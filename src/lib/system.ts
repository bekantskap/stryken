import { signWeights, expectedInverseWinners, TIER_SHARE, type SignProbs } from './payout.ts'

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

/**
 * 'traff'     — max sannolikhet att systemet innehåller rätt rad.
 * 'utdelning' — max förväntad 13-utdelning, men med högst 10 % lägre
 *               träffchans än 'traff'. Väljer mindre streckade tecken så att
 *               potten delas med färre. Gör förväntad avkastning mindre
 *               negativ, inte positiv (backtesten, PRD §12).
 */
export type Mode = 'traff' | 'utdelning'

/**
 * Golvet håller utdelningsläget nära favoriterna. α-modellen underskattar
 * medvinnare kraftigt på extrema skrällrader (se topEvRowsConstrained), så
 * fri EV-optimering skulle jaga just de rader där modellen har mest fel.
 */
export const PAYOUT_MODE_HIT_FLOOR = 0.9

const SUBSETS: Sign[][][] = [
  [['1'], ['X'], ['2']],
  [['1', 'X'], ['1', '2'], ['X', '2']],
  [['1', 'X', '2']],
]

type Match = { eventNumber: number; label: string; model: SignProbs; crowd: SignProbs }

/** Andel av folkets α-viktade rader som har tecknet. */
function crowdShare(c: SignProbs, alpha: number, s: Sign): number {
  const w = signWeights(c, alpha)
  return probFor(w, s) / w.z
}

/**
 * Uttömmande sökning över garderingsnivå per match, inom radbudgeten.
 * score[i][c-1] är log-poängen för match i med c tecken.
 */
function bestCoverage(score: number[][], targetRows: number): Coverage[] {
  // UTTÖMMANDE sökning, inte heuristik.
  //
  // En girig algoritm ger mätbart sämre system här. Testad mot omgång 4969
  // med 48 rader: girig gav 0,15 % träffchans (10 spikar + 3 helgarderingar),
  // uttömmande gav 0,240 % (8 spikar + 4 halvgarderingar + 1 helgardering) —
  // 60 % bättre. Girigheten fastnar i att helgardera redan påbörjade matcher
  // (kostar ×1,5) i stället för att halvgardera nya (kostar ×2).
  //
  // Sökrymden är 3^13 men beskärs hårt av radbudgeten, så detta är billigt.
  const n = score.length
  let best = -Infinity
  let bestCov: Coverage[] = score.map(() => 1)
  const cov: Coverage[] = new Array(n).fill(1) as Coverage[]
  const search = (i: number, rowsUsed: number, acc: number): void => {
    if (i === n) {
      if (acc > best) {
        best = acc
        bestCov = [...cov]
      }
      return
    }
    for (const c of [1, 2, 3] as const) {
      const rows = rowsUsed * c
      if (rows > targetRows) continue
      cov[i] = c
      search(i + 1, rows, acc + score[i]![c - 1]!)
    }
    cov[i] = 1
  }
  search(0, 1, 0)
  return bestCov
}

/**
 * Väljer garderingar inom budgeten `targetRows`, enligt `mode`.
 *
 * Båda målen faktoriserar per match: P(13) = Π p_i och utdelningsproxyn
 * Π v_i, där v_i = Σ p(tecken)/folkandel(tecken) (utdelningen ∝ 1/antal
 * vinnare). Utdelningsläget söker log P + t·log(V/P) för ett rutnät av t och
 * behåller bästa V som klarar träffgolvet. t = 0 är exakt träffläget.
 */
export function suggestSystem(
  matches: Match[],
  targetRows: number,
  rowPriceOre: number,
  mode: Mode = 'traff',
  alpha = 1,
): SystemSuggestion {
  const opts = matches.map((m) =>
    SUBSETS.map((level) =>
      level.map((signs) => ({
        signs,
        p: signs.reduce((a, s) => a + probFor(m.model, s), 0),
        v: signs.reduce((a, s) => a + probFor(m.model, s) / crowdShare(m.crowd, alpha, s), 0),
      })),
    ),
  )

  const solve = (t: number) => {
    const chosen = opts.map((levels) =>
      levels.map((level) =>
        level.reduce((a, b) =>
          Math.log(b.p) + t * Math.log(b.v / b.p) > Math.log(a.p) + t * Math.log(a.v / a.p) ? b : a,
        ),
      ),
    )
    const cov = bestCoverage(
      chosen.map((levels) => levels.map((o) => Math.log(o.p) + t * Math.log(o.v / o.p))),
      targetRows,
    )
    const picked = chosen.map((levels, i) => levels[cov[i]! - 1]!)
    return {
      picked,
      p: picked.reduce((a, o) => a * o.p, 1),
      v: picked.reduce((a, o) => a * o.v, 1),
    }
  }

  let best = solve(0)
  if (mode === 'utdelning') {
    const floor = best.p * PAYOUT_MODE_HIT_FLOOR
    for (const t of [0.25, 0.5, 0.75, 1, 1.5, 2, 3]) {
      const cand = solve(t)
      if (cand.p >= floor && cand.v > best.v) best = cand
    }
  }

  const picks: MatchPick[] = matches.map((m, i) => {
    // Behåll spelordningen 1, X, 2 för läsbarhet.
    const ordered = (['1', 'X', '2'] as Sign[]).filter((s) => best.picked[i]!.signs.includes(s))
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
  const rows = picks.reduce((a, p) => a * p.signs.length, 1)

  return { picks, rows, prob13, expectedCorrect, costOre: rows * rowPriceOre }
}

/**
 * Förväntad utdelning i 13-gruppen GIVET att systemet träffar, i öre.
 *
 *   Σ_rader P(rad) · pott13 · E[1/(1+W)] / P(13)
 *
 * Utdelningen ≈ pott/λ och båda växer med omsättningen, så nuvarande
 * omsättning på en öppen omgång ger rimligt tal trots att den växer.
 * Extrapott ingår inte — den syns inte före spelstopp (PRD §9.1).
 */
export function payout13IfHitOre(
  sys: SystemSuggestion,
  matches: Match[],
  netSaleOre: number,
  rowPriceOre: number,
  alpha: number,
): number {
  const totalRows = netSaleOre / rowPriceOre
  const pool = netSaleOre * TIER_SHARE[13]
  let sum = 0
  for (const row of expandRows(sys.picks)) {
    let p = 1
    let c = 1
    row.forEach((s, i) => {
      p *= probFor(matches[i]!.model, s)
      c *= crowdShare(matches[i]!.crowd, alpha, s)
    })
    sum += p * pool * expectedInverseWinners(Math.max(0, totalRows * c - 1))
  }
  return sys.prob13 > 0 ? sum / sys.prob13 : 0
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
