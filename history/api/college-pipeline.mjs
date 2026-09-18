/**
 * The college-development read contract for an NFL player page.
 *
 * What this can answer: which institution and programme a player is associated
 * with, in which conference, over which years, under which coach, and how they
 * entered professional football.
 *
 * What it can never answer, and must never be made to look as though it can:
 * how good they were in college. There are no college statistics in the graph,
 * no recruiting stars, no talent composite, no SP+, no FPI and no scouting
 * grade — not because they are missing, but because the D3 audit found we hold
 * no rights to any of them. A contract that quietly omitted them would invite
 * someone to add them later; this one refuses them by name.
 *
 * Three rules are enforced here rather than trusted to callers:
 *
 *   1. FIELD ALLOWLIST. Only the keys in FIELDS reach the response. A field
 *      added upstream does not appear until it is added here on purpose.
 *   2. FORBIDDEN NAMES. A short list of things that must never appear under any
 *      key, checked after composition, so a rename cannot smuggle one through.
 *   3. MIXED SOURCES. A composed row takes the NARROWEST of its contributors.
 *      One component sourced from a lane that may not be shown here withholds
 *      the whole row — showing the rest would publish a fact that component is
 *      load-bearing for.
 */
import { compositionSurfaces, normaliseSurface, effectiveSurfaces } from '../lib/rights.mjs';

/** Every key the contract may return. Nothing else survives composition. */
export const FIELDS = [
  'player_id',
  'school',
  'school_id',
  'program',
  'program_id',
  'conference',
  'first_season',
  'last_season',
  'date_precision',
  'basis',
  'played_football',
  'head_coach',
  'entered_professional_football',
  'provenance',
];

/**
 * Names that must never appear in a public college-pipeline payload, whatever
 * key they arrive under. Checked as substrings of the key, lower-cased, because
 * the risk is a well-meaning rename (`sp_plus` -> `spRating`) rather than a
 * deliberate bypass.
 */
export const FORBIDDEN_SUBSTRINGS = [
  'stars', 'rating', 'ranking', 'rank', 'grade', 'composite',
  'sp_plus', 'spplus', 'fpi', 'talent', 'recruit',
  'ppa', 'epa', 'wepa', 'elo', 'srs',
  'passing', 'rushing', 'receiving', 'tackles', 'yards', 'touchdown', 'snaps', 'usage',
  'cfbd', 'espn', 'athlete_id', 'athleteid', 'crosswalk',
  'spread', 'moneyline', 'over_under',
];

