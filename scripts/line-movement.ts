/**
 * Mäter om Svenska Spels oddsrörelse förutsäger utfall.
 *
 * DEN SISTA ÖPPNA FRÅGAN i projektet. Alla andra spår är stängda med data
 * (PRD §12, §9.1, och oddsjämförelsen mot skarp marknad).
 *
 * Hypotesen: om linjen rör sig mot ett tecken under omgången betyder det att
 * pengar med bättre information kommit in. Att följa rörelsen skulle då vara
 * lönsammare än att spela på öppningsodds.
 *
 * Varför detta kräver väntan: live-odds nollställs när en omgång avgörs, så
 * bara omgångar vi capturat live OCH som hunnit avgöras kan användas. Det
 * växer med ~40 matcher/vecka, alltså ~3 månader till 500.
 *
 *   npm run line-movement
 *
 * Skriptet säger själv till om datan ännu är för tunn.
 */

import { getDb } from '../src/db/client.ts'
import { draw, event, snapshot, eventSnapshot, result } from '../src/db/schema.ts'
import { eq, and, asc } from 'drizzle-orm'
import { parseDecimal } from '../src/lib/parse.ts'

/** Under detta antal matcher är slutsatser inte meningsfulla. */
const MIN_MATCHES = 300
/** Rörelse (i procentenheter implicit sannolikhet) för att räknas som signal. */
const SIGNAL_PP = 1.5

type Snap = {
  hours: number
  o1: number | null
  ox: number | null
  o2: number | null
}

type MatchRec = {
  key: string
  product: string
  drawNumber: number
  eventNumber: number
  outcome: '1' | 'X' | '2'
  snaps: Snap[]
}

function implied(o: number | null): number | null {
  return o === null || o <= 1 ? null : 1 / o
}

