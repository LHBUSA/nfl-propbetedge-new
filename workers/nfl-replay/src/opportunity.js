/* PBE Opportunity — the one research data contract (pure, no I/O).
 *
 * Opportunity Radar, My Sunday and Game Script Lab all read what this file
 * derives from the nflverse play-by-play that nfl-replay already ingests. No
 * other source is read: no snap counts (PFR, owner-rejected), no participation
 * (on HOLD), no route or alignment data (not available). Metrics that would
 * need them are declared unsupported in the contract, never approximated.
 *
 * THE PLAY UNIVERSE (metric definitions opportunity-metrics/1.0)
 *
 *   excluded   no_play (penalty-nullified), two-point tries, kneels, spikes,
 *              aborted snaps, special teams, and rows without a possession
 *              team (game start, quarter ends, timeouts)
 *   dropback   a pass play the quarterback dropped back on, split into
 *                attempt   pass_attempt and not a sack
 *                sack      sack
 *                scramble  qb_scramble (checked first: nflverse leaves
 *                          qb_dropback empty on some scrambles)
 *   designed   a rush_attempt that is not a scramble. The ball carrier gets
 *   run        the carry. Scramble yardage is the quarterback's and is never
 *              counted as a carry for anyone.
 *
 *   target     a pass attempt with an intended receiver. Attempts with no
 *              intended receiver (throwaways, batted balls) stay attempts and
 *              are counted as untargeted — they are not anybody's target.
 *
 *   red zone   yardline_100 <= 20 before the snap; inside-10 <= 10; inside-5 <= 5
 *
 *   game state (game-state/1.0), from the pre-play score differential of the
 *   possession team: leading >= +7, trailing <= -7, balanced otherwise.
 *
 * SHARES are ratios of sums: a player's targets over the team's targets in
 * the same games, summed across the window before dividing. Percentages are
 * never averaged, and a denominator is never the sum of a leaderboard.
 *
 * MISSING IS NOT ZERO. A team game in which a player has no recorded target
 * or carry is reported as such — the play-by-play cannot say whether he was
 * inactive or on the field and unused, so it is never scored as a 0% game.
 */

export const OPPORTUNITY_VERSION = 'nfl-opportunity/1.0.0';
export const METRIC_VERSION = 'opportunity-metrics/1.0';
export const LABEL_VERSION = 'opportunity-labels/1.0';
export const STATE_VERSION = 'game-state/1.0';
export const CONTRACT = 'pbe-opportunity/v1';

/* Play-level columns the opportunity layer needs beyond Replay's own. */
export const OPP_COLUMNS = [
  'down', 'ydstogo', 'yardline_100', 'score_differential', 'game_seconds_remaining',
  'qb_dropback', 'qb_scramble', 'qb_kneel', 'qb_spike', 'pass_attempt', 'rush_attempt',
  'two_point_attempt', 'aborted_play'
];
export const OPP_NUMERIC = ['down', 'ydstogo', 'yardline_100', 'score_differential', 'game_seconds_remaining'];
export const OPP_FLAGS = ['qb_dropback', 'qb_scramble', 'qb_kneel', 'qb_spike', 'pass_attempt', 'rush_attempt', 'two_point_attempt', 'aborted_play'];
/* Game-level columns, read once per game rather than stored on every play. */
export const META_COLUMNS = ['season', 'season_type', 'week', 'home_team', 'away_team'];

export const STATES = ['leading', 'trailing', 'balanced'];
export const STATE_MARGIN = 7;
const TYPE_ORDER = { PRE: 0, REG: 1, POST: 2 };

/* Metrics this contract will not produce, and why. The UI renders these
   reasons; it never fills the gap. */
export const UNSUPPORTED = {
  snap_share: 'No approved snap-count source. Pro Football Reference snap counts were rejected for commercial use and participation data is on hold.',
  route_participation: 'Route participation, alignment and coverage are not in any source this product is licensed to use.',
  air_yards_share: 'Not part of Opportunity Radar v1.'
};

