/**
 * Klient mot The Odds API — oberoende, skarpa marknadsodds.
 *
 * Varför detta finns: Svenska Spels egna odds kan inte användas för att
 * utvärdera Svenska Spel (cirkulärt). För att mäta om deras linje avviker
 * systematiskt behövs en oberoende källa. Börser (Betfair, Matchbook) ligger
 * på 0,5–1,5 % marginal och Pinnacle på ~3,4 %, mot Svenska Spels ~5,6 %.
 *
 * ⚠ MATCHNING ÄR DEN FARLIGA DELEN.
 *
 * API:t returnerar matcher från flera omgångar samtidigt. En slarvig
 * namnmatchning parade "Millwall–Bolton" (5 sep) med "Millwall–Wrexham"
 * (2 sep) och gav en falsk avvikelse på 18,7 procentenheter — vilket ser ut
 * som en gigantisk edge. Matchning kräver därför BÅDE lagnamn OCH att
 * avsparkstiden ligger nära.
 *
 * Gratisnivån ger 500 anrop/månad. Ett anrop per liga returnerar alla dess
 * matcher, så ~4–6 anrop täcker en omgång.
 */

const BASE = 'https://api.the-odds-api.com/v4'

/** Ligor som förekommer i Stryktipset/Europatipset, med API-nycklar. */
export const LEAGUE_KEYS: Record<string, string> = {
  'Premier League': 'soccer_epl',
  Championship: 'soccer_efl_champ',
  'League One': 'soccer_england_league1',
  'League Two': 'soccer_england_league2',
  Allsvenskan: 'soccer_sweden_allsvenskan',
  Superettan: 'soccer_sweden_superettan',
  Eliteserien: 'soccer_norway_eliteserien',
  'Champions League': 'soccer_uefa_champs_league',
  'Europa League': 'soccer_uefa_europa_league',
  'Conference League': 'soccer_uefa_europa_conference_league',
}

/**
 * Bookmakers i preferensordning: lägst marginal först.
 * Börser är nära marginalfria och därmed bästa sannolikhetsskattningen.
 */
export const PREFERRED_BOOKS = [
  'betfair_ex_eu',
  'matchbook',
  'pinnacle',
  'betonlineag',
  'leovegas_se',
  'nordicbet',
] as const

export type SharpOdds = {
  home: string
  away: string
  commenceAt: Date
  one: number
  x: number
  two: number
  book: string
  overround: number
}

export class OddsApiError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'OddsApiError'
    this.status = status
  }
}

export type Quota = { remaining: number | null; used: number | null }

/** Hämtar odds för en liga. Returnerar även kvotinformation. */
export async function fetchLeagueOdds(
  leagueKey: string,
  apiKey: string,
): Promise<{ odds: SharpOdds[]; quota: Quota }> {
  const url = `${BASE}/sports/${leagueKey}/odds/?apiKey=${apiKey}&regions=eu,uk&markets=h2h&oddsFormat=decimal`
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })

  const quota: Quota = {
    remaining: Number(res.headers.get('x-requests-remaining')) || null,
    used: Number(res.headers.get('x-requests-used')) || null,
  }

  if (!res.ok) {
    throw new OddsApiError(`HTTP ${res.status} för ${leagueKey}`, res.status)
  }

  const games = (await res.json()) as unknown
  if (!Array.isArray(games)) return { odds: [], quota }

  const out: SharpOdds[] = []
  for (const g of games) {
    if (!g || typeof g !== 'object') continue
    const game = g as Record<string, unknown>
    const home = typeof game['home_team'] === 'string' ? game['home_team'] : null
    const away = typeof game['away_team'] === 'string' ? game['away_team'] : null
    const commence = typeof game['commence_time'] === 'string' ? game['commence_time'] : null
    if (!home || !away || !commence) continue
    const commenceAt = new Date(commence)
    if (Number.isNaN(commenceAt.getTime())) continue

    const books = Array.isArray(game['bookmakers']) ? game['bookmakers'] : []
    let chosen: SharpOdds | null = null

    for (const wanted of PREFERRED_BOOKS) {
      const b = books.find(
        (x) => x && typeof x === 'object' && (x as Record<string, unknown>)['key'] === wanted,
      ) as Record<string, unknown> | undefined
      if (!b) continue
      const markets = Array.isArray(b['markets']) ? b['markets'] : []
      const h2h = markets.find(
        (m) => m && typeof m === 'object' && (m as Record<string, unknown>)['key'] === 'h2h',
      ) as Record<string, unknown> | undefined
      if (!h2h) continue
      const outcomes = Array.isArray(h2h['outcomes']) ? h2h['outcomes'] : []

      let o1: number | null = null
      let oX: number | null = null
      let o2: number | null = null
      for (const oc of outcomes) {
        if (!oc || typeof oc !== 'object') continue
        const out2 = oc as Record<string, unknown>
        const name = out2['name']
        const price = typeof out2['price'] === 'number' ? out2['price'] : null
        if (price === null || price <= 1) continue
        if (name === home) o1 = price
        else if (name === away) o2 = price
        else oX = price
      }
      if (o1 === null || oX === null || o2 === null) continue

      // AVVISA TOMMA BÖRSMARKNADER.
      //
      // Betfair/Matchbook har ofta ingen likviditet i lägre ligor dagar i
      // förväg och returnerar då platshållare — verifierat 3,00/3,00/3,00
      // för Millwall–Bolton, vilket gav 28 pp falsk "avvikelse" mot
      // Svenska Spel. Ett äkta 1X2-odds har aldrig alla tre lika, och
      // marginalen kan inte vara negativ.
      const or = 1 / o1 + 1 / oX + 1 / o2
      const allEqual = o1 === oX && oX === o2
      if (allEqual) continue
      // Marginal under 0,2 % är orimligt även för en börs — tyder på
      // ofullständig orderbok. Över 25 % är trasig data.
      if (or < 1.002 || or > 1.25) continue
      // Kryss på 1X2 ligger i praktiken alltid mellan 2,5 och 8. Ett
      // kryssodds långt utanför betyder att marknaden inte är satt.
      if (oX < 2.2 || oX > 12) continue

      chosen = {
        home,
        away,
        commenceAt,
        one: o1,
        x: oX,
        two: o2,
        book: wanted,
        overround: or,
      }
      break
    }

    if (chosen) out.push(chosen)
  }

  return { odds: out, quota }
}

