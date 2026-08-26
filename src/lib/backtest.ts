import type { Db } from '../db/client.ts'
import { draw, event, snapshot, eventSnapshot, result, payoutTier } from '../db/schema.ts'
import { eq, and, inArray } from 'drizzle-orm'
import {
  poissonBinomial,
  signWeights,
  oddsShrinkToward,
  TIERS,
  TIER_SHARE,
  isBelowMinDividend,
  expectedInverseWinners,
  type Tier,
  type SignProbs,
  type Row,
} from './payout.ts'

/**
 * Backtestmotorn. Se PRD §7 fas 2 och planen.
 *
 * Bärande princip: allt som kan lura oss ska vara mätbart.
 *  - Tidsdelning, aldrig slumpmässig (ligastyrka och spelarbeteende driftar).
 *  - Strecklinjen som sanity-test: att följa folket MÅSTE ge ~-40 %.
 *  - δ-känslighetskurva i stället för gissad rabatt för tidsskevheten.
 *  - ROI redovisad både med och utan 13-gruppen.
 */

export type DrawData = {
  drawNumber: number
  product: string
  closeAt: Date
  netSaleOre: number
  rowPriceOre: number
  totalRows: number
  /** Marginalrensade marknadssannolikheter per match (från startOdds). */
  model: SignProbs[]
  /** Folkets streckfördelning per match. */
  crowd: SignProbs[]
  outcome: ('1' | 'X' | '2')[]
  /** Faktiska vinnare och utdelning per vinstgrupp. */
  observed: Map<Tier, { winners: number; amountOre: number }>
}

/**
 * Läser allt backtesten behöver. Bara omgångar med komplett data:
 * 13 matcher, odds, streck, fullt facit och utdelningstabell.
 */