export const DEFINITIONS = {
  version: METRIC_VERSION,
  target: 'A pass attempt with an intended receiver. Sacks, scrambles, throwaways with no intended receiver, two-point tries and penalty-nullified plays are not targets.',
  target_share: "A player's targets divided by his team's targets in the same games (ratio of sums).",
  carry: 'A designed run: a rush attempt that is not a quarterback scramble, kneel or two-point try.',
  carry_share: "A player's carries divided by his team's designed runs in the same games (ratio of sums). Quarterback scrambles are excluded from both.",
  red_zone: 'Targets plus carries snapped at or inside the opponent 20. Inside-10 and inside-5 use the same rule at 10 and 5 yards.',
  rz_share: "A player's red-zone targets plus carries divided by his team's red-zone targets plus designed runs.",
  appearance: 'A game in which the player has at least one recorded target or carry. A team game without one is shown as "no recorded opportunity" — inactive and unused look the same in play-by-play.',
  latest: "The player's most recent game with his current team.",
  prior: 'Up to 3 earlier appearances with the same team, excluding the latest game.',
  recent: 'The latest appearance plus the prior window (up to 4 appearances with the current team).',
  season: 'Every appearance with the current team this season. Games with a previous team are listed separately.',
  game_state: `Pre-snap score margin of the offense: leading by ${STATE_MARGIN}+, trailing by ${STATE_MARGIN}+, or balanced in between.`
};

/* ---- play classification ------------------------------------------------ */

export function classifyPlay(p) {
  if (!p || !p.posteam) return { universe: 'admin' };
  const type = p.play_type;
  if (type === 'no_play') return { universe: 'no_play' };
  if (p.two_point_attempt) return { universe: 'two_point' };
  if (type === 'qb_kneel' || p.qb_kneel) return { universe: 'kneel' };
  if (type === 'qb_spike' || p.qb_spike) return { universe: 'spike' };
  if (p.aborted_play) return { universe: 'aborted' };
  if (type !== 'pass' && type !== 'run') return { universe: 'special' };
  if (p.qb_scramble) return { universe: 'dropback', kind: 'scramble', player: p.rusher_player_id || null, name: p.rusher_player_name || null };
  if (p.sack) return { universe: 'dropback', kind: 'sack' };
  if (p.qb_dropback || p.pass_attempt) {
    if (p.pass_attempt) return { universe: 'dropback', kind: 'attempt', player: p.receiver_player_id || null, name: p.receiver_player_name || null };
    return { universe: 'dropback', kind: 'other' };
  }
  if (p.rush_attempt) return { universe: 'designed_run', player: p.rusher_player_id || null, name: p.rusher_player_name || null };
  return { universe: 'other' };
}

export function gameState(diff) {
  if (diff === undefined || diff === null || !Number.isFinite(Number(diff))) return 'unknown';
  const d = Number(diff);
  if (d >= STATE_MARGIN) return 'leading';
  if (d <= -STATE_MARGIN) return 'trailing';
  return 'balanced';
}

const zone = yl => {
  const y = Number(yl);
  if (yl === undefined || yl === null || !Number.isFinite(y) || y <= 0) return { rz: false, i10: false, i5: false };
  return { rz: y <= 20, i10: y <= 10, i5: y <= 5 };
};

const emptyTotals = () => ({
  plays: 0, dropbacks: 0, attempts: 0, sacks: 0, scrambles: 0, other_dropbacks: 0, designed_runs: 0,
  targets: 0, untargeted_attempts: 0, unattributed_runs: 0,
  rz_targets: 0, rz_carries: 0, i10_targets: 0, i10_carries: 0, i5_targets: 0, i5_carries: 0
});
const emptyState = () => ({ plays: 0, dropbacks: 0, attempts: 0, sacks: 0, scrambles: 0, other_dropbacks: 0, designed_runs: 0, targets: 0, untargeted_attempts: 0, unattributed_runs: 0 });
const emptyPlayer = name => ({ n: name || null, t: 0, c: 0, sc: 0, rzt: 0, rzc: 0, i10t: 0, i10c: 0, i5t: 0, i5c: 0, st: {} });

