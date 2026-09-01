import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestSystem, validSystemSizes, expandRows } from '../src/lib/system.ts'
import type { SignProbs } from '../src/lib/payout.ts'

function mk(probs: [number, number, number][]) {
  return probs.map((p, i) => ({
    eventNumber: i + 1,
    label: `match${i + 1}`,
    model: { one: p[0], x: p[1], two: p[2] } as SignProbs,
    crowd: { one: p[0], x: p[1], two: p[2] } as SignProbs,
  }))
}

/** 13 matcher med given fördelning. */
function uniform(p: [number, number, number]) {
  return mk(Array.from({ length: 13 }, () => p))
}

test('validSystemSizes ger bara 3^hel × 2^halv', () => {
  const s = validSystemSizes(200)
  assert.ok(s.includes(1))
  assert.ok(s.includes(48)) // 3^1 × 2^4
  assert.ok(s.includes(96)) // 3^1 × 2^5
  assert.ok(s.includes(108)) // 3^3 × 2^2
  // 50 går inte att bilda
  assert.ok(!s.includes(50))
  assert.ok(!s.includes(100))
  // Sorterad och unik
  assert.deepEqual(s, [...new Set(s)].sort((a, b) => a - b))
})

test('systemet håller sig inom radbudgeten', () => {
  const m = uniform([0.45, 0.28, 0.27])
  for (const target of [1, 6, 48, 96, 432]) {
    const sys = suggestSystem(m, target, 100)
    assert.ok(sys.rows <= target, `${sys.rows} > ${target}`)
    assert.equal(sys.costOre, sys.rows * 100)
  }
})

test('1 rad ger 13 spikar på favoriterna', () => {
  const m = mk(Array.from({ length: 13 }, () => [0.6, 0.25, 0.15] as [number, number, number]))
  const sys = suggestSystem(m, 1, 100)
  assert.equal(sys.rows, 1)
  assert.ok(sys.picks.every((p) => p.signs.length === 1))
  assert.ok(sys.picks.every((p) => p.signs[0] === '1'))
})

test('fler rader ger aldrig lägre träffsannolikhet', () => {
  const m = uniform([0.42, 0.3, 0.28])
  let prev = 0
  for (const target of [1, 2, 4, 8, 16, 32, 64, 128]) {
    const sys = suggestSystem(m, target, 100)
    assert.ok(sys.prob13 >= prev - 1e-12, `${target} rader gav lägre sannolikhet`)
    prev = sys.prob13
  }
})

test('garderar de mest osäkra matcherna först', () => {
  // Tolv säkra matcher, en jämn. Med 2 rader ska den jämna garderas.
  const probs: [number, number, number][] = Array.from({ length: 13 }, (_, i) =>
    i === 5 ? [0.36, 0.33, 0.31] : [0.85, 0.1, 0.05],
  )
  const sys = suggestSystem(mk(probs), 2, 100)
  assert.equal(sys.rows, 2)
  const garderad = sys.picks.filter((p) => p.signs.length > 1)
  assert.equal(garderad.length, 1)
  assert.equal(garderad[0]!.eventNumber, 6, 'den jämna matchen ska garderas')
})

test('uttömmande sökning slår girig heuristik', () => {
  // Verifierat mot omgång 4969: girig gav 0,15 %, uttömmande 0,240 %.
  // Detta testar egenskapen som gjorde skillnaden — att systemet hellre
  // halvgarderar flera matcher än helgarderar få.
  const probs: [number, number, number][] = [
    [0.52, 0.26, 0.22], [0.52, 0.26, 0.22], [0.41, 0.28, 0.31], [0.8, 0.13, 0.07],
    [0.37, 0.29, 0.34], [0.58, 0.25, 0.17], [0.52, 0.26, 0.22], [0.62, 0.23, 0.15],
    [0.38, 0.28, 0.34], [0.45, 0.28, 0.27], [0.4, 0.28, 0.33], [0.47, 0.28, 0.25],
    [0.38, 0.28, 0.34],
  ]
  const sys = suggestSystem(mk(probs), 48, 100)
  const halva = sys.picks.filter((p) => p.signs.length === 2).length
  const hela = sys.picks.filter((p) => p.signs.length === 3).length
  assert.ok(halva > hela, `fick ${halva} halva och ${hela} hela — ska föredra halvgarderingar`)
  assert.ok(sys.prob13 > 0.002, `träffchans ${sys.prob13} för låg`)
})

test('expandRows ger rätt antal rader i rätt ordning', () => {
  const m = mk([
    [0.5, 0.3, 0.2],
    [0.5, 0.3, 0.2],
    [0.5, 0.3, 0.2],
  ])
  const sys = suggestSystem(m, 4, 100)
  const rows = expandRows(sys.picks)
  assert.equal(rows.length, sys.rows)
  // Varje rad har ett tecken per match
  assert.ok(rows.every((r) => r.length === 3))
  // Alla rader unika
  assert.equal(new Set(rows.map((r) => r.join(''))).size, rows.length)
})

test('tecken skrivs i spelordning 1X2, inte sannolikhetsordning', () => {
  // 2:an är mest sannolik, men halvgardering ska visas som "12" inte "21".
  const probs: [number, number, number][] = Array.from({ length: 13 }, (_, i) =>
    i === 0 ? [0.3, 0.2, 0.5] : [0.9, 0.06, 0.04],
  )
  const sys = suggestSystem(mk(probs), 2, 100)
  const g = sys.picks.find((p) => p.signs.length === 2)!
  assert.deepEqual(g.signs, ['1', '2'], 'ska vara spelordning')
})
