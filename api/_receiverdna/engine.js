/* RECEIVER DNA engine factory — deterministic.
 * Shared by WR DNA and TE DNA: a tight end and a wide receiver are measured the
 * same way, so the metrics live here once and each product supplies its own
 * dataset. What differs between them is emphasis, not arithmetic.
 * =============================================================================
 * Shared with QB DNA: identity media, the market reader, sample labels, the
 * rate/ratio discipline and the condition vocabulary. Those live in
 * api/_playerdna/ because they are genuinely position-agnostic.
 *
 * NOT shared: the metrics. A receiver is measured by volume, share and
 * efficiency of the targets he gets, and forcing quarterback semantics onto
 * that would produce numbers that look right and mean nothing.
 *
 * The rules are the same ones the product is built on:
 *   1. no naked percentage — numerator, denominator and N always travel
 *   2. UNKNOWN never becomes 0
 *   3. roofed games never enter an outdoor weather split
 *   4. sample labels describe SIZE, never significance
 *   5. a field whose source coverage is inadequate is WITHHELD, not estimated
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function makeReceiverEngine(datasetFile) {
let DATA = null;
function dataset() {
  if (DATA) return DATA;
  const p = join(process.cwd(), 'data', 'dist', datasetFile);
  DATA = JSON.parse(readFileSync(p, 'utf8'));
  DATA._byPlayer = new Map();
  for (const g of (DATA.receiver_games || DATA.player_games)) {
    if (!DATA._byPlayer.has(g.pid)) DATA._byPlayer.set(g.pid, []);
    DATA._byPlayer.get(g.pid).push(g);
  }
  for (const [, rows] of DATA._byPlayer) rows.sort((a, b) => String(a.d).localeCompare(String(b.d)));
  DATA._pairs = new Map();
  for (const p of DATA.pairings) {
    if (!DATA._pairs.has(p.pid)) DATA._pairs.set(p.pid, []);
    DATA._pairs.get(p.pid).push(p);
  }
  DATA._players = new Map(DATA.players.map(p => [p.gsis_id, p]));
  DATA._byEspn = new Map(DATA.players.filter(p => p.espn_id).map(p => [String(p.espn_id), p]));
  return DATA;
}

const SAMPLE = n =>
  n >= 20 ? 'STRONG SAMPLE' : n >= 10 ? 'MODERATE SAMPLE' : n >= 5 ? 'SMALL SAMPLE' : 'VERY SMALL SAMPLE';

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (rows, k) => rows.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
const vals = (rows, k) => rows.map(r => num(r[k])).filter(v => v !== null);

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const sd = xs.length > 1
    ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null;
  return {
    n: xs.length, mean: +mean.toFixed(1), median: +median.toFixed(1),
    std: sd === null ? null : +sd.toFixed(1),
    min: s[0], max: s[s.length - 1],
    p25: +s[Math.floor(s.length * 0.25)].toFixed(1),
    p75: +s[Math.floor(s.length * 0.75)].toFixed(1)
  };
}

function rate(numerator, denominator) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, pct: null, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), pct: +(100 * N / D).toFixed(1) };
}

function ratio(numerator, denominator, unit) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, value: null, unit, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), value: +(N / D).toFixed(2), unit };
}

/* ---- receiving markets ---------------------------------------------------
 * Receiving yards and receptions are numeric thresholds. Anytime TD is NOT:
 * it is priced as odds, not a line, so it is handled separately as a rate of
 * TD games and never crammed into a threshold comparison.
 */
const MARKETS = {
  receiving_yards: { key: 'ry',  label: 'Receiving yards' },
  receptions:      { key: 'rec', label: 'Receptions' }
};
const TD_MARKET = { key: 'rtd', label: 'Anytime TD', gateway: 'player_anytime_td' };

