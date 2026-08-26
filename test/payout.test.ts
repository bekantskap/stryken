import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  poissonBinomial,
  expectedInverseWinners,
  signWeights,
  rowEv,
  detectExtraPot,
  TIER_SHARE,
  BASE_PAYOUT_RATIO,
  isBelowMinDividend,
  roundDividendOre,
  type SignProbs,
  type Row,
} from '../src/lib/payout.ts'

test('poissonBinomial summerar till 1 och matchar binomialfallet', () => {
  const p = [0.5, 0.5, 0.5]
  const d = poissonBinomial(p)
  assert.equal(d.length, 4)
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-12)
  // Binomial(3, 0.5) = 1/8, 3/8, 3/8, 1/8
  assert.ok(Math.abs((d[0] ?? 0) - 0.125) < 1e-12)
  assert.ok(Math.abs((d[1] ?? 0) - 0.375) < 1e-12)
  assert.ok(Math.abs((d[3] ?? 0) - 0.125) < 1e-12)
})

test('poissonBinomial hanterar 13 matcher med olika sannolikheter', () => {
  const p = [0.43, 0.47, 0.51, 0.42, 0.38, 0.44, 0.37, 0.44, 0.4, 0.49, 0.24, 0.34, 0.41]
  const d = poissonBinomial(p)
  assert.equal(d.length, 14)
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-12)
  // 13 rätt = produkten av alla
  const prod = p.reduce((a, b) => a * b, 1)
  assert.ok(Math.abs((d[13] ?? 0) - prod) < 1e-15)
})

test('expectedInverseWinners: sluten form, och skiljer sig från 1/(1+lambda)', () => {
  // lambda -> 0: ensam vinnare
  assert.ok(Math.abs(expectedInverseWinners(0) - 1) < 1e-12)
  assert.ok(Math.abs(expectedInverseWinners(1e-12) - 1) < 1e-6)

  // Detta är poängen med korrigeringen: naiv 1/(1+lambda) underskattar.
  for (const lam of [0.5, 1, 4, 10]) {
    const exact = expectedInverseWinners(lam)
    const naive = 1 / (1 + lam)
    assert.ok(exact > naive, `lambda=${lam}: exact ${exact} ska > naive ${naive}`)
  }
  // Vid lambda=4 är skillnaden materiell (~23 %).
  const rel = expectedInverseWinners(4) / (1 / 5)
  assert.ok(rel > 1.2, `fick förhållande ${rel}`)

  // Monte Carlo-kontroll mot Poisson-dragning.
  const lam = 3
  let acc = 0
  const N = 200_000
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = 0; i < N; i++) {
    // Knuth
    let k = 0
    let pp = Math.exp(-lam)
    let s = pp
    const u = rnd()
    while (u > s && k < 60) {
      k++
      pp *= lam / k
      s += pp
    }
    acc += 1 / (1 + k)
  }
  const mc = acc / N
  assert.ok(
    Math.abs(mc - expectedInverseWinners(lam)) < 0.01,
    `MC ${mc} vs sluten form ${expectedInverseWinners(lam)}`,
  )
})

test('signWeights: alpha=1 ger oförändrad fördelning', () => {
  const d: SignProbs = { one: 0.46, x: 0.24, two: 0.3 }
  const w = signWeights(d, 1)
  assert.ok(Math.abs(w.z - 1) < 1e-12)
  assert.ok(Math.abs(w.one / w.z - 0.46) < 1e-12)
})

test('signWeights: alpha>1 koncentrerar, alpha<1 plattar ut', () => {
  const d: SignProbs = { one: 0.6, x: 0.25, two: 0.15 }
  const hi = signWeights(d, 2)
  const lo = signWeights(d, 0.5)
  // Favoriten får större andel vid alpha>1
  assert.ok(hi.one / hi.z > 0.6)
  // ...och mindre vid alpha<1
  assert.ok(lo.one / lo.z < 0.6)
})

test('vinstgruppsandelarna matchar uppmätta värden', () => {
  // Uppmätt över 68 omgångar 2026-08-26.
  assert.equal(TIER_SHARE[13], 0.26)
  assert.equal(TIER_SHARE[12], 0.0975)
  assert.equal(TIER_SHARE[11], 0.0778)
  assert.equal(TIER_SHARE[10], 0.161)
  // Summan är 59,6 % — inte 65 % som PRD v0.1 antog.
  assert.ok(Math.abs(BASE_PAYOUT_RATIO - 0.5963) < 0.0001)
  assert.ok(BASE_PAYOUT_RATIO < 0.6, 'avdraget är >40 %, inte 35 %')
})

