# PBEcast Arcade Replay — Phase 1 prototype

Isolated. Not wired into `page-loader.js`, not referenced by any shipped file, not
deployed. Open `prototype/arcade/index.html` from a local static server.

Branch `prototype/arcade-replay`, cut from `visual-finish @ 2360156` so the
visual work awaiting review is untouched.

---

## 1. Audit of `/api/nfl-live` — what the contract actually is

Audited 2026-09-05 against `/api/nfl-live?event=401772936` (192 plays), four
more completed games (907 plays total), and the upstream
`cdn.espn.com/core/nfl/playbyplay` package the endpoint wraps.

### Present and structured — verified on 192/192 plays

| field | notes |
|---|---|
| `id`, `sequence` | stable play identity |
| `text`, `short_text` | the published sentence |
| `type`, `type_id` | **structured taxonomy** — 24 distinct ids observed |
| `period`, `clock`, `wallclock` | |
| `scoring_play` | boolean |
| `home_score`, `away_score` | |
| `start.{down,distance,yard_line,yards_to_endzone,possession_text,down_distance_text}` | |
| `end.{…same…}` | |
| `drives[].team{id,abbreviation,display_name,logo}` | **the possessing team** |

### Assumed in the brief but NOT present

| field | reality |
|---|---|
| `participants[]` | **0 of 192.** Not dropped by our normalizer — the upstream package carries no athlete participants on plays at all. |
| participant position / role | consequently absent |
| `play.team` | **0 of 192.** Possession comes from the parent drive. |
| `score_value` | 0 of 192 |

**Consequence:** passer, receiver, rusher, tackler, interceptor and kicker have
**no structured source**. They exist only inside `play.text`. The prototype reads
them from text and marks every one `TEXT_DERIVED`. Nothing is presented as a
structured participant list, and no role is asserted that the sentence did not
state.

### Present upstream but dropped by `/api/nfl-live` — the one blocking gap

| field | upstream coverage |
|---|---|
| `statYardage` | 192/192 — the official yards figure |
| `isTurnover` | 192/192 |
| `isPenalty` | 192/192 (14 true) |
| `start.team.id` | 190/192 |
| `end.team.id` | 192/192 |

**Why it matters.** `end.yards_to_endzone` is measured in whichever team's frame
holds the ball at that moment. Measured on game 401772936:

| | delta reproduces `statYardage` |
|---|---|
| `start.team == end.team` | 144 of 166 |
| `start.team != end.team` | **4 of 26** |

So `start.yards_to_endzone − end.yards_to_endzone` is wrong on every possession
change, and without the team ids the frontend cannot tell which case it is in.
The normalizer therefore accepts **both** shapes, reports which one it received
in `contract`, and lowers `confidence` rather than guessing.

Adding those five fields to `api/nfl-live.js` is a ~1-line change per field and
is the single highest-value follow-up. I have **not** made it — that is a
production API change and this is an isolated prototype.

### Observed play-type taxonomy (5 games, 907 plays)

`5` Rush 283 · `24` Pass Reception 166 · `3` Pass Incompletion 111 · `74` Official
Timeout 72 · `53` Kickoff 48 · `52` Punt 37 · `8` Penalty 31 · `7` Sack 30 ·
`21` Timeout 28 · `67` Passing TD 21 · `59` FG Good 15 · `2/65/66` period ends 20 ·
`75` Two-minute 10 · `68` Rushing TD 8 · `26` Interception Return 7 · `12` Kickoff
Return 5 · `60` FG Missed 4 · `9` Fumble Recovery (Own) 3 · `29` Fumble Recovery
(Opponent) 3 · `32` Kickoff Return TD 3 · `20` Safety 1 · `36` Interception Return TD 1

**Not observed** in the sample: extra point, two-point, kneel, spike, punt-return
TD, blocked kicks. These are mapped by type *name* and flagged
`typeVerified: false`. Anything matching neither id nor name becomes `unknown`
and falls back to a field-state transition plus the published text. No football
event is ever invented because a classifier missed.

---

## 2. Truth model

Every field on an `ArcadePlay` carries provenance, surfaced in the demo UI:

| tag | meaning |
|---|---|
| `SOURCE_FACT` | straight out of a structured API field |
| `DERIVED` | computed from structured fields only, no prose |
| `TEXT_DERIVED` | read out of `play.text` because the feed has no structured field |
| `RECONSTRUCTED` | invented for illustration |
| `UNAVAILABLE` | not supplied, and not guessed |

