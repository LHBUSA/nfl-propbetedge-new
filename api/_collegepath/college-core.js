/* College Path — composition rules, with no I/O so the tests never boot a server.
 *
 * Contract: college-path/v1. The payload is built at release time by
 * history/pipeline/build_college_product.mjs, which reads the history graph as
 * the public read-only role and composes every row through
 * history/api/college-pipeline.mjs. This module shapes what is already approved;
 * it must never widen it.
 *
 * THE STATE MACHINE IS THE POINT
 * ------------------------------
 * There are three ways a player can have no College Path, and the product must
 * not render them the same way, because only one of them is about the player:
 *
 *   RESOLVED     we hold a clean college association
 *   UNRESOLVED   we do not. This is a statement about OUR data, not about the
 *                player. The layer is built from Wikidata, which holds items
 *                for people notable enough to have one, so absence carries
 *                survivorship bias and is not evidence of anything.
 *   AMBIGUOUS    two strong identifiers disagreed about which graph person this
 *                is. We withhold rather than pick, because an approximate match
 *                for the sake of a filled-in section is a wrong fact.
 *
 * Nothing here may render as "no college", "did not play college football", or
 * any phrasing a reader could take as a negative finding about the player.
 */

export const CONTRACT = 'college-path/v1';

export const STATES = { RESOLVED: 'RESOLVED', UNRESOLVED: 'UNRESOLVED', AMBIGUOUS: 'AMBIGUOUS' };

/** The only copy allowed for a player we have not resolved. */
export const UNRESOLVED_LABEL = 'College history not yet resolved';
export const AMBIGUOUS_LABEL = 'College history withheld: identity not confirmed';

/**
 * Field names that must never appear in a response, whatever key carries them.
 * The read contract already refuses these upstream; this is the same refusal at
 * the product edge, so a hand-edited artifact cannot ship them either.
 */
export const FORBIDDEN_SUBSTRINGS = [
  'stars', 'rating', 'ranking', 'rank', 'grade', 'composite',
  'sp_plus', 'spplus', 'fpi', 'talent', 'recruit',
  'ppa', 'epa', 'wepa', 'elo', 'srs',
  'passing', 'rushing', 'receiving', 'tackles', 'yards', 'touchdown', 'usage', 'snaps',
  'cfbd', 'espn', 'athlete_id', 'athleteid', 'crosswalk',
  'spread', 'moneyline', 'over_under',
];

/**
 * Keys that are identity or provenance rather than content, and so are exempt
 * from the substring check above.
 *
 * Two of these were found by the guard firing on the payload it was written to
 * protect, which is the right way to find them:
 *
 *   * `snapshot_id` contains "snaps", forbidden because snap counts are a
 *     rejected source. A citation is not a statistic.
 *   * `espn_id` contains "espn", forbidden because ESPN-sourced college data is
 *     refused. But the ESPN athlete id is the product's OWN canonical player id,
 *     already public on every Player DNA surface and on /api/player-career; it
 *     is how the caller asked the question. `espn_athlete_id` — the history
 *     graph's internal-only crosswalk value — stays refused, and is a different
 *     key on purpose.
 */
export const PROVENANCE_KEYS = new Set([
  'provenance', 'snapshot_id', 'sources', 'lanes', 'source_id', 'lane', 'espn_id',
]);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Throws if anything prohibited survived into a response. */
export function assertClean(payload) {
  const findings = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (!isPlainObject(node)) return;
    for (const [key, v] of Object.entries(node)) {
      const here = at ? `${at}.${key}` : key;
      if (PROVENANCE_KEYS.has(key)) continue;
      const lower = key.toLowerCase();
      const hit = FORBIDDEN_SUBSTRINGS.find(f => lower.includes(f));
      if (hit) findings.push(`${here} matches forbidden "${hit}"`);
      else walk(v, here);
    }
  };
  walk(payload, '');
  if (findings.length) {
    const error = new Error(`college path contract violation: ${findings.join('; ')}`);
    error.name = 'ContractViolation';
    error.findings = findings;
    throw error;
  }
  return true;
}

