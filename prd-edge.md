# PRD — "Edge" (arbetsnamn)

## En +EV-analysapp för Stryktipset, Europatipset och V75

**Version:** 0.5 (extrapott-spåret stängt)
**Datum:** 2026-08-26 (v0.1: 2026-08-25)
**Ägare:** Alex
**Status:** Fas 2 klar. **Beslutsgrinden gav NEJ** — ingen edge påvisad (§12)

> **Ändringar i v0.2** — efter mätning mot live-API:er och 68 verkliga utdelningstabeller (§11):
> §3.1/§3.3 datakällor verifierade, tipsxtra-beroendet utgår, SvS-odds blir `p_modell` · §6 EV-matematiken omskriven (utbetalning 59,7 % ej 65 %; 13-gruppen 26 % ej 65 %; medvinnarmodell med α ersätter oberoende-antagandet) · §7 fasordning omkastad till backtest-före-UI, xG-fasen utgår · §4 F3/F4 följer nya matematiken · §8 risker omprioriterade.
>
> **Ändringar i v0.5** — §9.1 besvarad med live-data: extrapotten annonseras **inte** före spelstopp (verifierat mot omgång 4968, +5,3 Mkr utan förvarning i något fält). Extrapott-spåret därmed stängt.
>
> **Ändringar i v0.4** — fas 2 genomförd: **beslutsgrinden gav NEJ** (§12). Ingen edge påvisad; trimmad ROI −94 till −98 % vid alla trösklar och alla δ. Optimizer's curse dokumenterad. Systemgeneratorn byggs INTE.
>
> **Ändringar i v0.3** — efter arkivimport och α-kalibrering:
> §6.3 **α̂ = 1,068** kalibrerad mot 246 omgångar × 4 vinstgrupper; en skalär räcker, risken avförd · §6.1 minimiutdelningsgränsen rättad från 1 kr till **~15 kr** (~23 % av omgångarna, inte 30 %) · §6.3 oberoende-antagandet nedgraderat från katastrofal till **måttlig** felkälla (1,2–1,3×, inte storleksordningar) · §3.3 Europatipset har odds från **#2051**, ger 551 omgångar → totalt **~799** i stället för 248.

---

## 1. Bakgrund och vision

Stryktipset, Europatipset och V75 är poolspel (pari-mutuel): man spelar mot spelarkollektivet, inte mot ett spelbolag. Oddsen sätts av hur folket streckar. Det betyder att det finns ett systematiskt, mätbart fel att exploatera — **skillnaden mellan folkets streckprocent och den faktiska sannolikheten**. Det är exakt den edge Bill Benter byggde sin verksamhet på i Hongkong.

**Visionen:** En webapp som varje omgång automatiskt hämtar streckprocent från Svenska Spel/ATG, jämför den mot en oberoende sannolikhetsuppskattning, visar var folket har fel, och genererar reducerade systemförslag där varje rad har positivt förväntat värde.

### Ärlighetsavsnittet (viktigt)

Innan vi bygger något ska vi vara överens om spelplanen:

- **Avdraget är 40,3 %, inte 35 %.** Uppmätt över 68 omgångar betalas endast **59,7 %** av omsättningen tillbaka (§6.1) — ribban är alltså ~5 procentenheter högre än v0.1 antog. Modellen måste inte bara vara bättre än folket, den måste vara *så mycket* bättre att den övervinner ett 40-procentigt handikapp. De flesta som försöker går minus.
- **Variansen är brutal.** Även ett äkta +EV-spel på 13 rätt kan gå minus i månader eller år. Utdelning kommer i sällsynta klumpar.
- **Appen är ett analysverktyg, inte en pengamaskin.** Primärt värde: bättre beslut, disciplin, och mätbarhet (visste vi det vi trodde vi visste?). Sekundärt värde: eventuell vinst.
- Appen ska aktivt stödja **bankrollsdisciplin** (fasta insatser, Kelly-tak) — inte uppmuntra till att jaga förluster.

### Nyckelinsikten som gör MVP:n realistisk

Benter byggde en egen modell med 130+ parametrar. Det behöver inte vi göra i version 1, för på fotboll finns redan en nästan perfekt sannolikhetsuppskattning gratis: **skarpa bookmakers odds** (t.ex. Pinnacle). En bookmaker med låg marginal som tar emot proffspengar har inbyggt allt — skador, form, xG, avstängningar, vilodagar — i sitt odds. Marknaden har redan gjort Benter-jobbet åt oss.

MVP:ns modell är därför inte maskininlärning, utan aritmetik:

1. Ta marknadsodds för matchen → räkna bort bookmakerns marginal → **p_marknad** (bästa gratis skattningen av sann sannolikhet).
2. Hämta **p_streck** (folkets streckprocent) från Svenska Spel.
3. **Värde = p_marknad / p_streck.** Över 1,0 = folket underskattar tecknet. Under 1,0 = överstreckat.
4. Radens EV summeras över alla fyra vinstgrupperna (13/12/11/10) med hänsyn till hur många andra som väntas ha raden — se §6.2. *(v0.1:s enkla `× 0,65`-approximation visade sig fel och är ersatt.)*

Steg 1–3 är fortfarande ren aritmetik och står sig. Det som visade sig kräva mer arbete är steg 4: att gå från "detta tecken är felstreckat" till "denna rad är +EV" kräver en kalibrerad modell av folkets radfördelning, eftersom utdelningen beror på hur många man delar med (§6.3).

Egen xG-/skade-/formmodell **utgår ur planen** — se motivering i §7.

---

## 2. Mål och icke-mål

### Mål

- Automatisk datainhämtning per omgång (Stryktipset lör, Europatipset ons/sön, V75 lör).
- Tydlig värdevy per match: streck vs modellsannolikhet, flaggade över-/understreckningar.
- Systemgenerator som producerar reducerade system där raderna rankas på förväntat värde.
- Monte Carlo-simulering av förväntad utdelning (poolspecifik EV, inte bara träffsannolikhet).
- Historiklogg: varje omgångs prognoser sparas och utvärderas mot facit → mätbar edge över tid.
- Gratis drift: Vercel free tier + gratis datakällor.

### Icke-mål (v1)

- **Ingen automatisk spelinläggning.** Svenska Spel/ATG tillåter inte inlämning via API. Utdata är en radlista/ett system som lämnas in manuellt (ev. som spelfil hos ombud, utreds i fas 2).
- Ingen egen ML-modell i v1 (fas 3).
- Inga användarkonton/multi-user i v1 — appen byggs för eget bruk.
- Inget realtidsflöde under pågående omgång.

---

## 3. Datakällor

### 3.1 Svenska Spel (streckprocent, matcher, odds)

Svenska Spel har ett publikt, onyckelat API som communityn använt länge:

- `https://api.www.svenskaspel.se/draw/1/stryktipset/draws` — aktuell omgång: 13 matcher, lag, starttid, spelstopp, **svenska folkets streckprocent**, favoritodds och tidningarnas tips.
- Samma mönster för `europatipset`, `topptipset` (kräver nyckel via `/external/`-varianten), `maltipset` m.fl.

**Risk:** API:t är inofficiellt/odokumenterat och kan ändras eller stängas utan förvarning. Mitigering: (a) abstraktionslager i koden så källan kan bytas, (b) daglig snapshot till egen databas så historiken aldrig går förlorad, (c) fallback-skrapning av webbsidan som sista utväg.

**Verifierat 2026-08-26 — arkivet är bättre än väntat:**

- `/draw/1/{produkt}/draws/{n}` fungerar för historiska omgångar tillbaka till **#4267 (jan 2013)**. Europatipset ligger på samma path (`/draw/1/europatipset/`), identisk struktur. Topptipset kräver nyckel.
- `/draw/1/{produkt}/draws/{n}/result` ger facit per match **och den verkliga utdelningstabellen** (vinnare + belopp per vinstgrupp) samt omsättning. Detta är kalibreringsmålet för medvinnarmodellen.
- **Viktig begränsning:** på avgjorda omgångar nollställs `odds`, `favouriteOdds` och `fund`, men `startOdds` och `betMetrics` behålls. Odds finns från:
  - Stryktipset **#4720 (2021-12-18)** → ~248 omgångar
  - Europatipset **#2051 (2021-04-07)** → ~551 omgångar (spelas ons+sön)
  - **Totalt ~799 omgångar** användbar backtest, ~4,8 år.
- Det finns **ingen** tidsserie-/historik-endpoint (`/betmetrics`, `/distribution`, `/history`, `/trend` ger alla HTTP 500). Arkivet ger exakt **en fryst rad per omgång**: öppningsodds parat med *slutgiltig* streckprocent. Detta ger en systematisk optimistisk skevhet i backtesten — uppmätt drift ~1,1 procentenhet — som hanteras som känslighetskurva, inte som gissad rabatt.
- `rowPrice` = 1,00 kr bekräftad, vilket validerar omräkning omsättning → antal sålda rader.

Tidigare antagande om CSV-import från tipsxtra.se **utgår** — det officiella API:t har bättre data (auktoritativt, inkluderar vinnare per grupp) och ett skrapberoende mindre.

### 3.2 ATG (V75) — verifierat fungerande API

ATG:s racinginfo-API är öppet och svarar utan nyckel (verifierat 2026-08-25):

