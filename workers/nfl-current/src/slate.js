/* nfl-current — which week the product should put in front of a reader.
 *
 * `current_week` is the provider's label for the week (ESPN's board.week). It
 * is consumed outside the UI — the picks engine attributes decisions to it and
 * grades against it — so its meaning is not changed here.
 *
 * The provider keeps that label on the old week until its own calendar rolls
 * (midweek), so between Monday Night Football going final and that rollover a
 * homepage that follows it shows sixteen finals while the next week's games
 * already exist. The primary slate is a separate, presentation-only answer,
 * decided by football state and never by the day of the week:
 *
 *   1. any game LIVE                        -> the week containing the live games
 *   2. provider week still has a game that
 *      has not kicked off                   -> the provider week
 *   3. provider week has nothing open and a
 *      later scheduled kickoff exists       -> the week of the earliest one
 *   4. nothing scheduled anywhere           -> the most recently completed week,
 *                                              state FINAL
 *
 * A week is identified by season + season type + week number, because the
 * postseason restarts its week numbers at 1.
 */

const DAY_MS = 864e5;
/* A game the provider still calls pregame six hours after its kickoff is a
   postponement or a stalled feed, not something a reader can act on. The same
   tolerance the season contract already applies to `upcoming`. */
const STALE_PREGAME_MS = 6 * 36e5;

const POST_NAMES = { 1: 'WILD CARD', 2: 'DIVISIONAL ROUND', 3: 'CONFERENCE CHAMPIONSHIPS', 4: 'PRO BOWL', 5: 'SUPER BOWL' };

export function weekKey(g) {
  if (!g || g.season == null || !g.season_type || g.week == null) return null;
  return `${g.season}:${g.season_type}:${g.week}`;
}

export function weekLabel(seasonType, week) {
  if (week == null) return null;
  if (seasonType === 'POST') return POST_NAMES[week] || `POSTSEASON WEEK ${week}`;
  if (seasonType === 'PRE') return `PRESEASON WEEK ${week}`;
  return `WEEK ${week}`;
}