export async function loadBacktestData(db: Db, product: string): Promise<DrawData[]> {
  // Tre batchade frågor i stället för en per omgång. Över nätverket till Neon
  // är rundresorna helt dominerande — 246 omgångar × 2 frågor tog minuter.
  const draws = await db
    .select({
      id: draw.id,
      drawNumber: draw.drawNumber,
      product: draw.product,
      closeAt: draw.closeAt,
      netSaleOre: draw.netSaleOre,
      rowPriceOre: draw.rowPriceOre,
      snapshotId: snapshot.id,
    })
    .from(draw)
    .innerJoin(snapshot, and(eq(snapshot.drawId, draw.id), eq(snapshot.source, 'archive')))
    .where(eq(draw.product, product))
    .orderBy(draw.drawNumber)

  const drawIds = draws.map((d) => d.id)
  if (drawIds.length === 0) return []

  const allEvents = await db
    .select({
      drawId: event.drawId,
      eventNumber: event.eventNumber,
      dist1: eventSnapshot.dist1,
      distX: eventSnapshot.distX,
      dist2: eventSnapshot.dist2,
      so1: eventSnapshot.startOdds1,
      soX: eventSnapshot.startOddsX,
      so2: eventSnapshot.startOdds2,
      outcome: result.outcome,
    })
    .from(eventSnapshot)
    .innerJoin(event, eq(event.id, eventSnapshot.eventId))
    .innerJoin(snapshot, eq(snapshot.id, eventSnapshot.snapshotId))
    .leftJoin(result, and(eq(result.drawId, event.drawId), eq(result.eventId, event.id)))
    .where(and(eq(snapshot.source, 'archive'), inArray(event.drawId, drawIds)))
    .orderBy(event.drawId, event.eventNumber)

  const allTiers = await db
    .select({
      drawId: payoutTier.drawId,
      tier: payoutTier.tier,
      winners: payoutTier.winners,
      amountOre: payoutTier.amountOre,
    })
    .from(payoutTier)
    .where(inArray(payoutTier.drawId, drawIds))

  // Gruppera i minnet.
  const eventsByDraw = new Map<number, typeof allEvents>()
  for (const e of allEvents) {
    const list = eventsByDraw.get(e.drawId)
    if (list) list.push(e)
    else eventsByDraw.set(e.drawId, [e])
  }
  const tiersByDraw = new Map<number, typeof allTiers>()
  for (const t of allTiers) {
    const list = tiersByDraw.get(t.drawId)
    if (list) list.push(t)
    else tiersByDraw.set(t.drawId, [t])
  }

  const out: DrawData[] = []

  for (const d of draws) {
    if (d.netSaleOre === null || !d.rowPriceOre) continue
    const totalRows = Number(d.netSaleOre) / d.rowPriceOre
    if (!Number.isFinite(totalRows) || totalRows <= 0) continue

    const rows = eventsByDraw.get(d.id) ?? []
    if (rows.length !== 13) continue

    const model: SignProbs[] = []
    const crowd: SignProbs[] = []
    const outcome: ('1' | 'X' | '2')[] = []
    let ok = true

    for (const r of rows) {
      if (!r.outcome) {
        ok = false
        break
      }
      const o1 = Number(r.so1)
      const oX = Number(r.soX)
      const o2 = Number(r.so2)
      if (![o1, oX, o2].every((v) => Number.isFinite(v) && v > 1)) {
        ok = false
        break
      }
      const inv = [1 / o1, 1 / oX, 1 / o2]
      const sum = inv[0]! + inv[1]! + inv[2]!
      model.push({ one: inv[0]! / sum, x: inv[1]! / sum, two: inv[2]! / sum })

      const c1 = Number(r.dist1)
      const cX = Number(r.distX)
      const c2 = Number(r.dist2)
      if (![c1, cX, c2].every((v) => Number.isFinite(v) && v > 0)) {
        ok = false
        break
      }
      crowd.push({ one: c1, x: cX, two: c2 })
      outcome.push(r.outcome as '1' | 'X' | '2')
    }
    if (!ok) continue

    const tiers = tiersByDraw.get(d.id) ?? []
    if (tiers.length === 0) continue

    const observed = new Map<Tier, { winners: number; amountOre: number }>()
    for (const t of tiers) {
      if ((TIERS as readonly number[]).includes(t.tier)) {
        observed.set(t.tier as Tier, { winners: t.winners, amountOre: Number(t.amountOre) })
      }
    }

    out.push({
      drawNumber: d.drawNumber,
      product: d.product,
      closeAt: d.closeAt,
      netSaleOre: Number(d.netSaleOre),
      rowPriceOre: d.rowPriceOre,
      totalRows,
      model,
      crowd,
      outcome,
      observed,
    })
  }

  return out
}

/** Antal rätt en rad fick. */
export function countCorrect(row: Row, outcome: readonly ('1' | 'X' | '2')[]): number {
  let n = 0
  for (let i = 0; i < row.length; i++) if (row[i] === outcome[i]) n++
  return n
}

/**
 * FAKTISK avkastning för en rad, med verkliga utdelningar.
 *
 * Detta är kärnan i backtesten: vi använder INTE modellens EV-skattning här,
 * utan vad raden faktiskt hade betalat. Om vår rad hade vunnit måste vi lägga
 * till oss själva bland vinnarna och räkna om utdelningen — annars övervärderar
 * vi rader som ingen annan hade.
 */
export function actualReturnOre(
  row: Row,
  d: DrawData,
  opts: { excludeTier13?: boolean } = {},
): number {
  const correct = countCorrect(row, d.outcome)
  if (correct < 10) return 0
  const tier = correct as Tier
  if (!(TIERS as readonly number[]).includes(tier)) return 0
  if (opts.excludeTier13 && tier === 13) return 0

  const obs = d.observed.get(tier)
  if (!obs) return 0

  // Poolen för gruppen: rekonstruera ur faktisk utdelning × vinnare. Det
  // fångar extrapotten automatiskt, utan att behöva modellera var den kommer
  // ifrån. Faller tillbaka på TIER_SHARE när gruppen nollats.
  const observedPool = obs.winners * obs.amountOre
  const poolOre = observedPool > 0 ? observedPool : d.netSaleOre * TIER_SHARE[tier]

  // Vi lägger till vår egen rad bland vinnarna.
  const winners = obs.winners + 1

  // Minimiutdelningsregeln: nollades gruppen faktiskt? Då fick vi inget.
  if (obs.amountOre === 0) return 0
  if (isBelowMinDividend(poolOre, winners)) return 0

  return Math.floor(poolOre / winners / 100) * 100
}

