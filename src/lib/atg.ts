/**
 * Klient mot ATG:s racinginfo-API (öppet, ingen nyckel).
 *
 * Verifierat 2026-08-26:
 *  - /calendar/day/{YYYY-MM-DD} → dagens spel, nycklade på pooltyp
 *  - /games/{gameId}            → startlistor med barfota/sulky/spår,
 *                                 betDistribution och vinnarodds per start
 *
 * Två saker att inte snubbla på:
 *  1. Pooltyperna roterar mellan dagar (V75/V85/V65/V64/V5/V4...). Hårdkoda
 *     aldrig V75 — kalendern avgör vad som finns.
 *  2. Nativa heltalsskalor: vinnarodds i hundradelar (989 = 9,89x),
 *     betDistribution i hundradelar av procent (404 = 4,04 %) — summerar till
 *     10000 per lopp, verifierat i V85/V86/V5/V4. Lagras okonverterade.
 */

/** betDistribution → procent. 404 → 4.04 */
export function betDistToPercent(bps: number): number {
  return bps / 100
}

/** vinnarodds → decimalodds. 989 → 9.89 */
export function winOddsToDecimal(hundredths: number): number {
  return hundredths / 100
}

const BASE = 'https://www.atg.se/services/racinginfo/v1/api'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** Pooltyper vi bryr oss om — de med streckprocent värd att analysera. */
export const TRACKED_POOL_TYPES = ['V75', 'V86', 'V85', 'V65', 'V64', 'V5', 'V4'] as const

export class AtgError extends Error {
  // Explicita fält i stället för parameteregenskaper: Nodes type-stripping
  // (--experimental-strip-types) stödjer inte `constructor(readonly x)`.
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AtgError'
    this.status = status
  }
}

async function fetchJson(url: string, timeoutMs = 25_000): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    })
    if (!res.ok) throw new AtgError(`HTTP ${res.status}`, res.status)
    return await res.json()
  } catch (err) {
    if (err instanceof AtgError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new AtgError(`fetch misslyckades: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

export type CalendarGame = { gameId: string; poolType: string; startTime?: string }

/**
 * Listar spel för ett datum, filtrerat på pooltyper vi följer.
 * Datum som 'YYYY-MM-DD'.
 */
export async function fetchCalendarGames(date: string): Promise<CalendarGame[]> {
  const payload = await fetchJson(`${BASE}/calendar/day/${date}`)
  if (!payload || typeof payload !== 'object') return []
  const games = (payload as Record<string, unknown>)['games']
  if (!games || typeof games !== 'object') return []

  const out: CalendarGame[] = []
  for (const [poolType, entries] of Object.entries(games as Record<string, unknown>)) {
    if (!TRACKED_POOL_TYPES.includes(poolType as never)) continue
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const id = (e as Record<string, unknown>)['id']
      if (typeof id !== 'string') continue
      const st = (e as Record<string, unknown>)['startTime']
      out.push({
        gameId: id,
        poolType,
        startTime: typeof st === 'string' ? st : undefined,
      })
    }
  }
  return out
}

/** Hämtar komplett startlista för ett spel. */
export async function fetchGame(gameId: string): Promise<Record<string, unknown> | null> {
  try {
    const payload = await fetchJson(`${BASE}/games/${gameId}`)
    if (!payload || typeof payload !== 'object') return null
    return payload as Record<string, unknown>
  } catch (err) {
    if (err instanceof AtgError && (err.status === 404 || err.status === 500)) return null
    throw err
  }
}
