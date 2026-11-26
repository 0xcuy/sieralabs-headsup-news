// Heads Up News — backend for Even Realities 'Heads Up' hackathon (SIERA Labs).
// One process: RSS ingest -> GLM digest (0G router) -> JSON API for the G2 app
//            + Telegram bot (@HeadsUpNewsBot) long-polling for /start /digest.
// Runs on the 32GB droplet. No npm dependencies; Node >= 22 built-ins only.
// Secrets (bot token, 0G key) are read from files on disk, never logged.

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID, randomInt, createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PORT = Number(process.env.PORT || 8787)
const STATE_DIR = process.env.STATE_DIR || '/root/headsup'
const STATE_FILE = `${STATE_DIR}/state.json`
const BOT_TOKEN_FILE = process.env.BOT_TOKEN_FILE || '/root/headsup/telegram-bot-token'
// Bot API base URL override: pointing this at a local test-server build of
// telegram-bot-api (started with --test-dc) puts the bot in Telegram's $0 test
// environment, where Stars payments don't cost real money. The token still
// comes only from BOT_TOKEN_FILE.
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org'
// Telegram user id allowed to run /refund (bot owner). No secret: a user id.
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0)
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
export const LANGUAGES = {
  en: { name: 'English', native: 'English', title: 'News Digest', updated: 'Updated', locale: 'en-GB' },
  id: { name: 'Indonesian', native: 'Bahasa Indonesia', prompt: 'Bahasa Indonesia', title: 'Ringkasan Berita', updated: 'Diperbarui', locale: 'id-ID' },
  ru: { name: 'Russian', native: 'Русский', title: 'Новостной дайджест', updated: 'Обновлено', locale: 'ru-RU' },
  zh: { name: 'Chinese (Simplified)', native: '简体中文', prompt: 'Simplified Chinese', title: '新闻摘要', updated: '更新于', locale: 'zh-CN' },
  es: { name: 'Spanish', native: 'Español', title: 'Resumen de noticias', updated: 'Actualizado', locale: 'es-ES' },
  fr: { name: 'French', native: 'Français', title: 'Résumé de l’actualité', updated: 'Mis à jour', locale: 'fr-FR' },
  de: { name: 'German', native: 'Deutsch', title: 'Nachrichtenüberblick', updated: 'Aktualisiert', locale: 'de-DE' },
  ja: { name: 'Japanese', native: '日本語', title: 'ニュースダイジェスト', updated: '更新', locale: 'ja-JP' },
  ar: { name: 'Arabic', native: 'العربية', title: 'موجز الأخبار', updated: 'آخر تحديث', locale: 'ar-EG' },
  pt: { name: 'Portuguese', native: 'Português', title: 'Resumo de notícias', updated: 'Atualizado', locale: 'pt-BR' },
}
const LANGUAGE_LIST = Object.entries(LANGUAGES).map(([code, l]) => `${code} ${l.name}`).join(', ')
// Telegram Stars subscription (Bot API): XTR, exactly one LabeledPrice,
// 2592000 s (30 days) is the only allowed subscription_period.
const PRO_PRICE_STARS = 150
const PRO_PAYLOAD = 'headsup-pro-subscription'
const PRO_PERIOD_SECONDS = 2592000
const PRO_PERIOD_MS = PRO_PERIOD_SECONDS * 1000
const PRO_INVOICE_TITLE = 'Heads Up News Pro'
const PRO_INVOICE_DESCRIPTION = 'Unlimited saves and topics, /refresh every 5 min, up to 3 paired glasses. Renews every 30 days; cancel anytime with /cancelpro.'
// Free-tier limits (Pro lifts them).
const FREE_MAX_SAVED = 20
const FREE_MAX_TOPICS = 3
const FREE_REFRESH_COOLDOWN_MS = 30 * 60 * 1000
const FREE_MAX_DEVICES = 1
const PRO_MAX_DEVICES = 3
const HELP = [
  '/start — link this chat',
  '/digest — show your latest digest',
  '/alerts on|off — toggle breaking-news alerts',
  '/topics — set priority categories (or all)',
  `/lang ${Object.keys(LANGUAGES).join('|')} — set digest language`,
  '/place world|Indonesia — set geographic priority',
  '/pair CODE — link your glasses in this private chat',
  '/unpair — unlink the glasses paired to this chat',
  '/saved — list stories you saved from your glasses',
  '/refresh — fetch a fresh digest now',
  '/pro — see Free and Pro plans, upgrade',
  '/cancelpro — stop Pro auto-renewal',
  '/terms — Pro subscription terms',
  '/paysupport — payment support',
  '/sources — list news feeds',
].join('\n')
const PRO = [
  'Heads Up News plans',
  '',
  'Free',
  '- 8-story digest every 30 min',
  '- Breaking alerts',
  '- 20 saved stories',
  '- 3 priority topics',
  '- /refresh every 30 min',
  '- 1 paired glasses',
  `- ${Object.keys(LANGUAGES).length} digest languages (/lang)`,
  '',
  `Pro — ${PRO_PRICE_STARS} Telegram Stars / month`,
  '- Unlimited saved stories',
  '- Unlimited priority topics',
  '- /refresh every 5 min',
  '- Up to 3 paired devices',
  `- All ${Object.keys(LANGUAGES).length} digest languages`,
  '- Early access to new features',
  '',
  'Billed in Telegram Stars. Renews automatically every 30 days.',
  'Cancel anytime with /cancelpro; Pro runs until the paid period ends.',
].join('\n')
const TERMS = [
  'Heads Up News Pro — Terms',
  '',
  'Pro is a subscription inside the @HeadsUpNewsBot Telegram bot: unlimited saved stories, unlimited priority topics, /refresh every 5 minutes instead of 30, and up to 3 paired glasses instead of 1.',
  '',
  `Price: ${PRO_PRICE_STARS} Telegram Stars every 30 days, charged automatically by Telegram until you cancel.`,
  'The Free tier includes 20 saved stories, 3 priority topics, /refresh every 30 minutes and 1 paired glasses.',
  'Cancellation: /cancelpro stops renewal; Pro stays on until the paid period ends. You can also cancel from the payment receipt in this chat.',
  'Refunds: issued by the bot owner at your request, within reason, via /paysupport.',
  'Heads Up News is an experimental news digest; delivery is provided as is, without warranty.',
].join('\n')
const PAYSUPPORT = [
  'Payment support',
  '',
  `For charges, cancellations or refunds of Heads Up News Pro (${PRO_PRICE_STARS} Stars / 30 days), reply in this chat and the bot owner will get back to you. You can also open an issue at github.com/0xcuy/sieralabs-headsup-news/issues.`,
  'Note: Telegram support cannot help with purchases made via this bot - the bot owner handles all payment support.',
  'To cancel renewal yourself, use /cancelpro here or the payment receipt in this chat.',
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

let state = { digest: null, updatedAt: null, chats: [], saved: [], preferences: {}, devices: {}, alerts: [], pro: {} }
// Atomic: never truncate state.json in place. Back up the current file to
// .bak, write the new state to a temp file, then rename over the target.
// A crash mid-write leaves either the old or the new file, never a truncated
// one — required before storing payment data (proUntil, charge ids).
function persist() {
  try {
    const tmp = `${STATE_FILE}.tmp`
    if (existsSync(STATE_FILE)) {
      try { copyFileSync(STATE_FILE, `${STATE_FILE}.bak`) } catch (e) { console.error('[state] backup failed', e.message) }
    }
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, STATE_FILE)
  } catch (e) { console.error('[state] write failed', e.message) }
}