/* One game's plays -> per-team totals, per-state splits and per-player counts.
   `plays` is Replay's stored object (keyed by play_id); `meta` carries the
   game-level columns. Duplicate play ids cannot double count: plays are keyed. */
export function aggregateGame(plays, meta) {
  const list = Object.values(plays || {}).sort((a, b) => a.play_id - b.play_id);
  let maxQtr = 0, zeroClock = false;
  const teams = {};
  const team = abbr => (teams[abbr] ||= {
    totals: emptyTotals(),
    excluded: { no_play: 0, two_point: 0, kneel: 0, spike: 0, aborted: 0, special: 0, other: 0 },
    states: { leading: emptyState(), trailing: emptyState(), balanced: emptyState(), unknown: emptyState() },
    players: {}
  });
  for (const p of list) {
    if (Number.isFinite(p.qtr)) maxQtr = Math.max(maxQtr, p.qtr);
    if (p.game_seconds_remaining === 0) zeroClock = true;
    const cls = classifyPlay(p);
    if (cls.universe === 'admin') continue;
    const t = team(p.posteam);
    if (!['dropback', 'designed_run'].includes(cls.universe)) { t.excluded[cls.universe] = (t.excluded[cls.universe] || 0) + 1; continue; }
    const st = gameState(p.score_differential);
    const z = zone(p.yardline_100);
    const T = t.totals, S = t.states[st];
    T.plays++; S.plays++;
    const player = (id, name) => {
      const row = (t.players[id] ||= emptyPlayer(name));
      if (!row.n && name) row.n = name;
      return row;
    };
    if (cls.universe === 'dropback') {
      T.dropbacks++; S.dropbacks++;
      if (cls.kind === 'sack') { T.sacks++; S.sacks++; }
      else if (cls.kind === 'scramble') { T.scrambles++; S.scrambles++; if (cls.player) player(cls.player, cls.name).sc++; }
      else if (cls.kind === 'other') { T.other_dropbacks++; S.other_dropbacks++; }
      else if (cls.kind === 'attempt') {
        T.attempts++; S.attempts++;
        if (!cls.player) { T.untargeted_attempts++; S.untargeted_attempts++; continue; }
        T.targets++; S.targets++;
        const row = player(cls.player, cls.name);
        row.t++;
        (row.st[st] ||= { t: 0, c: 0 }).t++;
        if (z.rz) { T.rz_targets++; row.rzt++; }
        if (z.i10) { T.i10_targets++; row.i10t++; }
        if (z.i5) { T.i5_targets++; row.i5t++; }
      }
      continue;
    }
    T.designed_runs++; S.designed_runs++;
    if (!cls.player) { T.unattributed_runs++; S.unattributed_runs++; continue; }
    const row = player(cls.player, cls.name);
    row.c++;
    (row.st[st] ||= { t: 0, c: 0 }).c++;
    if (z.rz) { T.rz_carries++; row.rzc++; }
    if (z.i10) { T.i10_carries++; row.i10c++; }
    if (z.i5) { T.i5_carries++; row.i5c++; }
  }
  const home = meta?.home_team || null, away = meta?.away_team || null;
  for (const [abbr, t] of Object.entries(teams)) {
    t.opponent = abbr === home ? away : abbr === away ? home : null;
    t.home = abbr === home;
  }
  return {
    game_id: meta?.game_id || null,
    season: Number(meta?.season) || null,
    season_type: meta?.season_type || null,
    week: Number(meta?.week) || null,
    home, away,
    /* A game is complete when its final quarter reached 0:00 or it went to
       overtime. Anything short of that is excluded from every window and
       listed as incomplete. */
    complete: maxQtr >= 5 || (maxQtr >= 4 && zeroClock),
    teams
  };
}

/* ---- season rollup ---------------------------------------------------------- */

export const LABEL_RULES = {
  version: LABEL_VERSION,
  prior_window: 3,
  target: { min_latest_team: 15, min_prior_team: 25, min_prior_games: 1, delta_pp: 7, expand_min_latest: 4, decline_min_prior_per_game: 3 },
  carry: { min_latest_team: 10, min_prior_team: 15, min_prior_games: 1, delta_pp: 12, expand_min_latest: 6, decline_min_prior_per_game: 5 },
  flat_band_pp: 3,
  highlight_limit: 3
};

