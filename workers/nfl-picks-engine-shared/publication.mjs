/* PBE Picks V3 — the customer publication contract.
 *
 * ONE copy of the rules that decide which persisted decisions a customer may
 * see, how each one is labelled, and what a free visitor may see instead.
 * Pure functions only: no I/O, no clock (callers pass nowMs), no randomness.
 * The read service (today the Vercel shim api/pbe-picks.js; the durable target
 * is a Cloudflare read Worker next to the engine) imports this module and does
 * nothing but fetch rows and call it.
 *
 * Two publication classes, fixed at issuance by the database and never
 * reclassified here:
 *
 *   tracking : a real pregame decision made by a champion that is still under
 *              validation. NFL Pro may see it, labelled PBE VALIDATION SIGNAL.
 *              It never enters the Official Track Record and is never called
 *              an official pick.
 *   official : a decision issued by a promoted, TRAINED champion (the database
 *              refuses anything else). Labelled OFFICIAL PBE PICK.
 *
 * The label comes from the row's own publication_scope, never from the
 * champion's current state, so the surface graduates to OFFICIAL on its own
 * when the engine starts issuing official rows, and bootstrap rows that are
 * still in play keep their validation label.
 */

import { EDGE_THRESHOLD, confidenceBucket, quarterKellyUnits, devigTwoWay, clvPoints } from './pick-math.mjs';

export const SCOPE_TRACKING = 'tracking';
export const SCOPE_OFFICIAL = 'official';

export const LABELS = Object.freeze({
  tracking: Object.freeze({
    label: 'PBE VALIDATION SIGNAL',
    tag: 'LIVE VALIDATION · REAL PRE-GAME DECISION · NOT OFFICIAL CHAMPION RECORD',
    record: 'validation_history',
  }),
  official: Object.freeze({
    label: 'OFFICIAL PBE PICK',
    tag: 'OFFICIAL PBE PICK · CHAMPION',
    record: 'official_track_record',
  }),
});

/* Lifecycle as a customer sees it.
 *   ACTIVE     open, kickoff ahead: the engine still holds this decision and
 *              may still withdraw or replace it before kickoff
 *   LOCKED     open, kickoff passed: frozen, in play, awaiting the final
 *   FINAL      graded from the official final
 *   WITHDRAWN  killed before kickoff (edge collapsed). An audit event, never a
 *              pick — even after the grader stamps it graded/void
 *   SUPERSEDED replaced by a later decision on the other side. Never shown as
 *              a pick; only the replacement is current
 */
export const LIFECYCLE = Object.freeze({
  ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', FINAL: 'FINAL', WITHDRAWN: 'WITHDRAWN', SUPERSEDED: 'SUPERSEDED',
});

/* Fields that make a decision actionable. None of them may ever appear in a
 * response a non-Pro caller can receive. assertNoSelection() enforces it on
 * every public payload before it is sent. */
export const SELECTION_FIELDS = Object.freeze([
  'selection', 'selection_team', 'selection_over_under', 'side', 'side_is_home',
  'market_line', 'market_price', 'model_line', 'model_prob', 'market_prob',
  'edge_pct', 'stake_units', 'confidence_bucket', 'features', 'issue', 'model',
  'receipt', 'market_since_issue', 'why_cleared', 'grade', 'progress', 'events', 'id', 'pick_id',
]);

/* The economic terms the receipt freezes. A card is only published if the
 * decision row still equals its own issuance receipt on every one of them. */
const RECEIPT_TERMS = Object.freeze([
  ['pick_id', 'id'], ['game_id', 'game_id'], ['season', 'season'], ['week', 'week'],
  ['kickoff_ts', 'kickoff_ts'], ['issued_at', 'created_at'], ['market', 'market'], ['side', 'side'],
  ['market_line', 'market_line'], ['market_price', 'market_price'], ['model_line', 'model_line'],
  ['model_prob', 'model_prob'], ['market_prob', 'market_prob'], ['edge_pct', 'edge_pct'],
  ['stake_units', 'stake_units'], ['confidence_bucket', 'confidence_bucket'],
  ['model_version', 'model_version'], ['publication_scope', 'publication_scope'],
  ['selection_team', 'selection_team'], ['selection_over_under', 'selection_over_under'],
  ['side_is_home', 'side_is_home'],
]);
const TIME_TERMS = new Set(['kickoff_ts', 'issued_at']);

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const ms = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : null; };

export function labelFor(scope) {
  return scope === SCOPE_OFFICIAL ? LABELS.official : scope === SCOPE_TRACKING ? LABELS.tracking : null;
}

/* The top-level mode of the surface. Health dominates: a stale or dead engine
 * suppresses every actionable framing, whatever the champion state. */
export function displayMode({ health, trained }) {
  if (String(health || '').toUpperCase() !== 'HEALTHY') return 'DEGRADED';
  return trained === true ? 'OFFICIAL' : 'VALIDATION';
}

/* nflverse id -> teams. 2026_01_SF_LA -> SF @ LA. */
export function matchupFromGameId(gameId) {
  const m = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gameId || ''));
  return m ? { game_id: gameId, season: Number(m[1]), week: Number(m[2]), away_team: m[3], home_team: m[4] } : null;
}

