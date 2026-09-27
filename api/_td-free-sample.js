/* PBE Touchdown Targets — view=free-sample, the FREE TD TARGETS product.
 *
 * Shared by the Vercel function (api/pbe-touchdown-targets.js) and the
 * Cloudflare contract (workers/nfl-touchdown-targets-api/src/contract.js), so
 * the two cannot drift.
 *
 * WHAT IT IS
 * Up to TWO player-level anytime-touchdown targets per NFL slate, drawn from the
 * existing Touchdown Targets engine (pbe-td-hazard-v1). There is no second
 * selection system here: every row is a target the orchestrator already issued,
 * frozen and receipted. This module only decides which of those may be given
 * away, and how little of each leaves.
 *
 * THE ELIGIBILITY RULE (one named predicate: isFreeTdEligible)
 *   official scope  — the standing free-sample record contract (commit 23e37cf):
 *                     only an OFFICIAL decision may leave a free sample. A
 *                     tracking target is a verified live record but it is not a
 *                     publication, so it never qualifies, whatever it scored.
 *   primary         — the one player PBE names for the game. Secondaries are
 *                     never free.
 *   open            — issued and not withdrawn (killed / superseded) or settled.
 *   pregame         — issued strictly before kickoff.
 *   identity        — resolved to a GSIS id at issuance. A name alone never
 *                     identifies a player (Jr./Sr./II/III share names).
 * The owner changes the free product by changing THIS predicate, nowhere else.
 *
 * SLATE: one ET game day. The free sample covers the earliest ET kickoff date,
 * on or after today (ET), that still has an eligible target — so Thursday,
 * Sunday and Monday are separate slates, each with at most two. If every
 * eligible open target is on an earlier date (a game still awaiting its final),
 * the most recent such date is the slate. freeTdSlateDate() is the rule.
 *
 * IDENTITY OF A FREE TARGET: target_id is nfl_prop_picks.id — the primary key
 * of an issuance row whose issuance fields are frozen by trigger. It never
 * changes. A target replaced before kickoff is a NEW row with a new id; the old
 * one is superseded and simply stops appearing here.
 *
 * ORDER: the selector's own ranking key — PBE probability, highest first — then
 * kickoff, then target id, so the same rows always give the same two. The
 * probability orders; it is never sent.
 *
 * WHAT NEVER LEAVES: probability, market probability, edge, EV, price, book,
 * rank, confidence, drivers/factors, the model snapshot, receipts, or any
 * target beyond the first two. FREE_TD_TARGET_KEYS is the exact shape.
 */

export const FREE_TD_CONTRACT = 'pbe-nfl-free-td-targets-v1';
export const FREE_TD_PRODUCT_VERSION = 'nfl-free-td-targets/1.0.0';
export const FREE_TD_MAX_TARGETS = 2;
export const FREE_TD_ELIGIBILITY_RULE = 'official_primary_pregame_td_target';
export const FREE_TD_FULL_PRODUCT_URL = 'https://nfl.propbetedge.ai/#tdtargets';
export const FREE_TD_CTA_LABEL = 'Unlock all TD Targets';
export const FREE_TD_EMPTY_MESSAGE = 'No qualified free TD targets yet';
const MARKET = 'player_anytime_td';

/* The exact keys a free target carries. A test pins this list. */
export const FREE_TD_TARGET_KEYS = Object.freeze([
  'target_id', 'selection_type', 'free', 'official', 'publication_scope', 'market',
  'player_id', 'player_name', 'position', 'team', 'opponent', 'home_away',
  'game_id', 'game_label', 'slate_date', 'kickoff_ts', 'game_status', 'headshot_url',
  'model_version', 'selector_version', 'issued_at', 'locked_at', 'insights',
]);

/* Server-side read only: model_snapshot is needed for identity and insights and
 * is reduced before anything is sent. */
const FREE_READ_FIELDS = [
  'id', 'event_id', 'season', 'week', 'kickoff_ts', 'player_name', 'player_key',
  'market', 'model_prob', 'target_rank', 'projection_model_version', 'selector_version',
  'publication_scope', 'status', 'created_at', 'model_snapshot',
].join(',');

const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const arr = value => (Array.isArray(value) ? value : []);
const text = value => {
  const s = String(value ?? '').trim();
  return s || null;
};

/* The identity the engine resolved at issuance (roster / model player index).
 * GSIS is the id; never the name. */
export function freeTdPlayerId(row) {
  const gsis = text(row?.model_snapshot?.player?.gsis_id);
  return gsis && /^00-\d{7}$/.test(gsis) ? gsis : null;
}
export function freeTdGameId(row) {
  const event = row?.model_snapshot?.event || {};
  return text(event.game_id) || text(event.espn_id) || text(row?.event_id);
}

/* THE eligibility predicate. See the header. Allow-list: an unknown or missing
 * value never qualifies. */