function baseline(rows) {
  if (!rows.length) return null;
  const tg = sum(rows, 'tg'), rec = sum(rows, 'rec'), ry = sum(rows, 'ry');
  const tt = sum(rows, 'tt'), ay = sum(rows, 'ay'), tay = sum(rows, 'tay');
  const withResult = rows.filter(r => num(r.win) !== null);
  const tdGames = rows.filter(r => (num(r.rtd) ?? 0) > 0).length;
  return {
    games: rows.length,
    date_range: [rows[0].d, rows[rows.length - 1].d],
    wins: withResult.length ? withResult.filter(r => r.win === 1).length : null,
    losses: withResult.length ? withResult.filter(r => r.win === 0).length : null,
    games_with_result: withResult.length,

    targets: tg, receptions: rec, receiving_yards_total: ry,
    receiving_yards: stats(vals(rows, 'ry')),
    targets_per_game: stats(vals(rows, 'tg')),
    receptions_per_game: stats(vals(rows, 'rec')),
    air_yards_per_game: stats(vals(rows, 'ay')),
    yac_per_game: stats(vals(rows, 'yac')),

    catch_rate: rate(rec, tg),
    // share of his own team's targets in the games he played
    target_share: rate(tg, tt),
    air_yards_share: tay > 0 ? rate(ay, tay)
      : { numerator: ay, denominator: 0, pct: null,
          note: 'team air yards are not positive across this window' },
    yards_per_target: ratio(ry, tg, 'yards per target'),
    yards_per_reception: ratio(ry, rec, 'yards per reception'),
    yac_per_reception: ratio(sum(rows, 'yac'), rec, 'YAC per reception'),
    air_yards_per_target: ratio(ay, tg, 'air yards per target'),

    touchdowns: sum(rows, 'rtd'),
    /* RED ZONE. Derived only from targeted plays whose source-supplied
       yardline is inside the opponent twenty; field position is present on
       100% of targeted plays, measured. A team that never reached the red
       zone contributes no denominator rather than a zero. */
    rz_targets: sum(rows, 'rzt'),
    rz_receptions: sum(rows, 'rzr'),
    rz_touchdowns: sum(rows, 'rztd'),
    rz_target_share: sum(rows, 'trz') > 0 ? rate(sum(rows, 'rzt'), sum(rows, 'trz'))
      : { numerator: sum(rows, 'rzt'), denominator: 0, pct: null,
          note: 'this team recorded no red-zone targets across this window' },
    rz_catch_rate: rate(sum(rows, 'rzr'), sum(rows, 'rzt')),
    rz_td_per_target: rate(sum(rows, 'rztd'), sum(rows, 'rzt')),
    rz_games: rows.filter(r => (num(r.rzt) ?? 0) > 0).length,
    // a TD RATE for a receiver is best read per game, not per target
    td_games: tdGames,
    td_game_rate: rate(tdGames, rows.length),
    first_downs: sum(rows, 'fd'),

    sample_label: SAMPLE(rows.length)
  };
}

/* ---- conditions ---------------------------------------------------------
 * Identical vocabulary to QB DNA on purpose: the same game is the same game.
 * What changes is what we measure inside each window.
 *
 * Deliberately ABSENT: "high target volume games". Target volume is an OUTCOME
 * of a game, not a condition known before it. Splitting on it would produce a
 * confident-looking number that cannot be applied to a future game.
 */
const isOutdoorResolved = r => (r.ind !== 1) && r.ws === 'ok' && num(r.tf) !== null;

const CONDITION_GROUPS = {
  location: 'Location', venue: 'Venue', temperature: 'Temperature',
  precipitation: 'Precipitation', wind: 'Wind', context: 'Game context',
  market: 'Market position'
};

