/* QB DNA engine — deterministic. Shared by all three API routes.
 * =============================================================================
 * Every number here is COUNTED from the dataset. No model, no inference, no
 * estimation. The rules the product depends on:
 *
 *   1. no naked percentage. Every rate carries numerator, denominator and N.
 *   2. UNKNOWN never becomes 0. A split whose inputs are missing reports
 *      available:false with a reason, it does not report zero.
 *   3. roofed games never enter an outdoor weather split, by construction.
 *   4. sample labels describe SIZE ONLY. They are product labels, never a
 *      claim of statistical significance.
 *   5. advanced, season-gated fields fail closed. A column existing is not
 *      evidence the season contains the data.
 *
 * The dataset is a generated snapshot of the local warehouse. In production
 * these same functions read nfl_qb_game_metrics from Supabase; the shape of a
 * row is identical, which is why the engine is source-agnostic.
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let DATA = null;
export function dataset() {
  if (DATA) return DATA;
  // bundled with the deployment; see scripts/build-qbdna-dataset
  const p = join(process.cwd(), 'data', 'dist', 'qb-dna-dataset.json');
  DATA = JSON.parse(readFileSync(p, 'utf8'));
  DATA._byPlayer = new Map();
  for (const g of DATA.qb_games) {
    if (!DATA._byPlayer.has(g.pid)) DATA._byPlayer.set(g.pid, []);
    DATA._byPlayer.get(g.pid).push(g);
  }
  for (const [, rows] of DATA._byPlayer) rows.sort((a, b) => String(a.d).localeCompare(String(b.d)));
  DATA._players = new Map(DATA.players.map(p => [p.gsis_id, p]));
  DATA._byEspn = new Map(DATA.players.filter(p => p.espn_id).map(p => [String(p.espn_id), p]));
  return DATA;
}

export const SAMPLE = n =>
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
    n: xs.length,
    mean: +mean.toFixed(1),
    median: +median.toFixed(1),
    std: sd === null ? null : +sd.toFixed(1),
    min: s[0], max: s[s.length - 1],
    p25: +s[Math.floor(s.length * 0.25)].toFixed(1),
    p75: +s[Math.floor(s.length * 0.75)].toFixed(1)
  };
}

/** A rate always carries its parts. A zero denominator is "no attempts", not 0%. */
export function rate(numerator, denominator) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, pct: null, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), pct: +(100 * N / D).toFixed(1) };
}

/** A ratio in the outcome's OWN units (yards per attempt) — not a percentage.
 *  Same zero-denominator discipline as rate(). */
export function ratio(numerator, denominator, unit) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, value: null, unit, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), value: +(N / D).toFixed(2), unit };
}

/* ---- the market map ------------------------------------------------------
 * Only markets whose outcome is a real per-game column are supported. A market
 * we cannot count from the data is absent, not approximated.
 */
export const MARKETS = {
  passing_yards:      { key: 'py',  label: 'Passing yards' },
  passing_attempts:   { key: 'att', label: 'Passing attempts' },
  completions:        { key: 'cmp', label: 'Completions' },
  passing_touchdowns: { key: 'td',  label: 'Passing touchdowns' },
  interceptions:      { key: 'int', label: 'Interceptions' }
};

export function baseline(rows) {
  if (!rows.length) return null;
  const att = sum(rows, 'att'), cmp = sum(rows, 'cmp'), db = sum(rows, 'db');
  const withResult = rows.filter(r => num(r.win) !== null);
  return {
    games: rows.length,
    date_range: [rows[0].d, rows[rows.length - 1].d],
    wins: withResult.length ? withResult.filter(r => r.win === 1).length : null,
    losses: withResult.length ? withResult.filter(r => r.win === 0).length : null,
    games_with_result: withResult.length,
    attempts: att, completions: cmp,
    completion_pct: rate(cmp, att),
    passing_yards_total: sum(rows, 'py'),
    passing_yards: stats(vals(rows, 'py')),
    attempts_per_game: stats(vals(rows, 'att')),
    completions_per_game: stats(vals(rows, 'cmp')),
    tds_per_game: stats(vals(rows, 'td')),
    ints_per_game: stats(vals(rows, 'int')),
    ypa: ratio(sum(rows, 'py'), att, 'yards per attempt'),
    td_rate: rate(sum(rows, 'td'), att),
    int_rate: rate(sum(rows, 'int'), att),
    sack_rate: rate(sum(rows, 'sk'), db),
    rush_yards_total: sum(rows, 'ry'),
    sample_label: SAMPLE(rows.length)
  };
}

