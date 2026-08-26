/**
 * Utdelningsmatematiken. Se PRD §6.
 *
 * Kärnan är att INTE simulera spelarkollektivet. Att dra 21,5M oberoende rader
 * är både dyrt och grovt fel: oberoendeantagandet förutsäger tvåsiffrigt fler
 * 13-rättare än verkligheten (omgång 4967: 4 vinnare mot ~200 förutsagda).
 * Folk spelar system, vilket korrelerar deras rader.
 *
 * I stället: en popularitetsmodell med skalär exponent α, och exakt
 * Poisson-binomial-DP över antal rätt. ~200 flops i stället för miljontals
 * dragningar, och noggrannare.
 */

/** Sannolikhetsfördelning över ett 1X2-tecken. Summerar till 1. */
export type SignProbs = { one: number; x: number; two: number }

/** Vinstgrupperna i Stryktipset/Europatipset. */
export const TIERS = [13, 12, 11, 10] as const
export type Tier = (typeof TIERS)[number]

/**
 * Andel av nettoomsättningen per vinstgrupp.
 *
 * Uppmätt över 68 omgångar 2026-08-26, avvikelse < 0,001. Summan är 0,5963 —
 * alltså 40,4 % avdrag, inte 35 % som PRD v0.1 antog.
 *
 * OBS: 13-gruppen får i ~40 % av omgångarna extra tillskjuten pott (upp till
 * 0,73 av omsättningen). Detta är BASNIVÅN — se detectExtraPot().
 */
export const TIER_SHARE: Record<Tier, number> = {
  13: 0.26,
  12: 0.0975,
  11: 0.0778,
  10: 0.161,
}

export const BASE_PAYOUT_RATIO = TIER_SHARE[13] + TIER_SHARE[12] + TIER_SHARE[11] + TIER_SHARE[10]

/**
 * Minimiutdelning i 10-gruppen.
 *
 * Verifierat mot 98 omgångar (4870–4967) 2026-08-26: när utdelningen per
 * vinnare skulle bli under ~15 kr betalas gruppen inte ut alls (amount = 0).
 * Separationen är ren — högsta nollade var 14,40 kr, lägsta utbetalda 16,24 kr.
 * Den exakta gränsen ligger däremellan; 15 kr är mittpunkten.
 *
 * Detta inträffar i ~23 % av omgångarna (23 av 98). Då faller HELA 10-gruppens
 * 16,1 % av poolen bort. En EV-modell som ignorerar detta överskattar
 * systematiskt — 10-gruppen är den grupp en genomsnittlig rad oftast träffar.
 *
 * OBS: en tidigare gissning på 1 kr var fel; de nollade omgångarna hade
 * implicita utdelningar på 3,70–14,40 kr, alltså långt över 1 kr.
 */
export const MIN_DIVIDEND_ORE = 1500 // 15 kr

export function isBelowMinDividend(poolOre: number, winners: number): boolean {
  if (winners <= 0) return false
  return poolOre / winners < MIN_DIVIDEND_ORE
}

/**
 * Utdelning per vinnare avrundas nedåt till hela kronor (verifierat: floor
 * stämmer i 7 av 8 kontrollerade fall, det åttonde avvek 1 kr vilket är
 * avrundning i vår egen poolskattning snarare än i regeln).
 */
export function roundDividendOre(poolOre: number, winners: number): number {
  if (winners <= 0) return 0
  return Math.floor(poolOre / winners / 100) * 100
}

/**
 * Popularitetsvikter under exponent α, per match.
 *
 *   q_korr(rad) = Π q_i(tecken_i)^α / Z(α)
 *   Z(α)        = Π_i Σ_tecken q_i(tecken)^α
 *
 * Z faktoriserar, så ingen summering över 3^13 rader behövs.
 *
 * α < 1 plattar ut folkfördelningen (folket mer spritt än oberoende antar),
 * α > 1 koncentrerar den (folket klumpar ihop sig på konsensusrader).
 */
export function signWeights(dist: SignProbs, alpha: number): SignProbs & { z: number } {
  const a = Math.pow(dist.one, alpha)
  const b = Math.pow(dist.x, alpha)
  const c = Math.pow(dist.two, alpha)
  const z = a + b + c
  return { one: a, x: b, two: c, z }
}

