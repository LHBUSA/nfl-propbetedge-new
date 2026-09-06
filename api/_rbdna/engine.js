/* RB DNA engine — deterministic. A sibling of the QB and receiver engines,
 * not a copy of either.
 * =============================================================================
 * Shared with the rest of Player DNA: identity media, the market reader, the
 * condition vocabulary, the sample grammar and the rate/ratio discipline.
 *
 * NOT shared: a back is measured by USAGE — how much of his team's work he
 * gets and in what mix. A modern back is a runner and a receiver, and
 * reporting either side alone misstates him, which is why every headline
 * metric here is a touch, a share or a scrimmage total.
 *
 * The rules are the product's, unchanged:
 *   1. no naked percentage — numerator, denominator and N always travel
 *   2. UNKNOWN never becomes 0
 *   3. roofed games never enter an outdoor weather split
 *   4. sample labels describe SIZE, never significance
 *   5. a field whose source coverage is inadequate is WITHHELD, not estimated
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let DATA = null;
export function dataset() {
  if (DATA) return DATA;
  const p = join(process.cwd(), 'data', 'dist', 'rb-dna-dataset.json');
  DATA = JSON.parse(readFileSync(p, 'utf8'));
  DATA._byPlayer = new Map();
  for (const g of DATA.player_games) {
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
  return { n: xs.length, mean: +mean.toFixed(1), median: +median.toFixed(1),
           std: sd === null ? null : +sd.toFixed(1), min: s[0], max: s[s.length - 1],
           p25: +s[Math.floor(s.length * 0.25)].toFixed(1),
           p75: +s[Math.floor(s.length * 0.75)].toFixed(1) };
}

export function rate(numerator, denominator) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, pct: null, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), pct: +(100 * N / D).toFixed(1) };
}
export function ratio(numerator, denominator, unit) {
  const N = +numerator, D = +denominator;
  if (!Number.isFinite(D) || D <= 0) {
    return { numerator: Number.isFinite(N) ? N : null, denominator: 0, value: null, unit, note: 'no denominator' };
  }
  return { numerator: +N.toFixed(2), denominator: +D.toFixed(2), value: +(N / D).toFixed(2), unit };
}

/* Threshold markets a back is actually priced in. Anytime TD is deliberately
   absent: it is odds, not a line, and is handled as a rate of TD games. */
export const MARKETS = {
  rushing_yards:   { key: 'ry',   label: 'Rushing yards' },
  rush_attempts:   { key: 'car',  label: 'Rush attempts' },
  receiving_yards: { key: 'recy', label: 'Receiving yards' },
  receptions:      { key: 'rec',  label: 'Receptions' },
  scrimmage_yards: { key: 'scr',  label: 'Scrimmage yards' }
};

/** Derived per-row values the compact dataset does not store. */
const withDerived = rows => rows.map(r => ({
  ...r,
  scr: (num(r.ry) ?? 0) + (num(r.recy) ?? 0),
  tou: (num(r.car) ?? 0) + (num(r.rec) ?? 0),
  ttd: (num(r.rtd) ?? 0) + (num(r.rectd) ?? 0)
}));

export function baseline(raw) {
  if (!raw.length) return null;
  const rows = withDerived(raw);
  const car = sum(rows, 'car'), tg = sum(rows, 'tg'), rec = sum(rows, 'rec');
  const ry = sum(rows, 'ry'), recy = sum(rows, 'recy');
  const tc = sum(rows, 'tc'), tt = sum(rows, 'tt');
  const withResult = rows.filter(r => num(r.win) !== null);
  const tdGames = rows.filter(r => (r.ttd ?? 0) > 0).length;
  return {
    games: rows.length,
    date_range: [rows[0].d, rows[rows.length - 1].d],
    wins: withResult.length ? withResult.filter(r => r.win === 1).length : null,
    losses: withResult.length ? withResult.filter(r => r.win === 0).length : null,
    games_with_result: withResult.length,

    /* ---- USAGE, the heart of a running-back product ---------------------- */
    carries: car, targets: tg, receptions: rec,
    touches: car + rec,
    touches_per_game: stats(vals(rows, 'tou')),
    carries_per_game: stats(vals(rows, 'car')),
    targets_per_game: stats(vals(rows, 'tg')),
    receptions_per_game: stats(vals(rows, 'rec')),
    // share of the team's own work, both parts retained
    carry_share: rate(car, tc),
    target_share: rate(tg, tt),
    /* The run/pass mix of his own touches — the single number that separates a
       between-the-tackles back from a passing-down back. */
    rush_share_of_touches: rate(car, car + rec),

    /* ---- PRODUCTION ------------------------------------------------------ */
    rush_yards_total: ry, receiving_yards_total: recy,
    scrimmage_yards_total: ry + recy,
    scrimmage_yards: stats(vals(rows, 'scr')),
    rush_yards: stats(vals(rows, 'ry')),
    receiving_yards: stats(vals(rows, 'recy')),
    yards_per_carry: ratio(ry, car, 'yards per carry'),
    yards_per_target: ratio(recy, tg, 'yards per target'),
    yards_per_reception: ratio(recy, rec, 'yards per reception'),
    yards_per_touch: ratio(ry + recy, car + rec, 'yards per touch'),
    catch_rate: rate(rec, tg),

    /* ---- SCORING AND SECURITY ------------------------------------------- */
    rush_tds: sum(rows, 'rtd'), receiving_tds: sum(rows, 'rectd'),
    total_tds: sum(rows, 'rtd') + sum(rows, 'rectd'),
    td_games: tdGames,
    td_game_rate: rate(tdGames, rows.length),
    rz_carries: sum(rows, 'rzc'), rz_rush_tds: sum(rows, 'rztd'),
    fumbles_lost: sum(rows, 'fum'),
    fumble_rate: rate(sum(rows, 'fum'), car + rec),

    sample_label: SAMPLE(rows.length)
  };
}

