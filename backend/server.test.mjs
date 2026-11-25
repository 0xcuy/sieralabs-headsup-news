import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'headsup-test-'))
const { detectBreaking, shouldAlert, rankDigest, createPairing, handleUpdate, refreshWait, savedMessage, server } = await import('./server.mjs')

const now = Date.now()
const hour = 60 * 60 * 1000
const story = (source, title, age = 0) => ({ source, title, url: `https://example.test/${source}/story`, published: new Date(now - age).toUTCString() })
const lead = story('BBC', 'Central bank announces emergency interest rate cut')
const corroborating = story('Guardian', 'Central bank announces emergency interest rate cut today')

test('breaking detection requires distinct feeds or a fresh editorial label', () => {
  assert.equal(detectBreaking([lead, { ...corroborating, source: 'BBC' }], now), undefined)
  assert.equal(detectBreaking([lead, corroborating], now), lead)
  assert.equal(detectBreaking([story('BBC', 'Breaking records with a new marathon time')], now), undefined)
  assert.equal(detectBreaking([story('BBC', 'URGENT: Storm makes landfall', 3 * hour)], now), undefined)
  const urgent = story('BBC', '[Urgent] Storm makes landfall')
  assert.equal(detectBreaking([urgent], now), urgent)
})

test('alert history suppresses recent alerts and repeats from another source', () => {
  const unrelated = story('Al Jazeera', 'URGENT: Storm makes landfall')
  assert.equal(shouldAlert(unrelated, [{ ...lead, at: now - 1 }], now), false)
  assert.equal(shouldAlert(corroborating, [{ ...lead, at: now - 2 * hour }], now), false)
  assert.equal(shouldAlert(unrelated, [{ ...lead, at: now - 2 * hour }], now), true)
})

test('personal ranking keeps breaking first and preserves the global order', () => {
  const digest = [{ headline: 'Lead', breaking: true }, { headline: 'Other' }, { headline: 'Planet', category: 'SCIENCE' }, { headline: 'Jakarta election' }]
  assert.deepEqual(rankDigest(digest, { place: 'indonesia', topics: ['SCIENCE'] }).map(s => s.headline), ['Lead', 'Jakarta election', 'Planet', 'Other'])
  assert.deepEqual(digest.map(s => s.headline), ['Lead', 'Other', 'Planet', 'Jakarta election'])
})

test('pair codes have leading zeroes, are unique while active, single-use and expiring', () => {
  let time = now
  const codes = ['0042', '0042', '0043', '0044']
  const pairs = createPairing(() => time, () => codes.shift())
  const first = pairs.start('device-a')
  assert.deepEqual(pairs.start('device-a'), first)
  assert.equal(pairs.start('device-b').code, '0043')
  assert.deepEqual(pairs.claim('0042', 1), { device: 'device-a' })
  assert.deepEqual(pairs.claim('0042', 1), { error: 'invalid_code' })
  for (let i = 0; i < 4; i++) pairs.claim('0000', 1)
  assert.deepEqual(pairs.claim('0043', 1), { error: 'too_many_attempts' })
  time = first.expiresAt
  assert.deepEqual(pairs.claim('0043', 2), { error: 'invalid_code' })
  assert.equal(pairs.start('device-c').code, '0044')
  assert.deepEqual(pairs.claim('0044', 1), { device: 'device-c' })
})

test('manual refresh cooldown reports the remaining wait', () => {
  assert.equal(refreshWait(undefined, now), null)
  assert.equal(refreshWait(now - 5 * 60 * 1000, now), null)
  assert.equal(refreshWait(now, now), '5 min')
  assert.equal(refreshWait(now - 48 * 1000, now), '4 min 12 s')
  assert.equal(refreshWait(now - 4 * 60 * 1000 - 59500, now), '1 s')
})