/**
 * Drar sannolikheterna i `from` mot `toward` med `amount` (0–1 i sannolikhet,
 * dvs. 0,011 = 1,1 procentenheter på det tecken som flyttas mest).
 *
 * Används för δ-känslighetskurvan i backtesten: arkivet parar öppningsodds med
 * slutgiltig streckprocent, så vår p_marknad är systematiskt "för tidig".
 * Marknaden rör sig under veckan delvis mot samma information folket har.
 * I stället för att gissa en rabatt mäter vi ROI som funktion av δ.
 */
export function oddsShrinkToward(from: SignProbs, toward: SignProbs, amount: number): SignProbs {
  const a = Math.max(0, Math.min(1, amount))
  const raw = {
    one: from.one * (1 - a) + toward.one * a,
    x: from.x * (1 - a) + toward.x * a,
    two: from.two * (1 - a) + toward.two * a,
  }
  const s = raw.one + raw.x + raw.two
  return s > 0 ? { one: raw.one / s, x: raw.x / s, two: raw.two / s } : from
}

/**
 * Poisson-binomial: fördelningen över "antal rätt" när match i träffas med
 * sannolikhet p_i, oberoende mellan matcher.
 *
 * Returnerar array av längd n+1 där index k = P(exakt k rätt).
 * DP över polynomet Π_i (1 - p_i + p_i·x) — O(n²), n=13 ⇒ ~90 operationer.
 */
export function poissonBinomial(probs: readonly number[]): number[] {
  const poly: number[] = [1]
  for (const p of probs) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let k = 0; k < poly.length; k++) {
      const v = poly[k] ?? 0
      next[k] = (next[k] ?? 0) + v * (1 - p)
      next[k + 1] = (next[k + 1] ?? 0) + v * p
    }
    poly.length = 0
    poly.push(...next)
  }
  return poly
}

/**
 * E[1/(1+W)] för W ~ Poisson(λ), sluten form (1 - e^(-λ))/λ.
 *
 * Detta är den korrigering PRD §6 kräver. Att i stället använda 1/(1+λ)
 * underskattar EV systematiskt för lågsannolika rader — dvs. exakt de
 * skrällrader hela tesen bygger på (vid λ=0,5 är felet ~10 %, vid λ→0 blir
 * kvoten 1 mot 1, men vid λ=4 skiljer det ~25 %).
 */
export function expectedInverseWinners(lambda: number): number {
  if (lambda <= 0) return 1
  if (lambda < 1e-9) return 1 - lambda / 2 // Taylor: undvik 0/0
  return (1 - Math.exp(-lambda)) / lambda
}

/** En rad: valt tecken per match. */
export type Row = readonly ('1' | 'X' | '2')[]

function pick(d: SignProbs, sign: '1' | 'X' | '2'): number {
  return sign === '1' ? d.one : sign === 'X' ? d.x : d.two
}

export type EvInput = {
  /** Modellsannolikheter per match (marginalrensade marknadsodds). */
  model: readonly SignProbs[]
  /** Folkets streckfördelning per match, normaliserad. */
  crowd: readonly SignProbs[]
  /** Nettoomsättning i öre. */
  netSaleOre: number
  /** Radpris i öre (1 kr = 100). */
  rowPriceOre: number
  /** Kalibrerad popularitetsexponent. 1 = oberoendeantagandet. */
  alpha: number
  /**
   * Extra pott per vinstgrupp i öre, utöver TIER_SHARE (jackpot/tillskjutet).
   * Se detectExtraPot().
   */
  extraPotOre?: Partial<Record<Tier, number>>
}

export type EvBreakdown = {
  /** Förväntad utdelning i öre för en rad. */
  evOre: number
  /** EV delat på radpris. > 1 = +EV. */
  evRatio: number
  perTier: Record<
    Tier,
    {
      /** P(raden får exakt k rätt) enligt modellen. */
      pExact: number
      /** Förväntat antal MEDvinnare (andra spelare med k rätt). */
      lambdaOthers: number
      /** Pool i öre för gruppen. */
      poolOre: number
      /** Bidrag till EV i öre. */
      contribOre: number
      /** Om minimiutdelningsregeln nollar gruppen. */
      belowMin: boolean
    }
  >
}

