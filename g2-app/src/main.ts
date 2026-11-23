// Heads Up News — Even Realities G2 app (SIERA Labs).
// A glanceable AI news digest for the Messaging & News track.
// One story on screen at a time. The action list below the story is the
// write path: scroll the R1 ring to pick an action, tap to run it —
// next story, save the story to Telegram (@HeadsUpNewsBot), or voice
// command ("next" / "save this" / "repeat" via the glasses mic, transcribed
// by Whisper on the backend). Double-tap anywhere exits. Digest comes from
// the Heads Up backend (RSS -> GLM digest -> JSON API).
//
// SDK rule (README): exactly ONE container may have isEventCapture=1 —
// the action list owns it; the text containers are display-only.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const API_BASE = 'https://headsup.sieralabs.com'
const HEADER_ID = 1
const STORY_ID = 2
const ACTIONS_ID = 3

const ACTION_NEXT = 0
const ACTION_SAVE = 1
const ACTION_VOICE = 2

// Voice: the SDK mic delivers 16kHz signed 16-bit little-endian mono PCM
// (simulator spec — 100ms / 3200 bytes per audioEvent; the real G2 mic
// uses the same format). We record a fixed window, wrap it in a WAV header
// and POST it to /api/voice, which runs Whisper and returns a command.
const VOICE_SAMPLE_RATE = 16000
const VOICE_WINDOW_MS = 4000
const VOICE_SILENCE_MAX = 300 // max |int16| below this counts as silence

type Story = {
  id: string
  headline: string
  summary: string
  category: string
  source: string
  url: string
  published: string
}

let stories: Story[] = []
let index = 0
let updatedAt = ''
let saveFlash = ''
let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>> | null = null

// Voice capture state. Listening is additive: ring + tap keep working the
// whole time, and any failure here only flashes a hint — it never touches
// the story list or the save path.
let listening = false
let pcmChunks: Uint8Array[] = []
let listenTimer: number | null = null

const domApp = document.getElementById('app')

function timeLabel(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB'
  } catch {
    return ''
  }
}

function headerText(): string {
  if (saveFlash) return saveFlash
  const n = stories.length
  return n === 0 ? 'HEADS UP · NEWS' : `HEADS UP · NEWS   ${n} stories · ${timeLabel(updatedAt)}`
}

function storyText(): string {
  if (stories.length === 0) return 'Fetching today\'s digest…\nGlanceable news, one story at a time.'
  const s = stories[index]
  return `${index + 1}/${stories.length} · ${s.category} — ${s.source}\n${s.headline}\n${s.summary}`
}

async function pushToGlasses() {
  if (!bridge) return
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER_ID, containerName: 'header', content: headerText() }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: STORY_ID, containerName: 'story', content: storyText() }))
}

function renderDomFallback() {
  if (!domApp) return
  if (stories.length === 0) {
    domApp.innerHTML = '<p>Fetching today\'s digest…</p>'
    return
  }
  const s = stories[index]
  domApp.innerHTML = `
    <div style="text-align:left;max-width:520px">
      <div style="opacity:.7;font-size:13px">${headerText()}</div>
      <h2 style="margin:12px 0 6px">${index + 1}/${stories.length} · ${s.category} — ${s.source}</h2>
      <div style="font-size:20px;font-weight:700">${s.headline}</div>
      <p style="font-size:15px">${s.summary}</p>
      <button id="nextBtn">Next story →</button>
      <button id="saveBtn">★ Save to Telegram</button>
      <button id="refreshBtn">↻ Refresh</button>
      <button id="voiceBtn">Voice command</button>
    </div>`
  document.getElementById('nextBtn')?.addEventListener('click', () => nextStory())
  document.getElementById('saveBtn')?.addEventListener('click', () => saveCurrent())
  document.getElementById('refreshBtn')?.addEventListener('click', () => loadDigest())
  // Browser preview only: record ~4s with the laptop mic and run it through
  // the same /api/voice endpoint as the glasses mic. Guarded — if the
  // browser has no mic API, the button just reports that.
  document.getElementById('voiceBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('voiceBtn')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      flash('🎤 No browser mic here — voice needs the glasses')
      return
    }
    try {
      if (btn) btn.textContent = 'Listening… (4s)'
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const parts: Blob[] = []
      rec.ondataavailable = e => { if (e.data.size > 0) parts.push(e.data) }
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        if (btn) btn.textContent = 'Voice command'
        if (parts.length === 0) { flash('🎤 Nothing heard — try again'); return }
        flash('🎤 Heard you — thinking…')
        void sendVoiceAudio(new Blob(parts, { type: rec.mimeType || 'audio/webm' }), rec.mimeType || 'audio/webm')
      }
      rec.start()
      window.setTimeout(() => { if (rec.state !== 'inactive') rec.stop() }, VOICE_WINDOW_MS)
    } catch {
      if (btn) btn.textContent = 'Voice command'
      flash('🎤 Mic blocked — allow microphone access and try again')
    }
  })
}

