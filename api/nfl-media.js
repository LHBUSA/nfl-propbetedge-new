import { headshotUrl, teamLogoUrl } from './_qbdna/media.js';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const kind = String(req.query?.kind || 'player').toLowerCase();
  const name = String(req.query?.name || '').trim();
  const espnId = String(req.query?.espn_id || '').replace(/[^0-9]/g, '');
  const abbr = String(req.query?.abbr || '').replace(/[^A-Za-z]/g, '');

  /* IDENTITY-SAFE PATH (additive).
     When a caller already holds a stable ESPN id there is nothing to search
     for, and searching would only introduce the risk of returning a different
     person's face. The same is true of a team abbreviation. These branches
     short-circuit before any name matching happens. */
  if (kind === 'player' && espnId) {
    const image = headshotUrl(espnId);
    if (!image) return res.status(404).json({ error: 'No NFL image found.' });
    return res.status(200).json({
      kind: 'player', name: name || null, id: espnId, image,
      source: 'ESPN', resolved_by: 'espn_athlete_id'
    });
  }
  if (kind === 'team' && abbr) {
    const image = teamLogoUrl(abbr);
    if (!image) return res.status(404).json({ error: 'No NFL image found.' });
    return res.status(200).json({
      kind: 'team', name: name || null, abbreviation: abbr.toUpperCase(), image,
      source: 'ESPN', resolved_by: 'team_abbreviation'
    });
  }

  if (!['player', 'team'].includes(kind) || !name || name.length > 100) {
    return res.status(400).json({ error: 'Invalid kind or name.' });
  }

  try {
    const media = kind === 'team' ? await resolveTeam(name) : await resolvePlayer(name);
    if (!media?.image) return res.status(404).json({ error: 'No NFL image found.' });
    return res.status(200).json(media);
  } catch (error) {
    console.warn('[nfl-media] lookup failed:', error?.message || error);
    return res.status(404).json({ error: 'No NFL image found.' });
  }
}

async function resolveTeam(query) {
  const response = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=100', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`ESPN teams ${response.status}`);
  const data = await response.json();
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams?.map((entry) => entry?.team || entry).filter(Boolean) || [];
  const team = bestNamedMatch(teams, query, ['displayName', 'shortDisplayName', 'name', 'location', 'abbreviation']);
  if (!team) return null;
  const abbreviation = String(team.abbreviation || '').toUpperCase();
  return {
    kind: 'team',
    name: team.displayName || team.shortDisplayName || query,
    abbreviation,
    image: firstImage(team) || logoFromAbbreviation(abbreviation),
    source: 'ESPN',
  };
}

async function resolvePlayer(query) {
  const searchUrl = new URL('https://site.web.api.espn.com/apis/search/v2');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('limit', '25');
  searchUrl.searchParams.set('sport', 'football');

  const response = await fetch(searchUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`ESPN search ${response.status}`);
  const data = await response.json();
  const objects = [];
  walkObjects(data, objects, 0);
  const candidate = pickPlayerCandidate(objects, query);
  if (!candidate) return null;

  const id = extractId(candidate);
  const image = firstImage(candidate) || headshotUrl(id);
  if (!image) return null;

  return {
    kind: 'player',
    name: bestLabel(candidate) || query,
    id: id || null,
    image,
    source: 'ESPN',
  };
}

// one builder, shared with the QB DNA routes - see api/_qbdna/media.js
function logoFromAbbreviation(abbreviation) {
  return teamLogoUrl(abbreviation);
}

function pickPlayerCandidate(objects, query) {
  const q = normalize(query);
  let best = null;
  let bestScore = -Infinity;

  for (const obj of objects) {
    const label = bestLabel(obj);
    if (!label) continue;
    const value = normalize(label);
    if (!value) continue;

    const exact = value === q;
    const overlap = tokenOverlap(q, value);
    const context = normalize([
      obj.type,
      obj.typeName,
      obj.contentType,
      obj.category,
      obj.subtitle,
      obj.description,
      obj.uid,
      obj.href,
      obj.url,
      obj.link?.href,
    ].filter(Boolean).join(' '));

    const athleteLike = context.includes('athlete') || context.includes('player') || context.includes('nfl player');
    const editorialLike = ['article','story','news','video','topic','award','headline','recap'].some(token => context.includes(token));

    /* A player image must be identity-safe. We only accept an exact name match,
     * or a very strong fuzzy match that is explicitly player/athlete shaped.
     * This prevents names such as Walter Payton from resolving to articles
     * about the Walter Payton Man of the Year award. */
    if (!exact && !(athleteLike && overlap >= 0.8)) continue;
    if (editorialLike && !athleteLike) continue;

    let score = exact ? 100 : overlap * 70;
    if (athleteLike) score += 45;
    if (editorialLike) score -= 70;
    if (extractId(obj)) score += 10;
    if (firstImage(obj)) score += 10;

    if (score > bestScore) {
      bestScore = score;
      best = obj;
    }
  }

  return bestScore >= 100 ? best : null;
}

function bestNamedMatch(items, query, fields) {
  const q = normalize(query);
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    let local = 0;
    for (const field of fields) {
      const raw = item?.[field];
      if (!raw) continue;
      const value = normalize(raw);
      if (value === q) local = Math.max(local, 100);
      else if (value.includes(q) || q.includes(value)) local = Math.max(local, 65);
      else local = Math.max(local, tokenOverlap(q, value) * 45);
    }
    if (local > bestScore) {
      bestScore = local;
      best = item;
    }
  }
  return bestScore >= 20 ? best : null;
}

function walkObjects(value, output, depth) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  output.push(value);
  for (const child of Object.values(value)) walkObjects(child, output, depth + 1);
}

function bestLabel(obj) {
  return obj?.displayName || obj?.fullName || obj?.name || obj?.title || obj?.shortName || obj?.label || '';
}

function firstImage(obj) {
  return [
    obj?.headshot?.href,
    typeof obj?.headshot === 'string' ? obj.headshot : null,
    obj?.image?.href,
    typeof obj?.image === 'string' ? obj.image : null,
    obj?.logo,
    obj?.logos?.[0]?.href,
    obj?.images?.[0]?.href,
    obj?.images?.[0]?.url,
  ].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || null;
}

function extractId(obj) {
  const raw = obj?.id;
  if (raw != null && /^\d+$/.test(String(raw))) return String(raw);
  const text = [obj?.uid, obj?.guid, obj?.link?.href, obj?.href, obj?.url].filter(Boolean).join(' ');
  const match = text.match(/(?:~a:|\/id\/|athletes\/)(\d{2,})/i) || text.match(/\b(\d{4,})\b/);
  return match?.[1] || null;
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlap(a, b) {
  const aa = new Set(a.split(/\s+/).filter(Boolean));
  const bb = new Set(b.split(/\s+/).filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap += 1;
  return overlap / Math.max(aa.size, bb.size);
}