/* nflverse codes the Rams LA and Washington WAS; the product and ESPN say LAR
 * and WSH. Display always uses the product code. */
const DISPLAY_CODE = Object.freeze({ LA: 'LAR', WAS: 'WSH' });
const NFLVERSE_CODE = Object.freeze({ LAR: 'LA', WSH: 'WAS' });
export const displayTeam = code => DISPLAY_CODE[code] || code || null;
export const nflverseTeam = code => NFLVERSE_CODE[String(code || '').toUpperCase()] || String(code || '').toUpperCase() || null;

/* The lock boundary is the REAL kickoff, which is what the engine itself
 * issues against (nfl-current). A row's own kickoff_ts is frozen at issuance,
 * and rows issued before the 2026-09-10 kickoff fix carry a time four hours
 * early (ET parsed as UTC); locking on it would call a decision LOCKED while
 * the engine can still replace it. So: a live or final game locks; otherwise
 * nfl-current's kickoff decides; the row's value is only a fallback.
 * `game` is { kickoff, state } from nfl-current, or null. */
export function effectiveKickoff(row, game) {
  return ms(game?.kickoff) ?? ms(row?.kickoff_ts);
}

/* Killed ids come from the persisted audit log (event_type = pick_killed),
 * because the grader later stamps a killed row status=graded / result=void and
 * the status column alone can no longer tell a withdrawal from a final. */
export function lifecycleOf(row, { nowMs, killedIds, game } = {}) {
  const status = String(row?.status || '');
  if (status === 'superseded') return LIFECYCLE.SUPERSEDED;
  if (status === 'killed') return LIFECYCLE.WITHDRAWN;
  if (killedIds && killedIds.has(row?.id)) return LIFECYCLE.WITHDRAWN;
  if (status === 'graded') return LIFECYCLE.FINAL;
  if (status === 'open') {
    const state = String(game?.state || '').toUpperCase();
    if (state === 'LIVE' || state === 'FINAL') return LIFECYCLE.LOCKED;
    const kick = effectiveKickoff(row, game);
    if (kick === null) return null;
    return kick > nowMs ? LIFECYCLE.ACTIVE : LIFECYCLE.LOCKED;
  }
  return null;
}

/* Canonical attribution must be complete and consistent, or the decision is
 * not publishable — the same rule the database enforces at issuance. */
export function attributionValid(row) {
  if (row?.market === 'total') {
    return (row.selection_over_under === 'OVER' || row.selection_over_under === 'UNDER')
      && (row.selection_team === null || row.selection_team === undefined);
  }
  if (row?.market === 'spread' || row?.market === 'moneyline') {
    return Boolean(row.selection_team) && typeof row.side_is_home === 'boolean';
  }
  return false;
}

function sameTerm(key, a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (TIME_TERMS.has(key)) return ms(a) !== null && ms(a) === ms(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const na = finite(a), nb = finite(b);
  if (na !== null && nb !== null) return na === nb;
  return String(a) === String(b);
}

/* Row vs its own issuance receipt payload, term by term. */
export function receiptMatches(row, payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, mismatched: ['receipt_payload_missing'] };
  const mismatched = [];
  for (const [receiptKey, rowKey] of RECEIPT_TERMS) {
    if (!sameTerm(receiptKey, payload[receiptKey], row?.[rowKey])) mismatched.push(receiptKey);
  }
  return { ok: mismatched.length === 0, mismatched };
}

/* The receipt trigger hashes jsonb::text. The read service asks PostgREST for
 * that exact text (payload::text), so recomputing the digest needs no
 * re-serialisation guesswork. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Verifies one receipt: payload digest, chain link, and row-vs-payload terms.
 *   receipt.payload_text  payload::text from the database
 *   row.created_text      created_at::text from the database (chain input)
 */
export async function verifyReceipt(row, receipt) {
  if (!receipt) return { ok: false, reason: 'receipt_missing', payload_hash: false, chain: null, terms: [] };
  let payload = null;
  try { payload = JSON.parse(receipt.payload_text); } catch (_) { payload = null; }
  const payloadHash = typeof receipt.payload_text === 'string'
    && (await sha256Hex(receipt.payload_text)) === receipt.payload_sha256;
  const terms = receiptMatches(row, payload);
  let chain = null;
  if (typeof row?.created_text === 'string' && receipt.chain_hash) {
    const input = `${receipt.previous_chain_hash || 'GENESIS'}:${receipt.payload_sha256}:${row.created_text}:${row.id}`;
    chain = (await sha256Hex(input)) === receipt.chain_hash;
  }
  const scopeOk = receipt.publication_scope === row?.publication_scope && receipt.pick_id === row?.id;
  const ok = payloadHash && terms.ok && scopeOk;
  return {
    ok,
    reason: ok ? null : !scopeOk ? 'receipt_identity_mismatch' : !payloadHash ? 'payload_hash_mismatch' : 'issued_terms_mismatch',
    payload_hash: payloadHash,
    chain,
    terms: terms.mismatched,
  };
}

/* ---------------------------------------------------------------------------
 * Eligibility
 * ------------------------------------------------------------------------ */

