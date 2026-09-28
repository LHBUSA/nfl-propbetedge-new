/**
 * Touchdown Target records, split by the PERSISTED publication scope — the one aggregation shared by the Vercel
 * function, the Worker contract and (mirrored, see touchdown-targets-v1.js scopeOfTarget) the record UI.
 *
 *   OFFICIAL record  publication_scope === 'official'   (nfl_prop_picks.publication_scope, frozen at issuance)
 *   TRACKING record  publication_scope === 'tracking'
 *
 * Nothing else decides the scope: not whether a target was displayed or free, not whether it graded, not its rank,
 * date, model version or the learning-gate state. A row with any other or missing scope belongs to NEITHER record.
 * The two records are never merged anywhere that claims official performance. `combined_internal` exists for
 * internal reconciliation only (official + tracking == combined) and is never rendered as a record.
 *
 * Grades: win / loss decide; void is counted separately; an OPEN target (no grade yet) is pending in its own scope.
 */

export const OFFICIAL_SCOPE = 'official';
export const TRACKING_SCOPE = 'tracking';

/** The persisted scope of a target row / shaped target, or null when it is neither official nor tracking. */
export function scopeOf(row) {
  const scope = String(row?.publication_scope ?? '').trim().toLowerCase();
  return scope === OFFICIAL_SCOPE || scope === TRACKING_SCOPE ? scope : null;
}

function resultOf(row) {
  const grade = Array.isArray(row?.grade) ? row.grade[0] : row?.grade;
  return String(grade?.result ?? '').toLowerCase() || null;
}

/**
 * @param {object[]} settled  targets from the record view (status graded / killed / superseded), shaped or raw
 * @param {object[]} open     open targets (status = open): only publication_scope + target_rank are read
 */
function tally(settled, open) {
  const wins = settled.filter(row => resultOf(row) === 'win').length;
  const losses = settled.filter(row => resultOf(row) === 'loss').length;
  return {
    wins,
    losses,
    voids: settled.filter(row => resultOf(row) === 'void').length,
    graded: wins + losses,
    hit_rate: wins + losses ? wins / (wins + losses) : null,
    pending: open.length,
  };
}

function block(settled, open) {
  const primary = row => String(row?.target_rank ?? '').toLowerCase() === 'primary';
  return { all: tally(settled, open), primary: tally(settled.filter(primary), open.filter(primary)) };
}

export function tdRecordsByScope({ settled = [], open = [] } = {}) {
  const pick = (rows, scope) => rows.filter(row => scopeOf(row) === scope);
  const known = rows => rows.filter(row => scopeOf(row) !== null);
  return {
    filter: 'publication_scope (persisted on nfl_prop_picks at issuance)',
    official: block(pick(settled, OFFICIAL_SCOPE), pick(open, OFFICIAL_SCOPE)),
    tracking: block(pick(settled, TRACKING_SCOPE), pick(open, TRACKING_SCOPE)),
    combined_internal: block(known(settled), known(open)),
    unscoped_excluded: settled.length + open.length - known(settled).length - known(open).length,
  };
}