/* ---- conditions ----------------------------------------------------------
 * Each returns {rows} or {unavailable, reason}. A weather condition is applied
 * ONLY to outdoor games whose environment row actually resolved, so a dome can
 * never be counted as "not cold" and an unresolved game is never counted at all.
 */
const isOutdoorResolved = r => (r.ind !== 1) && r.ws === 'ok' && num(r.tf) !== null;

/* Every condition carries the GROUP it belongs to, so the product can present
   research surfaces rather than one undifferentiated list. `rollup: true`
   marks a band that overlaps finer bands below it — it is still computed, but
   a grouped view shows the finer ones so nothing is double counted visually. */
export const CONDITION_GROUPS = {
  location:      'Location',
  venue:         'Venue',
  temperature:   'Temperature',
  precipitation: 'Precipitation',
  wind:          'Wind',
  context:       'Game context',
  market:        'Market position'
};

export const CONDITIONS = {
  home:            { group: 'location', label: 'Home',  pick: r => r.ha === 1 },
  road:            { group: 'location', label: 'Road',  pick: r => r.ha === 0 },
  dome:            { group: 'venue', label: 'Dome / closed roof',
                     pick: r => r.rf === 'dome' || r.rf === 'closed' },
  outdoor:         { group: 'venue', label: 'Outdoor',
                     pick: r => r.rf === 'outdoors' || r.rf === 'open' },

  /* Temperature bands are exclusive and cover the whole range, so a grouped
     view sums to the outdoor-resolved games and nothing is counted twice.
     below_freezing is retained as a rollup of the two coldest bands. */
  arctic_sub20:    { group: 'temperature', label: 'Below 20 F', weather: true,
                     pick: r => isOutdoorResolved(r) && r.tf < 20 },
  freezing_20_32:  { group: 'temperature', label: '20-32 F', weather: true,
                     pick: r => isOutdoorResolved(r) && r.tf >= 20 && r.tf < 32 },
  below_freezing:  { group: 'temperature', label: 'Below freezing', weather: true, rollup: true,
                     pick: r => isOutdoorResolved(r) && r.tf < 32 },
  cold_33_50:      { group: 'temperature', label: '33-50 F', weather: true,
                     pick: r => isOutdoorResolved(r) && r.tf >= 32 && r.tf <= 50 },
  mild_51_70:      { group: 'temperature', label: '51-70 F', weather: true,
                     pick: r => isOutdoorResolved(r) && r.tf > 50 && r.tf <= 70 },
  warm_70_plus:    { group: 'temperature', label: 'Above 70 F', weather: true,
                     pick: r => isOutdoorResolved(r) && r.tf > 70 },

  snow:            { group: 'precipitation', label: 'Snow', weather: true,
                     pick: r => isOutdoorResolved(r) && num(r.sn) > 0 },
  rain:            { group: 'precipitation', label: 'Rain', weather: true,
                     pick: r => isOutdoorResolved(r) && num(r.rn) > 0 },
  dry:             { group: 'precipitation', label: 'Dry', weather: true,
                     pick: r => isOutdoorResolved(r) && !(num(r.sn) > 0) && !(num(r.rn) > 0) },

  wind_10_plus:    { group: 'wind', label: 'Wind 10+ mph', weather: true,
                     pick: r => isOutdoorResolved(r) && num(r.wd) >= 10 },
  wind_15_plus:    { group: 'wind', label: 'Wind 15+ mph', weather: true,
                     pick: r => isOutdoorResolved(r) && num(r.wd) >= 15 },
  wind_20_plus:    { group: 'wind', label: 'Wind 20+ mph', weather: true,
                     pick: r => isOutdoorResolved(r) && num(r.wd) >= 20 },

  // kickoff hour is the venue's local hour; 19:00 or later is the primetime window
  primetime:       { group: 'context', label: 'Primetime',
                     pick: r => num(r.kh) !== null && r.kh >= 19 },
  divisional:      { group: 'context', label: 'Divisional', pick: r => r.div === 1 },
  playoffs:        { group: 'context', label: 'Playoffs', pick: r => r.st && r.st !== 'REG' },
  favorite:        { group: 'market', label: 'Favorite',
                     pick: r => num(r.spr) !== null && r.spr > 0 },
  underdog:        { group: 'market', label: 'Underdog',
                     pick: r => num(r.spr) !== null && r.spr < 0 }
};

