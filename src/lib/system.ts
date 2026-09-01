import type { SignProbs } from './payout.ts'

/**
 * Systemgenerator: väljer garderingar för en omgång.
 *
 * VIKTIGT om vad detta är och inte är:
 *
 * Backtesten (PRD §12) visade ingen edge i radurval — trimmad ROI −94 till
 * −98 % vid alla testade trösklar. Denna modul påstår därför INTE att dess
 * urval är lönsamt. Vad den gör är att lösa ett konkret praktiskt problem:
 * givet att du ska lämna in ett system på N rader, vilka garderingar ger
 * högst sannolikhet att träffa enligt marknadsodds?
 *
 * Det är en bättre utgångspunkt än att gissa för hand, men det är inte en
 * vinstmaskin.
 *
 * Ett riktigt Stryktipset-system är en uppsättning garderingar per match
 * (spik / halvgardering / helgardering), inte en fri radlista — det är vad
 * man faktiskt lämnar in hos ombud eller i appen. Antalet rader är därför
 * produkten av garderingarna: 3^hel × 2^halv.
 */

export type Coverage = 1 | 2 | 3
export type Sign = '1' | 'X' | '2'

/** Garderingen för en match: vilka tecken som ingår. */
export type MatchPick = {
  eventNumber: number
  label: string
  signs: Sign[]
  /** Marknadssannolikhet för de valda tecknen tillsammans. */
  coveredProb: number
  /** Folkets streckprocent för de valda tecknen. */
  crowdProb: number
}

export type SystemSuggestion = {
  picks: MatchPick[]
  rows: number
  /** Sannolikhet att systemet innehåller den rätta raden (13 rätt). */
  prob13: number
  /** Förväntat antal rätt för systemets bästa rad. */
  expectedCorrect: number
  costOre: number
}

