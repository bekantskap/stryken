import {
  pgTable,
  serial,
  integer,
  bigint,
  smallint,
  text,
  timestamp,
  numeric,
  jsonb,
  char,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core'

/**
 * Fas 0-schema. Se prd-edge.md §6 och planen.
 *
 * Bärande designbeslut: arkivraden är inte en egen form utan ett degenererat
 * specialfall av snapshot. Ett schema, inte två. Nullbarheten bär skillnaden:
 * start_odds_* finns alltid, odds_* bara live (nollställs när omgången avgörs).
 */

// ---------------------------------------------------------------------------
// Fotboll: Stryktipset / Europatipset
// ---------------------------------------------------------------------------

export const draw = pgTable(
  'draw',
  {
    id: serial('id').primaryKey(),
    /** 'stryktipset' | 'europatipset' */
    product: text('product').notNull(),
    drawNumber: integer('draw_number').notNull(),
    openAt: timestamp('open_at', { withTimezone: true }),
    closeAt: timestamp('close_at', { withTimezone: true }).notNull(),
    /** Nettoomsättning i öre. Aldrig float — se parseAmountToOre(). */
    netSaleOre: bigint('net_sale_ore', { mode: 'bigint' }),
    /** Radpris i öre. Verifierat 100 (1,00 kr) för båda produkterna. */
    rowPriceOre: integer('row_price_ore'),
    /** Kopplad Bomben-omgång. Misstänkt källa till extrapotten — se §9 fråga 3. */
    bombenDrawNumber: integer('bomben_draw_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('draw_product_number_uq').on(t.product, t.drawNumber)],
)

export const event = pgTable(
  'event',
  {
    id: serial('id').primaryKey(),
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id, { onDelete: 'cascade' }),
    /** 1..13 */
    eventNumber: smallint('event_number').notNull(),
    home: text('home').notNull(),
    away: text('away').notNull(),
    league: text('league'),
    kickoffAt: timestamp('kickoff_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('event_draw_number_uq').on(t.drawId, t.eventNumber)],
)

/**
 * Join-punkten. Många rader per omgång live, exakt en för arkivimport.
 */
export const snapshot = pgTable(
  'snapshot',
  {
    id: serial('id').primaryKey(),
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    /** 'live' | 'archive' */
    source: text('source').notNull(),
    /** Timmar kvar till spelstopp vid capture. Analysaxeln för streckrörelse. */
    hoursToClose: numeric('hours_to_close', { precision: 10, scale: 4 }),
    /**
     * Fullt API-svar. Inte valfritt: betMetrics och fund har struktur som ännu
     * inte utvunnits, och live-fält går inte att hämta om i efterhand.
     */
    raw: jsonb('raw').notNull(),
  },
  (t) => [
    uniqueIndex('snapshot_draw_captured_uq').on(t.drawId, t.capturedAt),
    index('snapshot_draw_source_idx').on(t.drawId, t.source),
  ],
)

export const eventSnapshot = pgTable(
  'event_snapshot',
  {
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => snapshot.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),

    /** Streckprocent normaliserad mot radsumman → summerar exakt till 1. */
    dist1: numeric('dist_1', { precision: 10, scale: 8 }).notNull(),
    distX: numeric('dist_x', { precision: 10, scale: 8 }).notNull(),
    dist2: numeric('dist_2', { precision: 10, scale: 8 }).notNull(),

    /** Live-odds. NULL på avgjorda omgångar — nollställs av Svenska Spel. */
    odds1: numeric('odds_1', { precision: 10, scale: 4 }),
    oddsX: numeric('odds_x', { precision: 10, scale: 4 }),
    odds2: numeric('odds_2', { precision: 10, scale: 4 }),

    /** Öppningsodds. Behålls i hela arkivet → backtestens p_marknad-källa. */
    startOdds1: numeric('start_odds_1', { precision: 10, scale: 4 }),
    startOddsX: numeric('start_odds_x', { precision: 10, scale: 4 }),
    startOdds2: numeric('start_odds_2', { precision: 10, scale: 4 }),

    /** betMetrics.refDistribution — föregående streck-snapshot. */
    refDist1: numeric('ref_dist_1', { precision: 10, scale: 8 }),
    refDistX: numeric('ref_dist_x', { precision: 10, scale: 8 }),
    refDist2: numeric('ref_dist_2', { precision: 10, scale: 8 }),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.eventId] })],
)

export const result = pgTable(
  'result',
  {
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    /** '1' | 'X' | '2' */
    outcome: char('outcome', { length: 1 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.drawId, t.eventId] })],
)