const CONDITIONS = {
  home:           { group: 'location', label: 'Home', pick: r => r.ha === 1 },
  road:           { group: 'location', label: 'Road', pick: r => r.ha === 0 },
  dome:           { group: 'venue', label: 'Dome / closed roof',
                    pick: r => r.rf === 'dome' || r.rf === 'closed' },
  outdoor:        { group: 'venue', label: 'Outdoor',
                    pick: r => r.rf === 'outdoors' || r.rf === 'open' },
  arctic_sub20:   { group: 'temperature', label: 'Below 20 F', weather: true,
                    pick: r => isOutdoorResolved(r) && r.tf < 20 },
  freezing_20_32: { group: 'temperature', label: '20-32 F', weather: true,
                    pick: r => isOutdoorResolved(r) && r.tf >= 20 && r.tf < 32 },
  below_freezing: { group: 'temperature', label: 'Below freezing', weather: true, rollup: true,
                    pick: r => isOutdoorResolved(r) && r.tf < 32 },
  cold_33_50:     { group: 'temperature', label: '33-50 F', weather: true,
                    pick: r => isOutdoorResolved(r) && r.tf >= 32 && r.tf <= 50 },
  mild_51_70:     { group: 'temperature', label: '51-70 F', weather: true,
                    pick: r => isOutdoorResolved(r) && r.tf > 50 && r.tf <= 70 },
  warm_70_plus:   { group: 'temperature', label: 'Above 70 F', weather: true,
                    pick: r => isOutdoorResolved(r) && r.tf > 70 },
  snow:           { group: 'precipitation', label: 'Snow', weather: true,
                    pick: r => isOutdoorResolved(r) && num(r.sn) > 0 },
  rain:           { group: 'precipitation', label: 'Rain', weather: true,
                    pick: r => isOutdoorResolved(r) && num(r.rn) > 0 },
  dry:            { group: 'precipitation', label: 'Dry', weather: true,
                    pick: r => isOutdoorResolved(r) && !(num(r.sn) > 0) && !(num(r.rn) > 0) },
  wind_10_plus:   { group: 'wind', label: 'Wind 10+ mph', weather: true,
                    pick: r => isOutdoorResolved(r) && num(r.wd) >= 10 },
  wind_15_plus:   { group: 'wind', label: 'Wind 15+ mph', weather: true,
                    pick: r => isOutdoorResolved(r) && num(r.wd) >= 15 },
  wind_20_plus:   { group: 'wind', label: 'Wind 20+ mph', weather: true,
                    pick: r => isOutdoorResolved(r) && num(r.wd) >= 20 },
  primetime:      { group: 'context', label: 'Primetime',
                    pick: r => num(r.kh) !== null && r.kh >= 19 },
  divisional:     { group: 'context', label: 'Divisional', pick: r => r.div === 1 },
  playoffs:       { group: 'context', label: 'Playoffs', pick: r => r.st && r.st !== 'REG' },
  favorite:       { group: 'market', label: 'Favorite',
                    pick: r => num(r.spr) !== null && r.spr > 0 },
  underdog:       { group: 'market', label: 'Underdog',
                    pick: r => num(r.spr) !== null && r.spr < 0 }
};

function splitRows(rows, key) {
  const c = CONDITIONS[key];
  if (!c) return { unavailable: true, reason: `unknown condition ${key}` };
  const picked = rows.filter(c.pick);
  const out = { label: c.label, rows: picked };
  if (c.weather) {
    const resolvable = rows.filter(r => r.ind !== 1).length;
    const resolved = rows.filter(isOutdoorResolved).length;
    out.coverage = {
      outdoor_games: resolvable, environment_resolved: resolved,
      note: resolved < resolvable
        ? `${resolvable - resolved} outdoor game(s) have no resolved environment row and are excluded`
        : null
    };
  }
  return out;
}

