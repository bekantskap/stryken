/**
 * Systemförslag för aktuell omgång.
 *
 * Du anger antal rader, verktyget föreslår garderingar.
 *
 *   npm run tips                    # visar giltiga systemstorlekar
 *   npm run tips -- --rader 48
 *   npm run tips -- --rader 96 --visa-rader     # skriv ut alla rader
 *   npm run tips -- --rader 48 --draw 4968      # specifik omgång
 *
 * ÄRLIGHETSNOT: backtesten (PRD §12) visade INGEN edge i radurval — trimmad
 * ROI −94 till −98 %. Detta verktyg löser problemet "givet att jag ska lämna
 * in N rader, vilka garderingar ger högst träffchans enligt marknadsodds?".
 * Det är inte samma sak som att systemet är lönsamt.
 */

import { getDb } from '../src/db/client.ts'
import { draw, event, snapshot, eventSnapshot, result } from '../src/db/schema.ts'
import { eq, and, desc, asc } from 'drizzle-orm'
import { oddsToProbabilities } from '../src/lib/parse.ts'
import { suggestSystem, validSystemSizes, expandRows, type Sign } from '../src/lib/system.ts'
import type { SignProbs } from '../src/lib/payout.ts'
import { BASE_PAYOUT_RATIO } from '../src/lib/payout.ts'

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f: string) => {
    const i = a.indexOf(f)
    return i >= 0 ? a[i + 1] : undefined
  }
  return {
    product: get('--product') ?? 'stryktipset',
    drawNumber: get('--draw') ? Number(get('--draw')) : undefined,
    rows: get('--rader') ? Number(get('--rader')) : undefined,
    showRows: a.includes('--visa-rader'),
  }
}

function pad(s: string, n: number): string {
  const len = [...s].length
  return len >= n ? [...s].slice(0, n).join('') : s + ' '.repeat(n - len)
}

