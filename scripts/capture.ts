/**
 * Fas 0: snapshot-daemon.
 *
 * Det enda i projektet med verklig deadline. Live-fälten `odds`,
 * `favouriteOdds`, `fund` och streckrörelsen nollställs när omgången avgörs
 * och kan aldrig återskapas. Varje omgång utan capture är permanent förlorad
 * data.
 *
 * Körs av GitHub Actions var 15:e minut (loop i capture.yml). Ingen parsing utöver det som behövs
 * för att kunna fråga senare — rå JSON sparas alltid i snapshot.raw.
 *
 *   npm run capture            # fotboll + trav
 *   npm run capture -- --football-only
 */

import { getDb } from '../src/db/client.ts'
import { PRODUCTS, fetchCurrentDraw } from '../src/lib/svenskaspel.ts'
import { fetchCalendarGames, fetchGame } from '../src/lib/atg.ts'
import { ingestDraw } from '../src/lib/ingest.ts'
import { raceGame, raceSnapshot } from '../src/db/schema.ts'
import { eq } from 'drizzle-orm'

const args = new Set(process.argv.slice(2))
const footballOnly = args.has('--football-only')
const travOnly = args.has('--trav-only')

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

/**
 * Öppna frågan från PRD §9.1: annonseras extrapotten före spelstopp?
 * `fund` är null på både avgjorda och nuvarande öppna omgång, så vi loggar
 * den explicit varje capture för att fånga när/om den dyker upp.
 */
function noteFundFields(product: string, raw: Record<string, unknown>) {
  const fund = raw['fund']
  const extraInfo = raw['extraInfo']
  if (fund !== null && fund !== undefined) {
    log(`  !! ${product}: fund = ${JSON.stringify(fund)} (§9.1 — potten annonserad?)`)
  }
  if (extraInfo !== null && extraInfo !== undefined) {
    log(`  !! ${product}: extraInfo = ${JSON.stringify(extraInfo)}`)
  }
}

async function captureFootball(): Promise<number> {
  const db = getDb()
  let ok = 0
  for (const product of PRODUCTS) {
    try {
      const raw = await fetchCurrentDraw(product)
      if (!raw) {
        log(`${product}: ingen öppen omgång`)
        continue
      }
      noteFundFields(product, raw)
      const res = await ingestDraw(db, product, raw, { source: 'live' })
      if (res.status === 'inserted') {
        log(
          `${product}: omgång ${raw['drawNumber']} → snapshot ${res.snapshotId} (${res.events} matcher)`,
        )
        ok++
      } else if (res.status === 'duplicate') {
        log(`${product}: redan fångad denna sekund`)
      } else {
        log(`${product}: hoppades över — ${res.reason}`)
      }
    } catch (err) {
      // En trasig produkt får inte stoppa den andra.
      log(`${product}: FEL — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return ok
}

async function captureTrav(): Promise<number> {
  const db = getDb()
  let ok = 0
  // Idag och imorgon: spel öppnar dagen innan.
  const dates = [0, 1].map((d) => {
    const dt = new Date()
    dt.setUTCDate(dt.getUTCDate() + d)
    return dt.toISOString().slice(0, 10)
  })

  for (const date of dates) {
    let games
    try {
      games = await fetchCalendarGames(date)
    } catch (err) {
      log(`ATG ${date}: FEL — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (games.length === 0) {
      log(`ATG ${date}: inga spel av följd typ`)
      continue
    }

    for (const g of games) {
      try {
        const raw = await fetchGame(g.gameId)
        if (!raw) continue

        const existing = await db
          .select({ id: raceGame.id })
          .from(raceGame)
          .where(eq(raceGame.gameId, g.gameId))
          .limit(1)

        let gameRowId: number
        if (existing[0]) {
          gameRowId = existing[0].id
        } else {
          const ins = await db
            .insert(raceGame)
            .values({
              gameId: g.gameId,
              poolType: g.poolType,
              raceDate: date,
              startTime:
                g.startTime && !Number.isNaN(new Date(g.startTime).getTime())
                  ? new Date(g.startTime)
                  : null,
            })
            .returning({ id: raceGame.id })
          if (!ins[0]) continue
          gameRowId = ins[0].id
        }

        await db.insert(raceSnapshot).values({
          gameId: gameRowId,
          capturedAt: new Date(),
          raw: raw as Record<string, unknown>,
        })
        log(`ATG ${g.poolType} ${g.gameId}: snapshot sparad`)
        ok++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('duplicate') || msg.includes('unique')) continue
        log(`ATG ${g.gameId}: FEL — ${msg}`)
      }
    }
  }
  return ok
}

async function main() {
  log('capture startar')
  let total = 0
  if (!travOnly) total += await captureFootball()
  if (!footballOnly) total += await captureTrav()
  log(`capture klar — ${total} snapshots skrivna`)
  // Exit 0 även vid 0 snapshots: utanför omgångsfönstret finns inget att fånga,
  // och ett rött cron-jobb varje natt gör att man slutar titta på loggen.
}

main().catch((err) => {
  console.error('capture kraschade:', err)
  process.exit(1)
})
