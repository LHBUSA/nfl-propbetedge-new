# College data rights — CollegeFootballData.com and the alternatives (D3)

Audited 2026-09-18 from primary documents. **Not legal advice.** Nothing was
ingested, no account was created, no vendor was contacted, no key was requested.
Quotes are ≤25 words from the document named; anything that could not be read in
a primary document is marked **UNVERIFIED**.

**Verdict in one line: CFBD's contract is generous and is not the problem. Its
upstream is — Rad Sports Analytics LLC documents the origin of three datasets,
documents a redistribution licence for none, and §8 assigns that risk to us.**

> **Status (2026-09-18): this audit is no longer only a document.** Its matrix is
> encoded as executable policy in `history/registry/lanes.v2.json` and enforced by
> `football_src.source_lane_policy`, the row-level security policies, and the
> ingestion boundary in `history/lib/cfbd-policy.mjs`. The refused datasets are
> refused at ingestion, not hidden at display. See `RIGHTS_ENGINE.md`.
> **CFBD ingestion remains disabled: no key, no request, no data.**

## 1. The contract layer — https://collegefootballdata.com/terms (effective 2026-08-12)

| Question | Answer |
|---|---|
| Commercial use | **Granted at every tier.** "Commercial use is permitted. Your subscription tier determines your API usage quota, not whether you may use the API commercially." |
| Caching / retention | **Granted, and survives termination.** "retain API Data retrieved while your access was active in a private historical corpus after API access or a subscription ends" |
| Display | "display reasonable portions of factual API Data as part of a larger product" — *reasonable* is undefined |
| Models | **Granted explicitly**, including "model weights", and they may be commercialised |
| Redistribution | **Prohibited**: "sell, sublicense, publish, or provide API Data as a standalone dataset or bulk download"; also no "raw feed, public database mirror, proxy, substitute API" |
| Attribution | **Not required** ("appreciated but not required") |
| Warranty | None. "No particular field, endpoint, correction schedule, availability level, stable identifier … is guaranteed." |
| Indemnity / liability cap / governing law | **All three absent from the document** |
| Upstream rights | §8: "You are responsible for obtaining any rights your Application requires." |

Two operational consequences for us:
- **Normalising into our schema does not launder it.** "API Data" includes
  "stored or normalized copies that retain substantially the same informational
  content".
- **CFBD's own Elo/PPA/SP+ values are API Data, not our Derived Outputs.** A page
  showing one is display; a table of them is redistribution.
- A PropBetEdge endpoint proxying CFBD would be a "substitute API" — prohibited.
  Our gateway pattern must terminate CFBD data into rendered or derived output.

**§7 trap:** the Gumroad data packs carry their own licences that override the
API terms, and the Personal tier is "personal, non-commercial use". The Starter
Pack also says **"Any proprietary data is excluded."** — CFBD's own admission
that part of what the API serves is proprietary and cannot be shipped as files.

## 2. The upstream layer — documented for three datasets, licensed for none

CFBD's About page discloses no sources at all, and part of the corpus is
crowd-sourced ("Have data to contribute or correct? … CSV format is preferred").
What CFBD *does* state:

| Dataset | CFBD's own words |
|---|---|
| Talent ratings | "Returns 247Sports Team Talent Composite ratings for a season." |
| FPI | "FPI is third-party data"; its client library calls it "ESPN's Football Power Index" |
| SP+ | attributed on CFBD's own page to Bill Connelly (ESPN) |
| Elo, SRS, PPA, WEPA, CORE, win probability | "proprietary CFBD models" |

The play/drive/box lane is ESPN-shaped on strong code evidence: CFBD's own
public API server reads `gamepackageJSON.drives.previous` with `xhr=1` and
`render=false` (the ESPN gamepackage contract), and its v2 types declare
ESPN-only fields (`onWatchESPN`, `dataSourceIdentifier`, `sportscenter`).
**Origin inference: high confidence. Licence: no document exists.**