export function ymdET(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}${g('month')}${g('day')}`;
}

const kick = g => Date.parse(g?.kickoff || '');
export const isOpen = (g, now) => g?.semantics === 'SCHEDULE' && Number.isFinite(kick(g)) && kick(g) >= now - STALE_PREGAME_MS;

function weeksOf(games) {
  const map = new Map();
  for (const g of games) {
    const key = weekKey(g);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { key, season: g.season, season_type: g.season_type, week: g.week, games: [] });
    map.get(key).games.push(g);
  }
  for (const w of map.values()) w.games.sort((a, b) => kick(a) - kick(b));
  return map;
}

function describe(w, now, reason, dates) {
  const live = w.games.filter(g => g.semantics === 'LIVE').length;
  const final = w.games.filter(g => g.semantics === 'FINAL').length;
  const open = w.games.filter(g => isOpen(g, now)).length;
  const state = live ? 'LIVE' : open && !final ? 'UPCOMING' : open ? 'IN_PROGRESS' : 'FINAL';
  const first = kick(w.games[0]), last = kick(w.games[w.games.length - 1]);
  return {
    key: w.key,
    season: w.season,
    season_type: w.season_type,
    week: w.week,
    label: weekLabel(w.season_type, w.week),
    state,
    reason,
    first_kickoff: w.games[0]?.kickoff || null,
    last_kickoff: w.games[w.games.length - 1]?.kickoff || null,
    /* The games of this week that fall inside the contract's window. A week
       at the edge of the window can be partial, so a reader fetches the week
       by `dates` and filters on `key` rather than trusting this count. */
    counts_in_window: { games: w.games.length, live, final, scheduled: open },
    /* ET dates wide enough to hold the whole week: the provider's `dates`
       filter does not use kickoff instants, so the range is padded and the
       reader keeps only games whose season/type/week match `key`. */
    dates: dates(first, last)
  };
}

/* games: the season contract's readGame() rows. provider: { season, season_type, week }. */
export function deriveSlate(games, provider, now = Date.now()) {
  const rows = (Array.isArray(games) ? games : []).filter(g => g && g.id);
  const weeks = weeksOf(rows);
  const providerKey = weekKey(provider || {});
  const byKick = rows.slice().sort((a, b) => kick(a) - kick(b));

  let primary = null, reason = null;
  const live = byKick.filter(g => g.semantics === 'LIVE');
  if (live.length) { primary = weeks.get(weekKey(live[0])); reason = 'live_games'; }
  if (!primary && providerKey && weeks.get(providerKey)?.games.some(g => isOpen(g, now))) {
    primary = weeks.get(providerKey); reason = 'provider_week_has_games_to_play';
  }
  if (!primary) {
    const next = byKick.find(g => isOpen(g, now));
    if (next) { primary = weeks.get(weekKey(next)); reason = 'advanced_to_earliest_scheduled_kickoff'; }
  }
  if (!primary) {
    const lastFinal = byKick.filter(g => g.semantics === 'FINAL').pop();
    if (lastFinal) { primary = weeks.get(weekKey(lastFinal)); reason = 'no_scheduled_games_remaining'; }
  }

  const completed = [...weeks.values()]
    .filter(w => w.games.some(g => g.semantics === 'FINAL') && !w.games.some(g => g.semantics === 'LIVE' || isOpen(g, now)))
    .sort((a, b) => kick(b.games[b.games.length - 1]) - kick(a.games[a.games.length - 1]));
  const latestCompleted = completed[0] || null;
  /* The finished week that precedes the primary slate: what a reader has just
     missed. When the primary slate is itself the final state, there is no
     separate "previous" to fold away. */
  const previous = primary
    ? completed.find(w => w.key !== primary.key && kick(w.games[w.games.length - 1]) <= kick(primary.games[0])) || null
    : null;

  const primaryDates = (first, last) => `${ymdET(first - DAY_MS)}-${ymdET(Math.max(last, first + 6 * DAY_MS) + DAY_MS)}`;
  const previousDates = (first, last) => `${ymdET(Math.min(first, last - 6 * DAY_MS) - DAY_MS)}-${ymdET(last + DAY_MS)}`;

  return {
    provider_week: provider?.week ?? null,
    primary_slate_week: primary ? primary.week : null,
    latest_completed_week: latestCompleted ? latestCompleted.week : null,
    primary_slate: primary ? describe(primary, now, reason, primaryDates) : null,
    previous_slate: previous ? describe(previous, now, 'most_recent_completed_week_before_primary', previousDates) : null,
    latest_completed_slate: latestCompleted ? { key: latestCompleted.key, season: latestCompleted.season, season_type: latestCompleted.season_type, week: latestCompleted.week, label: weekLabel(latestCompleted.season_type, latestCompleted.week) } : null
  };
}

/* ---- per-team schedule truth ------------------------------------------------
   Player DNA needs "this team's next NFL game" and used to take it from
   whatever scoreboard it happened to hold, so on the Tuesday after Week 1 every
   team had "no upcoming game" while Week 2 was already scheduled. The answer
   comes from the schedule, never from whether a market exists for the game.

   next        the team's LIVE game, else its earliest open scheduled kickoff
   last_final  the team's most recent FINAL
   A team with no game in `window` genuinely has nothing scheduled in it
   (offseason, eliminated, or a postseason round not yet drawn). */
function brief(g) {
  return {
    espn_event_id: g.id, name: g.name, kickoff_utc: g.kickoff, season: g.season, season_type: g.season_type, week: g.week,
    semantics: g.semantics, away_team: g.away?.abbreviation || null, home_team: g.home?.abbreviation || null,
    away_score: g.semantics === 'SCHEDULE' ? null : (g.away?.score ?? null), home_score: g.semantics === 'SCHEDULE' ? null : (g.home?.score ?? null)
  };
}

const NOT_TEAMS = new Set(['TBD', 'TBA', 'AFC', 'NFC']);

export function teamSchedule(games, now = Date.now()) {
  const out = {};
  const rows = (Array.isArray(games) ? games : []).filter(g => g && g.id && g.away?.abbreviation && g.home?.abbreviation)
    .sort((a, b) => kick(a) - kick(b));
  const seen = new Set();
  for (const g of rows) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    for (const team of [g.away.abbreviation, g.home.abbreviation]) {
      if (!/^[A-Z]{2,4}$/.test(team) || NOT_TEAMS.has(team)) continue;  // an undrawn playoff slot or Pro Bowl side is not a team
      const t = (out[team] ||= { next: null, last_final: null });
      if (!t.next && (g.semantics === 'LIVE' || isOpen(g, now))) t.next = brief(g);
      if (g.semantics === 'FINAL') t.last_final = brief(g);  // ascending, so the last write is the latest
    }
  }
  return out;
}