/** Movement from the receiver's OWN baseline, on receiving yards. */
function conditionProfile(rows, minN = 1) {
  const base = stats(vals(rows, 'ry'));
  const out = {};
  for (const key of Object.keys(CONDITIONS)) {
    const c = CONDITIONS[key];
    const s = splitRows(rows, key);
    if (s.unavailable) { out[key] = { available: false, reason: s.reason }; continue; }
    const n = s.rows.length;
    if (n < minN) {
      out[key] = { available: true, key, group: c.group, label: s.label, games: n,
                   coverage: s.coverage || undefined };
      continue;
    }
    const b = baseline(s.rows);
    const st = stats(vals(s.rows, 'ry'));
    out[key] = {
      available: true, key, group: c.group, rollup: Boolean(c.rollup),
      label: s.label, games: n,
      wins: b.wins, losses: b.losses, games_with_result: b.games_with_result,
      record: b.wins === null ? null : `${b.wins}-${b.losses}`,
      win_pct: rate(b.wins ?? 0, b.games_with_result),
      receiving_yards_avg: st ? st.mean : null,
      receiving_yards_median: st ? st.median : null,
      targets_avg: b.targets_per_game ? b.targets_per_game.mean : null,
      receptions_avg: b.receptions_per_game ? b.receptions_per_game.mean : null,
      catch_rate: b.catch_rate,
      target_share: b.target_share,
      yards_per_target: b.yards_per_target,
      air_yards_avg: b.air_yards_per_game ? b.air_yards_per_game.mean : null,
      td_games: b.td_games, td_game_rate: b.td_game_rate,
      baseline_delta_pct: (st && base && base.mean)
        ? +(100 * (st.mean - base.mean) / base.mean).toFixed(1) : null,
      sample_label: SAMPLE(n),
      coverage: s.coverage || undefined
    };
  }
  return {
    baseline_mean: base ? base.mean : null,
    baseline_n: base ? base.n : 0,
    groups: CONDITION_GROUPS, conditions: out
  };
}

/* ---- DNA signals — same sample discipline as the quarterback product ----- */
const SIGNAL_TIERS = { qualifying_n: 10, signal_n: 5, min_move_pct: 4 };

function dnaSignals(profile, opts = {}) {
  const qualN = opts.qualifying_n ?? SIGNAL_TIERS.qualifying_n;
  const sigN = opts.signal_n ?? SIGNAL_TIERS.signal_n;
  const minMove = opts.min_move_pct ?? SIGNAL_TIERS.min_move_pct;

  const scored = Object.values(profile.conditions)
    .filter(c => c.available && c.games > 0 && typeof c.baseline_delta_pct === 'number')
    .filter(c => !c.rollup)
    .map(c => {
      const move = Math.abs(c.baseline_delta_pct);
      let tier = 'NEUTRAL';
      if (move >= minMove) {
        if (c.games >= qualN) tier = c.baseline_delta_pct > 0 ? 'STRENGTH' : 'WATCHOUT';
        else if (c.games >= sigN) tier = 'SIGNAL';
        else tier = 'INSUFFICIENT';
      }
      return {
        key: c.key, group: c.group, label: c.label, tier,
        direction: c.baseline_delta_pct > 0 ? 'up' : 'down',
        baseline_delta_pct: c.baseline_delta_pct,
        receiving_yards_avg: c.receiving_yards_avg,
        targets_avg: c.targets_avg, receptions_avg: c.receptions_avg,
        catch_rate: c.catch_rate, target_share: c.target_share,
        games: c.games, sample_label: c.sample_label,
        statement: `${c.receiving_yards_avg} yds/game · `
          + `${c.baseline_delta_pct > 0 ? '+' : ''}${c.baseline_delta_pct}% vs own baseline · `
          + `N=${c.games} · ${c.sample_label}`
      };
    })
    .sort((a, b) => Math.abs(b.baseline_delta_pct) - Math.abs(a.baseline_delta_pct));

  return {
    policy: {
      qualifying_n: qualN, signal_n: sigN, min_move_pct: minMove,
      rule: `A movement is only called a strength or a watchout with at least ${qualN} `
          + `games behind it. Between ${sigN} and ${qualN - 1} games it is a signal `
          + `carrying its sample label. Below ${sigN} games it is neither, however `
          + 'large the number looks.'
    },
    baseline_mean: profile.baseline_mean, baseline_n: profile.baseline_n,
    strengths: scored.filter(x => x.tier === 'STRENGTH'),
    watchouts: scored.filter(x => x.tier === 'WATCHOUT'),
    signals: scored.filter(x => x.tier === 'SIGNAL'),
    // reported, never promoted
    insufficient: scored.filter(x => x.tier === 'INSUFFICIENT'),
    /* The same rows under their accurate name. A condition with N<5 has
       LIMITED HISTORY; the player does not. A veteran with 120 games still has
       one wind-20+ game, and that is a fact about the weather, not about him.
       Additive: `insufficient` is unchanged for existing consumers. */
    limited_history: {
      label: 'Limited history in rare conditions',
      disclosure: `Not used as Player DNA signals because fewer than ${sigN} qualifying games are available.`,
      rows: scored.filter(x => x.tier === 'INSUFFICIENT').map(x => ({
        key: x.key, label: x.label, games: x.games, sample_label: x.sample_label,
        classified: false
      }))
    },
    neutral_count: scored.filter(x => x.tier === 'NEUTRAL').length
  };
}

