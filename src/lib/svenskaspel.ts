/**
 * Klient mot Svenska Spels publika (inofficiella) API.
 *
 * Abstraktionslager enligt PRD §5: API:t är odokumenterat och kan ändras utan
 * förvarning, så all kunskap om dess form bor här.
 *
 * Verifierat 2026-08-26:
 *  - /draw/1/{produkt}/draws          → öppen omgång
 *  - /draw/1/{produkt}/draws/{n}      → historisk omgång (tillbaka till #4267)
 *  - /draw/1/{produkt}/draws/{n}/result → facit + utdelningstabell
 *
 * Både stryktipset och europatipset ligger på /draw/1/ trots olika productId.
 */

export const PRODUCTS = ['stryktipset', 'europatipset'] as const
export type Product = (typeof PRODUCTS)[number]

const BASE = 'https://api.www.svenskaspel.se/draw/1'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export class SvenskaSpelError extends Error {
  // Explicita fält i stället för parameteregenskaper: Nodes type-stripping
  // (--experimental-strip-types) stödjer inte `constructor(readonly x)`.
  readonly status: number | undefined
  readonly url: string | undefined

  constructor(message: string, status?: number, url?: string) {
    super(message)
    this.name = 'SvenskaSpelError'
    this.status = status
    this.url = url
  }
}

async function fetchJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    })
    if (!res.ok) {
      throw new SvenskaSpelError(`HTTP ${res.status}`, res.status, url)
    }
    return await res.json()
  } catch (err) {
    if (err instanceof SvenskaSpelError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new SvenskaSpelError(`fetch misslyckades: ${msg}`, undefined, url)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retry med exponentiell backoff. Låg frekvens och backoff är mitigeringen mot
 * rate limiting (PRD §8) — vi vill inte bli blockerade från en gratis källa.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // 404 betyder att omgången inte finns — ingen idé att försöka igen.
      if (err instanceof SvenskaSpelError && err.status === 404) throw err
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i))
      }
    }
  }
  throw lastErr
}

/** Rå omgångsdata, oparsad. Formen dokumenteras av användningen. */
export type RawDraw = Record<string, unknown>

/**
 * Plockar ut omgången ur svaret. Öppna omgångar kommer som {draws:[...]},
 * historiska ibland som {draw:{...}} — normalisera här, en gång.
 */
function extractDraw(payload: unknown): RawDraw | null {
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  if (obj['draw'] && typeof obj['draw'] === 'object') {
    return obj['draw'] as RawDraw
  }
  const draws = obj['draws']
  if (Array.isArray(draws) && draws.length > 0 && typeof draws[0] === 'object') {
    return draws[0] as RawDraw
  }
  return null
}

/** Hämtar aktuell öppen omgång. Null om ingen är öppen. */
export async function fetchCurrentDraw(product: Product): Promise<RawDraw | null> {
  const payload = await withRetry(() => fetchJson(`${BASE}/${product}/draws`))
  return extractDraw(payload)
}

/** Hämtar en specifik omgång. Null om den inte finns (404). */
export async function fetchDraw(
  product: Product,
  drawNumber: number,
): Promise<RawDraw | null> {
  try {
    const payload = await withRetry(() =>
      fetchJson(`${BASE}/${product}/draws/${drawNumber}`),
    )
    return extractDraw(payload)
  } catch (err) {
    if (err instanceof SvenskaSpelError && err.status === 404) return null
    throw err
  }
}

export type RawResult = Record<string, unknown>

/**
 * Hämtar facit + utdelningstabell. Null om omgången inte är avgjord.
 * Notera: API:t svarar 200 med tomt result för oavgjorda omgångar.
 */
export async function fetchResult(
  product: Product,
  drawNumber: number,
): Promise<RawResult | null> {
  try {
    const payload = await withRetry(() =>
      fetchJson(`${BASE}/${product}/draws/${drawNumber}/result`),
    )
    if (!payload || typeof payload !== 'object') return null
    const r = (payload as Record<string, unknown>)['result']
    if (!r || typeof r !== 'object') return null
    const res = r as RawResult
    // Oavgjord omgång: inga events eller tom distribution.
    const events = res['events']
    if (!Array.isArray(events) || events.length === 0) return null
    return res
  } catch (err) {
    if (err instanceof SvenskaSpelError && err.status === 404) return null
    // 500 förekommer på vissa omgångar — behandla som "saknas", inte som krasch.
    if (err instanceof SvenskaSpelError && err.status === 500) return null
    throw err
  }
}
