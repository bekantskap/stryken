/**
 * Torrkörning utan databas: hämtar live-data och visar vad som skulle skrivas.
 *
 * Finns för att verifiera parsning och API-klient innan Neon är uppsatt, och
 * som felsökningsverktyg när Svenska Spel ändrar sitt odokumenterade API.
 *
 *   npx tsx scripts/dry-run.ts
 */

import { PRODUCTS, fetchCurrentDraw } from '../src/lib/svenskaspel.ts'
import { fetchCalendarGames, fetchGame } from '../src/lib/atg.ts'
import {
  parseDecimal,
  parseAmountToOre,
  normaliseDistribution,
  oddsToProbabilities,
} from '../src/lib/parse.ts'

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
const fmtPct = (v: number) => (v * 100).toFixed(1).padStart(5)

async function football() {
  for (const product of PRODUCTS) {
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

async function trav() {
  console.log('\n═══ ATG ═══')
  const today = new Date().toISOString().slice(0, 10)
  const games = await fetchCalendarGames(today)
  console.log(`  ${today}: ${games.length} spel av följd typ`)
  for (const g of games.slice(0, 2)) {
    const raw = await fetchGame(g.gameId)
    if (!raw) continue
    const races = raw['races']
    if (!Array.isArray(races) || !races[0]) continue
    const r0 = races[0] as Record<string, unknown>
    const starts = r0['starts']
    console.log(`\n  ${g.poolType} ${g.gameId} — lopp 1, ${Array.isArray(starts) ? starts.length : 0} startande`)
    if (!Array.isArray(starts)) continue
    console.log(`    ${pad('nr', 4)}${pad('spår', 5)}${pad('häst', 24)}${pad('vinnarodds', 12)}${pad('streck%', 9)}barfota`)
    for (const st of starts.slice(0, 6)) {
      const s = st as Record<string, unknown>
      const horse = (s['horse'] ?? {}) as Record<string, unknown>
      const pools = (s['pools'] ?? {}) as Record<string, unknown>
      const vin = (pools['vinnare'] ?? {}) as Record<string, unknown>
      const pool = (pools[g.poolType] ?? {}) as Record<string, unknown>
      const shoes = (horse['shoes'] ?? {}) as Record<string, unknown>
      const front = (shoes['front'] ?? {}) as Record<string, unknown>
      const back = (shoes['back'] ?? {}) as Record<string, unknown>

      // Nativa skalor: odds i hundradelar, betDistribution i hundradelar procent.
      const oddsRaw = parseDecimal(vin['odds'])
      const distRaw = parseDecimal(pool['betDistribution'])
      const bare =
        front['hasShoe'] === false && back['hasShoe'] === false
          ? 'barfota fram+bak'
          : front['hasShoe'] === false
            ? 'barfota fram'
            : back['hasShoe'] === false
              ? 'barfota bak'
              : ''

      console.log(
        `    ${pad(String(s['number']), 4)}${pad(String(s['postPosition']), 5)}` +
          `${pad(String(horse['name'] ?? ''), 24)}` +
          `${pad(oddsRaw === null ? '?' : (oddsRaw / 100).toFixed(2), 12)}` +
          `${pad(distRaw === null ? '?' : (distRaw / 100).toFixed(2), 9)}${bare}`,
      )
    }
  }
}

async function main() {
  await football()
  await trav()
  console.log('\nTorrkörning klar — inget skrevs till databas.')
}

main().catch((err) => {
  console.error('dry-run misslyckades:', err)
  process.exit(1)
})