/** Radens EV enligt modellen, i öre. Används för urval, inte för utfall. */
export function modelEvOre(row: Row, d: DrawData, alpha: number): number {
  const modelHit: number[] = []
  const crowdHit: number[] = []
  for (let i = 0; i < row.length; i++) {
    const s = row[i]!
    const m = d.model[i]!
    const c = d.crowd[i]!
    modelHit.push(s === '1' ? m.one : s === 'X' ? m.x : m.two)
    const w = signWeights(c, alpha)
    crowdHit.push((s === '1' ? w.one : s === 'X' ? w.x : w.two) / w.z)
  }
  const pModel = poissonBinomial(modelHit)
  const pCrowd = poissonBinomial(crowdHit)

  let ev = 0
  for (const tier of TIERS) {
    const pExact = pModel[tier] ?? 0
    if (pExact <= 0) continue
    const lambdaOthers = Math.max(0, d.totalRows * (pCrowd[tier] ?? 0) - 1)
    const poolOre = d.netSaleOre * TIER_SHARE[tier]
    if (isBelowMinDividend(poolOre, lambdaOthers + 1)) continue
    ev += pExact * poolOre * expectedInverseWinners(lambdaOthers)
  }
  return ev
}

/** Rad som följer folkets favorittecken per match. */
export function crowdFavouriteRow(d: DrawData): Row {
  return d.crowd.map((c) =>
    c.one >= c.x && c.one >= c.two ? '1' : c.x >= c.two ? 'X' : '2',
  ) as Row
}

/** Rad som följer marknadens favorittecken per match. */
export function modelFavouriteRow(d: DrawData): Row {
  return d.model.map((m) =>
    m.one >= m.x && m.one >= m.two ? '1' : m.x >= m.two ? 'X' : '2',
  ) as Row
}

/** Deterministisk pseudoslump så backtesten är reproducerbar. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Slumpmässig rad, dragen ur en fördelning. */
export function sampleRow(dists: readonly SignProbs[], rnd: () => number): Row {
  return dists.map((d) => {
    const u = rnd()
    return u < d.one ? '1' : u < d.one + d.x ? 'X' : '2'
  }) as Row
}

/**
 * Enumererar alla 3^13 rader och returnerar de N med högst modell-EV.
 *
 * 1 594 323 rader är trivialt att gå igenom — ingen R-systemreducering behövs.
 *
 * ⚠ OPTIMIZER'S CURSE — läs detta innan du litar på utdatan.
 *
 * Att maximera modell-EV över hela radrymden maximerar i praktiken MODELLFEL,
 * inte verkligt värde. Verifierat 2026-08-26 mot omgång 4721:
 *
 *   Toppraden 22X12222122X2 fick modell-EV 8,58 kr per krona insats.
 *   Modellen förutsåg 1,11 medvinnare på 12 rätt.
 *   Faktiskt antal 12-rättare i omgången: 8 506. Fel med faktor ~7 700.
 *   Radens verkliga utfall: 4 rätt, 0 kr.
 *
 * Orsaken är INTE en bugg i α-modellen. På realistiska rader (facitraden) är
 * den välkalibrerad — kvot modell/faktiskt 0,7–1,8 över testade omgångar.
 * Men α kalibrerades mot vinnarantal på FACITRADER, och topp-EV-sökningen
 * plockar systematiskt de mest extrema raderna i rymden, där Π q_i^α
 * extrapolerar långt utanför kalibreringsområdet och underskattar
 * medvinnarantalet katastrofalt.
 *
 * Konsekvens: denna funktion duger för att RANKA rader inom ett rimligt
 * urval, men dess absoluta EV-tal är inte trovärdiga för extremrader, och
 * den ska inte användas för att välja rader ur hela rymden.
 *
 * Se scripts/backtest.ts för det empiriska utfallet (−94,6 % ROI).
 */
