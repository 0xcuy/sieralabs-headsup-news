// Payments tests: the Telegram Stars Pro subscription, run against a mocked
// Bot API with no token present (the backend only reaches Telegram through
// fetch, which node:test mocks here).
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'headsup-pay-test-'))
process.env.ADMIN_CHAT_ID = '9001'
const { handleUpdate, isPro, refreshWait, server } = await import('./server.mjs')

const stateFile = join(process.env.STATE_DIR, 'state.json')
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))
const until = timestamp => new Date(timestamp * 1000).toISOString()
const proDate = iso => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' })

test('isPro is true only until the stored expiry; Free refresh waits 30 minutes', () => {
  const now = Date.now()
  assert.equal(isPro({ proUntil: new Date(now + 3_600_000).toISOString() }, now), true)
  assert.equal(isPro({ proUntil: new Date(now - 1000).toISOString() }, now), false)
  assert.equal(isPro(undefined, now), false)
  assert.equal(isPro({}, now), false)
  assert.equal(isPro({ proUntil: 'garbage' }, now), false)
  const halfHour = 30 * 60 * 1000
  assert.equal(refreshWait(now, now, halfHour), '30 min')
  assert.equal(refreshWait(now - 5 * 60 * 1000, now, halfHour), '25 min')
  assert.equal(refreshWait(now, now), '5 min') // Pro default stays 5 min
})

