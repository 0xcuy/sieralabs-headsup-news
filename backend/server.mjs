// Heads Up News — backend for Even Realities 'Heads Up' hackathon (SIERA Labs).
// One process: RSS ingest -> GLM digest (0G router) -> JSON API for the G2 app
//            + Telegram bot (@HeadsUpNewsBot) long-polling for /start /digest.
// Runs on the 32GB droplet. No npm dependencies; Node >= 22 built-ins only.
// Secrets (bot token, 0G key) are read from files on disk, never logged.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const STATE_DIR = process.env.STATE_DIR || '/root/headsup'
const STATE_FILE = `${STATE_DIR}/state.json`
const BOT_TOKEN_FILE = process.env.BOT_TOKEN_FILE || '/root/headsup/telegram-bot-token'
const OG_KEY_FILE = '/root/.config/0g-router/api-key'
const OG_API_URL = 'https://router-api.0g.ai/v1/chat/completions'
const OG_MODEL = 'glm-5.3-flash'
// Voice: speech-to-text runs through Deepgram, but the Deepgram credential
// lives on the Muse VM (custom.deepgram, via authd surrogates) and the
// surrogate is only substituted on VM egress — the droplet CANNOT call
// Deepgram itself, and no key (raw or surrogate) may ever be written to the
// droplet, an env var, or this file. So /api/voice is an ASYNC JOB QUEUE:
// the glasses POST audio, a poller on the VM picks the job up, calls
// Deepgram from the VM, and POSTs the transcript back here. The app polls
// GET /api/voice/:jobId for the result. See voice-poller/deepgram_poller.py.
// The poller's GET /api/voice-jobs doubles as its heartbeat: if it hasn't
// checked in for 20s, /api/voice fails fast (503) instead of hanging.
const MAX_VOICE_BYTES = 1024 * 1024 // ~30s of 16kHz 16-bit mono PCM; clips are ~4s
const VOICE_JOB_TTL_MS = 90 * 1000
const VOICE_POLLER_STALE_MS = 20 * 1000
const voiceJobs = new Map() // jobId -> { audio, mime, status, transcript, command, error, createdAt }
let lastVoicePollAt = 0
setInterval(() => {
  const now = Date.now()
  for (const [id, job] of voiceJobs) if (now - job.createdAt > VOICE_JOB_TTL_MS) voiceJobs.delete(id)
}, 60 * 1000)

const FEEDS = [
  { source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'Guardian', url: 'https://www.theguardian.com/world/rss' },
  { source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
]

const MAX_STORIES = 8
const REFRESH_MS = 30 * 60 * 1000

mkdirSync(STATE_DIR, { recursive: true })

let state = { digest: null, updatedAt: null, chats: [], saved: [] }
if (existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) } } catch { /* corrupt state: start fresh */ }
}
function persist() {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) } catch (e) { console.error('[state] write failed', e.message) }
}

const botToken = readFileSync(BOT_TOKEN_FILE, 'utf8').trim()
const ogKey = readFileSync(OG_KEY_FILE, 'utf8').trim()
const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  }).then(r => r.json())

// ---------- RSS ingest (plain fetch + regex parse; no deps) ----------
function stripTags(s) {
  let t = (s || '')
  // Decode entities FIRST so encoded markup (&lt;p&gt;) becomes real tags, then strip.
  for (let i = 0; i < 3; i++) {
    t = t.replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  }
  return t.replace(/\s+/g, ' ').trim()
}
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? stripTags(m[1]) : ''
}
async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'user-agent': 'HeadsUpNews/1.0 (hackathon demo)' }, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const xml = await res.text()
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1])
    return items.map(b => ({
      source: feed.source,
      title: tagText(b, 'title'),
      url: tagText(b, 'link') || tagText(b, 'guid'),
      published: tagText(b, 'pubDate'),
      description: tagText(b, 'description'),
    })).filter(i => i.title && i.url)
  } catch (e) {
    console.error(`[rss] ${feed.source} failed:`, e.message)
    return []
  }
}