const sumKeys = ['t', 'c', 'sc', 'rzt', 'rzc', 'i10t', 'i10c', 'i5t', 'i5c'];
const teamKeys = ['targets', 'designed_runs', 'rz_targets', 'rz_carries', 'i10_targets', 'i10_carries', 'i5_targets', 'i5_carries', 'dropbacks', 'attempts', 'plays'];

const gameOrder = (a, b) => (a.season - b.season) || ((TYPE_ORDER[a.season_type] ?? 9) - (TYPE_ORDER[b.season_type] ?? 9)) || (a.week - b.week) || String(a.game_id).localeCompare(String(b.game_id));
const ratio = (n, d) => (d > 0 ? n / d : null);
const pct = v => (v === null ? null : Math.round(v * 1000) / 10);
const pp = (a, b) => (a === null || b === null ? null : Math.round((a - b) * 1000) / 10);

/* Sum a window of appearances into counts, team denominators and shares. */
export function windowSummary(apps) {
  const out = { games: apps.length, weeks: apps.map(a => a.week), player: {}, team: {} };
  for (const k of sumKeys) out.player[k] = apps.reduce((s, a) => s + a.p[k], 0);
  for (const k of teamKeys) out.team[k] = apps.reduce((s, a) => s + a.tt[k], 0);
  const P = out.player, T = out.team;
  out.target_share = ratio(P.t, T.targets);
  out.carry_share = ratio(P.c, T.designed_runs);
  out.rz_share = ratio(P.rzt + P.rzc, T.rz_targets + T.rz_carries);
  out.target_share_pct = pct(out.target_share);
  out.carry_share_pct = pct(out.carry_share);
  out.rz_share_pct = pct(out.rz_share);
  return out;
}

function judge(metric, latest, prior) {
  const R = LABEL_RULES[metric];
  const shareKey = metric === 'target' ? 'target_share' : 'carry_share';
  const teamKey = metric === 'target' ? 'targets' : 'designed_runs';
  const countKey = metric === 'target' ? 't' : 'c';
  const reasons = [];
  if (!latest || latest.team[teamKey] < R.min_latest_team) reasons.push(`latest game team ${teamKey.replace('_', ' ')} below ${R.min_latest_team}`);
  if (!prior || prior.games < R.min_prior_games) reasons.push('no prior appearance with this team');
  else if (prior.team[teamKey] < R.min_prior_team) reasons.push(`prior window team ${teamKey.replace('_', ' ')} below ${R.min_prior_team}`);
  if (reasons.length) return { metric, label: 'INSUFFICIENT_SAMPLE', delta_pp: pp(latest?.[shareKey] ?? null, prior?.[shareKey] ?? null), reasons };
  const delta = pp(latest[shareKey], prior[shareKey]);
  const perGamePrior = prior.player[countKey] / prior.games;
  if (delta >= R.delta_pp && latest.player[countKey] >= R.expand_min_latest) return { metric, label: 'EXPANDING', delta_pp: delta, reasons: [] };
  if (delta <= -R.delta_pp && perGamePrior >= R.decline_min_prior_per_game) return { metric, label: 'DECLINING', delta_pp: delta, reasons: [] };
  return { metric, label: 'STABLE', delta_pp: delta, reasons: [] };
}