- `https://www.atg.se/services/racinginfo/v1/api/calendar/day/{YYYY-MM-DD}` — dagens spel, banor, lopp, `returnToPlayer`, jackpott.
- `https://www.atg.se/services/racinginfo/v1/api/games/{gameId}` — komplett startlista per V75-omgång: hästar, kuskar, **skor (barfotainfo)**, sulky/vagn, spår, rekord, tidigare resultat, och **spelprocent per häst**.

Det här är ovanligt bra rådata — barfota/vagn/spår finns med, vilket är kärnan i travanalys.

### 3.3 Oberoende sannolikheter (MVP-modellen)

**Beslut (2026-08-26): Svenska Spels egna odds är `p_modell` i v1.**

- De ligger redan i samma svar (`odds` live, `startOdds` i hela arkivet), kräver ingen nyckel, och har uppmätt marginal **~3,6 %** — förvånansvärt skarpt, satt mot Kambi-marknaden snarare än mot streckprocenten.
- Avgörande: **The Odds API finns inte i arkivet.** Backtesten över ~799 omgångar kan bara byggas på Svenska Spels `startOdds`. Att göra dem primära håller backtest- och live-vägen identiska — vilket i sig är värt mycket.
- **The Odds API** (~500 anrop/mån gratis, Pinnacle m.fl.) blir valfri fas 3-förbättring, inte ett MVP-beroende. Dess täckning av Championship/League One/Two är overifierad — och det är just de lägre ligorna där folkets felstreckning väntas vara störst.
- Byggs bakom utbytbart oddskälle-lager så alternativ kan A/B-testas på Brier score över tid.

### 3.4 Berikningsdata (fas 3 — egen modell)

- **Understat** (gratis skrapning): skott- och xG-data för PL, La Liga, Bundesliga, Serie A, Ligue 1, RFPL. Täcker inte Championship/lägre engelska divisioner eller Allsvenskan.
- **FBref via `soccerdata`-paketet** (Python): xG och lagstatistik för fler ligor, gratis.
- **football-data.org**: gratisnivå med spelscheman, tabeller och resultat för 12 större tävlingar (10 anrop/min).
- **Skador/avstängningar:** svåraste gratisdatan. Alternativ i fallande ordning: Fotmobs inofficiella API, skrapning av Transfermarkt, API-Footballs betalnivå (~$25/mån) om gratisvägen blir för skör. I MVP:n behövs detta inte — marknadsoddsen bär redan skadeinformationen.
- **V75-modell (fas 4):** ATG-API:ts startlistor + historiska resultat räcker för en enkel ratingmodell (kusk/häst-form, spår, barfota-effekt). Här finns ingen "marknadsodds-genväg" av samma kvalitet, så V75 börjar som ren streck-vs-vinnarodds-analys (ATG:s vinnarspel är en egen pool vars odds kan användas som proxy — proffsen spelar i vinnarpoolen, folket i V75-poolen, och skillnaden mellan dem är en känd edge-signal).

---

## 4. Kärnfunktioner

### F1 — Omgångsvy

Lista aktuella omgångar (Stryktipset, Europatipset, V75) med spelstopp-nedräkning. Data hämtas via Vercel Cron flera gånger per dygn fram till spelstopp — streckprocenten rör sig mycket sista dygnet, och sena streckrörelser är i sig en signal.

### F2 — Värdetabell (hjärtat i appen)

Per match/lopp, per tecken:

| Kolumn | Beskrivning |
|---|---|
| Streck % | Folkets procent (Svenska Spel/ATG) |
| Modell % | Marginal-rensad marknadssannolikhet |
| Värde | Modell % / Streck % |
| Flagga | SPIK-kandidat (högt värde + hög sannolikhet), SKRÄLL-värde (lågt streckat, kvot ≫ 1), FÄLLA (överstreckad favorit) |

Sorterbar, färgkodad, med sparkline över hur strecket rört sig sedan omgången öppnade.

### F3 — Systemgenerator

- Användaren sätter budget (t.ex. 96–864 kr) och ev. tvång (spikar/lås).
- **3^13 = 1 594 323 rader är trivialt att räkna igenom exakt.** Enumerera alla, ranka på EV enligt §6.2, ta topp-N inom budget. Klassisk R-systemreducering behövs inte för fotboll och utgår ur scope (för V75 är det omvänt — där gör fältstorlekarna uttömmande enumerering omöjlig, så reduktionslogiken hör hemma i F7).
- Utdata: radlista (kopierbar/CSV), täckningsgrad, förväntat värde för systemet som helhet.
- **Byggs först efter godkänd beslutsgrind (fas 2).**

### F4 — Utdelningssimulering (Monte Carlo)

Poolspels-EV är inte bara "sannolikhet att vinna" — utdelningen beror på hur många *andra* som har raden. Det är detta som gör att en skrällrad med "för låg" sannolikhet ändå kan vara rätt spel: när den går in delar man med nästan ingen.

