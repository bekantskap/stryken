import { getDb } from '../db/client.ts'
import { draw, event, snapshot, eventSnapshot, result } from '../db/schema.ts'
import { eq, and, asc } from 'drizzle-orm'
import { parseDecimal } from './parse.ts'

/**
 * Mäter om Svenska Spels oddsrörelse förutsäger utfall.
 *
 * DEN SISTA ÖPPNA FRÅGAN i projektet — alla andra spår är stängda med data
 * (PRD §12 radurval, §9.1 extrapott, och oddsjämförelsen mot skarp marknad).
 *
 * Hypotesen: om linjen rör sig mot ett tecken under omgången har pengar med
 * bättre information kommit in. Att följa rörelsen skulle då slå att spela
 * på öppningsodds.
 *
 * Delat lager mellan CLI (scripts/line-movement.ts) och UI (app/) så de
 * aldrig kan visa olika siffror.
 */

/** Under detta antal matcher är slutsatser inte meningsfulla. */
export const MIN_MATCHES = 300

/** Rörelse (procentenheter implicit sannolikhet) för att räknas som signal. */
export const SIGNAL_PP = 1.5

/** Matcher som tillkommer per vecka, för tidsuppskattning. */
export const MATCHES_PER_WEEK = 40

export type StrategyResult = {
  name: string
  n: number
  roi: number
  p5: number
  p95: number
  verdict: 'för få' | 'ej signifikant' | 'signifikant positiv' | 'signifikant negativ'
}

export type LineMovementReport = {
  totalMatches: number
  usableMatches: number
  /** Genomsnittligt mätfönster i timmar före spelstopp. */
  spanFromHours: number
  spanToHours: number
  ready: boolean
  weeksRemaining: number
  medianMovePp: number
  strategies: StrategyResult[]
  /** Uppdelning på hur nära spelstopp sista mätpunkten togs. Tom om ej ready. */
  byTiming: StrategyResult[]
}

type Snap = { hours: number; o1: number; ox: number; o2: number }
type MatchRec = { outcome: '1' | 'X' | '2'; snaps: Snap[] }

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function bootstrap(pl: number[], iters = 10_000): { p5: number; p95: number } {
  if (pl.length === 0) return { p5: 0, p95: 0 }
  const rnd = makeRng(42)
  const out: number[] = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < pl.length; j++) sum += pl[Math.floor(rnd() * pl.length)]!
    out.push(sum / pl.length)
  }
  out.sort((a, b) => a - b)
  const q = (p: number) => out[Math.min(out.length - 1, Math.floor(p * out.length))]!
  return { p5: q(0.05), p95: q(0.95) }
}

function summarise(name: string, pl: number[]): StrategyResult {
  if (pl.length === 0) {
    return { name, n: 0, roi: 0, p5: 0, p95: 0, verdict: 'för få' }
  }
  const roi = pl.reduce((a, b) => a + b, 0) / pl.length
  const { p5, p95 } = bootstrap(pl)
  // Kräver att HELA intervallet ligger på ena sidan noll — inte bara
  // medelvärdet. Ett positivt medelvärde med negativ 5-percentil är brus.
  const verdict: StrategyResult['verdict'] =
    pl.length < 100 ? 'för få' : p5 > 0 ? 'signifikant positiv' : p95 < 0 ? 'signifikant negativ' : 'ej signifikant'
  return { name, n: pl.length, roi, p5, p95, verdict }
}

export async function loadLineMovement(): Promise<LineMovementReport> {
  const db = getDb()

  const rows = await db
    .select({
      product: draw.product,
      drawNumber: draw.drawNumber,
      eventNumber: event.eventNumber,
      hours: snapshot.hoursToClose,
      o1: eventSnapshot.odds1,
      ox: eventSnapshot.oddsX,
      o2: eventSnapshot.odds2,
      outcome: result.outcome,
    })
    .from(eventSnapshot)
    .innerJoin(snapshot, and(eq(snapshot.id, eventSnapshot.snapshotId), eq(snapshot.source, 'live')))
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
    if (o1 <= 1 || ox <= 1 || o2 <= 1) continue
    const key = `${r.product}|${r.drawNumber}|${r.eventNumber}`
    const snap: Snap = { hours: Number(r.hours), o1, ox, o2 }
    const cur = byMatch.get(key)
    if (cur) cur.snaps.push(snap)
    else byMatch.set(key, { outcome: r.outcome as '1' | 'X' | '2', snaps: [snap] })
  }

  const usable = [...byMatch.values()].filter((m) => m.snaps.length >= 2)
  const ready = usable.length >= MIN_MATCHES

  if (usable.length === 0) {
    return {
      totalMatches: byMatch.size,
      usableMatches: 0,
      spanFromHours: 0,
      spanToHours: 0,
      ready: false,
      weeksRemaining: Math.ceil(MIN_MATCHES / MATCHES_PER_WEEK),
      medianMovePp: 0,
      strategies: [],
      byTiming: [],
    }
  }

  const spanFromHours = usable.reduce((a, m) => a + m.snaps[0]!.hours, 0) / usable.length
  const spanToHours =
    usable.reduce((a, m) => a + m.snaps[m.snaps.length - 1]!.hours, 0) / usable.length

  const SIGNS = ['1', 'X', '2'] as const
  const follow: number[] = []
  const fade: number[] = []
  const baseline: number[] = []
  const moves: number[] = []

  const timingBuckets: { lo: number; hi: number; label: string; pl: number[] }[] = [
    { lo: 0, hi: 6, label: '< 6 h före spelstopp', pl: [] },
    { lo: 6, hi: 24, label: '6–24 h före', pl: [] },
    { lo: 24, hi: Infinity, label: '> 24 h före', pl: [] },
  ]

  for (const m of usable) {
    const first = m.snaps[0]!
    const last = m.snaps[m.snaps.length - 1]!
    const fO = [first.o1, first.ox, first.o2]
    const lO = [last.o1, last.ox, last.o2]

    for (let i = 0; i < 3; i++) {
      const pFirst = 1 / fO[i]!
      const pLast = 1 / lO[i]!
      const odds = lO[i]!
      const driftPp = (pLast - pFirst) * 100
      moves.push(Math.abs(driftPp))
      const pl = m.outcome === SIGNS[i] ? odds - 1 : -1

      baseline.push(pl)
      if (driftPp >= SIGNAL_PP) {
        follow.push(pl)
        const b = timingBuckets.find((b) => last.hours >= b.lo && last.hours < b.hi)
        if (b) b.pl.push(pl)
      } else if (driftPp <= -SIGNAL_PP) {
        fade.push(pl)
      }
    }
  }

  moves.sort((a, b) => a - b)

  return {
    totalMatches: byMatch.size,
    usableMatches: usable.length,
    spanFromHours,
    spanToHours,
    ready,
    weeksRemaining: Math.max(
      0,
      Math.ceil((MIN_MATCHES - usable.length) / MATCHES_PER_WEEK),
    ),
    medianMovePp: moves[Math.floor(moves.length / 2)] ?? 0,
    strategies: [
      summarise('Spela alla tecken (baslinje)', baseline),
      summarise('Följ rörelsen', follow),
      summarise('Fade rörelsen', fade),
    ],
    byTiming: ready ? timingBuckets.map((b) => summarise(b.label, b.pl)) : [],
  }
}