async function main() {
  const opts = parseArgs()
  const sizes = validSystemSizes()

  if (!opts.rows) {
    console.log('\nAnge antal rader med --rader. Giltiga systemstorlekar:\n')
    // Gruppera i rader om 10 för läsbarhet.
    for (let i = 0; i < sizes.length; i += 10) {
      console.log('  ' + sizes.slice(i, i + 10).map((n) => String(n).padStart(5)).join(''))
    }
    console.log('\n  Ett system är garderingar per match, så radantalet är 3^hel × 2^halv.')
    console.log('  Kostnad = rader × 1 kr.  Exempel: npm run tips -- --rader 48\n')
    return
  }

  if (!sizes.includes(opts.rows)) {
    const near = sizes.reduce((a, b) => (Math.abs(b - opts.rows!) < Math.abs(a - opts.rows!) ? b : a))
    console.log(
      `\n${opts.rows} är ingen giltig systemstorlek (måste vara 3^hel × 2^halv).\n` +
        `Närmaste giltiga: ${near}. Kör utan --rader för hela listan.\n`,
    )
    return
  }

  const db = getDb()
  const where = opts.drawNumber
    ? and(eq(draw.product, opts.product), eq(draw.drawNumber, opts.drawNumber))
    : eq(draw.product, opts.product)

  const draws = await db
    .select({
      id: draw.id,
      drawNumber: draw.drawNumber,
      closeAt: draw.closeAt,
      rowPriceOre: draw.rowPriceOre,
    })
    .from(draw)
    .where(where)
    .orderBy(desc(draw.drawNumber))
    .limit(opts.drawNumber ? 1 : 20)

  const now = new Date()
  const target = opts.drawNumber ? draws[0] : (draws.find((d) => d.closeAt > now) ?? draws[0])
  if (!target) {
    console.log(`Ingen omgång hittad för ${opts.product}.`)
    return
  }

  const snaps = await db
    .select({ id: snapshot.id, capturedAt: snapshot.capturedAt })
    .from(snapshot)
    .where(and(eq(snapshot.drawId, target.id), eq(snapshot.source, 'live')))
    .orderBy(desc(snapshot.capturedAt))
    .limit(1)

  const snap = snaps[0]
  if (!snap) {
    console.log(`Omgång ${target.drawNumber} saknar live-snapshot. Kör npm run capture.`)
    return
  }

  const rows = await db
    .select({
      eventNumber: event.eventNumber,
      home: event.home,
      away: event.away,
      dist1: eventSnapshot.dist1,
      distX: eventSnapshot.distX,
      dist2: eventSnapshot.dist2,
      odds1: eventSnapshot.odds1,
      oddsX: eventSnapshot.oddsX,
      odds2: eventSnapshot.odds2,
      so1: eventSnapshot.startOdds1,
      soX: eventSnapshot.startOddsX,
      so2: eventSnapshot.startOdds2,
    })
    .from(eventSnapshot)
    .innerJoin(event, eq(event.id, eventSnapshot.eventId))
    .where(eq(eventSnapshot.snapshotId, snap.id))
    .orderBy(asc(event.eventNumber))

  const matches: { eventNumber: number; label: string; model: SignProbs; crowd: SignProbs }[] = []
  for (const r of rows) {
    const src =
      r.odds1 && r.oddsX && r.odds2
        ? { one: r.odds1, x: r.oddsX, two: r.odds2 }
        : { one: r.so1, x: r.soX, two: r.so2 }
    const mk = oddsToProbabilities(src.one, src.x, src.two)
    if (!mk) continue
    matches.push({
      eventNumber: r.eventNumber,
      label: `${r.home}-${r.away}`,
      model: mk.p,
      crowd: { one: Number(r.dist1), x: Number(r.distX), two: Number(r.dist2) },
    })
  }

  if (matches.length !== 13) {
    console.log(`Bara ${matches.length} matcher har odds — kan inte bygga system.`)
    return
  }

  const sys = suggestSystem(matches, opts.rows, target.rowPriceOre ?? 100)

  // Facit om omgången är avgjord.
  const facit = await db
    .select({ eventNumber: event.eventNumber, outcome: result.outcome })
    .from(result)
    .innerJoin(event, eq(event.id, result.eventId))
    .where(eq(result.drawId, target.id))
  const facitByNum = new Map(facit.map((f) => [f.eventNumber, f.outcome as Sign]))

  // ---- utskrift ----
  const hoursLeft = (target.closeAt.getTime() - now.getTime()) / 3_600_000
  console.log()
  console.log(`═══ SYSTEMFÖRSLAG — ${opts.product.toUpperCase()} #${target.drawNumber} ═══`)
  console.log(
    `  Spelstopp: ${target.closeAt.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}` +
      (hoursLeft > 0 ? `  (om ${hoursLeft.toFixed(1)} h)` : '  (STÄNGD)'),
  )
  // Bästa kombinationen fyller inte alltid budgeten exakt: 288 rader kan
  // t.ex. bäst utnyttjas som 243 (3^5). Visa vad du faktiskt betalar.
  const budgetNote =
    sys.rows < opts.rows ? `  (av budgeten ${opts.rows} — ${opts.rows} går inte att fylla bättre)` : ''
  console.log(`  System: ${sys.rows} rader = ${(sys.costOre / 100).toLocaleString('sv-SE')} kr${budgetNote}`)
  console.log()

  const covName = (n: number) => (n === 1 ? 'spik' : n === 2 ? 'halvgard.' : 'helgard.')
  console.log(`  ${pad('#', 3)}${pad('match', 28)}${pad('tecken', 10)}${pad('typ', 11)}${pad('marknad', 9)}streck`)
  console.log('  ' + '─'.repeat(72))
  for (const p of sys.picks) {
    const fac = facitByNum.get(p.eventNumber)
    const hit = fac ? (p.signs.includes(fac) ? ' ✓' : ' ✗') : ''
    const facStr = fac ? ` [${fac}]${hit}` : ''
    const maxLabel = 28 - [...facStr].length
    const lbl = [...p.label].length > maxLabel ? [...p.label].slice(0, maxLabel - 1).join('') + '…' : p.label
    console.log(
      `  ${pad(String(p.eventNumber), 3)}${pad(lbl + facStr, 28)}` +
        `${pad(p.signs.join(''), 10)}${pad(covName(p.signs.length), 11)}` +
        `${pad((p.coveredProb * 100).toFixed(0) + ' %', 9)}${(p.crowdProb * 100).toFixed(0)} %`,
    )
  }

  const spikar = sys.picks.filter((p) => p.signs.length === 1).length
  const halva = sys.picks.filter((p) => p.signs.length === 2).length
  const hela = sys.picks.filter((p) => p.signs.length === 3).length

  console.log()
  console.log(`  ${spikar} spikar, ${halva} halvgarderingar, ${hela} helgarderingar`)
  console.log(`  Sannolikhet att systemet innehåller rätt rad: ${(sys.prob13 * 100).toFixed(2)} %`)
  console.log(`  Förväntat antal rätt (bästa rad): ${sys.expectedCorrect.toFixed(1)} av 13`)

  if (facitByNum.size === 13) {
    const correct = sys.picks.filter((p) => {
      const f = facitByNum.get(p.eventNumber)
      return f && p.signs.includes(f)
    }).length
    console.log()
    console.log(`  FACIT: systemet fick ${correct} av 13 rätt` + (correct === 13 ? ' — hela systemet träffade!' : ''))
  }

  if (opts.showRows) {
    const all = expandRows(sys.picks)
    console.log()
    console.log(`  Alla ${all.length} rader:`)
    for (let i = 0; i < all.length; i++) {
      console.log(`    ${String(i + 1).padStart(4)}  ${all[i]!.join('')}`)
    }
  } else {
    console.log()
    console.log('  Lägg in garderingarna ovan hos Svenska Spel (--visa-rader för radlista).')
  }

  // ---- ärlighetsnot ----
  console.log()
  console.log('  ' + '─'.repeat(72))
  console.log('  SÅ HÄR ÄR DETTA VALT: garderingar placerade där de ger mest')
  console.log('  sannolikhet per tillkommen rad, enligt marknadsodds. Alltså')
  console.log('  maximerad TRÄFFCHANS för din budget.')
  console.log()
  console.log(`  MEN: utbetalningen är ${(BASE_PAYOUT_RATIO * 100).toFixed(1)} % av omsättningen (avdrag`)
  console.log(`  ${((1 - BASE_PAYOUT_RATIO) * 100).toFixed(1)} %), och backtesten över 147 omgångar visade INGEN edge i`)
  console.log('  radurval: trimmad ROI −94 till −98 % vid alla testade trösklar.')
  console.log('  Förväntad avkastning på detta system är negativ. Spela belopp du')
  console.log('  är bekväm med att förlora.')
  console.log()
}

main().catch((err) => {
  console.error('tips kraschade:', err)
  process.exit(1)
})
