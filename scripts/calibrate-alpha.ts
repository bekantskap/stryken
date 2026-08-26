/**
 * Fas 1c: kalibrera medvinnarmodellens exponent α.
 *
 * Projektets viktigaste enskilda beräkning. Hela radrankningen vilar på att vi
 * kan förutsäga antalet medvinnare; oberoendeantagandet (α=1) är grovt fel.
 *
 * Metod: maximum likelihood över faktiska vinnarantal.
 *   λ_{d,k}(α) = N_d · P(en slumpmässig folkrad får exakt k rätt | α)
 *   ℓ(α)       = Σ_d Σ_k log Poisson(observerade vinnare; λ_{d,k}(α))
 *
 * Omgångar med extra tillskjuten pott utesluts INTE här — potten påverkar
 * utdelningens storlek, inte antalet vinnare, så de bidrar med giltiga
 * observationer av vinnarantal.
 *
 *   npm run calibrate
 *   npm run calibrate -- --product europatipset
 *   npm run calibrate -- --tier 13        # bara en vinstgrupp
 */

import { getDb } from '../src/db/client.ts'
import {
  draw,
  event,
  snapshot,
  eventSnapshot,
  result,
  payoutTier,
} from '../src/db/schema.ts'
import { eq, and, sql as raw } from 'drizzle-orm'
import { poissonBinomial, signWeights, TIERS, type Tier, type SignProbs } from '../src/lib/payout.ts'

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f: string) => {
    const i = a.indexOf(f)
    return i >= 0 ? a[i + 1] : undefined
  }
  return {
    product: get('--product') ?? 'stryktipset',
    tier: get('--tier') ? (Number(get('--tier')) as Tier) : undefined,
    verbose: a.includes('--verbose'),
  }
}

type DrawObs = {
  drawNumber: number
  /** Antal sålda rader. */
  totalRows: number
  /** Folkets streckfördelning per match, normaliserad. */
  crowd: SignProbs[]
  /** Facit per match. */
  outcome: ('1' | 'X' | '2')[]
  /** Observerade vinnare per vinstgrupp. */
  winners: Partial<Record<Tier, number>>
}

/**
 * log P(X = k) för X ~ Poisson(λ), numeriskt stabilt via log-gamma.
 */
function logPoissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity
  return k * Math.log(lambda) - lambda - logGamma(k + 1)
}

/** Lanczos-approximation av log Γ(z). */
function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  z -= 1
  let x = 0.99999999999980993
  for (let i = 0; i < g.length; i++) x += (g[i] ?? 0) / (z + i + 1)
  const t = z + g.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

/**
 * Sannolikheten att en slumpmässig folkrad får exakt k rätt, under exponent α.
 * Detta är DP:n från PRD §6.3 — folkets sida, inte modellens.
 */
function crowdHitDistribution(crowd: SignProbs[], outcome: ('1' | 'X' | '2')[], alpha: number): number[] {
  const match: number[] = []
  for (let i = 0; i < crowd.length; i++) {
    const c = crowd[i]
    const o = outcome[i]
    if (!c || !o) continue
    const w = signWeights(c, alpha)
    const hit = o === '1' ? w.one : o === 'X' ? w.x : w.two
    match.push(hit / w.z)
  }
  return poissonBinomial(match)
}

function logLikelihood(obs: DrawObs[], alpha: number, onlyTier?: Tier): number {
  let ll = 0
  for (const d of obs) {
    const dist = crowdHitDistribution(d.crowd, d.outcome, alpha)
    for (const tier of TIERS) {
      if (onlyTier && tier !== onlyTier) continue
      const w = d.winners[tier]
      if (w === undefined) continue
      const lambda = d.totalRows * (dist[tier] ?? 0)
      if (lambda <= 0) {
        if (w > 0) return -Infinity
        continue
      }
      ll += logPoissonPmf(w, lambda)
    }
  }
  return ll
}

async function loadObservations(product: string): Promise<DrawObs[]> {
  const db = getDb()

  // Arkivsnapshot per omgång + facit + utdelning. Bara omgångar med allt.
  const draws = await db
    .select({
      id: draw.id,
      drawNumber: draw.drawNumber,
      netSaleOre: draw.netSaleOre,
      rowPriceOre: draw.rowPriceOre,
      snapshotId: snapshot.id,
    })
    .from(draw)
    .innerJoin(snapshot, and(eq(snapshot.drawId, draw.id), eq(snapshot.source, 'archive')))
    .where(eq(draw.product, product))
    .orderBy(draw.drawNumber)

  const out: DrawObs[] = []

  for (const d of draws) {
    if (d.netSaleOre === null || !d.rowPriceOre) continue
    const totalRows = Number(d.netSaleOre) / d.rowPriceOre
    if (!Number.isFinite(totalRows) || totalRows <= 0) continue

    const rows = await db
      .select({
        eventNumber: event.eventNumber,
        dist1: eventSnapshot.dist1,
        distX: eventSnapshot.distX,
        dist2: eventSnapshot.dist2,
        outcome: result.outcome,
      })
      .from(eventSnapshot)
      .innerJoin(event, eq(event.id, eventSnapshot.eventId))
      .leftJoin(result, and(eq(result.drawId, d.id), eq(result.eventId, event.id)))
      .where(eq(eventSnapshot.snapshotId, d.snapshotId))
      .orderBy(event.eventNumber)

    if (rows.length !== 13) continue
    if (rows.some((r) => !r.outcome)) continue // ofullständigt facit

    const crowd: SignProbs[] = []
    const outcome: ('1' | 'X' | '2')[] = []
    let bad = false
    for (const r of rows) {
      const one = Number(r.dist1)
      const x = Number(r.distX)
      const two = Number(r.dist2)
      if (![one, x, two].every((v) => Number.isFinite(v) && v > 0)) {
        bad = true
        break
      }
      crowd.push({ one, x, two })
      outcome.push(r.outcome as '1' | 'X' | '2')
    }
    if (bad) continue

    const tiers = await db
      .select({ tier: payoutTier.tier, winners: payoutTier.winners })
      .from(payoutTier)
      .where(eq(payoutTier.drawId, d.id))

    if (tiers.length === 0) continue
    const winners: Partial<Record<Tier, number>> = {}
    for (const t of tiers) {
      if ((TIERS as readonly number[]).includes(t.tier)) {
        winners[t.tier as Tier] = t.winners
      }
    }

    out.push({ drawNumber: d.drawNumber, totalRows, crowd, outcome, winners })
  }

  return out
}

