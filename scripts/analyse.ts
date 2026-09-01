/**
 * Värdetabell för aktuell omgång (PRD F1–F2).
 *
 * Detta är appens användbara kärna efter beslutsgrinden: ett ANALYSVERKTYG.
 * Den genererar medvetet inga spelförslag och rankar inga rader — backtesten
 * (§12) visade ingen edge i radurval, så sådana förslag vore vilseledande.
 *
 * Vad den visar:
 *  - streck vs marknadssannolikhet per match, med värdekvot
 *  - flaggor för över-/understreckning
 *  - streckrörelse sedan omgången öppnade (det daemonen samlar)
 *  - omgångens karaktär: favorittyngd eller skrällvänlig
 *
 *   npm run analyse                    # aktuell öppen omgång
 *   npm run analyse -- --draw 4968     # specifik omgång
 *   npm run analyse -- --product europatipset
 */

import { getDb } from '../src/db/client.ts'
import { draw, event, snapshot, eventSnapshot, result } from '../src/db/schema.ts'
import { eq, and, desc, asc } from 'drizzle-orm'
import { oddsToProbabilities, type Dist } from '../src/lib/parse.ts'
import { TIER_SHARE, BASE_PAYOUT_RATIO } from '../src/lib/payout.ts'

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (f: string) => {
    const i = a.indexOf(f)
    return i >= 0 ? a[i + 1] : undefined
  }
  return {
    product: get('--product') ?? 'stryktipset',
    drawNumber: get('--draw') ? Number(get('--draw')) : undefined,
  }
}

const SIGNS = ['1', 'X', '2'] as const
type Sign = (typeof SIGNS)[number]

function pad(s: string, n: number): string {
  // Padding som räknar tecken, inte bytes (svenska tecken).
  const len = [...s].length
  return len >= n ? [...s].slice(0, n).join('') : s + ' '.repeat(n - len)
}

function pct(v: number): string {
  return (v * 100).toFixed(0).padStart(3)
}

/** Värdekvot → flagga. Trösklarna är beskrivande, inte spelråd. */
function flagFor(value: number, modelP: number): string {
  if (value >= 1.25 && modelP >= 0.4) return 'UNDERSTRECKAD FAV'
  if (value >= 1.25) return 'understreckad'
  if (value <= 0.8 && modelP <= 0.25) return 'ÖVERSTRECKAD'
  if (value <= 0.8) return 'överstreckad'
  return ''
}

