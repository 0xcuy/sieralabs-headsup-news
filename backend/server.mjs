// Heads Up News — backend for Even Realities 'Heads Up' hackathon (SIERA Labs).
// One process: RSS ingest -> GLM digest (0G router) -> JSON API for the G2 app
//            + Telegram bot (@HeadsUpNewsBot) long-polling for /start /digest.
// Runs on the 32GB droplet. No npm dependencies; Node >= 22 built-ins only.
// Secrets (bot token, 0G key) are read from files on disk, never logged.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID, randomInt, createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

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

const FEEDS = [
  { source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'Guardian', url: 'https://www.theguardian.com/world/rss' },
  { source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
]
const HELP = [
  '/start — link this chat',
  '/digest — show your latest digest',
  '/alerts on|off — toggle breaking-news alerts',
  '/topics — set priority categories (or all)',
  '/lang en|id — set digest language',
  '/place world|Indonesia — set geographic priority',
  '/pair CODE — link your glasses in this private chat',
  '/saved — list stories you saved from your glasses',
  '/refresh — fetch a fresh digest now',
  '/pro — see Free and Pro plans',
  '/sources — list news feeds',
].join('\n')
const PRO = [
  'Heads Up News plans',
  '',
  'Free',
  '- 8-story digest every 30 min',
  '- Breaking alerts',
  '- 1 paired glasses',
  '- English + Indonesian',
  '',
  'Pro — $3/month',
  '- Unlimited saved stories',
  '- /refresh anytime (no cooldown)',
  '- Unlimited topics',
  '- Up to 3 paired devices',
  '- Early access to new features',
  '',
  'Payment is not wired up yet (coming soon).',
].join('\n')

const MAX_STORIES = 8
const REFRESH_MS = 30 * 60 * 1000
const ALERT_COOLDOWN_MS = 60 * 60 * 1000
const BREAKING_MAX_AGE_MS = 2 * ALERT_COOLDOWN_MS
const ALERT_HISTORY_MS = 2 * 24 * ALERT_COOLDOWN_MS
const CATEGORIES = ['WORLD', 'TECH', 'BUSINESS', 'SPORT', 'SCIENCE', 'CULTURE']
const DEFAULT_PREFERENCES = { topics: [], lang: 'en', place: 'world', alerts: true }
const INDONESIA = /\b(?:indonesia(?:n)?|jakarta|bali|surabaya|yogyakarta|bandung|sulawesi|sumatra|jokowi|prabowo)\b/i
const PAIR_TTL_MS = 10 * 60 * 1000
const MAX_SAVED_LIST = 10
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000
const DEVICE_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

let state = { digest: null, updatedAt: null, chats: [], saved: [], preferences: {}, devices: {}, alerts: [] }
function persist() {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) } catch (e) { console.error('[state] write failed', e.message) }
}

