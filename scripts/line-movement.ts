/**
 * Mäter om Svenska Spels oddsrörelse förutsäger utfall — CLI-vy.
 *
 * All logik ligger i src/lib/line-movement.ts, delad med UI:t, så de två
 * gränssnitten aldrig kan visa olika siffror.
 *
 *   npm run line-movement
 *
 * Skriptet vägrar dra slutsatser under MIN_MATCHES matcher och säger själv
 * till hur länge det är kvar.
 */

import {
  loadLineMovement,
  MIN_MATCHES,
  SIGNAL_PP,
  type StrategyResult,
} from '../src/lib/line-movement.ts'

function fmt(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} %`
}

function line(s: StrategyResult, indent = '  ') {
  if (s.n === 0) {
    console.log(`${indent}${s.name.padEnd(34)} (inga observationer)`)
    return
  }
  console.log(
    `${indent}${s.name.padEnd(34)} n=${String(s.n).padStart(5)}  ROI ${fmt(s.roi).padStart(9)}  ` +
      `[5%: ${fmt(s.p5).padStart(9)}]  ${s.verdict}`,
  )
}

async function main() {
  const r = await loadLineMovement()

  console.log('\n═══ LINJERÖRELSE — förutsäger den utfall? ═══\n')
  console.log(`  ${r.totalMatches} matcher med live-odds + facit`)
  console.log(`  ${r.usableMatches} med minst två snapshots (mätbar rörelse)`)

  if (r.usableMatches === 0) {
    console.log('\n  Ingen data än. Daemonen behöver köra genom avgjorda omgångar.\n')
    return
  }

  console.log(
    `  Mätfönster: ${r.spanFromHours.toFixed(1)} h → ${r.spanToHours.toFixed(1)} h före spelstopp`,
  )
  console.log(`  Median oddsrörelse: ${r.medianMovePp.toFixed(2)} pp`)

  if (!r.ready) {
    console.log(
      `\n  ⏳ FÖR TIDIGT. Behöver ${MIN_MATCHES}+ matcher för en meningsfull slutsats.\n` +
        `     Ungefär ${r.weeksRemaining} veckor kvar vid nuvarande takt.\n` +
        `     Kör om skriptet då — det säger till när datan räcker.`,
    )
    console.log('\n  (Talen nedan är BRUS vid detta urval. Läs dem inte som resultat.)')
  }

  console.log(`\n  Signaltröskel: rörelse ≥ ${SIGNAL_PP} pp implicit sannolikhet\n`)
  for (const s of r.strategies) line(s)

  if (r.byTiming.length > 0) {
    console.log('\n  Följ rörelsen, uppdelat på när sista mätpunkten togs:')
    for (const s of r.byTiming) line(s, '    ')
  }

  console.log(
    `\n  Tolkning: baslinjen ska ligga nära −5,6 % (Svenska Spels marginal).\n` +
      `  För att en strategi ska räknas som edge krävs att 5-percentilen är\n` +
      `  POSITIV — inte bara att medelvärdet är det.\n`,
  )
}

main().catch((err) => {
  console.error('line-movement kraschade:', err)
  process.exit(1)
})