test('Stars subscription: invoice, pre-checkout, payment, renewal, cancel, refund, limits, atomic state', async t => {
  const httpFetch = fetch
  const CHAT = 42, ADMIN = 9001
  const sent = []       // sendMessage bodies
  const answers = []    // answerPreCheckoutQuery bodies
  const edits = []      // editUserStarSubscription bodies
  const refunds = []    // refundStarPayment bodies
  const invoices = []   // createInvoiceLink bodies
  const feedHosts = ['feeds.bbci.co.uk', 'www.theguardian.com', 'www.aljazeera.com', 'www.theverge.com']
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const host = new URL(url).hostname
    if (feedHosts.includes(host)) {
      const items = host === feedHosts[0]
        ? ['Central bank cuts rates again', 'Jakarta marathon draws record field'].map((title, i) =>
          `<item><title>${title}</title><link>https://example.test/news/${i}</link><description>RSS metadata only</description><pubDate>${new Date(Date.now() - i * 3_600_000).toUTCString()}</pubDate></item>`)
        : []
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`)
    }
    if (host === 'router-api.0g.ai') {
      const rows = [{ candidate: 1, headline: 'Rates cut sharply', summary: 'The bank moved early.', category: 'BUSINESS' }, { candidate: 2, headline: 'Marathon record', summary: '', category: 'SPORT' }]
      return Response.json({ choices: [{ message: { content: JSON.stringify(rows) } }] })
    }
    assert.equal(host, 'api.telegram.org')
    const method = url.split('/').at(-1)
    const body = JSON.parse(options.body)
    if (method === 'createInvoiceLink') { invoices.push(body); return Response.json({ ok: true, result: 'https://t.me/test-invoice-link' }) }
    if (method === 'answerPreCheckoutQuery') { answers.push(body); return Response.json({ ok: true, result: true }) }
    if (method === 'editUserStarSubscription') { edits.push(body); return Response.json({ ok: true, result: true }) }
    if (method === 'refundStarPayment') { refunds.push(body); return Response.json({ ok: true, result: true }) }
    assert.equal(method, 'sendMessage')
    sent.push(body)
    return Response.json({ ok: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)) })
  const api = (path, body) => httpFetch(`http://127.0.0.1:${server.address().port}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const bot = (id, text) => handleUpdate({ message: { chat: { id, type: 'private' }, text } })
  const pay = (chatId, chargeId, expirationDate) => handleUpdate({ message: { chat: { id: chatId, type: 'private' }, from: { id: chatId }, successful_payment: {
    currency: 'XTR', total_amount: 150, invoice_payload: 'headsup-pro-subscription',
    telegram_payment_charge_id: chargeId, subscription_expiration_date: expirationDate, is_recurring: true, is_first_recurring: false,
  } } })

  await bot(CHAT, '/start')
  await bot(ADMIN, '/start')
  await api('/api/refresh', {})
  const digest = (await (await api('/api/digest')).json()).stories
  const storyId = digest[0].id
  const device = randomUUID()
  const secondDevice = randomUUID()
  const pairDevice = async deviceUuid => {
    const { code } = await (await api('/api/pair/start', { device: deviceUuid })).json()
    await bot(CHAT, `/pair ${code}`)
  }
  const status = async deviceUuid => (await api(`/api/pair/status?device=${deviceUuid}`)).json()
  await pairDevice(device)

  // Free: /refresh only every 30 minutes.
  const beforeFirstRefresh = sent.length
  await bot(CHAT, '/refresh')
  assert.equal(sent.at(-1).text, 'Refreshing now. Your new digest will follow in a moment.')
  for (let i = 0; i < 200 && !(sent.length > beforeFirstRefresh + 1 && sent.at(-1).text.startsWith('📰')); i++) await new Promise(resolve => setTimeout(resolve, 10))
  await bot(CHAT, '/refresh')
  assert.match(sent.at(-1).text, /^You can refresh again in (?:29 min \d+ s|30 min)\. Free plan refreshes every 30 min; \/pro gets 5 min\.$/)

  // Free: 20 saves, the 21st is refused.
  for (let i = 0; i < 20; i++) assert.equal((await api('/api/save', { storyId, device })).status, 200)
  const twentyFirst = await api('/api/save', { storyId, device })
  assert.equal(twentyFirst.status, 402)
  assert.deepEqual(await twentyFirst.json(), { ok: false, error: 'free_limit', limit: 'saved_stories', hint: 'Free plan allows 20 saved stories; /pro in @HeadsUpNewsBot lifts all limits.' })
  assert.equal(sent.at(-1).text, 'Free plan: 20 saved stories limit reached. Your save was not kept. /pro lifts the limit.')

  // Free: at most 3 priority topics.
  await bot(CHAT, '/topics world tech business sport')
  assert.equal(sent.at(-1).text, 'Free allows up to 3 priority topics. Pro lifts the limit; see /pro.')
  await bot(CHAT, '/topics world tech business')
  assert.match(sent.at(-1).text, /^Priority topics: WORLD, TECH, BUSINESS\./)

  // Free: 1 paired glasses; the second is refused (and the code stays unused).
  await pairDevice(secondDevice)
  assert.equal(sent.at(-1).text, 'Your plan allows 1 paired glasses. See /pro to pair up to 3.')
  assert.deepEqual(await status(secondDevice), { ok: true, paired: false })

  // /pro shows the plans with a Stars subscription button.
  await bot(CHAT, '/pro')
  assert.deepEqual(invoices, [{
    title: 'Heads Up News Pro',
    description: 'Unlimited saves and topics, /refresh every 5 min, up to 3 paired glasses. Renews every 30 days; cancel anytime with /cancelpro.',
    payload: 'headsup-pro-subscription',
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: 'Heads Up News Pro', amount: 150 }],
    subscription_period: 2592000,
  }])
  const proDelivery = sent.at(-1)
  assert.match(proDelivery.text, /Free\n- 8-story digest every 30 min\n- Breaking alerts\n- 20 saved stories\n- 3 priority topics\n- \/refresh every 30 min\n- 1 paired glasses[\s\S]*Pro — 150 Telegram Stars \/ month[\s\S]*Cancel anytime with \/cancelpro; Pro runs until the paid period ends\.$/)
  assert.deepEqual(proDelivery.reply_markup, { inline_keyboard: [[{ text: 'Upgrade: 150 ⭐/month', url: 'https://t.me/test-invoice-link' }]] })
  assert.equal(Object.hasOwn(proDelivery, 'parse_mode'), false)

  // Pre-checkout: approve within the 10-second window; reject foreign payloads.
  await handleUpdate({ pre_checkout_query: { id: 'pcq-ok', from: { id: CHAT }, currency: 'XTR', total_amount: 150, invoice_payload: 'headsup-pro-subscription' } })
  assert.deepEqual(answers, [{ pre_checkout_query_id: 'pcq-ok', ok: true }])
  await handleUpdate({ pre_checkout_query: { id: 'pcq-bad', from: { id: CHAT }, currency: 'XTR', total_amount: 150, invoice_payload: 'someone-elses-bot' } })
  assert.deepEqual(answers.at(-1), { pre_checkout_query_id: 'pcq-bad', ok: false, error_message: 'This invoice is no longer available. Send /pro for a fresh upgrade link.' })

  // First successful payment: store proUntil and confirm in plain text.
  const month = 30 * 24 * 3600
  const firstExpiry = Math.floor(Date.now() / 1000) + month
  await pay(CHAT, 'chg-1', firstExpiry)
  assert.deepEqual((await readState()).pro[CHAT], { proUntil: until(firstExpiry), chargeId: 'chg-1', cancelRequested: false })
  assert.equal(sent.at(-1).text, `Pro active until ${proDate(until(firstExpiry))}.\nRenews automatically every 30 days; /cancelpro stops renewal.`)
  assert.equal(Object.hasOwn(sent.at(-1), 'parse_mode'), false)

  // Pro lifts the limits: save #21 works, 4 topics allowed, second glasses pairs,
  // /refresh cooldown drops from 30 to 5 minutes.
  assert.equal((await api('/api/save', { storyId, device })).status, 200)
  await bot(CHAT, '/topics world tech business sport')
  assert.match(sent.at(-1).text, /^Priority topics: WORLD, TECH, BUSINESS, SPORT\./)
  await pairDevice(secondDevice)
  assert.match(sent.at(-1).text, /^Glasses paired\./)
  assert.deepEqual(await status(secondDevice), { ok: true, paired: true })
  await bot(CHAT, '/refresh')
  assert.match(sent.at(-1).text, /^You can refresh again in (?:[1-4] min \d+ s|5 min)\. The digest also refreshes every 30 min\.$/)

  // Renewal: the next successful payment pushes the stored expiry forward.
  const renewalExpiry = firstExpiry + month
  await pay(CHAT, 'chg-2', renewalExpiry)
  const proStateAfterRenewal = (await readState()).pro[CHAT]
  assert.equal(proStateAfterRenewal.proUntil, until(renewalExpiry))
  assert.equal(proStateAfterRenewal.chargeId, 'chg-2')
  assert.equal(sent.at(-1).text, `Pro active until ${proDate(until(renewalExpiry))}.\nRenews automatically every 30 days; /cancelpro stops renewal.`)

  // /cancelpro stops renewal but keeps Pro until the paid period ends.
  await bot(CHAT, '/cancelpro')
  assert.deepEqual(edits, [{ user_id: CHAT, telegram_payment_charge_id: 'chg-2', is_canceled: true }])
  assert.equal((await readState()).pro[CHAT].cancelRequested, true)
  assert.match(sent.at(-1).text, new RegExp(`^Renewal cancelled\\. Pro stays on until ${proDate(until(renewalExpiry))}\\.`))
  assert.equal((await api('/api/save', { storyId, device })).status, 200) // still Pro
  await bot(CHAT, '/cancelpro')
  assert.match(sent.at(-1).text, /^Renewal is already stopped\. Pro stays on until /)

  // /refund is owner-only and revokes Pro.
  const thirdCharge = Math.floor(Date.now() / 1000) + month
  await pay(CHAT, 'chg-3', thirdCharge)
  await bot(CHAT, `/refund ${CHAT}`)
  assert.equal(sent.at(-1).text, 'Only the bot owner can issue refunds.')
  assert.deepEqual(refunds, [])
  await bot(ADMIN, `/refund ${CHAT}`)
  assert.deepEqual(refunds, [{ user_id: CHAT, telegram_payment_charge_id: 'chg-3' }])
  assert.equal(sent.at(-1).text, 'Refunded 150 Stars (charge chg-3) and revoked Pro for chat 42.')
  assert.equal((await readState()).pro[CHAT], undefined)
  assert.equal((await api('/api/save', { storyId, device })).status, 402)
  await bot(CHAT, '/topics world tech business sport')
  assert.equal(sent.at(-1).text, 'Free allows up to 3 priority topics. Pro lifts the limit; see /pro.')

  // When renewal stops, Pro simply turns off at the expiry date (no cron).
  const shortExpiry = Math.floor((Date.now() + 1500) / 1000)
  await pay(CHAT, 'chg-4', shortExpiry)
  assert.equal((await api('/api/save', { storyId, device })).status, 200) // Pro for the last moment
  await new Promise(resolve => setTimeout(resolve, 1700))
  assert.equal((await api('/api/save', { storyId, device })).status, 402)

  // Compliance texts Telegram requires before going live.
  await bot(CHAT, '/terms')
  assert.match(sent.at(-1).text, /Price: 150 Telegram Stars every 30 days[\s\S]*\/cancelpro stops renewal[\s\S]*without warranty\.$/)
  await bot(CHAT, '/paysupport')
  assert.match(sent.at(-1).text, /150 Stars \/ 30 days[\s\S]*Telegram support cannot help with purchases made via this bot[\s\S]*\/cancelpro here or the payment receipt/)
  await bot(CHAT, '/help')
  for (const command of ['/pro', '/cancelpro', '/terms', '/paysupport']) assert.match(sent.at(-1).text, new RegExp(`^${command} — `, 'm'))

  // Atomic state writes: valid state.json, a kept .bak, no leftover temp file.
  const current = await readState()
  assert.ok(Array.isArray(current.saved) && current.saved.length >= 20)
  const backup = JSON.parse(await readFile(join(process.env.STATE_DIR, 'state.json.bak'), 'utf8'))
  assert.ok(Array.isArray(backup.saved))
  await assert.rejects(access(join(process.env.STATE_DIR, 'state.json.tmp'), constants.F_OK))
  assert.ok(sent.every(message => !Object.hasOwn(message, 'parse_mode')))
})