Every readable upstream terms document except Sports Reference prohibits
commercial redistribution — ESPN/Disney ("use the Disney Products for any
commercial or business-related use"), 247Sports/Paramount ("personal,
non-commercial purposes"; robots.txt disallows `*.json`), On3/Rivals
("personal, non-commercial"), NCAA. Sports Reference permits commercial reuse
with credit but bars substitute databases **and** AI/ML training — and states
the pattern out loud: "Most of our data comes from third parties who sell the
data to us." / "we can not provide the data available as a download on our site."

## 3. GO / RESTRICTED / NO-GO by dataset

Surfaces: *public* = unauthenticated pages, *pro* = behind login, *internal* =
never leaves our infrastructure, *none* = do not ingest.

| Dataset | Verdict | Surfaces | Model use | Why |
|---|---|---|---|---|
| Games / results, schedules | **GO** | public / pro / internal | yes | thin facts; 1869+ predates any known feed; never label "official" |
| Coaches | **GO** | public / pro / internal | yes | names and tenures are thin facts |
| Venues | **GO** | public / pro / internal | yes | CFBD geo-enrichment; never reuse logo fields (§8) |
| CFBD's own models (Elo, SRS, PPA, WEPA, CORE, WP) | **GO** | public sparingly / pro / internal | yes | CFBD states these are its own; display portions, never tabulate |
| Team season/game stats | **RESTRICTED** (GO at aggregate) | public aggregates / pro / internal | yes | ESPN-shaped underneath |
| Drives, plays, box scores, player stats, usage | **RESTRICTED** | internal, derived-only on pro | **yes — the safest use** | strongest ESPN evidence; publish model outputs, never rows |
| Rosters | **RESTRICTED** | pro / internal | yes | §8 covers names and likenesses — text only, no photos |
| Draft picks | **RESTRICTED** | pro / internal | yes | results are widely republished facts |
| `preDraftGrade` / `preDraftRanking` / `preDraftPositionRanking` | **NO-GO** | none | no | editorial scouting opinion, near-certainly ESPN's board |
| Recruiting ratings/rankings | **NO-GO** | none | no | 247 Composite shape; 247 bars commercial use and calls it proprietary |
| Talent ratings | **NO-GO** | none | no | CFBD names 247Sports as the source |
| Transfer portal ratings | **NO-GO** (movement fact RESTRICTED) | internal, `from/to/date` only | ratings no | star ratings imply a 247/On3 composite; portal rows carry no athlete id |
| SP+ | **NO-GO** | none | no | third-party rating relayed by CFBD |
| FPI | **NO-GO** | none | no | CFBD itself calls it third-party ESPN data |
| Betting lines | **NO-GO** | none | no | sportsbook-branded prices; we already have a licensed odds path |
| Identifier crosswalks (`collegeAthleteId` ↔ `nflAthleteId`, `recruitIds`) | **RESTRICTED — internal only, hard** | internal | yes, as join keys | ids are almost certainly ESPN's, §9 disclaims their stability, and a crosswalk table is definitionally "a standalone dataset" under §5 |

**The pattern:** what CFBD *computes* is GO; what CFBD *relays from a named third
party* is NO-GO; everything in between is RESTRICTED and belongs behind the
paywall or inside our infrastructure. **Model weights are the safest artifact**
— granted by §4, not a substantial reproduction of anyone's expression, and they
survive termination.

## 4. Alternatives

| Source | Verdict | Note |
|---|---|---|
| **Wikidata (CC0)** | **CLEAR** | the only genuinely clean source. Coverage measured: 49,088 American football players, **38,235 (78%) with a college link**, PFR↔SRCFB bridge only **2,968** players. Also CC0 NCAA identifiers: P8777 coach (9,576), P8762 team-season (5,217) |
| **EADA (US Dept of Education)** | **CLEAR** (federal public domain, inferred — no licence text on the page) | bulk institution-year football sponsorship and squad sizes; a clean spine for "which schools fielded a programme when" |
| **Wikipedia** | discovery pointer only | CC BY-SA attaches to prose; per D5 it is not a canonical source |
| **nflverse `draft_picks`** | **identifier crosswalk to verify against, not a data supply** | "Loads every draft pick since 1980 courtesy of PFR" — a downstream CC-BY label does not extinguish Sports Reference's terms |
| **NCAA (ncaa.com and ncaa.org)** | **NO-GO** | ncaa.org adds an explicit anti-harvesting clause ncaa.com lacks; stats.ncaa.org is 403-walled behind Akamai Bot Manager |
| **School athletics sites** | **NO-GO at platform level** | almost all are SIDEARM (a LEARFIELD subsidiary): "intended for your personal, noncommercial use", and §1.1 puts RSS/API feeds inside that licence. One LEARFIELD conversation would cover most of FBS |
| **Sportradar NCAAFB** | licence required; the only vendor publishing both a history floor and its data terms | "Coverage begins with the 2013 season"; **no draft, no recruiting, no depth-chart endpoints** — the college→NFL edge is not in the product. History depth is itself a contract tier ("Core History" = current + two prior years) |
| **SportsDataIO CFB** | cannot substitute | **no play-by-play for CFB at all**, current-season-only standings, rosters overwritten each season |
| **Genius Sports** | UNVERIFIED for college football | its public NCAA release concerns post-season tournaments and never mentions football |

## 5. What we can build today with zero new rights risk

A **college pipeline view on each NFL player page** — school, conference, coach
at the time, draft round/pick — from Wikidata CC0 joined to the NFL data we
already hold. No attribution required, no licence to negotiate, no new provider.

What it cannot support, stated plainly: **no college performance data at all** —
no plays, drives, box scores, snaps or efficiency. So it is the *spine* of a
development graph without the *signal*. And because Wikidata only covers notable
people, the college-side identifier exists for a small minority of players, which
is a **survivorship bias that would silently corrupt** any "who becomes a pro"
model trained on it.

## 6. Recommendation and the decision that would change it

1. **Ship the CC0 spine.** Zero new risk, real product value.
2. **If college production is wanted: subscribe to CFBD ($5-10/month) for
   internal and model use only**, with a field denylist from day one — drop
   `/talent`, `/recruiting/*`, `/ratings/sp`, `/ratings/fpi`, `/lines` and the
   three `preDraft*` fields, and strip `rating`/`stars` from portal rows.
3. **Never build a public college surface on CFBD, and never expose a crosswalk
   endpoint.** That is what turns a cheap dependency into a legal problem.
4. **Ask Rad Sports Analytics, in writing:** for each dataset family, what is the
   upstream source, and does it hold redistribution rights sufficient for a paid
   commercial product — plus a mutual indemnity? Given §8, §9 and "Any
   proprietary data is excluded", the expected answer is no. **That expected no
   is itself the decision.**
5. **No single licensed vendor sells this graph off the shelf.** Sportradar is
   the only one worth a trial, and even then the draft/recruiting join stays ours.