export function topEvRows(d: DrawData, alpha: number, n: number): { row: Row; ev: number }[] {
  const SIGNS = ['1', 'X', '2'] as const
  const nMatches = d.model.length
  const total = 3 ** nMatches

  // Förberäkna per match och tecken. Flat Float64Array: [match*3 + tecken].
  const mHit = new Float64Array(nMatches * 3)
  const cHit = new Float64Array(nMatches * 3)
  for (let i = 0; i < nMatches; i++) {
    const m = d.model[i]!
    const c = d.crowd[i]!
    const w = signWeights(c, alpha)
    mHit[i * 3] = m.one
    mHit[i * 3 + 1] = m.x
    mHit[i * 3 + 2] = m.two
    cHit[i * 3] = w.one / w.z
    cHit[i * 3 + 1] = w.x / w.z
    cHit[i * 3 + 2] = w.two / w.z
  }

  // Poolstorlek och minimiutdelning per vinstgrupp är radoberoende.
  const pools = new Float64Array(14)
  for (const tier of TIERS) pools[tier] = d.netSaleOre * TIER_SHARE[tier]

  // Återanvänd DP-buffertar i stället för att allokera per rad.
  const polyM = new Float64Array(nMatches + 1)
  const polyC = new Float64Array(nMatches + 1)

  const best: { row: Row; ev: number }[] = []
  let worstKept = -Infinity
  const idx = new Uint8Array(nMatches)

  for (let counter = 0; counter < total; counter++) {
    // Poisson-binomial-DP in-place för både modell och folk.
    polyM.fill(0)
    polyC.fill(0)
    polyM[0] = 1
    polyC[0] = 1
    for (let i = 0; i < nMatches; i++) {
      const pm = mHit[i * 3 + idx[i]!]!
      const pc = cHit[i * 3 + idx[i]!]!
      for (let k = i + 1; k > 0; k--) {
        polyM[k] = polyM[k]! * (1 - pm) + polyM[k - 1]! * pm
        polyC[k] = polyC[k]! * (1 - pc) + polyC[k - 1]! * pc
      }
      polyM[0] = polyM[0]! * (1 - pm)
      polyC[0] = polyC[0]! * (1 - pc)
    }

    let ev = 0
    for (const tier of TIERS) {
      const pExact = polyM[tier]!
      if (pExact <= 0) continue
      const lambdaOthers = d.totalRows * polyC[tier]! - 1
      const lam = lambdaOthers > 0 ? lambdaOthers : 0
      const poolOre = pools[tier]!
      if (isBelowMinDividend(poolOre, lam + 1)) continue
      ev += pExact * poolOre * expectedInverseWinners(lam)
    }

    if (best.length < n || ev > worstKept) {
      const row: ('1' | 'X' | '2')[] = new Array(nMatches)
      for (let i = 0; i < nMatches; i++) row[i] = SIGNS[idx[i]!]!
      best.push({ row: row as Row, ev })
      best.sort((a, b) => b.ev - a.ev)
      if (best.length > n) best.pop()
      worstKept = best[best.length - 1]?.ev ?? -Infinity
    }

    // Inkrementera bas-3-räknaren.
    for (let i = nMatches - 1; i >= 0; i--) {
      const v = idx[i]! + 1
      if (v < 3) {
        idx[i] = v
        break
      }
      idx[i] = 0
    }
  }

  return best
}

/**
 * Rader med högst modell-EV, men BEGRÄNSAT till rader vars modellsannolikhet
 * ligger inom ett rimligt intervall.
 *
 * Detta är motgiftet mot optimizer's curse i topEvRows(): i stället för att
 * söka fritt i hela rymden — där α-modellen extrapolerar och underskattar
 * medvinnare med faktor tusentals — kräver vi att raden har minst
 * `minProb13Ratio` gånger så hög 13-sannolikhet som en genomsnittlig rad.
 *
 * Med ratio 1,0 spelar vi bara rader som är minst lika sannolika som
 * genomsnittet, vilket utesluter de extrema skrällrader modellen övervärderar.
 */