let botToken, ogKey
const tg = (method, body) =>
  fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
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
  return order.slice(0, MAX_STORIES).map(key => {
    const c = candidates[key - 1], s = selections.get(key)
    return {
      // Stable per article (candidates are unique by url) so ids shown on the glasses survive refreshes.
      id: `s${createHash('sha256').update(c.url).digest('hex').slice(0, 12)}`,
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
    .filter(c => { const k = c.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40); if (seen.has(k) || seen.has(c.url)) return false; seen.add(k).add(c.url); return true })
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
const translationCache = new Map() // lang -> { stories, promise }
export function translateDigest(stories, lang) {
  const language = LANGUAGES[lang], target = language.prompt || language.name
  if (translationCache.get(lang)?.stories !== stories) {
    const list = stories.map((s, i) => ({ candidate: i + 1, headline: s.headline, summary: s.summary }))
    const prompt = `Translate each headline and summary into ${target}. Max 10 headline words and 18 summary words. Keep the facts; use an empty summary if the original is empty. Return only a JSON array with candidate, headline, and summary for each entry.\n${JSON.stringify(list)}`
    const promise = askModel(prompt, 20000).then(rows => {
      const byNumber = new Map(rows.filter(Boolean).map(s => [s.candidate, s]))
      return stories.map((story, i) => {
        const row = byNumber.get(i + 1)
        const headline = limitText(row?.headline, 10, 120), summary = limitText(row?.summary, 18, 220)
        if (!headline || (story.summary && !summary)) throw new Error(`incomplete ${language.name} translation`)
        return { ...story, headline, summary: story.summary ? summary : '' }
      })
    }).catch(e => {
      console.error(`[digest] ${language.name} translation failed:`, e.message)
      if (translationCache.get(lang)?.stories === stories) translationCache.delete(lang)
      return null
    })
    translationCache.set(lang, { stories, promise })
  }
  return translationCache.get(lang).promise
}
async function personalDigest(chatId) {
  const { digest, updatedAt } = state
  const { lang, ...prefs } = { ...DEFAULT_PREFERENCES, ...state.preferences[chatId] }
  const wanted = Object.hasOwn(LANGUAGES, lang) ? lang : 'en'
  const translated = wanted !== 'en' && digest?.length ? await translateDigest(digest, wanted) : null
  const stories = rankDigest(translated || digest || [], prefs)
  return { updatedAt, stories, lang: translated ? wanted : 'en', ...(wanted !== 'en' && !translated && stories.length ? { translationUnavailable: true, requestedLang: wanted } : {}) }
}
export function digestMessage({ stories, updatedAt, lang, translationUnavailable, requestedLang }) {
  if (!stories.length) return 'No digest yet — try again in a minute.'
  const lines = stories.map((s, i) => [`${i + 1}. ${s.headline}`, s.summary, s.source, s.url].filter(Boolean).join('\n'))
  const l = LANGUAGES[lang] || LANGUAGES.en
  const date = new Date(updatedAt).toLocaleString(l.locale, { timeZone: 'Asia/Jakarta' })
  const fallback = translationUnavailable ? `\n${LANGUAGES[requestedLang]?.name || 'The'} translation unavailable; showing English.` : ''
  return `📰 Heads Up — ${l.title}\n${l.updated} ${date} WIB${fallback}\n\n${lines.join('\n\n')}`
}

export function createPairing(now = Date.now, nextCode = () => String(randomInt(1_000_000)).padStart(6, '0')) {
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

// Pro status comes straight from state.pro[chatId] = { proUntil, chargeId, cancelRequested }: proUntil
// is only set by a confirmed Telegram Stars payment and never extended by a
// cron — when renewal stops, the date passes and the user is Free again.
export function isPro(entry, now = Date.now()) {
  return Boolean(entry?.proUntil && Date.parse(entry.proUntil) > now)
}
function proDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })
}
// Saves counted toward the Free limit follow the same ownership rules as
// savedMessage: entries record their chats, pre-attribution entries belong to
// the single linked chat of the time.
function savedCountFor(saved, chatId, linkedChats) {
  const legacyOwner = linkedChats.length === 1 && linkedChats[0] === chatId
  return saved.filter(entry => entry.chats ? entry.chats.includes(chatId) : legacyOwner).length
}