const WORD = { target: 'Target', carry: 'Carry' };
const fmtPct = v => `${v.toFixed(1)}%`;
const fmtPp = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} pts`;
const weekLabel = (a) => (a.season_type === 'POST' ? `Postseason week ${a.week}` : `Week ${a.week}`);

/* Deterministic insight templates. Each one is emitted only when every input
   it quotes exists and meets its sample rule; the inputs travel with it. */
export function insights(player) {
  const out = [];
  const { latest, prior, judged, team } = player;
  if (!latest) return out;
  for (const metric of ['target', 'carry']) {
    const j = judged[metric];
    if (!j || !['EXPANDING', 'DECLINING'].includes(j.label)) continue;
    const key = metric === 'target' ? 'target_share' : 'carry_share';
    const cnt = metric === 'target' ? 't' : 'c';
    const den = metric === 'target' ? 'targets' : 'designed_runs';
    out.push({
      code: `${metric.toUpperCase()}_${j.label}`,
      text: `${WORD[metric]} share ${j.label === 'EXPANDING' ? 'rose' : 'fell'} from ${fmtPct(prior[`${key}_pct`])} to ${fmtPct(latest[`${key}_pct`])} (${fmtPp(j.delta_pp)}): ${latest.player[cnt]} of ${latest.team[den]} ${team} ${metric === 'target' ? 'targets' : 'designed runs'} in ${player.latest_label}, vs ${prior.player[cnt]} of ${prior.team[den]} over the prior ${prior.games} game${prior.games === 1 ? '' : 's'}.`,
      inputs: { metric, latest: latest[`${key}_pct`], prior: prior[`${key}_pct`], delta_pp: j.delta_pp }
    });
  }
  /* "Carry share increased, but target share remained flat." Only when the
     second metric has a real sample of its own. */
  for (const [moved, flat] of [['carry', 'target'], ['target', 'carry']]) {
    const jm = judged[moved], jf = judged[flat];
    if (!jm || !['EXPANDING', 'DECLINING'].includes(jm.label)) continue;
    if (!jf || jf.label === 'INSUFFICIENT_SAMPLE' || jf.delta_pp === null) continue;
    if (Math.abs(jf.delta_pp) > LABEL_RULES.flat_band_pp) continue;
    const flatCount = flat === 'target' ? latest.player.t + (prior?.player.t || 0) : latest.player.c + (prior?.player.c || 0);
    if (flatCount < 3) continue;
    out.push({
      code: `${moved.toUpperCase()}_MOVED_${flat.toUpperCase()}_FLAT`,
      text: `${WORD[moved]} share ${jm.label === 'EXPANDING' ? 'increased' : 'decreased'}, but ${flat} share remained flat (${fmtPp(jf.delta_pp)}).`,
      inputs: { moved, flat, moved_delta_pp: jm.delta_pp, flat_delta_pp: jf.delta_pp }
    });
  }
  const rzTeam = latest.team.rz_targets + latest.team.rz_carries;
  const rzMine = latest.player.rzt + latest.player.rzc;
  if (rzTeam >= 3 && rzMine >= 1) {
    const i5 = latest.player.i5t + latest.player.i5c;
    out.push({
      code: 'RED_ZONE_LATEST',
      text: `${rzMine} of ${team}'s ${rzTeam} red-zone opportunities in ${player.latest_label}${i5 ? `, ${i5} inside the 5` : ''}.`,
      inputs: { player: rzMine, team: rzTeam, inside_5: i5 }
    });
  }
  if (player.other_teams.length) {
    out.push({
      code: 'TEAM_CHANGE',
      text: `Also played for ${player.other_teams.map(o => o.abbr).join(', ')} this season. Shares here compare only games with ${team}.`,
      inputs: { team, other_teams: player.other_teams.map(o => o.abbr) }
    });
  }
  return out;
}

/* Build the season contract from per-game aggregates (any order, any
   duplicates: the last object per game_id wins, which is how a corrected
   nflverse file replaces an earlier one). */
