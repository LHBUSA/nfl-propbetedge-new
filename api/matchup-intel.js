/* GET /api/matchup-intel?event_id=<odds event id>
 *
 * ONE authoritative matchup payload, composed on the server.
 *
 * The page this replaces made its own unrelated calls from the browser — an
 * odds board, the whole news feed, a model endpoint — and then assembled team
 * facts out of them with its own heuristics. That is how a Bills-Lions recap
 * ended up filed under Atlanta. Composition happens here now, once, and the
 * browser renders what it is given.
 *
 * SOURCES, all of them already in production:
 *   game + market   nfl-odds  /api/odds/board, /api/odds?markets=h2h,spreads,totals
 *   consensus       api/game-intel.js (cross-book spread / total / moneyline)
 *   availability    nfl-intel /api/injuries   (ESPN core injury designations)
 *   what changed    nfl-intel /api/changes    (designation transitions)
 *   team efficiency nfl_team_ratings          (the picks engine's own ratings)
 *   news            api/news-feed.js, filtered by the shared trust guard
 *   model           workers/nfl-picks /api/picks/pass, Pro only
 *
 * NO EVENT IS HARDCODED. With no event_id the current slate is resolved from
 * the market tape and the first game that has not kicked off is chosen. The old
 * page shipped a 32-hex QA fixture as its consumer default; a user landing on
 * Matchups was reading a stale game.
 *
 * NULL IS NOT ZERO, everywhere. A team with no usable rating is reported
 * UNAVAILABLE, never as league average; a split with no plays is not 0.0 EPA;
 * a player with no injury row is absent, not healthy.
 */
import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';
import {
  CONTRACT, STATE, ratingUsable, ratingLabel, metric, percentileOf, classify,
  collisions, orderAvailability, whatMattersMost, toFreePayload, LIMITED_SAMPLE_PLAYS,
  STRENGTH_PERCENTILE, WEAKNESS_PERCENTILE,
} from './_matchup/intel-core.js';

const GATEWAY = process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai';
/* Same-origin reads: game-intel and news-feed are Vercel functions in this repo,
   not gateway routes. VERCEL_URL is the running deployment, so a preview reads
   its own functions rather than production's. */
const SELF = process.env.PBE_SELF_ORIGIN
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://nfl.propbetedge.ai');
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const TIMEOUT_MS = 6000;

const supabaseUrl = () => String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const supabaseSecret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

/** Every upstream read is allowed to fail without taking the page with it. */
async function soft(label, fn) {
  try {
    const value = await fn();
    return { ok: true, value, error: null, label };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message || error).slice(0, 160), label };
  }
}

