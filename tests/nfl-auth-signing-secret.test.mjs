import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'legacy-service-role-test-key';
process.env.SUPABASE_URL ||= 'https://supabase.test';

const auth = await import('../api/_nfl-auth.js');
const worker = await import('../workers/nfl-auth/src/index-v5.js');

const EMAIL = 'signing-migration@propbetedge.test';
const LEGACY = 'legacy-service-role-test-key';
const DEDICATED = 'dedicated-session-signing-test-key';

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = obj => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));
const now = () => Math.floor(Date.now() / 1000);

function sign(payload, secret) {
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = createHmac('sha256', `${auth.HMAC_NAMESPACE}:${secret}`).update(data).digest();
  return `${data}.${b64u(sig)}`;
}

function session(secret) {
  return sign({ email: EMAIL, type: 'session', iat: now(), exp: now() + 3600, jti: 'migration-test' }, secret);
}

test('auth Worker source remains importable after signing-secret migration', () => {
  assert.equal(typeof worker.default?.fetch, 'function');
});

test('dedicated signing secret becomes primary while service-role remains verify-only fallback', () => {
  const savedDedicated = process.env.NFL_SESSION_SIGNING_SECRET;
  const savedLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NFL_SESSION_SIGNING_SECRET = DEDICATED;
  process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
  try {
    const secrets = auth.getSessionSigningSecrets();
    assert.equal(secrets.mode, 'dedicated');
    assert.equal(secrets.primary, DEDICATED);
    assert.equal(secrets.fallback, LEGACY);

    const current = auth.verifyWorkerJwtWithSecrets(session(DEDICATED), secrets, 'session');
    assert.equal(current.payload.email, EMAIL);
    assert.equal(current.matched, 'primary');

    const old = auth.verifyWorkerJwtWithSecrets(session(LEGACY), secrets, 'session');
    assert.equal(old.payload.email, EMAIL);
    assert.equal(old.matched, 'fallback');
  } finally {
    if (savedDedicated === undefined) delete process.env.NFL_SESSION_SIGNING_SECRET;
    else process.env.NFL_SESSION_SIGNING_SECRET = savedDedicated;
    process.env.SUPABASE_SERVICE_ROLE_KEY = savedLegacy;
  }
});

test('dedicated signing keeps identity valid when entitlement credential is unavailable', async () => {
  const savedDedicated = process.env.NFL_SESSION_SIGNING_SECRET;
  const savedLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NFL_SESSION_SIGNING_SECRET = DEDICATED;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const token = session(DEDICATED);
    const result = await auth.getNflSession({ headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } });
    assert.equal(result.valid, true);
    assert.equal(result.pro, false);
    assert.equal(result.user.email, EMAIL);
    assert.equal(result.stage, 'entitlement_secret_missing');
    assert.equal(result.degraded, true);
    assert.equal(result.signing.mode, 'dedicated');
  } finally {
    if (savedDedicated === undefined) delete process.env.NFL_SESSION_SIGNING_SECRET;
    else process.env.NFL_SESSION_SIGNING_SECRET = savedDedicated;
    process.env.SUPABASE_SERVICE_ROLE_KEY = savedLegacy;
  }
});

test('unrelated signing key is rejected even during fallback window', () => {
  const savedDedicated = process.env.NFL_SESSION_SIGNING_SECRET;
  const savedLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NFL_SESSION_SIGNING_SECRET = DEDICATED;
  process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
  try {
    const secrets = auth.getSessionSigningSecrets();
    assert.throws(
      () => auth.verifyWorkerJwtWithSecrets(session('wrong-key'), secrets, 'session'),
      /token_signature/
    );
  } finally {
    if (savedDedicated === undefined) delete process.env.NFL_SESSION_SIGNING_SECRET;
    else process.env.NFL_SESSION_SIGNING_SECRET = savedDedicated;
    process.env.SUPABASE_SERVICE_ROLE_KEY = savedLegacy;
  }
});
