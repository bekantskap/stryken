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
 * Endast Stryktipset capturas (CAPTURE_PRODUCTS). Trav-capturen är borttagen:
 * rå ATG-payload fyllde Neons 512 MB-tak (467 MB i race_snapshot) och stoppade
 * all skrivning inklusive fotbollen 2026-09-16. V75-spåret var aldrig påbörjat.
 * Tabellerna race_* finns kvar i schemat om det återupptas.
 *
 *   npm run capture
 */

import { sql } from 'drizzle-orm'

import { getDb } from '../src/db/client.ts'
import { CAPTURE_PRODUCTS, fetchCurrentDraw } from '../src/lib/svenskaspel.ts'
import { ingestDraw } from '../src/lib/ingest.ts'

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
  for (const product of CAPTURE_PRODUCTS) {
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

/**
 * Neon free tier tar slut vid 512 MB, och då failar varje insert tyst —
 * jobbet loggar "0 snapshots skrivna" och exitar 0. Det pågick 2026-09-16
 * till 09-23 innan någon märkte det. Exit 1 vid fullt tak: hellre ett rött
 * jobb än en vecka förlorad live-data.
 */
const SIZE_LIMIT_MB = 512
const WARN_AT_MB = 450

async function checkDiskBudget(): Promise<boolean> {
  try {
    const r = await getDb().execute(
      sql`select pg_database_size(current_database()) / 1024 / 1024 as mb`,
    )
    const mb = Number((r as unknown as { rows?: { mb: unknown }[] }).rows?.[0]?.mb ?? 0)
    if (!mb) return true
    if (mb >= WARN_AT_MB) {
      log(`!! databasen är ${mb} MB av ${SIZE_LIMIT_MB} MB — inserts failar snart`)
      return false
    }
    log(`databas ${mb} MB / ${SIZE_LIMIT_MB} MB`)
    return true
  } catch (err) {
    // Vakten får inte vara det som stoppar en capture.
    log(`diskkoll misslyckades (fortsätter): ${err instanceof Error ? err.message : String(err)}`)
    return true
  }
}

async function main() {
  log('capture startar')
  const roomy = await checkDiskBudget()
  const total = await captureFootball()
  log(`capture klar — ${total} snapshots skrivna`)
  if (!roomy) {
    // Exit 2 är kontraktet mot capture.yml: avbryt hela loopjobbet rött.
    log('AVBRYTER RÖTT: diskutrymmet är slut, capture skriver inget förrän det rensas')
    process.exit(2)
  }
  // Exit 0 även vid 0 snapshots: utanför omgångsfönstret finns inget att fånga,
  // och ett rött cron-jobb varje natt gör att man slutar titta på loggen.
}

main().catch((err) => {
  console.error('capture kraschade:', err)
  process.exit(1)
})