// ---------- AI digest via GLM on 0G router ----------
async function summarize(candidates) {
  const list = candidates.map((c, i) =>
    `${i + 1}. [${c.source}] ${c.title} — ${c.description.slice(0, 220)} (${c.published || 'no date'}) <${c.url}>`).join('\n')
  const prompt = `You are the editor of a glanceable news digest for smart glasses. Pick the ${MAX_STORIES} most important, distinct stories from this list and rewrite each for a 1-second glance on a tiny display. Rules: headline max 10 words, plain and factual; summary max 18 words, one sentence, no hype; category one of WORLD, TECH, BUSINESS, SPORT, SCIENCE, CULTURE; keep the original source name and URL. Reply with ONLY a JSON array: [{"headline": "...", "summary": "...", "category": "...", "source": "...", "url": "...", "published": "..."}].\n\n${list}`
  const res = await fetch(OG_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ogKey}` },
    body: JSON.stringify({ model: OG_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 4000, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(180000),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`0G router HTTP ${res.status}: ${raw.slice(0, 200)}`)
  if (!raw.trim()) throw new Error('0G router returned empty body')
  const data = JSON.parse(raw)
  let text = data.choices?.[0]?.message?.content || ''
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  // The model sometimes wraps the array in prose or truncates mid-object:
  // extract the outermost [...] slice, then parse.
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) throw new Error(`no JSON array in model reply (head: ${text.slice(0, 120)})`)
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    throw new Error(`model JSON unparseable: ${e.message} (head: ${text.slice(0, 120)})`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty digest from model')
  return parsed.slice(0, MAX_STORIES).map((s, i) => ({
    id: `s${Date.now().toString(36)}-${i}`,
    headline: String(s.headline || '').slice(0, 120),
    summary: String(s.summary || '').slice(0, 220),
    category: String(s.category || 'WORLD').toUpperCase().slice(0, 12),
    source: String(s.source || ''),
    url: String(s.url || ''),
    published: String(s.published || ''),
  }))
}

function fallbackDigest(candidates) {
  return candidates.slice(0, MAX_STORIES).map((c, i) => ({
    id: `s${Date.now().toString(36)}-${i}`,
    headline: c.title.slice(0, 120),
    summary: c.description.slice(0, 200) || c.title,
    category: 'WORLD',
    source: c.source,
    url: c.url,
    published: c.published,
  }))
}

async function refreshDigest(reason) {
  console.log(`[digest] refresh (${reason})`)
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat()
  const seen = new Set()
  const candidates = all
    .filter(c => { const k = c.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 14)
  if (candidates.length === 0) { console.error('[digest] no RSS items at all'); return false }
  try {
    state.digest = await summarize(candidates)
    console.log(`[digest] AI digest ready: ${state.digest.length} stories`)
  } catch (e) {
    console.error('[digest] GLM attempt 1 failed:', e.message, '— retrying once')
    try {
      state.digest = await summarize(candidates)
      console.log(`[digest] AI digest ready on retry: ${state.digest.length} stories`)
    } catch (e2) {
      console.error('[digest] GLM retry failed, using raw fallback:', e2.message)
      state.digest = fallbackDigest(candidates)
    }
  }
  state.updatedAt = new Date().toISOString()
  persist()
  return true
}

// ---------- Telegram bot ----------
function digestMessage() {
  if (!state.digest) return 'No digest yet — try again in a minute.'
  const lines = state.digest.map((s, i) => `${i + 1}. *${s.headline}*\n${s.summary}\n_${s.source}${s.published ? ' · ' + s.published : ''}_\n${s.url}`)
  return `📰 *Heads Up — News Digest*\nUpdated ${new Date(state.updatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })} WIB\n\n${lines.join('\n\n')}`
}
async function sendToChats(text, parseMode) {
  for (const chatId of state.chats) {
    try {
      const r = await tg('sendMessage', { chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true })
      if (!r.ok) console.error('[tg] send failed', chatId, r.description)
    } catch (e) { console.error('[tg] send error', e.message) }
  }
}
async function handleUpdate(u) {
  const msg = u.message
  if (!msg || !msg.text) return
  const chatId = msg.chat.id
  const text = msg.text.trim()
  if (text.startsWith('/start')) {
    if (!state.chats.includes(chatId)) { state.chats.push(chatId); persist() }
    await tg('sendMessage', {
      chat_id: chatId,
      text: '👋 *Heads Up News* — your AI news digest for Even Realities G2 glasses.\n\nI send a short digest of the day\'s most important stories, and anything you save on your glasses lands here.\n\nCommands:\n/digest — latest digest now\n/start — link this chat (needed for saving from glasses)',
      parse_mode: 'Markdown',
    })
    console.log(`[tg] /start from chat ${chatId} (linked chats: ${state.chats.length})`)
  } else if (text.startsWith('/digest')) {
    await tg('sendMessage', { chat_id: chatId, text: digestMessage(), parse_mode: 'Markdown', disable_web_page_preview: true })
  } else if (text.startsWith('/help')) {
    await tg('sendMessage', { chat_id: chatId, text: 'Commands: /digest — latest AI news digest. /start — link this chat so glasses saves arrive here.' })
  }
}
async function pollLoop() {
  let offset = 0
  for (;;) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=25`, { signal: AbortSignal.timeout(40000) })
      const data = await res.json()
      if (data.ok) {
        for (const u of data.result) { offset = u.update_id + 1; await handleUpdate(u) }
      } else if (data.error_code === 409) {
        console.error('[tg] getUpdates 409: another poller is running — waiting 30s')
        await new Promise(r => setTimeout(r, 30000))
      }
    } catch (e) { console.error('[tg] poll error', e.message); await new Promise(r => setTimeout(r, 5000)) }
  }
}