test('saved list is per chat, newest first, capped, and survives digest rotation', () => {
  const at = i => new Date(now - i * hour).toISOString()
  const digest = [{ id: 'live', headline: 'Live headline', source: 'BBC', url: 'https://example.test/live' }]
  const saved = [
    { storyId: 'gone', at: at(3) },
    { storyId: 'live', at: at(1), chats: [7] },
    { storyId: 'old', at: at(2), chats: [7], headline: 'Snapshot headline', source: 'Guardian', url: 'https://example.test/old' },
    { storyId: 'other', at: at(0), chats: [8], headline: 'Not mine' },
  ]
  const text = savedMessage(saved, digest, 7, [7])
  assert.deepEqual(text.split('\n\n').slice(1).map(entry => entry.split('\n')[0]),
    ['1. Live headline', '2. Snapshot headline', '3. Saved story (no longer in the digest)'])
  assert.match(text, /\nhttps:\/\/example\.test\/live\nSaved .+ WIB/)
  assert.doesNotMatch(text, /Not mine/)
  assert.match(savedMessage(saved, digest, 9, [7]), /^No saved stories yet/)
  const many = Array.from({ length: 12 }, (_, i) => ({ storyId: `s${i}`, at: at(i), chats: [7], headline: `Story ${i}` }))
  const capped = savedMessage(many, [], 7, [])
  assert.equal(capped.split('\n\n').length, 12)
  assert.match(capped, /1\. Story 0\n/)
  assert.doesNotMatch(capped, /Story 10/)
  assert.match(capped, /Showing the 10 most recent of 12\.$/)
})

