import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDecimal,
  parseAmountToOre,
  normaliseDistribution,
  oddsToProbabilities,
  parseOutcome,
  parseTierName,
} from '../src/lib/parse.ts'

test('parseDecimal hanterar svenskt decimalkomma', () => {
  assert.equal(parseDecimal('2,28'), 2.28)
  assert.equal(parseDecimal('2.28'), 2.28)
  assert.equal(parseDecimal(2.28), 2.28)
  assert.equal(parseDecimal('1,00'), 1)
  assert.equal(parseDecimal(null), null)
  assert.equal(parseDecimal(''), null)
  assert.equal(parseDecimal('abc'), null)
})

test('parseAmountToOre undviker float-fel', () => {
  // Verkliga belopp ur omgång 4967.
  assert.equal(parseAmountToOre('1522223,00'), 152222300n)
  assert.equal(parseAmountToOre('32159,00'), 3215900n)
  assert.equal(parseAmountToOre('1498,00'), 149800n)
  assert.equal(parseAmountToOre('284,00'), 28400n)
  // 0 är giltigt: minimiutdelningsregeln i 10-gruppen.
  assert.equal(parseAmountToOre('0,00'), 0n)
  // Klassiskt float-fall: 0.07 * 100 = 7.000000000000001
  assert.equal(parseAmountToOre('0,07'), 7n)
  assert.equal(parseAmountToOre('23418830,00'), 2341883000n)
  assert.equal(parseAmountToOre(null), null)
})

test('normaliseDistribution normaliserar mot radsumman, inte mot 100', () => {
  // Verklig rad ur 4968 match 1: 46/24/30 = 100
  const d = normaliseDistribution('46', '24', '30')
  assert.ok(d)
  assert.ok(Math.abs(d.one + d.x + d.two - 1) < 1e-12)
  assert.ok(Math.abs(d.one - 0.46) < 1e-12)

  // Fallet som motiverar funktionen: summa 101, inte 100.
  const e = normaliseDistribution('47', '24', '30')
  assert.ok(e)
  assert.ok(Math.abs(e.one + e.x + e.two - 1) < 1e-12)
  assert.ok(Math.abs(e.one - 47 / 101) < 1e-12)
  // Naiv /100 hade gett 0.47 — skillnaden kompounderar över 13 matcher.
  assert.ok(Math.abs(e.one - 0.47) > 1e-4)

  assert.equal(normaliseDistribution('0', '0', '0'), null)
  assert.equal(normaliseDistribution('46', null, '30'), null)
})

test('oddsToProbabilities rensar marginal och rapporterar overround', () => {
  // Verklig rad ur 4968 match 1.
  const r = oddsToProbabilities('2,28', '3,75', '3,15')
  assert.ok(r)
  assert.ok(Math.abs(r.p.one + r.p.x + r.p.two - 1) < 1e-12)
  // Svenska Spels marginal ligger runt 3–4 %.
  assert.ok(r.overround > 1.0 && r.overround < 1.12, `overround=${r.overround}`)
  // Favoriten ska ha högst sannolikhet.
  assert.ok(r.p.one > r.p.two)

  assert.equal(oddsToProbabilities('0', '3,75', '3,15'), null)
  assert.equal(oddsToProbabilities(null, '3,75', '3,15'), null)
})

test('parseOutcome och parseTierName', () => {
  assert.equal(parseOutcome('1'), '1')
  assert.equal(parseOutcome('x'), 'X')
  assert.equal(parseOutcome('2'), '2')
  assert.equal(parseOutcome('3'), null)
  assert.equal(parseTierName('13 rätt'), 13)
  assert.equal(parseTierName('10 rätt'), 10)
  assert.equal(parseTierName('nonsens'), null)
})