**SOURCE FACT** — snap spot, destination, down, distance, first-down line,
possession change, scoring, clock, quarter, score, play type, offense, the
published sentence.

**RECONSTRUCTED** — routes, running lanes, blocking, defender movement,
formation, all 22 player positions, timing. Labelled on the canvas itself
("ROUTES, LANES AND DEFENDER MOVEMENT ARE RECONSTRUCTED"), not only in
surrounding chrome. Geometry is seeded from the play id so a replay never
wanders between viewings.

**TEXT_DERIVED** — every player name.

Three places the naive reading would have lied, caught during the build:

1. A **field goal**'s `statYardage` is kick distance. `M.Gay 51 yard field goal`
   carries `statYardage: 51` while the offense advanced nothing; the delta said
   "+33". Yards gained is now simply not asserted for a kick; `kickDistanceYards`
   is reported separately.
2. An **incompletion** with a penalty carries `statYardage: 5` — the penalty's
   net field result, not the pass. Yards gained is forced to 0 and the animation
   never shows a catch; `fieldResultYards` reports the 5 separately.
3. A **touchdown**'s `end` state is a sentinel (`down: -1`, `yards_to_endzone: 0`)
   describing the ensuing kickoff, not where the ball finished.

---

## 3. Demonstrated plays — all real, all from the live feed

| demo | play id | source text | ArcadePlay result |
|---|---|---|---|
| Completed pass | `401772936137` | `(Shotgun) J.Love pass short left to D.Wicks pushed ob at WAS 46 for 13 yards (M.Lattimore).` | 41 → 54, **+13**, passer J.Love, receiver D.Wicks, tackler M.Lattimore |
| Rush | `401772936647` | `J.Love scrambles right end to WAS 5 for 14 yards (J.Newton).` | 81 → 95, **+14**, rusher J.Love, tackler J.Newton |
| Touchdown | `401772936672` | `J.Love pass short right to R.Doubs for 5 yards, TOUCHDOWN.` | 95 → 100, **TOUCHDOWN**, scoring `true` |
| Turnover | `4016718891047` | `J.Hurts pass deep right intended for A.Brown INTERCEPTED by B.Cook at KC 2.` | 70 → 98, **possessionChange true**, interceptor B.Cook |
| Incomplete | `401772936189` | `J.Love pass incomplete deep middle to R.Doubs. PENALTY …` | 55 → 55, **0 yards**, `fieldResultYards: 5` |
| Sack | `401772936427` | `J.Daniels sacked at WAS 35 for -1 yards (D.Wyatt).` | 36 → 35, **−1** |
| Field goal | `4017729361709` | `M.Gay 51 yard field goal is GOOD.` | `kickDistanceYards: 51`, yards gained **not asserted** |

Every animation terminates on the published field state.

---

## 4. Renderer

Original PropBetEdge pixel language. Nothing is traced from, measured against or
derived from any commercial football game's artwork, sprites, logos, animations,
fonts or UI. Figures are built from rectangles at draw time; the palette is the
brand's ink/paper/gold/crimson plus the two teams' own feed colours (lifted to a
minimum luminance so a near-black team colour stays visible on turf).

One canvas at a fixed 240 × 108 pixel grid — 2px per yard across 120 yards —
scaled up with `imageSmoothingEnabled = false`. One draw call per frame, no
animated DOM nodes, a single `requestAnimationFrame` timeline. Internal scale is
`max(2, ceil(cssWidth × dpr / 240))` so a phone never renders the grid at 1× and
lets CSS blur it.

`prefers-reduced-motion` is honoured: start state → result state, no animation.
Also toggleable in the demo.

## 5. Live queue and historical replay

Simulated in the demo against real plays. New play ids enqueue and animate once;
several arriving together queue in sequence; a queue deeper than 4 skips
straight to the live state so the animation can never fall behind the game.
PAUSE / REPLAY / SKIP TO RESULT are wired. Selecting an older row in the game log
enters a red **REPLAY** band with **RETURN TO LIVE**, so an old play is never
mistaken for the current one.

## 6. Not built in Phase 1

Audio (the brief defers it), landscape/fullscreen, real polling against a live
game (no NFL game is in progress — the 2026 season has not started, so every
scheduled game returns 0 plays), and the `api/nfl-live.js` field additions.