/** Gyllene snitt-sökning efter maximum. */
function maximise(f: (x: number) => number, lo: number, hi: number, iters = 60): number {
  const phi = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let c = b - phi * (b - a)
  let d = a + phi * (b - a)
  for (let i = 0; i < iters; i++) {
    if (f(c) > f(d)) {
      b = d
      d = c
      c = b - phi * (b - a)
    } else {
      a = c
      c = d
      d = a + phi * (b - a)
    }
  }
  return (a + b) / 2
}

async function main() {
  const opts = parseArgs()
  console.log(`Laddar observationer för ${opts.product}...`)
  const obs = await loadObservations(opts.product)

  const totalObs = obs.reduce((n, d) => n + Object.keys(d.winners).length, 0)
  console.log(`  ${obs.length} omgångar, ${totalObs} vinnarobservationer\n`)

  if (obs.length < 10) {
    console.log('För få omgångar för meningsfull kalibrering. Kör import-archive först.')
    return
  }

  // --- grid för överblick ---
  console.log('Log-likelihood över α:')
  const grid: { alpha: number; ll: number }[] = []
  for (let a = 0.5; a <= 2.001; a += 0.05) {
    const ll = logLikelihood(obs, a, opts.tier)
    grid.push({ alpha: a, ll })
  }
  const best = grid.reduce((m, g) => (g.ll > m.ll ? g : m), grid[0]!)
  const maxLl = best.ll
  for (const g of grid) {
    if (g.alpha % 0.1 > 0.049 && g.alpha % 0.1 < 0.051) continue // var 0,1
    const rel = g.ll - maxLl
    const bar = rel > -1e-9 ? '████ BÄST' : '█'.repeat(Math.max(0, Math.round(40 + rel / 200)))
    console.log(`  α=${g.alpha.toFixed(2)}  ll=${g.ll.toFixed(0).padStart(12)}  ${bar}`)
  }

  // --- finjustering ---
  const alphaHat = maximise((a) => logLikelihood(obs, a, opts.tier), 0.5, 2.0)
  console.log(`\nα̂ = ${alphaHat.toFixed(4)}  (ll = ${logLikelihood(obs, alphaHat, opts.tier).toFixed(0)})`)
  console.log(`   jämför α=1 (oberoende): ll = ${logLikelihood(obs, 1, opts.tier).toFixed(0)}`)

  // --- per vinstgrupp: räcker en skalär? ---
  console.log('\nα per vinstgrupp (om dessa spretar räcker inte en skalär):')
  for (const tier of TIERS) {
    const withTier = obs.filter((d) => d.winners[tier] !== undefined)
    if (withTier.length < 10) {
      console.log(`  ${tier}: för få observationer (${withTier.length})`)
      continue
    }
    const a = maximise((x) => logLikelihood(withTier, x, tier), 0.5, 2.0)
    console.log(`  ${tier} rätt: α̂ = ${a.toFixed(4)}  (${withTier.length} omgångar)`)
  }

  // --- residualanalys: förutsagt vs faktiskt ---
  console.log(`\nResidualer vid α̂=${alphaHat.toFixed(3)} (log10 faktisk/förutsagd):`)
  const resid: Record<number, number[]> = { 13: [], 12: [], 11: [], 10: [] }
  for (const d of obs) {
    const dist = crowdHitDistribution(d.crowd, d.outcome, alphaHat)
    for (const tier of TIERS) {
      const w = d.winners[tier]
      if (w === undefined || w <= 0) continue
      const lambda = d.totalRows * (dist[tier] ?? 0)
      if (lambda <= 0) continue
      resid[tier]?.push(Math.log10(w / lambda))
    }
  }
  for (const tier of TIERS) {
    const r = resid[tier] ?? []
    if (r.length === 0) continue
    r.sort((a, b) => a - b)
    const med = r[Math.floor(r.length / 2)] ?? 0
    const mean = r.reduce((a, b) => a + b, 0) / r.length
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length)
    const within = r.filter((v) => Math.abs(v) < 0.301).length // inom faktor 2
    console.log(
      `  ${tier} rätt: median ${med >= 0 ? '+' : ''}${med.toFixed(3)}  sd ${sd.toFixed(3)}  ` +
        `inom faktor 2: ${((within / r.length) * 100).toFixed(0)} %  (n=${r.length})`,
    )
  }

  console.log(
    '\nTolkning: median nära 0 = modellen träffar rätt storleksordning.\n' +
      'Stor spridning mellan vinstgruppernas α = en skalär räcker inte.',
  )
}

main().catch((err) => {
  console.error('calibrate-alpha kraschade:', err)
  process.exit(1)
})