**Reviderad metod (2026-08-26):** simulera *inte* spelarkollektivet. Att dra 21,5M oberoende rader är både dyrt och grovt fel (§6.3). I stället:

1. Monte Carlo **enbart över matchutfall**, dragna ur `p_marknad`.
2. Antal medvinnare per vinstgrupp beräknas **exakt** med Poisson-binomial-DP över den α-kalibrerade folkfördelningen `q_korr` — ett 14-termers polynom, ~200 flops, ingen sampling.
3. Utdelning per grupp via sluten form `E[1/(1+W)] = (1 − e^(−λ))/λ`.
4. Minimiutdelningsregeln i 10-gruppen modelleras explicit (noll om vinnare > tröskel).

Detta är både noggrannare och storleksordningar snabbare än att simulera spelare — vilket i praktiken avför risken för serverless-timeouts.

### F5 — Historik och facit (utan detta vet vi ingenting)

Varje omgång sparas: prognoser, streck vid spelstopp, faktiskt utfall, faktisk utdelning, och (om vi spelade) resultatet. Dashboarden visar över tid: modellens kalibrering (Brier score), teoretisk ROI om man spelat varje +EV-rad, faktisk ROI, och varians. **Detta är appens viktigaste funktion på 6 månaders sikt** — den svarar på frågan "har vi en edge eller lurar vi oss själva?".

### F6 — Backtesting (fas 2)

Ladda historiska omgångar (tipsxtra-CSV + odds-historik) och kör modellen bakåt i tiden innan riktiga pengar sätts.

### F7 — V75-modul (fas 4)

Samma värdetabell-koncept: V75-procent vs vinnarpoolens odds per häst, barfota-/vagnändringsflaggor från startlistan, systemgenerator. Egen ratingmodell som senare ambition.

---

## 5. Teknisk arkitektur

```
┌─────────────────────────── Vercel (free tier) ───────────────────────────┐
│                                                                           │
│  Next.js 15 (App Router, TypeScript)                                      │
│  ├── UI: värdetabell, systemgenerator, historik (React Server Components) │
│  ├── API-routes: /api/ingest, /api/simulate                               │
│  └── Vercel Cron: hämtning 4×/dygn + tätare nära spelstopp                │
│                                                                           │
└──────────┬────────────────────────────────────────────────────────────────┘
           │
    ┌──────┴───────┐        ┌─────────────────────────────┐
    │ Postgres      │        │ GitHub Actions (gratis cron) │
    │ (Neon free)   │◄───────│ Python-skrapjobb: Understat, │
    │ snapshots,    │        │ FBref, historikimport        │
    │ prognoser,    │        └─────────────────────────────┘
    │ facit         │
    └───────────────┘
```

**Val och motiveringar:**

- **Next.js på Vercel** — som föreslaget. Free tier räcker: låg trafik, cron-jobb ingår (obs: free tier tillåter endast cron 1×/dygn med lös precision — därför läggs de täta hämtningarna i GitHub Actions, som är gratis och kan köra var 15:e minut).
- **Neon Postgres (free)** i stället för Vercel KV — vi vill köra riktiga frågor över historiken. Drizzle ORM.
- **GitHub Actions som skrapmotor** — Python-ekosystemet (soccerdata, understat-bibliotek) är överlägset för skrapning; Actions kör gratis på schema och skriver direkt till Neon. Vercel-appen blir ren läsare/presentatör plus simuleringsmotor.
- **Simulering i TypeScript** i API-route (Monte Carlo på 13 matcher är billigt — miljontals rader/sekund behövs inte). Om det växer: flytta till Actions-jobb som förberäknar.
- Abstraktionslager `DataSource` per källa så inofficiella API:er kan bytas utan att röra resten.

---

## 6. EV-matematiken (specifikation för motorn)

> **Reviderad 2026-08-26 efter mätning mot 68 verkliga utdelningstabeller.** Den ursprungliga formeln nedan visade sig vara fel i riktningen som *uppfinner* edge, och är ersatt. Se §6.1 för vad mätningen gav.

**Per tecken:** `värde(tecken) = p_modell / p_streck` — oförändrad, denna är korrekt.

### 6.1 Vad utdelningsdatan faktiskt visar

Utbetalningen är **inte** 65 % av omsättningen utan **59,7 %**, fördelat på fyra vinstgrupper som är exakta konstanter av nettoomsättningen (uppmätt över 68 omgångar, avvikelse < 0,001):

| Vinstgrupp | Andel av omsättningen |
|---|---|
| 13 rätt | **26,00 %** |
| 12 rätt | 9,75 % |
| 11 rätt | 7,78 % |
| 10 rätt | 16,10 % |
| **Summa** | **59,63 %** |

