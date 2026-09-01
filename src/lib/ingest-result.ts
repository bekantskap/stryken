import { eq, and } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { draw, event, result, payoutTier } from '../db/schema.ts'
import type { Product, RawResult } from './svenskaspel.ts'
import { parseAmountToOre, parseOutcome, parseTierName, parseDecimal } from './parse.ts'

/**
 * Skriver facit + utdelningstabell för en avgjord omgång.
 *
 * payout_tier är kalibreringsmålet för medvinnarmodellen (PRD §6.3) — 248
 * omgångar × 4 vinstgrupper ≈ 992 observationer. Skriv aldrig skräp hit.
 *
 * Notera: amount 0 är ett GILTIGT värde och betyder att minimiutdelningsregeln
 * slog till (§6.1), inte att data saknas. Skilj det från null.
 */

export type ResultIngestOutcome =
  | { status: 'inserted'; outcomes: number; tiers: number }
  | { status: 'skipped'; reason: string }

export async function ingestResult(
  db: Db,
  product: Product,
  drawNumber: number,
  raw: RawResult,
): Promise<ResultIngestOutcome> {
  // Inställda omgångar: cancelled=true, tomma outcomes, noll utbetalning.
  // De får ALDRIG in i databasen — nollade payout_tier-rader förorenar
  // α-kalibreringen (en omgång med 0 vinnare på alla grupper är inte en
  // observation av folkets beteende, den är frånvaro av en omgång).
  if (raw['cancelled'] === true) {
    return { status: 'skipped', reason: 'omgången är inställd (cancelled)' }
  }

  const drawRows = await db
    .select({ id: draw.id })
    .from(draw)
    .where(and(eq(draw.product, product), eq(draw.drawNumber, drawNumber)))
    .limit(1)

  const drawRow = drawRows[0]
  if (!drawRow) return { status: 'skipped', reason: 'omgången finns inte i draw' }
  const drawId = drawRow.id

  // Mappa eventNumber → event.id
  const events = await db
    .select({ id: event.id, eventNumber: event.eventNumber })
    .from(event)
    .where(eq(event.drawId, drawId))
  const eventIdByNumber = new Map<number, number>()
  for (const e of events) eventIdByNumber.set(e.eventNumber, e.id)

  // --- facit per match ---
  const rawEvents = raw['events']
  let outcomes = 0
  if (Array.isArray(rawEvents)) {
    for (const ev of rawEvents) {
      if (!ev || typeof ev !== 'object') continue
      const e = ev as Record<string, unknown>
      const num = parseDecimal(e['eventNumber'])
      if (num === null) continue
      const eventId = eventIdByNumber.get(num)
      if (eventId === undefined) continue
      const outcome = parseOutcome(e['outcome'])
      if (!outcome) continue // inställd match e.d.

      try {
        await db.insert(result).values({ drawId, eventId, outcome })
        outcomes++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('duplicate') || msg.includes('unique')) continue
        throw err
      }
    }
  }

  // --- utdelningstabell ---
  const dist = raw['distribution']
  let tiers = 0
  if (Array.isArray(dist)) {
    for (const d of dist) {
      if (!d || typeof d !== 'object') continue
      const t = d as Record<string, unknown>
      const tier = parseTierName(t['name'])
      if (tier === null) continue
      const winners = parseDecimal(t['winners'])
      const amountOre = parseAmountToOre(t['amount'])
      if (winners === null || amountOre === null) continue

      try {
        await db.insert(payoutTier).values({
          drawId,
          tier,
          winners: Math.trunc(winners),
          amountOre,
        })
        tiers++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('duplicate') || msg.includes('unique')) continue
        throw err
      }
    }
  }

  if (outcomes === 0 && tiers === 0) {
    return { status: 'skipped', reason: 'varken facit eller utdelning kunde läsas' }
  }
  return { status: 'inserted', outcomes, tiers }
}

/** Uppdaterar omsättningen från resultatsvaret (mer exakt än sista live-värdet). */
export async function updateNetSaleFromResult(
  db: Db,
  product: Product,
  drawNumber: number,
  raw: RawResult,
): Promise<void> {
  const netSaleOre = parseAmountToOre(raw['currentNetSale'])
  if (netSaleOre === null) return
  await db
    .update(draw)
    .set({ netSaleOre })
    .where(and(eq(draw.product, product), eq(draw.drawNumber, drawNumber)))
}
