/* NFL auth Worker — magic links prove mailbox ownership exactly once.
 *
 * The real Worker (workers/nfl-auth/src/index-v5.js) with its real
 * MagicLinkLedger Durable Object class, driven in-process. The DO namespace
 * stub gives one object per name and runs each fetch to completion, like the
 * runtime's input gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { MagicLinkLedger } from '../workers/nfl-auth/src/index-v5.js';

const SECRET = 'magic-link-test-signing-secret';
const APP = 'https://nfl.propbetedge.ai';

function ledgerNamespace() {
  const objects = new Map();
  let queue = Promise.resolve();
  return {
    objects,
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const store = new Map();
        const state = { storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); }, setAlarm: async () => {}, deleteAll: async () => store.clear() } };
        objects.set(id.name, new MagicLinkLedger(state));
      }
      const obj = objects.get(id.name);
      /* serialize like a Durable Object's input gate */
      return { fetch: (url, init) => (queue = queue.then(() => obj.fetch(new Request(url, init)))) };
    },
  };
}

const b64u = bytes => Buffer.from(bytes).toString('base64url');
async function sign(payload, secret = SECRET) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`pbe-nfl-auth-v5:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${data}.${b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const magic = (email, over = {}) => sign({ email, type: 'magic', purpose: 'signin', iat: now(), exp: now() + 900, jti: crypto.randomUUID(), ...over });

async function exchange(env, token) {
  const r = await worker.fetch(new Request(`${APP.replace('nfl.', 'auth.')}/v1/auth/exchange`, { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), env);
  return { status: r.status, body: await r.json() };
}
/* The exchange re-checks NFL access; the owner passes without a ledger read. */
const envWith = (ns = ledgerNamespace()) => ({ NFL_SESSION_SIGNING_SECRET: SECRET, APP_ORIGIN: APP, MAGIC_LINKS: ns, NFL_OWNER_EMAILS: 'owner@propbetedge.test' });

test('a magic link exchanges once for a session; the same link again is refused', async () => {
  const env = envWith();
  const token = await magic('owner@propbetedge.test');
  const first = await exchange(env, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.email, 'owner@propbetedge.test');
  assert.ok(first.body.session_token.split('.').length === 3);
  const again = await exchange(env, token);
  assert.equal(again.status, 401);
  assert.deepEqual(again.body, { error: 'link_already_used' });
  assert.equal(again.body.session_token, undefined);
});

test('two simultaneous exchanges of one link: exactly one session', async () => {
  const env = envWith();
  const token = await magic('owner@propbetedge.test');
  const results = await Promise.all([exchange(env, token), exchange(env, token), exchange(env, token)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.body.error === 'link_already_used').length, 2);
});

test('expired, forged, non-magic and jti-less links are refused without touching the ledger', async () => {
  const ns = ledgerNamespace();
  const env = envWith(ns);
  assert.equal((await exchange(env, await magic('owner@propbetedge.test', { exp: now() - 1 }))).body.error, 'token_expired');
  assert.equal((await exchange(env, await sign({ email: 'owner@propbetedge.test', type: 'magic', exp: now() + 900, jti: crypto.randomUUID() }, 'attacker-secret'))).body.error, 'token_signature');
  assert.equal((await exchange(env, await sign({ email: 'owner@propbetedge.test', type: 'session', exp: now() + 900, jti: crypto.randomUUID() }))).body.error, 'invalid_magic');
  assert.equal(ns.objects.size, 0, 'no ledger entry for a refused token');
  const noJti = await exchange(env, await sign({ email: 'owner@propbetedge.test', type: 'magic', exp: now() + 900 }));
  assert.equal(noJti.status, 401); assert.equal(noJti.body.error, 'link_invalid');
});

test('without the ledger the Worker issues no session (fail closed)', async () => {
  const env = { NFL_SESSION_SIGNING_SECRET: SECRET, APP_ORIGIN: APP };
  const r = await exchange(env, await magic('owner@propbetedge.test'));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'link_ledger_unavailable');
  assert.equal(r.body.session_token, undefined);
});

test('a different origin cannot exchange a link', async () => {
  const env = envWith();
  const r = await worker.fetch(new Request('https://auth.test/v1/auth/exchange', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: await magic('owner@propbetedge.test') }) }), env);
  assert.equal(r.status, 403);
});
