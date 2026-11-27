import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'headsup-breaking-'))
const { fastBreakingCheck, topicRecipients, handleUpdate } = await import('./server.mjs')

const now = Date.now()
const hour = 60 * 60 * 1000
const story = (source, title, age = 0) => ({ source, title, url: `https://example.test/${source}/story`, published: new Date(now - age).toUTCString() })

test('topic filter: alerts follow the chosen topics, empty topics mean everyone', () => {
  const chats = [1, 2, 3, 4]
  const preferences = {
    1: { alerts: false, topics: [] },
    2: { topics: ['SCIENCE'] },
    3: { topics: [] },
    4: {},
  }
  assert.deepEqual(topicRecipients('SCIENCE', chats, preferences), [2, 3, 4])
  assert.deepEqual(topicRecipients('WORLD', chats, preferences), [3, 4])
  assert.deepEqual(topicRecipients(undefined, chats, preferences), [3, 4])
})

test('fast breaking loop: alerts once, filtered by topic, and stays silent within the cooldown', async t => {
  const feedStories = [
    [story('BBC', 'Breaking: quake hits coastal city'), story('BBC', 'Regular quarterly roundup')],
    [], [], [],
  ]
  const feedHosts = ['feeds.bbci.co.uk', 'www.theguardian.com', 'www.aljazeera.com', 'www.theverge.com']
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const host = new URL(url).hostname
    if (feedHosts.includes(host)) {
      const items = feedStories[feedHosts.indexOf(host)].map(s => `<item><title>${s.title}</title><link>${s.url}</link><description>RSS metadata only</description><pubDate>${s.published}</pubDate></item>`)
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`)
    }
    assert.equal(host, 'api.telegram.org')
    sent.push(JSON.parse(options.body))
    return Response.json({ ok: true })
  })
  t.after(() => rm(process.env.STATE_DIR, { recursive: true, force: true }))
  const bot = (id, text) => handleUpdate({ message: { chat: { id, type: 'private' }, text } })
  await bot(5, '/start')
  await bot(5, '/topics tech') // TECH only: a WORLD lead must not reach this chat
  await bot(6, '/start')
  await bot(6, '/topics world') // matches the raw story's fallback category
  await bot(7, '/start') // no topics set: every breaking alert
  await fastBreakingCheck()
  await new Promise(resolve => setImmediate(resolve))
  const alerts = () => sent.filter(m => m.text.startsWith('🚨'))
  assert.deepEqual(alerts().map(m => m.chat_id), [6, 7])
  assert.match(alerts()[0].text, /Breaking: quake hits coastal city/)

  // Same story on the next 2-minute pass: already in the alert history.
  await fastBreakingCheck()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(alerts().length, 2)

  // A different breaking story still sits inside the 1-hour cooldown.
  feedStories[0] = [story('BBC', 'URGENT: flood hits inland town')]
  await fastBreakingCheck()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(alerts().length, 2)
})
