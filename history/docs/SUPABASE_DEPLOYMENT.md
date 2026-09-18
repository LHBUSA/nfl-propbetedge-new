# History database — deployment package

**Status: prepared, not deployed.** No Supabase project has been created, no
remote database has been written to, and no credentials for one exist in this
repository. Everything below is ready to run the moment the owner provisions a
project and supplies a connection string.

Owner decision D2: the history graph gets its **own Supabase project**. It shares
nothing with the databases that serve live product.

---

## Why a separate project

The NFL product and UFC run on Supabase project `tkmlnhmylqnttmnsnief`; MLB and
PropTech on `rlfyavnhbngwbldebrid`. The history graph is a different thing with a
different risk profile: bulk loads, long-running backfills, schema churn while
the model settles, and data whose licensing is still being established. None of
that belongs next to a table a paying customer's session reads.

The deployment commands do not merely *prefer* a separate project — they refuse
those two project refs outright (`history/deploy/target.mjs`,
`FORBIDDEN_PROJECT_REFS`), and a test asserts the refusal. There is also no
default connection string anywhere: a target must be passed explicitly, because
a default is how data ends up in the wrong database.

---

## What is in the package

| File | What it is |
| --- | --- |
| `deploy/generate.mjs` | Builds `deploy/migrations/` from `schema/*.sql` + `deploy/policy/*.sql`. `--check` fails on drift (run by the test suite). |
| `deploy/migrations/` | The ordered, checksummed migrations. Generated — never hand-edited. |
| `deploy/policy/010_roles_and_grants.sql` | Roles, grants, and the surface contract (`football_rights.*`). |
| `deploy/apply.mjs` | Applies pending migrations; records each with the checksum of what ran. Dry run by default. |
| `deploy/seed.mjs` | Loads the source registry first, then built datasets, in foreign-key order. Idempotent. Dry run by default. |
| `deploy/checks.mjs` | The validation suite, as plain SQL assertions. |
| `deploy/validate.mjs` | Runs the suite (or `--canary`) against a target. Read-only. |
| `deploy/connection.mjs` | The connection contract a Worker uses: reader role, read-only transaction, surface set per transaction. |
| `deploy/rollback.sql` | Whole-deployment undo, with the registry archived first. |
| `deploy/.env.example` | Environment template. Fill in outside the repo. |
| `tests/deploy.test.mjs` | Applies the real migrations to PGlite and proves the rights gate. 15 tests. |

---

## Rights are enforced in SQL, not in the UI

Every table in `football`, `football_src` and `football_derived` has row-level
security enabled and exactly one policy, generated from the schema so a new table
cannot be added without a rights decision being made for it — `generate.mjs`
throws if a table has neither a `source_snapshot_id` nor an entry in
`RIGHTS_EXCEPTIONS`.

The policy resolves the row's snapshot to its source and compares the source's
`display_policy` with the surface of the current connection:

```sql
create policy football_league_rights on football.league for select to pbe_history_reader
  using (football_rights.snapshot_visible(source_snapshot_id));
```

The surface is `app.surface` (`public` | `pro` | `internal`), and the default in
SQL is **public**: a caller that sets nothing, or sets something unrecognised,
sees the least. A restricted row is not fetched and hidden — it does not exist
for that connection, including to `count(*)`, `where` probes and joins.

Tables with no snapshot of their own are gated explicitly:

- `football_src.source`, `football.stat_definition` — our own registry and
  ontology, readable on every surface.
- `football.person` / `player` / `coach` — gated by whether any
  `entity_source_record` for them comes from an allowed source.
- `football.transaction_asset`, `football.depth_chart_entry` — inherit their
  parent row's rights.
- `football_src.identity_match_decision` — internal only, always.
- `football_derived.*` — **internal only**, until a derivation records the rights
  of every input that fed it. Derived output inherits the strictest input; until
  that is implemented, it is not publishable. Fail closed.

The reader role is read-only, so it also cannot widen its own surface by editing
`football_src.source`.

---

## Runbook

```bash
# 0. Build the migrations and confirm they match the schema
node history/deploy/generate.mjs
node history/deploy/generate.mjs --check

# 1. Prove the package locally (no server involved)
node --test history/tests/deploy.test.mjs

# 2. Point at the history project (never a product project)
export HISTORY_DATABASE_URL='postgresql://…'          # owner role
export HISTORY_DEPLOY_CONFIRM=i-understand-this-writes-to-the-history-database

# 3. Plan, then apply
node history/deploy/apply.mjs --url "$HISTORY_DATABASE_URL"
node history/deploy/apply.mjs --url "$HISTORY_DATABASE_URL" --execute

# 4. Build the datasets locally, then load registry → skeleton → slice
python history/pipeline/fetch_skeleton_seed.py
python history/pipeline/build_skeleton.py
python history/pipeline/build_slice_2023.py
node history/deploy/seed.mjs --url "$HISTORY_DATABASE_URL"            # dry run
node history/deploy/seed.mjs --url "$HISTORY_DATABASE_URL" --execute

# 5. Validate, then canary
node history/deploy/validate.mjs --url "$HISTORY_DATABASE_URL"
node history/deploy/validate.mjs --url "$HISTORY_DATABASE_URL" --canary
```