export function isFreeTdEligible(row) {
  if (!row || row.market !== MARKET) return false;
  if (String(row.publication_scope || '').toLowerCase() !== 'official') return false;
  if (row.target_rank !== 'primary') return false;
  if (row.status !== 'open') return false;
  const issued = Date.parse(row.created_at || '');
  const kickoff = Date.parse(row.kickoff_ts || '');
  if (!Number.isFinite(issued) || !Number.isFinite(kickoff) || !(issued < kickoff)) return false;
  if (!freeTdPlayerId(row)) return false;
  return true;
}

/* The ET calendar date (YYYY-MM-DD) of an instant. */
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function etDate(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) ? ET_DATE.format(new Date(ms)) : null;
}

/* The slate day the free sample covers, from the ELIGIBLE rows only. */
export function freeTdSlateDate(rows, nowMs = Date.now()) {
  const dates = [...new Set(arr(rows).filter(isFreeTdEligible).map(row => etDate(row.kickoff_ts)).filter(Boolean))].sort();
  if (!dates.length) return null;
  const today = etDate(nowMs);
  return dates.find(date => date >= today) || dates[dates.length - 1];
}

/* "AWAY @ HOME" in team codes, from the resolved player's side of the game,
 * falling back to the nflverse game id (2026_03_LV_NO). */
export function freeTdGameLabel(row) {
  const player = row?.model_snapshot?.player || {};
  const team = text(player.team);
  const opponent = text(player.opponent);
  if (team && opponent && typeof player.at_home === 'boolean') {
    return player.at_home ? `${opponent} @ ${team}` : `${team} @ ${opponent}`;
  }
  const m = /^\d{4}_\d{2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(row?.model_snapshot?.event?.game_id || ''));
  return m ? `${m[1]} @ ${m[2]}` : null;
}

/* Eligible rows on ONE slate day, in the selector's order, one per
 * player+game, at most two. */
