/* Football history graph — bitemporal AS-OF semantics.
 *
 * Every time-varying fact carries two clocks:
 *   valid time      effective_from / effective_to   when it was true in the world
 *   knowledge time  observed_at                     when PropBetEdge (or its
 *                                                  source) could first know it
 *   (event_time and source_observed_at are kept too, but these two decide.)
 *
 * A model dataset or a "what was knowable before kickoff" view asks for facts
 * valid at `validAt` AND observed no later than `knownAt`. A row observed after
 * the cutoff is invisible even when it describes an earlier moment — that is
 * how a later injury designation, a retroactive stat correction or a trade
 * announced after the game stays out of pre-game features.
 *
 * Intervals are half-open: [effective_from, effective_to). A null
 * effective_to means "still in effect as far as this row knows".
 */

const ms = v => (v === null || v === undefined ? null : (typeof v === 'number' ? v : Date.parse(v)));

export class TemporalError extends Error {}

function assertInstant(name, value) {
  const t = ms(value);
  if (!Number.isFinite(t)) throw new TemporalError(`${name}_required`);
  return t;
}

/** Is this row true at validAt and knowable by knownAt? Pure. */
export function visibleAsOf(row, { validAt, knownAt }) {
  const v = assertInstant('validAt', validAt);
  const k = assertInstant('knownAt', knownAt);
  const observed = ms(row?.observed_at);
  if (!Number.isFinite(observed)) return false;          // unknowable rows never leak in
  if (observed > k) return false;
  const from = ms(row?.effective_from);
  if (Number.isFinite(from) && from > v) return false;
  const to = ms(row?.effective_to);
  if (Number.isFinite(to) && to <= v) return false;
  return true;
}

/**
 * Resolve the state as it was knowable: among visible rows for one subject,
 * the latest-observed row wins (a later correction supersedes an earlier
 * observation only once it had been observed).
 */
export function asOf(rows, { validAt, knownAt, subjectKey = r => r.subject_id }) {
  const best = new Map();
  for (const row of rows || []) {
    if (!visibleAsOf(row, { validAt, knownAt })) continue;
    const key = subjectKey(row);
    const prev = best.get(key);
    if (!prev || ms(row.observed_at) > ms(prev.observed_at)
      || (ms(row.observed_at) === ms(prev.observed_at) && ms(row.effective_from) > ms(prev.effective_from))) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

/**
 * Leakage audit for a feature row: every input it cites must have been
 * observed before the prediction cutoff. Returns the offending inputs.
 */
export function leakageViolations(inputs, cutoff) {
  const c = assertInstant('cutoff', cutoff);
  return (inputs || []).filter(input => {
    const observed = ms(input?.observed_at);
    return !Number.isFinite(observed) || observed > c;
  });
}
