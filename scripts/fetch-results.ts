/**
 * Hämtar facit + utdelningstabell för avgjorda omgångar som saknar dem.
 *
 * Fyller en lucka i driften: capture-daemonen hämtar bara ÖPPNA omgångar, så
 * utan detta får omgångar som capturats live aldrig något facit — och då
 * slutar historikloggen (F5) att fungera framåt. Upptäcktes när 4968 saknade
 * facit trots att den avgjorts.
 *
 * Idempotent: hoppar över omgångar som redan har facit.
 *
 *   npm run fetch-results
 *   npm run fetch-results -- --product europatipset
 */

import { getDb } from '../src/db/client.ts'
import { draw, result, payoutTier } from '../src/db/schema.ts'
import { eq, and, lt, sql as rawSql, notExists } from 'drizzle-orm'
import { PRODUCTS, fetchResult, type Product } from '../src/lib/svenskaspel.ts'
import { ingestResult, updateNetSaleFromResult } from '../src/lib/ingest-result.ts'

function parseArgs() {
  const a = process.argv.slice(2)
  const i = a.indexOf('--product')
  const p = i >= 0 ? a[i + 1] : undefined
  return { products: p ? [p as Product] : [...PRODUCTS] }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(product: Product) {
  const db = getDb()

  // Avgjorda omgångar (spelstopp passerat) som saknar facit.
  const pending = await db
    .select({ id: draw.id, drawNumber: draw.drawNumber, closeAt: draw.closeAt })
    .from(draw)
    .where(
      and(
        eq(draw.product, product),
        lt(draw.closeAt, new Date()),
        notExists(
          db.select({ x: rawSql`1` }).from(result).where(eq(result.drawId, draw.id)),
        ),
      ),
    )
    .orderBy(draw.drawNumber)

  if (pending.length === 0) {
    console.log(`${product}: alla avgjorda omgångar har redan facit`)
    return
  }

  console.log(`${product}: ${pending.length} omgångar saknar facit`)

  let ok = 0
  let notReady = 0
  for (const d of pending) {
    try {
      const res = await fetchResult(product, d.drawNumber)
      if (!res) {
        notReady++
        console.log(`  #${d.drawNumber}: facit inte publicerat än`)
        continue
      }
      await updateNetSaleFromResult(db, product, d.drawNumber, res)
      const r = await ingestResult(db, product, d.drawNumber, res)
      if (r.status === 'inserted') {
        console.log(`  #${d.drawNumber}: ${r.outcomes} matcher, ${r.tiers} vinstgrupper`)
        ok++
      } else {
        console.log(`  #${d.drawNumber}: ${r.reason}`)
      }
      await sleep(250)
    } catch (err) {
      console.log(`  #${d.drawNumber}: FEL — ${err instanceof Error ? err.message : String(err)}`)
      await sleep(1000)
    }
  }
  console.log(`${product}: ${ok} hämtade, ${notReady} väntar på publicering`)
}

async function main() {
  for (const p of parseArgs().products) await run(p)
}

main().catch((err) => {
  console.error('fetch-results kraschade:', err)
  process.exit(1)
})