/* ---- QB CONNECTION ------------------------------------------------------
 * The dimension a receiver product has and a quarterback product does not.
 * Built from PLAY-LEVEL passer ids, so a receiver targeted by two passers in
 * one game is counted correctly against each. Never inferred from which
 * quarterback happened to start.
 */
function qbConnections(gsis, opts = {}) {
  const minTargets = opts.min_targets ?? 1;
  const pairs = dataset()._pairs.get(gsis) || [];
  const by = new Map();
  for (const p of pairs) {
    if (!by.has(p.qb)) {
      by.set(p.qb, { passer_id: p.qb, name: p.qbn, espn_id: p.qbe || null,
                     games: new Set(), targets: 0, receptions: 0, yards: 0,
                     tds: 0, air_yards: 0, yac: 0, first: p.d, last: p.d, teams: new Set() });
    }
    const a = by.get(p.qb);
    a.games.add(p.g);
    a.targets += p.tg ?? 0; a.receptions += p.rec ?? 0; a.yards += p.ry ?? 0;
    a.tds += p.rtd ?? 0; a.air_yards += p.ay ?? 0; a.yac += p.yac ?? 0;
    if (p.d < a.first) a.first = p.d;
    if (p.d > a.last) a.last = p.d;
    if (p.t) a.teams.add(p.t);
  }
  const rows = [...by.values()]
    .filter(a => a.targets >= minTargets)
    .map(a => {
      // games is a Set of game ids while it is being accumulated; every
      // per-game rate and the sample label divide by its SIZE
      const n = a.games.size;
      return {
        passer_id: a.passer_id, name: a.name, espn_id: a.espn_id,
        teams: [...a.teams], games: n,
        date_range: [a.first, a.last],
        targets: a.targets, receptions: a.receptions,
        receiving_yards: a.yards, touchdowns: a.tds,
        targets_per_game: +(a.targets / n).toFixed(1),
        receptions_per_game: +(a.receptions / n).toFixed(1),
        receiving_yards_per_game: +(a.yards / n).toFixed(1),
        catch_rate: rate(a.receptions, a.targets),
        yards_per_target: ratio(a.yards, a.targets, 'yards per target'),
        air_yards_per_target: ratio(a.air_yards, a.targets, 'air yards per target'),
        sample_label: SAMPLE(n)
      };
    })
    .sort((x, y) => y.targets - x.targets);
  return {
    connections: rows,
    total_passers: rows.length,
    method: 'Counted from play-level passer ids. A receiver targeted by more than '
          + 'one passer in a game is counted against each of them, so games do not '
          + 'sum to his game total.',
    disclaimer: 'Historical pairing counts. Not a model, not a projection.'
  };
}

/* ---- thresholds ---------------------------------------------------------- */
function propThreshold(rows, market, line) {
  const m = MARKETS[market];
  if (!m) return { available: false, reason: `unsupported market ${market}` };
  const xs = vals(rows, m.key);
  if (!xs.length) return { available: false, reason: 'no games with this outcome recorded' };
  const over = xs.filter(v => v > line).length;
  const under = xs.filter(v => v < line).length;
  const push = xs.filter(v => v === line).length;
  const st = stats(xs);
  return {
    available: true, market, market_label: m.label, line,
    total: xs.length, over, under, push,
    over_pct: +(100 * over / xs.length).toFixed(1),
    mean: st.mean, median: st.median,
    statement: `${over}/${xs.length} over ${line}`,
    sample_label: SAMPLE(xs.length)
  };
}