export function refreshWait(lastAt, now = Date.now(), cooldown = MANUAL_REFRESH_COOLDOWN_MS) {
  const left = lastAt === undefined ? 0 : lastAt + cooldown - now
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
async function sendToChat(chatId, text, extra) {
  const parts = splitMessage(text)
  for (const [i, part] of parts.entries()) {
    try {
      // extra (an inline keyboard for /pro) rides on the first part only;
      // text is always plain — parse_mode is never set.
      const r = await tg('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true, ...(i === 0 && extra ? extra : {}) })
      if (!r.ok) return console.error('[tg] send failed', chatId, r.description)
    } catch (e) { return console.error('[tg] send error', chatId, e.message) }
  }
}

async function sendToChats(text, chats = state.chats) {
  for (const chatId of chats) await sendToChat(chatId, text)
}
// ---------- Telegram Stars (Pro subscription) ----------
// Digital goods sold inside a Telegram bot must be paid in Telegram Stars
// (Bot API currency "XTR"); crypto and third-party providers are not allowed.
// No provider token is involved and 30 days is the only subscription period
// Telegram permits. See /pro for the invoice and the commands below for the
// subscription lifecycle. Details verified against core.telegram.org/bots/api.

async function answerPreCheckout(query) {
  // Telegram cancels the purchase if the answer does not arrive within 10 s,
  // so this answers immediately — nothing is awaited before the call.
  const ok = query.currency === 'XTR' && query.total_amount === PRO_PRICE_STARS && query.invoice_payload === PRO_PAYLOAD
  const body = ok
    ? { pre_checkout_query_id: query.id, ok: true }
    : { pre_checkout_query_id: query.id, ok: false, error_message: 'This invoice is no longer available. Send /pro for a fresh upgrade link.' }
  try { await tg('answerPreCheckoutQuery', body) } catch (e) { console.error('[tg] answerPreCheckoutQuery failed', e.message) }
}

async function handleSuccessfulPayment(msg) {
  const payment = msg.successful_payment
  if (payment.invoice_payload !== PRO_PAYLOAD) return
  const chatId = msg.chat.id
  const current = state.pro?.[chatId]
  // Telegram re-charges every 30 days; each renewal pushes the expiry forward.
  // subscription_expiration_date is authoritative when present.
  const base = current?.proUntil ? Math.max(Date.now(), Date.parse(current.proUntil)) : Date.now()
  const untilMs = payment.subscription_expiration_date ? payment.subscription_expiration_date * 1000 : base + PRO_PERIOD_MS
  state.pro[chatId] = { proUntil: new Date(untilMs).toISOString(), chargeId: payment.telegram_payment_charge_id, cancelRequested: false }
  if (!state.chats.includes(chatId)) state.chats.push(chatId)
  persist()
  const entry = state.pro[chatId]
  await sendToChat(chatId, `Pro active until ${proDate(entry.proUntil)}.\nRenews automatically every 30 days; /cancelpro stops renewal.`)
  console.log(`[stars] chat ${chatId} paid ${payment.total_amount} XTR; Pro until ${entry.proUntil}`)
}

export async function handleUpdate(u) {
  if (u.pre_checkout_query) return answerPreCheckout(u.pre_checkout_query)
  const msg = u.message
  if (msg?.successful_payment) return handleSuccessfulPayment(msg)
  if (!msg || !msg.text) return
  const chatId = msg.chat.id
  const [target, ...args] = msg.text.trim().split(/\s+/)
  const [command, username] = target.toLowerCase().split('@')
  if (username && username !== 'headsupnewsbot') return
  const reply = (text, extra) => sendToChat(chatId, text, extra)
  const value = args.join(' ').toLowerCase()
  const pro = isPro(state.pro?.[chatId])
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
    else if (topics.length && topics.every(topic => CATEGORIES.includes(topic))) {
      if (!pro && topics.length > FREE_MAX_TOPICS) return reply(`Free allows up to ${FREE_MAX_TOPICS} priority topics. Pro lifts the limit; see /pro.`)
      setPreference('topics', topics)
    }
    await reply(`Priority topics: ${(state.preferences[chatId]?.topics || []).join(', ') || 'all'}. Use /topics followed by any of: ${CATEGORIES.join(', ')}. Use /topics all to reset.`)
  } else if (command === '/lang') {
    if (value && !Object.hasOwn(LANGUAGES, value)) return reply(`Unknown language "${value}". Supported: ${LANGUAGE_LIST}.`)
    if (value) setPreference('lang', value)
    const code = state.preferences[chatId]?.lang || DEFAULT_PREFERENCES.lang, l = LANGUAGES[code] || LANGUAGES.en
    await reply(`Digest language${value ? ' set to' : ':'} ${l.name}${l.native !== l.name ? ` (${l.native})` : ''}.${value ? '' : ` Use /lang followed by one of: ${LANGUAGE_LIST}.`}`)
  } else if (command === '/place') {
    if (value === 'world' || value === 'indonesia') setPreference('place', value)
    await reply(`Digest place: ${state.preferences[chatId]?.place || DEFAULT_PREFERENCES.place}. Use /place world or /place Indonesia.`)
  } else if (command === '/pair') {
    if (msg.chat.type !== 'private') return reply('Send /pair and the code in a private chat with @HeadsUpNewsBot.')
    if (!/^\d{6}$/.test(value)) return reply('Use /pair followed by the six-digit code on your glasses.')
    const pairedCount = Object.values(state.devices).filter(owner => owner === chatId).length
    const maxDevices = pro ? PRO_MAX_DEVICES : FREE_MAX_DEVICES
    if (pairedCount >= maxDevices) return reply(`Your plan allows ${maxDevices === 1 ? '1 paired glasses' : `up to ${maxDevices} paired glasses`}. ${pro ? 'Unpair one first with /unpair.' : 'See /pro to pair up to 3.'}`)
    const { device, error } = pairing.claim(value, chatId)
    if (error === 'too_many_attempts') return reply('Too many pairing attempts. Wait a few minutes and request a new code.')
    if (!device) return reply('That code is invalid or expired. Request a code on your glasses.')
    state.devices[device] = chatId
    if (!state.chats.includes(chatId)) state.chats.push(chatId)
    persist()
    await reply('Glasses paired. They will now show your personal digest, and stories you save on them come to this chat.')
  } else if (command === '/unpair') {
    const paired = Object.keys(state.devices).filter(device => state.devices[device] === chatId)
    if (paired.length === 0) return reply('No glasses are paired to this chat. Use /pair CODE with the code on your glasses.')
    for (const device of paired) delete state.devices[device]
    persist()
    await reply(`Unpaired ${paired.length === 1 ? 'your glasses' : `${paired.length} glasses`}. They will show a new pairing code.`)
  } else if (command === '/saved') {
    await reply(savedMessage(state.saved, state.digest, chatId, state.chats))
  } else if (command === '/refresh') {
    const wait = refreshWait(manualRefreshAt.get(chatId), Date.now(), pro ? MANUAL_REFRESH_COOLDOWN_MS : FREE_REFRESH_COOLDOWN_MS)
    if (wait) return reply(`You can refresh again in ${wait}. ${pro ? 'The digest also refreshes every 30 min.' : 'Free plan refreshes every 30 min; /pro gets 5 min.'}`)
    manualRefreshAt.set(chatId, Date.now())
    await reply('Refreshing now. Your new digest will follow in a moment.')
    // Detached so a slow refresh does not hold up other chats' commands in pollLoop.
    void refreshDigest('telegram').then(async ok => {
      if (!ok) await reply('Could not fetch fresh news right now. Here is the latest digest.')
      await reply(digestMessage(await personalDigest(chatId)))
    }).catch(e => console.error('[tg] /refresh failed', chatId, e.message))

  } else if (command === '/pro') {
    // A Stars subscription can only be sold via a Telegram-generated link
    // (30 days is the only period); createInvoiceLink makes it the button URL.
    let link = null
    try {
      const r = await tg('createInvoiceLink', {
        title: PRO_INVOICE_TITLE,
        description: PRO_INVOICE_DESCRIPTION,
        payload: PRO_PAYLOAD,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: PRO_INVOICE_TITLE, amount: PRO_PRICE_STARS }],
        subscription_period: PRO_PERIOD_SECONDS,
      })
      if (r.ok && typeof r.result === 'string') link = r.result
      else console.error('[stars] createInvoiceLink failed', r.description)
    } catch (e) { console.error('[stars] createInvoiceLink error', e.message) }
    const headline = pro ? 'You are on Pro. Thank you!' : null
    if (link) await reply(`${headline ? `${headline}\n\n` : ''}${PRO}`, { reply_markup: { inline_keyboard: [[{ text: 'Upgrade: 150 ⭐/month', url: link }]] } })
    else await reply(`${PRO}\n\nPayments are momentarily unavailable; try again in a minute.`)
  } else if (command === '/cancelpro') {
    const entry = state.pro?.[chatId]
    if (!pro) return reply('You do not have an active Pro subscription.')
    if (entry.cancelRequested) return reply(`Renewal is already stopped. Pro stays on until ${proDate(entry.proUntil)}.`)
    // editUserStarSubscription(is_canceled: true) stops auto-renewal while the
    // subscription stays active to the end of the paid period.
    const r = await tg('editUserStarSubscription', { user_id: chatId, telegram_payment_charge_id: entry.chargeId, is_canceled: true })
    if (!r.ok) return reply('Could not cancel renewal right now. Try again in a minute, or cancel from the payment receipt in this chat.')
    entry.cancelRequested = true
    persist()
    await reply(`Renewal cancelled. Pro stays on until ${proDate(entry.proUntil)}. Cancelled by mistake? Payments resume if you subscribe again.`)
  } else if (command === '/terms') {
    await reply(TERMS)
  } else if (command === '/paysupport') {
    await reply(PAYSUPPORT)
  } else if (command === '/refund') {
    if (chatId !== ADMIN_CHAT_ID) return reply('Only the bot owner can issue refunds.')
    const target = Number(args[0])
    const entry = Number.isInteger(target) && target > 0 ? state.pro?.[target] : null
    if (!entry?.chargeId) return reply('Usage: /refund <chat id> of a chat with an active Pro payment.')
    const r = await tg('refundStarPayment', { user_id: target, telegram_payment_charge_id: entry.chargeId })
    if (!r.ok) return reply(`Refund failed: ${r.description || 'unknown error'}`)
    delete state.pro[target]
    persist()
    await reply(`Refunded ${PRO_PRICE_STARS} Stars (charge ${entry.chargeId}) and revoked Pro for chat ${target}.`)
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
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${offset}&timeout=25`, { signal: AbortSignal.timeout(40000) })
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
    return jsonResponse(res, 200, requestedDevice === null ? digest : { ...digest, paired: chatId !== undefined })
  }
  if (url.pathname === '/api/pair/status' && req.method === 'GET') {
    res.setHeader('cache-control', 'no-store')
    const device = deviceId(url.searchParams.get('device'))
    if (!device) return jsonResponse(res, 400, { ok: false, error: 'invalid_device' })
    return jsonResponse(res, 200, { ok: true, paired: Object.hasOwn(state.devices, device) })
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
        if (chatId !== undefined && !isPro(state.pro?.[chatId]) && savedCountFor(state.saved, chatId, state.chats) >= FREE_MAX_SAVED) {
          await sendToChat(chatId, `Free plan: ${FREE_MAX_SAVED} saved stories limit reached. Your save was not kept. /pro lifts the limit.`)
          return jsonResponse(res, 402, { ok: false, error: 'free_limit', limit: 'saved_stories', hint: `Free plan allows ${FREE_MAX_SAVED} saved stories; /pro in @HeadsUpNewsBot lifts all limits.` })
        }
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
    state.pro ??= {}
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
