/* PropBetEdge NFL — PBE Touchdown Targets grading, as pure functions.
 *
 * THE DEFINITION, STATED ONCE
 *
 *   PBE TARGET RESULT = WIN  when the official final box score credits the
 *                            selected player with at least one RUSHING or
 *                            RECEIVING touchdown in that game.
 *
 * A quarterback's passing touchdowns are never his own score. A return or
 * defensive touchdown is not part of the PBE result either — but it is read
 * off the same box score and recorded on the grade, because a book's
 * anytime-touchdown rule may include it and we hold no book's rulebook. The
 * divergence therefore lives on the row as a fact rather than in an argument
 * after the event.
 *
 * WHY NOT "VOID WHEN HE DOESN'T APPEAR"
 * A box score lists a player who recorded a stat. A receiver who played every
 * snap and was never thrown to may not appear at all, and neither may a healthy
 * scratch. Voiding both would quietly delete the losses and inflate the hit
 * rate, so absence from the final box score is a LOSS, with
 * `participation_observed: false` recorded so the row says exactly what was
 * seen. Only an explicit did-not-play flag — a factual observation of
 * non-participation — voids a target.
 *
 * Deterministic and idempotent: the same box score always produces the same
 * grade object, and the grade object is compared field by field before
 * anything is written, so a re-run writes nothing.
 */

import { normalizePlayerName, americanToImpliedProbability, round } from './td-kernel.mjs';

export const RESULT_DEFINITION = 'pbe_offensive_td_from_final_box_score';

/* Box-score groups that credit a touchdown to the player who scored it. */
const OFFENSIVE_GROUPS = ['rushing', 'receiving'];
const NON_OFFENSIVE_GROUPS = ['kickreturns', 'puntreturns', 'interceptions', 'defensive', 'fumbles'];

const arr = value => (Array.isArray(value) ? value : []);
const groupName = group => String(group?.name || group?.display_name || '').toLowerCase().replace(/[^a-z]/g, '');

/* The TD column of a labelled stat group. ESPN labels it exactly "TD" in every
 * group that has one; a group without that label has no touchdown column and
 * contributes nothing rather than a guessed index. */
function tdIndex(group) {
  const labels = arr(group?.labels).map(label => String(label).toUpperCase().trim());
  const exact = labels.indexOf('TD');
  if (exact >= 0) return exact;
  const loose = labels.findIndex(label => label === 'TDS');
  return loose;
}