/**
 * Kalibreringsmålet för medvinnarmodellen (§6.3). Skydda denna tabell —
 * hela α-anpassningen vilar på den.
 */
export const payoutTier = pgTable(
  'payout_tier',
  {
    drawId: integer('draw_id')
      .notNull()
      .references(() => draw.id, { onDelete: 'cascade' }),
    /** 13 | 12 | 11 | 10 */
    tier: smallint('tier').notNull(),
    winners: integer('winners').notNull(),
    /**
     * Utdelning per vinnare i öre. 0 är ett giltigt värde och betyder att
     * minimiutdelningsregeln slog till (§6.1) — inte att data saknas.
     */
    amountOre: bigint('amount_ore', { mode: 'bigint' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.drawId, t.tier] })],
)

/**
 * Ärlighetsliggaren (F5). Append-only — aldrig UPDATE.
 * model_version + snapshot_id gör varje påstående reproducerbart.
 */
export const prediction = pgTable('prediction', {
  id: serial('id').primaryKey(),
  drawId: integer('draw_id')
    .notNull()
    .references(() => draw.id, { onDelete: 'cascade' }),
  snapshotId: integer('snapshot_id')
    .notNull()
    .references(() => snapshot.id, { onDelete: 'cascade' }),
  modelVersion: text('model_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  params: jsonb('params'),
})

export const predictionEvent = pgTable(
  'prediction_event',
  {
    predictionId: integer('prediction_id')
      .notNull()
      .references(() => prediction.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    p1: numeric('p_1', { precision: 10, scale: 8 }).notNull(),
    pX: numeric('p_x', { precision: 10, scale: 8 }).notNull(),
    p2: numeric('p_2', { precision: 10, scale: 8 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.predictionId, t.eventId] })],
)

// ---------------------------------------------------------------------------
// Trav: V75/V85/V65/V64...
//
// Separat schema — formen skiljer sig genuint (variabel fältstorlek, roterande
// pooltyper). Pooltyp är kolumn, aldrig tabellnamn: kalendern roterar.
// ---------------------------------------------------------------------------

export const raceGame = pgTable(
  'race_game',
  {
    id: serial('id').primaryKey(),
    /** ATG:s gameId, t.ex. 'V85_2026-08-29_9_5' */
    gameId: text('game_id').notNull(),
    /** 'V75' | 'V85' | 'V65' | ... — aldrig hårdkodad */
    poolType: text('pool_type').notNull(),
    raceDate: text('race_date').notNull(),
    startTime: timestamp('start_time', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('race_game_gameid_uq').on(t.gameId)],
)

export const raceSnapshot = pgTable(
  'race_snapshot',
  {
    id: serial('id').primaryKey(),
    gameId: integer('game_id')
      .notNull()
      .references(() => raceGame.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    raw: jsonb('raw').notNull(),
  },
  (t) => [uniqueIndex('race_snapshot_game_captured_uq').on(t.gameId, t.capturedAt)],
)

export const raceStart = pgTable(
  'race_start',
  {
    id: serial('id').primaryKey(),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => raceSnapshot.id, { onDelete: 'cascade' }),
    raceNumber: smallint('race_number').notNull(),
    startNumber: smallint('start_number').notNull(),
    horseName: text('horse_name'),
    postPosition: smallint('post_position'),
    /**
     * ATG:s nativa heltalsskalor — lagras okonverterade, konverteras först vid
     * presentation. Att konvertera för tidigt är där skalorna tyst byter plats.
     *
     * odds: hundradelar. 989 = 9,89x.
     * betDistribution: hundradelar av procent (basispunkter). 404 = 4,04 %.
     *   Verifierat 2026-08-26: summerar till 10000 per lopp i V85/V86/V5/V4.
     *   (Ett tidigare antagande om tiondels procent var fel — kolumnen hette
     *   bet_dist_tenths och gav 10× för höga streckprocent.)
     */
    winOddsHundredths: integer('win_odds_hundredths'),
    betDistBps: integer('bet_dist_bps'),
    trend: numeric('trend', { precision: 12, scale: 8 }),
    /** Barfota: true = har sko. front/back separat, plus changed-flagga. */
    shoeFront: text('shoe_front'),
    shoeBack: text('shoe_back'),
    sulkyType: text('sulky_type'),
  },
  (t) => [
    uniqueIndex('race_start_uq').on(t.snapshotId, t.raceNumber, t.startNumber),
  ],
)
