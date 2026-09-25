/* nfl-my-sunday — saved research + in-app alerts (pbe-my-sunday/v1).
 *
 * INTERNAL ONLY. Every route requires `Authorization: Bearer
 * MY_SUNDAY_INTERNAL_TOKEN` and an `x-pbe-owner` key; only the Vercel session
 * boundary (api/my-sunday.js) holds the token, and it derives the owner key
 * from the verified session. Nothing here can be reached by a browser with a
 * cookie, and nothing here ever sees an email address.
 *
 *   GET    /v1/items                      items + alerts for the owner
 *   POST   /v1/items                      save one item (idempotent)
 *   POST   /v1/items/delete   {item_key}  remove one item (+ its alerts)
 *   POST   /v1/import         {items:[]}  explicit, validated device import
 *   POST   /v1/alerts/read    {ids:[]}    mark alerts read
 *   GET    /health
 *
 * Every statement binds owner_key from the header. D1 has no row-level
 * security and this binding is privileged, so ownership is enforced in each
 * query, not assumed.
 *
 * Alerts: refreshAlerts() reads nfl-intel's shared change ledger once and the
 * odds snapshot once per saved prop event, for everyone, at most every
 * REFRESH_MS — on the cron in production, or on a read when the last run is
 * older (the preview has no cron). No upstream provider is ever polled per
 * user, and a failed read writes no alert.
 */
import { VERSION, CONTRACT, MAX_ITEMS, MAX_IMPORT, validateItem, matchIntel, propAlert, publicItem } from './core.js';

const REFRESH_MS = 10 * 60 * 1000;
const OWNER_RX = /^[a-f0-9]{64}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-pbe-runtime': VERSION } });
}