/** Normaliserar lagnamn för jämförelse. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sk|if|bk|ff)\b/g, '')
    .replace(/[^a-z]/g, '')
}

/**
 * Vanliga förkortningar Svenska Spel använder. Deras namn är trunkerade
 * ("Sheff U", "Queens Park Rangers" vs "Sheffield United").
 */
const ALIASES: Record<string, string> = {
  sheffu: 'sheffieldunited',
  sheffw: 'sheffieldwednesday',
  manutd: 'manchesterunited',
  mancity: 'manchestercity',
  qpr: 'queensparkrangers',
  westbrom: 'westbromwichalbion',
  westbromwich: 'westbromwichalbion',
  nottingham: 'nottinghamforest',
  wolves: 'wolverhamptonwanderers',
  bournemou: 'afcbournemouth',
  southampt: 'southampton',
  huddersfi: 'huddersfieldtown',
  middlesbr: 'middlesbrough',
  portsmout: 'portsmouth',
  peterboro: 'peterboroughunited',
}

function canon(s: string): string {
  const n = norm(s)
  return ALIASES[n] ?? n
}

/** Matchar två lagnamn: prefix-överlapp åt båda håll. */
function sameTeam(a: string, b: string): boolean {
  const x = canon(a)
  const y = canon(b)
  if (x === y) return true
  if (x.length >= 5 && y.startsWith(x)) return true
  if (y.length >= 5 && x.startsWith(y)) return true
  // Svenska Spel trunkerar ofta till 9 tecken.
  const p = Math.min(x.length, y.length, 8)
  return p >= 6 && x.slice(0, p) === y.slice(0, p)
}

/**
 * Hittar matchande odds för en match.
 *
 * Kräver BÅDE lagnamn OCH avspark inom `maxHoursApart`. Utan tidskravet
 * matchas fel omgångs möte mellan samma lag — verifierat fel som gav
 * 18,7 pp falsk avvikelse.
 */
export function matchGame(
  home: string,
  away: string,
  kickoffAt: Date | null,
  pool: readonly SharpOdds[],
  maxHoursApart = 12,
): SharpOdds | null {
  const candidates = pool.filter((p) => sameTeam(p.home, home) && sameTeam(p.away, away))
  if (candidates.length === 0) return null
  if (!kickoffAt) {
    // Utan avsparkstid kan vi inte skilja omgångar — vägra hellre än gissa.
    return candidates.length === 1 ? candidates[0]! : null
  }
  const withinWindow = candidates.filter(
    (c) => Math.abs(c.commenceAt.getTime() - kickoffAt.getTime()) / 3_600_000 <= maxHoursApart,
  )
  if (withinWindow.length === 0) return null
  // Närmast i tid vinner.
  return withinWindow.reduce((a, b) =>
    Math.abs(a.commenceAt.getTime() - kickoffAt.getTime()) <
    Math.abs(b.commenceAt.getTime() - kickoffAt.getTime())
      ? a
      : b,
  )
}

/** Marginalrensade sannolikheter ur skarpa odds. */
export function sharpProbabilities(s: SharpOdds): { one: number; x: number; two: number } {
  const r1 = 1 / s.one
  const rx = 1 / s.x
  const r2 = 1 / s.two
  const sum = r1 + rx + r2
  return { one: r1 / sum, x: rx / sum, two: r2 / sum }
}
