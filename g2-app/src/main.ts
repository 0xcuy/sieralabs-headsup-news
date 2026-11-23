// Heads Up News — Even Realities G2 app (SIERA Labs).
// A glanceable AI news digest for the Messaging & News track.
// One story on screen at a time. The action list below the story is the
// write path: scroll the R1 ring to pick an action, tap to run it —
// next story, save the story to Telegram (@HeadsUpNewsBot), refresh.
// Double-tap anywhere exits. Digest comes from the Heads Up backend
// (RSS -> GLM digest -> JSON API).
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

const API_BASE = 'http://159.89.197.202:8787'
const HEADER_ID = 1
const STORY_ID = 2
const ACTIONS_ID = 3

const ACTION_NEXT = 0
const ACTION_SAVE = 1

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
    </div>`
  document.getElementById('nextBtn')?.addEventListener('click', () => nextStory())
  document.getElementById('saveBtn')?.addEventListener('click', () => saveCurrent())
  document.getElementById('refreshBtn')?.addEventListener('click', () => loadDigest())
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

async function saveCurrent() {
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
      flash('★ SAVED — sent to your Telegram')
    } else if (res.status === 409) {
      flash('Open Telegram → /start @HeadsUpNewsBot first')
    } else {
      flash('Save failed — try again')
    }
  } catch {
    flash('Save failed — no connection to backend')
  }
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
  // Two rows fit the 288px canvas; digest auto-refreshes every 5 min,
  // so no manual Refresh item is needed here.
  const actions = new ListContainerProperty({
    xPosition: 0, yPosition: 200, width: 576, height: 84,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: ACTIONS_ID, containerName: 'actions',
    itemContainer: new ListItemContainerProperty({
      itemCount: 2,
      itemWidth: 400,
      isItemSelectBorderEn: 1,
      itemName: ['Next story ▶', '★ Save to Telegram'],
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

    // Action list selection (ring scroll + tap).
    if (event.listEvent) {
      // Protobuf omits zero-value fields: index 0 arrives as `undefined`.
      // Same quirk as CLICK_EVENT=0 — resolve the default explicitly.
      const i = event.listEvent.currentSelectItemIndex ?? 0
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