A migration that has already been applied and then edited is **refused**, naming
the checksum that ran and the checksum now on disk. Fix forward with a new
migration; never rewrite history in the history database.

---

## Backup and restore

Supabase provides daily backups on paid plans and point-in-time recovery as an
add-on. Neither removes the need for a dump before a structural change.

```bash
# Before any migration that drops or rewrites data
pg_dump --format=custom --no-owner --no-privileges \
        --schema=football --schema=football_src --schema=football_derived \
        --schema=football_deploy \
        "$HISTORY_DATABASE_URL" > history-$(date +%Y%m%d-%H%M).dump

# Restore into a fresh project (roles first: run migration 006 there)
pg_restore --clean --if-exists --no-owner --no-privileges \
           --dbname "$HISTORY_RESTORE_URL" history-20260918-1200.dump
```

What actually needs backing up is narrower than it looks. The skeleton and the
2023 slice are **rebuildable from source** — the pipelines are deterministic and
every row cites the snapshot it came from. What is not rebuildable is the rights
registry (`football_src.source`: owner decisions, terms quotes, verification
state) and the deployment ledger. `rollback.sql` archives both before dropping
anything.

Restore drill: restore into a scratch project, run
`node history/deploy/validate.mjs --url <restored>` and confirm the same check
count passes. A backup that has never been restored is not a backup.

---

## Rollback

| Situation | Action |
| --- | --- |
| A migration failed part-way | It ran in one psql invocation with `ON_ERROR_STOP`; fix the SQL, re-run `apply.mjs --execute`. The ledger records only what completed. |
| A migration applied but is wrong | Write a new migration that corrects it. Do not edit the applied file — `apply.mjs` refuses it. |
| A load went wrong | Re-run the loader: inserts are `on conflict do nothing`. For bad rows, delete by `source_snapshot_id` — that is what provenance is for. |
| The whole deployment is wrong | `psql -f history/deploy/rollback.sql`, which refuses to run against a database holding product tables. |
| Data loss | Restore from the dump or Supabase PITR, then `validate.mjs`. |

---

## Connection architecture (Hyperdrive-ready)

```
Cloudflare Worker (future)
  └── Hyperdrive binding  ──►  Supabase (history project)
        connection string = pbe_history_reader, read-only
        per request:  begin read only
                      select set_config('app.surface', <surface>, true)   -- SET LOCAL
                      <query>
                      commit
```

Hyperdrive pools connections at the edge and a pooled connection is reused
across requests. The surface is therefore set with `SET LOCAL` inside the
transaction (`set_config(..., true)`), never with a session-wide `SET`: a
session-wide setting would outlive the request and hand the next caller —
possibly an anonymous one — the previous caller's surface. `connection.mjs`
implements this and a test asserts the file cannot regress to a session `SET`.

The surface comes from the caller's entitlement, resolved by the existing NFL
session, and a request parameter may only **narrow** it (`surfaceFor()`).

Setup, when the owner is ready:

```bash
wrangler hyperdrive create pbe-history --connection-string "$HISTORY_READER_URL"
# then bind in the Worker's wrangler.toml:
#   [[hyperdrive]]
#   binding = "HISTORY_DB"
#   id = "<the id returned>"
```

## Worker API architecture (future)

`history/api/history-api.mjs` is already storage-independent: `createHistoryApi({ query })`
takes any async query function. Today the tests pass it PGlite; a Worker passes it
`createSurfaceQuery(pool, surface)`. The intended shape:

```
workers/nfl-history/          (does not exist yet)
  src/index.js                → createHistoryApi({ query: createSurfaceQuery(...) })
  wrangler.toml               → hyperdrive binding, no secrets in the repo
```

It is a **separate Worker** from anything serving picks, auth or live game data.
It shares no binding, no database and no Durable Object with them, so a history
incident cannot touch the product. Routes stay unpublished until the data behind
them is complete enough to publish — incomplete history is not exposed, per the
shipping rules.

---

## What is deliberately not here

- **No project creation.** No `supabase projects create`, no API call that would
  provision anything.
- **No credentials.** `.env.example` is a template with `REPLACE` placeholders.
- **No remote writes.** Every write command is a dry run unless `--execute` is
  passed *and* `HISTORY_DEPLOY_CONFIRM` is set.
- **No dependency on the NFL production database.** The history database holds
  its own copy of everything it needs; nothing in this package reads from or
  writes to a product project.
