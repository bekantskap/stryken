# Edge

+EV-analys för Stryktipset, Europatipset och V75/V85. Se [prd-edge.md](prd-edge.md) för produktbeskrivning och matematik.

**Status:** fas 0 (snapshot-daemon). Ingen edge är ännu påvisad — det avgörs av backtesten i fas 2.

## Varför fas 0 först

Live-fälten `odds`, `favouriteOdds`, `fund` och streckrörelsen **nollställs när en omgång avgörs** och kan aldrig hämtas i efterhand. Varje omgång utan capture är permanent förlorad data. Daemonen körs därför innan något annat byggs.

Allt annat kan vänta: Svenska Spels arkiv har 248 färdiga omgångar (dec 2021→) med öppningsodds, slutstreck, facit och verkliga utdelningstabeller, och de går ingenstans.

## Kom igång

```bash
npm install
cp .env.example .env          # fyll i DATABASE_URL från Neon
npm run db:push               # skapa tabellerna
npm run capture               # en manuell körning
```

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
| `scripts/capture.ts` | Fas 0-daemonen |
| `scripts/dry-run.ts` | Torrkörning mot live-API utan databas |

## Fällor som redan kostat tid

Tre saker i datan ser rimliga ut i fel skala och ger inga felmeddelanden:

- **Belopp** kommer som `"1522223,00"` — svenskt decimalkomma. Parsas via sträng till heltal öre, aldrig via float.
- **Streckprocent** är heltal som summerar till 99–101, inte 100. Normaliseras mot radsumman; att dela med 100 ger fel som kompounderar över 13 matcher.
- **ATG:s `betDistribution`** är hundradelar av procent (404 = 4,04 %), inte tiondelar. Summerar till 10000 per lopp — det är kontrollen som avslöjar skalan. Vinnarodds är hundradelar (989 = 9,89).

## Nästa steg

1. **Fas 1** — arkivimport 4720–4967, kalibrera medvinnarmodellens α mot 992 observationer, implementera korrekt EV-formel (PRD §6.2).
2. **Fas 2** — backtest med tidsdelning och δ-känslighetskurva → beslutsgrind.
3. **Fas 3** — UI, men bara om grinden passeras.