function authorized(req, env) {
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const want = String(env.MY_SUNDAY_INTERNAL_TOKEN || '');
  if (!want || token.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return d === 0;
}

async function body(req, max = 32768) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error('body_too_large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch (_) { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}

const COLS = ['item_type', 'season', 'event_id', 'odds_event_id', 'player_espn_id', 'player_gsis_id', 'team', 'market', 'side', 'saved_line', 'saved_price', 'saved_book', 'market_captured_at', 'pick_ref', 'label'];

export async function listItems(db, owner) {
  const { results } = await db.prepare('SELECT * FROM saved_items WHERE owner_key = ?1 ORDER BY saved_at DESC LIMIT ?2').bind(owner, MAX_ITEMS).all();
  return results || [];
}

/* Insert once; a repeated save returns the stored original untouched. */
export async function saveItem(db, owner, item, now = new Date().toISOString()) {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM saved_items WHERE owner_key = ?1').bind(owner).first();
  const existing = await db.prepare('SELECT * FROM saved_items WHERE owner_key = ?1 AND item_key = ?2').bind(owner, item.item_key).first();
  if (existing) return { created: false, item: publicItem(existing) };
  if ((count?.n || 0) >= MAX_ITEMS) return { error: 'limit_reached', status: 409 };
  const values = COLS.map(c => (item[c] === undefined ? null : item[c]));
  await db.prepare(`INSERT OR IGNORE INTO saved_items (owner_key, item_key, ${COLS.join(', ')}, context, saved_at) VALUES (?1, ?2, ${COLS.map((_, i) => `?${i + 3}`).join(', ')}, ?${COLS.length + 3}, ?${COLS.length + 4})`)
    .bind(owner, item.item_key, ...values, JSON.stringify(item.context || {}), now).run();
  const row = await db.prepare('SELECT * FROM saved_items WHERE owner_key = ?1 AND item_key = ?2').bind(owner, item.item_key).first();
  return { created: true, item: publicItem(row) };
}

export async function deleteItem(db, owner, itemKey) {
  const r = await db.prepare('DELETE FROM saved_items WHERE owner_key = ?1 AND item_key = ?2').bind(owner, itemKey).run();
  await db.prepare('DELETE FROM alerts WHERE owner_key = ?1 AND item_key = ?2').bind(owner, itemKey).run();
  return { deleted: (r?.meta?.changes || 0) > 0 };
}

export async function listAlerts(db, owner) {
  const { results } = await db.prepare('SELECT alert_id, item_key, kind, payload, observed_at, first_seen_at, read_at FROM alerts WHERE owner_key = ?1 ORDER BY observed_at DESC LIMIT 100').bind(owner).all();
  return (results || []).map(a => { let payload = {}; try { payload = JSON.parse(a.payload); } catch (_) {} return { ...a, payload }; });
}

async function lane(db, name) {
  return db.prepare('SELECT lane, ran_at, ok, detail FROM refresh_state WHERE lane = ?1').bind(name).first();
}
async function mark(db, name, ok, detail, now) {
  await db.prepare('INSERT INTO refresh_state (lane, ran_at, ok, detail) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(lane) DO UPDATE SET ran_at = excluded.ran_at, ok = excluded.ok, detail = excluded.detail').bind(name, now, ok ? 1 : 0, String(detail || '').slice(0, 300)).run();
}

async function insertAlerts(db, rows, ownersByKey, now) {
  let n = 0;
  for (const a of rows) for (const owner of ownersByKey.get(a._row) || []) {
    const r = await db.prepare('INSERT OR IGNORE INTO alerts (owner_key, alert_id, item_key, kind, payload, observed_at, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(owner, a.alert_id, a.item_key, a.kind, JSON.stringify(a.payload), a.observed_at, now).run();
    n += r?.meta?.changes || 0;
  }
  return n;
}

/* One shared refresh for all owners. `fetchers` are injectable for tests. */
export async function refreshAlerts(env, { now = new Date().toISOString(), fetchChanges, fetchBoard } = {}) {
  const db = env.DB;
  fetchChanges ||= async () => {
    const r = await env.NFL_INTEL.fetch(new Request('https://nfl-intel.internal/api/changes?window_hours=168', { headers: { accept: 'application/json' } }));
    if (!r.ok) throw new Error(`nfl_intel_${r.status}`);
    return r.json();
  };
  fetchBoard ||= async (oddsEventId, markets) => {
    const r = await env.NFL_ODDS.fetch(new Request(`https://nfl-odds.internal/api/odds/board?event_id=${encodeURIComponent(oddsEventId)}&markets=${encodeURIComponent(markets.join(','))}`, { headers: { accept: 'application/json' } }));
    if (!r.ok) throw new Error(`nfl_odds_${r.status}`);
    return r.json();
  };
  const { results } = await db.prepare('SELECT * FROM saved_items').all();
  const rows = results || [];
  /* Match once per distinct (item_key, saved_at) and fan out to owners. */
  const byItem = new Map(), owners = new Map();
  for (const r of rows) {
    const k = `${r.item_key}|${r.saved_at}`;
    if (!byItem.has(k)) byItem.set(k, { ...r, _row: k });
    (owners.get(k) || owners.set(k, []).get(k)).push(r.owner_key);
  }
  const items = [...byItem.values()];
  const summary = { items: items.length, intel: null, props: null };

  try {
    const payload = await fetchChanges();
    /* Match per distinct item row so each alert keeps the row (and so the
       owners) it belongs to. */
    const tagged = [];
    for (const it of items) for (const a of matchIntel([it], payload)) tagged.push({ ...a, _row: it._row });
    summary.intel = { ok: true, matched: tagged.length, inserted: await insertAlerts(db, tagged, owners, now), sources: Object.fromEntries(Object.entries(payload.sources || {}).map(([k, v]) => [k, v?.available === true])) };
    await mark(db, 'intel', true, JSON.stringify(summary.intel.sources), now);
  } catch (error) {
    summary.intel = { ok: false, error: String(error?.message || error) };
    await mark(db, 'intel', false, summary.intel.error, now);
  }

  const props = items.filter(i => i.item_type === 'prop' && i.odds_event_id);
  const events = [...new Set(props.map(p => p.odds_event_id))];
  const propSummary = { events: events.length, ok: 0, failed: 0, inserted: 0 };
  for (const ev of events) {
    const list = props.filter(p => p.odds_event_id === ev);
    try {
      const board = await fetchBoard(ev, [...new Set(list.map(p => p.market))]);
      const parsed = list.map(p => { let context = {}; try { context = JSON.parse(p.context || '{}'); } catch (_) {} return { ...p, context }; });
      const found = parsed.map(p => { const a = propAlert(p, board); return a ? { ...a, _row: p._row } : null; }).filter(Boolean);
      propSummary.inserted += await insertAlerts(db, found, owners, now);
      propSummary.ok++;
    } catch (_) { propSummary.failed++; }
  }
  summary.props = propSummary;
  await mark(db, 'props', propSummary.failed === 0, JSON.stringify(propSummary), now);
  await mark(db, 'refresh', true, JSON.stringify({ items: items.length }), now);
  return summary;
}

async function maybeRefresh(env, ctx) {
  const last = await lane(env.DB, 'refresh');
  const age = last ? Date.now() - Date.parse(last.ran_at) : Infinity;
  if (age < REFRESH_MS) return;
  /* Claim the slot first so concurrent readers do not all refresh. */
  await mark(env.DB, 'refresh', true, 'claimed', new Date().toISOString());
  const run = refreshAlerts(env).catch(e => console.log('[nfl-my-sunday] refresh failed', String(e?.message || e)));
  if (ctx?.waitUntil) ctx.waitUntil(run); else await run;
}

async function state(env) {
  const [intel, props] = await Promise.all([lane(env.DB, 'intel'), lane(env.DB, 'props')]);
  return {
    alerts_state: !intel ? 'NOT_YET_RUN' : intel.ok ? 'READY' : 'SOURCE_UNAVAILABLE',
    intel_checked_at: intel?.ran_at || null,
    props_checked_at: props?.ran_at || null
  };
}

export async function handle(req, env, ctx) {
  const url = new URL(req.url);
  if (url.pathname === '/health') return json({ service: 'nfl-my-sunday', version: VERSION, contract: CONTRACT, ...(await state(env).catch(() => ({}))) });
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
  const owner = String(req.headers.get('x-pbe-owner') || '');
  if (!OWNER_RX.test(owner)) return json({ error: 'owner_required' }, 400);
  const db = env.DB;
  try {
    if (url.pathname === '/v1/items' && req.method === 'GET') {
      await maybeRefresh(env, ctx);
      const [items, alerts, st] = await Promise.all([listItems(db, owner), listAlerts(db, owner), state(env)]);
      return json({ contract: CONTRACT, version: VERSION, items: items.map(publicItem), alerts, ...st });
    }
    if (url.pathname === '/v1/items' && req.method === 'POST') {
      const v = validateItem((await body(req)).item);
      if (!v.ok) return json({ error: v.error }, 422);
      const r = await saveItem(db, owner, v.item);
      if (r.error) return json({ error: r.error }, r.status);
      return json({ contract: CONTRACT, ...r }, r.created ? 201 : 200);
    }
    if (url.pathname === '/v1/items/delete' && req.method === 'POST') {
      const key = String((await body(req)).item_key || '');
      if (!key || key.length > 200) return json({ error: 'item_key_required' }, 422);
      return json({ contract: CONTRACT, ...(await deleteItem(db, owner, key)) });
    }
    if (url.pathname === '/v1/import' && req.method === 'POST') {
      const list = (await body(req, 65536)).items;
      if (!Array.isArray(list) || !list.length) return json({ error: 'items_required' }, 422);
      if (list.length > MAX_IMPORT) return json({ error: 'too_many_items', max: MAX_IMPORT }, 422);
      const results = [];
      for (const raw of list) {
        const v = validateItem(raw);
        if (!v.ok) { results.push({ ok: false, error: v.error }); continue; }
        const r = await saveItem(db, owner, v.item);
        results.push(r.error ? { ok: false, error: r.error } : { ok: true, created: r.created, item_key: v.item.item_key });
      }
      return json({ contract: CONTRACT, imported: results.filter(r => r.ok && r.created).length, already_saved: results.filter(r => r.ok && !r.created).length, rejected: results.filter(r => !r.ok).length, results });
    }
    if (url.pathname === '/v1/alerts/read' && req.method === 'POST') {
      const ids = (await body(req)).ids;
      if (!Array.isArray(ids) || ids.length > 100) return json({ error: 'ids_required' }, 422);
      const now = new Date().toISOString();
      let n = 0;
      for (const id of ids) {
        if (typeof id !== 'string' || id.length > 300) continue;
        const r = await db.prepare('UPDATE alerts SET read_at = ?1 WHERE owner_key = ?2 AND alert_id = ?3 AND read_at IS NULL').bind(now, owner, id).run();
        n += r?.meta?.changes || 0;
      }
      return json({ contract: CONTRACT, marked: n });
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    return json({ error: error.status ? error.message : 'internal' }, error.status || 500);
  }
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAlerts(env).then(s => console.log('[nfl-my-sunday] refresh', JSON.stringify(s))).catch(e => console.log('[nfl-my-sunday] refresh failed', String(e?.message || e))));
  }
};
