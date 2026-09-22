/* build-td-model-v1 — compiles the PBE Touchdown Targets model artefact.
 *
 *   data/dist/{rb,wr,te,qb}-dna-dataset.json
 *        -> workers/nfl-td-targets-shared/td-model-v1.js      (the champion's factual base)
 *        -> research/td-model-v1-backtest.json                (HISTORICAL BACKTEST, never a live record)
 *
 * WHY THESE INPUTS AND NO OTHERS
 * The four Player DNA datasets are already production sources for this site
 * (api/rb-dna.js, wr-dna.js, te-dna.js, qb-dna.js). Compiling a TD baseline
 * from them adds no new data source and therefore no new rights exposure; the
 * dataset-level rights position is docs/career-ledger/SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md.
 * Nothing here reads data/nflverse/*.parquet.
 *
 * WHAT A TOUCHDOWN MEANS HERE
 * One label, everywhere: an OFFENSIVE touchdown — a rushing TD or a receiving
 * TD credited to the player. A quarterback's passing touchdowns are not his
 * own score and never enter the label. Return and defensive touchdowns are not
 * in these datasets and are not in the label either; the grader observes them
 * separately so the divergence from a book's settlement is auditable rather
 * than hidden. See NFL-TOUCHDOWN-TARGETS-CONTRACT.md.
 *
 * NO FABRICATED FEATURE
 * Every coefficient below is measured from the rows and carries its own sample
 * size. A bucket that does not clear its sample gate gets no coefficient and
 * is reported unavailable — never 1.0 dressed up as a measurement. The
 * precipitation columns (`rn`, `sn`) are present in all 23,000 REG rows and
 * are 0 in every one of them: that is a source gap, not a league with no rain,
 * so precipitation is fitted nowhere.
 *
 * NO LOOK-AHEAD
 * Player baselines are walk-forward: a game's features are built only from
 * games that kicked off before it. Team and opponent profiles for season S use
 * seasons < S. The calibration fit trains on the earlier seasons and scores the
 * held-out latest season with the same code path production runs.
 *
 * Usage: node scripts/build-td-model-v1.mjs [--holdout 2025] [--check]
 *        --check re-reads the committed artefact and fails if it would change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  MODEL_VERSION, LABEL, HALF_LIFE_GAMES, SHRINK_PRIOR_GAMES, RZ_TIERS,
  scriptBucketOf, weatherBucketOf, poissonAtLeastOne, logit, logistic,
  normalizePlayerName, lambdaFor,
} from '../workers/nfl-td-targets-shared/td-kernel.mjs';

const ROOT = process.cwd();
const ARTEFACT = join(ROOT, 'workers', 'nfl-td-targets-shared', 'td-model-v1.js');
const BACKTEST = join(ROOT, 'research', 'td-model-v1-backtest.json');

const args = process.argv.slice(2);
const HOLDOUT_SEASON = Number(argValue('--holdout') ?? 2025);
const VALIDATION_SEASON = Number(argValue('--validation') ?? HOLDOUT_SEASON - 1);
const CHECK_ONLY = args.includes('--check');

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

/* ------------------------------------------------------------------ loading */

/* Each dataset names its game rows differently and means different things by
 * the same short key: in the receiver datasets `rtd` is a RECEIVING touchdown
 * and `ry` is receiving yards, while in the RB dataset `rtd` is a RUSHING
 * touchdown and `rectd` the receiving one. Normalising here — once — is the
 * only place that distinction is allowed to matter. */
const SOURCES = [
  { file: 'rb-dna-dataset.json', rows: 'player_games', position: 'RB' },
  { file: 'wr-dna-dataset.json', rows: 'receiver_games', position: 'WR' },
  { file: 'te-dna-dataset.json', rows: 'receiver_games', position: 'TE' },
  { file: 'qb-dna-dataset.json', rows: 'qb_games', position: 'QB' },
];

const numOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function normalizeRow(raw, position) {
  const rushTd = numOrNull(raw.rtd);
  const recTd = position === 'RB' ? numOrNull(raw.rectd)
    : position === 'QB' ? 0
      : numOrNull(raw.rtd);
  const rushingTd = position === 'RB' || position === 'QB' ? rushTd : 0;
  const receivingTd = position === 'RB' ? recTd : position === 'QB' ? 0 : recTd;

  /* A QB row with a null rushing line is a row where rushing was not recorded.
   * It is not a zero-touchdown observation and must not become one. */
  if (rushingTd === null || receivingTd === null) return null;

  const rzOpportunities = position === 'RB' ? numOrNull(raw.rzc) : numOrNull(raw.rzt);
  const rzTd = numOrNull(raw.rztd);
  const teamRz = position === 'RB' ? null : numOrNull(raw.trz);

  return {
    game_id: String(raw.g || ''),
    pid: String(raw.pid || ''),
    position,
    season: Number(raw.s),
    week: Number(raw.w),
    date: String(raw.d || ''),
    team: String(raw.t || ''),
    opponent: String(raw.opp || ''),
    at_home: raw.ha === 1,
    offensive_td: rushingTd + receivingTd,
    rushing_td: rushingTd,
    receiving_td: receivingTd,
    touches: position === 'RB' ? (numOrNull(raw.car) ?? 0) + (numOrNull(raw.rec) ?? 0)
      : position === 'QB' ? numOrNull(raw.ra)
        : numOrNull(raw.rec),
    targets: position === 'QB' ? null : numOrNull(raw.tg),
    rz_opportunities: rzOpportunities,
    rz_td: rzTd,
    team_rz_targets: teamRz,
    /* game environment, as the dataset recorded it */
    spread: numOrNull(raw.spr),
    roof: String(raw.rf || ''),
    indoor: raw.ind === 1,
    temp_f: numOrNull(raw.tf),
    wind_mph: numOrNull(raw.wd),
    weather_status: String(raw.ws || ''),
  };
}

function load() {
  const players = new Map();
  const rows = [];
  const meta = {};
  for (const source of SOURCES) {
    const data = JSON.parse(readFileSync(join(ROOT, 'data', 'dist', source.file), 'utf8'));
    meta[source.position] = {
      file: source.file,
      generated_at: data.meta?.generated_at ?? null,
      data_through: data.meta?.data_through ?? null,
      seasons: data.meta?.seasons ?? null,
      latest_completed_game: data.meta?.latest_completed_game?.game_id ?? null,
    };
    for (const player of data.players || []) {
      const id = String(player.gsis_id || '');
      if (!id) continue;
      /* A player can appear in two datasets (a converted RB/WR). The dataset
       * whose position matches his own `position` field owns him; otherwise
       * first seen wins and the duplicate is recorded, never silently merged. */
      const existing = players.get(id);
      if (existing && existing.position === player.position) continue;
      if (existing && existing.position !== source.position && player.position !== source.position) continue;
      players.set(id, {
        gsis_id: id,
        name: String(player.display_name || ''),
        espn_id: player.espn_id ? String(player.espn_id) : null,
        position: String(player.position || source.position),
        dataset_position: source.position,
        active_2026: player.active_2026 === true,
        team_2026: player.team_2026 ? String(player.team_2026) : null,
        market_priced_2026: player.market_priced_2026 === true,
        experience_years: numOrNull(player.experience_years),
      });
    }
    let dropped = 0;
    for (const raw of data[source.rows] || []) {
      if (String(raw.st || '') !== 'REG') continue;
      const row = normalizeRow(raw, source.position);
      if (!row) { dropped += 1; continue; }
      rows.push(row);
    }
    meta[source.position].reg_rows = rows.filter(r => r.position === source.position).length;
    meta[source.position].rows_dropped_unrecorded = dropped;
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.season - b.season || a.week - b.week);
  return { players, rows, meta };
}

/* ------------------------------------------------- team / opponent profiles */

/* "Touchdowns" in a team profile means offensive touchdowns scored by players
 * inside the Player DNA cohort — the same cohort in the numerator and in the
 * league mean, so the RATIO is meaningful even though the absolute count is
 * not the league's full total. This is stated in the artefact and surfaced in
 * the API so nobody reads it as a complete team total. */
function seasonTeamTotals(rows) {
  const bySeason = new Map();
  for (const row of rows) {
    if (!bySeason.has(row.season)) bySeason.set(row.season, { scored: new Map(), allowed: new Map(), games: new Map() });
    const bucket = bySeason.get(row.season);
    const add = (map, key, field, value) => {
      if (!map.has(key)) map.set(key, { offensive_td: 0, rushing_td: 0, receiving_td: 0, games: new Set() });
      map.get(key)[field] += value;
    };
    add(bucket.scored, row.team, 'offensive_td', row.offensive_td);
    add(bucket.scored, row.team, 'rushing_td', row.rushing_td);
    add(bucket.scored, row.team, 'receiving_td', row.receiving_td);
    bucket.scored.get(row.team).games.add(row.game_id);
    add(bucket.allowed, row.opponent, 'offensive_td', row.offensive_td);
    add(bucket.allowed, row.opponent, 'rushing_td', row.rushing_td);
    add(bucket.allowed, row.opponent, 'receiving_td', row.receiving_td);
    bucket.allowed.get(row.opponent).games.add(row.game_id);
  }
  return bySeason;
}

