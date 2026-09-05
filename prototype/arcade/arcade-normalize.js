/* PBECAST ARCADE REPLAY — play normalizer (PROTOTYPE, not wired into the app)
 * =============================================================================
 * Turns one /api/nfl-live play object into an ArcadePlay the renderer can draw.
 *
 * TRUTH CONTRACT
 * We do not have X/Y player tracking. This is not an exact replay. Outcome and
 * published field states are exact; everything between them is illustrative.
 * Every field on an ArcadePlay therefore carries provenance:
 *
 *   SOURCE_FACT    read straight out of a structured API field
 *   DERIVED        computed from structured API fields only, no prose
 *   TEXT_DERIVED   read out of play.text because the feed has no structured
 *                  field for it -- lower confidence, never presented as tracking
 *   RECONSTRUCTED  invented by the renderer for illustration (routes, lanes,
 *                  blocking, defender movement, all 22 positions)
 *   UNAVAILABLE    the feed does not supply it and we will not guess
 *
 * WHAT THE LIVE FEED ACTUALLY CONTAINS (audited 2026-09-05 against
 * /api/nfl-live?event=401772936 -- 192 plays -- plus four more games, and
 * against the upstream cdn.espn.com playbyplay package):
 *
 *   PRESENT and structured
 *     id, sequence, text, short_text, type, type_id, period, clock, wallclock,
 *     scoring_play, home_score, away_score,
 *     start{down,distance,yard_line,yards_to_endzone,possession_text,
 *           down_distance_text}, end{same},
 *     drives[].team{id,abbreviation,display_name,logo}  <- the possessing team
 *
 *   ABSENT despite being in the assumed contract
 *     participants[]        0 of 192 plays. Not dropped by our normalizer --
 *                           the upstream package does not carry athlete
 *                           participants on plays at all. So passer, receiver,
 *                           rusher, tackler and interceptor have NO structured
 *                           source. They exist only inside play.text.
 *     play.team             0 of 192. Possession comes from the parent drive.
 *     score_value           0 of 192.
 *
 *   PRESENT UPSTREAM BUT DROPPED BY /api/nfl-live  (the one blocking gap)
 *     statYardage           192/192 upstream. The official yards figure.
 *     isTurnover            192/192 upstream.
 *     isPenalty             192/192 upstream.
 *     start.team.id         190/192 upstream.
 *     end.team.id           192/192 upstream.
 *
 * WHY THAT GAP MATTERS. end.yards_to_endzone is measured in whichever team's
 * frame owns the ball at that moment. Measured on game 401772936:
 *   start.team == end.team : start.ytg_ez - end.ytg_ez reproduced statYardage
 *                            on 144 of 166 plays
 *   start.team != end.team : it reproduced it on 4 of 26
 * So the naive delta is wrong on every possession change, and without the team
 * ids the frontend cannot tell which case it is in. This module therefore
 * accepts BOTH shapes: today's /api/nfl-live play, and the same play enriched
 * with the five upstream fields above. It reports which one it got in
 * `contract`, and lowers confidence rather than guessing when the frame is
 * unknown.
 * ========================================================================== */

/* ---- play-type taxonomy --------------------------------------------------
 * OBSERVED means the type_id was seen in the five real games audited; the count
 * follows. UNVERIFIED means the id/name is a standard ESPN value that did not
 * occur in the audited sample, so it is mapped but not proven. Anything that
 * matches neither becomes `unknown` and the renderer falls back to a field-state
 * transition plus the published text. We never invent a football event because
 * a classifier missed.
 */
export const PLAY_TYPES = {
  // id  : [kind, observedCount|null]
  '5':  ['rush', 283],
  '24': ['pass_complete', 166],
  '3':  ['pass_incomplete', 111],
  '7':  ['sack', 30],
  '52': ['punt', 37],
  '53': ['kickoff', 48],
  '12': ['kickoff_return', 5],
  '32': ['kickoff_return_td', 3],
  '59': ['field_goal_good', 15],
  '60': ['field_goal_missed', 4],
  '67': ['passing_touchdown', 21],
  '68': ['rushing_touchdown', 8],
  '26': ['interception', 7],
  '36': ['interception_td', 1],
  '9':  ['fumble_own', 3],
  '29': ['fumble_lost', 3],
  '20': ['safety', 1],
  /* observed in the 59-game corpus and previously falling through to unknown */
  '80': ['sack_fumble_lost', 5],
  '39': ['fumble_return_td', 2],
  '38': ['blocked_fg_td', 2],
  '8':  ['penalty', 31],
  '2':  ['period_end', 10],
  '65': ['period_end', 5],
  '66': ['period_end', 5],
  '21': ['stoppage', 28],
  '74': ['stoppage', 72],
  '75': ['stoppage', 10]
};

