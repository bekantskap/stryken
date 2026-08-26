import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countCorrect,
  actualReturnOre,
  crowdFavouriteRow,
  modelFavouriteRow,
  makeRng,
  sampleRow,
  shrinkModelTowardCrowd,
  type DrawData,
} from '../src/lib/backtest.ts'
import type { Row, SignProbs, Tier } from '../src/lib/payout.ts'

/** Omgång 4967: verkliga siffror ur arkivet. */
function draw4967(): DrawData {
  const outcome: ('1' | 'X' | '2')[] = ['1', '1', '1', '2', '1', 'X', '2', 'X', '1', 'X', '2', 'X', 'X']
  const flat: SignProbs = { one: 0.4, x: 0.3, two: 0.3 }
  return {
    drawNumber: 4967,
    product: 'stryktipset',
    closeAt: new Date('2026-08-22T15:59:00+02:00'),
    netSaleOre: 23_418_830 * 100,
    rowPriceOre: 100,
    totalRows: 23_418_830,
    model: Array.from({ length: 13 }, () => flat),
    crowd: Array.from({ length: 13 }, () => flat),
    outcome,
    observed: new Map<Tier, { winners: number; amountOre: number }>([
      [13, { winners: 4, amountOre: 152_222_300 }],
      [12, { winners: 71, amountOre: 3_215_900 }],
      [11, { winners: 1219, amountOre: 149_800 }],
      [10, { winners: 13364, amountOre: 28_400 }],
    ]),
  }
}

test('countCorrect räknar rätt', () => {
  const d = draw4967()
  assert.equal(countCorrect(d.outcome as Row, d.outcome), 13)
  const oneWrong = [...d.outcome] as ('1' | 'X' | '2')[]
  oneWrong[0] = oneWrong[0] === '1' ? '2' : '1'
  assert.equal(countCorrect(oneWrong as Row, d.outcome), 12)
})

test('actualReturnOre: vinnande rad ger utdelning nära den faktiska', () => {
  const d = draw4967()
  // Perfekt rad. Faktisk utdelning var 1 522 223 kr till 4 vinnare.
  // Vi lägger till oss själva → 5 vinnare → poolen delas på 5.
  const ret = actualReturnOre(d.outcome as Row, d)
  const observedPool = 4 * 152_222_300
  const expected = Math.floor(observedPool / 5 / 100) * 100
  assert.equal(ret, expected)
  // Rimlighetskoll: ~1,22 Mkr
  assert.ok(ret / 100 > 1_200_000 && ret / 100 < 1_250_000, `fick ${ret / 100} kr`)
})

test('actualReturnOre: rad under 10 rätt ger noll', () => {
  const d = draw4967()
  const bad = d.outcome.map((o) => (o === '1' ? '2' : '1')) as Row
  assert.equal(actualReturnOre(bad, d), 0)
})

test('actualReturnOre: nollad vinstgrupp ger noll', () => {
  const d = draw4967()
  // Simulera minimiutdelningsregeln: 10-gruppen nollad.
  d.observed.set(10, { winners: 300_000, amountOre: 0 })
  // Bygg en rad med exakt 10 rätt.
  const row = [...d.outcome] as ('1' | 'X' | '2')[]
  for (let i = 0; i < 3; i++) row[i] = row[i] === '1' ? '2' : '1'
  assert.equal(countCorrect(row as Row, d.outcome), 10)
  assert.equal(actualReturnOre(row as Row, d), 0, 'nollad grupp ska ge noll')
})

test('actualReturnOre: excludeTier13 nollar toppvinsten', () => {
  const d = draw4967()
  assert.ok(actualReturnOre(d.outcome as Row, d) > 0)
  assert.equal(actualReturnOre(d.outcome as Row, d, { excludeTier13: true }), 0)
})

test('favoritrader väljer högsta sannolikhet', () => {
  const d = draw4967()
  d.crowd = Array.from({ length: 13 }, () => ({ one: 0.6, x: 0.2, two: 0.2 }))
  d.model = Array.from({ length: 13 }, () => ({ one: 0.2, x: 0.2, two: 0.6 }))
  assert.deepEqual([...crowdFavouriteRow(d)], Array(13).fill('1'))
  assert.deepEqual([...modelFavouriteRow(d)], Array(13).fill('2'))
})

test('sampleRow är reproducerbar med samma seed', () => {
  const dists: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 0.4, x: 0.3, two: 0.3 }))
  const a = sampleRow(dists, makeRng(99))
  const b = sampleRow(dists, makeRng(99))
  assert.deepEqual([...a], [...b])
})

test('shrinkModelTowardCrowd drar modellen mot folket', () => {
  const d = draw4967()
  d.model = Array.from({ length: 13 }, () => ({ one: 0.7, x: 0.2, two: 0.1 }))
  d.crowd = Array.from({ length: 13 }, () => ({ one: 0.3, x: 0.3, two: 0.4 }))

  const same = shrinkModelTowardCrowd(d, 0)
  assert.equal(same.model[0]!.one, 0.7, 'δ=0 ska lämna oförändrat')

  const shrunk = shrinkModelTowardCrowd(d, 2)
  assert.ok(shrunk.model[0]!.one < 0.7, 'ska dras nedåt mot folkets 0,3')
  assert.ok(shrunk.model[0]!.one > 0.3, 'ska inte gå hela vägen')
  const sum = shrunk.model[0]!.one + shrunk.model[0]!.x + shrunk.model[0]!.two
  assert.ok(Math.abs(sum - 1) < 1e-12, 'ska förbli normaliserad')
})