async function main() {
  const opts = parseArgs()
  const db = getDb()

  // Välj omgång: angiven, annars senaste öppna, annars senaste alls.
  const where = opts.drawNumber
    ? and(eq(draw.product, opts.product), eq(draw.drawNumber, opts.drawNumber))
    : eq(draw.product, opts.product)

  const draws = await db
    .select({
      id: draw.id,
      drawNumber: draw.drawNumber,
      closeAt: draw.closeAt,
      netSaleOre: draw.netSaleOre,
      rowPriceOre: draw.rowPriceOre,
    })
    .from(draw)
    .where(where)
    .orderBy(desc(draw.drawNumber))
    .limit(opts.drawNumber ? 1 : 20)

  const now = new Date()
  const target = opts.drawNumber
    ? draws[0]
    : (draws.find((d) => d.closeAt > now) ?? draws[0])

  if (!target) {
    console.log(`Ingen omgång hittad för ${opts.product}. Kör npm run capture först.`)
    return
  }

  // Senaste och första snapshot — för att visa streckrörelse.
  const snaps = await db
    .select({ id: snapshot.id, capturedAt: snapshot.capturedAt, hoursToClose: snapshot.hoursToClose })
    .from(snapshot)
    .where(and(eq(snapshot.drawId, target.id), eq(snapshot.source, 'live')))
    .orderBy(asc(snapshot.capturedAt))

  if (snaps.length === 0) {
    console.log(`Omgång ${target.drawNumber} saknar live-snapshots. Kör npm run capture.`)
    return
  }

  const first = snaps[0]!
  const last = snaps[snaps.length - 1]!

  const rowsFor = async (snapshotId: number) =>
    db
      .select({
        eventNumber: event.eventNumber,
        home: event.home,
        away: event.away,
        league: event.league,
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
      .where(eq(eventSnapshot.snapshotId, snapshotId))
      .orderBy(asc(event.eventNumber))

  const current = await rowsFor(last.id)
  const opening = snaps.length > 1 ? await rowsFor(first.id) : current
  const openingByNum = new Map(opening.map((r) => [r.eventNumber, r]))

  // Facit om omgången är avgjord.
  const facit = await db
    .select({ eventNumber: event.eventNumber, outcome: result.outcome })
    .from(result)
    .innerJoin(event, eq(event.id, result.eventId))
    .where(eq(result.drawId, target.id))
  const facitByNum = new Map(facit.map((f) => [f.eventNumber, f.outcome]))

  // ---- rubrik ----
  const hoursLeft = (target.closeAt.getTime() - now.getTime()) / 3_600_000
  const netSale = target.netSaleOre === null ? null : Number(target.netSaleOre) / 100
  console.log()
  console.log(`═══ ${opts.product.toUpperCase()} #${target.drawNumber} ═══`)
  console.log(
    `  Spelstopp: ${target.closeAt.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}` +
      (hoursLeft > 0 ? `  (om ${hoursLeft.toFixed(1)} h)` : '  (stängd)'),
  )
  if (netSale !== null) console.log(`  Omsättning: ${netSale.toLocaleString('sv-SE')} kr`)
  console.log(
    `  Snapshots: ${snaps.length} st, senaste ${last.capturedAt.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}`,
  )

  // ---- värdetabell ----
  console.log()
  console.log(
    `  ${pad('#', 3)}${pad('match', 26)}${pad('streck 1/X/2', 15)}${pad('marknad 1/X/2', 15)}` +
      `${pad('värde 1/X/2', 20)}${pad('rörelse', 9)}flagga`,
  )
  console.log('  ' + '─'.repeat(96))

  let sumFavProb = 0
  let nWithOdds = 0
  const perSignValues: { num: number; sign: Sign; value: number; modelP: number; crowdP: number }[] = []

  for (const r of current) {
    // Live-odds om de finns, annars öppningsodds.
    const oddsSrc =
      r.odds1 && r.oddsX && r.odds2
        ? { one: r.odds1, x: r.oddsX, two: r.odds2 }
        : { one: r.so1, x: r.soX, two: r.so2 }
    const mk = oddsToProbabilities(oddsSrc.one, oddsSrc.x, oddsSrc.two)
    const crowd: Dist = { one: Number(r.dist1), x: Number(r.distX), two: Number(r.dist2) }

    const label = `${r.home}-${r.away}`
    if (!mk) {
      console.log(`  ${pad(String(r.eventNumber), 3)}${pad(label, 26)}(odds saknas)`)
      continue
    }
    nWithOdds++
    sumFavProb += Math.max(mk.p.one, mk.p.x, mk.p.two)

    const values: Record<Sign, number> = {
      '1': mk.p.one / crowd.one,
      X: mk.p.x / crowd.x,
      '2': mk.p.two / crowd.two,
    }
    const modelPs: Record<Sign, number> = { '1': mk.p.one, X: mk.p.x, '2': mk.p.two }
    const crowdPs: Record<Sign, number> = { '1': crowd.one, X: crowd.x, '2': crowd.two }
    for (const s of SIGNS) {
      perSignValues.push({ num: r.eventNumber, sign: s, value: values[s], modelP: modelPs[s], crowdP: crowdPs[s] })
    }

    // Streckrörelse: största förändring i procentenheter sedan första snapshot.
    const op = openingByNum.get(r.eventNumber)
    let moveStr = '     -'
    if (op && snaps.length > 1) {
      const d1 = (crowd.one - Number(op.dist1)) * 100
      const dx = (crowd.x - Number(op.distX)) * 100
      const d2 = (crowd.two - Number(op.dist2)) * 100
      const biggest = [d1, dx, d2].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
      const which = Math.abs(d1) >= Math.abs(dx) && Math.abs(d1) >= Math.abs(d2) ? '1' : Math.abs(dx) >= Math.abs(d2) ? 'X' : '2'
      moveStr = Math.abs(biggest) < 0.5 ? '     -' : `${which}${biggest >= 0 ? '+' : ''}${biggest.toFixed(0)}pp`
    }

    // Flagga ALLA tecken som passerar tröskeln — en match kan ha både en
    // överstreckad och en understreckad sida, och båda är intressanta.
    // (Att bara visa det mest avvikande tecknet dolde t.ex. att Hull–Villa
    // hade både en kraftigt överstreckad 1:a och en understreckad 2:a.)
    const flagStr = SIGNS.map((s) => ({ s, f: flagFor(values[s], modelPs[s]) }))
      .filter((x) => x.f)
      .map((x) => `${x.s}: ${x.f}`)
      .join('  ')

    const fac = facitByNum.get(r.eventNumber)
    const facStr = fac ? ` [${fac}]` : ''

    // Korta lagnamnet, inte facit — annars klipps facit bort på långa
    // matchnamn (t.ex. "Blackburn-Queens Park Rangers").
    const maxLabel = 26 - [...facStr].length
    const shortLabel = [...label].length > maxLabel ? [...label].slice(0, maxLabel - 1).join('') + '…' : label

    console.log(
      `  ${pad(String(r.eventNumber), 3)}${pad(shortLabel + facStr, 26)}` +
        `${pct(crowd.one)}${pct(crowd.x)}${pct(crowd.two)}   ` +
        `${pct(mk.p.one)}${pct(mk.p.x)}${pct(mk.p.two)}   ` +
        `${pad(SIGNS.map((s) => values[s].toFixed(2)).join(' '), 20)}` +
        `${pad(moveStr, 9)}${flagStr}`,
    )
  }

  // ---- omgångens karaktär ----
  console.log()
  const avgFav = nWithOdds > 0 ? sumFavProb / nWithOdds : 0
  const character =
    avgFav > 0.52 ? 'favorittyngd (färre skrällar väntas)' : avgFav < 0.45 ? 'öppen/skrällvänlig' : 'normal'
  console.log(`  Omgångens karaktär: ${character} — genomsnittlig favoritsannolikhet ${(avgFav * 100).toFixed(0)} %`)

  // Störst avvikelser, som observation.
  const sorted = [...perSignValues].sort((a, b) => Math.abs(Math.log(b.value)) - Math.abs(Math.log(a.value)))
  console.log()
  console.log('  Största avvikelserna mellan marknad och streck:')
  for (const v of sorted.slice(0, 5)) {
    const dir = v.value > 1 ? 'marknaden tror mer än folket' : 'folket streckar mer än marknaden tror'
    console.log(
      `    match ${String(v.num).padStart(2)} tecken ${v.sign}:  ` +
        `streck ${(v.crowdP * 100).toFixed(0)} % vs marknad ${(v.modelP * 100).toFixed(0)} %  ` +
        `(kvot ${v.value.toFixed(2)}) — ${dir}`,
    )
  }

  // ---- ärlighetsnot ----
  console.log()
  console.log('  ' + '─'.repeat(96))
  console.log(`  Utbetalning: ${(BASE_PAYOUT_RATIO * 100).toFixed(1)} % av omsättningen (avdrag ${((1 - BASE_PAYOUT_RATIO) * 100).toFixed(1)} %).`)
  console.log(
    `  Vinstgrupper: 13→${(TIER_SHARE[13] * 100).toFixed(1)} %  12→${(TIER_SHARE[12] * 100).toFixed(2)} %  ` +
      `11→${(TIER_SHARE[11] * 100).toFixed(2)} %  10→${(TIER_SHARE[10] * 100).toFixed(1)} %`,
  )
  console.log()
  console.log('  OBS: detta är ett analysverktyg, inte ett spelförslag.')
  console.log('  Backtesten (PRD §12) visade INGEN edge i radurval: trimmad ROI −94 till −98 %')
  console.log('  vid alla testade trösklar. Kvoterna ovan visar var marknaden och folket')
  console.log('  skiljer sig — inte att sådana avvikelser går att tjäna pengar på.')
  console.log()
}

main().catch((err) => {
  console.error('analyse kraschade:', err)
  process.exit(1)
})
