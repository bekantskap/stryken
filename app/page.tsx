import { loadDrawView, systemFor, listDraws } from '../src/lib/draw-view.ts'
import { validSystemSizes, expandRows, MOVE_STRONG_PP } from '../src/lib/system.ts'
import { BASE_PAYOUT_RATIO } from '../src/lib/payout.ts'
import { Controls } from './controls.tsx'

export const dynamic = 'force-dynamic'

const PRODUCTS = [
  { value: 'stryktipset', label: 'Stryktipset' },
  { value: 'europatipset', label: 'Europatipset' },
] as const
const SIZES = validSystemSizes(1200).filter((n) => n >= 8)

function fmtPct(v: number, digits = 0) {
  return `${(v * 100).toFixed(digits)} %`
}

/** Färgklass för värdekvot. */
function vClass(v: number) {
  if (v >= 1.15) return 'v-hi'
  if (v <= 0.87) return 'v-lo'
  return 'v-mid'
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ draw?: string; rader?: string; produkt?: string }>
}) {
  const sp = await searchParams
  const product = PRODUCTS.some((p) => p.value === sp.produkt)
    ? sp.produkt!
    : PRODUCTS[0].value
  const drawNumber = sp.draw ? Number(sp.draw) : undefined
  const wantRows = sp.rader ? Number(sp.rader) : 48
  const targetRows = SIZES.includes(wantRows) ? wantRows : 48

  const [view, all] = await Promise.all([
    loadDrawView(product, drawNumber),
    listDraws(product, 30),
  ])

  if (!view) {
    return (
      <main className="wrap">
        <h1>Edge</h1>
        <div className="panel">
          <p className="empty">
            Ingen omgång med snapshots hittad för {product}. Kör <code>npm run capture</code>.
          </p>
        </div>
      </main>
    )
  }

  const sys = systemFor(view, targetRows)
  const pickByNum = new Map(sys.picks.map((p) => [p.eventNumber, p]))
  const moved = view.matches
    .filter((m) => m.move)
    .map((m) => ({ m, spiked: (pickByNum.get(m.eventNumber)?.signs.length ?? 3) === 1 }))
    .sort((a, b) => Math.abs(b.m.move!.deltaPp) - Math.abs(a.m.move!.deltaPp))

  const correct = view.settled
    ? sys.picks.filter((p) => {
        const m = view.matches.find((x) => x.eventNumber === p.eventNumber)
        return m?.outcome && p.signs.includes(m.outcome)
      }).length
    : null

  const drawOptions = all.map((d) => ({
    drawNumber: d.drawNumber,
    label: `#${d.drawNumber} — ${d.closeAt.toLocaleDateString('sv-SE')}${
      d.closeAt > new Date() ? ' (öppen)' : ''
    }`,
  }))

  const character =
    view.avgFavourite > 0.52
      ? 'favorittyngd'
      : view.avgFavourite < 0.45
        ? 'öppen / skrällvänlig'
        : 'normal'

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>
            {PRODUCTS.find((p) => p.value === product)?.label ?? product} #{view.drawNumber}
          </h1>
          <div className="sub">
            Spelstopp{' '}
            {view.closeAt.toLocaleString('sv-SE', {
              timeZone: 'Europe/Stockholm',
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            {view.isOpen ? ` — om ${view.hoursLeft.toFixed(0)} h` : ' — stängd'}
          </div>
        </div>
        <div className="meta">
          {view.netSaleKr !== null && (
            <span>
              Omsättning <b>{view.netSaleKr.toLocaleString('sv-SE')} kr</b>
            </span>
          )}
          <span>
            Karaktär <b>{character}</b>
          </span>
          <span>
            Snapshots <b>{view.snapshotCount}</b>
          </span>
        </div>
      </header>

      <div className="panel">
        <Controls
          products={PRODUCTS.map((p) => ({ value: p.value, label: p.label }))}
          draws={drawOptions}
          sizes={SIZES}
          currentProduct={product}
          currentDraw={view.drawNumber}
          currentRows={targetRows}
        />

        <div className="stats">
          <div className="stat">
            <div className="k">System</div>
            <div className="v">{sys.rows} rader</div>
            <div className="n">
              {(sys.costOre / 100).toLocaleString('sv-SE')} kr
              {sys.rows < targetRows && ` (av ${targetRows})`}
            </div>
          </div>
          <div className="stat">
            <div className="k">Träffchans 13 rätt</div>
            <div className="v">{fmtPct(sys.prob13, 2)}</div>
            <div className="n">1 på {Math.round(1 / sys.prob13).toLocaleString('sv-SE')} omgångar</div>
          </div>
          <div className="stat">
            <div className="k">Förväntat antal rätt</div>
            <div className="v">{sys.expectedCorrect.toFixed(1)}</div>
            <div className="n">av 13, bästa raden</div>
          </div>
          <div className="stat">
            <div className="k">Garderingar</div>
            <div className="v">
              {sys.picks.filter((p) => p.signs.length === 1).length}/
              {sys.picks.filter((p) => p.signs.length === 2).length}/
              {sys.picks.filter((p) => p.signs.length === 3).length}
            </div>
            <div className="n">spik / halv / hel</div>
          </div>
          {correct !== null && (
            <div className="stat">
              <div className="k">Facit</div>
              <div className="v">{correct} rätt</div>
              <div className="n">av 13</div>
            </div>
          )}
        </div>
      </div>

      {moved.length > 0 && (
        <div className="panel">
          <h2>Streckrörelse sedan omgången öppnade</h2>
          <div className="notice">
            <div className="h">
              {moved.length} {moved.length === 1 ? 'match har' : 'matcher har'} rört sig ovanligt
              mycket
            </div>
            {moved.map(({ m, spiked }) => (
              <div key={m.eventNumber} className="num">
                match {m.eventNumber} · {m.home}–{m.away} · {m.move!.sign}
                {m.move!.deltaPp >= 0 ? '+' : ''}
                {m.move!.deltaPp.toFixed(0)} pp
                {Math.abs(m.move!.deltaPp) >= MOVE_STRONG_PP && ' · kraftig'}
                {spiked && ' · SPIKAD i systemet'}
              </div>
            ))}
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>
              Stora rörelser betyder ofta ny information (laguppställning, skada). Värt att kolla
              innan spelstopp — särskilt de matcher systemet spikar.
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Värdetabell och systemförslag</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="l">#</th>
                <th className="l">Match</th>
                <th>Streck 1/X/2</th>
                <th>Marknad 1/X/2</th>
                <th>Värde 1/X/2</th>
                <th className="l">System</th>
                <th className="l">Noteringar</th>
              </tr>
            </thead>
            <tbody>
              {view.matches.map((m) => {
                const pick = pickByNum.get(m.eventNumber)
                const tags: React.ReactNode[] = []
                for (const [sign, v, p] of [
                  ['1', m.value.one, m.model.one],
                  ['X', m.value.x, m.model.x],
                  ['2', m.value.two, m.model.two],
                ] as const) {
                  if (v >= 1.25) {
                    tags.push(
                      <span key={`u${sign}`} className="tag under">
                        {sign} understreckad{p >= 0.4 ? ' FAV' : ''}
                      </span>,
                    )
                  } else if (v <= 0.8) {
                    tags.push(
                      <span key={`o${sign}`} className="tag over">
                        {sign} överstreckad
                      </span>,
                    )
                  }
                }
                if (m.move) {
                  tags.push(
                    <span key="mv" className="tag move">
                      {m.move.sign}
                      {m.move.deltaPp >= 0 ? '+' : ''}
                      {m.move.deltaPp.toFixed(0)} pp
                    </span>,
                  )
                }
                return (
                  <tr key={m.eventNumber}>
                    <td className="l num">{m.eventNumber}</td>
                    <td className="l">
                      <span className="match">
                        {m.home}–{m.away}
                      </span>
                      {m.outcome && (
                        <span className="num" style={{ color: 'var(--muted)' }}>
                          {' '}
                          [{m.outcome}]
                        </span>
                      )}
                      {m.league && <span className="league">{m.league}</span>}
                    </td>
                    <td className="num">
                      {fmtPct(m.crowd.one)} {fmtPct(m.crowd.x)} {fmtPct(m.crowd.two)}
                    </td>
                    <td className="num">
                      {fmtPct(m.model.one)} {fmtPct(m.model.x)} {fmtPct(m.model.two)}
                    </td>
                    <td className="num">
                      <span className={vClass(m.value.one)}>{m.value.one.toFixed(2)}</span>{' '}
                      <span className={vClass(m.value.x)}>{m.value.x.toFixed(2)}</span>{' '}
                      <span className={vClass(m.value.two)}>{m.value.two.toFixed(2)}</span>
                    </td>
                    <td className="l">
                      <span className="picks">
                        {(['1', 'X', '2'] as const).map((s) => {
                          const on = pick?.signs.includes(s)
                          const hit = on && m.outcome === s
                          return (
                            <span
                              key={s}
                              className={`pick${on ? (hit ? ' hit' : ' on') : ''}`}
                            >
                              {s}
                            </span>
                          )
                        })}
                      </span>
                    </td>
                    <td className="l notes">{tags}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
            Visa alla {sys.rows} rader
          </summary>
          <div className="rows">
            {expandRows(sys.picks).map((r, i) => (
              <div key={i}>{r.join('')}</div>
            ))}
          </div>
        </details>
      </div>

      <div className="honesty">
        <b>Så här är systemet valt:</b> garderingarna placeras så att sannolikheten att systemet
        innehåller den rätta raden maximeras, enligt marknadsodds. Alltså störst träffchans för
        budgeten.
        <br />
        <br />
        <b>Men:</b> utbetalningen är {fmtPct(BASE_PAYOUT_RATIO, 1)} av omsättningen (avdrag{' '}
        {fmtPct(1 - BASE_PAYOUT_RATIO, 1)}), och backtesten över 147 omgångar visade{' '}
        <b>ingen edge</b> i radurval — trimmad ROI −94 till −98 % vid alla testade trösklar.
        Förväntad avkastning är negativ oavsett hur systemet väljs. Detta är ett analysverktyg,
        inte ett vinstsystem. Spela belopp du är bekväm med att förlora.
      </div>
    </main>
  )
}