/* Decides, for every persisted decision, whether it may appear on the current
 * card and in which lifecycle. Deterministic; returns what was excluded and
 * why, so the canary can prove the filter rather than assume it.
 *
 *   rows       nfl_game_picks rows (current season)
 *   killedIds  Set of pick ids with a pick_killed audit event
 *   verified   Map pick_id -> verifyReceipt() result
 *   week       current NFL week (FINAL rows are shown for this week only)
 */
export function eligibleDecisions(rows, { nowMs, killedIds = new Set(), verified = new Map(), season, week, games = new Map() } = {}) {
  const current = [];
  const withdrawn = [];
  const excluded = { superseded: 0, withdrawn: 0, stale_final: 0, attribution: 0, receipt_unverified: 0, scope: 0, duplicate_open: 0, other_season: 0 };
  const openByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.publication_scope !== SCOPE_TRACKING && row.publication_scope !== SCOPE_OFFICIAL) { excluded.scope += 1; continue; }
    if (season && Number(row.season) !== Number(season)) { excluded.other_season += 1; continue; }
    const lifecycle = lifecycleOf(row, { nowMs, killedIds, game: games.get(row.game_id) || null });
    if (lifecycle === LIFECYCLE.SUPERSEDED || lifecycle === null) { excluded.superseded += lifecycle ? 1 : 0; continue; }
    if (lifecycle === LIFECYCLE.WITHDRAWN) {
      excluded.withdrawn += 1;
      if (week && Number(row.week) === Number(week)) withdrawn.push({ row, lifecycle });
      continue;
    }
    if (lifecycle === LIFECYCLE.FINAL && week && Number(row.week) !== Number(week)) { excluded.stale_final += 1; continue; }
    if (!attributionValid(row)) { excluded.attribution += 1; continue; }
    const check = verified.get(row.id);
    if (!check || check.ok !== true) { excluded.receipt_unverified += 1; continue; }
    if (lifecycle === LIFECYCLE.ACTIVE || lifecycle === LIFECYCLE.LOCKED) {
      /* one_open_pick_per_market makes this impossible in the database; if it
       * ever happened, the newest issuance is the current decision. */
      const key = `${row.game_id}|${row.market}`;
      const prior = openByKey.get(key);
      if (prior) {
        excluded.duplicate_open += 1;
        if (ms(prior.row.created_at) >= ms(row.created_at)) continue;
        current.splice(current.indexOf(prior), 1);
      }
      const entry = { row, lifecycle };
      openByKey.set(key, entry);
      current.push(entry);
      continue;
    }
    current.push({ row, lifecycle });
  }
  const order = { LOCKED: 0, ACTIVE: 1, FINAL: 2 };
  const kickOf = e => effectiveKickoff(e.row, games.get(e.row.game_id)) ?? 0;
  current.sort((a, b) => (order[a.lifecycle] - order[b.lifecycle]) || (kickOf(a) - kickOf(b)) || String(a.row.game_id).localeCompare(String(b.row.game_id)) || String(a.row.market).localeCompare(String(b.row.market)));
  return { current, withdrawn, excluded };
}

/* ---------------------------------------------------------------------------
 * Signal lifecycle: replacements
 *
 * The engine never edits an issued decision. When the other side of a market
 * clears the threshold before kickoff, nfl_replace_open_pick marks the
 * incumbent `superseded` (superseded_by -> the new row) and inserts the
 * replacement in the same transaction. Both rows stay frozen forever.
 *
 * A customer must see that happen: the replacement card carries the full
 * chain of frozen decisions it replaced, each with its own terms and receipt,
 * and the moment it was replaced. A replaced decision is never graded, never
 * counted as a loss and never an Official Track Record pick.
 * ------------------------------------------------------------------------ */

const selectionKey = row => `${row?.market}|${row?.market === 'total' ? row?.selection_over_under : row?.selection_team}`;

/* predecessors: replacement id -> rows it superseded. */
export function lineageIndex(rows) {
  const predecessors = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.status !== 'superseded' || !row.superseded_by) continue;
    if (!predecessors.has(row.superseded_by)) predecessors.set(row.superseded_by, []);
    predecessors.get(row.superseded_by).push(row);
  }
  for (const list of predecessors.values()) list.sort((a, b) => ms(a.created_at) - ms(b.created_at));
  return { predecessors };
}

/* The chain a decision replaced, oldest first: [{ row, replacedBy }]. */
export function lineageOf(row, index) {
  const chain = [];
  const seen = new Set([row?.id]);
  let cur = row;
  while (cur && index?.predecessors?.has(cur.id)) {
    const preds = index.predecessors.get(cur.id).filter(p => !seen.has(p.id));
    if (!preds.length) break;
    const prev = preds[preds.length - 1];
    seen.add(prev.id);
    chain.unshift({ row: prev, replacedBy: cur });
    cur = prev;
  }
  return chain;
}

/* The only replacement reason the engine's own rule allows us to state: the
 * opposite selection qualified (edge at or above the market threshold, stake
 * above zero) on a later market capture. Derived from the two persisted rows;
 * anything that does not satisfy the rule gets no reason at all. */
