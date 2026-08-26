/**
 * Fas 1a: arkivimport.
 *
 * Hämtar historiska omgångar med öppningsodds + slutstreck + facit + verkliga
 * utdelningstabeller. Odds finns från omgång 4720 (2021-12-18) — före det
 * nollställs startOdds också, så äldre omgångar duger bara till streckanalys.
 *
 *   npm run import-archive                       # 4720..senaste avgjorda
 *   npm run import-archive -- --from 4900 --to 4967
 *   npm run import-archive -- --product europatipset
 *   npm run import-archive -- --dry              # skriv inget, visa bara
 */

import { getDb } from '../src/db/client.ts'
import {
  PRODUCTS,
  fetchDraw,
  fetchResult,
  fetchCurrentDraw,
  type Product,
} from '../src/lib/svenskaspel.ts'
import { ingestDraw } from '../src/lib/ingest.ts'
import { ingestResult, updateNetSaleFromResult } from '../src/lib/ingest-result.ts'
import { parseDecimal } from '../src/lib/parse.ts'

/**
 * Första omgången med bevarade startOdds, verifierat med binärsökning
 * 2026-08-26:
 *   stryktipset  4720 (2021-12-18) — 4719 saknar odds  →  ~248 omgångar
 *   europatipset 2051 (2021-04-07) — 2050 saknar odds  →  ~551 omgångar
 *
 * Europatipset ger fler observationer eftersom det spelas ons+sön.
 * Tillsammans ~799 omgångar till backtesten.
 */
const FIRST_DRAW_WITH_ODDS = { stryktipset: 4720, europatipset: 2051 } as const

function parseArgs() {
  const a = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag)
    return i >= 0 ? a[i + 1] : undefined
  }
  const products = get('--product')
  return {
    from: get('--from') ? Number(get('--from')) : undefined,
    to: get('--to') ? Number(get('--to')) : undefined,
    dry: a.includes('--dry'),
    products: products ? [products as Product] : [...PRODUCTS],
    /** Paus mellan anrop (ms). Låg frekvens är mitigeringen mot blockering. */
    delay: get('--delay') ? Number(get('--delay')) : 250,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function log(msg: string) {
  console.log(msg)
}

/**
 * Hittar senaste avgjorda omgång: den öppna omgångens nummer minus 1.
 */
async function findLatestSettled(product: Product): Promise<number | null> {
  const open = await fetchCurrentDraw(product)
  if (!open) return null
  const n = parseDecimal(open['drawNumber'])
  return n === null ? null : Math.trunc(n) - 1
}

async function importProduct(product: Product, opts: ReturnType<typeof parseArgs>) {
  const db = opts.dry ? null : getDb()

  const first = FIRST_DRAW_WITH_ODDS[product]
  const from = opts.from ?? first
  let to = opts.to
  if (to === undefined) {
    const latest = await findLatestSettled(product)
    if (latest === null) {
      log(`${product}: kunde inte avgöra senaste avgjorda omgång — ange --to`)
      return
    }
    to = latest
  }

  if (from < first) {
    log(
      `${product}: OBS — omgångar före ${first} saknar odds. ` +
        `Importerar från ${from} ändå, men de raderna duger bara till streckanalys.`,
    )
  }

  log(`\n═══ ${product} ${from}..${to} (${to - from + 1} omgångar) ═══`)

  let okDraw = 0
  let okResult = 0
  let missing = 0
  let noOdds = 0
  let failed = 0

  for (let n = from; n <= to; n++) {
    try {
      const raw = await fetchDraw(product, n)
      if (!raw) {
        missing++
        continue
      }

      // Hur många matcher har bevarade startOdds? Avgör om raden duger till backtest.
      const events = Array.isArray(raw['drawEvents']) ? raw['drawEvents'] : []
      const withOdds = events.filter(
        (e) => e && typeof e === 'object' && (e as Record<string, unknown>)['startOdds'],
      ).length
      if (withOdds === 0) noOdds++

      const res = await fetchResult(product, n)

      if (opts.dry) {
        const tiers = res && Array.isArray(res['distribution']) ? res['distribution'].length : 0
        log(
          `  ${n}: ${events.length} matcher, ${withOdds} med odds, ` +
            `facit ${res ? 'ja' : 'NEJ'}, ${tiers} vinstgrupper`,
        )
      } else if (db) {
        const ing = await ingestDraw(db, product, raw, { source: 'archive' })
        if (ing.status === 'inserted') okDraw++
        else if (ing.status === 'duplicate') okDraw++ // redan importerad

        if (res) {
          await updateNetSaleFromResult(db, product, n, res)
          const r = await ingestResult(db, product, n, res)
          if (r.status === 'inserted') okResult++
        }
      }

      if ((n - from + 1) % 25 === 0) {
        log(
          `  ...${n} (${okDraw} omgångar, ${okResult} facit, ${missing} saknas, ${noOdds} utan odds)`,
        )
      }
      await sleep(opts.delay)
    } catch (err) {
      failed++
      log(`  ${n}: FEL — ${err instanceof Error ? err.message : String(err)}`)
      // Backa av vid fel — kan vara rate limiting.
      await sleep(opts.delay * 4)
    }
  }

  log(
    `\n  ${product}: ${okDraw} omgångar, ${okResult} med facit, ` +
      `${missing} saknades, ${noOdds} utan odds, ${failed} fel`,
  )
}

async function main() {
  const opts = parseArgs()
  if (opts.dry) log('TORRKÖRNING — inget skrivs till databas\n')

  for (const product of opts.products) {
    await importProduct(product, opts)
  }
  log('\nimport klar')
}

main().catch((err) => {
  console.error('import-archive kraschade:', err)
  process.exit(1)
})
