/* Football history API — request handling, independent of storage.
 *
 * createHistoryApi({ query }) takes any async SQL function (PGlite in the
 * technical-validation slice; Hyperdrive/Supabase in a future Worker) and
 * returns a fetch handler. Nothing here is deployed yet.
 *
 * Two rules are enforced for every response:
 *   1. RIGHTS. A row is returned only if every source behind it permits the
 *      requested surface (public | pro | internal). The filter is a SQL join on
 *      football_src.source.display_policy, not a display-time decision.
 *   2. PROVENANCE. Each response carries the sources and snapshots it came
 *      from, whether it is derived, and the as-of pair it was resolved at.
 */

/* The surface travels as a NAME, not as a list of display policies, because a
   source no longer has one policy. CollegeFootballData serves games, ESPN-shaped
   play-by-play and relayed third-party ratings through one contract, and which
   of those a row belongs to is the lane. Resolving the question in SQL
   (football_rights.surface_allows) means this join filter and the row-level
   policy in the database are the same rule, rather than two rules that have to
   be kept in step by hand. */
const SURFACE_NAMES = new Set(['public', 'pro', 'internal']);
const surfaceName = s => (SURFACE_NAMES.has(s) ? s : 'public');

export function createHistoryApi({ query, now = () => new Date().toISOString() }) {
  const q = async (sql, params = []) => (await query(sql, params)).rows;

  /* Every row-returning query goes through this: it joins the snapshot and the
     source, keeps only rows whose source AND lane are allowed on this surface,
     and collects the provenance actually used. */
  async function fetchWithRights(sql, params, surface) {
    const rows = await q(sql, [...params, surfaceName(surface)]);
    const sources = new Map();
    for (const row of rows) {
      if (row.__source_id) sources.set(row.__source_id, { source_id: row.__source_id, snapshot_id: row.__snapshot_id, licence_class: row.__licence_class });
      delete row.__source_id; delete row.__snapshot_id; delete row.__licence_class;
    }
    return { rows, sources: [...sources.values()] };
  }

  const envelope = (data, { sources = [], derived = false, derivation_id = null, valid_at = null, known_at = null, surface, withheld = 0 }) => ({
    data,
    provenance: { sources, derived, derivation_id, as_of: { valid_at, known_at } },
    rights: { surface, rows_withheld_by_rights: withheld },
  });

  const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

  const PROV = `s.source_id as "__source_id", s.source_snapshot_id as "__snapshot_id", src.licence_class as "__licence_class"`;
  const JOIN = t => `join football_src.source_snapshot s on s.source_snapshot_id = ${t}.source_snapshot_id
                     join football_src.source src using (source_id)`;
  const GATE = `football_rights.surface_allows($__N__, s.source_id, s.lane)`;

  const routes = [
    // GET /v1/history/sources
    { pattern: /^\/v1\/history\/sources$/, handler: async (_m, url, surface) => {
      const rows = await q(`select source_id, name, licence_class, commercial_verdict, display_policy, model_use_allowed, obligations, terms_url
         from football_src.source order by source_id`);
      return envelope(rows, { surface, sources: [] });
    } },

    // GET /v1/history/franchises/:id/lineage
    { pattern: /^\/v1\/history\/franchises\/([^/]+)\/lineage$/, handler: async (m, url, surface) => {
      const { rows, sources } = await fetchWithRights(
        `select t.global_football_team_identity_id as team_identity_id, t.full_name, t.abbreviation,
                t.effective_from::text as effective_from, t.effective_to::text as effective_to, ${PROV}
         from football.team_identity_franchise f
         join football.team_identity t using (global_football_team_identity_id)
         ${JOIN('t')}
         where f.global_football_franchise_id = $1 and ${GATE.replace('$__N__', '$2')}
         order by t.effective_from`, [m[1]], surface);
      return envelope({ franchise_id: m[1], identities: rows }, { surface, sources });
    } },

    // GET /v1/history/seasons/:league/:year/standings   (derived from canonical results)
    { pattern: /^\/v1\/history\/seasons\/([^/]+)\/(\d{4})\/standings$/, handler: async (m, url, surface) => {
      const { rows, sources } = await fetchWithRights(
        `select ti.full_name as team, ti.abbreviation,
                count(*) filter (where gts.result='win')::int wins,
                count(*) filter (where gts.result='loss')::int losses,
                count(*) filter (where gts.result='tie')::int ties,
                sum(gts.final_score)::int points_for, ${PROV}
         from football.game_team_score gts
         join football.game g using (global_football_game_id)
         join football.competition c using (competition_id)
         join football.season se on se.season_id = g.season_id
         join football.league l on l.league_id = se.league_id
         join football.team_identity ti on ti.global_football_team_identity_id = gts.global_football_team_identity_id
         ${JOIN('gts')}
         where lower(l.short_name) = lower($1) and se.season_year = $2 and c.kind = 'regular_season'
           and ${GATE.replace('$__N__', '$3')}
         group by ti.full_name, ti.abbreviation, s.source_id, s.source_snapshot_id, src.licence_class
         order by wins desc, points_for desc`, [m[1], Number(m[2])], surface);
      return envelope(rows, { surface, sources, derived: true, derivation_id: 'standings_from_game_results' });
    } },

    // GET /v1/history/games?season=&week=&team=
    { pattern: /^\/v1\/history\/games$/, handler: async (_m, url, surface) => {
      const season = Number(url.searchParams.get('season') || 0);
      const team = url.searchParams.get('team_identity');
      const { rows, sources } = await fetchWithRights(
        `select g.global_football_game_id as game_id, g.game_date::text, g.week_label, g.status,
                home.full_name as home, away.full_name as away,
                hs.final_score as home_score, aws.final_score as away_score,
                g.venue_name_as_played as venue, g.neutral_site, ${PROV}
         from football.game g
         join football.season se on se.season_id = g.season_id
         join football.team_identity home on home.global_football_team_identity_id = g.home_team_identity_id
         join football.team_identity away on away.global_football_team_identity_id = g.away_team_identity_id
         left join football.game_team_score hs on hs.global_football_game_id = g.global_football_game_id and hs.global_football_team_identity_id = g.home_team_identity_id
         left join football.game_team_score aws on aws.global_football_game_id = g.global_football_game_id and aws.global_football_team_identity_id = g.away_team_identity_id
         ${JOIN('g')}
         where ($1 = 0 or se.season_year = $1)
           and ($2::text is null or $2 in (g.home_team_identity_id, g.away_team_identity_id))
           and ${GATE.replace('$__N__', '$3')}
         order by g.game_date, g.global_football_game_id limit 400`, [season, team], surface);
      return envelope(rows, { surface, sources });
    } },

    // GET /v1/history/games/:id  (package: score, drives, weather)
    { pattern: /^\/v1\/history\/games\/([^/]+)$/, handler: async (m, url, surface) => {
      const { rows, sources } = await fetchWithRights(
        `select g.global_football_game_id as game_id, g.game_date::text, g.week_label, g.status, g.overtime_periods,
                g.venue_name_as_played as venue, g.neutral_site, g.kickoff_precision, g.overtime_rule_key, ${PROV}
         from football.game g ${JOIN('g')}
         where g.global_football_game_id = $1 and ${GATE.replace('$__N__', '$2')}`, [m[1]], surface);
      if (!rows.length) return null;
      const scores = await q(`select ti.full_name as team, gts.final_score, gts.period_scores, gts.result
         from football.game_team_score gts join football.team_identity ti on ti.global_football_team_identity_id = gts.global_football_team_identity_id
         where gts.global_football_game_id = $1 order by gts.result`, [m[1]]);
      const drives = await q(`select sequence, result, result_source_label, plays, first_downs, start_yardline_100
         from football.drive where global_football_game_id = $1 order by sequence`, [m[1]]);
      return envelope({ ...rows[0], scores, drives }, { surface, sources });
    } },

    // GET /v1/history/games/:id/plays
    { pattern: /^\/v1\/history\/games\/([^/]+)\/plays$/, handler: async (m, url, surface) => {
      const { rows, sources } = await fetchWithRights(
        `select p.sequence, p.period, p.down, p.distance, p.yardline_100, p.play_type, p.description,
                p.yards_gained, p.touchdown, p.turnover, p.field_confidence, ${PROV}
         from football.play p ${JOIN('p')}
         where p.global_football_game_id = $1 and ${GATE.replace('$__N__', '$2')}
         order by p.sequence limit 400`, [m[1]], surface);
      return envelope(rows, { surface, sources });
    } },

    // GET /v1/history/players/:id  (passport core)
    { pattern: /^\/v1\/history\/players\/([^/]+)$/, handler: async (m, url, surface) => {
      const { rows, sources } = await fetchWithRights(
        `select pl.global_football_player_id as player_id, n.display_name, n.generational_suffix, ${PROV}
         from football.player pl
         join football.person_name n on n.global_football_person_id = pl.global_football_person_id and n.name_kind='canonical'
         join football_src.source_snapshot s on s.source_snapshot_id = n.source_snapshot_id
         join football_src.source src using (source_id)
         where pl.global_football_player_id = $1 and ${GATE.replace('$__N__', '$2')}`, [m[1]], surface);
      if (!rows.length) return null;
      const ids = await q(`select id_system, id_value, confidence from football_src.external_id
         where entity_type='player' and entity_id = $1 order by id_system`, [m[1]]);
      const positions = await q(`select distinct source_label, canonical_code, ambiguous, context from football.player_position_observation
         where global_football_player_id = $1`, [m[1]]);
      return envelope({ ...rows[0], external_ids: ids, positions }, { surface, sources });
    } },

    // GET /v1/history/players/:id/gamelog?season=
    { pattern: /^\/v1\/history\/players\/([^/]+)\/gamelog$/, handler: async (m, url, surface) => {
      const season = Number(url.searchParams.get('season') || 0);
      const { rows, sources } = await fetchWithRights(
        `select g.game_date::text, g.week_label, ti.abbreviation as team, opp.abbreviation as opponent,
                jsonb_object_agg(st.stat_key, st.value) as stats, ${PROV}
         from football.player_game_stat st
         join football.game g using (global_football_game_id)
         join football.season se on se.season_id = g.season_id
         join football.team_identity ti on ti.global_football_team_identity_id = st.global_football_team_identity_id
         join football.team_identity opp on opp.global_football_team_identity_id =
              case when g.home_team_identity_id = st.global_football_team_identity_id then g.away_team_identity_id else g.home_team_identity_id end
         ${JOIN('st')}
         where st.global_football_player_id = $1 and ($2 = 0 or se.season_year = $2) and ${GATE.replace('$__N__', '$3')}
         group by g.game_date, g.week_label, ti.abbreviation, opp.abbreviation, s.source_id, s.source_snapshot_id, src.licence_class
         order by g.game_date`, [m[1], season], surface);
      return envelope(rows, { surface, sources });
    } },

    // GET /v1/history/rosters/:team_identity?valid_at=&known_at=
    { pattern: /^\/v1\/history\/rosters\/([^/]+)$/, handler: async (m, url, surface) => {
      const validAt = url.searchParams.get('valid_at') || now().slice(0, 10);
      const knownAt = url.searchParams.get('known_at') || now();
      const { rows, sources } = await fetchWithRights(
        `select n.display_name, r.status, r.effective_from::text as effective_from, r.effective_to::text as effective_to, ${PROV}
         from football.roster_status_period r
         join football.player pl using (global_football_player_id)
         join football.person_name n on n.global_football_person_id = pl.global_football_person_id and n.name_kind='canonical'
         ${JOIN('r')}
         where r.global_football_team_identity_id = $1
           and r.effective_from <= $2::date and (r.effective_to is null or $2::date < r.effective_to)
           and r.observed_at <= $3::timestamptz
           and ${GATE.replace('$__N__', '$4')}
         order by n.display_name`, [m[1], validAt, knownAt], surface);
      return envelope(rows, { surface, sources, valid_at: validAt, known_at: knownAt });
    } },

    // GET /v1/history/leaderboards?stat=&season=  (derived)
    { pattern: /^\/v1\/history\/leaderboards$/, handler: async (_m, url, surface) => {
      const stat = url.searchParams.get('stat') || 'passing_yards';
      const season = Number(url.searchParams.get('season') || 0);
      if (!/^[a-z_]+$/.test(stat)) return json({ error: 'invalid_stat' }, 400);
      const { rows, sources } = await fetchWithRights(
        `select n.display_name, sum(st.value)::int as value, ${PROV}
         from football.player_game_stat st
         join football.game g using (global_football_game_id)
         join football.competition c using (competition_id)
         join football.season se on se.season_id = g.season_id
         join football.player pl on pl.global_football_player_id = st.global_football_player_id
         join football.person_name n on n.global_football_person_id = pl.global_football_person_id and n.name_kind='canonical'
         ${JOIN('st')}
         where st.stat_key = $1 and ($2 = 0 or se.season_year = $2) and c.counts_toward_records = 'regular'
           and ${GATE.replace('$__N__', '$3')}
         group by n.display_name, s.source_id, s.source_snapshot_id, src.licence_class
         order by value desc limit 10`, [stat, season], surface);
      return envelope(rows, { surface, sources, derived: true, derivation_id: `leaderboard:${stat}` });
    } },
  ];

  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const surface = url.searchParams.get('surface') || 'public';
    if (!SURFACE_NAMES.has(surface)) return json({ error: 'unknown_surface' }, 400);
    for (const route of routes) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        const body = await route.handler(m, url, surface);
        if (body === null) return json({ error: 'not_found_or_not_permitted_on_this_surface', rights: { surface } }, 404);
        return body instanceof Response ? body : json(body);
      } catch (error) {
        return json({ error: 'query_failed', detail: String(error.message || error) }, 500);
      }
    }
    return json({ error: 'not_found' }, 404);
  };
}
