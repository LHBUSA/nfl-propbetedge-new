/* SEV-1 2026-09-15 — an MLB-only customer received "PropBetEdge NFL — secure
 * sign-in". The auth Worker signed and emailed an NFL magic link for any
 * syntactically valid email, and exchanged it for a session without asking
 * whether the email had bought NFL.
 *
 * NFL means NFL. These tests drive the real Worker (workers/nfl-auth) and the
 * real Vercel handlers against a controlled ledger and a Resend spy:
 *   · request  — a magic token is signed and Resend is called ONLY for a
 *                current NFL entitlement or a configured owner; every answer
 *                is the same enumeration-safe 200
 *   · exchange — access is checked AGAIN after the link is consumed; a denied
 *                link issues no session and stays spent
 *   · session  — a verified email without NFL is paywalled, and every premium
 *                route refuses it
 *   · drift    — the Worker and Vercel share one lookup and one predicate, and
 *                the NFL price ids are pinned here
 *
 *   node --test tests/nfl-auth-entitlement-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SECRET = 'entitlement-gate-signing-secret';
const APP = 'https://nfl.propbetedge.ai';
const SUPABASE = 'https://supabase.gate.test';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'gate-service-role-key',
  NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@gate.test',
  NFL_GATEWAY_TOKEN: 'gate-model-credential',
});

const { default: worker, MagicLinkLedger, GENERIC_REQUEST_MESSAGE, issueLinkIfEntitled } = await import('../workers/nfl-auth/src/index-v5.js');
const ent = await import('../api/_nfl-entitlement.js');
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------ the ledger */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const P = ent.NFL_PRICES;
const recurring = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1Gate', stripe_customer_id: 'cus_Gate', stripe_checkout_session_id: 'cs_live_Gate', current_period_end: iso(Date.now() + 5 * DAY), cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
/* Perfectly valid subscriptions in every respect except the product. If the
   lookup ever degrades to "any active subscription", these grant and fail. */
const OTHER_SPORT = { mlb: 'price_1MLBProMonthlyGate', nba: 'price_1NBAProMonthlyGate', nhl: 'price_1NHLProMonthlyGate', ufc: 'price_1UFCProMonthlyGate', wnba: 'price_1WNBAProMonthlyGate' };

