/**
 * Torrkörning utan databas: hämtar live-data och visar vad som skulle skrivas.
 *
 * Finns för att verifiera parsning och API-klient innan Neon är uppsatt, och
 * som felsökningsverktyg när Svenska Spel ändrar sitt odokumenterade API.
 *
 *   npx tsx scripts/dry-run.ts
 */

import { CAPTURE_PRODUCTS, fetchCurrentDraw } from '../src/lib/svenskaspel.ts'
import {
  parseDecimal,
  parseAmountToOre,
  normaliseDistribution,
  oddsToProbabilities,
} from '../src/lib/parse.ts'

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
const fmtPct = (v: number) => (v * 100).toFixed(1).padStart(5)

async function football() {
  for (const product of CAPTURE_PRODUCTS) {
    console.log(`\n═══ ${product.toUpperCase()} ═══`)
    const raw = await fetchCurrentDraw(product)
    if (!raw) {
      console.log('  ingen öppen omgång')
      continue
    }

    const netSale = parseAmountToOre(raw['currentNetSale'])
    const rowPrice = parseAmountToOre(raw['rowPrice'])
    console.log(
      `  omgång ${raw['drawNumber']}  stänger ${String(raw['regCloseTime']).slice(0, 16)}`,
    )
    console.log(
      `  omsättning ${netSale === null ? '?' : (Number(netSale) / 100).toLocaleString('sv-SE')} kr` +
        `  radpris ${rowPrice === null ? '?' : Number(rowPrice) / 100} kr` +
        `  fund=${JSON.stringify(raw['fund'])}`,
    )

    const events = raw['drawEvents']
    if (!Array.isArray(events)) continue

    console.log(
      `\n  ${pad('#', 3)}${pad('match', 26)}${pad('streck 1/X/2', 20)}${pad('p_marknad 1/X/2', 20)}${pad('värde 1/X/2', 20)}`,
    )
    let overroundSum = 0
    let overroundN = 0

    for (const ev of events) {
      const e = ev as Record<string, unknown>
      const num = parseDecimal(e['eventNumber'])
      const sf = (e['svenskaFolket'] ?? {}) as Record<string, unknown>
      const dist = normaliseDistribution(sf['one'], sf['x'], sf['two'])
      // Live-odds om de finns, annars öppningsodds (arkivfallet).
      const oddsObj = (e['odds'] ?? e['startOdds'] ?? {}) as Record<string, unknown>
      const mk = oddsToProbabilities(oddsObj['one'], oddsObj['x'], oddsObj['two'])

      const desc = String(e['eventDescription'] ?? '')
      if (!dist || !mk) {
        console.log(`  ${pad(String(num), 3)}${pad(desc, 26)}(data saknas)`)
        continue
      }
      overroundSum += mk.overround
      overroundN++

      const v1 = mk.p.one / dist.one
      const vx = mk.p.x / dist.x
      const v2 = mk.p.two / dist.two
      const mark = (v: number) => (v >= 1.15 ? '+' : v <= 0.87 ? '-' : ' ')

      console.log(
        `  ${pad(String(num), 3)}${pad(desc, 26)}` +
          `${fmtPct(dist.one)}${fmtPct(dist.x)}${fmtPct(dist.two)}  ` +
          `${fmtPct(mk.p.one)}${fmtPct(mk.p.x)}${fmtPct(mk.p.two)}  ` +
          `${v1.toFixed(2)}${mark(v1)} ${vx.toFixed(2)}${mark(vx)} ${v2.toFixed(2)}${mark(v2)}`,
      )
    }
    if (overroundN > 0) {
      console.log(
        `\n  marginal (overround): ${(overroundSum / overroundN).toFixed(4)} ` +
          `→ ${(((overroundSum / overroundN) - 1) * 100).toFixed(2)} %`,
      )
    }
    console.log(
      '\n  OBS: värde > 1 betyder att marknaden tror mer än folket streckar.\n' +
        '  Det säger inget om huruvida edgen överlever 40,3 % avdrag — det avgörs\n' +
        '  först av backtesten (fas 2).',
    )
  }
}

async function main() {
  await football()
  console.log('\nTorrkörning klar — inget skrevs till databas.')
}

main().catch((err) => {
  console.error('dry-run misslyckades:', err)
  process.exit(1)
})