export function replacementReason(prev, next) {
  if (!prev || !next || prev.market !== next.market) return null;
  const threshold = EDGE_THRESHOLD[next.market];
  const edge = finite(next.edge_pct), stake = finite(next.stake_units);
  if (selectionKey(prev) === selectionKey(next) || threshold === undefined || edge === null || edge < threshold || !(stake > 0)) return null;
  return {
    rule: 'opposite_side_qualified',
    from: selectionOf(prev).display,
    to: selectionOf(next).display,
    new_edge_pp: Number((edge * 100).toFixed(2)),
    threshold_pp: Number((threshold * 100).toFixed(2)),
    new_stake_units: stake,
    source: 'persisted_rows_and_engine_threshold',
  };
}

function receiptSummary(receipt, verification) {
  if (!receipt) return null;
  return {
    seq: receipt.seq,
    receipt_version: receipt.receipt_version,
    issued_at: receipt.issued_at,
    payload_sha256: receipt.payload_sha256,
    chain_hash: receipt.chain_hash,
    publication_scope: receipt.publication_scope,
    verified: {
      payload_hash: verification?.payload_hash === true,
      issued_terms: Array.isArray(verification?.terms) && verification.terms.length === 0,
      chain_link: verification?.chain ?? null,
    },
  };
}

/* One frozen, replaced decision as a customer sees it. `game` is nfl-current's
 * view of the game, so "before lock" is judged against the real kickoff. */
export function replacedEntry({ row, replacedBy }, { receipts = new Map(), verified = new Map(), game = null } = {}) {
  const replacedAt = replacedBy?.created_at || null;
  const kick = effectiveKickoff(row, game);
  const beforeLock = replacedAt !== null && kick !== null ? ms(replacedAt) < kick : null;
  return {
    id: row.id,
    status: 'SIGNAL REPLACED',
    publication_scope: row.publication_scope,
    record: row.publication_scope === SCOPE_OFFICIAL ? 'official_replaced_not_a_pick' : 'validation_history',
    graded: false,
    selection: selectionOf(row),
    issue: { line: finite(row.market_line), price: finite(row.market_price), at: row.created_at },
    model: { version: row.model_version, prob: finite(row.model_prob), fair_line: finite(row.model_line) },
    market_prob: finite(row.market_prob),
    edge_pct: finite(row.edge_pct),
    confidence_bucket: row.confidence_bucket,
    stake_units: finite(row.stake_units),
    receipt: receiptSummary(receipts.get(row.id), verified.get(row.id)),
    replaced_at: replacedAt,
    before_lock: beforeLock,
    replaced_by: replacedBy ? {
      id: replacedBy.id,
      selection: selectionOf(replacedBy),
      issue: { line: finite(replacedBy.market_line), price: finite(replacedBy.market_price), at: replacedBy.created_at },
      receipt_chain_hash: receipts.get(replacedBy.id)?.chain_hash || null,
    } : null,
    reason: replacementReason(row, replacedBy),
  };
}

/* LOCK IMMUTABILITY. After the real kickoff nothing about a decision may
 * change: no replacement, no withdrawal, no new issuance. The engine enforces
 * this by only evaluating games nfl-current still calls scheduled; this check
 * proves it from the persisted rows and reports any breach instead of hiding
 * it. killedAt: Map pick id -> pick_killed occurred_at. */
export function lockViolations(rows, { index, games = new Map(), killedAt = new Map(), byId = new Map() } = {}) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const kick = effectiveKickoff(row, games.get(row.game_id));
    if (kick === null) continue;
    if (ms(row.created_at) >= kick) out.push({ id: row.id, kind: 'issued_after_kickoff', at: row.created_at });
    if (row.status === 'superseded' && row.superseded_by) {
      const next = byId.get(row.superseded_by);
      if (next && ms(next.created_at) >= kick) out.push({ id: row.id, kind: 'replaced_after_kickoff', at: next.created_at });
    }
    const killed = killedAt.get(row.id);
    if (killed && ms(killed) >= kick) out.push({ id: row.id, kind: 'withdrawn_after_kickoff', at: killed });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Presentation facts (all from persisted rows)
 * ------------------------------------------------------------------------ */

function signedLine(value) {
  const n = finite(value);
  if (n === null) return null;
  if (n === 0) return 'PK';
  return `${n > 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(1)}`;
}
function americanText(value) {
  const n = finite(value);
  return n === null ? null : `${n > 0 ? '+' : ''}${Math.round(n)}`;
}

export function selectionOf(row) {
  const matchup = matchupFromGameId(row?.game_id);
  if (row?.market === 'total') {
    const ou = row.selection_over_under;
    return { kind: 'total', over_under: ou, team: null, is_home: null, display: `${ou} ${finite(row.market_line) ?? ''}`.trim() };
  }
  const team = displayTeam(row?.selection_team);
  const opponent = matchup ? displayTeam(row.side_is_home ? matchup.away_team : matchup.home_team) : null;
  const display = row?.market === 'moneyline' ? `${team} ML` : `${team} ${signedLine(row?.market_line) ?? ''}`.trim();
  return { kind: row?.market, team, opponent, is_home: row?.side_is_home, over_under: null, display };
}