/* ---- conditions: the same vocabulary as every other Player DNA product --- */
const isOutdoorResolved = r => (r.ind !== 1) && r.ws === 'ok' && num(r.tf) !== null;

export const CONDITION_GROUPS = {
  location: 'Location', venue: 'Venue', temperature: 'Temperature',
  precipitation: 'Precipitation', wind: 'Wind', context: 'Game context',
  market: 'Market position'
};

export const CONDITIONS = {
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
  /* Favourite and underdog are the closest this data comes to game script, and
     they are DESCRIPTIVE. A back carrying more as a favourite is a record of
     what happened, not evidence that being favoured causes carries. */
  favorite:       { group: 'market', label: 'Favorite',
                    pick: r => num(r.spr) !== null && r.spr > 0 },
  underdog:       { group: 'market', label: 'Underdog',
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
    out.coverage = { outdoor_games: resolvable, environment_resolved: resolved,
      note: resolved < resolvable
        ? `${resolvable - resolved} outdoor game(s) have no resolved environment row and are excluded`
        : null };
  }
  return out;
}

/** Movement from the back's OWN baseline, measured on scrimmage yards. */
export function conditionProfile(rows, minN = 1) {
  const base = stats(vals(withDerived(rows), 'scr'));
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
    const st = stats(vals(withDerived(s.rows), 'scr'));
    out[key] = {
      available: true, key, group: c.group, rollup: Boolean(c.rollup),
      label: s.label, games: n,
      wins: b.wins, losses: b.losses, games_with_result: b.games_with_result,
      record: b.wins === null ? null : `${b.wins}-${b.losses}`,
      win_pct: rate(b.wins ?? 0, b.games_with_result),
      scrimmage_yards_avg: st ? st.mean : null,
      scrimmage_yards_median: st ? st.median : null,
      rush_yards_avg: b.rush_yards ? b.rush_yards.mean : null,
      touches_avg: b.touches_per_game ? b.touches_per_game.mean : null,
      carries_avg: b.carries_per_game ? b.carries_per_game.mean : null,
      targets_avg: b.targets_per_game ? b.targets_per_game.mean : null,
      carry_share: b.carry_share, target_share: b.target_share,
      yards_per_carry: b.yards_per_carry, yards_per_touch: b.yards_per_touch,
      td_games: b.td_games, td_game_rate: b.td_game_rate,
      baseline_delta_pct: (st && base && base.mean)
        ? +(100 * (st.mean - base.mean) / base.mean).toFixed(1) : null,
      sample_label: SAMPLE(n),
      coverage: s.coverage || undefined
    };
  }
  return { baseline_mean: base ? base.mean : null, baseline_n: base ? base.n : 0,
           groups: CONDITION_GROUPS, conditions: out };
}

export const SIGNAL_TIERS = { qualifying_n: 10, signal_n: 5, min_move_pct: 4 };