test('minimiutdelning: 10-gruppen nollas under ~15 kr per vinnare', () => {
  // Verifierat mot 98 omgångar: högsta nollade 14,40 kr, lägsta utbetalda
  // 16,24 kr. Gränsen ligger däremellan.
  const pool = 100_000_00 // 100 000 kr i öre
  assert.equal(isBelowMinDividend(pool, 1000), false) // 100 kr/vinnare
  assert.equal(isBelowMinDividend(pool, 666), false) // ~150 kr
  assert.equal(isBelowMinDividend(pool, 10_000), true) // 10 kr < 15 kr
  assert.equal(isBelowMinDividend(pool, 6667), true) // ~15,0 kr, precis under
  assert.equal(isBelowMinDividend(pool, 0), false) // inga vinnare

  // Verkliga fall ur arkivet.
  // 4949: 265 989 vinnare, pool 16,1 % av 23,8 Mkr → 14,40 kr → NOLLAD
  assert.equal(isBelowMinDividend(Math.round(23_800_000 * 100 * 0.161), 265_989), true)
  // 4951: 263 094 vinnare, pool 16,1 % av 27,0 Mkr → 16,51 kr → utbetald
  assert.equal(isBelowMinDividend(Math.round(27_000_000 * 100 * 0.161), 263_094), false)
})

test('utdelning avrundas nedåt till hela kronor', () => {
  // 16 241 öre = 162,41 kr → 162 kr = 16 200 öre
  assert.equal(roundDividendOre(16_241, 1), 16_200)
  assert.equal(roundDividendOre(100_000, 1000), 100) // exakt 1 kr
  assert.equal(roundDividendOre(199_999, 1000), 100) // 199,99 öre → 1 kr
  assert.equal(roundDividendOre(1000, 0), 0)
})

test('rowEv: alla fyra vinstgrupper beräknas, inte bara 13', () => {
  const model: SignProbs[] = Array.from({ length: 13 }, () => ({
    one: 0.45,
    x: 0.27,
    two: 0.28,
  }))
  const crowd: SignProbs[] = Array.from({ length: 13 }, () => ({
    one: 0.5,
    x: 0.25,
    two: 0.25,
  }))
  const row: Row = Array.from({ length: 13 }, () => '1' as const)

  const ev = rowEv(row, {
    model,
    crowd,
    netSaleOre: 23_418_830 * 100,
    rowPriceOre: 100,
    alpha: 1,
  })

  // Alla fyra grupper ska ha en sannolikhet — det gamla formeln saknade helt.
  for (const t of [13, 12, 11, 10] as const) {
    assert.ok(ev.perTier[t].pExact > 0, `tier ${t} saknar sannolikhet`)
    assert.ok(ev.perTier[t].poolOre > 0, `tier ${t} saknar pool`)
  }
  // Sannolikheten ska öka monotont nedåt i grupperna.
  assert.ok(ev.perTier[10].pExact > ev.perTier[11].pExact)
  assert.ok(ev.perTier[11].pExact > ev.perTier[12].pExact)
  assert.ok(ev.perTier[12].pExact > ev.perTier[13].pExact)
  assert.ok(ev.evOre > 0)
  assert.ok(Number.isFinite(ev.evRatio))
})

test('rowEv: minimiutdelning nollar grupper med extremt många vinnare', () => {
  // Enhetlig streckfördelning över alla 13 matcher är artificiellt: den ger
  // hundratusentals medvinnare på 10-11 rätt, vilket utlöser minimiutdelning.
  // Detta verifierar att regeln faktiskt biter i EV-beräkningen.
  const model: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 0.45, x: 0.27, two: 0.28 }))
  const crowd: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 0.5, x: 0.25, two: 0.25 }))
  const row: Row = Array.from({ length: 13 }, () => '1' as const)

  const ev = rowEv(row, {
    model,
    crowd,
    netSaleOre: 23_418_830 * 100,
    rowPriceOre: 100,
    alpha: 1,
  })

  assert.equal(ev.perTier[10].belowMin, true, '10-gruppen ska nollas här')
  assert.equal(ev.perTier[10].contribOre, 0, 'nollad grupp ska inte bidra till EV')
  assert.equal(ev.perTier[13].belowMin, false, '13-gruppen ska betalas ut')
  // EV kommer då enbart från de grupper som faktiskt betalar.
  assert.ok(ev.perTier[13].contribOre > 0)
})