let botToken, ogKey
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
async function askModel(prompt, timeout = 180000) {
  const res = await fetch(OG_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ogKey}` },
    body: JSON.stringify({ model: OG_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 4000, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(timeout),
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
  return parsed
}

const STOP_WORDS = new Set('about after also amid and are been before breaking but could first for from has have into latest live more new now over says than that the their this under urgent was were what when where which who will with would'.split(' '))
function titleWords(title) {
  return new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= 3 && !STOP_WORDS.has(w)))
}
function sameStory(a, b) {
  const aw = titleWords(a.title), bw = titleWords(b.title)
  const overlap = [...aw].filter(word => bw.has(word)).length
  return overlap >= 4 && overlap / new Set([...aw, ...bw]).size >= 0.65
}
function publicationTime(candidate) {
  return Date.parse(candidate.published) || 0
}
export function detectBreaking(items, now = Date.now()) {
  const recent = items.filter(c => {
    const age = now - publicationTime(c)
    return age >= 0 && age <= BREAKING_MAX_AGE_MS
  }).sort((a, b) => publicationTime(b) - publicationTime(a))
  return recent.find((c, i) =>
    /^(?:\[\s*(?:breaking(?:\s+news)?|urgent)\s*\]|breaking news\b|(?:breaking|urgent)\s*[:–—!-])/i.test(c.title) ||
    recent.some((other, j) => i !== j && c.source !== other.source && sameStory(c, other))
  )
}
export function shouldAlert(candidate, history, now = Date.now()) {
  return !history.some(alert => now - alert.at < ALERT_COOLDOWN_MS ||
    (now - alert.at < ALERT_HISTORY_MS && (alert.url === candidate.url || sameStory(alert, candidate))))
}
function limitText(text, words, chars) {
  return typeof text === 'string' ? text.trim().split(/\s+/).slice(0, words).join(' ').slice(0, chars) : ''
}
function buildDigest(candidates, rewritten, breaking) {
  const selections = new Map()
  for (const s of rewritten) {
    if (s && Number.isInteger(s.candidate) && candidates[s.candidate - 1] && !selections.has(s.candidate)) selections.set(s.candidate, s)
  }
  const order = [...new Set([...(breaking ? [1] : []), ...selections.keys(), ...candidates.map((_, i) => i + 1)])]
  const ids = new Set()
  return order.slice(0, MAX_STORIES).map((key, i) => {
    const c = candidates[key - 1], s = selections.get(key)
    // Stable per article so ids shown on the glasses survive refreshes.
    const base = `s${createHash('sha256').update(c.url).digest('hex').slice(0, 12)}`
    const id = ids.has(base) ? `${base}-${i}` : base
    ids.add(id)
    return {
      id,

      headline: limitText(s?.headline, 10, 120) || limitText(c.title, 10, 120),
      summary: limitText(s?.summary, 18, 220),
      category: CATEGORIES.includes(s?.category) ? s.category : c.source === 'The Verge' ? 'TECH' : 'WORLD',
      source: c.source,
      url: c.url,
      published: c.published,
      indonesia: INDONESIA.test(`${c.title} ${c.description}`),
      ...(breaking && key === 1 ? { breaking: true } : {}),
    }
  })
}
async function summarize(candidates, breaking) {
  const list = candidates.map((c, i) =>
    `${i + 1}. [${c.source}] ${c.title} — ${c.description.slice(0, 220)} (${c.published || 'no date'})`).join('\n')
  const prompt = `You are the editor of a glanceable news digest for smart glasses. Pick up to ${MAX_STORIES} important, distinct stories from this list.${breaking ? ' Always include candidate 1 first; it is breaking news.' : ''} Rewrite each for a 1-second glance on a tiny display. Headline max 10 words, plain and factual; summary max 18 words, one sentence, no hype; category one of ${CATEGORIES.join(', ')}. Reply with ONLY a JSON array: [{"candidate": 1, "headline": "...", "summary": "...", "category": "..."}]. The candidate number must match the original list.\n\n${list}`
  return buildDigest(candidates, await askModel(prompt), breaking)
}

let refreshInProgress
function refreshDigest(reason) {
  refreshInProgress ??= runRefresh(reason).finally(() => { refreshInProgress = undefined })
  return refreshInProgress
}
async function runRefresh(reason) {
  console.log(`[digest] refresh (${reason})`)
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat()
  const breaking = detectBreaking(all)
  const seen = new Set()
  const candidates = [...(breaking ? [breaking] : []), ...all
    .filter(c => !breaking || (c !== breaking && c.url !== breaking.url && !sameStory(c, breaking)))
    .filter(c => { const k = c.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => publicationTime(b) - publicationTime(a))].slice(0, 14)
  if (candidates.length === 0) { console.error('[digest] no RSS items at all'); return false }
  try {
    state.digest = await summarize(candidates, breaking)
    console.log(`[digest] AI digest ready: ${state.digest.length} stories`)
  } catch (e) {
    console.error('[digest] GLM attempt 1 failed:', e.message, '— retrying once')
    try {
      state.digest = await summarize(candidates, breaking)
      console.log(`[digest] AI digest ready on retry: ${state.digest.length} stories`)
    } catch (e2) {
      console.error('[digest] GLM retry failed, using raw fallback:', e2.message)
      state.digest = buildDigest(candidates, [], breaking)
    }
  }
  state.updatedAt = new Date().toISOString()
  const now = Date.now()
  state.alerts = state.alerts.filter(alert => now - alert.at < ALERT_HISTORY_MS)
  const recipients = state.chats.filter(id => state.preferences[id]?.alerts !== false)
  if (breaking && recipients.length && shouldAlert(breaking, state.alerts, now)) {
    state.alerts.push({ title: breaking.title, url: breaking.url, at: now })
    persist()
    const lead = state.digest[0]
    void sendToChats(`🚨 Breaking news\n${lead.headline}\n${lead.source}: ${lead.url}`, recipients)
  } else {
    persist()
  }
  return true
}

// ---------- Telegram bot ----------
export function rankDigest(stories, prefs) {
  const score = s => (s.breaking ? 4 : 0) +
    (prefs.place === 'indonesia' && (s.indonesia ?? INDONESIA.test(`${s.headline} ${s.summary}`)) ? 2 : 0) +
    (prefs.topics.includes(s.category) ? 1 : 0)
  return [...stories].sort((a, b) => score(b) - score(a))
}
let translationCache
function translateDigest(stories) {
  if (translationCache?.stories !== stories) {
    const list = stories.map((s, i) => ({ candidate: i + 1, headline: s.headline, summary: s.summary }))
    const prompt = `Translate each headline and summary into Bahasa Indonesia. Max 10 headline words and 18 summary words. Keep the facts; use an empty summary if the original is empty. Return only a JSON array with candidate, headline, and summary for each entry.\n${JSON.stringify(list)}`
    const promise = askModel(prompt, 20000).then(rows => {
      const byNumber = new Map(rows.filter(Boolean).map(s => [s.candidate, s]))
      return stories.map((story, i) => {
        const row = byNumber.get(i + 1)
        const headline = limitText(row?.headline, 10, 120), summary = limitText(row?.summary, 18, 220)
        if (!headline || (story.summary && !summary)) throw new Error('incomplete Indonesian translation')
        return { ...story, headline, summary: story.summary ? summary : '' }
      })
    }).catch(e => {
      console.error('[digest] Indonesian translation failed:', e.message)
      if (translationCache?.stories === stories) translationCache = undefined
      return null
    })
    translationCache = { stories, promise }
  }
  return translationCache.promise
}
async function personalDigest(chatId) {
  const { digest, updatedAt } = state
  const { lang, ...prefs } = { ...DEFAULT_PREFERENCES, ...state.preferences[chatId] }
  const translated = lang === 'id' && digest?.length ? await translateDigest(digest) : null
  const stories = rankDigest(translated || digest || [], prefs)
  return { updatedAt, stories, lang: translated ? 'id' : 'en', ...(lang === 'id' && !translated && stories.length ? { translationUnavailable: true } : {}) }
}
function digestMessage({ stories, updatedAt, lang, translationUnavailable }) {
  if (!stories.length) return 'No digest yet — try again in a minute.'
  const lines = stories.map((s, i) => [`${i + 1}. ${s.headline}`, s.summary, s.source, s.url].filter(Boolean).join('\n'))
  const date = new Date(updatedAt).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', { timeZone: 'Asia/Jakarta' })
  return `📰 Heads Up — ${lang === 'id' ? 'Ringkasan Berita' : 'News Digest'}\n${lang === 'id' ? 'Diperbarui' : 'Updated'} ${date} WIB${translationUnavailable ? '\nIndonesian translation unavailable; showing English.' : ''}\n\n${lines.join('\n\n')}`
}

export function createPairing(now = Date.now, nextCode = () => String(randomInt(10000)).padStart(4, '0')) {
  const pending = new Map()
  let misses = []
  const chatMisses = new Map()
  function prune(time) {
    for (const [code, request] of pending) if (request.expiresAt <= time) pending.delete(code)
    for (const [id, attempts] of chatMisses) if (attempts.at(-1) <= time - PAIR_TTL_MS) chatMisses.delete(id)
    misses = misses.filter(at => at > time - PAIR_TTL_MS)
  }
  return {
    start(device) {
      const time = now()
      prune(time)
      for (const [code, request] of pending) if (request.device === device) return { code, expiresAt: request.expiresAt }
      if (pending.size >= 20) return null
      let code
      do { code = nextCode() } while (pending.has(code))
      const expiresAt = time + PAIR_TTL_MS
      pending.set(code, { device, expiresAt })
      return { code, expiresAt }
    },
    claim(code, chatId) {
      const time = now()
      prune(time)
      const attempts = (chatMisses.get(chatId) || []).filter(at => at > time - PAIR_TTL_MS)
      if (misses.length >= 20 || attempts.length >= 5) return { error: 'too_many_attempts' }
      const request = pending.get(code)
      if (!request) {
        misses.push(time)
        chatMisses.set(chatId, [...attempts, time])
        return { error: 'invalid_code' }
      }
      pending.delete(code)
      return { device: request.device }
    },
  }
}
const pairing = createPairing()
const manualRefreshAt = new Map()

export function refreshWait(lastAt, now = Date.now()) {
  const left = lastAt === undefined ? 0 : lastAt + MANUAL_REFRESH_COOLDOWN_MS - now
  if (left <= 0) return null
  const seconds = Math.ceil(left / 1000), min = Math.floor(seconds / 60), sec = seconds % 60
  return [min && `${min} min`, sec && `${sec} s`].filter(Boolean).join(' ')
}
function wibTime(iso) {
  return `${new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })} WIB`
}
// Saves record the chats they were delivered to. Older entries without that
// field cannot be attributed, so they are shown only while one chat is linked.
export function savedMessage(saved, digest, chatId, linkedChats = []) {
  const legacyOwner = linkedChats.length === 1 && linkedChats[0] === chatId
  const mine = saved.filter(entry => entry.chats ? entry.chats.includes(chatId) : legacyOwner)

    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (!mine.length) return 'No saved stories yet. Save one from your glasses with the ★ action or say "save this".'
  const lines = mine.slice(0, MAX_SAVED_LIST).map((entry, i) => {
    const story = (digest || []).find(s => s.id === entry.storyId) || entry
    const when = `Saved ${wibTime(entry.at)}`
    return story.headline
      ? [`${i + 1}. ${story.headline}`, story.source, story.url, when].filter(Boolean).join('\n')
      : `${i + 1}. Saved story (no longer in the digest)\n${when}`
  })
  const more = mine.length > MAX_SAVED_LIST ? `\n\nShowing the ${MAX_SAVED_LIST} most recent of ${mine.length}.` : ''
  return `🔖 Saved stories\n\n${lines.join('\n\n')}${more}`
}

// Telegram rejects messages over 4096 characters; split on paragraph breaks.
export function splitMessage(text, limit = 4096) {
  const parts = []
  let current = ''
  for (const block of text.split('\n\n')) {
    const joined = current ? `${current}\n\n${block}` : block
    if (joined.length <= limit) { current = joined; continue }
    if (current) parts.push(current)
    current = block
    while (current.length > limit) { parts.push(current.slice(0, limit)); current = current.slice(limit) }
  }
  if (current) parts.push(current)
  return parts
}
async function sendToChat(chatId, text) {
  for (const part of splitMessage(text)) {
    try {
      const r = await tg('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true })
      if (!r.ok) return console.error('[tg] send failed', chatId, r.description)
    } catch (e) { return console.error('[tg] send error', chatId, e.message) }
  }
}

async function sendToChats(text, chats = state.chats) {
  for (const chatId of chats) await sendToChat(chatId, text)
}
export async function handleUpdate(u) {
  const msg = u.message
  if (!msg || !msg.text) return
  const chatId = msg.chat.id
  const [target, ...args] = msg.text.trim().split(/\s+/)
  const [command, username] = target.toLowerCase().split('@')
  if (username && username !== 'headsupnewsbot') return
  const reply = text => sendToChat(chatId, text)
  const value = args.join(' ').toLowerCase()
  function setPreference(key, value) {
    state.preferences[chatId] = { ...state.preferences[chatId], [key]: value }
    persist()
  }
  if (command === '/start') {
    if (!state.chats.includes(chatId)) { state.chats.push(chatId); persist() }
    await reply('👋 Heads Up News — your AI news digest for Even Realities G2 glasses.\n\nUse /digest for news, /pair to link your glasses, or /help for all commands.')
    console.log(`[tg] /start from chat ${chatId} (linked chats: ${state.chats.length})`)
  } else if (command === '/digest') {
    await reply(digestMessage(await personalDigest(chatId)))
  } else if (command === '/alerts') {
    if (value === 'on' || value === 'off') setPreference('alerts', value === 'on')
    await reply(`Breaking alerts are ${state.preferences[chatId]?.alerts !== false ? 'on' : 'off'}. Use /alerts on or /alerts off.`)
  } else if (command === '/topics') {
    const topics = [...new Set(value.toUpperCase().split(/[\s,]+/).filter(Boolean))]
    if (value === 'all') setPreference('topics', [])
    else if (topics.length && topics.every(topic => CATEGORIES.includes(topic))) setPreference('topics', topics)
    await reply(`Priority topics: ${(state.preferences[chatId]?.topics || []).join(', ') || 'all'}. Use /topics followed by any of: ${CATEGORIES.join(', ')}. Use /topics all to reset.`)
  } else if (command === '/lang') {
    if (value === 'en' || value === 'id') setPreference('lang', value)
    await reply(`Digest language: ${state.preferences[chatId]?.lang || DEFAULT_PREFERENCES.lang}. Use /lang en or /lang id.`)
  } else if (command === '/place') {
    if (value === 'world' || value === 'indonesia') setPreference('place', value)
    await reply(`Digest place: ${state.preferences[chatId]?.place || DEFAULT_PREFERENCES.place}. Use /place world or /place Indonesia.`)
  } else if (command === '/pair') {
    if (msg.chat.type !== 'private') return reply('Send /pair and the code in a private chat with @HeadsUpNewsBot.')
    if (!/^\d{4}$/.test(value)) return reply('Use /pair followed by the four-digit code on your glasses.')
    const { device, error } = pairing.claim(value, chatId)
    if (error === 'too_many_attempts') return reply('Too many pairing attempts. Wait a few minutes and request a new code.')
    if (!device) return reply('That code is invalid or expired. Request a code on your glasses.')
    state.devices[device] = chatId
    if (!state.chats.includes(chatId)) state.chats.push(chatId)
    persist()
    await reply('Glasses paired. They will now show your personal digest.')
  } else if (command === '/saved') {
    await reply(savedMessage(state.saved, state.digest, chatId, state.chats))
  } else if (command === '/refresh') {
    const wait = refreshWait(manualRefreshAt.get(chatId))
    if (wait) return reply(`You can refresh again in ${wait}. The digest also refreshes every 30 min.`)
    manualRefreshAt.set(chatId, Date.now())
    await reply('Refreshing now. Your new digest will follow in a moment.')
    // Detached so a slow refresh does not hold up other chats' commands in pollLoop.
    void refreshDigest('telegram').then(async ok => {
      if (!ok) await reply('Could not fetch fresh news right now. Here is the latest digest.')
      await reply(digestMessage(await personalDigest(chatId)))
    }).catch(e => console.error('[tg] /refresh failed', chatId, e.message))

  } else if (command === '/pro') {
    await reply(PRO)
  } else if (command === '/sources') {
    await reply(`Sources (public RSS feeds):\n${FEEDS.map(feed => `${feed.source}: ${feed.url}`).join('\n')}\n\nHeads Up News rewrites short summaries and links to the original articles. It does not fetch full article bodies.`)
  } else if (command === '/help') {
    await reply(HELP)
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
function deviceId(value) {
  return typeof value === 'string' && DEVICE_ID.test(value) ? value.toLowerCase() : null
}
function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  return res.end(JSON.stringify(body))
}
export const server = createServer(async (req, res) => {
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
    const requestedDevice = url.searchParams.get('device')
    if (requestedDevice !== null) res.setHeader('cache-control', 'no-store')
    const chatId = state.devices[deviceId(requestedDevice)]
    const digest = chatId === undefined ? { updatedAt: state.updatedAt, stories: state.digest || [] } : await personalDigest(chatId)
    return jsonResponse(res, 200, digest)
  }
  if (url.pathname === '/api/pair/start' && req.method === 'POST') {
    res.setHeader('cache-control', 'no-store')
    let body = '', size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size <= 1024) body += chunk
    })
    req.on('end', () => {
      if (size > 1024) return jsonResponse(res, 413, { ok: false, error: 'body_too_large' })
      let device
      try { device = deviceId(JSON.parse(body || '{}')?.device) } catch { /* invalid request */ }
      if (!device) return jsonResponse(res, 400, { ok: false, error: 'invalid_device' })
      if (Object.hasOwn(state.devices, device)) return jsonResponse(res, 409, { ok: false, error: 'device_already_paired' })
      const request = pairing.start(device)
      if (!request) return jsonResponse(res, 429, { ok: false, error: 'too_many_pending_pairs' })
      return jsonResponse(res, 200, request)
    })
    return
  }
  if (url.pathname === '/api/save' && req.method === 'POST') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      try {
        const { storyId, device } = JSON.parse(body || '{}')
        const story = (state.digest || []).find(s => s.id === storyId)
        if (!story) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'story_not_found' })) }
        const chatId = state.devices[deviceId(device)]
        if (device !== undefined && chatId === undefined) return jsonResponse(res, 409, { ok: false, error: 'device_not_paired' })
        if (state.chats.length === 0) { res.writeHead(409, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no_chat_linked', hint: 'Open @HeadsUpNewsBot and press /start first.' })) }
        const chats = chatId === undefined ? [...state.chats] : [chatId]
        state.saved.push({ storyId, at: new Date().toISOString(), chats, headline: story.headline, source: story.source, url: story.url }); persist()
        await sendToChats([`🔖 Saved from your G2 glasses\n\n${story.headline}`, story.summary, story.source, story.url].filter(Boolean).join('\n'), chats)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(STATE_DIR, { recursive: true })
  if (existsSync(STATE_FILE)) {
    try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) } } catch { /* corrupt state: start fresh */ }
  }
  botToken = readFileSync(BOT_TOKEN_FILE, 'utf8').trim()
  ogKey = readFileSync(OG_KEY_FILE, 'utf8').trim()
  setInterval(() => {
    const now = Date.now()
    for (const [id, job] of voiceJobs) if (now - job.createdAt > VOICE_JOB_TTL_MS) voiceJobs.delete(id)
  }, 60 * 1000)
  server.listen(PORT, '0.0.0.0', () => console.log(`[headsup] listening on :${PORT}`))
  refreshDigest('startup')
  setInterval(() => refreshDigest('scheduled'), REFRESH_MS)
  pollLoop()
}