/* Same selection on the market tape: same market and same side attribution. */
function sameSide(row, snap) {
  if (row.market !== snap.market) return false;
  if (row.market === 'total') return snap.over_under === row.selection_over_under;
  return Boolean(snap.team) && snap.team === row.selection_team;
}
function oppositeSide(row, snap) {
  if (row.market !== snap.market) return false;
  if (row.market === 'total') return Boolean(snap.over_under) && snap.over_under !== row.selection_over_under;
  return Boolean(snap.team) && snap.team !== row.selection_team;
}

/* Market since issue, from real persisted tape only (nfl_odds_snapshots).
 * The issued call is never rewritten: the issue point is the row itself. */
export function marketSinceIssue(row, snapshots, { nowMs } = {}) {
  const issuedMs = ms(row.created_at);
  const tape = (Array.isArray(snapshots) ? snapshots : [])
    .filter(s => s.game_id === row.game_id)
    .sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
  const mine = tape.filter(s => sameSide(row, s));
  const after = mine.filter(s => issuedMs === null || ms(s.captured_at) >= issuedMs - 60000);
  const close = mine.filter(s => s.is_closing === true).slice(-1)[0] || null;
  const latest = after.slice(-1)[0] || null;
  const reference = close || latest;
  const issue = { line: finite(row.market_line), price: finite(row.market_price), captured_at: row.created_at, market_prob: finite(row.market_prob) };
  if (!reference) {
    return { available: false, reason: 'no_tape_since_issue', issue, current: null, close: null, path: [issue].map(p => ({ ...p, stage: 'issue' })) };
  }
  /* The tape holds one consensus row per side per captured batch, so the
   * opposite side of the same batch is the de-vig partner. */
  const opposite = tape.find(s => oppositeSide(row, s) && s.captured_at === reference.captured_at) || null;
  let probNow = null;
  try { probNow = opposite ? devigTwoWay(reference.price, opposite.price) : null; } catch (_) { probNow = null; }
  const lineDelta = issue.line !== null && finite(reference.line) !== null ? Number((finite(reference.line) - issue.line).toFixed(2)) : null;
  const priceDelta = issue.price !== null && finite(reference.price) !== null ? finite(reference.price) - issue.price : null;
  /* Same sign convention the grader uses for CLV: positive = the issue number
   * is better than the market now. */
  const points = row.market === 'moneyline' ? null : clvPoints({
    market: row.market, side: row.market === 'total' ? row.selection_over_under : row.side,
    pickLine: issue.line, closeLine: finite(reference.line),
  });
  const probDelta = probNow !== null && issue.market_prob !== null ? Number((probNow - issue.market_prob).toFixed(6)) : null;
  const direction = points !== null && points !== 0 ? (points > 0 ? 'toward' : 'against')
    : probDelta !== null && Math.abs(probDelta) >= 0.0025 ? (probDelta > 0 ? 'toward' : 'against')
      : 'flat';
  const path = [{ ...issue, stage: 'issue' }];
  const sampled = after.length > 10 ? after.filter((_, i) => i % Math.ceil(after.length / 10) === 0 || i === after.length - 1) : after;
  for (const s of sampled) path.push({ line: finite(s.line), price: finite(s.price), captured_at: s.captured_at, book: s.book, stage: s.is_closing ? 'close' : 'market' });
  if (close && !path.some(p => p.stage === 'close')) path.push({ line: finite(close.line), price: finite(close.price), captured_at: close.captured_at, book: close.book, stage: 'close' });
  const capturedMs = ms(reference.captured_at);
  return {
    available: true,
    basis: close ? 'close' : 'latest_snapshot',
    issue,
    current: { line: finite(reference.line), price: finite(reference.price), captured_at: reference.captured_at, book: reference.book, market_prob: probNow },
    close: close ? { line: finite(close.line), price: finite(close.price), captured_at: close.captured_at, book: close.book } : null,
    line_delta: lineDelta,
    price_delta: priceDelta,
    clv_points_now: points,
    market_prob_delta: probDelta,
    direction,
    line_moved: lineDelta !== null && lineDelta !== 0,
    snapshots_since_issue: after.length,
    age_seconds: capturedMs !== null && nowMs ? Math.max(0, Math.round((nowMs - capturedMs) / 1000)) : null,
    path,
  };
}

/* WHY IT CLEARED — deterministic threshold checks on persisted terms plus the
 * frozen feature flags. No narrative, no model-generated reasons. Each check
 * reports whether today's engine rule reproduces the persisted value. */