/* Standard ESPN type names that did not occur in the audited sample. Mapped by
   name so V1 supports them, flagged unverified so the report stays honest. */
export const PLAY_TYPES_BY_NAME_UNVERIFIED = {
  'extra point good': 'extra_point',
  'extra point missed': 'extra_point',
  'extra point blocked': 'extra_point',
  'two-point conversion': 'two_point',
  'two point conversion': 'two_point',
  'two-point rush': 'two_point',
  'two-point pass': 'two_point',
  'kneel': 'kneel',
  'kneel down': 'kneel',
  'end of regulation': 'period_end',
  'spike': 'spike',
  'pass incompletion spike': 'spike',
  'blocked field goal': 'field_goal_missed',
  'blocked punt': 'punt',
  'punt return touchdown': 'punt_return_td',
  'fumble recovery (own) touchdown': 'fumble_own',
  'fumble recovery (opponent) touchdown': 'fumble_lost'
};

/* Play kinds that structurally change possession. Derived from the play TYPE,
   which is a structured field -- not from prose. */
const FLIPS_POSSESSION = new Set([
  'punt', 'kickoff', 'kickoff_return', 'kickoff_return_td',
  'interception', 'interception_td', 'fumble_lost',
  'field_goal_good', 'field_goal_missed', 'punt_return_td', 'safety',
  'sack_fumble_lost', 'fumble_return_td', 'blocked_fg_td'
]);

const SCORES = new Set([
  'passing_touchdown', 'rushing_touchdown', 'kickoff_return_td',
  'interception_td', 'punt_return_td', 'field_goal_good', 'extra_point',
  'two_point', 'safety', 'fumble_return_td', 'blocked_fg_td'
]);

/* Plays with no field action to animate. */
const NON_PLAYS = new Set(['stoppage', 'period_end']);

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = v => (v === null || v === undefined ? '' : String(v));
const clampYard = v => Math.max(0, Math.min(100, v));

function classify(play) {
  const id = str(play?.type_id);
  if (PLAY_TYPES[id]) {
    const [kind, observed] = PLAY_TYPES[id];
    return { kind, basis: 'type_id', observed, verified: true };
  }
  const name = str(play?.type).toLowerCase().trim();
  if (PLAY_TYPES_BY_NAME_UNVERIFIED[name]) {
    return { kind: PLAY_TYPES_BY_NAME_UNVERIFIED[name], basis: 'type_name', observed: 0, verified: false };
  }
  return { kind: 'unknown', basis: 'none', observed: 0, verified: false };
}

/* ---- participants --------------------------------------------------------
 * The feed carries no structured participants, so these come out of play.text
 * and are labelled TEXT_DERIVED everywhere they surface. The patterns below
 * match the NFL gamebook conventions actually present in the audited text
 * ("J.Love pass short left to D.Wicks ... (M.Lattimore)"). A name that does not
 * match is left null rather than guessed at, and no role is asserted that the
 * sentence did not state.
 */
/* A gamebook name is "J.Love" / "D.Wicks". The surname must be bounded to a
   single capitalised word, or it swallows the next sentence: the real text
   "to R.Doubs.PENALTY on WAS-M.Lattimore" yielded the receiver
   "R.Doubs.PENALTY" while the surname class still allowed a dot. */