export function buildRollup(gameAggs, { season, crosswalk = {}, source = {}, generatedAt = new Date().toISOString() } = {}) {
  const byId = new Map();
  for (const g of gameAggs || []) if (g?.game_id && Number(g.season) === Number(season)) byId.set(g.game_id, g);
  const all = [...byId.values()].sort(gameOrder);
  const games = all.filter(g => g.complete);
  const incomplete = all.filter(g => !g.complete).map(g => g.game_id);

  /* team -> ordered complete games */
  const teamGames = {};
  for (const g of games) for (const [abbr, t] of Object.entries(g.teams)) {
    (teamGames[abbr] ||= []).push({ game_id: g.game_id, season_type: g.season_type, week: g.week, opponent: t.opponent, home: t.home, totals: t.totals, states: t.states, players: t.players, excluded: t.excluded });
  }

  /* gsis -> appearances (a recorded target or carry) in order */
  const apps = {};
  for (const [abbr, list] of Object.entries(teamGames)) for (const tg of list) {
    for (const [gsis, p] of Object.entries(tg.players)) {
      if (!(p.t + p.c)) continue; // scramble-only rows are not target/carry appearances
      (apps[gsis] ||= []).push({ team: abbr, game_id: tg.game_id, season_type: tg.season_type, week: tg.week, opponent: tg.opponent, p, tt: tg.totals, name: p.n });
    }
  }

  let resolved = 0, unresolved = 0;
  const players = [];
  for (const [gsis, list] of Object.entries(apps)) {
    list.sort((a, b) => gameOrder({ season, ...a }, { season, ...b }));
    const last = list[list.length - 1];
    const team = last.team;
    const withTeam = list.filter(a => a.team === team);
    const teamList = teamGames[team] || [];
    const latestTeamGame = teamList[teamList.length - 1];
    const latestIsTeamLatest = latestTeamGame && latestTeamGame.game_id === last.game_id;
    const latestApp = withTeam[withTeam.length - 1];
    const priorApps = withTeam.slice(0, -1).slice(-LABEL_RULES.prior_window);
    const latest = windowSummary([latestApp]);
    const prior = priorApps.length ? windowSummary(priorApps) : null;
    const recent = windowSummary(withTeam.slice(-(LABEL_RULES.prior_window + 1)));
    const seasonWin = windowSummary(withTeam);
    const firstWeekIdx = teamList.findIndex(tg => tg.game_id === withTeam[0].game_id);
    const appeared = new Set(withTeam.map(a => a.game_id));
    const noRecorded = teamList.slice(Math.max(0, firstWeekIdx)).filter(tg => !appeared.has(tg.game_id)).map(tg => ({ game_id: tg.game_id, week: tg.week, season_type: tg.season_type, opponent: tg.opponent }));
    const judged = { target: judge('target', latest, prior), carry: judge('carry', latest, prior) };
    const primary = seasonWin.player.t >= seasonWin.player.c ? 'target' : 'carry';
    let label = judged[primary].label;
    const notes = [];
    if (!latestIsTeamLatest && latestTeamGame) {
      label = 'INSUFFICIENT_SAMPLE';
      notes.push({ code: 'NO_RECORDED_OPPORTUNITY_LATEST', text: `No target or carry recorded in ${team}'s ${weekLabel(latestTeamGame)} game — the play-by-play cannot tell inactive from unused, so it is not scored as 0%.` });
    }
    const espn = crosswalk[gsis] || null;
    if (espn) resolved++; else unresolved++;
    const others = [...new Set(list.filter(a => a.team !== team).map(a => a.team))].map(t => ({ abbr: t, window: windowSummary(list.filter(a => a.team === t)) }));
    const row = {
      gsis_id: gsis,
      espn_id: espn,
      identity: espn ? 'RESOLVED' : 'UNRESOLVED',
      pbp_name: last.name || withTeam.find(a => a.name)?.name || null,
      team,
      primary_metric: primary,
      label,
      judged,
      latest_label: weekLabel(latestApp),
      latest_game: { game_id: latestApp.game_id, week: latestApp.week, season_type: latestApp.season_type, opponent: latestApp.opponent },
      latest,
      prior,
      recent,
      season: seasonWin,
      other_teams: others,
      no_recorded_games: noRecorded,
      notes,
      series: withTeam.map(a => ({ w: a.week, st: a.season_type, g: a.game_id, o: a.opponent, t: a.p.t, tt: a.tt.targets, c: a.p.c, tc: a.tt.designed_runs, rz: a.p.rzt + a.p.rzc, trz: a.tt.rz_targets + a.tt.rz_carries }))
    };
    row.insights = insights(row);
    players.push(row);
  }
  players.sort((a, b) => (b.season.player.t + b.season.player.c) - (a.season.player.t + a.season.player.c) || a.gsis_id.localeCompare(b.gsis_id));

  const lastGame = games[games.length - 1] || null;
  const throughWeek = lastGame ? { season_type: lastGame.season_type, week: lastGame.week } : null;
  const highlights = players
    .filter(p => ['EXPANDING', 'DECLINING'].includes(p.label) && p.identity === 'RESOLVED' && throughWeek && p.latest_game.week === throughWeek.week && p.latest_game.season_type === throughWeek.season_type)
    .sort((a, b) => Math.abs(b.judged[b.primary_metric].delta_pp) - Math.abs(a.judged[a.primary_metric].delta_pp) || a.gsis_id.localeCompare(b.gsis_id))
    .slice(0, LABEL_RULES.highlight_limit)
    .map(p => p.gsis_id);

  const teams = {};
  for (const [abbr, list] of Object.entries(teamGames)) teams[abbr] = teamSeason(abbr, list, crosswalk);

  return {
    contract: CONTRACT,
    version: OPPORTUNITY_VERSION,
    metric_version: METRIC_VERSION,
    label_version: LABEL_VERSION,
    state_version: STATE_VERSION,
    season: Number(season),
    generated_at: generatedAt,
    source,
    data_through: lastGame ? { game_id: lastGame.game_id, season_type: lastGame.season_type, week: lastGame.week, games: games.length } : null,
    coverage: {
      games_ingested: all.length,
      games_complete: games.length,
      games_incomplete: incomplete,
      weeks: [...new Set(games.map(g => `${g.season_type}:${g.week}`))],
      game_ids: games.map(g => g.game_id),
      identity: { resolved, unresolved }
    },
    definitions: DEFINITIONS,
    rules: LABEL_RULES,
    unsupported: UNSUPPORTED,
    highlights,
    players,
    teams
  };
}