// ---------- Voice: STT + command parse (POST /api/voice) ----------
// The G2 app sends a short WAV (16kHz 16-bit mono PCM from the glasses mic,
// wrapped in a WAV header by the app) or multipart form-data with a `file`
// part (browser preview sends MediaRecorder webm the same way). We forward
// the bytes to Whisper on the 0G router and map the transcript to one of
// three commands. The app owns the action itself (it holds the story index);
// the backend only returns { transcript, command }.
function parseVoiceCommand(text) {
  const t = (text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  const has = w => new RegExp(`\\b${w}\\b`).test(t)
  if (has('save')) return 'save' // "save", "save this", "save this story"
  if (has('next')) return 'next' // "next", "next story"
  if (has('repeat') || has('again')) return 'repeat' // "repeat", "say it again"
  return null
}

// Pull the audio bytes out of a multipart/form-data body (part named `file`);
// a non-multipart body is treated as raw audio bytes as-is.
function extractAudio(req, body) {
  const ct = req.headers['content-type'] || ''
  const m = ct.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) return { bytes: body, filename: 'clip.wav', mime: ct.split(';')[0] || 'audio/wav' }
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim())
  let pos = body.indexOf(boundary)
  while (pos !== -1) {
    const headEnd = body.indexOf('\r\n\r\n', pos)
    if (headEnd === -1) break
    const head = body.subarray(pos, headEnd).toString('latin1')
    const next = body.indexOf(boundary, headEnd)
    if (next === -1) break
    if (/name="file"/.test(head)) {
      const fn = head.match(/filename="([^"]*)"/)
      const mt = head.match(/Content-Type:\s*([^\r\n]+)/i)
      return { bytes: body.subarray(headEnd + 4, next - 2), filename: fn?.[1] || 'clip.wav', mime: (mt?.[1] || 'audio/wav').trim() }
    }
    pos = next
  }
  return { bytes: null, filename: '', mime: '' }
}