/**
 * Förväntat värde för en enskild rad, summerat över alla vinstgrupper.
 *
 *   EV(rad) = Σ_k andel_k · omsättning · P_modell(exakt k rätt) · E[1/(1+W_k)]
 *
 * Två SEPARATA Poisson-binomial-beräkningar, och att blanda ihop dem ger
 * rimliga men felaktiga tal:
 *   - P_modell(k rätt) för VÅR rad → använder model
 *   - λ_k, antal medvinnare        → använder crowd upphöjt till α
 */
export function rowEv(row: Row, input: EvInput): EvBreakdown {
  const { model, crowd, netSaleOre, rowPriceOre, alpha } = input
  const n = row.length
  if (model.length !== n || crowd.length !== n) {
    throw new Error(`rad har ${n} tecken men model/crowd har ${model.length}/${crowd.length}`)
  }

  // --- DP 1: sannolikheten att VÅR rad får k rätt, enligt modellen ---
  const modelHit: number[] = []
  for (let i = 0; i < n; i++) {
    const m = model[i]
    const s = row[i]
    if (!m || !s) throw new Error(`saknar model/tecken för match ${i}`)
    modelHit.push(pick(m, s))
  }
  const pExactByK = poissonBinomial(modelHit)

  // --- DP 2: sannolikheten att en SLUMPMÄSSIG folkrad matchar vår rad ---
  // Under α-viktad popularitet: a_i = q_i(vårt tecken)^α / Z_i
  const crowdMatch: number[] = []
  for (let i = 0; i < n; i++) {
    const c = crowd[i]
    const s = row[i]
    if (!c || !s) throw new Error(`saknar crowd/tecken för match ${i}`)
    const w = signWeights(c, alpha)
    crowdMatch.push(pick(w, s) / w.z)
  }
  const crowdExactByK = poissonBinomial(crowdMatch)

  const totalRows = netSaleOre / rowPriceOre

  const perTier = {} as EvBreakdown['perTier']
  let evOre = 0

  for (const tier of TIERS) {
    const pExact = pExactByK[tier] ?? 0
    // Antal ANDRA rader med k rätt. Vår egen rad räknas inte som medvinnare.
    const lambdaOthers = Math.max(0, totalRows * (crowdExactByK[tier] ?? 0) - 1)

    const basePool = netSaleOre * TIER_SHARE[tier]
    const extra = input.extraPotOre?.[tier] ?? 0
    const poolOre = basePool + extra

    // Minimiutdelning: nollas om utdelningen per vinnare < 1 kr.
    const expectedWinners = lambdaOthers + 1
    const belowMin = isBelowMinDividend(poolOre, expectedWinners)

    const contribOre = belowMin
      ? 0
      : pExact * poolOre * expectedInverseWinners(lambdaOthers)

    perTier[tier] = { pExact, lambdaOthers, poolOre, contribOre, belowMin }
    evOre += contribOre
  }

  return { evOre, evRatio: evOre / rowPriceOre, perTier }
}

/**
 * Detekterar extra tillskjuten pott genom att jämföra faktisk utbetalning mot
 * basnivån. Se PRD §6.1 — inträffar i ~40 % av omgångarna och kan tredubbla
 * 13-gruppens pool.
 *
 * Används för att (a) utesluta sådana omgångar ur α-kalibreringen, och
 * (b) flagga dem som spelvärda.
 */
export function detectExtraPot(
  netSaleOre: number,
  observed: readonly { tier: Tier; winners: number; amountOre: number }[],
): { hasExtra: boolean; extraByTier: Partial<Record<Tier, number>>; totalRatio: number } {
  const extraByTier: Partial<Record<Tier, number>> = {}
  let hasExtra = false
  let paidTotal = 0

  for (const o of observed) {
    const paid = o.winners * o.amountOre
    paidTotal += paid
    const expected = netSaleOre * TIER_SHARE[o.tier]
    // Tolerans 2 %: avrundning i utdelning per vinnare.
    if (expected > 0 && paid > expected * 1.02) {
      extraByTier[o.tier] = paid - expected
      hasExtra = true
    }
  }

  return { hasExtra, extraByTier, totalRatio: netSaleOre > 0 ? paidTotal / netSaleOre : 0 }
}
