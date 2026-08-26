import { test } from 'node:test'
import assert from 'node:assert/strict'
import { betDistToPercent, winOddsToDecimal, TRACKED_POOL_TYPES } from '../src/lib/atg.ts'

/**
 * Skalorna är den lättaste tysta buggen i travdelen: två heltalsfält på samma
 * objekt, båda "ser rimliga ut" i fel skala. Verifierat mot verklig data
 * 2026-08-26 — betDistribution summerar till 10000 per lopp.
 */

test('betDistribution är hundradelar av procent, inte tiondelar', () => {
  assert.equal(betDistToPercent(404), 4.04)
  assert.equal(betDistToPercent(10000), 100)
  assert.equal(betDistToPercent(1170), 11.7)
})

test('ett helt lopp summerar till ~100 %', () => {
  // Verkliga råvärden ur V5_2026-08-26_5_2, lopp 1 (11 startande).
  // Detta är testet som fångar skalförväxlingen: i fel skala blir summan
  // 1000 % eller 10 %, aldrig 100 %.
  const bps = [95, 137, 600, 350, 108, 1158, 6806, 132, 206, 298, 109]
  const total = betDistToPercent(bps.reduce((a, b) => a + b, 0))
  // 9999/100 = 99.99 — avrundning i ATG:s eget data, inte i vår kod.
  assert.ok(Math.abs(total - 100) < 0.5, `fick ${total} %`)
})

test('vinnarodds är hundradelar', () => {
  assert.equal(winOddsToDecimal(989), 9.89)
  assert.equal(winOddsToDecimal(9999), 99.99)
  assert.equal(winOddsToDecimal(100), 1)
})

test('pooltyper är inte hårdkodade till V75', () => {
  // Kalendern roterar — V75 fanns inte alls 2026-08-26.
  assert.ok(TRACKED_POOL_TYPES.includes('V75'))
  assert.ok(TRACKED_POOL_TYPES.includes('V85'))
  assert.ok(TRACKED_POOL_TYPES.includes('V86'))
  assert.ok(TRACKED_POOL_TYPES.length > 3)
})