test('refresh, Telegram preferences, pairing, and device digest/save work together', async t => {
  const httpFetch = fetch
  const feedStories = [
    [lead, story('BBC', 'Officials announce programs for residents', hour), story('BBC', 'Jakarta election results released', hour)],
    [corroborating], [], [],
  ]
  const feedHosts = ['feeds.bbci.co.uk', 'www.theguardian.com', 'www.aljazeera.com', 'www.theverge.com']
  const sent = []
  const summary = 'A [draft and an _underscore appear.'
  let rejectDelivery = false
  let translations = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const host = new URL(url).hostname
    if (feedHosts.includes(host)) {
      const items = feedStories[feedHosts.indexOf(host)].map(s => `<item><title>${s.title}</title><link>${s.url}/${encodeURIComponent(s.title)}</link><description>RSS metadata only</description><pubDate>${s.published}</pubDate></item>`)
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`)
    }
    if (host === 'router-api.0g.ai') {
      const prompt = JSON.parse(options.body).messages[0].content
      let rows = [{ candidate: 2, headline: 'Other news', summary, category: 'SCIENCE' }, { candidate: 3, headline: 'Local news', category: 'WORLD' }]
      if (prompt.startsWith('Translate')) {
        translations++
        rows = JSON.parse(prompt.split('\n').at(-1)).map(row => ({ ...row, headline: `ID ${row.headline}` }))
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(rows) } }] })
    }
    assert.equal(host, 'api.telegram.org')
    sent.push(JSON.parse(options.body))
    if (rejectDelivery) return Response.json({ ok: false, description: 'Bad Request: delivery rejected' }, { status: 400 })
    return Response.json({ ok: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(process.env.STATE_DIR, { recursive: true, force: true })
  })
  const api = (path, body) => httpFetch(`http://127.0.0.1:${server.address().port}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  const bot = (id, text) => handleUpdate({ message: { chat: { id, type: 'private' }, text } })
  await bot(1, '/start')
  await bot(2, '/start')
  await bot(2, '/alerts off')
  await api('/api/refresh', {})
  await api('/api/refresh', {})
  assert.deepEqual(sent.filter(m => m.text.startsWith('🚨')).map(m => m.chat_id), [1])
  const device = randomUUID()
  const digests = async id => (await api(`/api/digest${id ? `?device=${id}` : ''}`)).json()
  const global = await digests()
  assert.equal(global.stories[0].headline, lead.title)
  assert.equal(global.stories[0].source, 'BBC')
  assert.equal(global.stories[1].headline, 'Other news')
  assert.deepEqual(await digests(device), global)
  const assertPlainDigest = (digest, title, updatedLabel) => {
    const delivery = sent.at(-1)
    assert.equal(Object.hasOwn(delivery, 'parse_mode'), false)
    const [header, ...sections] = delivery.text.split('\n\n')
    assert.equal(header.split('\n')[0], `📰 Heads Up — ${title}`)
    assert.match(header.split('\n')[1], new RegExp(`^${updatedLabel} .+ WIB$`))
    assert.deepEqual(sections, digest.stories.map((s, i) =>
      [`${i + 1}. ${s.headline}`, s.summary, s.source, s.url].filter(Boolean).join('\n')))
    assert.ok(delivery.text.includes(summary))
  }
  await bot(1, '/digest')
  assertPlainDigest(global, 'News Digest', 'Updated')
  const start = await api('/api/pair/start', { device })
  const { code } = await start.json()
  assert.match(code, /^\d{4}$/)
  await bot(2, `/pair ${code}`)
  assert.equal((await api('/api/pair/start', { device })).status, 409)
  await bot(2, '/place Indonesia')
  await bot(2, '/topics science')
  await bot(2, '/lang id')
  await bot(2, '/digest')
  assert.match(sent.at(-1).text, /Ringkasan Berita/)
  const personalized = await digests(device)
  assertPlainDigest(personalized, 'Ringkasan Berita', 'Diperbarui')
  assert.equal(personalized.lang, 'id')
  assert.deepEqual(personalized.stories.map(s => s.headline), [`ID ${lead.title}`, 'ID Local news', 'ID Other news'])
  assert.equal(translations, 1)
  assert.deepEqual(await digests(), global)
  assert.equal((await api('/api/save', { storyId: global.stories[0].id, device })).status, 200)
  assert.equal(sent.at(-1).chat_id, 2)
  assert.equal((await api('/api/save', { storyId: global.stories[0].id, device: randomUUID() })).status, 409)
  await bot(1, '/saved')
  assert.match(sent.at(-1).text, /^No saved stories yet/)
  await bot(2, '/saved')
  assert.match(sent.at(-1).text, new RegExp(`^🔖 Saved stories\n\n1\. ${lead.title}\nBBC\n`))
  await bot(2, '/refresh')
  const refreshed = await digests(device)
  assert.notEqual(refreshed.updatedAt, personalized.updatedAt)
  assert.notEqual(refreshed.stories[0].id, personalized.stories[0].id)
  assertPlainDigest(refreshed, 'Ringkasan Berita', 'Diperbarui')
  await bot(2, '/refresh')
  assert.match(sent.at(-1).text, /^You can refresh again in (?:4 min \d+ s|5 min)\./)
  assert.equal((await digests(device)).updatedAt, refreshed.updatedAt)
  await bot(2, '/saved')
  assert.match(sent.at(-1).text, new RegExp(`^🔖 Saved stories\n\n1\. ${lead.title}\nBBC\n`))
  await bot(2, '/pro')
  assert.match(sent.at(-1).text, /Free\n- 8-story digest every 30 min[\s\S]*Pro — \$3\/month[\s\S]*Up to 3 paired devices[\s\S]*Payment is not wired up yet \(coming soon\)\./)
  await bot(2, '/help')
  for (const command of ['/saved', '/refresh', '/pro']) assert.match(sent.at(-1).text, new RegExp(`^${command} — `, 'm'))
  await bot(2, '/sources')
  assert.match(sent.at(-1).text, /BBC: .*\nGuardian: .*\nAl Jazeera: .*\nThe Verge:/)
  const logError = t.mock.method(console, 'error', () => {})
  rejectDelivery = true
  await bot(2, '/digest')
  assert.deepEqual(logError.mock.calls.map(call => call.arguments), [
    ['[tg] send failed', 2, 'Bad Request: delivery rejected'],
  ])
  assert.ok(sent.every(message => !Object.hasOwn(message, 'parse_mode')))
  const state = JSON.parse(await readFile(join(process.env.STATE_DIR, 'state.json'), 'utf8'))
  assert.equal(state.alerts.length, 1)
  assert.equal(state.devices[device], 2)
  assert.deepEqual(state.saved.map(({ chats, headline }) => ({ chats, headline })), [{ chats: [2], headline: lead.title }])
  assert.deepEqual(state.preferences[2], { alerts: false, place: 'indonesia', topics: ['SCIENCE'], lang: 'id' })
})