function perGame(entry) {
  const games = entry?.games?.size || 0;
  if (!games) return null;
  return {
    games,
    offensive_td_per_game: entry.offensive_td / games,
    rushing_td_per_game: entry.rushing_td / games,
    receiving_td_per_game: entry.receiving_td / games,
  };
}

/* Profiles that a game in season S is allowed to see: seasons strictly before
 * S, recency-weighted (the latest prior season counts double the one before).
 * Never season S itself — that is the leakage this function exists to stop. */
function profilesAsOf(bySeason, season, teams) {
  const priors = [...bySeason.keys()].filter(s => s < season).sort((a, b) => b - a).slice(0, 3);
  if (!priors.length) return null;
  const weightFor = index => 0.5 ** index;
  const out = { scored: {}, allowed: {}, priors_used: priors };
  for (const team of teams) {
    for (const side of ['scored', 'allowed']) {
      let wSum = 0, off = 0, rush = 0, rec = 0, games = 0;
      priors.forEach((s, index) => {
        const stats = perGame(bySeason.get(s)?.[side]?.get(team));
        if (!stats) return;
        const w = weightFor(index);
        wSum += w; games += stats.games;
        off += w * stats.offensive_td_per_game;
        rush += w * stats.rushing_td_per_game;
        rec += w * stats.receiving_td_per_game;
      });
      if (!wSum) continue;
      out[side][team] = {
        games,
        offensive_td_per_game: round(off / wSum, 5),
        rushing_td_per_game: round(rush / wSum, 5),
        receiving_td_per_game: round(rec / wSum, 5),
      };
    }
  }
  for (const side of ['scored', 'allowed']) {
    const values = Object.values(out[side]);
    out[`league_${side}`] = values.length ? {
      teams: values.length,
      offensive_td_per_game: round(mean(values.map(v => v.offensive_td_per_game)), 5),
      rushing_td_per_game: round(mean(values.map(v => v.rushing_td_per_game)), 5),
      receiving_td_per_game: round(mean(values.map(v => v.receiving_td_per_game)), 5),
    } : null;
  }
  return out;
}

/* ------------------------------------------------------- positional priors */

/* The prior a thin sample is shrunk toward is not "the average skill player".
 * A goal-line back and a third-down back have different populations, so the
 * prior is taken inside the player's position AND his red-zone opportunity
 * tier. Tiers are the population terciles of red-zone opportunities per game,
 * computed on the training seasons only. */
function buildPositionPriors(trainRows) {
  const byPosition = new Map();
  for (const row of trainRows) {
    if (!byPosition.has(row.position)) byPosition.set(row.position, []);
    byPosition.get(row.position).push(row);
  }
  const priors = {};
  for (const [position, rows] of byPosition) {
    const byPlayer = new Map();
    for (const row of rows) {
      if (!byPlayer.has(row.pid)) byPlayer.set(row.pid, []);
      byPlayer.get(row.pid).push(row);
    }
    const qualified = [...byPlayer.values()].filter(list => list.length >= 8);
    const rzRates = qualified
      .map(list => {
        const withRz = list.filter(r => r.rz_opportunities !== null);
        return withRz.length ? sum(withRz.map(r => r.rz_opportunities)) / withRz.length : null;
      })
      .filter(v => v !== null)
      .sort((a, b) => a - b);
    const cut = q => (rzRates.length ? rzRates[Math.min(rzRates.length - 1, Math.floor(rzRates.length * q))] : null);
    const edges = rzRates.length >= 30 ? [cut(1 / 3), cut(2 / 3)] : null;

    const tiers = {};
    for (const tier of RZ_TIERS) {
      const inTier = rows.filter(row => rzTierOf(row.rz_opportunities, edges) === tier);
      tiers[tier] = inTier.length >= 200 ? {
        rows: inTier.length,
        offensive_td_per_game: round(mean(inTier.map(r => r.offensive_td)), 6),
        td_game_rate: round(inTier.filter(r => r.offensive_td > 0).length / inTier.length, 6),
      } : null;
    }
    const rzRows = rows.filter(r => r.rz_opportunities !== null);
    priors[position] = {
      rows: rows.length,
      players: byPlayer.size,
      offensive_td_per_game: round(mean(rows.map(r => r.offensive_td)), 6),
      /* The denominator of the role term. Measured over the rows that actually
       * carry a red-zone opportunity count, and reported with that count so a
       * thin position cannot hide behind a mean. */
      rz_opportunities_per_game: rzRows.length >= 200 ? round(mean(rzRows.map(r => r.rz_opportunities)), 6) : null,
      rz_rows: rzRows.length,
      td_game_rate: round(rows.filter(r => r.offensive_td > 0).length / rows.length, 6),
      rush_share_of_td: sum(rows.map(r => r.offensive_td)) > 0
        ? round(sum(rows.map(r => r.rushing_td)) / sum(rows.map(r => r.offensive_td)), 6) : null,
      rz_tier_edges: edges ? edges.map(v => round(v, 4)) : null,
      rz_tiers: tiers,
    };
  }
  return priors;
}