async function getJson(url, ms = TIMEOUT_MS, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: headers || { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${label(url)}_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
const label = url => String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/[^a-z0-9]+/gi, '_').slice(1, 40);

/* ---------------------------------------------------------------- event */

/**
 * Resolve the event without a hardcoded default.
 *
 * The market tape is already kickoff-ordered and marks which games have
 * started, so "the current slate" is a read, not a guess. If nothing is
 * upcoming the most recent game is used, and the payload says which rule fired.
 */
async function resolveEvent(requested) {
  const board = await getJson(`${GATEWAY}/api/best-line`);
  const events = Array.isArray(board?.events) ? board.events : [];
  if (requested) {
    const match = events.find(e => String(e.id) === String(requested));
    return { event: match || null, id: String(requested), events, rule: match ? 'requested' : 'requested_not_in_slate', week: board?.current_week ?? null };
  }
  const upcoming = events.find(e => !e.started);
  const chosen = upcoming || events[events.length - 1] || null;
  return {
    event: chosen,
    id: chosen ? String(chosen.id) : null,
    events,
    rule: upcoming ? 'first_not_started' : (chosen ? 'most_recent' : 'no_events'),
    week: board?.current_week ?? null,
  };
}

/* -------------------------------------------------------------- ratings */

async function teamRatings(season) {
  const secret = supabaseSecret();
  if (!secret) throw new Error('ratings_secret_missing');
  const query = `season=eq.${encodeURIComponent(season)}&select=*&order=as_of_week.desc&limit=600`;
  const rows = await getJson(`${supabaseUrl()}/rest/v1/nfl_team_ratings?${query}`, TIMEOUT_MS, supabaseAdminHeaders(secret));
  const latest = new Map();
  for (const row of rows || []) if (!latest.has(row.team)) latest.set(row.team, row);
  return latest;
}

/**
 * Build the displayable side for one team.
 *
 * The distributions are the league's own values for the same week, so a
 * percentile is computed against real peers rather than an assumed scale. A
 * team whose rating is unusable contributes nothing to the distribution and
 * receives no percentile — it does not silently become median.
 */
function sideFor(teamAbbr, ratings, distributions, week) {
  const rating = ratings?.get(teamAbbr) || null;
  const state = ratingLabel(rating, week);
  const usable = ratingUsable(rating).usable;
  const plays = usable ? rating.plays_sample ?? null : null;

  const offence = metric(usable ? rating.off_epa_play : null, { plays, label: 'Offence EPA/play', better: 'high' });
  const defence = metric(usable ? rating.def_epa_play : null, { plays, label: 'Defence EPA/play allowed', better: 'low' });
  const proe = metric(usable ? rating.proe : null, { plays, label: 'PROE', better: 'high' });
  const pace = metric(usable ? rating.pace : null, { plays, label: 'Plays per game', better: 'high' });

  return {
    team: teamAbbr,
    rating: {
      state: state.state, label: state.label, note: state.note || null,
      reason: state.reason || null, prior_weight: state.prior_weight,
      status: rating?.status ?? null,
      games_sample: usable ? rating.games_sample ?? null : null,
      plays_sample: plays,
      as_of_week: rating?.as_of_week ?? null,
      source: rating?.source ?? null,
      source_version: rating?.source_version ?? null,
      source_timestamp: rating?.source_timestamp ?? null,
    },
    form: {
      offence: { ...offence, percentile: percentileOf(offence.value, distributions.off, 'high') },
      /* better:'low' — the fewest EPA allowed is the BEST defence and must come
         out as the highest percentile. */
      defence: { ...defence, percentile: percentileOf(defence.value, distributions.def, 'low') },
      proe: { ...proe, percentile: percentileOf(proe.value, distributions.proe, 'high') },
      pace: { ...pace, percentile: percentileOf(pace.value, distributions.pace, 'high') },
    },
    /* Pass/rush/explosive splits need 2026 play-by-play, which this product has
       no approved path to yet. They are declared unavailable rather than
       approximated from the team aggregate — an aggregate is not a split. */
    splits: {
      state: STATE.UNAVAILABLE,
      reason: 'no_2026_play_by_play_source',
      pass: null, rush: null, explosive: null,
    },
  };
}

function distributionsFrom(ratings) {
  const out = { off: [], def: [], proe: [], pace: [] };
  for (const rating of (ratings?.values?.() || [])) {
    if (!ratingUsable(rating).usable) continue;
    if (Number.isFinite(Number(rating.off_epa_play))) out.off.push(Number(rating.off_epa_play));
    if (Number.isFinite(Number(rating.def_epa_play))) out.def.push(Number(rating.def_epa_play));
    if (Number.isFinite(Number(rating.proe))) out.proe.push(Number(rating.proe));
    if (Number.isFinite(Number(rating.pace))) out.pace.push(Number(rating.pace));
  }
  return out;
}

/* -------------------------------------------------------------- handler */

export default async function handler(req, res) {
  const requested = String(req.query?.event_id || req.query?.event || '').trim();
  if (requested && !/^[a-z0-9-]{6,64}$/i.test(requested)) {
    return send(res, 400, { ok: false, contract: CONTRACT, error: 'bad_event_id' });
  }

  const auth = await getNflSession(req).catch(() => null);
  const pro = auth?.pro === true && !!verifiedEmail(auth);

  const resolved = await soft('event', () => resolveEvent(requested));
  if (!resolved.ok || !resolved.value?.id) {
    return send(res, 503, {
      ok: false, contract: CONTRACT, error: 'event_unresolved',
      detail: resolved.error || resolved.value?.rule || null,
    });
  }
  const { event, id: eventId, events, rule, week } = resolved.value;
  const away = event?.away || null;
  const home = event?.home || null;
  const season = Number(event?.season) || new Date().getUTCFullYear();

  const [board, injuries, changes, news, ratings] = await Promise.all([
    soft('board', () => getJson(`${GATEWAY}/api/odds/board?event_id=${encodeURIComponent(eventId)}`)),
    soft('injuries', () => getJson(`${GATEWAY}/api/injuries`)),
    soft('changes', () => getJson(`${GATEWAY}/api/changes?window_hours=72`)),
    soft('news', () => getJson(`${SELF}/api/news-feed?limit=100`)),
    soft('ratings', () => teamRatings(season)),
  ]);

  const ratingMap = ratings.ok ? ratings.value : null;
  const distributions = distributionsFrom(ratingMap);
  const awaySide = away ? sideFor(abbrOf(away), ratingMap, distributions, week) : null;
  const homeSide = home ? sideFor(abbrOf(home), ratingMap, distributions, week) : null;

  /* Availability: structured designations, never a count of injury-ish
     headlines. The board is keyed by team abbreviation. */
  const byTeam = {};
  for (const team of (injuries.ok ? injuries.value?.teams || [] : [])) {
    byTeam[String(team.abbreviation || '').toUpperCase()] = team;
  }
  const availabilityFor = abbr => {
    const team = byTeam[String(abbr || '').toUpperCase()];
    if (!team) return { state: STATE.UNAVAILABLE, rows: [], counts: null, source_status: null };
    return {
      state: STATE.OK,
      rows: orderAvailability(team.injuries || []),
      counts: team.counts || null,
      total_rows: (team.injuries || []).length,
      source_status: team.source_status || null,
    };
  };

  const market = buildMarket(board, event);

  const pressurePoints = [
    ...collisions({
      offense: dimensionsOf(awaySide, 'offence'), defense: dimensionsOf(homeSide, 'defence'),
      offenseTeam: awaySide?.team, defenseTeam: homeSide?.team,
    }),
    ...collisions({
      offense: dimensionsOf(homeSide, 'offence'), defense: dimensionsOf(awaySide, 'defence'),
      offenseTeam: homeSide?.team, defenseTeam: awaySide?.team,
    }),
  ];

  /* Requirement: each team's own classified strengths and weaknesses, separate
     from the collision. A pressure point needs BOTH sides to qualify and is
     deliberately strict; this says what each team is, so the page has substance
     on a week where no mismatch clears the bar. */
  const profileOf = side => {
    if (!side) return null;
    const out = [];
    for (const [key, label] of [['offence', 'Offence'], ['defence', 'Defence'],
      ['proe', 'Pass rate over expected'], ['pace', 'Pace']]) {
      const m = side.form?.[key];
      if (!m || m.state === STATE.UNAVAILABLE) continue;
      const band = classify(m.percentile);
      if (band.band === 'STRENGTH' || band.band === 'WEAKNESS') {
        out.push({ dimension: key, label, band: band.band, percentile: m.percentile, plays: m.plays, limited: m.limited });
      }
    }
    return out;
  };

  const payload = {
    ok: true,
    contract: CONTRACT,
    generated_at: new Date().toISOString(),
    entitlement: { pro: true, withheld: [] },
    game: {
      event_id: eventId,
      resolution_rule: rule,
      away: away ? { name: away, abbr: abbrOf(away) } : null,
      home: home ? { name: home, abbr: abbrOf(home) } : null,
      kickoff: event?.kickoff || null,
      started: !!event?.started,
      season, week: event?.week ?? week ?? null,
    },
    slate: events.map(e => ({
      event_id: String(e.id), away: e.away, home: e.home, kickoff: e.kickoff,
      started: !!e.started, books: e.books ?? null,
    })),
    teams: { away: awaySide, home: homeSide },
    profile: { away: profileOf(awaySide), home: profileOf(homeSide) },
    availability: {
      away: away ? availabilityFor(abbrOf(away)) : null,
      home: home ? availabilityFor(abbrOf(home)) : null,
      source: injuries.ok ? injuries.value?.source || null : null,
      freshness: injuries.ok ? injuries.value?.generated_at || null : null,
    },
    changes: changes.ok ? summariseChanges(changes.value, [abbrOf(away), abbrOf(home)]) : { state: STATE.UNAVAILABLE, rows: [] },
    market,
    /* MATCHUP ADVANTAGE. Efficiency against efficiency — never a price. */
    pressure_points: pressurePoints,
    thresholds: {
      strength_percentile: STRENGTH_PERCENTILE,
      weakness_percentile: WEAKNESS_PERCENTILE,
      limited_sample_plays: LIMITED_SAMPLE_PLAYS,
    },
    /* PBE EDGE. Model fair value against the market — a different question, in
       a different object, on purpose. */
    model: { state: 'PENDING', rows: [] },
    role: { state: STATE.UNAVAILABLE, reason: 'no_2026_snap_or_usage_source', players: [] },
    red_zone: { state: STATE.UNAVAILABLE, reason: 'no_2026_play_by_play_source' },
    news: { state: 'CLIENT_FILTERED', note: 'Attribution is applied in the browser by pbe-news-trust.js', raw: news.ok ? news.value : null },
    data_quality: {
      ratings: ratings.ok ? { state: STATE.OK, teams: ratingMap?.size ?? 0, as_of_week: awaySide?.rating?.as_of_week ?? null }
        : { state: STATE.UNAVAILABLE, reason: ratings.error },
      market: market.state === STATE.NO_MARKET ? { state: STATE.NO_MARKET } : { state: STATE.OK, captured_at: market.captured_at, age_seconds: market.age_seconds },
      availability: injuries.ok ? { state: STATE.OK, generated_at: injuries.value?.generated_at || null } : { state: STATE.UNAVAILABLE, reason: injuries.error },
      missing_inputs: [
        { input: 'pass / rush / explosive splits', reason: 'no approved 2026 play-by-play path for this surface' },
        { input: 'snap share, target share, carry share', reason: 'no 2026 snap-count or usage source' },
        { input: 'red-zone detail', reason: 'no approved 2026 play-by-play path for this surface' },
        { input: 'pressure, blitz, coverage', reason: '2026 charting data is not licensed' },
      ],
      upstream: [board, injuries, changes, news, ratings]
        .map(r => ({ source: r.label, ok: r.ok, error: r.error })),
    },
  };

  payload.what_matters_most = whatMattersMost({
    away: { team: awaySide?.team, rating: awaySide?.rating, availability: payload.availability.away?.rows },
    home: { team: homeSide?.team, rating: homeSide?.rating, availability: payload.availability.home?.rows },
    pressurePoints, market,
  });

  if (!pro) {
    return send(res, 200, toFreePayload(payload), 'public, s-maxage=45, stale-while-revalidate=120');
  }

  const model = await soft('model', () => getJson(
    `${GATEWAY}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`, TIMEOUT_MS,
    { accept: 'application/json', 'x-pbe-gateway-token': String(process.env.NFL_GATEWAY_TOKEN || '') }));
  payload.model = model.ok
    ? { state: STATE.OK, rows: model.value?.players || model.value?.rows || [], model_version: model.value?.model_version || null, generated_at: model.value?.generated_at || null }
    : { state: STATE.UNAVAILABLE, reason: model.error, rows: [] };

  return send(res, 200, payload, 'private, no-store, max-age=0');
}

/* ------------------------------------------------------------- helpers */

/** Team name -> abbreviation, through the same directory the product uses. */
const NAME_TO_ABBR = {
  'arizona cardinals': 'ARI', 'atlanta falcons': 'ATL', 'baltimore ravens': 'BAL', 'buffalo bills': 'BUF',
  'carolina panthers': 'CAR', 'chicago bears': 'CHI', 'cincinnati bengals': 'CIN', 'cleveland browns': 'CLE',
  'dallas cowboys': 'DAL', 'denver broncos': 'DEN', 'detroit lions': 'DET', 'green bay packers': 'GB',
  'houston texans': 'HOU', 'indianapolis colts': 'IND', 'jacksonville jaguars': 'JAX', 'kansas city chiefs': 'KC',
  'las vegas raiders': 'LV', 'los angeles chargers': 'LAC', 'los angeles rams': 'LAR', 'miami dolphins': 'MIA',
  'minnesota vikings': 'MIN', 'new england patriots': 'NE', 'new orleans saints': 'NO', 'new york giants': 'NYG',
  'new york jets': 'NYJ', 'philadelphia eagles': 'PHI', 'pittsburgh steelers': 'PIT', 'san francisco 49ers': 'SF',
  'seattle seahawks': 'SEA', 'tampa bay buccaneers': 'TB', 'tennessee titans': 'TEN', 'washington commanders': 'WAS',
};
export function abbrOf(name) {
  const key = String(name || '').toLowerCase().trim();
  return NAME_TO_ABBR[key] || null;
}

/** The three dimensions the collision engine compares, from a composed side. */
function dimensionsOf(side, which) {
  if (!side) return null;
  /* Only the aggregate is sourced today, so it is compared under its own name,
     'overall'. The pass/rush/explosive slots stay null until 2026 play-by-play
     exists — a fabricated split would be worse than none, and an engine that
     only iterates dimensions it never receives produces an empty section
     forever, which is how this one first shipped. */
  const base = which === 'offence' ? side.form.offence : side.form.defence;
  return { overall: base, pass: null, rush: null, explosive: null };
}

/**
 * The market block.
 *
 * The consensus lines come from the SAME best-line payload the event was
 * resolved from — it already carries a per-side consensus line, price, no-vig
 * probability and book count. Two earlier attempts went elsewhere for this and
 * both failed in production: the gateway has no game-intel route (404), and the
 * same-origin one is entitlement-gated (401), which would have made the market
 * Pro-only by accident. This needs no extra call at all.
 */
function buildMarket(board, event) {
  const markets = event?.markets || null;
  const b = board.ok ? board.value : null;
  if (!markets && !b) return { state: STATE.NO_MARKET, reason: board.error || 'no_snapshot' };

  /* Each market is keyed by side name; the shape is {side: {consensus:{line,price,...}}}. */
  const sideOf = (marketName, sideName) => {
    const m = markets?.[marketName];
    if (!m || !sideName) return null;
    const entry = m[sideName];
    if (!entry?.consensus) return null;
    return {
      line: entry.consensus.line ?? null,
      price: entry.consensus.price ?? null,
      no_vig_probability: entry.consensus.no_vig_probability ?? null,
      books: entry.book_count ?? null,
    };
  };
  const total = markets?.total || null;
  const totalSide = total ? (total.Over || total.over || Object.values(total)[0]) : null;

  return {
    state: markets || b ? STATE.OK : STATE.NO_MARKET,
    spread: { away: sideOf('spread', event?.away), home: sideOf('spread', event?.home) },
    moneyline: { away: sideOf('moneyline', event?.away), home: sideOf('moneyline', event?.home) },
    total: totalSide?.consensus
      ? { line: totalSide.consensus.line ?? null, price: totalSide.consensus.price ?? null }
      : null,
    books: event?.books ?? b?.market_summary?.length ?? null,
    quote_count: b?.quote_count ?? null,
    player_market_count: b?.player_market_count ?? null,
    captured_at: b?.captured_at ?? b?.snapshot_captured_at ?? null,
    age_seconds: b?.age_seconds ?? null,
    price_semantics: b?.price_semantics ?? null,
    /* The odds surface declares it holds no movement tape. Saying so is the
       honest answer; inventing an opener is not. */
    movement: { state: STATE.UNAVAILABLE, reason: 'no_open_vs_current_tape_on_this_surface' },
  };
}

function summariseChanges(payload, abbrs) {
  const wanted = new Set(abbrs.filter(Boolean).map(a => String(a).toUpperCase()));
  const rows = (payload?.changes || payload?.items || [])
    .filter(c => wanted.has(String(c.team || c.abbreviation || '').toUpperCase()))
    .slice(0, 10);
  return { state: rows.length ? STATE.OK : STATE.UNAVAILABLE, rows, window_hours: payload?.window_hours ?? null };
}