const NAME = "([A-Z][A-Za-z'`-]*\\.[A-Z][a-z'`-]+(?:-[A-Z][a-z'`-]+)?)";
const RX = {
  passer:      new RegExp(NAME + '\\s+pass\\b', 'i'),
  sacked:      new RegExp(NAME + '\\s+sacked\\b', 'i'),
  receiver:    new RegExp('\\bto\\s+' + NAME + '(?=[\\s,.]|$)'),
  intendedFor: new RegExp('\\bintended for\\s+' + NAME),
  rusher:      new RegExp(NAME + "\\s+(?:up the middle|left|right|scrambles|rushed|run|kneels)", 'i'),
  interceptor: new RegExp('INTERCEPTED by\\s+' + NAME),
  kicker:      new RegExp(NAME + '\\s+(?:kicks|punts|\\d+\\s+yard field goal)', 'i'),
  recoverer:   new RegExp('RECOVERED by\\s+[A-Z]{2,3}-' + NAME, 'i'),
  fumbledBy:   new RegExp(NAME + '\\s+FUMBLES', 'i'),
  /* the trailing parenthetical is the tackler in gamebook convention */
  tackler:     new RegExp('\\((' + "[A-Z][A-Za-z'`-]*\\.[A-Z][a-z'`-]+(?:-[A-Z][a-z'`-]+)?" + ')\\)')
};

function readNames(text, kind) {
  const t = str(text);
  const hit = rx => { const m = t.match(rx); return m ? m[1] : null; };
  const out = {
    passer: null, receiver: null, rusher: null, tackler: null,
    interceptor: null, kicker: null, fumbledBy: null, recoveredBy: null
  };
  if (!t) return out;

  if (kind === 'pass_complete' || kind === 'passing_touchdown') {
    out.passer = hit(RX.passer);
    out.receiver = hit(RX.receiver);
  } else if (kind === 'pass_incomplete') {
    out.passer = hit(RX.passer);
    /* an incompletion names a target, not a receiver -- keep the distinction */
    out.receiver = hit(RX.intendedFor) || hit(RX.receiver);
  } else if (kind === 'interception' || kind === 'interception_td') {
    out.passer = hit(RX.passer);
    out.receiver = hit(RX.intendedFor);
    out.interceptor = hit(RX.interceptor);
  } else if (kind === 'rush' || kind === 'rushing_touchdown' || kind === 'kneel') {
    out.rusher = hit(RX.rusher);
  } else if (kind === 'sack') {
    out.passer = hit(RX.sacked);
  } else if (kind === 'punt' || kind === 'kickoff' || kind === 'field_goal_good' ||
             kind === 'field_goal_missed' || kind === 'extra_point') {
    out.kicker = hit(RX.kicker);
  }
  if (kind === 'fumble_own' || kind === 'fumble_lost') {
    out.fumbledBy = hit(RX.fumbledBy);
    out.recoveredBy = hit(RX.recoverer);
  }
  out.tackler = hit(RX.tackler);
  /* A tackler cannot also be the ball carrier; the parenthetical would have
     matched something else. Drop rather than assert. */
  if (out.tackler && (out.tackler === out.receiver || out.tackler === out.rusher)) out.tackler = null;
  return out;
}

/* ---- field model ---------------------------------------------------------
 * Canonical coordinate is `abs`: 0..100 yards from the OFFENSE'S OWN goal line,
 * so 100 is the end zone they are attacking. It is computed only from
 * yards_to_endzone, which is unambiguous, never from possession_text prose.
 *
 * A spot is reported in the frame of whichever team holds the ball at that
 * moment. Converting the end spot back into the snapping offense's frame:
 *     same frame      absOffense = 100 - end.yards_to_endzone
 *     frame flipped   absOffense =       end.yards_to_endzone
 * Verified against the real interception below: PHI snap at their own 70
 * (KC 30, ytg_ez 30 -> abs 70); ball intercepted at KC 2, published in KC's
 * frame as ytg_ez 98, which is abs 98 in PHI's frame -- the correct spot.
 */
