/* PropBetEdge NFL Picks Engine — shared Supabase (PostgREST) access.
 *
 * Header handling is ported from nfl-propbetedge-new/api/_nfl-auth.js rather
 * than reinvented: Supabase's modern sb_secret_* keys are API keys, not JWTs,
 * and must be sent on `apikey` only. Legacy service_role JWTs use both. The
 * MLB loop's always-send-Bearer form breaks the moment the key is rotated.
 *
 * Never log a key, a row payload, or a URL containing credentials.
 */

export function supabaseAdminHeaders(secret, extra = {}) {
  const key = String(secret || '').trim();
  const headers = { apikey: key, accept: 'application/json', ...extra };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return headers;
}

function baseUrl(env) {
  const url = String(env?.SUPABASE_URL || '').trim().replace(/\/$/, '');
  if (!url) throw new Error('supabase_url_missing');
  return url;
}

function requireKey(env) {
  const key = String(env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new Error('supabase_key_missing');
  return key;
}

/* Throws an error whose message carries only status + table, never body text
 * that might echo a row or a key. */
async function request(env, path, init = {}) {
  const response = await fetch(`${baseUrl(env)}/rest/v1/${path}`, {
    ...init,
    headers: supabaseAdminHeaders(requireKey(env), init.headers || {}),
    cache: 'no-store',
  });
  if (!response.ok) {
    const table = String(path).split('?')[0];
    throw new Error(`supabase_${response.status}:${table}`);
  }
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

export function select(env, table, query = '') {
  const q = query ? `?${query}` : '';
  return request(env, `${table}${q}`, { method: 'GET' });
}

/* Plain insert. Conflicts surface as supabase_409, which callers may treat as
 * "already recorded" for idempotent paths. */
export function insert(env, table, rows, { returning = 'representation' } = {}) {
  return request(env, table, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: `return=${returning}` },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

/* Upsert on an explicit conflict target. Used by the grader so a re-run
 * updates in place instead of duplicating — this is what makes grading
 * idempotent. */
export function upsert(env, table, rows, onConflict, { returning = 'representation' } = {}) {
  const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return request(env, `${table}${q}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: `resolution=merge-duplicates,return=${returning}`,
    },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

export function patch(env, table, query, values) {
  return request(env, `${table}?${query}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(values),
  });
}

/* Append-only audit trail. Never updates, never deletes. Failure to write an
 * audit row must not abort the operation being audited, but it is logged as an
 * error class so it is visible in /health. */
export async function audit(env, event) {
  try {
    await insert(env, 'nfl_pick_audit_events', {
      pick_id: event.pick_id || null,
      event_type: event.event_type,
      model_version: event.model_version ?? null,
      detail: event.detail || {},
    }, { returning: 'minimal' });
    return true;
  } catch (error) {
    console.error('[audit] failed', String(error?.message || error).slice(0, 120));
    return false;
  }
}

/* The single coupling between learning and picking: the orchestrator always
 * scores with the highest promoted version, never a challenger. */
export async function latestPromotedWeights(env) {
  const rows = await select(
    env,
    'nfl_model_weights',
    'promoted=is.true&select=version,weights,notes&order=version.desc&limit=1',
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error('no_promoted_model');
  return row;
}
