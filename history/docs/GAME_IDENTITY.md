# Game identity — impact graph, model and reversible crosswalk plan

Status: **design + tested library. No migration run, no id rewritten.**
Library `history/lib/game-identity.mjs`, tests `tests/nfl-game-identity.test.mjs` (9).

## 1. The defect, measured

`workers/nfl-picks-engine-shared/current-slate.mjs:37` derives the postseason week
as `ESPN postseason week + 18`. Measured against nflverse's own data
(`data/warehouse/nfl_games.parquet`, 1,960 games, 2019-2025) the real rule is
**postseason week = regular-season weeks + round**:

| Seasons | REG weeks | Wild Card | Divisional | Conference | Super Bowl |
|---|---|---|---|---|---|
| 2019, 2020 | 17 | 18 | 19 | 20 | **21** |
| 2021-2025 | 18 | 19 | 20 | 21 | **22** |

So `+18` is correct only for Wild Card/Divisional/Conference in 2021+. The Super
Bowl becomes week **23**, which does not exist in the provider's data.

Two defects beyond the brief:
1. **Pro Bowl.** ESPN numbers it postseason week 4, so `+18` emits week **22** —
   in 2021+ that is exactly the Super Bowl slot. The only thing distinguishing
   the two strings is the team codes (`AFC`/`NFC`), which is now how the library
   tells them apart. The Pro Bowl is not a league game and is refused.
2. **2019-20 ambiguity.** A legacy Wild Card id (`2019_19_…`) is byte-identical
   to a provider Divisional id for that season. **The string alone cannot decide
   which round it means.** `resolve()` reports `ambiguous: true` with both
   interpretations rather than picking silently.

## 2. Blast radius: zero stored rows

Measured 2026-09-18 across Supabase, KV, R2 and committed artefacts:

| Store | Rows / keys carrying a game id | Postseason ids today |
|---|---|---|
| `nfl_game_picks` | 212 rows, 31 games | **0** |
| `nfl_odds_snapshots` | 6,336 rows, 31 games | **0** |
| `nfl_pick_receipts` (in hashed payload) | 212 | **0** |
| `nfl_pick_anomalies` | 1 | **0** |
| PICKS_KV `closing:done:*` | 17 keys | **0** |
| R2 `nfl-replay` | 17 objects | **0** |
| `workers/nfl-schedule/schedule-2026.js` | 272 committed ids | **0** (REG only) |
| `data/warehouse/*.parquet` | 79 postseason games | already provider-native |

Everything stored is a 2026 regular-season week (01-02), and **regular-season ids
are identical under both spellings**. The first postseason issuance is ~January
2027. This is a code-and-tests change today, not a data migration — provided it
lands before then.

## 3. Why an id must never be rewritten in place

`migrations/nfl_picks_engine_v3_receipts.sql` hashes `game_id` into the receipt
payload, and `nfl_pick_receipts` is append-only:

```sql
create or replace function public.nfl_pick_receipt_no_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'nfl_pick_receipts is append-only';
end $$;
```

`publication.mjs` re-checks the row against that payload term by term
(`RECEIPT_TERMS` includes `['game_id','game_id']`). An in-place `UPDATE` of
`nfl_game_picks.game_id` would pass the database (the freeze trigger enumerates
terms and `game_id` is not among them) and then **silently drop the pick from the
Verified Track Record** as `receipt_unverified`. So the crosswalk is additive,
always.

## 4. The identity model

| Layer | What it is | Where |
|---|---|---|
| **canonical game** | `global_football_game_id` (`gga_…`), opaque, assigned once | `history/schema/004` |
| **provider id** | how a provider spells it (`nflverse:2023_22_SF_KC`, `espn:401547378`) | `football_src.external_id` with `id_system` |
| **legacy PropBetEdge id** | what we issued (`2023_23_SF_KC`) | same table, `id_system='pbe_legacy_game_id'` |
| **structured facts** | season, season type, round, week, home/away identity, neutral site | `football.game` columns |
| **aliases** | every string that has ever named this game, each with its reason | `football_src.external_id` rows |

Round is the durable concept; week is a provider's encoding of it. The library
exposes `providerGameId()`, `legacyPropBetEdgeGameId()`, `resolve()`,
`isProviderSpelling()` and `alias()`.

## 5. Reversible migration plan (not executed)

**Stage 0 — now (done).** Library + tests. No production behaviour changed.

**Stage 1 — additive crosswalk, NFL project.** A new table, no existing column
touched:

```sql
create table public.nfl_game_id_alias (
  issued_game_id   text primary key,      -- exactly as issued, never rewritten
  provider_game_id text,                  -- null when no league game exists (Pro Bowl)
  season           int  not null,
  round_key        text,                  -- wild_card | divisional | conference | super_bowl
  reason           text not null,         -- legacy_postseason_week_offset | pro_bowl_...
  ambiguous        boolean not null default false,
  created_at       timestamptz not null default now()
);
```
Reads resolve through it; writes never touch `nfl_game_picks`. Reversible by
dropping the table.

**Stage 2 — correct the producer.** `nflverseGameId` takes the measured rule and
refuses the Pro Bowl. `workers/nfl-picks-engine-shared/tests/live-engine.test.mjs:33`
pins `2026_19_SF_LA` (Wild Card 2026) — still correct under the new rule, so that
test stays green. Add Super Bowl coverage, which no test has today.

**Stage 3 — write an alias row at issuance** for any id whose spelling differs
from the provider's, so old and new both resolve forever.

**Stage 4 — backfill** only if a postseason id was ever issued in the legacy
spelling. Today: nothing to backfill.

**Rollback:** revert stage 2 and drop the table; issued ids never changed.

## 6. Blockers that outrank the id itself

A correct id does not make the postseason work. These were measured and are
**not** fixed here:

1. `api/pbe-picks.js:425` hard-filters `game_type !== 'REG'`, so a playoff card
   would render with `game: null` — and `api/pbe-picks.js:424` is a **second,
   hand-rolled copy** of the id formula that stage 2 would not touch.
2. `workers/nfl-schedule/schedule-2026.js` carries no postseason rows, so
   `/api/schedule`, `api/home-market.js` and the broadcast/venue lanes resolve
   nothing in January.
3. `workers/nfl-schedule/broadcast-core.js:172,184` rejects non-REG.
4. `workers/nfl-current/src/index.js:349` filters REG in `buildStats`.

**Owner decision:** whether to schedule the postseason readiness work (these four
plus stages 1-3) before January 2027, and whether the duplicate producer in
`api/pbe-picks.js` should be replaced by the shared library at the same time.