Två konsekvenser: 13-gruppen är bara 26 %, inte 65 %. Och 12+11+10 = 33,6 % är **större än** 13-gruppen — merparten av pengarna ligger i grupperna som den gamla formeln ignorerade.

**Två mekanismer som inte fanns i v0.1 och som båda påverkar EV kraftigt:**

- **Extra tillskjuten pott till 13-gruppen.** I ~40 % av omgångarna är 13-andelen inte 26 % utan 0,39–0,73 av omsättningen. Det förklaras *inte* av att föregående omgång var otagen (verifierat: överskott uppstår även efter tagna omgångar) — källan är extern. Effekten är stor nog att dominera EV: **vilken omgång man spelar betyder sannolikt mer än vilka rader man spelar.**
- **Minimiutdelningsregel i 10-gruppen.** När utdelningen per vinnare skulle bli under **~15 kr** betalas gruppen inte ut alls (amount = 0). Verifierat mot 98 omgångar: högsta nollade 14,40 kr, lägsta utbetalda 16,24 kr — ren separation. Inträffar i **23 av 98 omgångar (~23 %)**, och då faller hela 16,1 % av poolen bort. Måste modelleras explicit, annars krediteras EV till en grupp som ofta betalar noll — och 10-gruppen är den grupp en genomsnittlig rad oftast träffar. *(En första gissning på 1 kr var fel: de nollade omgångarna hade implicita utdelningar på 3,70–14,40 kr.)* Utdelning avrundas dessutom nedåt till hela kronor.

### 6.2 Korrekt EV-formel

```
EV(rad) = Σ_{k=10..13}  andel_k · omsättning · P_modell(exakt k rätt) · E[1/(1+W_k)]
```

- `E[1/(1+W)] = (1 − e^(−λ))/λ` för `W ~ Poisson(λ)` — sluten form. Att i stället substituera `1/(1+λ)` underskattar EV systematiskt för just lågsannolika rader, dvs. exakt de skrällrader hela tesen bygger på.
- `P_modell(exakt k rätt)` beräknas ur `p_marknad`; `W_k` ur folkets radfördelning `q_korr`. **Två separata Poisson-binomial-DP:er** — att blanda ihop dem ger rimliga men felaktiga tal.

**Den gamla formeln, för referens:** `EV ≈ 0,65 × Π p_modell / Π p_streck`. Den överskattar 13-radens EV med ~2,5× och ignorerar 33,6 % av utdelningen. En tröskel på 1,2 ovanpå den är ingen säkerhetsmarginal.

### 6.3 Medvinnarmodellen (ersätter oberoende-antagandet)

Folk spelar system, vilket korrelerar deras rader. Oberoende-antagandet underskattar därför hur mycket folket klumpar ihop sig på konsensusrader. Korrigeras med en popularitetsmodell med skalär exponent α:

```
q_korr(rad) = Π q_i(tecken_i)^α / Z(α)     där  Z(α) = Π_i Σ_tecken q_i(tecken)^α
```

`Z(α)` faktoriserar, så ingen summering över 1,59M rader behövs.

**Kalibrerat 2026-08-26 mot 246 omgångar × 4 vinstgrupper = 984 observationer** (MLE):

| Vinstgrupp | α per grupp | Median-residual (log10) | Inom faktor 2 |
|---|---|---|---|
| 13 rätt | 1,101 | −0,012 | 79 % |
| 12 rätt | 1,093 | −0,008 | 92 % |
| 11 rätt | 1,080 | −0,010 | 97 % |
| 10 rätt | 1,063 | −0,007 | 99 % |

**α̂ = 1,068 samlat.** Resultatet är gott på tre punkter: α stabiliserar sig (största risken avförd), grupperna ligger tätt (1,06–1,10) så **en skalär räcker** — ingen α per vinstgrupp behövs, och medianresidualerna är i praktiken noll (~2 % fel).

**Korrigering av tidigare uppskattning:** oberoende-antagandet är en *måttlig*, inte katastrofal, felkälla. Kontroll mot omgång 4967 (23,4M rader, faktiskt 4/71/1219/13364 vinnare):

| Grupp | Faktiskt | α=1 | α=1,068 |
|---|---|---|---|
| 13 | 4 | 1,8 (0,45×) | 1,4 (0,34×) |
| 12 | 71 | 84,6 (1,19×) | 70,6 (0,99×) |
| 11 | 1219 | 1577 (1,29×) | 1392 (1,14×) |
| 10 | 13364 | 16372 (1,23×) | 15057 (1,13×) |

Oberoende är alltså ~1,2–1,3× fel på de stora grupperna, inte storleksordningar. 13-gruppen har hög varians på enstaka omgångar (4 vinnare är ett litet tal), vilket är väntat och syns i den högre spridningen ovan.

