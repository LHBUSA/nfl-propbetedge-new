/**
 * What must be true of a deployed history database.
 *
 * These are plain SQL assertions so the same list can run three ways: against
 * PGlite in the test suite (proving the deployment package before it meets a
 * real server), against the history project after a migration, and as the
 * repeating canary. A check that can only run in one of those places would be
 * a check nobody runs.
 *
 * Severity: 'blocker' fails a deployment. 'warn' is reported and does not.
 * canary: true means it is cheap and safe to run against a live database.
 */

export const CHECKS = [
  {
    name: 'schema.present', severity: 'blocker', canary: true,
    describe: 'the three history schemas exist and nothing else was created alongside them',
    sql: `select count(*)::int n from information_schema.schemata
           where schema_name in ('football','football_src','football_derived','football_rights','football_deploy')`,
    expect: r => ({ pass: r.n === 5, detail: `${r.n}/5 schemas` }),
  },
  {
    name: 'schema.isolated', severity: 'blocker', canary: true,
    describe: 'the history database holds no live product tables',
    sql: `select count(*)::int n from information_schema.tables
           where table_schema = 'public' and (table_name like 'nfl\\_%' or table_name like 'ufc\\_%' or table_name like 'mlb\\_%')`,
    expect: r => ({ pass: r.n === 0, detail: `${r.n} product tables found in public` }),
  },
  {
    name: 'migrations.recorded', severity: 'blocker',
    describe: 'every migration that ran is recorded with the checksum of what ran',
    sql: `select count(*)::int n, count(*) filter (where sha256 is null or length(sha256) <> 64)::int bad
            from football_deploy.migration`,
    expect: r => ({ pass: r.n > 0 && r.bad === 0, detail: `${r.n} migrations recorded, ${r.bad} without a usable checksum` }),
  },
  {
    name: 'rights.rls_on_every_table', severity: 'blocker', canary: true,
    describe: 'no history table is readable without a rights policy',
    sql: `select count(*)::int total,
                 count(*) filter (where not c.relrowsecurity)::int without_rls,
                 count(*) filter (where not exists (select 1 from pg_policies p
                     where p.schemaname = n.nspname and p.tablename = c.relname))::int without_policy
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'r' and n.nspname in ('football','football_src','football_derived')`,
    expect: r => ({ pass: r.without_rls === 0 && r.without_policy === 0,
      detail: `${r.total} tables, ${r.without_rls} without row-level security, ${r.without_policy} without a policy` }),
  },
  {
    name: 'rights.surface_function', severity: 'blocker', canary: true,
    describe: 'the public surface is the default and it admits only public sources',
    sql: `select array_to_string(football_rights.allowed_policies(null), ',') as dflt,
                 array_to_string(football_rights.allowed_policies('public'), ',') as pub,
                 array_to_string(football_rights.allowed_policies('pro'), ',') as pro,
                 array_to_string(football_rights.allowed_policies('internal'), ',') as internal,
                 array_to_string(football_rights.allowed_policies('nonsense'), ',') as unknown_surface`,
    expect: r => ({
      pass: r.dflt === 'public' && r.pub === 'public' && r.pro === 'public,pro'
        && r.internal === 'public,pro,internal_only,measurement_only' && r.unknown_surface === 'public',
      detail: `default=${r.dflt}; pro=${r.pro}; internal=${r.internal}; unrecognised surface falls back to ${r.unknown_surface}`,
    }),
  },
  {
    name: 'rights.registry_complete', severity: 'blocker', canary: true,
    describe: 'every source carries a licence class and a display policy',
    sql: `select count(*)::int n,
                 count(*) filter (where display_policy is null or licence_class is null or commercial_verdict is null)::int undecided
            from football_src.source`,
    expect: r => ({ pass: r.n > 0 && r.undecided === 0, detail: `${r.n} sources, ${r.undecided} without a rights decision` }),
  },
  {
    name: 'rights.lane_policy_present', severity: 'blocker', canary: true,
    describe: 'a source that requires lanes has them, and no snapshot claims a lane we never decided',
    sql: `select
            (select count(*)::int from football_src.source src
              where src.lane_policy_required
                and not exists (select 1 from football_src.source_lane_policy lp where lp.source_id = src.source_id)
            ) as requiring_without_lanes,
            (select count(*)::int from football_src.source_snapshot s
              where s.lane is not null
                and not exists (select 1 from football_src.source_lane_policy lp
                                 where lp.source_id = s.source_id and lp.lane = s.lane)
            ) as snapshots_with_undecided_lane,
            (select count(*)::int from football_src.source_snapshot s
              join football_src.source src on src.source_id = s.source_id
             where src.lane_policy_required and s.lane is null) as snapshots_missing_required_lane,
            (select count(*)::int from football_src.source_lane_policy) as lanes`,
    expect: r => ({
      pass: r.requiring_without_lanes === 0 && r.snapshots_with_undecided_lane === 0
        && r.snapshots_missing_required_lane === 0 && r.lanes > 0,
      detail: `${r.lanes} lane policies; ${r.requiring_without_lanes} sources requiring lanes without any, `
        + `${r.snapshots_with_undecided_lane} snapshots naming an undecided lane, `
        + `${r.snapshots_missing_required_lane} snapshots missing a required lane`,
    }),
  },
  {
    name: 'rights.refused_lanes_cannot_be_ingested', severity: 'blocker', canary: true,
    describe: 'no lane we refused is marked ingestible, and none has been ingested',
    sql: `select
            (select count(*)::int from football_src.source_lane_policy
              where commercial_verdict in ('do_not_use','rejected') and ingest_allowed) as refused_but_ingestible,
            (select count(*)::int from football_src.source_lane_policy
              where commercial_verdict in ('do_not_use','rejected')
                and (public_allowed or pro_allowed or internal_allowed or model_use_allowed)) as refused_but_permitted,
            (select count(*)::int from football_src.source_snapshot s
              join football_src.source_lane_policy lp
                on lp.source_id = s.source_id and lp.lane = s.lane
             where not lp.ingest_allowed) as snapshots_on_refused_lanes`,
    expect: r => ({
      pass: r.refused_but_ingestible === 0 && r.refused_but_permitted === 0 && r.snapshots_on_refused_lanes === 0,
      detail: `${r.refused_but_ingestible} refused lanes marked ingestible, ${r.refused_but_permitted} refused lanes `
        + `granting a surface or model use, ${r.snapshots_on_refused_lanes} snapshots stored on a refused lane`,
    }),
  },
  {
    name: 'rights.cfbd_not_ingested', severity: 'blocker', canary: true,
    describe: 'CollegeFootballData ingestion is still disabled and nothing has been stored from it',
    sql: `select
            (select coalesce(bool_and(lane_policy_required), false) from football_src.source
              where source_id = 'src_cfbd') as requires_lanes,
            (select count(*)::int from football_src.source_snapshot where source_id = 'src_cfbd') as snapshots`,
    expect: r => ({
      pass: r.requires_lanes === true && r.snapshots === 0,
      detail: r.requires_lanes
        ? `src_cfbd requires a lane per snapshot; ${r.snapshots} CFBD snapshots stored`
        : 'src_cfbd is NOT marked lane_policy_required — its source row would act as a single blanket permission',
    }),
  },
  {
    name: 'provenance.every_row_cited', severity: 'blocker', canary: true,
    describe: 'no canonical row exists without the snapshot it came from',
    sql: `select coalesce(sum(missing), 0)::int missing, count(*)::int tables_checked from (
            select (xpath('/row/c/text()', query_to_xml(
              format('select count(*) c from %I.%I where source_snapshot_id is null', table_schema, table_name),
              false, true, '')))[1]::text::int as missing
              from information_schema.columns
             where table_schema in ('football','football_src') and column_name = 'source_snapshot_id') t`,
    expect: r => ({ pass: r.missing === 0, detail: `${r.tables_checked} tables carry provenance, ${r.missing} rows without a snapshot` }),
  },
  {
    name: 'provenance.snapshot_has_source', severity: 'blocker', canary: true,
    describe: 'every snapshot resolves to a registered source',
    sql: `select count(*)::int orphans from football_src.source_snapshot s
           where not exists (select 1 from football_src.source src where src.source_id = s.source_id)`,
    expect: r => ({ pass: r.orphans === 0, detail: `${r.orphans} snapshots with no source` }),
  },
  {
    name: 'skeleton.eras', severity: 'blocker',
    describe: 'the three leagues and the full season span are present',
    sql: `select (select count(*) from football.league)::int leagues,
                 (select min(season_year) from football.season)::int lo,
                 (select max(season_year) from football.season)::int hi,
                 (select count(*) from football.franchise)::int franchises`,
    expect: r => ({ pass: r.leagues >= 3 && r.lo <= 1920 && r.hi >= 2026 && r.franchises >= 40,
      detail: `${r.leagues} leagues, seasons ${r.lo}-${r.hi}, ${r.franchises} franchises` }),
  },
  {
    name: 'skeleton.unknown_is_explicit', severity: 'blocker', canary: true,
    describe: 'an unknown bound is null and says so, never a filled-in guess',
    sql: `select count(*) filter (where effective_from is null and from_basis <> 'unknown')::int mislabelled_from,
                 count(*) filter (where effective_to is null and to_basis not in ('unknown','still_in_force'))::int mislabelled_to,
                 count(*) filter (where from_precision = 'unknown' and effective_from is not null)::int date_without_precision
            from football.team_identity`,
    expect: r => ({ pass: r.mislabelled_from === 0 && r.mislabelled_to === 0 && r.date_without_precision === 0,
      detail: `${r.mislabelled_from} starts and ${r.mislabelled_to} ends mislabelled, ${r.date_without_precision} dates without a stated precision` }),
  },
  {
    name: 'skeleton.no_game_without_participants', severity: 'blocker', canary: true,
    describe: 'a championship whose participants are unknown is a result, not a game',
    sql: `select count(*)::int n from football.championship_result where global_football_game_id is not null`,
    expect: r => ({ pass: r.n === 0, detail: `${r.n} championship rows claim a game record` }),
  },
  {
    name: 'temporal.no_future_knowledge', severity: 'blocker',
    describe: 'nothing is recorded as observed before the source that carries it was retrieved',
    sql: `select count(*)::int n from football_src.entity_source_record esr
            join football_src.source_snapshot s using (source_snapshot_id)
           where esr.observed_at < s.retrieved_at - interval '1 day'`,
    expect: r => ({ pass: r.n === 0, detail: `${r.n} records claim knowledge older than their snapshot` }),
  },
];

/** The subset safe to run repeatedly against a live database. */
export const CANARIES = CHECKS.filter(c => c.canary);

/**
 * Run checks with any async query function returning { rows }.
 * Returns { results, failed } and never throws for a failing check.
 */
export async function runChecks(query, checks = CHECKS) {
  const results = [];
  for (const check of checks) {
    try {
      const { rows } = await query(check.sql);
      const outcome = check.expect(rows[0] || {});
      results.push({ ...outcome, name: check.name, severity: check.severity, describe: check.describe });
    } catch (error) {
      results.push({ pass: false, name: check.name, severity: check.severity, describe: check.describe,
        detail: `check could not run: ${error.message.split('\n')[0]}` });
    }
  }
  return { results, failed: results.filter(r => !r.pass && r.severity === 'blocker') };
}

export function report(results) {
  for (const r of results) {
    const state = r.pass ? 'PASS' : (r.severity === 'blocker' ? 'FAIL' : 'WARN');
    console.log(`${state}  ${r.name.padEnd(36)} ${r.describe} — ${r.detail}`);
  }
}