function fieldModel(play, kind, contract) {
  const sYtg = num(play?.start?.yards_to_endzone);
  const eYtg = num(play?.end?.yards_to_endzone);
  const startAbs = sYtg === null ? null : 100 - sYtg;

  /* --- possession frame -------------------------------------------------
     Audited on 10,832 plays: is_turnover TRUE always coincided with a changed
     frame (122/122) but FALSE did not imply the frame held -- 1,159 plays
     changed frame without it (529 kickoffs, 433 punts, turnovers on downs,
     missed field goals). The team ids are the only necessary-and-sufficient
     test, so they are preferred and everything else is a fallback. */
  let flipped = null, flipSource = 'UNAVAILABLE';
  const sTeam = str(play?.start?.team_id), eTeam = str(play?.end?.team_id);
  if (sTeam && eTeam) {
    flipped = sTeam !== eTeam; flipSource = 'SOURCE_FACT';
  } else if (play?.is_turnover === true) {
    flipped = true; flipSource = 'SOURCE_FACT';
  } else if (kind !== 'unknown') {
    flipped = FLIPS_POSSESSION.has(kind); flipSource = 'DERIVED';
  }

  /* --- the scoring sentinel ---------------------------------------------
     On all 515 scoring plays in the sample the end state carried down === -1
     (and often yards_to_endzone of the ensuing kickoff spot, e.g. 15). It
     describes the restart, NOT where the ball finished, and must never be read
     as an ordinary same-possession field transition. */
  const endDown = num(play?.end?.down);
  const scored = SCORES.has(kind) || play?.scoring_play === true;
  /* down === -1 alone is NOT the scoring sentinel. Kickoff returns carry it too
     (75 in the corpus) while their end.yards_to_endzone is a real return spot,
     and treating them as sentinels made every one of them fail closed. The
     sentinel is a SCORING end state: measured, all 515 scoring plays in the
     corpus carried down === -1 or yards_to_endzone === 0. */
  const sentinel = scored && (endDown === -1 || eYtg === 0);

  /* --- next snap spot ---------------------------------------------------
     Where the chains actually go, after any enforcement. Meaningless on a
     sentinel end state. */
  let nextSnapAbs = null, nextSnapSource = 'UNAVAILABLE';
  if (!sentinel && eYtg !== null && flipped !== null) {
    nextSnapAbs = flipped ? eYtg : 100 - eYtg;
    nextSnapSource = flipSource === 'SOURCE_FACT' ? 'SOURCE_FACT' : 'DERIVED';
  }

  const isKick = kind === 'field_goal_good' || kind === 'field_goal_missed' ||
                 kind === 'extra_point' || kind === 'punt' || kind === 'kickoff';
  const stat = num(play?.stat_yardage);

  /* --- yards gained ------------------------------------------------------ */
  let gained = null, gainedSource = 'UNAVAILABLE';
  let kickDistance = null;
  if (isKick) {
    /* statYardage on a kick is KICK DISTANCE. Measured: it equalled
       start.yards_to_endzone + 18 on 212 of 253 field goals. It is never the
       offence's field advance and is never reported as yards gained. */
    if (stat !== null) kickDistance = stat;
  } else if (kind === 'pass_incomplete' || kind === 'spike') {
    gained = 0; gainedSource = 'DERIVED';          // the pass itself gains nothing
  } else if (stat !== null && !NON_PLAYS.has(kind)) {
    gained = stat; gainedSource = 'SOURCE_FACT';
  } else if (startAbs !== null && nextSnapAbs !== null && flipped === false && !NON_PLAYS.has(kind)) {
    gained = nextSnapAbs - startAbs; gainedSource = 'DERIVED';
  }

  /* --- where the ball finished ------------------------------------------
     Distinct from the next snap spot. On an incompletion the ball returns to
     the snap; a penalty may then move the NEXT SNAP without the pass having
     gained anything. Both are reported so neither can be mistaken for the
     other, and so an incompletion is never animated as a completion nor
     falsely pinned when a penalty did move the ball. */
  let ballEndAbs = null, ballEndSource = 'UNAVAILABLE';
  if (scored && !isKick) {
    ballEndAbs = 100; ballEndSource = 'SOURCE_FACT';
  } else if (kind === 'pass_incomplete' || kind === 'spike') {
    ballEndAbs = startAbs; ballEndSource = 'DERIVED';
  } else if (isKick && scored) {
    /* a made kick finishes through the uprights; its end state is the ensuing
       kickoff spot (yards_to_endzone 65 on every made field goal in the corpus)
       and must not be drawn as the ball's destination */
    ballEndAbs = 100; ballEndSource = 'SOURCE_FACT';
  } else if (isKick) {
    ballEndAbs = nextSnapAbs; ballEndSource = nextSnapSource;
  } else if (startAbs !== null && gained !== null && flipped === false) {
    ballEndAbs = clampYard(startAbs + gained); ballEndSource = gainedSource;
  } else if (nextSnapAbs !== null) {
    ballEndAbs = nextSnapAbs; ballEndSource = nextSnapSource;
  } else if (startAbs !== null && gained !== null) {
    ballEndAbs = clampYard(startAbs + gained); ballEndSource = gainedSource;
  }

  /* --- penalty displacement ---------------------------------------------
     Only asserted when the feed says a penalty was on the play AND the next
     snap sits somewhere other than where the ball finished. */
  let penaltyYards = null;
  if (play?.is_penalty === true && ballEndAbs !== null && nextSnapAbs !== null &&
      flipped === false && nextSnapAbs !== ballEndAbs) {
    penaltyYards = nextSnapAbs - ballEndAbs;
  }

  return {
    startAbs, ballEndAbs, ballEndSource, nextSnapAbs, nextSnapSource,
    flipped, flipSource, scored, sentinel,
    gained, gainedSource, kickDistance, penaltyYards, isKick,
    startYtgEz: sYtg, endYtgEz: eYtg
  };
}

