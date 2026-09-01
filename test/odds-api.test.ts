import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchGame, sharpProbabilities, LEAGUE_KEYS, type SharpOdds } from '../src/lib/odds-api.ts'

const mk = (h: string, a: string, iso: string): SharpOdds => ({
  home: h, away: a, commenceAt: new Date(iso),
  one: 2.5, x: 3.4, two: 2.9, book: 'test', overround: 1.05,
})

test('matchGame kräver att avspark ligger nära', () => {
  // Detta är buggen som gav 18,7 pp falsk avvikelse: samma lag möts i
  // flera omgångar, och utan tidskrav matchas fel möte.
  const pool = [
    mk('Millwall', 'Wrexham AFC', '2026-09-02T14:00:00Z'),
    mk('Millwall', 'Bolton Wanderers', '2026-09-05T14:00:00Z'),
  ]
  const kick = new Date('2026-09-05T14:00:00Z')
  const m = matchGame('Millwall', 'Bolton', kick, pool)
  assert.ok(m)
  assert.equal(m.away, 'Bolton Wanderers', 'ska välja rätt omgångs möte')

  // Fel bortalag ska inte matcha alls.
  assert.equal(matchGame('Millwall', 'Charlton', kick, pool), null)
})

test('matchGame avvisar match utanför tidsfönstret', () => {
  const pool = [mk('Burnley', 'Middlesbrough', '2026-09-02T19:00:00Z')]
  const kick = new Date('2026-09-05T14:00:00Z') // 67 h senare
  assert.equal(matchGame('Burnley', 'Middlesbrough', kick, pool), null)
})

test('matchGame hanterar Svenska Spels trunkerade namn', () => {
  const kick = new Date('2026-09-05T14:00:00Z')
  const pool = [
    mk('Sheffield United', 'Norwich City', '2026-09-05T14:00:00Z'),
    mk('Queens Park Rangers', 'Middlesbrough', '2026-09-05T14:00:00Z'),
  ]
  assert.ok(matchGame('Sheff U', 'Norwich', kick, pool), 'Sheff U → Sheffield United')
  assert.ok(matchGame('Queens Park Rangers', 'Middlesbr', kick, pool), 'Middlesbr → Middlesbrough')
})

test('matchGame vägrar gissa utan avsparkstid vid flera kandidater', () => {
  const pool = [
    mk('Millwall', 'Bolton Wanderers', '2026-09-02T14:00:00Z'),
    mk('Millwall', 'Bolton Wanderers', '2026-09-05T14:00:00Z'),
  ]
  assert.equal(matchGame('Millwall', 'Bolton', null, pool), null, 'hellre ingen match än fel')
})

test('sharpProbabilities normaliserar bort marginalen', () => {
  const s = mk('A', 'B', '2026-09-05T14:00:00Z')
  const p = sharpProbabilities(s)
  assert.ok(Math.abs(p.one + p.x + p.two - 1) < 1e-12)
  assert.ok(p.one > p.two, 'lägre odds = högre sannolikhet')
})

test('ligakartan täcker Stryktipsets vanligaste ligor', () => {
  // 657 av ~750 matcher i vår historik ligger i dessa.
  for (const l of ['Premier League', 'Championship', 'League One', 'League Two', 'Allsvenskan']) {
    assert.ok(LEAGUE_KEYS[l], `${l} saknas`)
  }
})
