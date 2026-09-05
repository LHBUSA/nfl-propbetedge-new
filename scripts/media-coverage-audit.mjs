/* Hard gate: do we have a REAL image for every identity QB DNA will render?
 *
 *   node scripts/media-coverage-audit.mjs [outJson]
 *
 * Headshots are built from the STABLE ESPN ATHLETE ID, never from a name
 * search. Team logos are built from the team abbreviation. Every URL is then
 * exercised with a real request — a constructed URL that 404s is a failure,
 * not coverage.
 *
 * A failure is reported with its exact reason. Nothing is hidden behind a
 * placeholder, and no fallback mark is counted as a resolved image.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { headshotUrl, teamLogoUrl } from '../api/_qbdna/media.js';

const OUT = process.argv[2] || 'data/dist/media-coverage.json';
const CONCURRENCY = 8;

async function head(url) {
  // some CDNs answer HEAD differently from GET, so a failed HEAD is retried
  // as a ranged GET before it is called a failure
  for (const init of [{ method: 'HEAD' }, { method: 'GET', headers: { range: 'bytes=0-256' } }]) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      const r = await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' });
      clearTimeout(t);
      const type = r.headers.get('content-type') || '';
      const len = Number(r.headers.get('content-length') || 0);
      if (r.ok && /^image\//.test(type)) return { ok: true, status: r.status, type, bytes: len };
      if (r.ok) return { ok: false, status: r.status, type, reason: `not an image (${type})` };
      if (init.method === 'GET') return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
    } catch (e) {
      if (init.method === 'GET') return { ok: false, status: null, reason: String(e.message).slice(0, 80) };
    }
  }
  return { ok: false, status: null, reason: 'unreachable' };
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const audit = JSON.parse(readFileSync('data/dist/active-qbs-2026.json', 'utf8'));
const venues = JSON.parse(readFileSync('data/dist/nfl-venues.json', 'utf8'));

/* ---- quarterbacks ------------------------------------------------------- */
// one row per identity; a QB on two roster buckets is audited once
const seen = new Map();
for (const q of audit.quarterbacks) {
  const key = q.gsis_id || `name:${q.name}`;
  if (!seen.has(key)) seen.set(key, q);
  else if (q.market_priced) seen.set(key, { ...seen.get(key), market_priced: true });
}
const qbs = [...seen.values()];

const qbRows = await pool(qbs, async q => {
  const url = q.espn_id ? headshotUrl(q.espn_id) : null;
  const check = url ? await head(url) : { ok: false, reason: 'no ESPN athlete id on this identity' };
  return {
    name: q.name, team: q.team, gsis_id: q.gsis_id, espn_id: q.espn_id,
    market_priced: Boolean(q.market_priced), roster_bucket: q.roster_bucket,
    headshot_url: url, ...check
  };
});

/* ---- teams -------------------------------------------------------------- */
const teams = Object.keys(venues.teams).sort();
const teamRows = await pool(teams, async abbr => {
  const url = teamLogoUrl(abbr);
  const check = url ? await head(url) : { ok: false, reason: 'no abbreviation' };
  return { abbr, name: venues.teams[abbr].venue, logo_url: url, ...check };
});

/* ---- report ------------------------------------------------------------- */
const priced = qbRows.filter(r => r.market_priced);
const summary = {
  generated_at: new Date().toISOString(),
  quarterbacks: {
    total_identities: qbRows.length,
    espn_id_available: qbRows.filter(r => r.espn_id).length,
    headshot_url_built: qbRows.filter(r => r.headshot_url).length,
    headshot_http_valid: qbRows.filter(r => r.ok).length,
    no_photo_found: qbRows.filter(r => !r.ok).length
  },
  market_priced_starters: {
    total: priced.length,
    espn_id_available: priced.filter(r => r.espn_id).length,
    headshot_http_valid: priced.filter(r => r.ok).length,
    failures: priced.filter(r => !r.ok).map(r => ({ name: r.name, team: r.team,
      espn_id: r.espn_id, reason: r.reason, status: r.status }))
  },
  teams: {
    total: teamRows.length,
    logo_http_valid: teamRows.filter(r => r.ok).length,
    failures: teamRows.filter(r => !r.ok).map(r => ({ abbr: r.abbr, reason: r.reason }))
  },
  all_failures: qbRows.filter(r => !r.ok).map(r => ({
    name: r.name, team: r.team, bucket: r.roster_bucket, espn_id: r.espn_id,
    market_priced: r.market_priced, reason: r.reason, status: r.status
  }))
};

writeFileSync(OUT, JSON.stringify({ summary, quarterbacks: qbRows, teams: teamRows }, null, 2));

const Q = summary.quarterbacks, P = summary.market_priced_starters, T = summary.teams;
console.log('=== HEADSHOT COVERAGE ===');
console.log(`  total roster identities   ${Q.total_identities}`);
console.log(`  ESPN athlete id available ${Q.espn_id_available}`);
console.log(`  headshot URL built        ${Q.headshot_url_built}`);
console.log(`  headshot HTTP valid       ${Q.headshot_http_valid}`);
console.log(`  no photo found            ${Q.no_photo_found}`);
console.log(`\n  MARKET-PRICED STARTERS    ${P.headshot_http_valid}/${P.total}`);
for (const f of P.failures) console.log(`    FAIL ${f.name} (${f.team}) espn=${f.espn_id}: ${f.reason}`);
console.log('\n=== TEAM LOGO COVERAGE ===');
console.log(`  logos HTTP valid          ${T.logo_http_valid}/${T.total}`);
for (const f of T.failures) console.log(`    FAIL ${f.abbr}: ${f.reason}`);
if (summary.all_failures.length) {
  console.log('\n=== EVERY IDENTITY WITH NO REAL IMAGE ===');
  for (const f of summary.all_failures) {
    console.log(`  ${f.name} · ${f.team || '—'} · ${f.bucket} · espn=${f.espn_id || 'none'}`
      + `${f.market_priced ? ' · MARKET-PRICED' : ''} -> ${f.reason}`);
  }
}
console.log(`\nwrote ${OUT}`);
process.exitCode = (P.headshot_http_valid === P.total && T.logo_http_valid === T.total) ? 0 : 1;