/** Deterministisk pseudoslump för bootstrap. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function bootstrap(pl: number[], iters = 10_000): { p5: number; p50: number; p95: number } {
  if (pl.length === 0) return { p5: 0, p50: 0, p95: 0 }
  const rnd = makeRng(42)
  const out: number[] = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < pl.length; j++) sum += pl[Math.floor(rnd() * pl.length)]!
    out.push(sum / pl.length)
  }
  out.sort((a, b) => a - b)
  const q = (p: number) => out[Math.min(out.length - 1, Math.floor(p * out.length))]!
  return { p5: q(0.05), p50: q(0.5), p95: q(0.95) }
}

function fmt(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} %`
}

async function main() {
  const db = getDb()

  const rows = await db
    .select({
      product: draw.product,
      drawNumber: draw.drawNumber,
      eventNumber: event.eventNumber,
      hours: snapshot.hoursToClose,
      capturedAt: snapshot.capturedAt,
      o1: eventSnapshot.odds1,
      ox: eventSnapshot.oddsX,
      o2: eventSnapshot.odds2,
      outcome: result.outcome,
    })
    .from(eventSnapshot)
    .innerJoin(
      snapshot,
      and(eq(snapshot.id, eventSnapshot.snapshotId), eq(snapshot.source, 'live')),
    )
    .innerJoin(event, eq(event.id, eventSnapshot.eventId))
    .innerJoin(draw, eq(draw.id, event.drawId))
    .innerJoin(result, eq(result.eventId, event.id))
    .orderBy(asc(snapshot.capturedAt))

  const byMatch = new Map<string, MatchRec>()
  for (const r of rows) {
    if (!r.outcome) continue
    const o1 = parseDecimal(r.o1)
    const ox = parseDecimal(r.ox)
    const o2 = parseDecimal(r.o2)
    if (o1 === null || ox === null || o2 === null) continue
    const key = `${r.product}|${r.drawNumber}|${r.eventNumber}`
    const snap: Snap = { hours: Number(r.hours), o1, ox, o2 }
    const cur = byMatch.get(key)
    if (cur) cur.snaps.push(snap)
    else
      byMatch.set(key, {
        key,
        product: r.product,
        drawNumber: r.drawNumber,
        eventNumber: r.eventNumber,
        outcome: r.outcome as '1' | 'X' | '2',
        snaps: [snap],
      })
  }

  const usable = [...byMatch.values()].filter((m) => m.snaps.length >= 2)

  console.log(`\n═══ LINJERÖRELSE — förutsäger den utfall? ═══\n`)
  console.log(`  ${byMatch.size} matcher med live-odds + facit`)
  console.log(`  ${usable.length} med minst två snapshots (mätbar rörelse)`)

  if (usable.length === 0) {
    console.log('\n  Ingen data än. Daemonen behöver köra genom avgjorda omgångar.')
    return
  }

  const spanFrom = usable.reduce((a, m) => a + m.snaps[0]!.hours, 0) / usable.length
  const spanTo =
    usable.reduce((a, m) => a + m.snaps[m.snaps.length - 1]!.hours, 0) / usable.length
  console.log(`  Mätfönster: ${spanFrom.toFixed(1)} h → ${spanTo.toFixed(1)} h före spelstopp`)

  if (usable.length < MIN_MATCHES) {
    const weeks = Math.ceil((MIN_MATCHES - usable.length) / 40)
    console.log(
      `\n  ⏳ FÖR TIDIGT. Behöver ${MIN_MATCHES}+ matcher för en meningsfull slutsats.\n` +
        `     Vid ~40 matcher/vecka: ungefär ${weeks} veckor kvar.\n` +
        `     Kör om skriptet då — det säger till när datan räcker.`,
    )
    console.log('\n  (Preliminära tal nedan är BRUS vid detta urval. Läs dem inte som resultat.)')
  }

  // --- Strategierna ---
  //
  // För varje match: jämför första och sista live-odds. Satsa på det tecken
  // linjen rört sig MOT (marknaden tror mer nu) respektive BORT från.
  // Avkastningen räknas mot SISTA oddset — det man faktiskt kan spela på.
  const follow: number[] = []
  const fade: number[] = []
  const baseline: number[] = []

  for (const m of usable) {
    const first = m.snaps[0]!
    const last = m.snaps[m.snaps.length - 1]!
    const signs = ['1', 'X', '2'] as const
    const firstO = [first.o1, first.ox, first.o2]
    const lastO = [last.o1, last.ox, last.o2]

    for (let i = 0; i < 3; i++) {
      const pFirst = implied(firstO[i]!)
      const pLast = implied(lastO[i]!)
      const odds = lastO[i]!
      if (pFirst === null || pLast === null || odds === null || odds <= 1) continue

      const driftPp = (pLast - pFirst) * 100
      const won = m.outcome === signs[i]
      const pl = won ? odds - 1 : -1

      baseline.push(pl)
      if (driftPp >= SIGNAL_PP) follow.push(pl)
      else if (driftPp <= -SIGNAL_PP) fade.push(pl)
    }
  }

  const report = (name: string, pl: number[]) => {
    if (pl.length === 0) {
      console.log(`  ${name.padEnd(38)} (inga observationer)`)
      return
    }
    const roi = pl.reduce((a, b) => a + b, 0) / pl.length
    const ci = bootstrap(pl)
    const verdict =
      pl.length < 100
        ? 'för få'
        : ci.p5 > 0
          ? 'SIGNIFIKANT POSITIV'
          : ci.p95 < 0
            ? 'signifikant negativ'
            : 'ej signifikant'
    console.log(
      `  ${name.padEnd(38)} n=${String(pl.length).padStart(5)}  ROI ${fmt(roi).padStart(9)}  ` +
        `[5%: ${fmt(ci.p5).padStart(9)}]  ${verdict}`,
    )
  }

  console.log(`\n  Signaltröskel: rörelse ≥ ${SIGNAL_PP} pp implicit sannolikhet\n`)
  report('Spela ALLA tecken (baslinje)', baseline)
  report('FÖLJ rörelsen (marknaden tror mer)', follow)
  report('FADE rörelsen (marknaden tror mindre)', fade)

  console.log(
    `\n  Tolkning: baslinjen ska ligga nära −5,6 % (Svenska Spels marginal).\n` +
      `  För att en strategi ska räknas som edge krävs att 5-percentilen är\n` +
      `  POSITIV — inte bara att medelvärdet är det.`,
  )

  // Delat på hur nära spelstopp rörelsen mäts — sena rörelser bär mer info.
  if (usable.length >= MIN_MATCHES) {
    console.log('\n  Uppdelat på när sista mätpunkten togs:')
    for (const [lo, hi, lbl] of [
      [0, 6, '< 6 h före stopp'],
      [6, 24, '6–24 h'],
      [24, 999, '> 24 h'],
    ] as const) {
      const sub: number[] = []
      for (const m of usable) {
        const last = m.snaps[m.snaps.length - 1]!
        if (last.hours < lo || last.hours >= hi) continue
        const first = m.snaps[0]!
        const signs = ['1', 'X', '2'] as const
        const fO = [first.o1, first.ox, first.o2]
        const lO = [last.o1, last.ox, last.o2]
        for (let i = 0; i < 3; i++) {
          const pf = implied(fO[i]!)
          const pl2 = implied(lO[i]!)
          if (pf === null || pl2 === null) continue
          if ((pl2 - pf) * 100 < SIGNAL_PP) continue
          sub.push(m.outcome === signs[i] ? lO[i]! - 1 : -1)
        }
      }
      report(`  följ rörelsen, ${lbl}`, sub)
    }
  }
  console.log()
}

main().catch((err) => {
  console.error('line-movement kraschade:', err)
  process.exit(1)
})