**Bankroll:** **fast andel av bankrollen med hårt tak per omgång** — inte Kelly. Kelly förutsätter upprepade spel; vid ~1e-5 vinstsannolikhet och 2 omgångar/vecka ligger asymptotiken bortom en livstid, och Kelly-ramverket lånar falsk stringens åt vad som i praktiken är "små fasta insatser". Appen visar rekommenderad insats men uppmuntrar aldrig höjning efter förlust.

---

## 7. Faser och milstolpar

> **Reviderad 2026-08-26.** Fas 0-spiken är utförd (se §11). Den visade att Svenska Spels arkiv innehåller 248 färdiga omgångar med öppningsodds + slutstreck + facit + verkliga utdelningstabeller — alltså kan **beslutsgrinden köras före UI-bygget**. Ordningen nedan är omkastad därefter: ingen radgenerator byggs innan matematiken är verifierad mot verklig utdelningsdata.

| Fas | Innehåll | Klart när |
|---|---|---|
| **0. Snapshot-daemon (halvdag)** | GitHub Actions var 15:e min, rå JSON → Postgres `jsonb`. Ingen parsing, ingen UI. Stryktipset + Europatipset + ATG dagligen | Snapshots ackumuleras för pågående omgång |
| **1. Arkivimport + utdelningsmodell** | Import 4720–4967, verifiera vinstgruppsandelar, kalibrera α mot 992 observationer, implementera korrekt EV-formel (§6.2) | α stabiliserar sig; simulatorn reproducerar faktiska vinnarantal på hållna omgångar |
| **2. Backtest → BESLUTSGRIND** | Tidsdelad backtest, baslinjer, δ-känslighetskurva, bootstrappad ROI | Ärligt svar på om metoden bär efter avdrag |
| **3. UI (endast efter godkänd grind)** | Next-app, värdetabell (F1–F2), omgångsflagga, F5-loggning, systemgenerator (F3) | Användbar inför en riktig omgång |
| **4. V75/V85** | ATG-ingest, värdetabell streck vs vinnarodds, barfota/vagn-flaggor | Användbar inför en V75-omgång |

**Fas 0 är det enda med verklig deadline.** Live-fälten `odds`, `favouriteOdds`, `fund` och streckrörelse nollställs när omgången avgörs och kan aldrig återskapas. Varje omgång utan capture är permanent förlorad data. Blockerar inget annat och bör startas först.

**Beslutsgrind efter fas 2:** om ROI:ns 5:e percentil är negativ vid δ=1,1 pp → bygg ingen systemgenerator. Appen blir analysverktyg, inte spelverktyg. **Det utfallet är ett resultat, inte ett misslyckande.**

**Fas "egen modellkant" (xG/form) utgår ur planen.** Motiv: målet var att slå marknadens Brier score, men Svenska Spels egna odds ligger på ~3,6 % marginal och Understat täcker inte Championship/League One/Two — dvs. exakt de ligor omgångarna domineras av. Dessutom fel måltavla: edgen kommer från att `p_streck` är fel, inte från att `p_marknad` är marginellt förbättringsbar. Den ansträngningen gör mer nytta i medvinnarmodellen (§6.3).

---

## 8. Risker

| Risk | Sannolikhet | Mitigering |
|---|---|---|
| **Permanent dataförlust på live-fält** | **Säker om inget görs** | Fas 0-daemon **nu** — `odds`/`fund`/streckrörelse nollställs vid avgjord omgång och kan aldrig återskapas |
| Ingen verklig edge efter avdrag (40,3 %) | **Hög** | Beslutsgrind fas 2 *före* UI-bygge; appens värde är även disciplin + mätning |
| ~~α stabiliserar sig inte~~ | **AVFÖRD** | Kalibrerad 2026-08-26: α̂=1,068, grupperna inom 1,06–1,10, medianresidual ~0. En skalär räcker (§6.3) |
| Backtestens tidsskevhet (öppningsodds vs slutstreck) | **Säker, ~1,1 pp** | δ-känslighetskurva {0; 0,5; 1; 1,5; 2} pp i stället för gissad rabatt; mät verklig drift ur fas 0-snapshots |
| Självbedrägeri vid tröskeltrimning | Hög | Förregistrerat rutnät, testmängd rörs en gång, redovisa ROI både med och utan 13-gruppen |
| Svenska Spel stänger/ändrar API:t | Medel | Abstraktionslager, egna snapshots, skrapfallback |
| Rate limits / blockering av skrapning | Medel | Låg frekvens, caching, GitHub Actions med backoff |
| Spelproblem/tilt | — | Fast insats + hårt tak (ej Kelly), ingen "öka efter förlust"-funktionalitet, insatslogg synlig |