export function topEvRowsConstrained(
  d: DrawData,
  alpha: number,
  n: number,
  minProb13Ratio = 1,
): { row: Row; ev: number; p13: number }[] {
  const SIGNS = ['1', 'X', '2'] as const
  const nMatches = d.model.length
  const total = 3 ** nMatches
  const uniformP13 = 1 / total

  const mHit = new Float64Array(nMatches * 3)
  const cHit = new Float64Array(nMatches * 3)
  for (let i = 0; i < nMatches; i++) {
    const m = d.model[i]!
    const c = d.crowd[i]!
    const w = signWeights(c, alpha)
    mHit[i * 3] = m.one
    mHit[i * 3 + 1] = m.x
    mHit[i * 3 + 2] = m.two
    cHit[i * 3] = w.one / w.z
    cHit[i * 3 + 1] = w.x / w.z
    cHit[i * 3 + 2] = w.two / w.z
  }

  const pools = new Float64Array(14)
  for (const tier of TIERS) pools[tier] = d.netSaleOre * TIER_SHARE[tier]

  const polyM = new Float64Array(nMatches + 1)
  const polyC = new Float64Array(nMatches + 1)
  const best: { row: Row; ev: number; p13: number }[] = []
  let worstKept = -Infinity
  const idx = new Uint8Array(nMatches)

  for (let counter = 0; counter < total; counter++) {
    // Radens 13-sannolikhet är produkten — billig förhandsfiltrering.
    let p13 = 1
    for (let i = 0; i < nMatches; i++) p13 *= mHit[i * 3 + idx[i]!]!

    if (p13 >= uniformP13 * minProb13Ratio) {
      polyM.fill(0)
      polyC.fill(0)
      polyM[0] = 1
      polyC[0] = 1
      for (let i = 0; i < nMatches; i++) {
        const pm = mHit[i * 3 + idx[i]!]!
        const pc = cHit[i * 3 + idx[i]!]!
        for (let k = i + 1; k > 0; k--) {
          polyM[k] = polyM[k]! * (1 - pm) + polyM[k - 1]! * pm
          polyC[k] = polyC[k]! * (1 - pc) + polyC[k - 1]! * pc
        }
        polyM[0] = polyM[0]! * (1 - pm)
        polyC[0] = polyC[0]! * (1 - pc)
      }

      let ev = 0
      for (const tier of TIERS) {
        const pExact = polyM[tier]!
        if (pExact <= 0) continue
        const lam = Math.max(0, d.totalRows * polyC[tier]! - 1)
        const poolOre = pools[tier]!
        if (isBelowMinDividend(poolOre, lam + 1)) continue
        ev += pExact * poolOre * expectedInverseWinners(lam)
      }

      if (best.length < n || ev > worstKept) {
        const row: ('1' | 'X' | '2')[] = new Array(nMatches)
        for (let i = 0; i < nMatches; i++) row[i] = SIGNS[idx[i]!]!
        best.push({ row: row as Row, ev, p13 })
        best.sort((a, b) => b.ev - a.ev)
        if (best.length > n) best.pop()
        worstKept = best[best.length - 1]?.ev ?? -Infinity
      }
    }

    for (let i = nMatches - 1; i >= 0; i--) {
      const v = idx[i]! + 1
      if (v < 3) {
        idx[i] = v
        break
      }
      idx[i] = 0
    }
  }

  return best
}

/**
 * Justerar modellsannolikheter mot folket med δ procentenheter.
 *
 * Hanterar tidsskevheten: arkivet parar ÖPPNINGSodds med SLUTGILTIG streck.
 * Marknaden rör sig mot den mognare informationen under veckan, så vår
 * p_marknad är systematiskt "för tidig" — vilket flatterar oss. I stället för
 * en gissad rabatt mäter vi ROI som funktion av δ.
 */
export function shrinkModelTowardCrowd(d: DrawData, deltaPp: number): DrawData {
  if (deltaPp <= 0) return d
  return {
    ...d,
    model: d.model.map((m, i) => oddsShrinkToward(m, d.crowd[i]!, deltaPp / 100)),
  }
}