/* Team season: distribution of opportunities among teammates, and the
   game-state splits Game Script Lab reads. Shares divide by the team's own
   totals over all of its games, so the parts plus the unattributed remainder
   add back to the whole. */
export function teamSeason(abbr, list, crosswalk = {}) {
  const totals = emptyTotals();
  const states = { leading: emptyState(), trailing: emptyState(), balanced: emptyState(), unknown: emptyState() };
  const excluded = {};
  const per = {};
  for (const tg of list) {
    for (const k of Object.keys(totals)) totals[k] += tg.totals[k] || 0;
    for (const s of Object.keys(states)) for (const k of Object.keys(states[s])) states[s][k] += tg.states[s]?.[k] || 0;
    for (const [k, v] of Object.entries(tg.excluded || {})) excluded[k] = (excluded[k] || 0) + v;
    for (const [gsis, p] of Object.entries(tg.players)) {
      const row = (per[gsis] ||= { gsis_id: gsis, espn_id: crosswalk[gsis] || null, pbp_name: p.n, games: 0, t: 0, c: 0, sc: 0, rzt: 0, rzc: 0, i10t: 0, i10c: 0, i5t: 0, i5c: 0, st: { leading: { t: 0, c: 0 }, trailing: { t: 0, c: 0 }, balanced: { t: 0, c: 0 }, unknown: { t: 0, c: 0 } } });
      if (p.t + p.c) row.games++;
      for (const k of sumKeys) row[k] += p[k] || 0;
      for (const [s, v] of Object.entries(p.st || {})) { row.st[s].t += v.t || 0; row.st[s].c += v.c || 0; }
    }
  }
  const players = Object.values(per).filter(p => p.t + p.c + p.sc > 0).map(p => ({
    ...p,
    target_share: ratio(p.t, totals.targets),
    carry_share: ratio(p.c, totals.designed_runs),
    rz_share: ratio(p.rzt + p.rzc, totals.rz_targets + totals.rz_carries)
  })).sort((a, b) => (b.t + b.c) - (a.t + a.c) || a.gsis_id.localeCompare(b.gsis_id));
  return {
    team: abbr,
    games: list.map(tg => ({ game_id: tg.game_id, week: tg.week, season_type: tg.season_type, opponent: tg.opponent, home: tg.home, totals: tg.totals, states: tg.states })),
    totals,
    states,
    excluded,
    players,
    residual: { untargeted_attempts: totals.untargeted_attempts, unattributed_runs: totals.unattributed_runs }
  };
}