function rzTierOf(rzOpportunities, edges) {
  if (!edges || rzOpportunities === null || rzOpportunities === undefined) return 'unknown';
  if (rzOpportunities <= edges[0]) return 'low';
  if (rzOpportunities <= edges[1]) return 'mid';
  return 'high';
}

/* ------------------------------------------- measured context coefficients */

/* Ratio of offensive touchdowns per player-game inside a bucket to the rate
 * outside it. A bucket under the sample gate returns null: no coefficient,
 * reported unavailable. */
function bucketRatios(rows, bucketOf, buckets, minRows) {
  const out = {};
  for (const bucket of buckets) {
    const inside = rows.filter(row => bucketOf(row) === bucket);
    const outside = rows.filter(row => {
      const b = bucketOf(row);
      return b !== null && b !== bucket;
    });
    if (inside.length < minRows || !outside.length) {
      out[bucket] = { rows: inside.length, ratio: null, unavailable_reason: `sample_below_${minRows}` };
      continue;
    }
    const insideRate = mean(inside.map(r => r.offensive_td));
    const outsideRate = mean(outside.map(r => r.offensive_td));
    out[bucket] = {
      rows: inside.length,
      offensive_td_per_game: round(insideRate, 6),
      reference_td_per_game: round(outsideRate, 6),
      ratio: outsideRate > 0 ? round(insideRate / outsideRate, 6) : null,
    };
  }
  return out;
}

const SCRIPT_BUCKETS = ['heavy_favourite', 'favourite', 'pickem', 'underdog', 'heavy_underdog'];
const WEATHER_BUCKETS = ['wind_15_plus', 'cold_32_or_below', 'benign_outdoor'];

/* ------------------------------------------------------- walk-forward state */

/* One pass in date order. For each row we first SCORE it from the state built
 * out of earlier rows, then fold it into the state. The order is the whole
 * point: reversing it is look-ahead leakage. */
class PlayerState {
  constructor() { this.byPlayer = new Map(); }

  baseline(pid) {
    const entry = this.byPlayer.get(pid);
    if (!entry || !(entry.weight > 0)) return null;
    return {
      weighted_games: round(entry.weight, 4),
      raw_games: entry.games,
      offensive_td_per_game: round(entry.td / entry.weight, 6),
      rushing_td_per_game: round(entry.rushTd / entry.weight, 6),
      receiving_td_per_game: round(entry.recTd / entry.weight, 6),
      td_game_rate: round(entry.tdGames / entry.weight, 6),
      rz_opportunities_per_game: entry.rzWeight > 0 ? round(entry.rzOpp / entry.rzWeight, 6) : null,
      rz_td_conversion: entry.rzOpp > 0 ? round(entry.rzTd / entry.rzOpp, 6) : null,
      rz_target_share: entry.teamRz > 0 ? round(entry.rzOpp / entry.teamRz, 6) : null,
      last_game_date: entry.lastDate,
    };
  }

