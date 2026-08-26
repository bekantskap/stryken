/**
 * Fas 2: backtest → BESLUTSGRIND.
 *
 * Svarar på projektets kärnfråga: överlever edgen 40,3 % avdrag?
 *
 * Allt här är byggt för att kunna svara NEJ billigt:
 *  - Tidsdelning, aldrig slumpmässig. Testmängden rörs en gång.
 *  - Sanity-test först: slumpspelning MÅSTE gå minus. Visar den plus finns
 *    en bugg i utdelningsberäkningen och allt nedanför är meningslöst.
 *  - δ-känslighetskurva för tidsskevheten i stället för gissad rabatt.
 *  - ROI både med och utan 13-gruppen (en lyckoträff får inte se ut som edge).
 *  - Bootstrappade konfidensintervall — punktskattningar på klumpiga utfall
 *    är nästan meningslösa.
 *
 *   npm run backtest
 *   npm run backtest -- --product europatipset
 *   npm run backtest -- --test          # rör testmängden (gör detta EN gång)
 */

import { getDb } from '../src/db/client.ts'
import {
  loadBacktestData,
  actualReturnOre,
  countCorrect,
  crowdFavouriteRow,
  modelFavouriteRow,
  modelEvOre,
  topEvRows,
  shrinkModelTowardCrowd,
  makeRng,
  sampleRow,
  type DrawData,
} from '../src/lib/backtest.ts'
import { TIERS, type Row, type SignProbs } from '../src/lib/payout.ts'

/** Kalibrerat i fas 1c. Stryktipset 1,068 / Europatipset 1,045. */
const ALPHA: Record<string, number> = { stryktipset: 1.068, europatipset: 1.045 }

/**
 * Förregistrerat tröskelrutnät. Bestämt INNAN testdata rörs (PRD §7 fas 2).
 * Äkta edge är slät över grannvärden; falsk spikar på exakt ett.
 */
const EV_THRESHOLDS = [1.0, 1.1, 1.2, 1.3, 1.5] as const

/** δ i procentenheter för tidsskevheten. Uppmätt drift ~1,1 pp. */
const DELTAS = [0, 0.5, 1.0, 1.5, 2.0] as const

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f: string) => {
    const i = a.indexOf(f)
    return i >= 0 ? a[i + 1] : undefined
  }
  return {
    product: get('--product') ?? 'stryktipset',
    useTest: a.includes('--test'),
    rowsPerDraw: get('--rows') ? Number(get('--rows')) : 100,
    verbose: a.includes('--verbose'),
  }
}

type Strategy = {
  name: string
  /** Returnerar raderna att spela för en omgång. Tom lista = avstå. */
  rows: (d: DrawData) => Row[]
}

type Outcome = {
  name: string
  staked: number
  returned: number
  drawsPlayed: number
  rowsPlayed: number
  /** Per omgång: (avkastning - insats) i öre. För bootstrap. */
  perDraw: number[]
  hits: Record<number, number>
}

function evaluate(strategy: Strategy, draws: DrawData[], excludeTier13 = false): Outcome {
  let staked = 0
  let returned = 0
  let drawsPlayed = 0
  let rowsPlayed = 0
  const perDraw: number[] = []
  const hits: Record<number, number> = { 13: 0, 12: 0, 11: 0, 10: 0 }

  for (const d of draws) {
    const rows = strategy.rows(d)
    if (rows.length === 0) continue
    drawsPlayed++
    let drawStake = 0
    let drawReturn = 0
    for (const row of rows) {
      drawStake += d.rowPriceOre
      const ret = actualReturnOre(row, d, { excludeTier13 })
      drawReturn += ret
      const c = countCorrect(row, d.outcome)
      if (c >= 10 && hits[c] !== undefined && ret > 0) hits[c]++
      rowsPlayed++
    }
    staked += drawStake
    returned += drawReturn
    perDraw.push(drawReturn - drawStake)
  }

  return { name: strategy.name, staked, returned, drawsPlayed, rowsPlayed, perDraw, hits }
}

function roi(o: Outcome): number {
  return o.staked > 0 ? (o.returned - o.staked) / o.staked : 0
}

/**
 * Bootstrap över OMGÅNGAR (inte rader) — utfallen är korrelerade inom en
 * omgång, så omgången är den oberoende enheten.
 */
function bootstrapRoi(o: Outcome, iters = 10_000, seed = 42): { p5: number; p50: number; p95: number } {
  if (o.perDraw.length === 0) return { p5: 0, p50: 0, p95: 0 }
  const rnd = makeRng(seed)
  const n = o.perDraw.length
  const stakePerDraw = o.staked / n
  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) sum += o.perDraw[Math.floor(rnd() * n)]!
    samples.push(sum / (stakePerDraw * n))
  }
  samples.sort((a, b) => a - b)
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) }
}