const LEDGER = {
  /* MLB subscriptions live in another project; an MLB-only customer has no NFL rows. */
  'mlb-only@gate.test': [],
  /* the same customer if another sport's row were ever written to the NFL ledger */
  'mlb-crosswrite@gate.test': [recurring('mlb-crosswrite@gate.test', OTHER_SPORT.mlb)],
  'nba-only@gate.test': [recurring('nba-only@gate.test', OTHER_SPORT.nba)],
  'nhl-only@gate.test': [recurring('nhl-only@gate.test', OTHER_SPORT.nhl)],
  'ufc-only@gate.test': [recurring('ufc-only@gate.test', OTHER_SPORT.ufc, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'multi-non-nfl@gate.test': Object.values(OTHER_SPORT).map(price => recurring('multi-non-nfl@gate.test', price)),
  'none@gate.test': [],
  /* the two rows production actually holds: status=active, no price, no Stripe proof */
  'orphan-active@gate.test': [{ customer_email: 'orphan-active@gate.test', status: 'active', stripe_price_id: null, current_period_end: null, created_at: '2026-08-29T18:22:09Z' }],
  'expired-nfl@gate.test': [recurring('expired-nfl@gate.test', P.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
  'canceled-nfl@gate.test': [recurring('canceled-nfl@gate.test', P.foundingMonthly, { status: 'canceled' })],
  'pastdue-nfl@gate.test': [recurring('pastdue-nfl@gate.test', P.foundingMonthly, { status: 'past_due' })],
  'unknown-nfl-price@gate.test': [recurring('unknown-nfl-price@gate.test', 'price_1NFLUnknownGate')],
  /* the ledger returned a row, but for another address */
  'lookalike@gate.test': [recurring('weekly@gate.test', P.foundingWeekly)],
  'weekly@gate.test': [recurring('weekly@gate.test', P.foundingWeekly)],
  'legacy-weekly@gate.test': [recurring('legacy-weekly@gate.test', P.legacyWeekly)],
  'monthly@gate.test': [recurring('monthly@gate.test', P.foundingMonthly, { current_period_end: iso(Date.now() + 20 * DAY) })],
  'season-pass@gate.test': [{ customer_email: 'season-pass@gate.test', status: 'active', stripe_price_id: P.legacySeasonPass, stripe_subscription_id: null, stripe_customer_id: 'cus_Gate', stripe_checkout_session_id: 'cs_live_GateSeason', current_period_end: '2027-02-15T05:59:59Z', cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z' }],
  'owner@gate.test': [],
};

let ledgerMode = 'ok';
const resendCalls = [];
const ledgerReads = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE && u.pathname === '/rest/v1/nfl_subscriptions') {
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    ledgerReads.push(email);
    if (ledgerMode === 'down') return new Response('{"message":"down"}', { status: 503 });
    return new Response(JSON.stringify(LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === SUPABASE) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.host === 'api.resend.com') {
    const body = JSON.parse(init.body);
    resendCalls.push(body);
    return new Response(JSON.stringify({ id: `re_gate_${resendCalls.length}` }), { status: 200 });
  }
  if (u.host === 'nfl-api.propbetedge.ai') return new Response('{"model":"PAID_MODEL_VALUE"}', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

/* Every HMAC signature the Worker computes goes through subtle.sign. A denied
   request must compute none: no magic token exists for it. */
let signCalls = 0;
const realSign = crypto.subtle.sign.bind(crypto.subtle);
crypto.subtle.sign = (...args) => { signCalls += 1; return realSign(...args); };

function ledgerNamespace() {
  const objects = new Map();
  let queue = Promise.resolve();
  return {
    objects,
    idFromName: name => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const store = new Map();
        objects.set(id.name, new MagicLinkLedger({ storage: { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); }, setAlarm: async () => {}, deleteAll: async () => store.clear() } }));
      }
      const obj = objects.get(id.name);
      return { fetch: (url, init) => (queue = queue.then(() => obj.fetch(new Request(url, init)))) };
    },
  };
}

const ENV = {
  NFL_SESSION_SIGNING_SECRET: SECRET, SUPABASE_SERVICE_ROLE_KEY: 'gate-service-role-key', SUPABASE_URL: SUPABASE,
  RESEND_API_KEY: 're_gate_key', APP_ORIGIN: APP, NFL_OWNER_EMAILS: 'owner@gate.test', MAGIC_LINKS: ledgerNamespace(),
};

/* A ctx like the runtime's: the response returns first, the work finishes after. */
async function requestLink(email, { purpose = 'signin', env = ENV } = {}) {
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const r = await worker.fetch(new Request('https://auth.gate.test/v1/auth/request', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ email, purpose }) }), env, ctx);
  const answer = { status: r.status, body: await r.json() };
  await Promise.all(pending);
  return answer;
}
async function exchange(token, env = ENV) {
  const r = await worker.fetch(new Request('https://auth.gate.test/v1/auth/exchange', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), env);
  return { status: r.status, body: await r.json() };
}
const tokenFrom = mail => new URL(/https:\/\/nfl\.propbetedge\.ai\/api\/auth-verify\?token=[^\s"<]+/.exec(mail.text)[0]).searchParams.get('token');

const GENERIC = { ok: true, provider: 'resend', auth_issuer: 'propbetedge', purpose: 'signin', message: GENERIC_REQUEST_MESSAGE };

/* ------------------------------------------------------------ request matrix */
const DENIED = [
  ['MLB-only', 'mlb-only@gate.test'],
  ['MLB row cross-written into the NFL ledger', 'mlb-crosswrite@gate.test'],
  ['NBA-only', 'nba-only@gate.test'],
  ['NHL-only', 'nhl-only@gate.test'],
  ['UFC-only', 'ufc-only@gate.test'],
  ['every other sport at once', 'multi-non-nfl@gate.test'],
  ['no subscriptions', 'none@gate.test'],
  ['orphan status=active row (no price, no Stripe proof)', 'orphan-active@gate.test'],
  ['expired NFL', 'expired-nfl@gate.test'],
  ['canceled NFL', 'canceled-nfl@gate.test'],
  ['past_due NFL', 'pastdue-nfl@gate.test'],
  ['unknown NFL price', 'unknown-nfl-price@gate.test'],
  ['ledger row for a different address', 'lookalike@gate.test'],
];
const ALLOWED = [
  ['valid weekly NFL', 'weekly@gate.test'],
  ['valid legacy weekly NFL', 'legacy-weekly@gate.test'],
  ['valid monthly NFL', 'monthly@gate.test'],
  ['valid NFL season pass', 'season-pass@gate.test'],
  ['owner (server configuration)', 'owner@gate.test'],
  ['owner, mixed case', 'Owner@Gate.TEST'],
];

for (const [name, email] of DENIED) {
  test(`request: ${name} -> generic 200, NO magic token, ZERO Resend email`, async () => {
    resendCalls.length = 0; signCalls = 0;
    const r = await requestLink(email);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, GENERIC);
    assert.equal(resendCalls.length, 0, 'Resend must not be called');
    assert.equal(signCalls, 0, 'no token may be signed');
  });
}

for (const [name, email] of ALLOWED) {
  test(`request: ${name} -> the same generic 200, exactly one NFL email to that address`, async () => {
    resendCalls.length = 0;
    const r = await requestLink(email);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, GENERIC, 'an entitled answer is indistinguishable from a denied one');
    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0].to, [email.toLowerCase()]);
    assert.equal(resendCalls[0].subject, 'PropBetEdge NFL — secure sign-in');
  });
}