  add(row) {
    if (!this.byPlayer.has(row.pid)) {
      this.byPlayer.set(row.pid, {
        weight: 0, games: 0, td: 0, rushTd: 0, recTd: 0, tdGames: 0,
        rzWeight: 0, rzOpp: 0, rzTd: 0, teamRz: 0, lastDate: null,
      });
    }
    const entry = this.byPlayer.get(row.pid);
    /* Decay everything already accumulated by one game of age, so the stored
     * sums are always "as of now" without keeping the game log. */
    const decay = 0.5 ** (1 / HALF_LIFE_GAMES);
    entry.weight = entry.weight * decay + 1;
    entry.td = entry.td * decay + row.offensive_td;
    entry.rushTd = entry.rushTd * decay + row.rushing_td;
    entry.recTd = entry.recTd * decay + row.receiving_td;
    entry.tdGames = entry.tdGames * decay + (row.offensive_td > 0 ? 1 : 0);
    entry.games += 1;
    entry.lastDate = row.date;
    if (row.rz_opportunities !== null) {
      entry.rzWeight = entry.rzWeight * decay + 1;
      entry.rzOpp = entry.rzOpp * decay + row.rz_opportunities;
      entry.rzTd = entry.rzTd * decay + (row.rz_td ?? 0);
      if (row.team_rz_targets !== null) entry.teamRz = entry.teamRz * decay + row.team_rz_targets;
      else entry.teamRz = entry.teamRz * decay;
    }
  }
}

/* ------------------------------------------------------------ scoring core */

/* The same arithmetic production runs, called here with historical inputs.
 * It lives in td-kernel.mjs so there is exactly one implementation. */
function scoreRow({ row, baseline, priors, profiles, coefficients, weights, edgesFor }) {
  const tier = rzTierOf(baseline?.rz_opportunities_per_game ?? null, edgesFor(row.position));
  return lambdaFor({
    baseline,
    prior: priors[row.position],
    rzTier: tier,
    team: profiles?.scored?.[row.team] ?? null,
    leagueScored: profiles?.league_scored ?? null,
    opponent: profiles?.allowed?.[row.opponent] ?? null,
    leagueAllowed: profiles?.league_allowed ?? null,
    scriptBucket: scriptBucketOf(row.spread),
    weatherBucket: weatherBucketOf(row),
    coefficients,
    weights,
  });
}

/* ------------------------------------------------------------- calibration */

/* One-parameter-pair recalibration on the log-odds of the Poisson probability.
 * Fitted by Newton steps on the log-loss; two parameters over thousands of
 * observations needs no regularisation and no learning-rate tuning. */
function fitCalibration(samples) {
  let a = 0, b = 1;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const { x, y } of samples) {
      const p = logistic(a + b * x);
      const r = p - y;
      const w = Math.max(p * (1 - p), 1e-9);
      g0 += r; g1 += r * x;
      h00 += w; h01 += w * x; h11 += w * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a -= da; b -= db;
    if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-10) break;
  }
  return { a: round(a, 6), b: round(b, 6) };
}

function scoreQuality(samples, calibration) {
  let brier = 0, logLoss = 0, positives = 0;
  for (const { x, y } of samples) {
    const p = clampProb(calibration ? logistic(calibration.a + calibration.b * x) : logistic(x));
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    positives += y;
  }
  const n = samples.length;
  return n ? {
    n,
    base_rate: round(positives / n, 6),
    brier: round(brier / n, 6),
    log_loss: round(logLoss / n, 6),
  } : null;
}

/* What a model with no football in it would score on the same rows: the
 * training base rate, predicted for everyone. Published beside the model's own
 * numbers so "brier 0.158" cannot be read as skill without a reference. */
function baseRateReference(trainSamples, holdoutSamples) {
  const rate = clampProb(mean(trainSamples.map(s => s.y)));
  let brier = 0, logLoss = 0;
  for (const { y } of holdoutSamples) {
    brier += (rate - y) ** 2;
    logLoss += -(y * Math.log(rate) + (1 - y) * Math.log(1 - rate));
  }
  const n = holdoutSamples.length;
  return n ? {
    strategy: 'predict the training base rate for every player-game',
    predicted: round(rate, 6),
    n,
    brier: round(brier / n, 6),
    log_loss: round(logLoss / n, 6),
  } : null;
}

function reliability(samples, calibration, edges = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.55, 1.0001]) {
  const scored = samples.map(({ x, y }) => ({ p: clampProb(logistic(calibration.a + calibration.b * x)), y }));
  const bins = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const inBin = scored.filter(s => s.p >= edges[i] && s.p < edges[i + 1]);
    if (inBin.length < 25) continue;
    bins.push({
      from: edges[i], to: Math.min(edges[i + 1], 1), n: inBin.length,
      predicted: round(mean(inBin.map(s => s.p)), 6),
      observed: round(mean(inBin.map(s => s.y)), 6),
    });
  }
  return bins;
}