export function whyCleared(row) {
  const edge = finite(row.edge_pct);
  const threshold = EDGE_THRESHOLD[row.market];
  if (edge === null || threshold === undefined) return null;
  let bucket = null, stake = null;
  try { bucket = confidenceBucket(edge, row.market); } catch (_) { bucket = null; }
  try { stake = quarterKellyUnits(Number(row.model_prob), Number(row.market_price)); } catch (_) { stake = null; }
  const f = row.features && typeof row.features === 'object' ? row.features : null;
  const flags = [];
  if (f) {
    if (row.market !== 'total') flags.push({ key: 'home', label: row.side_is_home ? 'Selected side at home' : 'Selected side on the road', value: f.home === 1 });
    if (f.dome === 1) flags.push({ key: 'dome', label: 'Roofed stadium', value: true });
    if (f.wind15 === 1) flags.push({ key: 'wind15', label: 'Forecast wind 15+ mph at kickoff', value: true });
    if (f.cold25 === 1) flags.push({ key: 'cold25', label: 'Forecast 25°F or colder at kickoff', value: true });
    if (finite(f.rest_diff) !== null && finite(f.rest_diff) !== 0) flags.push({ key: 'rest_diff', label: `Rest ${finite(f.rest_diff) > 0 ? 'advantage' : 'deficit'} ${Math.abs(finite(f.rest_diff))} day${Math.abs(finite(f.rest_diff)) === 1 ? '' : 's'}`, value: finite(f.rest_diff) });
    if (finite(f.line_move) !== null && finite(f.line_move) !== 0) flags.push({ key: 'line_move', label: `Market line had moved ${finite(f.line_move) > 0 ? '+' : ''}${finite(f.line_move)} before issue`, value: finite(f.line_move) });
    if (finite(f.prior_blend_weight) !== null) flags.push({ key: 'prior_blend_weight', label: `Early-season prior weight ${Math.round(finite(f.prior_blend_weight) * 100)}%`, value: finite(f.prior_blend_weight) });
  }
  return {
    source: 'persisted_terms_and_frozen_features',
    checks: [
      { key: 'edge', label: 'Model edge cleared the market threshold', value_pp: Number((edge * 100).toFixed(2)), threshold_pp: Number((threshold * 100).toFixed(2)), margin_pp: Number(((edge - threshold) * 100).toFixed(2)), pass: edge >= threshold },
      { key: 'confidence', label: 'Confidence bucket from edge (A ≥ 5.0pp, B ≥ 3.5pp, C ≥ threshold)', persisted: row.confidence_bucket, recomputed: bucket, pass: bucket === row.confidence_bucket },
      { key: 'stake', label: 'Quarter-Kelly stake at the issue price (0.5u floor, 2.0u cap)', persisted: finite(row.stake_units), recomputed: stake, pass: stake !== null && Math.abs(stake - Number(row.stake_units)) < 0.0005 },
    ],
    frozen_flags: flags,
  };
}

/* Live progress for a LOCKED decision, from the live score only. */
export function progressOf(row, game) {
  if (!game || game.state === 'SCHEDULE') return null;
  const away = finite(game.away_score), home = finite(game.home_score);
  if (away === null || home === null) return null;
  const line = finite(row.market_line);
  if (row.market === 'total') {
    if (line === null) return null;
    const total = away + home;
    const over = row.selection_over_under === 'OVER';
    const margin = over ? total - line : line - total;
    return { kind: 'total', total, line, margin, state: margin > 0 ? 'ahead' : margin < 0 ? 'behind' : 'level',
      text: over ? (margin > 0 ? `Over by ${margin}` : `${-margin} point${-margin === 1 ? '' : 's'} to clear ${line}`) : (margin > 0 ? `${margin} point${margin === 1 ? '' : 's'} of room under ${line}` : `Over the number by ${-margin}`) };
  }
  const mine = row.side_is_home ? home : away;
  const theirs = row.side_is_home ? away : home;
  if (row.market === 'moneyline') {
    const margin = mine - theirs;
    return { kind: 'moneyline', margin, state: margin > 0 ? 'ahead' : margin < 0 ? 'behind' : 'level', text: margin > 0 ? `Leading by ${margin}` : margin < 0 ? `Trailing by ${-margin}` : 'Tied' };
  }
  if (line === null) return null;
  const cover = Number((mine - theirs + line).toFixed(1));
  return { kind: 'spread', margin: cover, state: cover > 0 ? 'ahead' : cover < 0 ? 'behind' : 'level', text: cover > 0 ? `Covering by ${cover}` : cover < 0 ? `Short of the cover by ${-cover}` : 'On the number' };
}

/* Event semantics for future opt-in alerts. Derived from persisted audit
 * events, persisted tape and the kickoff — nothing is sent anywhere here. */
export const EVENT_TYPES = Object.freeze({
  NEW_SIGNAL: 'NEW_PBE_SIGNAL',
  MOVED_THROUGH_ISSUE: 'PRICE_MOVED_THROUGH_ISSUE_LINE',
  SUPERSEDED: 'SIGNAL_SUPERSEDED',
  WITHDRAWN: 'SIGNAL_WITHDRAWN',
  LOCKED: 'PICK_LOCKED',
  FINAL: 'FINAL_GRADE',
});

