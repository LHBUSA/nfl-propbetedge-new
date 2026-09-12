const UPSTREAM = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

const TEAMS = [
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
].map(([id,abbreviation,name,conference,division])=>({id,abbreviation,name,conference,division}));

const TEAM_BY_ID = new Map(TEAMS.map(team => [team.id, team]));
const TEAM_BY_ABBR = new Map(TEAMS.map(team => [team.abbreviation, team]));

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200
    ? 'public, s-maxage=300, stale-while-revalidate=900'
    : 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function iso(value) {
  const raw = clean(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeStatus(value) {
  const raw = clean(value);
  if (!raw) return 'UNKNOWN';
  const key = raw.toUpperCase().replace(/[\s/-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  if (/^(IR|INJURED_RESERVE|RESERVE_INJURED)$/.test(key)) return 'INJURED_RESERVE';
  if (/PUP/.test(key)) return 'PUP';
  if (/NON_FOOTBALL|^NFI$/.test(key)) return 'NFI';
  if (/SUSPEND/.test(key)) return 'SUSPENDED';
  if (/QUESTION/.test(key)) return 'QUESTIONABLE';
  if (/DOUBT/.test(key)) return 'DOUBTFUL';
  if (/OUT/.test(key)) return 'OUT';
  if (/ACTIVE|AVAILABLE|RETURN/.test(key)) return 'ACTIVE';
  return key || 'UNKNOWN';
}

function statusBucket(status) {
  if (['OUT','INJURED_RESERVE','PUP','NFI','SUSPENDED'].includes(status)) return 'OUT';
  if (status === 'DOUBTFUL') return 'DOUBTFUL';
  if (status === 'QUESTIONABLE') return 'QUESTIONABLE';
  if (status === 'ACTIVE') return 'ACTIVE';
  return 'OTHER';
}

function teamMeta(block, entry) {
  const athleteTeam = entry?.athlete?.team || {};
  const id = clean(athleteTeam.id || block?.id);
  const abbr = clean(athleteTeam.abbreviation || block?.abbreviation || block?.shortDisplayName || block?.displayName).toUpperCase();
  return TEAM_BY_ID.get(id) || TEAM_BY_ABBR.get(abbr) || null;
}

function playerOf(entry) {
  const athlete = entry?.athlete || {};
  return {
    id: clean(athlete.id) || null,
    name: clean(athlete.displayName || athlete.fullName || athlete.shortName) || 'Unknown player',
    short_name: clean(athlete.shortName) || null,
    position: clean(athlete?.position?.abbreviation || athlete?.position?.name) || null,
    headshot: clean(athlete?.headshot?.href) || null
  };
}

function injuryOf(entry) {
  const details = entry?.details || {};
  const pieces = [details.type, details.location, details.detail]
    .map(clean)
    .filter(Boolean)
    .filter((value, index, array) => array.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
  return {
    label: pieces[0] || clean(entry?.type?.description || entry?.type?.name) || 'Not specified',
    type: clean(details.type) || null,
    location: clean(details.location) || null,
    detail: clean(details.detail) || null,
    side: clean(details.side) && clean(details.side).toLowerCase() !== 'not specified' ? clean(details.side) : null,
    return_date: iso(details.returnDate)
  };
}

function entryRow(entry, team) {
  const rawStatus = clean(entry?.status || entry?.type?.description || entry?.type?.name) || 'Reported';
  const status = normalizeStatus(rawStatus);
  return {
    id: clean(entry?.id) || null,
    status,
    status_label: rawStatus,
    bucket: statusBucket(status),
    updated_at: iso(entry?.date),
    note: clean(entry?.shortComment) || null,
    player: playerOf(entry),
    injury: injuryOf(entry),
    team: {
      id: team.id,
      abbreviation: team.abbreviation,
      name: team.name,
      conference: team.conference,
      division: team.division
    }
  };
}

function countStatuses(rows) {
  const counts = { total: rows.length, out: 0, doubtful: 0, questionable: 0, active: 0, other: 0 };
  for (const row of rows) {
    if (row.bucket === 'OUT') counts.out += 1;
    else if (row.bucket === 'DOUBTFUL') counts.doubtful += 1;
    else if (row.bucket === 'QUESTIONABLE') counts.questionable += 1;
    else if (row.bucket === 'ACTIVE') counts.active += 1;
    else counts.other += 1;
  }
  return counts;
}

function sortRows(rows) {
  const rank = { OUT: 0, DOUBTFUL: 1, QUESTIONABLE: 2, OTHER: 3, ACTIVE: 4 };
  return rows.sort((a,b) => {
    const bucket = (rank[a.bucket] ?? 9) - (rank[b.bucket] ?? 9);
    if (bucket) return bucket;
    const pos = String(a.player.position || '').localeCompare(String(b.player.position || ''));
    if (pos) return pos;
    return String(a.player.name || '').localeCompare(String(b.player.name || ''));
  });
}

function normalizeReport(payload, fetchedAt) {
  const blocks = Array.isArray(payload?.injuries) ? payload.injuries : [];
  const rowsByTeam = new Map(TEAMS.map(team => [team.abbreviation, []]));

  for (const block of blocks) {
    for (const entry of Array.isArray(block?.injuries) ? block.injuries : []) {
      const team = teamMeta(block, entry);
      if (!team) continue;
      rowsByTeam.get(team.abbreviation).push(entryRow(entry, team));
    }
  }

  const teams = TEAMS.map(team => {
    const injuries = sortRows(rowsByTeam.get(team.abbreviation));
    return {
      ...team,
      logo: `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${team.abbreviation.toLowerCase()}.png`,
      counts: countStatuses(injuries),
      injuries
    };
  });
  const allRows = teams.flatMap(team => team.injuries);

  return {
    ok: true,
    semantics: 'CURRENT_REPORTED_DESIGNATIONS',
    generated_at: fetchedAt,
    source: {
      provider: 'espn_site_injury_report',
      fetched_at: iso(payload?.timestamp) || fetchedAt,
      upstream: UPSTREAM,
      note: 'Current reported designations only. PropBetEdge does not infer return timelines or active/inactive game-day status.'
    },
    counts: {
      teams: TEAMS.length,
      teams_with_entries: teams.filter(team => team.counts.total > 0).length,
      ...countStatuses(allRows)
    },
    teams
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const upstream = await fetch(UPSTREAM, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'PropBetEdge-NFL/1.0 (https://nfl.propbetedge.ai)'
      }
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return send(res, 502, {
        ok: false,
        error: 'injury_source_unavailable',
        upstream_status: upstream.status,
        detail: text.slice(0, 180)
      });
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { return send(res, 502, { ok: false, error: 'injury_source_invalid_json' }); }

    const board = normalizeReport(payload, new Date().toISOString());
    if (!board.counts.total && !Array.isArray(payload?.injuries)) {
      return send(res, 502, { ok: false, error: 'injury_source_shape_changed' });
    }
    return send(res, 200, board);
  } catch (error) {
    return send(res, 502, {
      ok: false,
      error: error?.name === 'AbortError' ? 'injury_source_timeout' : 'injury_source_unreachable',
      detail: String(error?.message || error)
    });
  } finally {
    clearTimeout(timer);
  }
}
