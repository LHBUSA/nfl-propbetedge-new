/* PropBetEdge NFL — auth regression suite.
 *
 * The first block is the ROOT CAUSE reproduction: a browser holding two cookies
 * named `pbe_nfl_session` (a stale `.propbetedge.ai` one created earlier and the
 * fresh host-only one) makes a first-match cookie reader return the stale value
 * forever. Run with:  node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHmac } from 'node:crypto';

process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_URL ||= 'https://supabase.test';

const {
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  HMAC_NAMESPACE,
  readCookieValues,
  sessionCookie,
  purgeCookies,
  verifyWorkerJwt,
  getNflSession,
  verifiedEmail,
} = await import('../api/_nfl-auth.js');

const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = 'justin@proptechusa.ai';

/* ---------- helpers that mirror the Worker exactly ---------- */

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = obj => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));

/* Node-crypto version, used to build fixtures cheaply. */
function signNode(payload, secret = SECRET) {
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${secret}`).update(data).digest())}`;
}

/* Byte-for-byte the Worker's WebCrypto path from workers/nfl-auth/src/index-v5.js.
 * Proves the two runtimes agree, which is what makes a single verifier safe. */
async function signWorker(payload, secret = SECRET) {
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(`${HMAC_NAMESPACE}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64u(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const freshSession = (secret = SECRET) =>
  signNode({ email: EMAIL, type: 'session', iat: now(), exp: now() + 2592000, jti: 'fresh' }, secret);
const expiredSession = () =>
  signNode({ email: EMAIL, type: 'session', iat: now() - 90 * 86400, exp: now() - 60 * 86400, jti: 'stale' });
/* v1/v4 Workers issued an opaque random token, not a JWT. */
const opaqueLegacyToken = () => 'Ux9Qa7Kd2LmT4pR8vZbN6yHwJcE1sGfA0iOnDlXkVt';

const reqWith = cookie => ({ headers: { cookie } });

function stubSupabase({ rows }) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(rows), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  return () => { globalThis.fetch = original; };
}

const ACTIVE_ROW = [{ status: 'active', current_period_end: null, cancel_at_period_end: false, stripe_price_id: 'price_x', created_at: '2026-08-01T00:00:00Z' }];

/* =====================================================================
 * ROOT CAUSE
 * ===================================================================== */

test('ROOT CAUSE: two cookies share the name pbe_nfl_session and the stale one is sent first', () => {
  const stale = opaqueLegacyToken();
  const fresh = freshSession();
  const header = `${LEGACY_SESSION_COOKIE}=${stale}; pbe_nfl_event=nfl-2026-w1; ${LEGACY_SESSION_COOKIE}=${fresh}`;

  // The old first-match reader — reproduced verbatim — picks the unusable token.
  const firstMatch = (h, name) => {
    for (const part of String(h || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return '';
  };
  assert.equal(firstMatch(header, LEGACY_SESSION_COOKIE), stale, 'old reader must reproduce the bug');
  assert.throws(() => verifyWorkerJwt(stale, SECRET), /token_shape/,
    'the stale v1/v4 cookie is opaque, so it can never verify as a v5 session');

  // The new reader sees both, so the good token is reachable.
  const all = readCookieValues(header, LEGACY_SESSION_COOKIE);
  assert.deepEqual(all, [stale, fresh]);
});

test('duplicate cookies no longer shadow a valid session', async () => {
  const restore = stubSupabase({ rows: ACTIVE_ROW });
  try {
    const header = `${LEGACY_SESSION_COOKIE}=${opaqueLegacyToken()}; ${SESSION_COOKIE}=${freshSession()}`;
    const session = await getNflSession(reqWith(header));
    assert.equal(session.valid, true);
    assert.equal(session.pro, true);
    assert.equal(session.user.email, EMAIL);
    assert.equal(session.stage, 'entitlement_active');
    assert.equal(session.cookies.legacy, 1);
    assert.equal(session.cookies.current, 1);
  } finally { restore(); }
});

test('an expired duplicate ahead of a valid one is skipped, not fatal', async () => {
  const restore = stubSupabase({ rows: ACTIVE_ROW });
  try {
    const header = `${SESSION_COOKIE}=${expiredSession()}; ${SESSION_COOKIE}=${freshSession()}`;
    const session = await getNflSession(reqWith(header));
    assert.equal(session.valid, true, 'must fall through to the second value');
    assert.equal(session.pro, true);
  } finally { restore(); }
});

/* =====================================================================
 * COOKIE SCOPE
 * ===================================================================== */

test('the authoritative session cookie is host-only, so it cannot collide with .propbetedge.ai', () => {
  const cookie = sessionCookie('token.token.token');
  assert.match(cookie, /^pbe_nfl_session_v2=/);
  assert.ok(!/Domain=/i.test(cookie), 'a Domain attribute would recreate the collision');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});

test('purge covers every historical variant, host-only and domain-scoped', () => {
  const legacyOnly = purgeCookies();
  assert.equal(legacyOnly.length, 2);
  assert.ok(legacyOnly.some(c => c.startsWith('pbe_nfl_session=;') && !/Domain=/.test(c)));
  assert.ok(legacyOnly.some(c => /^pbe_nfl_session=;.*Domain=\.propbetedge\.ai/.test(c)));
  assert.ok(legacyOnly.every(c => /Max-Age=0/.test(c)));

  const all = purgeCookies({ includeCurrent: true });
  assert.equal(all.length, 4);
  assert.ok(all.some(c => c.startsWith('pbe_nfl_session_v2=;') && !/Domain=/.test(c)),
    'logout must clear the host-only cookie the app actually sets');
  assert.ok(all.some(c => /^pbe_nfl_session_v2=;.*Domain=\.propbetedge\.ai/.test(c)));
});

/* =====================================================================
 * CROSS-RUNTIME CRYPTO PARITY  (why one verifier is safe)
 * ===================================================================== */

test('a token signed by the Worker WebCrypto path verifies with the Vercel node:crypto path', async () => {
  const token = await signWorker({ email: EMAIL, type: 'session', iat: now(), exp: now() + 600, jti: 'x' });
  const payload = verifyWorkerJwt(token, SECRET, 'session');
  assert.equal(payload.email, EMAIL);
});

test('a token signed with a different service-role key is rejected', async () => {
  const token = await signWorker({ email: EMAIL, type: 'session', iat: now(), exp: now() + 600, jti: 'x' }, 'other-key');
  assert.throws(() => verifyWorkerJwt(token, SECRET, 'session'), /token_signature/);
});

test('the self-test probe token can never be used as a session', async () => {
  const probe = await signWorker({ type: 'probe', iat: now(), exp: now() + 120, jti: 'p' });
  verifyWorkerJwt(probe, SECRET, 'probe');                       // parity check passes
  assert.throws(() => verifyWorkerJwt(probe, SECRET, 'session'), /token_type/);
});

test('a magic token cannot be replayed as a session cookie', () => {
  const magic = signNode({ email: EMAIL, type: 'magic', purpose: 'signin', iat: now(), exp: now() + 900, jti: 'm' });
  assert.throws(() => verifyWorkerJwt(magic, SECRET, 'session'), /token_type/);
});

/* =====================================================================
 * STAGES  (a backend failure must not look like "signed out")
 * ===================================================================== */

test('no cookie reports stage=no_cookie', async () => {
  const session = await getNflSession(reqWith(''));
  assert.equal(session.valid, false);
  assert.equal(session.stage, 'no_cookie');
  assert.equal(session.degraded, false);
});

test('an unusable cookie reports stage=cookie_present_invalid with a reason', async () => {
  const session = await getNflSession(reqWith(`${SESSION_COOKIE}=${opaqueLegacyToken()}`));
  assert.equal(session.valid, false);
  assert.equal(session.stage, 'cookie_present_invalid');
  assert.equal(session.reason, 'token_shape');
  assert.equal(session.cookies.current, 1);
});

test('a missing service-role key reports stage=secret_missing, not a silent sign-out', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const session = await getNflSession(reqWith(`${SESSION_COOKIE}=${freshSession(saved)}`));
    assert.equal(session.stage, 'secret_missing');
    assert.equal(session.degraded, true);
  } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = saved; }
});

test('a Supabase outage keeps the proven identity and flags degraded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const session = await getNflSession(reqWith(`${SESSION_COOKIE}=${freshSession()}`));
    assert.equal(session.valid, true, 'the JWT proved identity; do not report signed out');
    assert.equal(session.pro, false);
    assert.equal(session.stage, 'entitlement_lookup_failed');
    assert.equal(session.degraded, true);
    assert.equal(verifiedEmail(session), EMAIL);
  } finally { globalThis.fetch = original; }
});

test('a signed-in account with no active row reports stage=entitlement_missing', async () => {
  const restore = stubSupabase({ rows: [{ status: 'canceled', current_period_end: null, created_at: '2026-01-01T00:00:00Z' }] });
  try {
    const session = await getNflSession(reqWith(`${SESSION_COOKIE}=${freshSession()}`));
    assert.equal(session.valid, true);
    assert.equal(session.pro, false);
    assert.equal(session.stage, 'entitlement_missing');
  } finally { restore(); }
});

test('an expired-period row does not grant Pro', async () => {
  const restore = stubSupabase({ rows: [{ status: 'active', current_period_end: '2020-01-01T00:00:00Z', created_at: '2019-01-01T00:00:00Z' }] });
  try {
    const session = await getNflSession(reqWith(`${SESSION_COOKIE}=${freshSession()}`));
    assert.equal(session.pro, false);
    assert.equal(session.stage, 'entitlement_missing');
  } finally { restore(); }
});

/* =====================================================================
 * ENDPOINT CONTRACTS
 * ===================================================================== */

function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, redirectedTo: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
  };
  return res;
}

test('auth-verify purges legacy cookies BEFORE setting the authoritative one', async () => {
  const { default: handler } = await import('../api/auth-verify.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true, email: EMAIL, session_token: freshSession(), expires_in: 2592000,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = mockRes();
    await handler({ method: 'GET', query: { token: signNode({ email: EMAIL, type: 'magic', iat: now(), exp: now() + 900 }) }, headers: {} }, res);

    const cookies = res.headers['set-cookie'];
    assert.ok(Array.isArray(cookies), 'must emit multiple Set-Cookie values');
    assert.equal(cookies.length, 3, '2 legacy purges + 1 authoritative cookie');
    assert.ok(cookies.slice(0, 2).every(c => /Max-Age=0/.test(c)), 'purges come first');
    assert.match(cookies[2], /^pbe_nfl_session_v2=/, 'the real cookie is written last');
    assert.ok(!/Max-Age=0/.test(cookies[2]));
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectedTo, 'https://nfl.propbetedge.ai/?auth=complete&session=established');
  } finally { globalThis.fetch = original; }
});

test('auth-verify never leaks the token into the redirect on failure', async () => {
  const { default: handler } = await import('../api/auth-verify.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'token_expired' }), { status: 401 });
  try {
    const res = mockRes();
    const token = signNode({ email: EMAIL, type: 'magic', iat: now(), exp: now() + 900 });
    await handler({ method: 'GET', query: { token }, headers: {} }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectedTo, 'https://nfl.propbetedge.ai/?auth=token_expired');
    assert.ok(!res.redirectedTo.includes(token));
    assert.equal(res.headers['set-cookie'], undefined, 'no cookie on a failed exchange');
  } finally { globalThis.fetch = original; }
});

test('auth-logout clears all four cookie variants', async () => {
  const { default: handler } = await import('../api/auth-logout.js');
  const res = mockRes();
  await handler({ method: 'POST', headers: {} }, res);
  const cookies = res.headers['set-cookie'];
  assert.equal(cookies.length, 4);
  assert.ok(cookies.every(c => /Max-Age=0/.test(c)));
  assert.ok(cookies.some(c => c.startsWith('pbe_nfl_session_v2=;') && !/Domain=/.test(c)),
    'the previous implementation never cleared this one, so logout could not work');
  assert.equal(res.body.ok, true);
});

test('auth-session returns the full stage contract for a Pro subscriber', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  const restore = stubSupabase({ rows: ACTIVE_ROW });
  try {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${freshSession()}` } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.pro, true);
    assert.equal(res.body.user.email, EMAIL);
    assert.equal(res.body.stage, 'entitlement_active');
    assert.equal(res.body.authority, 'vercel-local');
  } finally { restore(); }
});

