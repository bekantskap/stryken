/**
 * Parsing av Svenska Spels API-format.
 *
 * Två fällor bor här, båda tysta om de missas:
 *  1. Belopp kommer som "1522223,00" — svenskt decimalkomma. Float ger
 *     avrundningsfel rakt in i kalibreringsmålet.
 *  2. Streckprocent är heltal som summerar till 99–101, inte 100. Att dela
 *     med 100 i stället för med radsumman ger fel som kompounderar över 13
 *     matcher (~14 % på produkten).
 */

/** "2,28" | "2.28" | 2.28 → 2.28. Null/tomt → null. */
export function parseDecimal(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/\s/g, '').replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * "1522223,00" → 152222300n (öre).
 *
 * Går via sträng, inte via float: Number("0.07")*100 är 7.000000000000001.
 * Vid 20+ miljoner kronor blir sådana fel synliga i α-anpassningen.
 */
export function parseAmountToOre(v: unknown): bigint | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    return BigInt(Math.round(v * 100))
  }
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/\s/g, '').replace(',', '.')
  if (s === '') return null
  if (!/^-?\d+(\.\d*)?$/.test(s)) return null

  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [intPartRaw, fracRaw = ''] = body.split('.')
  const intPart = intPartRaw ?? '0'
  // Avrunda på tredje decimalen i stället för att trunkera.
  const frac3 = (fracRaw + '000').slice(0, 3)
  let ore = BigInt(intPart) * 100n + BigInt(frac3.slice(0, 2))
  if (Number(frac3[2] ?? '0') >= 5) ore += 1n
  return neg ? -ore : ore
}

export type Dist = { one: number; x: number; two: number }

/**
 * Normaliserar streckprocent mot radsumman så den summerar exakt till 1.
 * Returnerar null om summan är 0 eller något värde saknas.
 */
export function normaliseDistribution(
  one: unknown,
  x: unknown,
  two: unknown,
): Dist | null {
  const a = parseDecimal(one)
  const b = parseDecimal(x)
  const c = parseDecimal(two)
  if (a === null || b === null || c === null) return null
  if (a < 0 || b < 0 || c < 0) return null
  const sum = a + b + c
  if (sum <= 0) return null
  return { one: a / sum, x: b / sum, two: c / sum }
}

/**
 * Odds → marginalrensad sannolikhet (p_marknad).
 * Returnerar även den uppmätta marginalen (overround), som är värd att logga:
 * Svenska Spels egna odds ligger på ~1,036.
 */
export function oddsToProbabilities(
  one: unknown,
  x: unknown,
  two: unknown,
): { p: Dist; overround: number } | null {
  const a = parseDecimal(one)
  const b = parseDecimal(x)
  const c = parseDecimal(two)
  if (a === null || b === null || c === null) return null
  if (a <= 0 || b <= 0 || c <= 0) return null
  const ra = 1 / a
  const rb = 1 / b
  const rc = 1 / c
  const overround = ra + rb + rc
  if (!Number.isFinite(overround) || overround <= 0) return null
  return {
    p: { one: ra / overround, x: rb / overround, two: rc / overround },
    overround,
  }
}

/** '1' | 'X' | '2' — normaliserar gemener och whitespace. */
export function parseOutcome(v: unknown): '1' | 'X' | '2' | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toUpperCase()
  return s === '1' || s === 'X' || s === '2' ? s : null
}

/** "13 rätt" → 13. Tål "12 rätt", "10 rätt". */
export function parseTierName(name: unknown): number | null {
  if (typeof name !== 'string') return null
  const m = name.match(/(\d+)/)
  if (!m || m[1] === undefined) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 0 && n <= 13 ? n : null
}