async function refresh() {
  // Keep the companion WebView (left pane in the simulator / plain browser)
  // in sync with the glasses display.
  renderDomFallback()
  if (bridge) await pushToGlasses()
}

function flash(msg: string) {
  saveFlash = msg
  void refresh()
  window.setTimeout(() => { saveFlash = ''; void refresh() }, 4000)
}

function nextStory() {
  if (stories.length === 0) return
  index = (index + 1) % stories.length
  saveFlash = ''
  void refresh()
}

async function saveCurrent(viaVoice = false) {
  if (stories.length === 0) return
  const s = stories[index]
  flash('Saving…')
  try {
    const res = await fetch(`${API_BASE}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storyId: s.id }),
    })
    const data = await res.json()
    if (res.ok && data.ok) {
      flash(viaVoice ? '🎤 ★ SAVED — sent to your Telegram' : '★ SAVED — sent to your Telegram')
    } else if (res.status === 409) {
      flash('Open Telegram → /start @HeadsUpNewsBot first')
    } else {
      flash('Save failed — try again')
    }
  } catch {
    flash('Save failed — no connection to backend')
  }
}

// ---------- Voice commands ----------

// The host may deliver PCM as a Uint8Array, a plain number[] or a base64
// string (SDK types note the JSON bridge varies) — normalize to bytes.
function normalizePcm(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) {
    try { return Uint8Array.from(raw as number[]) } catch { return null }
  }
  if (typeof raw === 'string') {
    try {
      const bin = atob(raw)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch { return null }
  }
  return null
}

// Wrap raw 16kHz s16le mono PCM in a 44-byte WAV header so the backend can
// forward it to Whisper as a self-describing file.
function pcmToWav(pcm: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.length)
  const v = new DataView(out)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM format
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, VOICE_SAMPLE_RATE, true)
  v.setUint32(28, VOICE_SAMPLE_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, pcm.length, true)
  new Uint8Array(out, 44).set(pcm)
  return out
}

function pcmIsSilent(chunks: Uint8Array[]): boolean {
  let peak = 0
  for (const c of chunks) {
    for (let i = 0; i + 1 < c.length; i += 2) {
      const s = Math.abs(c[i] | (c[i + 1] << 8))
      if (s > peak) peak = s
      if (peak >= VOICE_SILENCE_MAX) return false
    }
  }
  return true
}

function handleVoiceResult(data: { ok?: boolean; transcript?: string; command?: string | null }) {
  if (!data.ok) {
    flash('🎤 Voice didn\'t work — ring + tap still works')
    return
  }
  const cmd = data.command
  if (cmd === 'next') {
    nextStory()
    flash('🎤 Next story')
  } else if (cmd === 'save') {
    void saveCurrent(true)
  } else if (cmd === 'repeat') {
    // Re-display the current story: re-push it to the glasses + confirm.
    flash(`🎤 Repeating ${index + 1}/${stories.length}`)
    void refresh()
  } else {
    const heard = (data.transcript || '').trim().slice(0, 24)
    flash(heard ? `🎤 Heard "${heard}" — try "next" or "save this"` : '🎤 Didn\'t catch that — try "next" or "save this"')
  }
}

// Voice is async: the clip is queued on the backend (POST /api/voice
// returns a jobId) and a poller on the Muse VM transcribes it with Deepgram
// and posts the transcript back. Poll for the result for up to ~15s.
const VOICE_POLL_MS = 1000
const VOICE_POLL_MAX = 15

async function sendVoiceAudio(body: ArrayBuffer | Blob, contentType: string) {
  let jobId = ''
  try {
    const res = await fetch(`${API_BASE}/api/voice`, { method: 'POST', headers: { 'content-type': contentType }, body })
    const data = await res.json()
    if (res.status === 503 || data.error === 'voice_unavailable') {
      flash('🎤 Voice is offline right now — ring + tap still works')
      return
    }
    if (!res.ok || !data.jobId) {
      flash('🎤 Voice didn\'t work — ring + tap still works')
      return
    }
    jobId = data.jobId
  } catch {
    flash('🎤 Voice didn\'t work — ring + tap still works')
    return
  }
  for (let i = 0; i < VOICE_POLL_MAX; i++) {
    await new Promise(r => window.setTimeout(r, VOICE_POLL_MS))
    try {
      const res = await fetch(`${API_BASE}/api/voice/${jobId}`)
      const data = await res.json()
      if (data.status === 'done') { handleVoiceResult(data); return }
      if (data.status === 'error') { flash('🎤 Voice didn\'t work — ring + tap still works'); return }
    } catch {
      // Transient fetch failure while polling: keep waiting until the cap.
    }
  }
  flash('🎤 Voice timed out — ring + tap still works')
}

function closeMic() {
  if (!bridge) return
  // Best-effort: never let a mic failure break the app.
  void bridge.audioControl(false).catch(() => {})
}

function stopListening() {
  if (listenTimer !== null) { window.clearTimeout(listenTimer); listenTimer = null }
  if (!listening) return
  listening = false
  closeMic()
  if (pcmChunks.length === 0 || pcmIsSilent(pcmChunks)) {
    flash('🎤 Nothing heard — try again')
    pcmChunks = []
    return
  }
  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Uint8Array(total)
  let off = 0
  for (const c of pcmChunks) { pcm.set(c, off); off += c.length }
  pcmChunks = []
  flash('🎤 Heard you — thinking…')
  void sendVoiceAudio(pcmToWav(pcm), 'audio/wav')
}

// User picked another action mid-listen: stop quietly, mic off, no flash.
function cancelListening() {
  if (listenTimer !== null) { window.clearTimeout(listenTimer); listenTimer = null }
  if (!listening) return
  listening = false
  pcmChunks = []
  closeMic()
}

async function startListening() {
  if (listening) return
  if (!bridge) { flash('🎤 Voice needs the glasses — use ring + tap here'); return }
  listening = true
  pcmChunks = []
  flash('🎤 Listening… say "next", "save this" or "repeat"')
  let opened = false
  try {
    opened = await bridge.audioControl(true)
  } catch {
    opened = false
  }
  if (!opened) {
    listening = false
    flash('🎤 Mic unavailable — use ring + tap')
    return
  }
  listenTimer = window.setTimeout(() => stopListening(), VOICE_WINDOW_MS)
}

async function loadDigest() {
  try {
    const res = await fetch(`${API_BASE}/api/digest`)
    const data = await res.json()
    if (Array.isArray(data.stories) && data.stories.length > 0) {
      stories = data.stories
      updatedAt = data.updatedAt || ''
      if (index >= stories.length) index = 0
    }
  } catch (e) {
    console.error('Digest fetch failed:', e)
  }
  await refresh()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all, so every scroll,
// exit and audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

async function startGlasses() {
  bridge = await waitForEvenAppBridge()

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 30,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: HEADER_ID, containerName: 'header',
    content: headerText(), isEventCapture: 0,
  })
  const story = new TextContainerProperty({
    xPosition: 0, yPosition: 32, width: 576, height: 164,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: STORY_ID, containerName: 'story',
    content: storyText(), isEventCapture: 0,
  })
  // The ONLY event-capturing container: the action list.
  // Three rows; the 288px canvas shows two at a time and the ring scrolls
  // to the third ("Voice command"). Digest auto-refreshes every 5 min,
  // so no manual Refresh item is needed here.
  const actions = new ListContainerProperty({
    xPosition: 0, yPosition: 200, width: 576, height: 84,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: ACTIONS_ID, containerName: 'actions',
    itemContainer: new ListItemContainerProperty({
      itemCount: 3,
      itemWidth: 400,
      isItemSelectBorderEn: 1,
      itemName: ['Next story ▶', '★ Save to Telegram', 'Voice command'],
    }),
    isEventCapture: 1,
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [header, story],
      listObject: [actions],
    }),
  )
  console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)

    // Double-tap → exit, from any envelope, always.
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge?.shutDownPageContainer(1)
      return
    }

    // Mic audio frames: collect while listening. The envelope carries no
    // sysEvent/listEvent, so this branch runs before the tap handling below
    // and never triggers an action by itself.
    if (event.audioEvent) {
      if (listening) {
        const pcm = normalizePcm(event.audioEvent.audioPcm)
        if (pcm && pcm.length > 0) pcmChunks.push(pcm)
      }
      return
    }

    // Action list selection (ring scroll + tap).
    if (event.listEvent) {
      // Protobuf omits zero-value fields: index 0 arrives as `undefined`.
      // Same quirk as CLICK_EVENT=0 — resolve the default explicitly.
      const i = event.listEvent.currentSelectItemIndex ?? 0
      if (i === ACTION_VOICE) { void startListening(); return }
      cancelListening()
      if (i === ACTION_NEXT) nextStory()
      else if (i === ACTION_SAVE) void saveCurrent()
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      unsubscribe()
    }
  })
}

// Boot: try the glasses bridge; if it never appears (plain browser preview),
// fall back to the DOM mirror so the app is still demoable on screen.
const bridgeTimer = window.setTimeout(() => {
  console.log('No Even Hub bridge — running DOM fallback preview.')
  void loadDigest()
  window.setInterval(() => void loadDigest(), 5 * 60 * 1000)
}, 3000)

startGlasses()
  .then(() => {
    window.clearTimeout(bridgeTimer)
    void loadDigest()
    window.setInterval(() => void loadDigest(), 5 * 60 * 1000)
  })
  .catch(e => {
    console.error('Bridge init failed, DOM fallback:', e)
    window.clearTimeout(bridgeTimer)
    void loadDigest()
    window.setInterval(() => void loadDigest(), 5 * 60 * 1000)
  })