export class ContractViolation extends Error {
  constructor(findings) {
    super(`college pipeline contract violation: ${findings.join('; ')}`);
    this.name = 'ContractViolation';
    this.findings = findings;
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Prove a composed payload carries nothing it must not. Runs after composition,
 * at any depth, and is the gate the tests assert on — the allowlist is the
 * intent, this is the proof.
 *
 * `provenance` is exempt from the substring check: it names source ids, and a
 * source id that contains 'cfbd' is exactly the disclosure we want to keep.
 */
export function assertContract(payload, { path = '', findings = [] } = {}) {
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (!isPlainObject(node)) return;
    for (const [key, v] of Object.entries(node)) {
      const here = at ? `${at}.${key}` : key;
      if (key === 'provenance') continue;
      const lower = key.toLowerCase();
      const hit = FORBIDDEN_SUBSTRINGS.find(f => lower.includes(f));
      if (hit) findings.push(`${here} matches forbidden "${hit}"`);
      else walk(v, here);
    }
  };
  walk(payload, path);
  if (findings.length) throw new ContractViolation(findings);
  return true;
}

/**
 * Compose one player's college-development record.
 *
 * `components` is a list of { part, value, source_id, lane }. Each part carries
 * its own provenance, because they come from different places: the affiliation
 * from Wikidata's CC0 college lane, the programme year from EADA, the coach
 * from the skeleton.
 *
 * Returns { data, withheld, surfaces }. `data` is null when the composition is
 * not permitted on this surface at all; `withheld` names the parts that were
 * dropped, so the caller can say "we have this but not here" rather than
 * implying it does not exist.
 */
export function composeCollegePipeline({ player_id, components = [], surface = 'public', requireAll = true }) {
  const want = normaliseSurface(surface);

  const permitted = [];
  const withheld = [];
  for (const c of components) {
    const surfaces = effectiveSurfaces(c.source_id, c.lane ?? null);
    if (surfaces.includes(want)) permitted.push(c);
    else withheld.push({ part: c.part, source_id: c.source_id, lane: c.lane ?? null, reason: 'lane not permitted on this surface' });
  }

  // The mixed-source rule. A composed record is one claim made of several
  // sources; if any contributor is barred here, the claim is barred here.
  if (requireAll && withheld.length) {
    return { data: null, withheld, surfaces: compositionSurfaces(components) };
  }
  if (permitted.length === 0) {
    return { data: null, withheld, surfaces: [] };
  }

  const data = { player_id };
  for (const c of permitted) {
    if (!FIELDS.includes(c.part)) continue;               // allowlist: silent by design
    data[c.part] = c.value;
  }
  data.provenance = permitted.map(c => ({
    part: c.part,
    source_id: c.source_id,
    lane: c.lane ?? null,
    snapshot_id: c.snapshot_id ?? null,
  }));

  assertContract(data);
  return { data, withheld, surfaces: compositionSurfaces(components) };
}

/**
 * The SQL behind the contract.
 *
 * Deliberately joins only the college spine: affiliation, programme, conference,
 * coaching tenure and the professional transition. There is no join to any
 * statistics table, so a future edit would have to add one on purpose rather
 * than widen a select.
 *
 * $1 is the player id, $2 the surface name. The gate is
 * football_rights.surface_allows, the same function the row-level policy uses.
 */
export const COLLEGE_PIPELINE_SQL = `
select
  pca.global_football_player_id                as player_id,
  sch.name                                     as school,
  sch.global_school_id                         as school_id,
  ct.global_college_team_id                    as program_id,
  ct.nickname                                  as program,
  cc.name                                      as conference,
  pca.first_season                             as first_season,
  pca.last_season                              as last_season,
  pca.date_precision                           as date_precision,
  pca.basis                                    as basis,
  pca.played_football                          as played_football,
  s.source_id                                  as "__source_id",
  s.lane                                       as "__lane",
  s.source_snapshot_id                         as "__snapshot_id"
from football.player_college_affiliation pca
join football.school sch on sch.global_school_id = pca.global_school_id
join football_src.source_snapshot s on s.source_snapshot_id = pca.source_snapshot_id
left join football.college_team ct on ct.global_college_team_id = pca.global_college_team_id
left join football.college_conference_membership ccm
       on ccm.global_college_team_id = ct.global_college_team_id
      and (pca.first_season is null or ccm.first_season is null or ccm.first_season <= pca.first_season)
      and (pca.first_season is null or ccm.last_season is null or ccm.last_season >= pca.first_season)
left join football.college_conference cc
       on cc.global_college_conference_id = ccm.global_college_conference_id
where pca.global_football_player_id = $1
  and football_rights.surface_allows($2, s.source_id, s.lane)
order by pca.first_season nulls last, sch.name
`;

export const COLLEGE_TRANSITION_SQL = `
select
  t.global_football_player_id                  as player_id,
  t.entry_route                                as entry_route,
  t.entry_year                                 as entry_year,
  t.draft_round                                as draft_round,
  t.draft_overall_pick                         as draft_overall_pick,
  s.source_id                                  as "__source_id",
  s.lane                                       as "__lane",
  s.source_snapshot_id                         as "__snapshot_id"
from football.college_to_pro_transition t
join football_src.source_snapshot s on s.source_snapshot_id = t.source_snapshot_id
where t.global_football_player_id = $1
  and football_rights.surface_allows($2, s.source_id, s.lane)
  -- A draft detail is shown only when the snapshot that supplied it may also be
  -- shown here. Round and pick are widely known facts, which is not a licence:
  -- every draft-detail source in the registry is currently do_not_use, so the
  -- honest state of these two columns is null.
  and (t.draft_detail_source_snapshot_id is null
       or football_rights.snapshot_visible(t.draft_detail_source_snapshot_id))
`;
