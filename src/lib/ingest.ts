import { eq, and } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { draw, event, snapshot, eventSnapshot } from '../db/schema.ts'
import type { Product, RawDraw } from './svenskaspel.ts'
import {
  parseDecimal,
  parseAmountToOre,
  normaliseDistribution,
} from './parse.ts'

/**
 * Skriver en omgång + en snapshot till databasen.
 *
 * Delad mellan live-capture och arkivimport: arkivraden är ett degenererat
 * specialfall av snapshot (source='archive', captured_at=close_at, odds_*=NULL).
 * Ingen grenlogik nedströms.
 */

type IngestOpts = {
  source: 'live' | 'archive'
  /** Default: nu för live, close_at för archive. */
  capturedAt?: Date
}

export type IngestOutcome =
  | { status: 'inserted'; drawId: number; snapshotId: number; events: number }
  | { status: 'duplicate'; drawId: number }
  | { status: 'skipped'; reason: string }

export async function ingestDraw(
  db: Db,
  product: Product,
  raw: RawDraw,
  opts: IngestOpts,
): Promise<IngestOutcome> {
  const drawNumber = parseDecimal(raw['drawNumber'])
  if (drawNumber === null || !Number.isInteger(drawNumber)) {
    return { status: 'skipped', reason: 'drawNumber saknas' }
  }

  const closeRaw = raw['regCloseTime']
  if (typeof closeRaw !== 'string') {
    return { status: 'skipped', reason: 'regCloseTime saknas' }
  }
  const closeAt = new Date(closeRaw)
  if (Number.isNaN(closeAt.getTime())) {
    return { status: 'skipped', reason: `ogiltig regCloseTime: ${closeRaw}` }
  }

  const openRaw = raw['regOpenTime']
  const openAt =
    typeof openRaw === 'string' && !Number.isNaN(new Date(openRaw).getTime())
      ? new Date(openRaw)
      : null

  const events = raw['drawEvents']
  if (!Array.isArray(events) || events.length === 0) {
    return { status: 'skipped', reason: 'drawEvents saknas' }
  }

  const capturedAt = opts.capturedAt ?? (opts.source === 'archive' ? closeAt : new Date())

  // --- draw (upsert på (product, draw_number)) ---
  const netSaleOre = parseAmountToOre(raw['currentNetSale'])
  const rowPriceOre = parseAmountToOre(raw['rowPrice'])
  const bombenNum = parseDecimal(raw['bombenDrawNum'])

  const existingDraw = await db
    .select({ id: draw.id })
    .from(draw)
    .where(and(eq(draw.product, product), eq(draw.drawNumber, drawNumber)))
    .limit(1)

  let drawId: number
  if (existingDraw.length > 0 && existingDraw[0]) {
    drawId = existingDraw[0].id
    // Omsättningen växer under omgången — uppdatera till senaste värdet.
    await db
      .update(draw)
      .set({
        netSaleOre,
        rowPriceOre: rowPriceOre === null ? null : Number(rowPriceOre),
        bombenDrawNumber: bombenNum === null ? null : Math.trunc(bombenNum),
      })
      .where(eq(draw.id, drawId))
  } else {
    const inserted = await db
      .insert(draw)
      .values({
        product,
        drawNumber,
        openAt,
        closeAt,
        netSaleOre,
        rowPriceOre: rowPriceOre === null ? null : Number(rowPriceOre),
        bombenDrawNumber: bombenNum === null ? null : Math.trunc(bombenNum),
      })
      .returning({ id: draw.id })
    if (!inserted[0]) return { status: 'skipped', reason: 'draw-insert gav inget id' }
    drawId = inserted[0].id
  }

  // --- events (stabil identitet inom omgången) ---
  const existingEvents = await db
    .select({ id: event.id, eventNumber: event.eventNumber })
    .from(event)
    .where(eq(event.drawId, drawId))

  const eventIdByNumber = new Map<number, number>()
  for (const e of existingEvents) eventIdByNumber.set(e.eventNumber, e.id)

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as Record<string, unknown>
    const num = parseDecimal(e['eventNumber'])
    if (num === null || !Number.isInteger(num)) continue
    if (eventIdByNumber.has(num)) continue

    const match = (e['match'] ?? {}) as Record<string, unknown>
    const participants = match['participants']
    let home = ''
    let away = ''
    if (Array.isArray(participants)) {
      for (const p of participants) {
        if (!p || typeof p !== 'object') continue
        const pp = p as Record<string, unknown>
        const name = typeof pp['name'] === 'string' ? pp['name'] : ''
        if (pp['type'] === 'home') home = name
        else if (pp['type'] === 'away') away = name
      }
    }
    // Fallback: "Tottenham - Newcastle"
    if (!home || !away) {
      const desc = e['eventDescription']
      if (typeof desc === 'string' && desc.includes(' - ')) {
        const [h, a] = desc.split(' - ')
        home = home || (h ?? '').trim()
        away = away || (a ?? '').trim()
      }
    }

    const leagueObj = match['league']
    const league =
      leagueObj && typeof leagueObj === 'object'
        ? ((leagueObj as Record<string, unknown>)['name'] as string | undefined) ?? null
        : null

    const ko = match['matchStart']
    const kickoffAt =
      typeof ko === 'string' && !Number.isNaN(new Date(ko).getTime())
        ? new Date(ko)
        : null

    const ins = await db
      .insert(event)
      .values({
        drawId,
        eventNumber: num,
        home: home || 'okänd',
        away: away || 'okänd',
        league,
        kickoffAt,
      })
      .returning({ id: event.id })
    if (ins[0]) eventIdByNumber.set(num, ins[0].id)
  }

  // --- snapshot ---
  const hoursToClose = (closeAt.getTime() - capturedAt.getTime()) / 3_600_000

  let snapshotId: number
  try {
    const ins = await db
      .insert(snapshot)
      .values({
        drawId,
        capturedAt,
        source: opts.source,
        hoursToClose: hoursToClose.toFixed(4),
        raw: raw as Record<string, unknown>,
      })
      .returning({ id: snapshot.id })
    if (!ins[0]) return { status: 'skipped', reason: 'snapshot-insert gav inget id' }
    snapshotId = ins[0].id
  } catch (err) {
    // Unik (draw_id, captured_at) — samma sekund fångad två gånger.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return { status: 'duplicate', drawId }
    }
    throw err
  }

  // --- event_snapshot ---
  let written = 0
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as Record<string, unknown>
    const num = parseDecimal(e['eventNumber'])
    if (num === null) continue
    const eventId = eventIdByNumber.get(num)
    if (eventId === undefined) continue

    const sf = (e['svenskaFolket'] ?? {}) as Record<string, unknown>
    const dist = normaliseDistribution(sf['one'], sf['x'], sf['two'])
    if (!dist) continue // utan streck är raden värdelös för analys

    const odds = (e['odds'] ?? null) as Record<string, unknown> | null
    const startOdds = (e['startOdds'] ?? null) as Record<string, unknown> | null
    const refDist = normaliseDistribution(sf['refOne'], sf['refX'], sf['refTwo'])

    const num8 = (v: number | null) => (v === null ? null : v.toFixed(8))
    const num4 = (v: number | null) => (v === null ? null : v.toFixed(4))

    await db.insert(eventSnapshot).values({
      snapshotId,
      eventId,
      dist1: dist.one.toFixed(8),
      distX: dist.x.toFixed(8),
      dist2: dist.two.toFixed(8),
      odds1: num4(odds ? parseDecimal(odds['one']) : null),
      oddsX: num4(odds ? parseDecimal(odds['x']) : null),
      odds2: num4(odds ? parseDecimal(odds['two']) : null),
      startOdds1: num4(startOdds ? parseDecimal(startOdds['one']) : null),
      startOddsX: num4(startOdds ? parseDecimal(startOdds['x']) : null),
      startOdds2: num4(startOdds ? parseDecimal(startOdds['two']) : null),
      refDist1: num8(refDist?.one ?? null),
      refDistX: num8(refDist?.x ?? null),
      refDist2: num8(refDist?.two ?? null),
    })
    written++
  }

  return { status: 'inserted', drawId, snapshotId, events: written }
}
