import test from 'node:test'
import assert from 'node:assert/strict'
import { BREAKING_FLASH, BREAKING_MARKER, markedHeadline } from './breaking.ts'

test('breaking marker prefixes only breaking headlines', () => {
  assert.equal(markedHeadline({ headline: 'Quake hits coastal city' }), 'Quake hits coastal city')
  assert.equal(markedHeadline({ headline: 'Quake hits coastal city', breaking: false }), 'Quake hits coastal city')
  assert.equal(markedHeadline({ headline: 'Quake hits coastal city', breaking: true }), `${BREAKING_MARKER}Quake hits coastal city`)
  assert.match(markedHeadline({ headline: 'Quake hits coastal city', breaking: true }), /^🚨 BREAKING/)
  assert.equal(BREAKING_FLASH, '🚨 BREAKING NEWS')
})