/** A year range the UI can print, at the precision the source actually gave. */
export function yearSpan(entry) {
  const from = entry.first_season ?? null;
  const to = entry.last_season ?? null;
  if (from && to && from !== to) return `${from}–${to}`;
  if (from) return String(from);
  if (to) return String(to);
  return null;
}

/**
 * What the source actually claimed. `educated_at` is Wikidata's P69: it
 * establishes attendance, not that the person played football there. Saying
 * otherwise would be an invention, so the two render differently.
 */
export function basisNote(basis) {
  switch (basis) {
    case 'member_of_sports_team': return 'Listed on the football programme';
    case 'draft_listing': return 'Listed as the college of record at the draft';
    case 'curated': return 'Curated by PropBetEdge from a cited source';
    case 'educated_at':
    default: return 'Attended — the source records enrolment, not a football roster';
  }
}

/** Order schools oldest-first where years exist, then by name. */
export function orderSchools(schools) {
  return [...schools].sort((a, b) => {
    const ay = a.first_season ?? Infinity, by = b.first_season ?? Infinity;
    if (ay !== by) return ay - by;
    return String(a.school || '').localeCompare(String(b.school || ''));
  });
}

/**
 * Build the response for one player.
 *
 * `record` is the artifact entry (or null/undefined when the player has none),
 * `ambiguous` is true when the build refused the identity.
 */
export function composeCollegePath({ espnId, record, ambiguous = false, meta = {} }) {
  const base = {
    ok: true,
    contract: CONTRACT,
    espn_id: String(espnId),
    generated_at: meta.generated_at || null,
    bias_note: meta.sampling_bias?.meaning || null,
  };

  if (ambiguous) {
    const body = {
      ...base, state: STATES.AMBIGUOUS, label: AMBIGUOUS_LABEL,
      schools: [], coaches: [], transition: null, provenance: null,
      /* Said explicitly, so no surface can read a negative out of an empty list. */
      absence_is_not_evidence: true,
    };
    assertClean(body);
    return body;
  }

  if (!record || !Array.isArray(record.schools) || (!record.schools.length && !record.transition)) {
    const body = {
      ...base, state: STATES.UNRESOLVED, label: UNRESOLVED_LABEL,
      schools: [], coaches: [], transition: null, provenance: null,
      absence_is_not_evidence: true,
    };
    assertClean(body);
    return body;
  }

  const schools = orderSchools(record.schools || []).map(s => ({
    school: s.school ?? null,
    program: s.program ?? null,
    conference: s.conference ?? null,
    first_season: s.first_season ?? null,
    last_season: s.last_season ?? null,
    years: yearSpan(s),
    date_precision: s.date_precision ?? 'unknown',
    basis: s.basis ?? null,
    basis_note: basisNote(s.basis),
    played_football: s.played_football ?? null,
  }));

  /* A tenure whose end the source never recorded must not print as a single
     year: "2021" reads as a coach who was there for one season, which is a
     claim the source did not make. The open interval is shown open, and said. */
  const coaches = (record.coaches || []).map(c => {
    const openEnded = !!c.from && !c.to;
    return {
      coach: c.coach ?? null,
      program: c.program ?? null,
      from: c.from ?? null,
      to: c.to ?? null,
      years: c.from && c.to ? `${c.from}–${c.to}` : (c.from ? `${c.from}–` : (c.to || null)),
      end_recorded: !openEnded,
      years_note: openEnded ? 'End of tenure not recorded' : null,
    };
  });

  const t = record.transition;
  const transition = t ? {
    entry_route: t.entry_route ?? null,
    entry_year: t.entry_year ?? null,
    /* Null unless a rights-clean source supplied it. Every draft-detail source
       in the registry is do_not_use, so null is the honest state, not a gap to
       fill from somewhere convenient. */
    draft_round: t.draft_round ?? null,
    draft_overall_pick: t.draft_overall_pick ?? null,
    detail_available: t.draft_round != null || t.draft_overall_pick != null,
  } : null;

  const body = {
    ...base,
    state: STATES.RESOLVED,
    label: 'College path',
    schools,
    coaches,
    transition,
    provenance: record.provenance || null,
    absence_is_not_evidence: true,
  };
  assertClean(body);
  return body;
}