test('request: the response is returned before the decision runs (no timing oracle)', async () => {
  resendCalls.length = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const pending = [];
  const env = { ...ENV };
  const slowFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).startsWith(SUPABASE)) await gate; return slowFetch(url, init); };
  try {
    const r = await worker.fetch(new Request('https://auth.gate.test/v1/auth/request', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'weekly@gate.test' }) }), env, { waitUntil: p => pending.push(p) });
    assert.equal(r.status, 200, 'answered while the ledger had not yet replied');
    assert.equal(resendCalls.length, 0);
  } finally {
    release(); await Promise.all(pending); globalThis.fetch = slowFetch;
  }
  assert.equal(resendCalls.length, 1);
});

test('request: a ledger that cannot answer sends nothing (fail closed), same generic answer', async () => {
  resendCalls.length = 0; signCalls = 0; ledgerMode = 'down';
  try {
    const r = await requestLink('weekly@gate.test');
    assert.deepEqual(r.body, GENERIC);
    assert.equal(resendCalls.length, 0); assert.equal(signCalls, 0);
  } finally { ledgerMode = 'ok'; }
});

test('request: without the ledger credential the Worker refuses to run at all', async () => {
  resendCalls.length = 0;
  const { SUPABASE_SERVICE_ROLE_KEY, ...env } = ENV;
  const r = await requestLink('owner@gate.test', { env });
  assert.equal(r.status, 503); assert.equal(resendCalls.length, 0);
});

test('request: owner access exists only in server configuration', async () => {
  resendCalls.length = 0;
  const { NFL_OWNER_EMAILS, ...env } = ENV;
  await requestLink('owner@gate.test', { env });
  assert.equal(resendCalls.length, 0);
});

test('request: a purchase return re-checks until the webhook row lands, and only then emails', async () => {
  resendCalls.length = 0;
  const email = 'late-webhook@gate.test';
  LEDGER[email] = [];
  const sleeps = [];
  const signing = { primary: SECRET };
  const decision = await issueLinkIfEntitled(ENV, APP, signing, email, 'purchase', { sleep: async ms => { sleeps.push(ms); if (sleeps.length === 2) LEDGER[email] = [recurring(email, P.foundingMonthly)]; } });
  assert.equal(decision.sent, true); assert.equal(sleeps.length, 2); assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].subject, 'PropBetEdge NFL Pro — your access is ready');

  resendCalls.length = 0;
  const never = await issueLinkIfEntitled(ENV, APP, signing, 'mlb-only@gate.test', 'purchase', { sleep: async () => {} });
  assert.equal(never.sent, false); assert.equal(resendCalls.length, 0);
  const signin = []; await issueLinkIfEntitled(ENV, APP, signing, 'mlb-only@gate.test', 'signin', { sleep: async ms => signin.push(ms) });
  assert.equal(signin.length, 0, 'sign-in never waits');
});

/* ------------------------------------------------------------ exchange */
test('exchange: an NFL subscriber exchanges once; the replay is refused', async () => {
  resendCalls.length = 0;
  await requestLink('monthly@gate.test');
  const token = tokenFrom(resendCalls[0]);
  const first = await exchange(token);
  assert.equal(first.status, 200); assert.equal(first.body.email, 'monthly@gate.test'); assert.ok(first.body.session_token);
  const replay = await exchange(token);
  assert.equal(replay.status, 401); assert.equal(replay.body.error, 'link_already_used'); assert.equal(replay.body.session_token, undefined);
});

