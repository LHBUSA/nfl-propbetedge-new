/* NFL Injury Board composition — pure presentation contract over nfl-intel's
 * persisted injury rows. No I/O, no inference, and all 32 teams are always
 * present even when a team has zero current reported entries.
 */
export const TEAM_DIRECTORY = [
  ['1','ATL','Atlanta Falcons','NFC','South'], ['2','BUF','Buffalo Bills','AFC','East'],
  ['3','CHI','Chicago Bears','NFC','North'], ['4','CIN','Cincinnati Bengals','AFC','North'],
  ['5','CLE','Cleveland Browns','AFC','North'], ['6','DAL','Dallas Cowboys','NFC','East'],
  ['7','DEN','Denver Broncos','AFC','West'], ['8','DET','Detroit Lions','NFC','North'],
  ['9','GB','Green Bay Packers','NFC','North'], ['10','TEN','Tennessee Titans','AFC','South'],
  ['11','IND','Indianapolis Colts','AFC','South'], ['12','KC','Kansas City Chiefs','AFC','West'],
  ['13','LV','Las Vegas Raiders','AFC','West'], ['14','LAR','Los Angeles Rams','NFC','West'],
  ['15','MIA','Miami Dolphins','AFC','East'], ['16','MIN','Minnesota Vikings','NFC','North'],
  ['17','NE','New England Patriots','AFC','East'], ['18','NO','New Orleans Saints','NFC','South'],
  ['19','NYG','New York Giants','NFC','East'], ['20','NYJ','New York Jets','AFC','East'],
  ['21','PHI','Philadelphia Eagles','NFC','East'], ['22','ARI','Arizona Cardinals','NFC','West'],
  ['23','PIT','Pittsburgh Steelers','AFC','North'], ['24','LAC','Los Angeles Chargers','AFC','West'],
  ['25','SF','San Francisco 49ers','NFC','West'], ['26','SEA','Seattle Seahawks','NFC','West'],
  ['27','TB','Tampa Bay Buccaneers','NFC','South'], ['28','WSH','Washington Commanders','NFC','East'],
  ['29','CAR','Carolina Panthers','NFC','South'], ['30','JAX','Jacksonville Jaguars','AFC','South'],
  ['33','BAL','Baltimore Ravens','AFC','North'], ['34','HOU','Houston Texans','AFC','South']
].map(([id,abbreviation,name,conference,division]) => ({ id, abbreviation, name, conference, division }));

const DIRECTORY = new Map(TEAM_DIRECTORY.map(team => [team.abbreviation, team]));
const STATUS_RANK = { OUT:0, DOUBTFUL:1, QUESTIONABLE:2, OTHER:3, ACTIVE:4 };

export function statusBucket(status) {
  const value = String(status || '').toUpperCase();
  if (['OUT','INJURED_RESERVE','PUP','NFI','SUSPENDED'].includes(value)) return 'OUT';
  if (value === 'DOUBTFUL') return 'DOUBTFUL';
  if (value === 'QUESTIONABLE') return 'QUESTIONABLE';
  if (value === 'ACTIVE') return 'ACTIVE';
  return 'OTHER';
}

export function injuryLabel(injury) {
  const values = [injury?.type, injury?.location, injury?.detail]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value,index,array) => array.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
  return values[0] || 'Not specified';
}

export function countStatuses(rows) {
  const counts = { total:rows.length, out:0, doubtful:0, questionable:0, active:0, other:0 };
  for (const row of rows) {
    const bucket = row.bucket || statusBucket(row.status);
    if (bucket === 'OUT') counts.out += 1;
    else if (bucket === 'DOUBTFUL') counts.doubtful += 1;
    else if (bucket === 'QUESTIONABLE') counts.questionable += 1;
    else if (bucket === 'ACTIVE') counts.active += 1;
    else counts.other += 1;
  }
  return counts;
}

function normalizeRow(row) {
  const abbreviation = String(row?.team?.abbreviation || '').toUpperCase();
  const team = DIRECTORY.get(abbreviation);
  if (!team) return null;
  const bucket = statusBucket(row.status);
  return {
    ...row,
    bucket,
    injury: { ...(row.injury || {}), label: injuryLabel(row.injury) },
    team: {
      id: String(row?.team?.id || team.id),
      abbreviation: team.abbreviation,
      name: team.name,
      conference: team.conference,
      division: team.division
    }
  };
}

function sortRows(rows) {
  return rows.sort((a,b) => {
    const status = (STATUS_RANK[a.bucket] ?? 9) - (STATUS_RANK[b.bucket] ?? 9);
    if (status) return status;
    const pos = String(a?.player?.position || '').localeCompare(String(b?.player?.position || ''));
    if (pos) return pos;
    return String(a?.player?.name || '').localeCompare(String(b?.player?.name || ''));
  });
}

export function buildInjuryBoard(rows, snapshot = {}, { now = Date.now(), staleMs = 30 * 60000 } = {}) {
  const byTeam = new Map(TEAM_DIRECTORY.map(team => [team.abbreviation, []]));
  const failedTeams = new Set((Array.isArray(snapshot?.failed_teams) ? snapshot.failed_teams : []).map(value => String(value || '').toUpperCase()));
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeRow(raw);
    if (row) byTeam.get(row.team.abbreviation).push(row);
  }

  const teams = TEAM_DIRECTORY.map(team => {
    const injuries = sortRows(byTeam.get(team.abbreviation));
    const sourceStale = failedTeams.has(team.abbreviation);
    return {
      ...team,
      logo: `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${team.abbreviation.toLowerCase()}.png`,
      source_status: sourceStale ? 'STALE_PREVIOUS_SNAPSHOT' : 'CURRENT',
      source_stale: sourceStale,
      counts: countStatuses(injuries),
      injuries
    };
  });
  const all = teams.flatMap(team => team.injuries);
  const fetchedAt = snapshot?.fetched_at || snapshot?.report?.timestamp || null;
  const fetchedMs = Date.parse(fetchedAt || '');
  const ageSeconds = Number.isFinite(fetchedMs) ? Math.max(0, Math.round((now - fetchedMs) / 1000)) : null;

  return {
    ok: true,
    semantics: 'CURRENT_REPORTED_DESIGNATIONS',
    generated_at: new Date(now).toISOString(),
    source: {
      provider: 'espn_core_api_injuries',
      fetched_at: fetchedAt,
      age_seconds: ageSeconds,
      stale: ageSeconds === null ? null : ageSeconds * 1000 > staleMs,
      partial: failedTeams.size > 0 || Number(snapshot?.record_failures || 0) > 0,
      ingested_by: 'nfl-intel cron',
      failed_teams: [...failedTeams],
      record_failures: Number(snapshot?.record_failures || 0),
      note: 'Current reported designations only. If a team refresh fails, nfl-intel retains that team’s last good entries and marks the team stale. PropBetEdge does not infer return timelines, practice participation, or game-day inactive status.'
    },
    counts: {
      teams: TEAM_DIRECTORY.length,
      teams_with_entries: teams.filter(team => team.counts.total > 0).length,
      stale_teams: teams.filter(team => team.source_stale).length,
      ...countStatuses(all)
    },
    teams
  };
}
