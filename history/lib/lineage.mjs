/* Football history graph — franchise lineage.
 *
 * global_football_franchise_id      the enduring organization (continuity of
 *                                   ownership/membership as the governing
 *                                   league recognizes it)
 * global_football_team_identity_id  the name + location + league a franchise
 *                                   used for a bounded period
 *
 * A game, standing, roster or draft selection references the TEAM IDENTITY in
 * force on that date, never the franchise's current city or name. Queries that
 * want "all of this franchise's history" traverse identity -> franchise.
 *
 * An identity may stand for more than one franchise (wartime merged teams), so
 * identity -> franchise is a many-to-many with its own effective dates.
 * Pure; data comes from canonical tables.
 */

const day = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`invalid_date:${v}`);
  return v;
};
const within = (date, from, to) => (from === null || from === undefined || from <= date) && (to === null || to === undefined || date < to);

export const LINEAGE_EVENT_TYPES = Object.freeze([
  'founded', 'admitted_to_league', 'relocated', 'renamed', 'merged_operations',
  'merger_dissolved', 'suspended_operations', 'resumed_operations', 'folded',
  'league_absorbed', 'conference_realigned', 'division_realigned', 'sold_no_identity_change',
]);

/** Identities in force for a franchise on a date (normally exactly one). */
export function identitiesOnDate(graph, franchiseId, date) {
  const d = day(date);
  const links = (graph.identity_franchise || []).filter(l => l.franchise_id === franchiseId && within(d, l.effective_from, l.effective_to));
  const ids = new Set(links.map(l => l.team_identity_id));
  return (graph.team_identities || []).filter(t => ids.has(t.team_identity_id) && within(d, t.effective_from, t.effective_to));
}

/** Franchises an identity represented on a date (normally one; merged wartime teams: several). */
export function franchisesForIdentity(graph, teamIdentityId, date) {
  const d = day(date);
  return (graph.identity_franchise || [])
    .filter(l => l.team_identity_id === teamIdentityId && within(d, l.effective_from, l.effective_to))
    .map(l => l.franchise_id);
}

/** Every identity a franchise has ever used, in time order: its lineage. */
export function lineage(graph, franchiseId) {
  const ids = new Set((graph.identity_franchise || []).filter(l => l.franchise_id === franchiseId).map(l => l.team_identity_id));
  return (graph.team_identities || [])
    .filter(t => ids.has(t.team_identity_id))
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
}

/**
 * Integrity checks a lineage graph must pass before it is published.
 * Returns a list of violations (empty = valid).
 */
export function validateLineage(graph) {
  const problems = [];
  const identities = new Map((graph.team_identities || []).map(t => [t.team_identity_id, t]));
  const byFranchise = new Map();
  for (const link of graph.identity_franchise || []) {
    const t = identities.get(link.team_identity_id);
    if (!t) { problems.push({ rule: 'link_to_unknown_identity', link }); continue; }
    if (!link.source_snapshot_id) problems.push({ rule: 'link_without_provenance', link });
    if (!byFranchise.has(link.franchise_id)) byFranchise.set(link.franchise_id, []);
    byFranchise.get(link.franchise_id).push({
      id: link.team_identity_id,
      from: link.effective_from ?? t.effective_from,
      to: link.effective_to ?? t.effective_to,
    });
  }
  for (const t of identities.values()) {
    if (!t.league_id) problems.push({ rule: 'identity_without_league', team_identity_id: t.team_identity_id });
    if (!t.source_snapshot_id) problems.push({ rule: 'identity_without_provenance', team_identity_id: t.team_identity_id });
    if (t.effective_to && t.effective_from && t.effective_to <= t.effective_from) problems.push({ rule: 'identity_interval_inverted', team_identity_id: t.team_identity_id });
  }
  /* A franchise uses one identity at a time: overlapping intervals are an error. */
  for (const [franchiseId, spans] of byFranchise) {
    spans.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1], cur = spans[i];
      if (!prev.to || prev.to > cur.from) problems.push({ rule: 'franchise_identity_overlap', franchise_id: franchiseId, a: prev.id, b: cur.id });
    }
  }
  return problems;
}

/** A historical record must name the identity in force on its date for that franchise. */
export function assertIdentityInForce(graph, { team_identity_id, date }) {
  const t = (graph.team_identities || []).find(x => x.team_identity_id === team_identity_id);
  if (!t) throw new Error('unknown_team_identity');
  if (!within(day(date), t.effective_from, t.effective_to)) throw new Error('identity_not_in_force_on_date');
  return true;
}