/* ---- read-side slicing ----------------------------------------------------- */

/* The radar view is the browser payload, so each player row is compact:
   counts with their team denominators and the shares derived from them, per
   window. Field names are documented in docs/nfl-product-depth-v2.md. */
function win(w, { withZones = false } = {}) {
  if (!w) return null;
  const P = w.player, T = w.team;
  const out = {
    games: w.games, weeks: w.weeks,
    t: P.t, tt: T.targets, c: P.c, tc: T.designed_runs,
    rz: P.rzt + P.rzc, trz: T.rz_targets + T.rz_carries,
    ts: w.target_share_pct, cs: w.carry_share_pct, rs: w.rz_share_pct
  };
  if (withZones) Object.assign(out, { rzt: P.rzt, rzc: P.rzc, i10: P.i10t + P.i10c, ti10: T.i10_targets + T.i10_carries, i5: P.i5t + P.i5c, ti5: T.i5_targets + T.i5_carries, sc: P.sc });
  return out;
}
export function radarRow(p) {
  return {
    gsis: p.gsis_id,
    espn: p.espn_id,
    identity: p.identity,
    name: p.pbp_name,
    team: p.team,
    label: p.label,
    metric: p.primary_metric,
    latest_game: p.latest_game,
    latest_label: p.latest_label,
    latest: win(p.latest, { withZones: true }),
    prior: win(p.prior),
    recent: win(p.recent),
    season: win(p.season, { withZones: true }),
    delta: {
      ts: pp(p.latest.target_share, p.prior ? p.prior.target_share : null),
      cs: pp(p.latest.carry_share, p.prior ? p.prior.carry_share : null),
      rs: pp(p.latest.rz_share, p.prior ? p.prior.rz_share : null)
    },
    judged: p.judged,
    insights: p.insights.map(i => ({ code: i.code, text: i.text })),
    notes: p.notes,
    other_teams: p.other_teams.map(o => ({ team: o.abbr, games: o.window.games, t: o.window.player.t, tt: o.window.team.targets, c: o.window.player.c, tc: o.window.team.designed_runs })),
    no_recorded: p.no_recorded_games.map(g => ({ week: g.week, st: g.season_type, opp: g.opponent })),
    series: p.series
  };
}

export function radarView(rollup, { team = null } = {}) {
  const T = team ? String(team).toUpperCase() : null;
  const players = (T ? rollup.players.filter(p => p.team === T) : rollup.players).map(radarRow);
  const distribution = {};
  for (const [abbr, t] of Object.entries(rollup.teams)) {
    if (T && abbr !== T) continue;
    distribution[abbr] = {
      games: t.games.length,
      totals: pick(t.totals, ['targets', 'designed_runs', 'rz_targets', 'rz_carries', 'i10_targets', 'i10_carries', 'i5_targets', 'i5_carries', 'untargeted_attempts', 'unattributed_runs', 'scrambles', 'dropbacks', 'attempts', 'sacks']),
      players: t.players.map(p => ({ gsis: p.gsis_id, espn: p.espn_id, name: p.pbp_name, games: p.games, t: p.t, c: p.c, sc: p.sc, rz: p.rzt + p.rzc, i5: p.i5t + p.i5c }))
    };
  }
  const { teams: _t, players: _p, ...head } = rollup;
  return { ...head, view: 'radar', team: T, players, distribution };
}

export function scriptView(rollup, team) {
  const T = String(team || '').toUpperCase();
  const t = rollup.teams[T];
  const { teams: _t, players: _p, highlights: _h, ...head } = rollup;
  if (!t) return { ...head, view: 'script', team: T, available: false, reason: 'NO_COMPLETED_GAMES' };
  return { ...head, view: 'script', team: T, available: true, script: { team: T, games: t.games.length, totals: t.totals, states: t.states, excluded: t.excluded, players: t.players.map(p => pick(p, ['gsis_id', 'espn_id', 'pbp_name', 't', 'c', 'sc', 'st'])) } };
}

function pick(o, keys) { const out = {}; for (const k of keys) out[k] = o[k]; return out; }