/** Anytime TD is a rate of TD GAMES, never a threshold and never a probability. */
function tdHistory(rows) {
  if (!rows.length) return { available: false, reason: 'no games' };
  const td = rows.filter(r => (num(r.rtd) ?? 0) > 0).length;
  return {
    available: true, market: 'anytime_td', market_label: TD_MARKET.label,
    total: rows.length, td_games: td, no_td_games: rows.length - td,
    td_game_rate: rate(td, rows.length),
    total_touchdowns: sum(rows, 'rtd'),
    statement: `${td}/${rows.length} games with a receiving touchdown`,
    sample_label: SAMPLE(rows.length),
    note: 'A historical rate of games with a touchdown. It is not an implied '
        + 'probability and it is not comparable to a bookmaker price.'
  };
}

/* ---- identity ----------------------------------------------------------- */
function resolvePlayer({ player_id, gsis_id, espn_id, name }) {
  const D = dataset();
  const id = player_id || gsis_id;
  if (id && D._players.has(id)) return { player: D._players.get(id), matched_by: 'gsis_id' };
  if (espn_id && D._byEspn.has(String(espn_id))) {
    return { player: D._byEspn.get(String(espn_id)), matched_by: 'espn_id' };
  }
  if (id || espn_id) return { player: null, matched_by: null, reason: 'no receiver carries that stable id' };
  if (name) {
    const want = String(name).toLowerCase().trim();
    const hits = D.players.filter(p => String(p.display_name).toLowerCase() === want);
    if (hits.length === 1) return { player: hits[0], matched_by: 'exact_name' };
    if (hits.length > 1) {
      return { player: null, matched_by: null, reason: 'ambiguous name',
               candidates: hits.map(h => h.gsis_id) };
    }
    return { player: null, matched_by: null, reason: 'no receiver with that name' };
  }
  return { player: null, matched_by: null, reason: 'no identifier supplied' };
}

function gamesFor(gsis) { return dataset()._byPlayer.get(gsis) || []; }

function dataWindow() {
  const m = dataset().meta;
  return {
    seasons: m.seasons, data_through: m.data_through, latest_season: m.latest_season,
    latest_completed_game: m.latest_completed_game,
    seasons_without_play_by_play: m.seasons_without_play_by_play || [],
    note: (m.seasons_without_play_by_play || []).length
      ? `No play-by-play exists yet for ${(m.seasons_without_play_by_play || []).join(', ')} `
        + 'because no game in that season has been completed. Nothing is projected for it.'
      : null
  };
}

function provenance(extra = {}) {
  const m = dataset().meta;
  return {
    dataset_generated_at: m.generated_at,
    seasons: m.seasons, data_through: m.data_through,
    latest_completed_game: m.latest_completed_game,
    receiver_games_in_dataset: m.receiver_games,
    position_scope: m.position_scope,
    count_rules: m.count_rules,
    withheld_fields: m.withheld_fields,
    sources: m.sources,
    notes: [
      'Sample labels describe SIZE ONLY. They are not claims of statistical significance.',
      'Roofed and closed-roof games are excluded from outdoor weather splits by construction.',
      'A split whose inputs are missing reports available:false. It never reports zero.',
      'Target share is share of this team\'s targeted plays as counted here, with '
      + 'tight ends and running backs excluded from the product but present in the '
      + 'team denominator.',
      'These are counted historical facts and current market context. They are not '
      + 'PropBetEdge model picks, not projections and not an edge claim.'
    ],
    ...extra
  };
}

  return {
    dataset, SAMPLE, rate, ratio, MARKETS, TD_MARKET, baseline,
    CONDITION_GROUPS, CONDITIONS, splitRows, conditionProfile,
    SIGNAL_TIERS, dnaSignals, qbConnections, propThreshold, tdHistory,
    resolvePlayer, gamesFor, dataWindow, provenance
  };
}