/** Giltiga systemstorlekar: 3^hel × 2^halv över 13 matcher. */
export function validSystemSizes(maxRows = 1200): number[] {
  const out = new Set<number>()
  for (let h = 0; h <= 13; h++) {
    for (let v = 0; v + h <= 13; v++) {
      const n = 3 ** h * 2 ** v
      if (n <= maxRows) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function probFor(p: SignProbs, s: Sign): number {
  return s === '1' ? p.one : s === 'X' ? p.x : p.two
}

/** Tecken sorterade efter marknadssannolikhet, mest sannolikt först. */
function rankedSigns(p: SignProbs): Sign[] {
  return (['1', 'X', '2'] as Sign[]).sort((a, b) => probFor(p, b) - probFor(p, a))
}

/**
 * Väljer den garderingskombination som maximerar sannolikheten att systemet
 * innehåller den rätta raden, inom budgeten `targetRows`.
 */
export function suggestSystem(
  matches: { eventNumber: number; label: string; model: SignProbs; crowd: SignProbs }[],
  targetRows: number,
  rowPriceOre: number,
): SystemSuggestion {
  // UTTÖMMANDE sökning, inte heuristik.
  //
  // En girig algoritm ger mätbart sämre system här. Testad mot omgång 4969
  // med 48 rader: girig gav 0,15 % träffchans (10 spikar + 3 helgarderingar),
  // uttömmande gav 0,240 % (8 spikar + 4 halvgarderingar + 1 helgardering) —
  // 60 % bättre. Girigheten fastnar i att helgardera redan påbörjade matcher
  // (kostar ×1,5) i stället för att halvgardera nya (kostar ×2).
  //
  // Sökrymden är 3^13 men beskärs hårt av radbudgeten, så detta är billigt.
  const n = matches.length
  // Förberäkna kumulativ täckt sannolikhet per match och garderingsnivå.
  const cumProb: number[][] = matches.map((m) => {
    const ranked = rankedSigns(m.model)
    const out: number[] = []
    let acc = 0
    for (const s of ranked) {
      acc += probFor(m.model, s)
      out.push(acc)
    }
    return out
  })

  let bestProb = -1
  let bestCov: Coverage[] = matches.map(() => 1)
  const cov: Coverage[] = new Array(n).fill(1) as Coverage[]

  const search = (i: number, rowsUsed: number, prob: number): void => {
    if (i === n) {
      if (prob > bestProb) {
        bestProb = prob
        bestCov = [...cov]
      }
      return
    }
    for (const c of [1, 2, 3] as const) {
      const rows = rowsUsed * c
      if (rows > targetRows) continue
      cov[i] = c
      search(i + 1, rows, prob * cumProb[i]![c - 1]!)
    }
    cov[i] = 1
  }
  search(0, 1, 1)

  const coverage = bestCov

  const picks: MatchPick[] = matches.map((m, i) => {
    const ranked = rankedSigns(m.model)
    const signs = ranked.slice(0, coverage[i]!)
    // Behåll spelordningen 1, X, 2 för läsbarhet.
    const ordered = (['1', 'X', '2'] as Sign[]).filter((s) => signs.includes(s))
    return {
      eventNumber: m.eventNumber,
      label: m.label,
      signs: ordered,
      coveredProb: ordered.reduce((a, s) => a + probFor(m.model, s), 0),
      crowdProb: ordered.reduce((a, s) => a + probFor(m.crowd, s), 0),
    }
  })

  const prob13 = picks.reduce((a, p) => a * p.coveredProb, 1)
  const expectedCorrect = picks.reduce((a, p) => a + p.coveredProb, 0)
  const rows = coverage.reduce<number>((a, b) => a * b, 1)

  return { picks, rows, prob13, expectedCorrect, costOre: rows * rowPriceOre }
}

/**
 * Trösklar för "ovanligt stor streckrörelse", i procentenheter.
 *
 * Uppmätt över 78 teckenrörelser i 6 omgångar (2026-09-01):
 *   median 3,0 pp · p75 5,0 · p90 12,0 · p95 16,0 · max 21,0
 *
 * En rörelse ≥8 pp ligger alltså i toppdecilerna och ≥12 pp i topp 10 %.
 * Stora rörelser betyder ofta att ny information kommit in (laguppställning,
 * skada) — värt att titta på innan man spikar emot.
 */
export const MOVE_NOTABLE_PP = 8
export const MOVE_STRONG_PP = 12

export type MoveFlag = { sign: Sign; deltaPp: number; strong: boolean }

/**
 * Är streckfördelningen degenererad, dvs. inte en meningsfull fördelning?
 *
 * Precis när en omgång öppnar har så få spelat att Svenska Spel rapporterar
 * skräp — verifierat på europatipset #2604, första snapshot 71 h före
 * spelstopp: match 7 visade 100/0/0 och match 13 visade 50/47/3. Nästa
 * snapshot 2,4 h senare gav realistiska 57/21/22 respektive 17/24/59.
 *
 * Att jämföra mot sådan data ger falska rörelser på 30–54 pp. Verkliga
 * rörelser ligger på median 3 pp (p90 = 12).
 */
export function isDegenerateDistribution(d: SignProbs): boolean {
  // Ett tecken tar nästan allt, eller något tecken är exakt noll.
  if (d.one >= 0.95 || d.x >= 0.95 || d.two >= 0.95) return true
  if (d.one === 0 || d.x === 0 || d.two === 0) return true
  return false
}

/** Största streckrörelsen för en match, om den överstiger tröskeln. */
export function biggestMove(
  opening: SignProbs | undefined,
  current: SignProbs,
): MoveFlag | null {
  if (!opening) return null
  // Skräpdata vid omgångens öppning ger falska rörelser — hoppa över.
  if (isDegenerateDistribution(opening)) return null
  const deltas: { sign: Sign; d: number }[] = [
    { sign: '1', d: (current.one - opening.one) * 100 },
    { sign: 'X', d: (current.x - opening.x) * 100 },
    { sign: '2', d: (current.two - opening.two) * 100 },
  ]
  const top = deltas.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a))
  if (Math.abs(top.d) < MOVE_NOTABLE_PP) return null
  return { sign: top.sign, deltaPp: top.d, strong: Math.abs(top.d) >= MOVE_STRONG_PP }
}

/** Expanderar garderingarna till alla rader, i spelordning. */
export function expandRows(picks: MatchPick[]): Sign[][] {
  let rows: Sign[][] = [[]]
  for (const p of picks) {
    const next: Sign[][] = []
    for (const r of rows) for (const s of p.signs) next.push([...r, s])
    rows = next
  }
  return rows
}
