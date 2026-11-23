// Heads Up News — backend for Even Realities 'Heads Up' hackathon (SIERA Labs).
// One process: RSS ingest -> GLM digest (0G router) -> JSON API for the G2 app
//            + Telegram bot (@HeadsUpNewsBot) long-polling for /start /digest.
// Runs on the 32GB droplet. No npm dependencies; Node >= 22 built-ins only.
// Secrets (bot token, 0G key) are read from files on disk, never logged.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || 8787)
const STATE_DIR = process.env.STATE_DIR || '/root/headsup'
const STATE_FILE = `${STATE_DIR}/state.json`
const BOT_TOKEN_FILE = process.env.BOT_TOKEN_FILE || '/root/headsup/telegram-bot-token'
const OG_KEY_FILE = '/root/.config/0g-router/api-key'
const OG_API_URL = 'https://router-api.0g.ai/v1/chat/completions'
const OG_MODEL = 'glm-5.3-flash'

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