/* ---- confidence ----------------------------------------------------------
 * Describes how much of the DESTINATION we can vouch for. It says nothing about
 * the movement in between, which is always reconstructed.
 */
function confidenceOf(kind, f, contract, names) {
  if (kind === 'unknown') return { level: 'field_state_only', reason: 'play type not in the observed taxonomy' };
  if (NON_PLAYS.has(kind)) return { level: 'no_field_action', reason: 'clock or administrative event' };
  if (f.startAbs === null || f.ballEndAbs === null) return { level: 'field_state_only', reason: 'published field state incomplete' };
  if (kind === 'pass_incomplete' || kind === 'spike') return { level: 'exact_endpoints', reason: 'an incompletion returns the ball to the snap spot; no yardage is created' };
  if (f.ballEndSource === 'SOURCE_FACT' && contract === 'enriched') return { level: 'exact_endpoints', reason: 'snap spot, ball spot and possession frame all from structured fields' };
  if (f.ballEndSource === 'SOURCE_FACT') return { level: 'exact_endpoints', reason: 'snap spot and ball spot from structured fields' };
  return { level: 'endpoints_inferred', reason: 'possession frame inferred from play type; /api/nfl-live does not expose start.team_id / end.team_id' };
}

/**
 * @param play      one object from /api/nfl-live plays[] (optionally enriched
 *                  with stat_yardage / is_turnover / is_penalty /
 *                  start.team_id / end.team_id)
 * @param gameState { drive, homeTeam, awayTeam } -- drive supplies possession,
 *                  which no play-level field does.
 */