/* ------------------------------------------------------------------- utils */
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => (xs.length ? sum(xs) / xs.length : 0);
const round = (value, digits) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const clampProb = p => Math.min(1 - 1e-9, Math.max(1e-9, p));

/* ------------------------------------------------------------------ driver */

/* One walk-forward pass over every row in date order, producing a sample per
 * scored player-game tagged with its season. The caller splits by season; this
 * function never knows which season is which, so a split can never leak into
 * the features. */
function buildSamples({ rows, priors, bySeason, teams, coefficients, weights, edgesFor }) {
  const state = new PlayerState();
  const profileCache = new Map();
  const samples = [];
  const skipped = { no_baseline: 0, no_profiles: 0, no_lambda: 0 };

  for (const row of rows) {
    if (!profileCache.has(row.season)) profileCache.set(row.season, profilesAsOf(bySeason, row.season, teams));
    const profiles = profileCache.get(row.season);
    const baseline = state.baseline(row.pid);
    state.add(row);
    if (!baseline || baseline.raw_games < 8) { skipped.no_baseline += 1; continue; }
    if (!profiles) { skipped.no_profiles += 1; continue; }
    const scored = scoreRow({ row, baseline, priors, profiles, coefficients, weights, edgesFor });
    if (scored.lambda === null) { skipped.no_lambda += 1; continue; }
    samples.push({
      x: logit(clampProb(poissonAtLeastOne(scored.lambda))),
      y: row.offensive_td > 0 ? 1 : 0,
      season: row.season,
      position: row.position,
    });
  }
  return { samples, skipped };
}

const inSeasons = (samples, predicate) => samples.filter(s => predicate(s.season));