export function selectFreeTdTargets(rows, max = FREE_TD_MAX_TARGETS, nowMs = Date.now()) {
  const limit = Math.min(Math.max(0, Number(max) || 0), FREE_TD_MAX_TARGETS);
  const slate = freeTdSlateDate(rows, nowMs);
  const ordered = arr(rows).filter(isFreeTdEligible).filter(row => etDate(row.kickoff_ts) === slate).sort((a, b) => {
    const pa = num(a.model_prob) ?? -1;
    const pb = num(b.model_prob) ?? -1;
    if (pb !== pa) return pb - pa;
    const ka = Date.parse(a.kickoff_ts);
    const kb = Date.parse(b.kickoff_ts);
    if (ka !== kb) return ka - kb;
    return String(a.id).localeCompare(String(b.id));
  });
  const seen = new Set();
  const out = [];
  for (const row of ordered) {
    const key = `${freeTdPlayerId(row)}|${freeTdGameId(row)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/* Two or three short reasons, built only from values the frozen snapshot
 * actually carries. A component that was unavailable produces nothing. */
const f1 = value => Number(value).toFixed(1);
const f2 = value => Number(value).toFixed(2);
export function freeTdInsights(snapshot) {
  const out = [];
  const components = snapshot?.probability?.components || {};
  const player = snapshot?.player || {};

  const role = components.red_zone_role;
  const rzPlayer = num(role?.player_rz_opportunities_per_game);
  if (role?.available === true && rzPlayer !== null) {
    const rzPosition = num(role.position_rz_opportunities_per_game);
    out.push({
      label: 'Red-zone role',
      value: `${f1(rzPlayer)} red-zone opportunities per game${rzPosition !== null && player.position ? ` (${player.position} average ${f1(rzPosition)})` : ''}`,
    });
  }

  const base = snapshot?.probability?.base || {};
  const current = base.current_season;
  const currentRate = num(current?.rate);
  const currentGames = num(current?.weight);
  const history = base.history;
  const historyRate = num(history?.rate);
  if (current?.available === true && currentRate !== null && currentGames !== null && currentGames > 0) {
    out.push({
      label: 'This season',
      value: `${f2(currentRate)} rushing + receiving TDs per game over ${currentGames} game${currentGames === 1 ? '' : 's'}`,
    });
  } else if (history?.available === true && historyRate !== null) {
    out.push({ label: 'Scoring history', value: `${f2(historyRate)} rushing + receiving TDs per game (recency-weighted)` });
  }

  const opponent = components.opponent;
  const oppRush = num(opponent?.opponent_rushing_td_allowed_per_game);
  const oppRec = num(opponent?.opponent_receiving_td_allowed_per_game);
  if (opponent?.available === true && oppRush !== null && oppRec !== null) {
    out.push({
      label: 'Opponent TD allowance',
      value: `${player.opponent ? `${player.opponent} allows ` : ''}${f2(oppRush)} rushing + ${f2(oppRec)} receiving TDs per game`,
    });
  }

  if (out.length < 3) {
    const implied = num(snapshot?.game_context?.implied_team_total?.[player.team]);
    if (implied !== null && player.team) {
      out.push({ label: 'Team implied total', value: `${player.team} ${f2(implied).replace(/\.?0+$/, '')} points (sportsbook consensus)` });
    }
  }
  return out.slice(0, 3);
}

const headshotUrl = espnId => (/^\d+$/.test(String(espnId || ''))
  ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : null);

/* One free target. Built key by key from FREE_TD_TARGET_KEYS' vocabulary; no
 * spread of the source row, so a new column can never leak through. */
export function shapeFreeTdTarget(row, nowMs = Date.now()) {
  const snapshot = row?.model_snapshot || {};
  const player = snapshot.player || {};
  const kickoffMs = Date.parse(row.kickoff_ts);
  const started = Number.isFinite(kickoffMs) && nowMs >= kickoffMs;
  return {
    target_id: row.id,
    selection_type: 'td_target',
    free: true,
    official: true,
    publication_scope: 'official',
    market: MARKET,
    player_id: freeTdPlayerId(row),
    player_name: row.player_name,
    position: text(player.position),
    team: text(player.team),
    opponent: text(player.opponent),
    home_away: player.at_home === true ? 'home' : player.at_home === false ? 'away' : null,
    game_id: freeTdGameId(row),
    game_label: freeTdGameLabel(row),
    slate_date: etDate(row.kickoff_ts),
    kickoff_ts: row.kickoff_ts,
    /* From the kickoff clock only; the grade, not this, settles the game. */
    game_status: started ? 'started' : 'scheduled',
    headshot_url: headshotUrl(player.espn_id),
    model_version: row.projection_model_version || null,
    selector_version: row.selector_version ?? null,
    issued_at: row.created_at,
    /* An open target may be replaced or withdrawn until kickoff; from kickoff it
     * cannot move (nfl_td_no_withdrawal_after_kickoff). */
    locked_at: started ? row.kickoff_ts : null,
    insights: freeTdInsights(snapshot),
  };
}

export function freeTdEligibilityReason({ state, eligibleCount }) {
  if (eligibleCount > 0) return null;
  if (String(state?.publication || '').toUpperCase() !== 'ALLOWED') return 'td_publication_gated';
  if (String(state?.engine_health || '').toUpperCase() !== 'HEALTHY') return 'td_engine_degraded';
  return 'no_official_primary_td_target';
}

/* The whole response body, from governance state and the slate's rows. Pure. */
export function buildFreeTdPayload({ state, rows, season, week, nowMs = Date.now() }) {
  const selected = selectFreeTdTargets(rows, FREE_TD_MAX_TARGETS, nowMs);
  const slateDate = selected.length ? freeTdSlateDate(rows, nowMs) : null;
  const targets = selected.map(row => shapeFreeTdTarget(row, nowMs));
  if (targets.length > FREE_TD_MAX_TARGETS || targets.some(t => t.publication_scope !== 'official' || t.slate_date !== slateDate)) {
    throw new Error('free_td_sample_contract_violation');
  }
  const reason = freeTdEligibilityReason({ state, eligibleCount: targets.length });
  return {
    contract: FREE_TD_CONTRACT,
    sport: 'NFL',
    product: 'free_td_targets',
    product_version: FREE_TD_PRODUCT_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    season: season ?? null,
    week: week ?? null,
    /* ET game day this sample covers; null when there is no eligible target. */
    slate_date: slateDate,
    max_targets: FREE_TD_MAX_TARGETS,
    count: targets.length,
    eligibility: {
      rule: FREE_TD_ELIGIBILITY_RULE,
      publication: state?.publication ?? null,
      gate_open: state?.gate_open === true,
      reason,
    },
    targets,
    empty_state: targets.length ? null : { code: reason, message: FREE_TD_EMPTY_MESSAGE },
    full_product_url: FREE_TD_FULL_PRODUCT_URL,
    cta_label: FREE_TD_CTA_LABEL,
  };
}

/* The view. `governance` is the caller's own (Vercel or Worker), so the
 * publication state is the one every other view reports. */
export async function freeSampleView({ res, send, sb, secret, governance }) {
  const state = await governance(secret);
  const season = state?.current?.season ?? null;
  const week = state?.current?.week ?? null;
  if (!season || week === null || week === undefined) {
    return send(res, 503, { error: 'season_unresolved', engine_state: 'ENGINE DEGRADED — SOURCE UNAVAILABLE' });
  }
  const rows = await sb(
    'nfl_prop_picks',
    `market=eq.${MARKET}&season=eq.${season}&week=eq.${week}&status=eq.open&target_rank=eq.primary`
      + `&select=${FREE_READ_FIELDS}&order=kickoff_ts.asc&limit=64`,
    secret,
  );
  const body = buildFreeTdPayload({ state, rows: arr(rows), season, week });
  res.setHeader('Access-Control-Allow-Origin', '*');
  return send(res, 200, body, 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
}