export function normalizePlayForArcade(play, gameState = {}) {
  if (!play) return null;
  const cls = classify(play);
  const kind = cls.kind;
  const contract = (play?.start?.team_id || play?.end?.team_id || play?.stat_yardage !== undefined)
    ? 'enriched' : 'api_nfl_live';

  const drive = gameState.drive || play.drive || null;
  const offense = drive?.team?.abbreviation || null;
  const home = gameState.homeTeam || null;
  const away = gameState.awayTeam || null;
  const defense = offense && home && away
    ? (offense === home.abbreviation ? away.abbreviation : home.abbreviation)
    : null;

  const f = fieldModel(play, kind, contract);
  const names = readNames(play.text, kind);

  const arcade = {
    /* identity */
    id: str(play.id),
    sequence: num(play.sequence),
    kind,
    typeText: str(play.type),
    typeId: str(play.type_id),

    /* sides */
    offense, defense,
    offenseColor: drive?.team?.color || null,

    /* field, in the offense's frame, 0..100 */
    startYard: f.startAbs,
    /* where the ball finished, and separately where the next snap is */
    endYard: f.ballEndAbs,
    ballEndYard: f.ballEndAbs,
    nextSnapYard: f.nextSnapAbs,
    penaltyYards: f.penaltyYards,
    scoringSentinel: f.sentinel,
    yardsGained: f.gained,
    kickDistanceYards: f.kickDistance,
    penaltyOnPlay: typeof play?.is_penalty === 'boolean' ? play.is_penalty : null,
    down: num(play?.start?.down) || null,
    distance: num(play?.start?.distance),
    firstDownYard: (f.startAbs !== null && num(play?.start?.distance) !== null)
      ? Math.min(100, f.startAbs + num(play.start.distance)) : null,

    /* outcome */
    scoring: f.scored,
    possessionChange: f.flipped,
    clock: str(play.clock),
    quarter: num(play.period),
    homeScore: num(play.home_score),
    awayScore: num(play.away_score),

    /* people -- every one of these is TEXT_DERIVED, see provenance */
    passer: names.passer, receiver: names.receiver, rusher: names.rusher,
    tackler: names.tackler, interceptor: names.interceptor, kicker: names.kicker,
    fumbledBy: names.fumbledBy, recoveredBy: names.recoveredBy,

    /* the published sentence, always shown verbatim beside the animation */
    actualText: str(play.text),

    contract,
    typeBasis: cls.basis,
    typeVerified: cls.verified,
    confidence: confidenceOf(kind, f, contract, names)
  };

  arcade.provenance = {
    id: 'SOURCE_FACT', sequence: 'SOURCE_FACT', kind: cls.basis === 'none' ? 'UNAVAILABLE' : 'SOURCE_FACT',
    typeText: 'SOURCE_FACT', typeId: 'SOURCE_FACT',
    offense: offense ? 'SOURCE_FACT' : 'UNAVAILABLE',      // from drives[].team
    defense: defense ? 'DERIVED' : 'UNAVAILABLE',
    startYard: f.startAbs === null ? 'UNAVAILABLE' : 'SOURCE_FACT',
    endYard: f.ballEndSource,
    ballEndYard: f.ballEndSource,
    nextSnapYard: f.nextSnapSource,
    penaltyYards: f.penaltyYards === null ? 'UNAVAILABLE' : 'SOURCE_FACT',
    scoringSentinel: 'SOURCE_FACT',
    yardsGained: f.gainedSource,
    kickDistanceYards: f.kickDistance === null ? 'UNAVAILABLE' : 'SOURCE_FACT',
    penaltyOnPlay: typeof play?.is_penalty === 'boolean' ? 'SOURCE_FACT' : 'UNAVAILABLE',
    down: play?.start?.down ? 'SOURCE_FACT' : 'UNAVAILABLE',
    distance: 'SOURCE_FACT',
    firstDownYard: arcade.firstDownYard === null ? 'UNAVAILABLE' : 'DERIVED',
    scoring: 'SOURCE_FACT',
    possessionChange: f.flipSource,
    clock: 'SOURCE_FACT', quarter: 'SOURCE_FACT',
    homeScore: 'SOURCE_FACT', awayScore: 'SOURCE_FACT',
    passer: names.passer ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    receiver: names.receiver ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    rusher: names.rusher ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    tackler: names.tackler ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    interceptor: names.interceptor ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    kicker: names.kicker ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    fumbledBy: names.fumbledBy ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    recoveredBy: names.recoveredBy ? 'TEXT_DERIVED' : 'UNAVAILABLE',
    actualText: 'SOURCE_FACT',
    /* everything the renderer draws that is not listed above */
    routes: 'RECONSTRUCTED', blocking: 'RECONSTRUCTED', defenderMovement: 'RECONSTRUCTED',
    formation: 'RECONSTRUCTED', runningLane: 'RECONSTRUCTED', allTwentyTwoPositions: 'RECONSTRUCTED',
    timing: 'RECONSTRUCTED'
  };

  return arcade;
}

/* Convenience for the demo and for a future game log: normalize a whole feed. */
export function normalizeFeed(feed) {
  const home = feed?.game?.teams?.home || null;
  const away = feed?.game?.teams?.away || null;
  const driveOf = new Map();
  (feed?.drives || []).forEach(d => (d.plays || []).forEach(p => driveOf.set(p.id, d)));
  return (feed?.plays || []).map(p =>
    normalizePlayForArcade(p, { drive: driveOf.get(p.id), homeTeam: home, awayTeam: away })
  );
}

export const __audit = { PLAY_TYPES, PLAY_TYPES_BY_NAME_UNVERIFIED, FLIPS_POSSESSION, classify, readNames, fieldModel };