export function eventsFor(row, { audits = [], market = null, lifecycle, grade = null, nowMs, game = null, lineage = [] } = {}) {
  const out = [];
  /* The signals this one replaced come first, so the timeline reads
   * issued -> replaced -> issued ... exactly as it happened. */
  for (const { row: prev, replacedBy } of lineage) {
    out.push({ type: EVENT_TYPES.NEW_SIGNAL, at: prev.created_at, source: 'row:created_at', detail: { selection: selectionOf(prev).display, price: finite(prev.market_price), pick_id: prev.id } });
    out.push({ type: EVENT_TYPES.SUPERSEDED, at: replacedBy?.created_at || null, source: 'row:superseded_by', detail: { selection: selectionOf(prev).display, replaced_by: selectionOf(replacedBy).display } });
  }
  const mine = audits.filter(a => a.pick_id === row.id);
  const created = mine.find(a => a.event_type === 'pick_created');
  out.push({ type: EVENT_TYPES.NEW_SIGNAL, at: row.created_at, source: created ? 'audit:pick_created' : 'row:created_at', detail: { selection: selectionOf(row).display, price: finite(row.market_price), pick_id: row.id, replacement: lineage.length > 0 } });
  if (market?.available && market.line_moved) {
    const first = (market.path || []).find(p => p.stage !== 'issue' && p.line !== null && p.line !== market.issue.line);
    if (first) out.push({ type: EVENT_TYPES.MOVED_THROUGH_ISSUE, at: first.captured_at, source: 'tape:nfl_odds_snapshots', detail: { from: market.issue.line, to: first.line } });
  }
  for (const a of mine) {
    if (a.event_type === 'pick_superseded') out.push({ type: EVENT_TYPES.SUPERSEDED, at: a.occurred_at, source: 'audit:pick_superseded' });
    if (a.event_type === 'pick_killed') out.push({ type: EVENT_TYPES.WITHDRAWN, at: a.occurred_at, source: 'audit:pick_killed' });
  }
  const kick = effectiveKickoff(row, game);
  if ((lifecycle === LIFECYCLE.LOCKED || lifecycle === LIFECYCLE.FINAL) && kick !== null && kick <= nowMs) {
    out.push({ type: EVENT_TYPES.LOCKED, at: new Date(kick).toISOString(), source: game?.kickoff ? 'nfl-current:kickoff' : 'row:kickoff_ts' });
  }
  if (grade) {
    const first = mine.find(a => a.event_type === 'first_grade');
    out.push({ type: EVENT_TYPES.FINAL, at: first?.occurred_at || grade.graded_at || null, source: first ? 'audit:first_grade' : 'grade:graded_at' });
  }
  return out.sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
}

/* ---------------------------------------------------------------------------
 * Cards
 * ------------------------------------------------------------------------ */

/* The complete Pro card. Every value is a persisted fact or a deterministic
 * function of persisted facts. No features leave the server raw. */
export function proCard({ row, lifecycle, receipt, verification, grade, market, game, audits, nowMs, engineHealthy, lineage = [], receipts = new Map(), verified = new Map() }) {
  const scope = labelFor(row.publication_scope);
  const matchup = matchupFromGameId(row.game_id);
  const kick = effectiveKickoff(row, game);
  const replaced = lineage.map(link => replacedEntry(link, { receipts, verified, game }));
  return {
    id: row.id,
    publication_scope: row.publication_scope,
    label: scope.label,
    tag: row.publication_scope === SCOPE_OFFICIAL ? `${scope.tag} v${row.model_version}` : scope.tag,
    record: scope.record,
    lifecycle,
    /* A pre-kickoff decision is actionable only while the engine that holds
     * it is healthy; otherwise it is shown as last-confirmed, not live. */
    actionable: lifecycle === LIFECYCLE.ACTIVE && engineHealthy === true,
    game_id: row.game_id,
    season: row.season,
    week: row.week,
    matchup: matchup ? { away: displayTeam(matchup.away_team), home: displayTeam(matchup.home_team) } : null,
    /* Real kickoff from nfl-current; the row's frozen value stays on the
     * receipt and is reported separately. */
    kickoff_ts: kick !== null ? new Date(kick).toISOString() : row.kickoff_ts,
    kickoff_source: game?.kickoff ? 'nfl-current' : 'decision_row',
    issued_kickoff_ts: row.kickoff_ts,
    seconds_to_kickoff: kick !== null ? Math.round((kick - nowMs) / 1000) : null,
    market: row.market,
    selection: selectionOf(row),
    issue: {
      line: finite(row.market_line),
      price: finite(row.market_price),
      at: row.created_at,
    },
    model: {
      version: row.model_version,
      prob: finite(row.model_prob),
      fair_line: finite(row.model_line),
    },
    market_prob: finite(row.market_prob),
    edge_pct: finite(row.edge_pct),
    confidence_bucket: row.confidence_bucket,
    stake_units: finite(row.stake_units),
    status: row.status,
    receipt: receipt ? {
      seq: receipt.seq,
      receipt_version: receipt.receipt_version,
      issued_at: receipt.issued_at,
      payload_sha256: receipt.payload_sha256,
      previous_chain_hash: receipt.previous_chain_hash,
      chain_hash: receipt.chain_hash,
      publication_scope: receipt.publication_scope,
      verified: {
        payload_hash: verification?.payload_hash === true,
        issued_terms: Array.isArray(verification?.terms) && verification.terms.length === 0,
        chain_link: verification?.chain ?? null,
      },
    } : null,
    market_since_issue: market,
    why_cleared: whyCleared(row),
    game: game ? { espn_id: game.espn_id, state: game.state, detail: game.detail, kickoff: game.kickoff || null, away_score: finite(game.away_score), home_score: finite(game.home_score) } : null,
    progress: lifecycle === LIFECYCLE.LOCKED || lifecycle === LIFECYCLE.FINAL ? progressOf(row, game) : null,
    grade: grade ? {
      result: grade.result,
      units_delta: finite(grade.units_delta),
      clv_points: finite(grade.clv_points),
      clv_prob: finite(grade.clv_prob),
      clv_beat: typeof grade.clv_beat === 'boolean' ? grade.clv_beat : null,
      brier: finite(grade.brier),
      graded_at: grade.graded_at || null,
    } : null,
    /* SIGNAL LIFECYCLE. revision 1 is an original decision; revision n > 1
     * replaced n-1 frozen decisions on this market, all shown. */
    lineage: {
      revision: replaced.length + 1,
      replaced,
      replaces: replaced.length ? replaced[replaced.length - 1] : null,
      post_lock_changes: replaced.filter(r => r.before_lock === false).length,
    },
    /* Kickoff is the lock boundary: before it the engine may replace this
     * decision (visibly, as a new row); after it nothing can change. */
    lock: {
      boundary: kick !== null ? new Date(kick).toISOString() : null,
      locked: lifecycle === LIFECYCLE.LOCKED || lifecycle === LIFECYCLE.FINAL,
      replaceable: lifecycle === LIFECYCLE.ACTIVE,
    },
    events: eventsFor(row, { audits, market, lifecycle, grade, nowMs, game, lineage }),
  };
}