test('exchange: canceled between request and click -> not_authorized, no session, link stays spent', async () => {
  resendCalls.length = 0;
  const email = 'cancels-midway@gate.test';
  LEDGER[email] = [recurring(email, P.foundingWeekly)];
  await requestLink(email);
  assert.equal(resendCalls.length, 1);
  const token = tokenFrom(resendCalls[0]);
  LEDGER[email] = [recurring(email, P.foundingWeekly, { status: 'canceled' })];
  const denied = await exchange(token);
  assert.equal(denied.status, 403); assert.deepEqual(denied.body, { error: 'not_authorized' });
  LEDGER[email] = [recurring(email, P.foundingWeekly)];
  const again = await exchange(token);
  assert.equal(again.status, 401); assert.equal(again.body.error, 'link_already_used', 'a denied link is not reusable');
});

test('exchange: expired between request and click -> not_authorized', async () => {
  resendCalls.length = 0;
  const email = 'expires-midway@gate.test';
  LEDGER[email] = [recurring(email, P.foundingMonthly)];
  await requestLink(email);
  const token = tokenFrom(resendCalls[0]);
  LEDGER[email] = [recurring(email, P.foundingMonthly, { current_period_end: iso(Date.now() - 1000) })];
  const r = await exchange(token);
  assert.equal(r.status, 403); assert.equal(r.body.session_token, undefined);
});