// ---------- HTTP API for the G2 app ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, updatedAt: state.updatedAt, stories: state.digest?.length || 0, linkedChats: state.chats.length }))
  }
  if (url.pathname === '/api/digest') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ updatedAt: state.updatedAt, stories: state.digest || [] }))
  }
  if (url.pathname === '/api/save' && req.method === 'POST') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      try {
        const { storyId } = JSON.parse(body || '{}')
        const story = (state.digest || []).find(s => s.id === storyId)
        if (!story) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'story_not_found' })) }
        if (state.chats.length === 0) { res.writeHead(409, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no_chat_linked', hint: 'Open @HeadsUpNewsBot and press /start first.' })) }
        state.saved.push({ storyId, at: new Date().toISOString() }); persist()
        await sendToChats(`🔖 *Saved from your G2 glasses*\n\n*${story.headline}*\n${story.summary}\n_${story.source}_\n${story.url}`, 'Markdown')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, saved: story.headline }))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }
  // Voice jobs (async — transcription runs in the VM poller, see header).
  // POST /api/voice: enqueue a clip, returns 202 { jobId }.
  if (url.pathname === '/api/voice' && req.method === 'POST') {
    if (Date.now() - lastVoicePollAt > VOICE_POLLER_STALE_MS) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'voice_unavailable', detail: 'voice relay has not checked in' }))
    }
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', c => {
      size += c.length
      if (size > MAX_VOICE_BYTES) { tooBig = true; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooBig) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'audio_too_large' })) }
      const { bytes, filename, mime } = extractAudio(req, Buffer.concat(chunks))
      if (!bytes || bytes.length < 100) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no_audio' })) }
      const jobId = randomUUID()
      voiceJobs.set(jobId, { audio: bytes, mime: mime || 'audio/wav', status: 'pending', transcript: '', command: null, error: '', createdAt: Date.now() })
      console.log(`[voice] job ${jobId} queued (${bytes.length} bytes ${mime || 'audio/wav'})`)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, jobId }))
    })
    return
  }
  // GET /api/voice-jobs: poller claim list (also the poller heartbeat).
  if (url.pathname === '/api/voice-jobs' && req.method === 'GET') {
    lastVoicePollAt = Date.now()
    const jobs = [...voiceJobs.entries()]
      .filter(([, j]) => j.status === 'pending')
      .map(([jobId, j]) => ({ jobId, mime: j.mime, createdAt: j.createdAt }))
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, jobs }))
  }
  // GET /api/voice/:jobId/audio: poller downloads the clip (id is a UUID).
  const audioMatch = url.pathname.match(/^\/api\/voice\/([0-9a-f-]{36})\/audio$/)
  if (audioMatch && req.method === 'GET') {
    const job = voiceJobs.get(audioMatch[1])
    if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'job_not_found' })) }
    res.writeHead(200, { 'content-type': job.mime || 'audio/wav' })
    return res.end(job.audio)
  }
  // POST /api/voice-result: poller delivers { jobId, transcript } or { jobId, error }.
  if (url.pathname === '/api/voice-result' && req.method === 'POST') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      try {
        const { jobId, transcript, error } = JSON.parse(body || '{}')
        const job = voiceJobs.get(jobId)
        if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'job_not_found' })) }
        if (error) {
          job.status = 'error'; job.error = String(error).slice(0, 120)
          console.log(`[voice] job ${jobId} error: ${job.error}`)
        } else {
          job.status = 'done'
          job.transcript = String(transcript || '').trim()
          job.command = parseVoiceCommand(job.transcript)
          job.audio = null // free the clip; the result is all the app needs
          console.log(`[voice] job ${jobId} "${job.transcript}" -> ${job.command || '(no match)'}`)
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }
  // GET /api/voice/:jobId: app polls for the result.
  const jobMatch = url.pathname.match(/^\/api\/voice\/([0-9a-f-]{36})$/)
  if (jobMatch && req.method === 'GET') {
    const job = voiceJobs.get(jobMatch[1])
    if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'job_not_found' })) }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, status: job.status, transcript: job.transcript, command: job.command, error: job.error }))
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    refreshDigest('manual').then(ok => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok, updatedAt: state.updatedAt, stories: state.digest?.length || 0 }))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not_found' }))
})

server.listen(PORT, '0.0.0.0', () => console.log(`[headsup] listening on :${PORT}`))
refreshDigest('startup')
setInterval(() => refreshDigest('scheduled'), REFRESH_MS)
pollLoop()