function statNumber(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/* Everything the box score says about one player's scoring in one game.
 * Reports what it SAW, and leaves the verdict to gradeTarget. */
export function readPlayerScoring(playerStats, playerKey) {
  const target = normalizePlayerName(playerKey);
  const seen = {
    participation_observed: false,
    did_not_play: false,
    offensive_td: 0,
    rushing_td: null,
    receiving_td: null,
    non_offensive_td: 0,
    non_offensive_detail: {},
    groups_seen: [],
  };
  let matched = false;

  for (const teamBlock of arr(playerStats)) {
    for (const group of arr(teamBlock?.groups)) {
      const name = groupName(group);
      const isOffensive = OFFENSIVE_GROUPS.includes(name);
      const isNonOffensive = NON_OFFENSIVE_GROUPS.includes(name);
      if (!isOffensive && !isNonOffensive) continue;
      const index = tdIndex(group);
      for (const row of arr(group?.athletes)) {
        const athlete = row?.athlete || {};
        const name2 = athlete.name || athlete.display_name || athlete.short_name || '';
        if (normalizePlayerName(name2) !== target) continue;
        matched = true;
        seen.groups_seen.push(name);
        if (row?.did_not_play === true) { seen.did_not_play = true; continue; }
        seen.participation_observed = true;
        if (index < 0) continue;
        const touchdowns = statNumber(arr(row?.stats)[index]);
        if (touchdowns === null) continue;
        if (isOffensive) {
          if (name === 'rushing') seen.rushing_td = touchdowns;
          if (name === 'receiving') seen.receiving_td = touchdowns;
          seen.offensive_td += touchdowns;
        } else {
          seen.non_offensive_td += touchdowns;
          seen.non_offensive_detail[name] = touchdowns;
        }
      }
    }
  }
  seen.matched = matched;
  return seen;
}

/* The grade. `target` is the persisted pick row; `seen` is readPlayerScoring's
 * observation; `closing` is the last pre-kick price, when one was captured. */
export function gradeTarget({ target, seen, closing }) {
  const withdrawn = String(target?.status || '') === 'killed';
  let result;
  let participationNote;

  if (withdrawn) {
    result = 'void';
    participationNote = 'target_withdrawn_before_kickoff';
  } else if (seen?.did_not_play === true) {
    result = 'void';
    participationNote = 'box_score_reported_did_not_play';
  } else if (seen?.matched !== true) {
    /* He is not in the final box score. He did not score. */
    result = 'loss';
    participationNote = 'absent_from_final_box_score';
  } else {
    result = seen.offensive_td > 0 ? 'win' : 'loss';
    participationNote = seen.participation_observed ? 'observed_in_final_box_score' : 'listed_without_a_stat_line';
  }

  const modelProb = Number(target?.model_prob);
  const price = Number(target?.market_price);
  const units = unitsFor(result, price);
  const closingProb = closing?.price === null || closing?.price === undefined
    ? null : americanToImpliedProbability(closing.price);
  const issueProb = Number.isFinite(Number(target?.market_prob)) ? Number(target.market_prob) : null;

  return {
    pick_id: target.id,
    /* The countable fact behind the verdict, in the column the prop grader
     * already uses for "what actually happened". */
    final_value: result === 'void' ? null : seen?.offensive_td ?? null,
    result,
    units_delta: units,
    closing_line: null,
    closing_price: closing?.price ?? null,
    closing_opposite_price: closing?.opposite_price ?? null,
    closing_market_prob: closingProb === null ? null : round(closingProb, 6),
    clv_points: null,
    clv_prob: closingProb === null || issueProb === null ? null : round(closingProb - issueProb, 6),
    clv_beat: closingProb === null || issueProb === null ? null : closingProb - issueProb > 0,
    brier: result === 'win' || result === 'loss'
      ? (Number.isFinite(modelProb) ? round((modelProb - (result === 'win' ? 1 : 0)) ** 2, 6) : null)
      : null,
    source: 'espn_cdn_gamepackage_final_box_score',
    result_definition: RESULT_DEFINITION,
    non_offensive_td: seen?.matched === true ? (seen.non_offensive_td || 0) > 0 : null,
    settlement_note: {
      pbe_definition: 'at least one rushing or receiving touchdown credited to the player',
      participation: participationNote,
      offensive_td: seen?.offensive_td ?? null,
      rushing_td: seen?.rushing_td ?? null,
      receiving_td: seen?.receiving_td ?? null,
      non_offensive_td: seen?.non_offensive_td ?? null,
      non_offensive_detail: seen?.non_offensive_detail ?? null,
      groups_seen: seen?.groups_seen ?? null,
      book_settlement_may_differ: (seen?.non_offensive_td || 0) > 0 && (seen?.offensive_td || 0) === 0
        ? 'this player scored a non-offensive touchdown; a book whose anytime-touchdown rule includes '
          + 'return or defensive scores would settle this differently from the PBE target result'
        : null,
    },
  };
}

/* One unit risked at the persisted issuance price. A win with no persisted
 * price has no profit and therefore no units — never a default price, never
 * an assumed -110. */
export function unitsFor(result, price) {
  if (result === 'void') return 0;
  if (result === 'push') return 0;
  if (result === 'loss') return -1;
  if (result !== 'win') throw new Error(`bad_result:${result}`);
  const value = Number(price);
  if (!Number.isFinite(value) || value === 0) return 0;
  return round(value > 0 ? value / 100 : 100 / Math.abs(value), 4);
}

/* Idempotency: the fields that decide whether a stored grade is already the
 * grade this box score produces. */
const GRADE_FIELDS = Object.freeze([
  'final_value', 'result', 'units_delta', 'closing_price', 'closing_opposite_price',
  'closing_market_prob', 'clv_prob', 'clv_beat', 'brier', 'result_definition', 'non_offensive_td',
]);

export function sameGrade(stored, fresh) {
  return GRADE_FIELDS.every(field => equalValue(stored?.[field], fresh?.[field]));
}

function equalValue(a, b) {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) return true;
  if (aMissing !== bMissing) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  const an = Number(a), bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return Math.abs(an - bn) < 1e-9;
  return String(a) === String(b);
}

export function gradeSummary(row) {
  return {
    result: row?.result ?? null,
    final_value: row?.final_value ?? null,
    units_delta: row?.units_delta ?? null,
    clv_prob: row?.clv_prob ?? null,
    brier: row?.brier ?? null,
    non_offensive_td: row?.non_offensive_td ?? null,
  };
}

export function outcomeBit(result) {
  if (result === 'win') return 1;
  if (result === 'loss') return 0;
  return null;
}

/* The finalized learning observation. The feature vector is the one frozen at
 * issuance and is copied, never recomputed: rebuilding it now would mean
 * rebuilding it from information that did not exist at decision time, which is
 * the definition of look-ahead leakage. */
export function learningObservation({ target, grade }) {
  const features = target?.model_snapshot?.features;
  if (!features || typeof features !== 'object' || !Object.keys(features).length) {
    throw new Error('issuance_feature_snapshot_missing');
  }
  return {
    pick_id: target.id,
    season: target.season,
    week: target.week,
    market: target.market,
    phase: target.phase,
    publication_scope: target.publication_scope || 'tracking',
    features,
    model_prob: target.model_prob,
    market_prob: target.market_prob,
    edge_pct: target.edge_pct,
    ev_pct: target.ev_pct,
    confidence_bucket: target.confidence_bucket,
    outcome: outcomeBit(grade.result),
    clv_beat: grade.clv_beat,
    units_delta: grade.units_delta,
    brier: grade.brier,
    finalized_at: new Date().toISOString(),
    is_final: true,
  };
}