/* A validly signed link minted before the gate existed. */
const b64u = v => Buffer.from(v).toString('base64url');
function mint(payload) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${SECRET}`).update(data).digest())}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const staleLink = email => mint({ email, type: 'magic', purpose: 'signin', iat: nowS() - 60, exp: nowS() + 840, jti: crypto.randomUUID() });

for (const [name, email] of DENIED) {
  test(`exchange: a pre-hotfix link for ${name} -> not_authorized, no session`, async () => {
    const r = await exchange(staleLink(email));
    assert.equal(r.status, 403); assert.deepEqual(r.body, { error: 'not_authorized' });
  });
}

test('exchange: a ledger that cannot answer issues no session', async () => {
  ledgerMode = 'down';
  try {
    const r = await exchange(staleLink('weekly@gate.test'));
    assert.equal(r.status, 503); assert.equal(r.body.error, 'entitlement_unavailable'); assert.equal(r.body.session_token, undefined);
  } finally { ledgerMode = 'ok'; }
});

test('exchange: owner and every NFL plan still receive a session', async () => {
  for (const [, email] of ALLOWED) {
    const r = await exchange(staleLink(email.toLowerCase()));
    assert.equal(r.status, 200, email); assert.ok(r.body.session_token);
  }
});

/* ------------------------------------------------------------ Vercel: session + premium */
function mockRes() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = JSON.stringify(b); return this; }, send(b) { this.body = String(b); return this; }, end(b) { this.body = String(b ?? ''); return this; }, redirect(c, l) { this.statusCode = c; this.headers.location = l; return this; } };
}
const sessionCookie = email => `${SESSION_COOKIE}=${mint({ email, type: 'session', iat: nowS(), exp: nowS() + 86400, jti: crypto.randomUUID() })}`;

test('auth-session: an MLB-only session (issued before the hotfix) is PAYWALLED, never an NFL customer', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  for (const [, email] of DENIED) {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie(email) } }, res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.pro, false, email); assert.equal(body.valid, false); assert.equal(body.user, null);
    assert.equal(body.access, 'no_entitlement'); assert.equal(body.paywalled, true); assert.equal(body.subscription, null);
    const cleared = res.headers['set-cookie'];
    assert.ok(cleared.some(c => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c)), 'the NFL session cookie is cleared');
    assert.ok(cleared.every(c => /^pbe_nfl_session(_v2)?=;/.test(c)), 'only NFL cookies are touched, never pbe_session');
  }
});

test('auth-session: NFL subscribers and the owner keep pro:true and their cookie', async () => {
  const { default: handler } = await import('../api/auth-session.js');
  for (const email of ['weekly@gate.test', 'monthly@gate.test', 'season-pass@gate.test', 'owner@gate.test']) {
    const res = mockRes();
    await handler({ method: 'GET', headers: { cookie: sessionCookie(email) } }, res);
    const body = JSON.parse(res.body);
    assert.equal(body.pro, true, email); assert.equal(body.access, 'granted'); assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('premium routes: MLB/NBA/NHL/UFC-only sessions are denied and see no paid value', async () => {
  const { default: proModel } = await import('../api/pro-model.js');
  const { default: picks } = await import('../api/pbe-picks.js');
  const { default: propPicks } = await import('../api/pbe-prop-picks.js');
  const routes = [
    ['pro-model', proModel, { event_id: 'e1' }],
    ['pbe-picks current', picks, { view: 'current' }],
    ['pbe-picks decision', picks, { view: 'decision', id: 'x' }],
    ['pbe-prop-picks current', propPicks, { view: 'current' }],
  ];
  for (const email of ['mlb-only@gate.test', 'nba-only@gate.test', 'nhl-only@gate.test', 'ufc-only@gate.test', 'none@gate.test']) {
    for (const [name, handler, query] of routes) {
      const res = mockRes();
      await handler({ method: 'GET', headers: { cookie: sessionCookie(email) }, query }, res);
      assert.equal(res.statusCode, 403, `${name} for ${email}`);
      assert.equal(/PAID_MODEL_VALUE|fair_line|model_probability/.test(res.body), false, `${name} leaked a paid value`);
    }
  }
});

test('auth-verify: a not_authorized exchange sets no cookie and lands on the NFL paywall', async () => {
  const { default: verify } = await import('../api/auth-verify.js');
  const saved = process.env.NFL_AUTH_WORKER_URL;
  process.env.NFL_AUTH_WORKER_URL = 'https://auth-worker.gate.test';
  const outer = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://auth-worker.gate.test/')) {
      const r = await worker.fetch(new Request('https://auth.gate.test/v1/auth/exchange', { method: 'POST', headers: init.headers, body: init.body }), ENV);
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    return outer(url, init);
  };
  try {
    const res = mockRes();
    await verify({ method: 'GET', query: { token: staleLink('mlb-only@gate.test') }, headers: {} }, res);
    assert.equal(res.statusCode, 302); assert.equal(res.headers.location, `${APP}/?auth=not_authorized`);
    assert.equal(res.headers['set-cookie'], undefined);
  } finally { globalThis.fetch = outer; if (saved === undefined) delete process.env.NFL_AUTH_WORKER_URL; else process.env.NFL_AUTH_WORKER_URL = saved; }
  const paywall = read('paywall.js');
  assert.match(paywall, /auth === 'not_authorized'[\s\S]{0,80}open\('upgrade'\)/);
  assert.match(paywall, /if \(access === 'no_entitlement'\) \{ state\.session = null; state\.user = null; \}/);
});

/* ------------------------------------------------------------ drift */
test('drift: the NFL price ids are exactly these (a changed id fails here)', () => {
  assert.deepEqual({ ...P }, {
    legacyWeekly: 'price_1U9QUZF3CaVzg4OR3QNfwWCS',
    foundingWeekly: 'price_1UEWAOF3CaVzg4ORjkWpwOz9',
    foundingMonthly: 'price_1UEWAXF3CaVzg4ORGlsgboLq',
    legacySeasonPass: 'price_1U9oVzF3CaVzg4ORnk5NiJFA',
  });
  assert.deepEqual([...ent.NFL_RECURRING_PRICES].sort(), [P.foundingMonthly, P.foundingWeekly, P.legacyWeekly].sort());
  assert.deepEqual([...ent.NFL_ONE_TIME_PRICES], [P.legacySeasonPass]);
});

test('drift: the Worker and Vercel decide through the same lookup and predicate', () => {
  const workerSrc = read('workers/nfl-auth/src/index-v5.js');
  assert.match(workerSrc, /from '\.\.\/\.\.\/\.\.\/api\/_nfl-entitlement-ledger\.js'/);
  assert.match(read('api/_nfl-auth.js'), /from '\.\/_nfl-entitlement-ledger\.js'/);
  assert.match(read('api/_nfl-entitlement-ledger.js'), /from '\.\/_nfl-entitlement\.js'/);
  assert.equal(/stripe_price_id|price_1|current_period_end|'trialing'/.test(workerSrc), false, 'the Worker restates no entitlement rule of its own');
  /* request: the gate runs before any token or Resend call */
  const gate = workerSrc.slice(workerSrc.indexOf('export async function issueLinkIfEntitled'));
  assert.ok(gate.indexOf('checkAccess(') < gate.indexOf("type:'magic'"));
  assert.ok(gate.indexOf('if(!access.allowed)') < gate.indexOf('api.resend.com'));
});