test('auth-session no longer masks failures as an anonymous 200', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 503 });
  try {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${freshSession()}` } }, res);
    assert.notEqual(res.body.stage, 'no_cookie');
    assert.equal(res.body.degraded, true);
    assert.match(res.body.error, /entitlement_503/);
  } finally { globalThis.fetch = original; }
});

/* =====================================================================
 * SECRETS MUST NOT ESCAPE
 * ===================================================================== */

test('auth-diag reports parity without echoing any secret or token', async () => {
  const { default: handler } = await import('../api/auth-diag.js');
  const probe = await signWorker({ type: 'probe', iat: now(), exp: now() + 120, jti: 'p' });
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/v1/auth/selftest')
    ? new Response(JSON.stringify({ ok: true, version: 'v6.0', probe_token: probe }), { status: 200 })
    : new Response(JSON.stringify([]), { status: 200 });
  try {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: `${SESSION_COOKIE}=${freshSession()}` } }, res);
    assert.equal(res.body.secret_parity, 'match');
    assert.equal(res.body.entitlement_store.reachable, true);
    assert.equal(res.body.cookies[SESSION_COOKIE].verifies, true);
    assert.equal(res.body.verdict, 'auth_backend_healthy');

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(SECRET), 'service-role key must never appear');
    assert.ok(!serialized.includes(probe), 'probe token must never be echoed');
    assert.ok(!serialized.includes(freshSession().split('.')[2]), 'no cookie signature bytes');
  } finally { globalThis.fetch = original; }
});

test('auth-diag detects a service-role key mismatch between Vercel and the Worker', async () => {
  const { default: handler } = await import('../api/auth-diag.js');
  const probe = await signWorker({ type: 'probe', iat: now(), exp: now() + 120, jti: 'p' }, 'a-different-key');
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/v1/auth/selftest')
    ? new Response(JSON.stringify({ ok: true, version: 'v6.0', probe_token: probe }), { status: 200 })
    : new Response(JSON.stringify([]), { status: 200 });
  try {
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);
    assert.match(res.body.secret_parity, /^mismatch:/);
    assert.equal(res.body.verdict, 'auth_backend_misconfigured');
  } finally { globalThis.fetch = original; }
});