test('rowEv: realistisk omgång ger bidrag från lägre grupper', () => {
  // Verklig streckspridning varierar per match — då blir medvinnarantalet
  // rimligt och de lägre grupperna bidrar.
  const dists: SignProbs[] = [
    { one: 0.46, x: 0.24, two: 0.3 },
    { one: 0.52, x: 0.24, two: 0.24 },
    { one: 0.46, x: 0.25, two: 0.29 },
    { one: 0.33, x: 0.23, two: 0.44 },
    { one: 0.18, x: 0.21, two: 0.61 },
    { one: 0.7, x: 0.19, two: 0.11 },
    { one: 0.39, x: 0.27, two: 0.34 },
    { one: 0.15, x: 0.24, two: 0.61 },
    { one: 0.57, x: 0.22, two: 0.21 },
    { one: 0.2, x: 0.21, two: 0.59 },
    { one: 0.86, x: 0.09, two: 0.05 },
    { one: 0.4, x: 0.27, two: 0.33 },
    { one: 0.49, x: 0.27, two: 0.24 },
  ]
  // Spela en skrällrad: kryss överallt där folket är starkt övertygat.
  const row = dists.map((d) => (d.one > 0.5 ? 'X' : '1')) as unknown as Row
  const ev = rowEv(row, {
    model: dists,
    crowd: dists,
    netSaleOre: 23_418_830 * 100,
    rowPriceOre: 100,
    alpha: 1,
  })
  // En rad som avviker från folket ska ha få medvinnare på 13 rätt.
  assert.ok(ev.perTier[13].lambdaOthers < 100, `fick ${ev.perTier[13].lambdaOthers}`)
  assert.ok(ev.evOre > 0)
})

test('rowEv: alpha påverkar antalet medvinnare', () => {
  const model: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 0.4, x: 0.3, two: 0.3 }))
  const crowd: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 0.6, x: 0.2, two: 0.2 }))
  // Rad på folkets favorit: högre alpha ⇒ fler medvinnare ⇒ lägre EV.
  const row: Row = Array.from({ length: 13 }, () => '1' as const)
  const base = { model, crowd, netSaleOre: 20_000_000 * 100, rowPriceOre: 100 }

  const a1 = rowEv(row, { ...base, alpha: 1 })
  const a15 = rowEv(row, { ...base, alpha: 1.5 })
  assert.ok(
    a15.perTier[13].lambdaOthers > a1.perTier[13].lambdaOthers,
    'alpha>1 ska ge fler medvinnare på konsensusraden',
  )
})

test('detectExtraPot: känner igen tillskjuten pott', () => {
  const netSaleOre = 12_167_286 * 100 // omgång 4957
  // 13-andelen var 0,505 i stället för 0,26 — extra pott.
  const observed = [
    { tier: 13 as const, winners: 2, amountOre: Math.round(netSaleOre * 0.505 / 2) },
    { tier: 12 as const, winners: 100, amountOre: Math.round(netSaleOre * 0.0975 / 100) },
    { tier: 11 as const, winners: 1000, amountOre: Math.round(netSaleOre * 0.0778 / 1000) },
    { tier: 10 as const, winners: 10000, amountOre: Math.round(netSaleOre * 0.161 / 10000) },
  ]
  const d = detectExtraPot(netSaleOre, observed)
  assert.equal(d.hasExtra, true)
  assert.ok((d.extraByTier[13] ?? 0) > 0, '13-gruppen ska flaggas')
  assert.equal(d.extraByTier[12], undefined, '12-gruppen ska inte flaggas')
  assert.ok(d.totalRatio > 0.8)
})

test('detectExtraPot: normal omgång flaggas inte', () => {
  const netSaleOre = 23_418_830 * 100 // omgång 4967, ingen extra pott
  const observed = [
    { tier: 13 as const, winners: 4, amountOre: 152_222_300 },
    { tier: 12 as const, winners: 71, amountOre: 3_215_900 },
    { tier: 11 as const, winners: 1219, amountOre: 149_800 },
    { tier: 10 as const, winners: 13364, amountOre: 28_400 },
  ]
  const d = detectExtraPot(netSaleOre, observed)
  assert.equal(d.hasExtra, false, `extraByTier=${JSON.stringify(d.extraByTier)}`)
  // Utbetalningen ska landa nära uppmätta 0,597.
  assert.ok(
    Math.abs(d.totalRatio - 0.597) < 0.01,
    `totalRatio ${d.totalRatio} ska vara ~0,597`,
  )
})
