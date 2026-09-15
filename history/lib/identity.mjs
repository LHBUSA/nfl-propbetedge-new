/* Football history graph — person identity policy.
 *
 * global_football_player_id is one athlete's single career identity across
 * every league, school and provider. This module is the ONLY place that decides
 * whether two source records may be the same person. It is pure (no I/O).
 *
 * Non-negotiable rules
 *   1. A name, however exact, never merges two records.
 *   2. Generational suffixes (Jr., Sr., II, III, IV, V) are identity-bearing:
 *      "Marvin Harrison" and "Marvin Harrison Jr." are different people until a
 *      shared strong identifier proves otherwise.
 *   3. A conflicting strong identifier or a conflicting date of birth blocks an
 *      automatic merge, whatever else agrees.
 *   4. Every decision carries its evidence and rule, so it can be audited and
 *      reversed. "review" means a human decides; nothing is written as merged.
 */

export const SUFFIXES = Object.freeze({ jr: 'Jr.', sr: 'Sr.', ii: 'II', iii: 'III', iv: 'IV', v: 'V' });

/* Identifier systems whose equality alone proves identity, because each id is
   assigned to exactly one person by its issuing system. Anything else (jersey
   numbers, source row keys, name slugs) is weak. */
export const STRONG_ID_SYSTEMS = Object.freeze(new Set([
  'nfl_gsis_id',        // NFL Game Statistics & Information System
  'nfl_esb_id',
  'espn_athlete_id',
  'pfr_player_id',      // identifier only; PFR data itself is not a source
  'wikidata_qid',
  'cfl_player_id',
  'ncaa_player_id',
  'cfbd_athlete_id',
]));

/* Known defects: an id system whose values are NOT globally unique on their own. */
export const NAMESPACE_COLLISIONS = Object.freeze({
  /* nflverse 2016-2022 participation keys players by NFL numeric id, and those
     numbers collide with pff_id values (docs/career-ledger rights audit). */
  nfl_numeric_id: 'collides_with_pff_id',
});

function fold(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase();
}

/** Split a display name into comparable parts. Pure; never guesses a suffix
 *  that is not written. */
export function normalizeName(display) {
  const raw = String(display ?? '').trim().replace(/\s+/g, ' ');
  let tokens = fold(raw).replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let suffix = null;
  while (tokens.length > 1 && Object.hasOwn(SUFFIXES, tokens[tokens.length - 1])) {
    suffix = SUFFIXES[tokens.pop()];
  }
  const given = tokens.length > 1 ? tokens.slice(0, -1).join(' ') : '';
  const family = tokens.length ? tokens[tokens.length - 1] : '';
  const key = tokens.join(' ').replace(/'/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return { display: raw, given, family, suffix, key };
}

function strongIds(record) {
  const out = new Map();
  for (const [system, value] of Object.entries(record?.external_ids || {})) {
    if (!STRONG_ID_SYSTEMS.has(system) || value === null || value === undefined || value === '') continue;
    out.set(system, String(value).trim());
  }
  return out;
}

function validDob(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * Decide whether two source person records may be linked.
 * @returns {{decision:'merge'|'review'|'distinct', rule:string, evidence:object}}
 */
export function matchDecision(a, b) {
  const na = normalizeName(a?.name), nb = normalizeName(b?.name);
  const ia = strongIds(a), ib = strongIds(b);
  const shared = [], conflicts = [];
  for (const [system, value] of ia) {
    if (!ib.has(system)) continue;
    (ib.get(system) === value ? shared : conflicts).push(system);
  }
  const dobA = validDob(a?.dob), dobB = validDob(b?.dob);
  const evidence = {
    name_a: na.key, name_b: nb.key, suffix_a: na.suffix, suffix_b: nb.suffix,
    shared_strong_ids: shared, conflicting_strong_ids: conflicts,
    dob_a: dobA, dob_b: dobB,
  };

  if (conflicts.length) return { decision: 'distinct', rule: 'conflicting_strong_id', evidence };
  if (dobA && dobB && dobA !== dobB) {
    return shared.length
      ? { decision: 'review', rule: 'shared_id_but_dob_conflict', evidence }
      : { decision: 'distinct', rule: 'dob_conflict', evidence };
  }
  if (shared.length) {
    /* A strong id links the records even across a name change (e.g., a player
       who adds a suffix or changes surname); a suffix disagreement is logged. */
    return { decision: 'merge', rule: na.suffix !== nb.suffix ? 'shared_strong_id_suffix_differs' : 'shared_strong_id', evidence };
  }
  if (na.suffix !== nb.suffix) return { decision: 'distinct', rule: 'generational_suffix_differs', evidence };
  if (na.key !== nb.key) return { decision: 'distinct', rule: 'name_differs_no_shared_id', evidence };

  /* Same normalized name, no shared strong id. Corroboration can raise a pair
     to human review; it can never produce an automatic merge. */
  const corroborations = [];
  if (dobA && dobB && dobA === dobB) corroborations.push('dob');
  if (a?.college_team_id && a.college_team_id === b?.college_team_id) corroborations.push('college_team');
  if (a?.draft_selection_id && a.draft_selection_id === b?.draft_selection_id) corroborations.push('draft_selection');
  evidence.corroborations = corroborations;
  return corroborations.length >= 2
    ? { decision: 'review', rule: 'same_name_corroborated', evidence }
    : { decision: 'distinct', rule: 'name_only_never_merges', evidence };
}