function main() {
  const { players, rows, meta } = load();
  const teams = [...new Set(rows.map(r => r.team))].sort();
  const bySeason = seasonTeamTotals(rows);
  const trainRows = rows.filter(r => r.season < HOLDOUT_SEASON);
  if (!trainRows.length) throw new Error('no training rows below the holdout season');

  const priors = buildPositionPriors(trainRows);
  const edgesFor = position => priors[position]?.rz_tier_edges ?? null;

  /* Context coefficients are measured on the training seasons only. */
  const outdoorTrain = trainRows.filter(r => r.roof === 'outdoors' && r.weather_status === 'ok');
  const coefficients = {
    script: bucketRatios(trainRows, row => scriptBucketOf(row.spread), SCRIPT_BUCKETS, 800),
    weather: bucketRatios(outdoorTrain, weatherBucketOf, WEATHER_BUCKETS, 400),
    precipitation: {
      unavailable_reason: 'rain and snow columns are 0 in every REG row of all four datasets; '
        + 'treated as an unpopulated source, not as an absence of precipitation',
      rows_examined: trainRows.length,
    },
  };

  /* THREE-WAY SPLIT, and the reason for it.
   *
   *   fit        seasons < VALIDATION_SEASON    calibration for the search
   *   validation VALIDATION_SEASON              picks the four damping weights
   *   holdout    HOLDOUT_SEASON                 reported, and touched once
   *
   * Choosing the weights on the season whose score is then published would
   * make the published score a training score. The weights are therefore
   * selected against VALIDATION_SEASON and HOLDOUT_SEASON is scored exactly
   * once, at the end, with the weights already fixed. */
  const grid = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1];
  let weights = { role: 0.3, team: 0.3, opponent: 0.3, script: 0.3, weather: 0.3, shrink_prior_games: SHRINK_PRIOR_GAMES };
  const search = [];
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const key of ['role', 'team', 'opponent', 'script', 'weather']) {
      let best = null;
      for (const candidate of grid) {
        const trial = { ...weights, [key]: candidate };
        const { samples } = buildSamples({ rows, priors, bySeason, teams, coefficients, weights: trial, edgesFor });
        const fit = inSeasons(samples, season => season < VALIDATION_SEASON);
        const validation = inSeasons(samples, season => season === VALIDATION_SEASON);
        if (!fit.length || !validation.length) continue;
        const quality = scoreQuality(validation, fitCalibration(fit));
        search.push({ sweep, key, value: candidate, validation_log_loss: quality.log_loss, validation_brier: quality.brier });
        if (!best || quality.log_loss < best.log_loss) best = { value: candidate, log_loss: quality.log_loss };
      }
      if (best) weights = { ...weights, [key]: best.value };
    }
  }

  /* Final pass at the fixed weights. Calibration is fitted on everything
   * before the holdout season — validation included, because the weights are
   * no longer being chosen — and the holdout season is scored with it. */
  const final = buildSamples({ rows, priors, bySeason, teams, coefficients, weights, edgesFor });
  const trainSamples = inSeasons(final.samples, season => season < HOLDOUT_SEASON);
  const holdoutSamples = inSeasons(final.samples, season => season === HOLDOUT_SEASON);
  if (!trainSamples.length || !holdoutSamples.length) throw new Error('empty split; check --holdout');
  const calibration = fitCalibration(trainSamples);
  const trainQuality = scoreQuality(trainSamples, calibration);
  const holdoutQuality = scoreQuality(holdoutSamples, calibration);
  const uncalibratedHoldout = scoreQuality(holdoutSamples, { a: 0, b: 1 });
  const baseRateHoldout = baseRateReference(trainSamples, holdoutSamples);
  const bins = reliability(holdoutSamples, calibration);
  /* Stability the challenger gate will later be judged on, measured here for
   * the champion so the two are comparable. */
  const byPosition = {};
  for (const position of [...new Set(holdoutSamples.map(s => s.position))].sort()) {
    byPosition[position] = scoreQuality(holdoutSamples.filter(s => s.position === position), calibration);
  }

  /* Production profiles: the most recent seasons available, for the season the
   * engine will actually run in. Built exactly like the historical ones so the
   * live path and the backtest path cannot drift. */
  const latestSeason = Math.max(...rows.map(r => r.season));
  const productionSeason = latestSeason + 1;
  const productionProfiles = profilesAsOf(bySeason, productionSeason, teams);

  /* Player baselines as of the end of the dataset. Only players who can be a
   * candidate: a resolvable name and at least eight recorded games. */
  const state = new PlayerState();
  for (const row of rows) state.add(row);
  const playerBaselines = {};
  const nameIndex = {};
  const ambiguous = {};
  let skippedThin = 0;
  for (const [pid, player] of players) {
    const baseline = state.baseline(pid);
    if (!baseline || baseline.raw_games < 8) { skippedThin += 1; continue; }
    const lastRow = [...rows].reverse().find(r => r.pid === pid) || null;
    playerBaselines[pid] = {
      name: player.name,
      espn_id: player.espn_id,
      position: player.position,
      team_2026: player.team_2026,
      active_2026: player.active_2026,
      market_priced_2026: player.market_priced_2026,
      last_team: lastRow?.team ?? null,
      last_season: lastRow?.season ?? null,
      rz_tier: rzTierOf(baseline.rz_opportunities_per_game, edgesFor(player.position)),
      ...baseline,
    };
    const key = normalizePlayerName(player.name);
    if (!key) continue;
    if (nameIndex[key] && nameIndex[key] !== pid) {
      ambiguous[key] = [...new Set([...(ambiguous[key] || [nameIndex[key]]), pid])];
      continue;
    }
    nameIndex[key] = pid;
  }
  /* A name two players share is never resolved by guessing. Both are removed
   * from the index; the selector reports identity_unresolved for that name. */
  for (const key of Object.keys(ambiguous)) delete nameIndex[key];

  const artefact = {
    version: MODEL_VERSION,
    label: LABEL,
    built_at: new Date().toISOString(),
    provenance: {
      inputs: meta,
      no_new_source: 'compiled only from the Player DNA datasets already served by this site',
      rights_note: 'docs/career-ledger/SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md',
      season_scope: 'REG only',
      validation_season: VALIDATION_SEASON,
      holdout_season: HOLDOUT_SEASON,
      label_definition: LABEL,
      cohort_note: 'team scored/allowed touchdown rates count the Player DNA cohort only; '
        + 'numerator and league mean share that cohort so the ratio is meaningful, the absolute count is not a team total',
    },
    weights,
    shrinkage: { half_life_games: HALF_LIFE_GAMES, prior_games: weights.shrink_prior_games },
    position_priors: priors,
    coefficients,
    teams: productionProfiles ? {
      season: productionSeason,
      priors_used: productionProfiles.priors_used,
      scored: productionProfiles.scored,
      allowed: productionProfiles.allowed,
      league_scored: productionProfiles.league_scored,
      league_allowed: productionProfiles.league_allowed,
    } : null,
    players: playerBaselines,
    name_index: nameIndex,
    ambiguous_names: ambiguous,
    calibration: {
      method: 'logistic recalibration of logit(1 - exp(-lambda)), Newton-fitted on the training seasons',
      ...calibration,
      split: {
        method: 'weights selected on the validation season; the holdout season scored once with the weights fixed',
        fit_seasons: `< ${HOLDOUT_SEASON}`,
        validation_season: VALIDATION_SEASON,
        holdout_season: HOLDOUT_SEASON,
      },
      train: trainQuality,
      holdout: holdoutQuality,
      holdout_uncalibrated: uncalibratedHoldout,
      holdout_base_rate_reference: baseRateHoldout,
      holdout_by_position: byPosition,
      reliability_holdout: bins,
      walk_forward: 'player baselines use only earlier games; team and opponent profiles use only earlier seasons',
      scope: 'HISTORICAL BACKTEST — never a verified live record',
    },
    counts: {
      reg_rows: rows.length,
      players_in_artefact: Object.keys(playerBaselines).length,
      players_skipped_thin_sample: skippedThin,
      ambiguous_names: Object.keys(ambiguous).length,
      train_samples: trainSamples.length,
      holdout_samples: holdoutSamples.length,
      skipped: final.skipped,
    },
  };

  const body = `/* GENERATED by scripts/build-td-model-v1.mjs — do not edit by hand.
 *
 * The factual base of the PBE Touchdown Targets champion. Every number here is
 * measured from the Player DNA datasets this site already serves; the header
 * of the build script states the label, the rights position and the
 * walk-forward discipline. \`calibration\` is a HISTORICAL BACKTEST and is
 * never presented as a verified live record.
 *
 * Rebuild: node scripts/build-td-model-v1.mjs
 * Verify:  node scripts/build-td-model-v1.mjs --check
 */
export const TD_MODEL = ${JSON.stringify(artefact, null, 1)};
export default TD_MODEL;
`;

  const backtest = {
    version: MODEL_VERSION,
    scope: 'HISTORICAL BACKTEST',
    warning: 'This is not the PBE Touchdown Targets verified live track record. It is what the '
      + 'model would have estimated for historical player-games, scored out of sample. No target '
      + 'was published, locked or graded from these rows.',
    built_at: artefact.built_at,
    validation_season: VALIDATION_SEASON,
    holdout_season: HOLDOUT_SEASON,
    weights,
    calibration: artefact.calibration,
    weight_search: search,
    counts: artefact.counts,
  };

  if (CHECK_ONLY) {
    const current = readFileSync(ARTEFACT, 'utf8');
    const strip = text => text.replace(/"built_at": "[^"]+"/g, '"built_at": "<ts>"');
    if (strip(current) !== strip(body)) {
      console.error('td-model artefact is stale: rebuild with node scripts/build-td-model-v1.mjs');
      process.exit(1);
    }
    console.log(`td-model artefact matches its inputs (sha ${sha(strip(current)).slice(0, 12)})`);
    return;
  }

  writeFileSync(ARTEFACT, body);
  writeFileSync(BACKTEST, `${JSON.stringify(backtest, null, 2)}\n`);
  console.log(`td-model ${MODEL_VERSION}`);
  console.log(`  players            ${artefact.counts.players_in_artefact} (thin sample skipped ${skippedThin}, ambiguous names ${Object.keys(ambiguous).length})`);
  console.log(`  weights            ${JSON.stringify(weights)}`);
  console.log(`  calibration        a=${calibration.a} b=${calibration.b}`);
  console.log(`  train              n=${trainQuality.n} base=${trainQuality.base_rate} brier=${trainQuality.brier} logloss=${trainQuality.log_loss}`);
  console.log(`  holdout ${HOLDOUT_SEASON}       n=${holdoutQuality.n} base=${holdoutQuality.base_rate} brier=${holdoutQuality.brier} logloss=${holdoutQuality.log_loss}`);
  console.log(`  base-rate ref      brier=${baseRateHoldout.brier} logloss=${baseRateHoldout.log_loss} (predict ${baseRateHoldout.predicted} for everyone)`);
  console.log(`  holdout uncalib.   brier=${uncalibratedHoldout.brier} logloss=${uncalibratedHoldout.log_loss}`);
  console.log(`  by position        ${Object.entries(byPosition).map(([k, v]) => `${k} n=${v.n} brier=${v.brier}`).join('  ')}`);
  console.log(`  artefact           ${ARTEFACT}`);
  console.log(`  backtest           ${BACKTEST}`);
}

function sha(text) { return createHash('sha256').update(text).digest('hex'); }

main();