export function splitRows(rows, key) {
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
  if (num(rows.find(r => num(r.spr) !== null) ? 1 : null) === null && (key === 'favorite' || key === 'underdog')) {
    out.coverage = { note: 'no game in this window carries a spread' };
  }
  return out;
}

/** Movement from the player's OWN baseline — the comparison that means something. */
export function conditionProfile(rows, metricKey = 'py', minN = 1) {
  const base = stats(vals(rows, metricKey));
  const out = {};
  for (const key of Object.keys(CONDITIONS)) {
    const c = CONDITIONS[key];
    const s = splitRows(rows, key);
    if (s.unavailable) { out[key] = { available: false, reason: s.reason }; continue; }
    const n = s.rows.length;
    if (n < minN) {
      out[key] = { available: true, key, group: c.group, label: s.label, games: n,
                   suppressed: `n<${minN}`, coverage: s.coverage || undefined };
      continue;
    }
    const b = baseline(s.rows);
    const st = stats(vals(s.rows, metricKey));
    const decided = b.games_with_result;
    out[key] = {
      available: true, key, group: c.group, rollup: Boolean(c.rollup),
      label: s.label, games: n,
      wins: b.wins, losses: b.losses,
      games_with_result: decided,
      // W-L as a rate, so the record can never be printed without its N
      win_pct: rate(b.wins ?? 0, decided),
      record: b.wins === null ? null : `${b.wins}-${b.losses}`,
      passing_yards_avg: st ? st.mean : null,
      passing_yards_median: st ? st.median : null,
      completion_pct: b.completion_pct,
      attempts_avg: b.attempts_per_game ? b.attempts_per_game.mean : null,
      tds_avg: b.tds_per_game ? b.tds_per_game.mean : null,
      ints_avg: b.ints_per_game ? b.ints_per_game.mean : null,
      tds_total: sum(s.rows, 'td'), ints_total: sum(s.rows, 'int'),
      ypa: b.ypa, td_rate: b.td_rate, int_rate: b.int_rate, sack_rate: b.sack_rate,
      baseline_delta_pct: (st && base && base.mean)
        ? +(100 * (st.mean - base.mean) / base.mean).toFixed(1) : null,
      sample_label: SAMPLE(n),
      coverage: s.coverage || undefined
    };
  }
  return {
    baseline_mean: base ? base.mean : null,
    baseline_n: base ? base.n : 0,
    groups: CONDITION_GROUPS,
    conditions: out
  };
}

/* ---- DNA SIGNALS ----------------------------------------------------------
 * The condition matrix answers "what changes his production" only if a reader
 * is willing to scan twenty rows. This reduces it to the few movements that
 * are both LARGE and BACKED BY ENOUGH GAMES to be worth a reader's attention.
 *
 * Sample discipline is the whole point, and it is enforced here rather than
 * left to the surface:
 *
 *   N >= 10  may be called a STRENGTH or a WATCHOUT
 *   N 5-9    is a SIGNAL, explicitly carrying SMALL SAMPLE
 *   N < 5    is never either; it is reported as VERY SMALL SAMPLE only
 *
 * A big number on three games is not an insight, and labelling it as one is
 * exactly the mythology this product exists to avoid.
 */
export const SIGNAL_TIERS = {
  qualifying_n: 10,     // may be labelled STRENGTH / WATCHOUT
  signal_n: 5,          // may be labelled SIGNAL
  min_move_pct: 4       // below this the movement is noise, whatever the N
};

