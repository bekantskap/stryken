# Edge

+EV-analys för Stryktipset, Europatipset och V75/V85. Se [prd-edge.md](prd-edge.md) för produktbeskrivning och matematik.

**Status:** användbar som analysverktyg för Stryktipset.

**Ingen edge påvisad.** Backtesten (PRD §12) gav trimmad ROI −94 till −98 % vid alla testade trösklar. Systemgeneratorn byggs därför inte. Appen visar var marknaden och folket skiljer sig — inte att det går att tjäna pengar på det.

## Varför fas 0 först

Live-fälten `odds`, `favouriteOdds`, `fund` och streckrörelsen **nollställs när en omgång avgörs** och kan aldrig hämtas i efterhand. Varje omgång utan capture är permanent förlorad data. Daemonen körs därför innan något annat byggs.

Allt annat kan vänta: Svenska Spels arkiv har 801 färdiga omgångar (Stryktipset från dec 2021, Europatipset från apr 2021) med öppningsodds, slutstreck, facit och verkliga utdelningstabeller, och de går ingenstans.

## Kom igång

```bash
npm install
cp .env.example .env          # fyll i DATABASE_URL från Neon
npm run db:push               # skapa tabellerna
npm run capture               # hämta aktuell omgång
npm run analyse               # ← värdetabellen
```

## Daglig användning

**Få ett systemförslag:**

```bash
npm run tips                         # visa giltiga systemstorlekar
npm run tips -- --rader 48           # ← systemet att lämna in
npm run tips -- --rader 96 --visa-rader     # med full radlista
npm run tips -- --rader 96 --draw 4968      # avgjord omgång, med facit
```

Ger garderingar per match (spik / halvgardering / helgardering) — det man faktiskt lämnar in. Väljer den kombination som maximerar sannolikheten att systemet innehåller rätt rad, inom din budget.

**Se värdetabellen:**

```bash
npm run analyse                      # aktuell öppen omgång
npm run analyse -- --draw 4968       # en specifik omgång (med facit om avgjord)
```

Visar per match: streckprocent, marknadssannolikhet, värdekvot, streckrörelse sedan omgången öppnade, och flaggor för över-/understreckning. Streckrörelsen kommer från capture-daemonens snapshots och går inte att få i efterhand.

### Vad systemförslaget påstår

Det maximerar **träffchans för din budget**, enligt marknadsodds. Det påstår inte att systemet är lönsamt — backtesten gav trimmad ROI −94 till −98 %, och utbetalningen är 59,6 % av omsättningen. Förväntad avkastning är negativ oavsett hur systemet väljs. Verktyget skriver ut detta varje gång.

Torrkörning utan databas — visar vad som skulle skrivas:

```bash
npx tsx scripts/dry-run.ts
```

Tester och typkontroll:

```bash
npm test
npm run typecheck
```

## Drift

`.github/workflows/capture.yml` kör `npm run capture` var 15:e minut. Kräver `DATABASE_URL` som repository secret.

Vercels free tier tillåter bara cron 1×/dygn med lös precision, därför ligger capture i GitHub Actions.

## Kod

| Fil | Ansvar |
|---|---|
| `src/lib/parse.ts` | Decimalkomma, öre-heltal, normalisering av streck |
| `src/lib/svenskaspel.ts` | Klient mot Svenska Spels API |
| `src/lib/atg.ts` | Klient mot ATG:s racinginfo-API |
| `src/lib/ingest.ts` | Skriver omgång + snapshot (delad live/arkiv) |
| `src/db/schema.ts` | Drizzle-schema |
| `scripts/capture.ts` | Snapshot-daemonen (var 15:e min) |
| `scripts/fetch-results.ts` | Hämtar facit när omgångar avgjorts |
| `scripts/analyse.ts` | Värdetabellen |
| `scripts/tips.ts` | Systemförslag för given budget |
| `src/lib/system.ts` | Garderingsval (uttömmande sökning) |
| `scripts/backtest.ts` | Backtest med beslutsgrind |
| `scripts/calibrate-alpha.ts` | Kalibrerar medvinnarmodellen |
| `scripts/dry-run.ts` | Torrkörning mot live-API utan databas |

## Fällor som redan kostat tid

Tre saker i datan ser rimliga ut i fel skala och ger inga felmeddelanden:

- **Belopp** kommer som `"1522223,00"` — svenskt decimalkomma. Parsas via sträng till heltal öre, aldrig via float.
- **Streckprocent** är heltal som summerar till 99–101, inte 100. Normaliseras mot radsumman; att dela med 100 ger fel som kompounderar över 13 matcher.
- **ATG:s `betDistribution`** är hundradelar av procent (404 = 4,04 %), inte tiondelar. Summerar till 10000 per lopp — det är kontrollen som avslöjar skalan. Vinnarodds är hundradelar (989 = 9,89).

## Vad som är gjort och vad som inte är det

Klart:

- Snapshot-daemon i drift (GitHub Actions, var 15:e min)
- Arkivimport: 801 omgångar med odds, streck, facit och verkliga utdelningar
- Medvinnarmodell kalibrerad: α = 1,068 (Stryktipset), 1,045 (Europatipset)
- Backtest med beslutsgrind → **ingen edge**
- Värdetabell för Stryktipset

Byggs inte:

- **EV-baserat radurval** — beslutsgrinden gav nej. Systemförslaget bygger på träffsannolikhet, inte på påstådd edge
- **Extrapott-signal** — potten annonseras inte före spelstopp (PRD §9.1)
- **Egen xG-modell** — fel måltavla, se PRD §7

Möjligt senare:

- Europatipset-backtest (551 omgångar importerade, ej körda)
- V75/V85 (ATG-data samlas redan)
