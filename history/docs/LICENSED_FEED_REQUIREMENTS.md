# Licensed feed — scoped requirements brief (D4)

Purpose: define exactly what PropBetEdge would need from a commercial provider to
retire the undocumented chain of rights behind NFL history, and to judge any
vendor against one list. **No vendor has been contacted, nothing purchased, no
pricing negotiated.** Public pages only; anything not read in a primary document
is marked UNVERIFIED.

## 1. Why this exists

Every route to game-level NFL history today is either owner-rejected (Pro
Football Reference, ESPN core API), on hold (participation, player week stats),
or rests on an undocumented chain of rights (nflverse republishing an NFL-origin
feed). A licensed feed is the only path where **someone other than PropBetEdge
carries the upstream rights risk**. It would also retire the ESPN dependency
already on the risk register.

## 2. Mandatory requirements

A candidate must satisfy all of these to replace the current dependency.

| # | Requirement | Why this line exists |
|---|---|---|
| M1 | **Games, schedules and results back to at least 2000**, regular season and postseason, with final scores and period scores | the floor the brief sets; our own warehouse only reaches 1999 through nflverse |
| M2 | **Play-by-play** with down, distance, yard line, possession, play type, participants and the **verbatim play description** | the description is what lets us refuse to invent structured fields |
| M3 | **Drives**, with start/end field position, plays, yards, time and result | drive structure is not reconstructable from box scores |
| M4 | **Box scores**, team and player, with the provider's stat definitions stated | era-aware definitions are a schema requirement, not a nicety |
| M5 | **Rosters**, dated — who was on which team on which date, not just current | our biggest measured gap: the roster file we hold is season-level, so week-by-week squads cannot be reconstructed |
| M6 | **Injury / availability reports**: practice participation, game status, inactives | availability is competition data; we will not model diagnosis |
| M7 | **Depth charts**, dated, with the source's own slot labels | role history; must be stated by the source, never inferred |
| M8 | **Transactions**, dated, typed (sign/release/waiver/trade/IR/PUP/NFI/practice squad/elevation), with effective *and* announced timestamps | roster state must be reconstructable for any date, and pre-game features need announcement time |
| M9 | **Draft**: round, pick, overall, selecting team, player, college; and **pick ownership/trades** where available | PFR is rejected, so there is no other route to draft history |
| M10 | **Coaches**: head coach and coordinators with effective dates | coaching graph and continuity features |
| M11 | **Venues**, with the venue as played, neutral-site flags, roof and surface | we measured 42 neutral-site games mis-assigned in our own warehouse |
| M12 | **Stable identifiers plus crosswalks** to at least NFL GSIS and ESPN ids, with a **written stability commitment** | our entire graph keys on these; "no stable identifier guaranteed" is a disqualifier |
| M13 | **Redistribution terms in writing** covering: display on public and paid surfaces, derived analytics, model training, model weights, and durable storage | the whole point of the exercise |
| M14 | **Historical bulk delivery** (files or a backfill endpoint), not just live polling | a live-only product cannot build history |
| M15 | **Retention after termination** of data already received | otherwise the archive evaporates with the contract |

## 3. Strongly preferred

| # | Requirement |
|---|---|
| P1 | Officials per game |
| P2 | Snap counts / participation (currently rejected or on hold from every free source) |
| P3 | Attendance and kickoff timestamps **with timezone** (our current schedule source has neither reliably) |
| P4 | Pre-1999 coverage: AFL (1960-69), AAFC (1946-49), early NFL |
| P5 | Weather at kickoff, or a clean licence to pair a weather provider |
| P6 | Correction/restatement feed, so a revised stat is a new observation rather than a silent overwrite |
| P7 | A sandbox with real (not scrambled) data for evaluation |
| P8 | Mutual indemnity and a stated liability position |

## 4. Explicitly out of scope

Betting odds (already licensed separately), college football (see
`COLLEGE_DATA_RIGHTS.md`), team logos and trademarks, player photographs and
likenesses, video and audio.

## 5. Questions every vendor must answer in writing

1. Exact **first season** for each of M1-M11 — not "historical data available".
2. Is history **included**, or sold as a tier? If tiered, what does the base tier
   include? (One vendor's public terms define "Core History" as the current
   season plus two prior years.)
3. Does the licence permit **public display**, **paid display**, **derived
   analytics**, **model training** and **commercialising model weights**?
4. **Bulk backfill**: files or API? What is the rate limit for a backfill?
5. **Identifier stability**: are ids stable across seasons, and is that a
   contractual commitment or a best effort?
6. **Crosswalks** to GSIS/ESPN/PFR ids: supplied, or must we build them?
7. **Corrections**: how is a restated statistic delivered?
8. **Retention** after termination.
9. **Indemnity** for upstream rights, and any liability cap.
10. Which fields are **third-party relayed** rather than collected by the vendor,
    and what are the terms on those?

## 6. Candidates measured against the list (public pages only)

| Vendor | M1 2000+ | M2 PBP | M8 transactions | M9 draft | M12 crosswalk | Terms public | Notes |
|---|---|---|---|---|---|---|---|
| **Sportradar NFL** | yes — REG/POST 2000+, PRE 2015+; "Seasons 2000 to 2020 were sourced in part directly from the NFL" | yes | yes (daily) | yes | ids + reference ids | data-licensing terms public; **pricing gated** | the only candidate that appears to meet M1-M12 in one product; history depth is itself a contract tier |
| **SportsDataIO NFL** | "dating back to 2001" (UNVERIFIED for NFL specifics) | yes (NFL) | yes | yes | advertises an open id-mapping product (**UNVERIFIED** licence) | generic website terms only; **no data-redistribution clause read** | cheaper reputationally; its *college* product has no PBP at all, which is a caution about assuming parity across products |
| **Genius Sports** | UNVERIFIED | official real-time NFL PBP, exclusive through the 2029 season | UNVERIFIED | UNVERIFIED | UNVERIFIED | gated | strongest for live/official data; **no public evidence of historical depth** |
| **Sports Reference bulk licence** | 1920+, drafts, combine | no PBP | no | yes | PFR ids | terms public | the only route to deep pre-1999 — but §5 bars substitute databases **and** AI/ML training, so a grant must expressly override both; custom data starts at $5,000 |
| **FTN Data** | n/a | charting/participation 2022+ | no | no | nflverse ids | UNVERIFIED | would resolve the participation hold without ShareAlike |

**Assessment:** on public evidence Sportradar is the only single-vendor candidate
for M1-M12, and it would also retire the ESPN live/schedule dependency. It does
not cover P4 (pre-1999), which would still need Sports Reference or
public-domain reconstruction.

## 7. What a licence would unblock

Stages 3-5 and 7 of the ingestion sequence in `PLAN.md`: modern-era games, plays
and drives; rosters, transactions, injuries and depth charts; draft and combine;
and — with Sports Reference or public-domain work — pre-1999 history. It would
also let the history graph serve **public** surfaces instead of internal-only,
since the rights filter is already enforced in the data layer.

## 8. Decision this brief is asking for

Whether to request pricing and terms from Sportradar (and optionally
SportsDataIO) against this list. **Nobody has been contacted.** If the answer is
yes, the next artefact is a one-page RFI built from §2, §3 and §5 — still with no
commitment.