export function dnaSignals(profile, opts = {}) {
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
        scrimmage_yards_avg: c.scrimmage_yards_avg,
        touches_avg: c.touches_avg, carry_share: c.carry_share,
        games: c.games, record: c.record, sample_label: c.sample_label,
        statement: `${c.scrimmage_yards_avg} scrimmage yds/game · `
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
          + 'large the number looks.',
      note: 'Favourite and underdog splits are descriptive records of what happened, '
          + 'not evidence that game script caused it.'
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

export function propThreshold(raw, market, line) {
  const m = MARKETS[market];
  if (!m) return { available: false, reason: `unsupported market ${market}` };
  const xs = vals(withDerived(raw), m.key);
  if (!xs.length) return { available: false, reason: 'no games with this outcome recorded' };
  const over = xs.filter(v => v > line).length;
  const under = xs.filter(v => v < line).length;
  const push = xs.filter(v => v === line).length;
  const st = stats(xs);
  return { available: true, market, market_label: m.label, line,
    total: xs.length, over, under, push,
    over_pct: +(100 * over / xs.length).toFixed(1),
    mean: st.mean, median: st.median,
    statement: `${over}/${xs.length} over ${line}`, sample_label: SAMPLE(xs.length) };
}

/** Anytime TD is a rate of TD GAMES — rushing or receiving. Never a threshold. */
export function tdHistory(raw) {
  if (!raw.length) return { available: false, reason: 'no games' };
  const rows = withDerived(raw);
  const td = rows.filter(r => (r.ttd ?? 0) > 0).length;
  return {
    available: true, market: 'anytime_td', market_label: 'Anytime TD',
    total: rows.length, td_games: td, no_td_games: rows.length - td,
    td_game_rate: rate(td, rows.length),
    total_touchdowns: sum(rows, 'rtd') + sum(rows, 'rectd'),
    rush_tds: sum(rows, 'rtd'), receiving_tds: sum(rows, 'rectd'),
    statement: `${td}/${rows.length} games with a touchdown`,
    sample_label: SAMPLE(rows.length),
    note: 'A historical rate of games with a rushing or receiving touchdown. It is '
        + 'not an implied probability and it is not comparable to a bookmaker price.'
  };
}

export function resolvePlayer({ player_id, gsis_id, espn_id, name }) {
  const D = dataset();
  const id = player_id || gsis_id;
  if (id && D._players.has(id)) return { player: D._players.get(id), matched_by: 'gsis_id' };
  if (espn_id && D._byEspn.has(String(espn_id))) {
    return { player: D._byEspn.get(String(espn_id)), matched_by: 'espn_id' };
  }
  if (id || espn_id) return { player: null, matched_by: null, reason: 'no back carries that stable id' };
  if (name) {
    const want = String(name).toLowerCase().trim();
    const hits = D.players.filter(p => String(p.display_name).toLowerCase() === want);
    if (hits.length === 1) return { player: hits[0], matched_by: 'exact_name' };
    if (hits.length > 1) {
      return { player: null, matched_by: null, reason: 'ambiguous name',
               candidates: hits.map(h => h.gsis_id) };
    }
    return { player: null, matched_by: null, reason: 'no back with that name' };
  }
  return { player: null, matched_by: null, reason: 'no identifier supplied' };
}

export function gamesFor(gsis) { return dataset()._byPlayer.get(gsis) || []; }

export function dataWindow() {
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

export function provenance(extra = {}) {
  const m = dataset().meta;
  return {
    dataset_generated_at: m.generated_at,
    seasons: m.seasons, data_through: m.data_through,
    latest_completed_game: m.latest_completed_game,
    player_games_in_dataset: m.player_games,
    position_scope: m.position_scope,
    count_rules: m.count_rules,
    withheld_fields: m.withheld_fields,
    sources: m.sources,
    notes: [
      'Sample labels describe SIZE ONLY. They are not claims of statistical significance.',
      'Roofed and closed-roof games are excluded from outdoor weather splits by construction.',
      'A split whose inputs are missing reports available:false. It never reports zero.',
      'Carry share and target share are shares of ALL of a team\'s carries and targets, '
      + 'including players this product excludes.',
      'Favourite and underdog splits are descriptive, not causal.',
      'These are counted historical facts and current market context. They are not '
      + 'PropBetEdge model picks, not projections and not an edge claim.'
    ],
    ...extra
  };
}

/** Everything the surface needs to describe how this back is used. */
export function usageProfile(rows) {
  const b = baseline(rows);
  if (!b) return null;
  return {
    touches_per_game: b.touches_per_game ? b.touches_per_game.mean : null,
    carries_per_game: b.carries_per_game ? b.carries_per_game.mean : null,
    targets_per_game: b.targets_per_game ? b.targets_per_game.mean : null,
    receptions_per_game: b.receptions_per_game ? b.receptions_per_game.mean : null,
    carry_share: b.carry_share, target_share: b.target_share,
    rush_share_of_touches: b.rush_share_of_touches,
    scrimmage_yards_per_game: b.scrimmage_yards ? b.scrimmage_yards.mean : null,
    rush_yards_per_game: b.rush_yards ? b.rush_yards.mean : null,
    receiving_yards_per_game: b.receiving_yards ? b.receiving_yards.mean : null,
    yards_per_touch: b.yards_per_touch,
    games: b.games, sample_label: b.sample_label,
    withheld: ['snap share', 'routes run'],
    withheld_reason: 'the nflverse participation file is ~37% covered for 2019-2022 and '
                   + 'is not published for 2024-2025, so a snap or route number would '
                   + 'describe whichever plays were charted'
  };
}