export function dnaSignals(profile, opts = {}) {
  const qualN = opts.qualifying_n ?? SIGNAL_TIERS.qualifying_n;
  const sigN = opts.signal_n ?? SIGNAL_TIERS.signal_n;
  const minMove = opts.min_move_pct ?? SIGNAL_TIERS.min_move_pct;

  const rows = Object.values(profile.conditions)
    .filter(c => c.available && c.games > 0 && typeof c.baseline_delta_pct === 'number')
    // a rollup band duplicates the finer bands beneath it; showing both as
    // separate signals would double-count the same games
    .filter(c => !c.rollup);

  const classify = c => {
    const move = Math.abs(c.baseline_delta_pct);
    if (move < minMove) return { tier: 'NEUTRAL', eligible: false };
    if (c.games >= qualN) {
      return { tier: c.baseline_delta_pct > 0 ? 'STRENGTH' : 'WATCHOUT', eligible: true };
    }
    if (c.games >= sigN) return { tier: 'SIGNAL', eligible: true };
    return { tier: 'INSUFFICIENT', eligible: false };
  };

  const scored = rows.map(c => {
    const k = classify(c);
    return {
      key: c.key, group: c.group, label: c.label,
      tier: k.tier, eligible: k.eligible,
      direction: c.baseline_delta_pct > 0 ? 'up' : 'down',
      baseline_delta_pct: c.baseline_delta_pct,
      passing_yards_avg: c.passing_yards_avg,
      games: c.games, record: c.record, win_pct: c.win_pct,
      completion_pct: c.completion_pct,
      sample_label: c.sample_label,
      // the one sentence a surface is allowed to print for this signal
      statement: `${c.passing_yards_avg} yds/game · `
        + `${c.baseline_delta_pct > 0 ? '+' : ''}${c.baseline_delta_pct}% vs own baseline · `
        + `N=${c.games} · ${c.sample_label}`
    };
  }).sort((a, b) => Math.abs(b.baseline_delta_pct) - Math.abs(a.baseline_delta_pct));

  return {
    policy: {
      qualifying_n: qualN, signal_n: sigN, min_move_pct: minMove,
      rule: `A movement is only called a strength or a watchout with at least `
          + `${qualN} games behind it. Between ${sigN} and ${qualN - 1} games it is a `
          + `signal carrying its sample label. Below ${sigN} games it is neither, `
          + `however large the number looks.`
    },
    baseline_mean: profile.baseline_mean,
    baseline_n: profile.baseline_n,
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

export function propThreshold(rows, market, line) {
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
    statement: `${over}/${xs.length} over ${line} = ${(100 * over / xs.length).toFixed(1)}%`,
    sample_label: SAMPLE(xs.length)
  };
}

/* ---- lookup --------------------------------------------------------------
 * IDENTITY INVARIANT: a stable id always wins. A name is only ever consulted
 * when no id was supplied, and a name match is reported as such so a caller can
 * refuse it. A fuzzy name match may never override an id match.
 */
export function resolvePlayer({ player_id, gsis_id, espn_id, name }) {
  const D = dataset();
  const id = player_id || gsis_id;
  if (id && D._players.has(id)) return { player: D._players.get(id), matched_by: 'gsis_id' };
  if (espn_id && D._byEspn.has(String(espn_id))) return { player: D._byEspn.get(String(espn_id)), matched_by: 'espn_id' };
  if (id || espn_id) return { player: null, matched_by: null, reason: 'no player carries that stable id' };
  if (name) {
    const want = String(name).toLowerCase().trim();
    const hits = D.players.filter(p => String(p.display_name).toLowerCase() === want);
    if (hits.length === 1) return { player: hits[0], matched_by: 'exact_name' };
    if (hits.length > 1) return { player: null, matched_by: null, reason: 'ambiguous name', candidates: hits.map(h => h.gsis_id) };
    return { player: null, matched_by: null, reason: 'no player with that name' };
  }
  return { player: null, matched_by: null, reason: 'no identifier supplied' };
}

export function gamesFor(gsis) {
  return dataset()._byPlayer.get(gsis) || [];
}

/** The window the dataset actually covers. Emitted on EVERY response so no
 *  surface can present a stale season as current form. */
export function dataWindow() {
  const m = dataset().meta;
  return {
    seasons: m.seasons,
    data_through: m.data_through,
    latest_season: m.latest_season,
    latest_completed_game: m.latest_completed_game,
    seasons_without_play_by_play: m.seasons_without_play_by_play || [],
    note: (m.seasons_without_play_by_play || []).length
      ? `No play-by-play exists yet for ${(m.seasons_without_play_by_play || []).join(', ')} `
        + 'because no game in that season has been completed. Nothing is projected for it.'
      : null
  };
}

export function provenance(extra = {}) {
  const D = dataset();
  return {
    dataset_generated_at: D.meta.generated_at,
    seasons: D.meta.seasons,
    data_through: D.meta.data_through,
    latest_completed_game: D.meta.latest_completed_game,
    qb_games_in_dataset: D.meta.qb_games,
    sources: D.meta.sources,
    field_availability_by_season: D.meta.field_availability_by_season,
    notes: [
      'Sample labels describe SIZE ONLY. They are not claims of statistical significance.',
      'Roofed and closed-roof games are excluded from outdoor weather splits by construction.',
      'A split whose inputs are missing reports available:false. It never reports zero.',
      'A quarterback with no NFL history reports zero games. College statistics are '
      + 'never substituted.'
    ],
    ...extra
  };
}