**Juridiskt:** eget bruk av publika API:er för analys är okontroversiellt; automatisk inlämning är inte tillåten och byggs inte. Appen är privat (bakom inlogg/obfuskerad URL) och delar inte Svenska Spels data vidare.

---

## 9. Öppna frågor

1. ~~**Annonseras den extra potten till 13-gruppen före spelstopp?**~~ **BESVARAD 2026-09-01: NEJ.**
   Omgång 4968 fick extrapott (13-andel 0,439 mot bas 0,26 — cirka +5,3 Mkr). Daemonen fångade 15 snapshots från 72,9 h till 2,9 h före spelstopp: `fund` och `extraInfo` var **null i samtliga**. Genomgång av alla 23 toppnivåfält i sista snapshot före spelstopp visar inget fält som signalerar potten.
   **Konsekvens:** extrapotten går inte att observera i förväg via detta API, och är därmed inte spelbar som signal. Den kan bara estimeras statistiskt (~40 % av omgångarna) eller upptäckas i efterhand. Det spåret är därmed stängt om inte en annan källa hittas (t.ex. Svenska Spels egen kommunikation/kampanjsidor).
2. **Exakt tröskel för 10-gruppens minimiutdelning** — uppskattad till ~230 000 vinnare, bör fastställas exakt ur arkivet.
3. **Vad förklarar överskottet till 13-gruppen?** Bomben-kopplad pott via `bombenDrawNum`? Marknadsföringspott? Avgör om det är prediktbart.
4. Ska Topptipset (kräver API-nyckel från Svenska Spel — värt att ansöka?) och Powerplay in i scope senare?
5. Spelfil via ombud (butiksinlämning av stora system) — hur funkar det i praktiken 2026?
6. Vill vi logga *faktiskt spelade* system i appen (manuell inmatning) för äkta ROI-tracking? (Rekommenderas.)
7. Namn på appen. "Edge" är arbetsnamn — förslag välkomna.

---

## 12. Fas 2: backtestresultat — BESLUTSGRINDEN (2026-08-26)

**Ingen edge påvisad. Grinden gav NEJ.**

Backtest över 147 träningsomgångar (4721–4868). Testmängden (99 omgångar) är fortfarande orörd.

| EV-tröskel | Trimmad ROI | Rå ROI | Andel från EN vinst |
|---|---|---|---|
| 1,0 | **−97,6 %** | −8,7 % | 88 % |
| 1,1 | **−98,0 %** | −1,7 % | 90 % |
| 1,2 | **−97,9 %** | +9,4 % | 92 % |
| 1,3 | **−96,1 %** | +24,6 % | 92 % |
| 1,5 | **−93,7 %** | +71,1 % | 92 % |

δ-känslighetskurvan är platt negativ: trimmad ROI −97,6 % till −97,9 % för alla δ ∈ {0; 0,5; 1,0; 1,5; 2,0} pp.

**Varför de råa plussiffrorna inte är en edge:** 88–92 % av all avkastning kommer från *en enda vinst*. Att exkludera 13-gruppen ändrar ingenting (identiska siffror), eftersom vinsten låg i 12-gruppen. Det är brus.

### Två metodfynd värda att behålla

**1. Optimizer's curse.** Att maximera modell-EV över hela radrymden maximerar *modellfel*, inte värde. Omgång 4721: toppraden fick modell-EV 8,58 kr/kr och förutsades ha 1,11 medvinnare på 12 rätt. Faktiskt antal: **8 506** — fel med faktor ~7 700. Radens utfall: 4 rätt, 0 kr.

α-modellen är inte trasig — på facitrader ligger kvoten modell/faktiskt på 0,7–1,8. Men den kalibrerades *på facitrader* och extrapolerar katastrofalt på de extremrader en fri sökning plockar. Motgiftet (`topEvRowsConstrained`, krav på minsta 13-sannolikhet) förbättrar rått utfall från −94,6 % till −22,7 %, men inte till plus.

**2. Varken medelvärde eller median duger som huvudmått.** Medelvärdet domineras av enstaka träffar (en 13-träff vände −78 % till +363 %). Medianen är alltid −100 % eftersom de flesta omgångar ger noll. Bootstrap-p50 hjälper inte — träffen ligger i nästan varje resampling. **Trimmat medelvärde (±5 %)** är måttet som svarar på "bär strategin utan tur?".

### Vad detta betyder

Enligt beslutsgrinden i §7: **bygg ingen systemgenerator.** Det utfallet är ett resultat, inte ett misslyckande — det var precis vad grinden fanns till för att avgöra, och den kostade fas 0–2 i stället för månader av spelande.

Vad som *inte* är uteslutet, och som kan prövas härnäst om intresse finns:

- ~~**Extrapott-signalen**~~ — **stängd 2026-09-01.** Potten annonseras inte före spelstopp (§9.1), så den går inte att spela på. Verifierat mot omgång 4968, som fick +5,3 Mkr utan förvarning i något API-fält.
- **Europatipset** (551 omgångar) är ännu inte backtestat.
- **V75/V85** — travdatan har ingen marknadsoddsgenväg och är ett separat problem.

Appen har fortfarande värde som analysverktyg och som mätinstrument: streckrörelse, felstreckningar, kalibreringslogg. Men den ska inte generera spelförslag på nuvarande grund.

---

## 11. Fas 0-spike: resultat (2026-08-26)

Utförd mot live-API:er. Alla siffror nedan är uppmätta, inte antagna.

**Verifierat fungerande:**

| Källa | Status |
|---|---|
| `api.www.svenskaspel.se/draw/1/stryktipset/draws` | 200, 13 matcher, streck + odds + startOdds + betMetrics |
| `.../draw/1/europatipset/draws` | 200, identisk struktur, 1 kr/rad |
| `.../draws/{n}` och `.../draws/{n}/result` | 200 tillbaka till #4267 (2013); utdelningstabell + facit |
| `atg.se/services/racinginfo/v1/api/calendar/day/{datum}` | 200, spel per dag |
| `.../api/games/{gameId}` | 200, startlistor med barfota/sulky/spår + streck + vinnarodds |

**Fynd som ändrade planen:**

1. **248 backtestbara omgångar** (4720–4967) med öppningsodds + slutstreck + facit + verklig utdelning → beslutsgrinden kan köras före UI.
2. **Utbetalning 59,7 %, inte 65 %.** 13-gruppen bara 26 %. PRD:ns EV-formel överskattade 13-radens EV ~2,5× → §6 omskriven.
3. **Extra pott i ~40 % av omgångarna** (13-andel upp till 0,73) → sannolikt appens starkaste signal.
4. **Minimiutdelningsregel i 10-gruppen** (~30 % av omgångarna betalar noll där).
5. **Ingen historik-endpoint** → arkivets tidsskevhet ~1,1 pp är irreducerbar, hanteras som känslighetskurva.

**ATG-detaljer att inte snubbla på:** vinnarodds i hundradelar (989 = 9,89). `betDistribution` i **hundradelar av procent** (404 = 4,04 %) — summerar till 10000 per lopp, verifierat i V85/V86/V5/V4. *(Ett första antagande om tiondels procent var fel och gav 10× för höga streckprocent; skalan bekräftades genom att summera per lopp.)* Lagra nativt heltal, konvertera först vid presentation. Kalendern roterar mellan V75/V85/V65/V64 m.fl. — pooltyp måste vara kolumn, aldrig hårdkodad.

### Fas 1-resultat (2026-08-26)

**α-kalibreringen lyckades.** 246 omgångar, 984 vinnarobservationer, MLE över α:

- **α̂ = 1,068.** Per vinstgrupp: 13→1,101, 12→1,093, 11→1,080, 10→1,063.
- Grupperna ligger inom 1,06–1,10 ⇒ **en skalär räcker**, ingen α per grupp behövs.
- Medianresidualer −0,007 till −0,012 i log10 (~2 % fel). Inom faktor 2: 79 % (13 rätt), 92 %, 97 %, 99 %.

Detta avför den största risken (R1 i planen): om α inte stabiliserat sig hade inget nedströms varit värt att bygga.

**Rättelse av två tidigare antaganden:**

1. Minimiutdelningsgränsen är **~15 kr**, inte 1 kr. Verifierat mot 98 omgångar med ren separation (14,40 vs 16,24 kr). Inträffar i 23 av 98 omgångar.
2. Oberoende-antagandet är en **måttlig** felkälla, inte katastrofal. Kontroll mot omgång 4967 visar 1,2–1,3× fel på de stora grupperna, inte storleksordningar. α=1,068 pressar felet till 0,99–1,14×.

**Vad fas 1 *inte* visade:** om det finns en edge. Modellen kan nu förutsäga medvinnare väl, men det säger inget om huruvida `p_marknad` vs `p_streck`-divergensen överlever 40,3 % avdrag. Det avgörs av fas 2.

---

**Vad spiken *inte* visade:** att det finns en edge. Signalen är synlig i datan (tydliga divergenser mellan streck och odds i både fotboll och trav), men om den överlever 40,3 % avdrag avgörs först av backtesten i fas 2. Detta är två olika påståenden och ska hållas isär.

---

## 10. Definition av framgång

- **3 månader:** Appen används varje omgång; alla prognoser loggas; noll manuellt datahämtande.
- **6 månader:** Backtest + live-kalibrering ger ett ärligt svar på om metoden har positiv förväntan.
- **12 månader:** Antingen en dokumenterad edge som spelas disciplinerat — eller ett riktigt bra analysverktyg och en rolig historia. Båda räknas.
