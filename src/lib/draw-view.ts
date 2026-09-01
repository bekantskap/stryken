import { getDb } from '../db/client.ts'
import { draw, event, snapshot, eventSnapshot, result } from '../db/schema.ts'
import { eq, and, desc, asc } from 'drizzle-orm'
import { oddsToProbabilities } from './parse.ts'
import { suggestSystem, biggestMove, type MoveFlag, type Sign, type SystemSuggestion } from './system.ts'
import type { SignProbs } from './payout.ts'

/**
 * Delat datalager för omgångsvyn — används av både CLI (scripts/) och
 * webb-UI (app/). Håller SQL och härledningar på ett ställe så de två
 * gränssnitten aldrig kan visa olika siffror.
 */

export type MatchView = {
  eventNumber: number
  home: string
  away: string
  league: string | null
  kickoffAt: Date | null
  model: SignProbs
  crowd: SignProbs
  /** Värdekvot per tecken: modell / streck. */
  value: { one: number; x: number; two: number }
  move: MoveFlag | null
  outcome: Sign | null
}

export type DrawView = {
  drawNumber: number
  product: string
  closeAt: Date
  isOpen: boolean
  hoursLeft: number
  netSaleKr: number | null
  rowPriceOre: number
  snapshotCount: number
  lastCapturedAt: Date | null
  matches: MatchView[]
  /** Genomsnittlig favoritsannolikhet — omgångens karaktär. */
  avgFavourite: number
  settled: boolean
}

export async function loadDrawView(
  product: string,
  drawNumber?: number,
): Promise<DrawView | null> {
  const db = getDb()

  const where = drawNumber
    ? and(eq(draw.product, product), eq(draw.drawNumber, drawNumber))
    : eq(draw.product, product)

  const draws = await db
    .select({
      id: draw.id,
      drawNumber: draw.drawNumber,
      product: draw.product,
      closeAt: draw.closeAt,
      netSaleOre: draw.netSaleOre,
      rowPriceOre: draw.rowPriceOre,
    })
    .from(draw)
    .where(where)
    .orderBy(desc(draw.drawNumber))
    .limit(drawNumber ? 1 : 20)

  const now = new Date()
  const target = drawNumber ? draws[0] : (draws.find((d) => d.closeAt > now) ?? draws[0])
  if (!target) return null

  const snaps = await db
    .select({ id: snapshot.id, capturedAt: snapshot.capturedAt })
    .from(snapshot)
    .where(and(eq(snapshot.drawId, target.id), eq(snapshot.source, 'live')))
    .orderBy(asc(snapshot.capturedAt))

  const last = snaps[snaps.length - 1]
  if (!last) return null
  const first = snaps[0]

  const rows = await db
    .select({
      eventNumber: event.eventNumber,
      home: event.home,
      away: event.away,
      league: event.league,
      kickoffAt: event.kickoffAt,
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
    .where(eq(eventSnapshot.snapshotId, last.id))
    .orderBy(asc(event.eventNumber))

  const openingRows =
    first && first.id !== last.id
      ? await db
          .select({
            eventNumber: event.eventNumber,
            dist1: eventSnapshot.dist1,
            distX: eventSnapshot.distX,
            dist2: eventSnapshot.dist2,
          })
          .from(eventSnapshot)
          .innerJoin(event, eq(event.id, eventSnapshot.eventId))
          .where(eq(eventSnapshot.snapshotId, first.id))
          .orderBy(asc(event.eventNumber))
      : []
  const openingByNum = new Map(
    openingRows.map((r) => [
      r.eventNumber,
      { one: Number(r.dist1), x: Number(r.distX), two: Number(r.dist2) } as SignProbs,
    ]),
  )

  const facit = await db
    .select({ eventNumber: event.eventNumber, outcome: result.outcome })
    .from(result)
    .innerJoin(event, eq(event.id, result.eventId))
    .where(eq(result.drawId, target.id))
  const facitByNum = new Map(facit.map((f) => [f.eventNumber, f.outcome as Sign]))

  const matches: MatchView[] = []
  let favSum = 0
  for (const r of rows) {
    const src =
      r.odds1 && r.oddsX && r.odds2
        ? { one: r.odds1, x: r.oddsX, two: r.odds2 }
        : { one: r.so1, x: r.soX, two: r.so2 }
    const mk = oddsToProbabilities(src.one, src.x, src.two)
    if (!mk) continue
    const crowd: SignProbs = { one: Number(r.dist1), x: Number(r.distX), two: Number(r.dist2) }
    favSum += Math.max(mk.p.one, mk.p.x, mk.p.two)
    matches.push({
      eventNumber: r.eventNumber,
      home: r.home,
      away: r.away,
      league: r.league,
      kickoffAt: r.kickoffAt,
      model: mk.p,
      crowd,
      value: {
        one: mk.p.one / crowd.one,
        x: mk.p.x / crowd.x,
        two: mk.p.two / crowd.two,
      },
      move: biggestMove(openingByNum.get(r.eventNumber), crowd),
      outcome: facitByNum.get(r.eventNumber) ?? null,
    })
  }

  return {
    drawNumber: target.drawNumber,
    product: target.product,
    closeAt: target.closeAt,
    isOpen: target.closeAt > now,
    hoursLeft: (target.closeAt.getTime() - now.getTime()) / 3_600_000,
    netSaleKr: target.netSaleOre === null ? null : Number(target.netSaleOre) / 100,
    rowPriceOre: target.rowPriceOre ?? 100,
    snapshotCount: snaps.length,
    lastCapturedAt: last.capturedAt,
    matches,
    avgFavourite: matches.length > 0 ? favSum / matches.length : 0,
    settled: facitByNum.size === matches.length && matches.length > 0,
  }
}

/** Bygger ett systemförslag ur en laddad omgångsvy. */
export function systemFor(view: DrawView, targetRows: number): SystemSuggestion {
  return suggestSystem(
    view.matches.map((m) => ({
      eventNumber: m.eventNumber,
      label: `${m.home}-${m.away}`,
      model: m.model,
      crowd: m.crowd,
    })),
    targetRows,
    view.rowPriceOre,
  )
}

/** Lista över tillgängliga omgångar, nyast först. */
export async function listDraws(product: string, limit = 30) {
  const db = getDb()
  return db
    .select({
      drawNumber: draw.drawNumber,
      closeAt: draw.closeAt,
      netSaleOre: draw.netSaleOre,
    })
    .from(draw)
    .where(eq(draw.product, product))
    .orderBy(desc(draw.drawNumber))
    .limit(limit)
}