/* A withdrawn decision is an audit event, not a pick: no selection, no terms. */
export function withdrawnEvent({ row, audits }) {
  const matchup = matchupFromGameId(row.game_id);
  const killed = (audits || []).find(a => a.pick_id === row.id && a.event_type === 'pick_killed');
  return {
    publication_scope: row.publication_scope,
    game_id: row.game_id,
    matchup: matchup ? { away: displayTeam(matchup.away_team), home: displayTeam(matchup.home_team) } : null,
    market: row.market,
    kickoff_ts: row.kickoff_ts,
    withdrawn_at: killed?.occurred_at || null,
    reason: killed?.detail?.reason === 'edge_collapsed' ? 'edge_collapsed' : 'withdrawn',
  };
}

/* What a free visitor may see about a current decision: that it exists, what
 * game and market it is on, and when it was issued. Nothing actionable. */
export function lockedPreview({ row, lifecycle, game = null, revisions = 0 }) {
  const matchup = matchupFromGameId(row.game_id);
  const scope = labelFor(row.publication_scope);
  const kick = effectiveKickoff(row, game);
  return {
    publication_scope: row.publication_scope,
    label: scope.label,
    lifecycle,
    game_id: row.game_id,
    matchup: matchup ? { away: displayTeam(matchup.away_team), home: displayTeam(matchup.home_team) } : null,
    kickoff_ts: kick !== null ? new Date(kick).toISOString() : row.kickoff_ts,
    market: row.market,
    issued_at: row.created_at,
    /* How many times this market's signal was replaced before lock. Not
     * actionable; shown to everyone so model evolution is never hidden. */
    revisions,
    locked: true,
  };
}

/* Throws if any actionable field is present anywhere in a public payload. The
 * read service runs this on every non-Pro response before sending it. */
export function assertNoSelection(payload, path = '$') {
  if (Array.isArray(payload)) { payload.forEach((v, i) => assertNoSelection(v, `${path}[${i}]`)); return true; }
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (SELECTION_FIELDS.includes(key)) throw new Error(`selection_leak:${path}.${key}`);
      assertNoSelection(value, `${path}.${key}`);
    }
  }
  return true;
}

/* Hero summary. "Strongest" is the highest persisted edge among actionable
 * cards, ties broken by persisted confidence then kickoff — stored fields only. */
export function cardSummary(cards, { nowMs } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const active = list.filter(c => c.lifecycle === LIFECYCLE.ACTIVE);
  const locked = list.filter(c => c.lifecycle === LIFECYCLE.LOCKED);
  const final = list.filter(c => c.lifecycle === LIFECYCLE.FINAL);
  const rank = { A: 0, B: 1, C: 2 };
  const strongest = active.slice().sort((a, b) =>
    ((b.edge_pct ?? -1) - (a.edge_pct ?? -1)) || ((rank[a.confidence_bucket] ?? 9) - (rank[b.confidence_bucket] ?? 9)) || (ms(a.kickoff_ts) - ms(b.kickoff_ts)))[0] || null;
  const upcoming = [...active, ...locked].map(c => ms(c.kickoff_ts)).filter(t => t !== null && t > (nowMs ?? 0)).sort((a, b) => a - b)[0];
  const settled = final.filter(c => ['win', 'loss', 'push'].includes(c.grade?.result));
  return {
    replaced_before_lock: list.reduce((n, c) => n + (c.lineage?.replaced?.length || 0), 0),
    revised_signals: list.filter(c => (c.lineage?.replaced?.length || 0) > 0).length,
    active: active.length,
    locked: locked.length,
    final: final.length,
    total: list.length,
    strongest: strongest ? { id: strongest.id, basis: 'highest_persisted_edge' } : null,
    next_kickoff: upcoming ? new Date(upcoming).toISOString() : null,
    week_units: settled.length ? Number(settled.reduce((s, c) => s + (c.grade.units_delta ?? 0), 0).toFixed(4)) : null,
    week_record: settled.length ? {
      win: settled.filter(c => c.grade.result === 'win').length,
      loss: settled.filter(c => c.grade.result === 'loss').length,
      push: settled.filter(c => c.grade.result === 'push').length,
    } : null,
  };
}
