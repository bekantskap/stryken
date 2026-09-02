import Link from 'next/link'
import {
  loadLineMovement,
  MIN_MATCHES,
  SIGNAL_PP,
  type StrategyResult,
} from '../../src/lib/line-movement.ts'

export const dynamic = 'force-dynamic'

function fmt(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} %`
}

/**
 * Färg på verdict. "signifikant positiv" är den ENDA som får grön färg.
 */
function verdictClass(v: StrategyResult['verdict']): string {
  if (v === 'signifikant positiv') return 'tag under'
  if (v === 'signifikant negativ') return 'tag over'
  return 'tag neutral'
}

/**
 * Färg på ROI-siffran.
 *
 * VIKTIGT: en ROI som inte är statistiskt säkerställd får ALDRIG grön färg.
 * "Följ rörelsen +18,94 %" med n=17 och 5-percentil −32,6 % är brus, men
 * grön text drar blicken och läses som ett fynd — vilket är exakt den
 * felläsning hela sidan finns för att förhindra.
 */
function roiClass(s: StrategyResult): string {
  if (s.verdict === 'signifikant positiv') return 'v-hi'
  if (s.verdict === 'signifikant negativ') return 'v-lo'
  return 'v-mid'
}

export default async function Page() {
  const r = await loadLineMovement()
  const pct = Math.min(100, (r.usableMatches / MIN_MATCHES) * 100)

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Linjerörelse</h1>
          <div className="sub">
            Förutsäger Svenska Spels oddsrörelse utfallet? — projektets sista öppna fråga
          </div>
        </div>
        <div className="meta">
          <Link href="/">← Tillbaka till omgången</Link>
        </div>
      </header>

      <div className="panel">
        <h2>Datainsamling</h2>

        <div className="progress">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-label">
          <b>{r.usableMatches}</b> av {MIN_MATCHES} matcher
          {!r.ready && (
            <>
              {' '}
              — ungefär <b>{r.weeksRemaining} veckor</b> kvar vid nuvarande takt
            </>
          )}
        </div>

        <div className="stats">
          <div className="stat">
            <div className="k">Matcher med facit</div>
            <div className="v">{r.totalMatches}</div>
            <div className="n">live-odds + resultat</div>
          </div>
          <div className="stat">
            <div className="k">Mätbar rörelse</div>
            <div className="v">{r.usableMatches}</div>
            <div className="n">minst två snapshots</div>
          </div>
          <div className="stat">
            <div className="k">Mätfönster</div>
            <div className="v">
              {r.spanFromHours.toFixed(0)}→{r.spanToHours.toFixed(0)} h
            </div>
            <div className="n">före spelstopp</div>
          </div>
          <div className="stat">
            <div className="k">Median rörelse</div>
            <div className="v">{r.medianMovePp.toFixed(2)} pp</div>
            <div className="n">implicit sannolikhet</div>
          </div>
        </div>
      </div>

      {!r.ready && (
        <div className="panel">
          <div className="notice">
            <div className="h">För tidigt för slutsatser</div>
            Siffrorna nedan är <b>brus</b> vid detta urval och ska inte läsas som resultat. Live-odds
            nollställs när en omgång avgörs, så bara omgångar daemonen fångat live räknas — det växer
            med ~40 matcher i veckan.
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              Sidan uppdaterar sig själv. Kom tillbaka när mätaren är full.
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Strategier — signaltröskel {SIGNAL_PP} pp</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="l">Strategi</th>
                <th>n</th>
                <th>ROI</th>
                <th>5-percentil</th>
                <th>95-percentil</th>
                <th className="l">Bedömning</th>
              </tr>
            </thead>
            <tbody>
              {r.strategies.map((s) => (
                <tr key={s.name} style={{ opacity: r.ready ? 1 : 0.55 }}>
                  <td className="l match">{s.name}</td>
                  <td className="num">{s.n || '—'}</td>
                  <td className="num">
                    <span className={roiClass(s)}>{s.n ? fmt(s.roi) : '—'}</span>
                  </td>
                  <td className="num">{s.n ? fmt(s.p5) : '—'}</td>
                  <td className="num">{s.n ? fmt(s.p95) : '—'}</td>
                  <td className="l">
                    {s.n > 0 && <span className={verdictClass(s.verdict)}>{s.verdict}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {r.byTiming.length > 0 && (
          <>
            <h2 style={{ marginTop: 22 }}>Följ rörelsen — uppdelat på tidpunkt</h2>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th className="l">Sista mätpunkt</th>
                    <th>n</th>
                    <th>ROI</th>
                    <th>5-percentil</th>
                    <th className="l">Bedömning</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byTiming.map((s) => (
                    <tr key={s.name}>
                      <td className="l match">{s.name}</td>
                      <td className="num">{s.n || '—'}</td>
                      <td className="num">
                        <span className={roiClass(s)}>{s.n ? fmt(s.roi) : '—'}</span>
                      </td>
                      <td className="num">{s.n ? fmt(s.p5) : '—'}</td>
                      <td className="l">
                        {s.n > 0 && <span className={verdictClass(s.verdict)}>{s.verdict}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="honesty">
        <b>Hur detta ska läsas:</b> baslinjen (spela alla tecken) ska ligga nära −5,6 %, vilket är
        Svenska Spels marginal. Det är sanity-testet — avviker den kraftigt finns ett fel i
        beräkningen.
        <br />
        <br />
        För att en strategi ska räknas som en edge krävs att <b>5-percentilen är positiv</b>, inte
        bara medelvärdet. Ett positivt medelvärde med negativ 5-percentil betyder att resultatet är
        förenligt med ren slump. Projektet har redan haft fyra fynd som såg övertygande ut och föll
        vid granskning — därför den strängare regeln.
      </div>
    </main>
  )
}