function fmtPct(v: number): string {
  return `${(v * 100 >= 0 ? '+' : '')}${(v * 100).toFixed(1)} %`
}

function line(o: Outcome, ci?: { p5: number; p50: number; p95: number }) {
  const r = roi(o)
  const hitStr = TIERS.map((t) => `${t}:${o.hits[t] ?? 0}`).join(' ')
  const ciStr = ci ? `  [5%: ${fmtPct(ci.p5)}  95%: ${fmtPct(ci.p95)}]` : ''
  console.log(
    `  ${o.name.padEnd(34)} ROI ${fmtPct(r).padStart(9)}${ciStr}` +
      `\n${' '.repeat(38)}${o.drawsPlayed} omg, ${o.rowsPlayed.toLocaleString('sv-SE')} rader, träffar ${hitStr}`,
  )
}

async function main() {
  const opts = parseArgs()
  const alpha = ALPHA[opts.product] ?? 1.05
  const db = getDb()

  console.log(`Laddar ${opts.product}...`)
  const all = await loadBacktestData(db, opts.product)
  console.log(`  ${all.length} omgångar med komplett data (odds + streck + facit + utdelning)\n`)

  if (all.length < 40) {
    console.log('För få omgångar. Kör import-archive först.')
    return
  }

  // --- TIDSDELNING. Aldrig slumpmässig. ---
  const splitAt = Math.floor(all.length * 0.6)
  const train = all.slice(0, splitAt)
  const test = all.slice(splitAt)
  const active = opts.useTest ? test : train

  console.log('═══ TIDSDELNING ═══')
  console.log(`  Träning: ${train.length} omgångar (${train[0]?.drawNumber}..${train[train.length - 1]?.drawNumber})`)
  console.log(`  Test:    ${test.length} omgångar (${test[0]?.drawNumber}..${test[test.length - 1]?.drawNumber})`)
  console.log(`  Kör mot: ${opts.useTest ? 'TESTMÄNGDEN (rör denna en gång!)' : 'träningsmängden'}\n`)

  // ═══ SANITY-TEST ═══
  //
  // Ursprungligen väntade jag ~-40 % (avdraget) för strecklinjen. Det var fel:
  // att spela EN rad ger -100 % i praktiken, eftersom en enskild rad nästan
  // aldrig träffar, och när folkets favoritrad DÅ träffar 10-11 rätt har
  // 244 000-1,4 miljoner andra samma rad → minimiutdelningsregeln nollar
  // gruppen. Verifierat: alla 13 fall av 10+ rätt i arkivet gav 0 kr.
  //
  // Det är kärnan i pari-mutuel: spela som alla andra och du vinner inget ens
  // när du har rätt. -40 % gäller kollektivet i genomsnitt, inte en enskild rad.
  //
  // Det meningsfulla sanity-testet är i stället: BREDD. Med tillräckligt många
  // slumpmässiga rader ska ROI närma sig avdragets storleksordning.
  console.log('═══ SANITY-TEST ═══')
  console.log('  En enskild rad ger nästan alltid −100 % (den träffar inte).')
  console.log('  Testet är i stället att bred slumpspelning närmar sig avdraget.\n')

  const crowdLine = evaluate({ name: 'Följ folket (1 rad/omgång)', rows: (d) => [crowdFavouriteRow(d)] }, active)
  line(crowdLine)

  const rngS = makeRng(7)
  const spread = evaluate(
    {
      name: `Slumpmässigt, ${opts.rowsPerDraw} rader/omgång`,
      rows: (d) => Array.from({ length: opts.rowsPerDraw }, () => sampleRow(d.crowd, rngS)),
    },
    active,
  )
  line(spread, bootstrapRoi(spread))

  const rngU = makeRng(11)
  const uniform: SignProbs[] = Array.from({ length: 13 }, () => ({ one: 1 / 3, x: 1 / 3, two: 1 / 3 }))
  const spreadUniform = evaluate(
    {
      name: `Likformigt slumpmässigt, ${opts.rowsPerDraw} rader`,
      rows: () => Array.from({ length: opts.rowsPerDraw }, () => sampleRow(uniform, rngU)),
    },
    active,
  )
  line(spreadUniform, bootstrapRoi(spreadUniform))

  // Referensmåttet: bred slumpspelning ska landa klart negativt men inte -100 %.
  const sanityOk = roi(spread) < 0 && roi(spread) > -0.99
  console.log(
    `\n  ${sanityOk ? '✓ PASSERAT' : '⚠ NOTERA'} — bred slumpspelning ger ${fmtPct(roi(spread))}` +
      (sanityOk
        ? ' (negativt, som väntat av avdraget)'
        : '\n  Om detta är positivt finns en bugg i utdelningsberäkningen.'),
  )
  if (roi(spread) > 0) {
    console.log('  STOPP: slumpspelning kan inte vara lönsam. Felsök innan vidare.')
    return
  }

  // ═══ BASLINJER ═══
  console.log('\n═══ BASLINJER ═══')
  const marketLine = evaluate(
    { name: 'Marknadens favoritrad', rows: (d) => [modelFavouriteRow(d)] },
    active,
  )
  line(marketLine, bootstrapRoi(marketLine))

  // ═══ EV-STRATEGIN över tröskelrutnätet ═══
  console.log(`\n═══ EV-STRATEGI (α=${alpha}, topp-${opts.rowsPerDraw} rader/omgång) ═══`)
  console.log('  Förregistrerat rutnät. Äkta edge är slät över grannvärden.\n')

  // Förberäkna topprader per omgång (dyrt: 1,59M rader × omgångar).
  console.log(`  Beräknar topp-EV-rader för ${active.length} omgångar...`)
  const topRowsCache = new Map<number, { row: Row; ev: number }[]>()
  for (const d of active) {
    topRowsCache.set(d.drawNumber, topEvRows(d, alpha, opts.rowsPerDraw))
  }
  console.log('  klart.\n')

  for (const threshold of EV_THRESHOLDS) {
    const strat: Strategy = {
      name: `EV-tröskel ${threshold.toFixed(1)}`,
      rows: (d) => {
        const top = topRowsCache.get(d.drawNumber) ?? []
        return top.filter((r) => r.ev / d.rowPriceOre >= threshold).map((r) => r.row)
      },
    }
    const o = evaluate(strat, active)
    line(o, bootstrapRoi(o))
  }

  // ═══ ROI UTAN 13-GRUPPEN ═══
  // Om allt plus kommer från en enstaka toppträff är det brus, inte edge.
  console.log('\n═══ SAMMA, MEN UTAN 13-GRUPPEN ═══')
  console.log('  Om edgen försvinner här kom den från enstaka lyckoträffar.\n')
  for (const threshold of EV_THRESHOLDS) {
    const strat: Strategy = {
      name: `EV-tröskel ${threshold.toFixed(1)} (ex 13)`,
      rows: (d) => {
        const top = topRowsCache.get(d.drawNumber) ?? []
        return top.filter((r) => r.ev / d.rowPriceOre >= threshold).map((r) => r.row)
      },
    }
    const o = evaluate(strat, active, true)
    line(o)
  }

  // ═══ δ-KÄNSLIGHETSKURVA ═══
  // Arkivet parar öppningsodds med slutgiltig streck. Vi mäter hur snabbt
  // edgen dör när modellen dras mot folket.
  console.log('\n═══ δ-KÄNSLIGHET (tidsskevhet) ═══')
  console.log('  Arkivet parar ÖPPNINGSodds med SLUTGILTIG streck — systematiskt')
  console.log('  optimistiskt. Uppmätt drift ~1,1 pp. Om edgen dör vid δ=1,1')
  console.log('  är den ett artefakt.\n')

  const bestThreshold = 1.2
  for (const delta of DELTAS) {
    const shrunk = active.map((d) => shrinkModelTowardCrowd(d, delta))
    const strat: Strategy = {
      name: `δ=${delta.toFixed(1)} pp`,
      rows: (d) => {
        const top = topEvRows(d, alpha, opts.rowsPerDraw)
        return top.filter((r) => r.ev / d.rowPriceOre >= bestThreshold).map((r) => r.row)
      },
    }
    const o = evaluate(strat, shrunk)
    const ci = bootstrapRoi(o)
    console.log(
      `  δ=${delta.toFixed(1)} pp  ROI ${fmtPct(roi(o)).padStart(9)}  ` +
        `[5%: ${fmtPct(ci.p5).padStart(9)}]  ${o.drawsPlayed} omg, ${o.rowsPlayed.toLocaleString('sv-SE')} rader`,
    )
  }

  console.log('\n═══ TOLKNING ═══')
  console.log('  Beslutsgrind: om ROI:ns 5:e percentil är negativ vid δ=1,1 pp')
  console.log('  → bygg ingen systemgenerator. Appen blir analysverktyg.')
  console.log('  Det utfallet är ett RESULTAT, inte ett misslyckande.')
}

main().catch((err) => {
  console.error('backtest kraschade:', err)
  process.exit(1)
})
