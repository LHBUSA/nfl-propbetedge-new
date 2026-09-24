/* PropBetEdge membership contract in the NFL frontend (2026-09-24).
 *
 * One vocabulary for membership across every sport frontend:
 *   free · sport_pro (NFL PRO ACTIVE) · all_access (ALL ACCESS ACTIVE) · owner
 * derived server-side ONLY, from the verdict api/_nfl-auth.js already reaches,
 * and carried as `membership` on every /api/auth-session answer. The browser
 * reads it (pbe-membership.js, window.PBEMembership) and never widens it.
 *
 *   server   anonymous · MLB-only (paywalled) · NFL weekly/monthly · All Access ·
 *            owner · canceled / expired / past_due NFL  -> the right state, label
 *            and UI flags; no email on a paywalled answer; no grant changed
 *   client   the funnel, header, footer and home sales builders render each
 *            state with no purchase CTA for all_access/owner; free readers get
 *            the ALL ACCESS hero FIRST, then both NFL plans (nfl-all-access-
 *            hero-v1.js is the NFL layer; the contract card is its fallback);
 *            never "Stripe" as a state
 *   copies   api/_pbe-membership.js and pbe-membership.js are byte-identical
 *
 *   node --test tests/nfl-membership-state.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SECRET = 'membership-contract-signing-secret';
const SUPABASE = 'https://supabase.membership.test';
const BILLING = 'https://billing.membership.test';
const READ_TOKEN = 'membership-billing-read-token';
Object.assign(process.env, {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'membership-service-role-key',
  NFL_SESSION_SIGNING_SECRET: SECRET,
  NFL_OWNER_EMAILS: 'owner@membership.test',
  NFL_GATEWAY_TOKEN: 'membership-model-credential',
  PBE_BILLING_URL: BILLING,
  PBE_ENTITLEMENT_READ_TOKEN: READ_TOKEN,
});

const M = await import('../api/_pbe-membership.js');
const ent = await import('../api/_nfl-entitlement.js');
const { SESSION_COOKIE, HMAC_NAMESPACE } = await import('../api/_nfl-auth.js');
const { default: sessionHandler } = await import('../api/auth-session.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------ the two ledgers */
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const P = ent.NFL_PRICES;
const END = iso(Date.now() + 9 * DAY);
const row = (email, price, over = {}) => ({ customer_email: email, status: 'active', stripe_price_id: price, stripe_subscription_id: 'sub_1Mbr', stripe_customer_id: 'cus_Mbr', stripe_checkout_session_id: 'cs_live_Mbr', current_period_end: END, cancel_at_period_end: false, created_at: '2026-09-01T00:00:00Z', ...over });
const NFL_LEDGER = {
  'weekly@membership.test': [row('weekly@membership.test', P.foundingWeekly)],
  'monthly@membership.test': [row('monthly@membership.test', P.foundingMonthly, { cancel_at_period_end: true })],
  'canceled@membership.test': [row('canceled@membership.test', P.foundingMonthly, { status: 'canceled' })],
  'expired@membership.test': [row('expired@membership.test', P.foundingWeekly, { current_period_end: iso(Date.now() - DAY) })],
  'pastdue@membership.test': [row('pastdue@membership.test', P.foundingMonthly, { status: 'past_due' })],
  'season-pass@membership.test': [row('season-pass@membership.test', P.legacySeasonPass, { stripe_subscription_id: null, current_period_end: iso(Date.now() + 120 * DAY) })],
};
const BILLING_LEDGER = {
  'all-access@membership.test': { entitled: true, product_key: 'pbe_all_access', access_source: 'all_access', subscription: { product_key: 'pbe_all_access', plan: 'monthly', status: 'active', current_period_end: END, cancel_at_period_end: false } },
  'mlb-only@membership.test': { entitled: false, product_key: 'pbe_all_access', access_source: null, subscription: null },
};
const no = { entitled: false, product_key: 'pbe_all_access', access_source: null, subscription: null };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin === SUPABASE && u.pathname === '/rest/v1/nfl_subscriptions') {
    const email = (/customer_email=ilike\.([^&]+)/.exec(decodeURIComponent(u.search))?.[1] || '').replace(/\\([%_*\\])/g, '$1');
    return new Response(JSON.stringify(NFL_LEDGER[email] || []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.origin === SUPABASE) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.origin === BILLING) {
    if ((init.headers?.authorization || '') !== `Bearer ${READ_TOKEN}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    const body = JSON.parse(init.body || '{}');
    return new Response(JSON.stringify(BILLING_LEDGER[String(body.email).toLowerCase()] || no), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

const b64u = v => Buffer.from(v).toString('base64url');
function mint(payload) {
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(createHmac('sha256', `${HMAC_NAMESPACE}:${SECRET}`).update(data).digest())}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const sessionCookie = email => `${SESSION_COOKIE}=${mint({ email, type: 'session', iat: nowS(), exp: nowS() + 86400, jti: crypto.randomUUID() })}`;
function mockRes() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = JSON.stringify(b); return this; } };
}
async function session(email) {
  const res = mockRes();
  await sessionHandler({ method: 'GET', headers: { cookie: email ? sessionCookie(email) : '' } }, res);
  return { res, body: JSON.parse(res.body) };
}

const CONTRACT_KEYS = ['contract', 'sport', 'state', 'legacy_tier', 'label', 'sublabel', 'entitled', 'access_source', 'product_key', 'plan', 'email', 'current_period_end', 'cancel_at_period_end', 'manage_url', 'network_url', 'show_purchase_cta', 'show_all_access_upgrade', 'show_manage'].sort();
function assertContractShape(m) {
  assert.deepEqual(Object.keys(m).sort(), CONTRACT_KEYS, 'exactly the browser-safe object, nothing more');
  assert.equal(m.contract, M.CONTRACT_VERSION); assert.equal(m.sport, 'nfl');
  assert.equal(m.manage_url, M.MANAGE_URL); assert.equal(m.network_url, M.ALL_ACCESS_URL);
  assert.equal(m.label, M.membershipLabel(m.state, 'nfl', m.legacy_tier));
}
function assertFree(m, { email = null } = {}) {
  assertContractShape(m);
  assert.equal(m.state, 'free'); assert.equal(m.label, 'FREE'); assert.equal(m.entitled, false);
  assert.equal(m.email, email); assert.equal(m.plan, null); assert.equal(m.access_source, null); assert.equal(m.product_key, null);
  assert.equal(m.show_purchase_cta, true); assert.equal(m.show_all_access_upgrade, false); assert.equal(m.show_manage, false);
}

/* ------------------------------------------------------------ server */
test('contract: the four states and their labels, exactly', () => {
  assert.deepEqual([...M.STATES], ['free', 'sport_pro', 'all_access', 'owner']);
  assert.equal(M.membershipLabel('free', 'nfl'), 'FREE');
  assert.equal(M.membershipLabel('sport_pro', 'nfl'), 'NFL PRO ACTIVE');
  assert.equal(M.membershipLabel('all_access', 'nfl'), 'ALL ACCESS ACTIVE');
  assert.equal(M.membershipLabel('owner', 'nfl'), 'OWNER');
});

test('auth-session: anonymous -> FREE membership, no email', async () => {
  const { body } = await session(null);
  assert.equal(body.access, 'anonymous'); assert.equal(body.pro, false);
  assertFree(body.membership);
});

test('auth-session: an MLB-only identity is paywalled -> FREE, no email, no identity, cookie cleared', async () => {
  const { res, body } = await session('mlb-only@membership.test');
  assert.equal(body.paywalled, true); assert.equal(body.valid, false); assert.equal(body.user, null); assert.equal(body.pro, false);
  assertFree(body.membership);
  assert.ok(res.headers['set-cookie'].some(c => c.startsWith(`${SESSION_COOKIE}=;`)));
});

for (const [email, plan, cancelAtEnd] of [['weekly@membership.test', 'founding_weekly', false], ['monthly@membership.test', 'founding_monthly', true]]) {
  test(`auth-session: NFL ${plan} -> NFL PRO ACTIVE with manage + All Access upgrade, no purchase CTA`, async () => {
    const { res, body } = await session(email);
    assert.equal(body.pro, true); assert.equal(body.access, 'granted'); assert.equal(body.role, 'subscriber'); assert.equal(res.headers['set-cookie'], undefined);
    const m = body.membership; assertContractShape(m);
    assert.equal(m.state, 'sport_pro'); assert.equal(m.label, 'NFL PRO ACTIVE'); assert.equal(m.entitled, true);
    assert.equal(m.access_source, 'sport'); assert.equal(m.product_key, 'nfl_pro'); assert.equal(m.plan, plan); assert.equal(m.email, email);
    assert.equal(m.current_period_end, body.subscription.current_period_end); assert.equal(m.cancel_at_period_end, cancelAtEnd);
    assert.equal(m.show_manage, true); assert.equal(m.show_all_access_upgrade, true); assert.equal(m.show_purchase_cta, false);
  });
}

test('auth-session: the legacy one-time NFL season pass -> sport_pro legacy tier, nothing to manage, All Access upgrade offered', async () => {
  const { body } = await session('season-pass@membership.test');
  assert.equal(body.pro, true); assert.equal(body.entitlement.plan, 'season_pass'); assert.equal(body.entitlement.billing, 'one_time');
  const m = body.membership; assertContractShape(m);
  assert.equal(m.state, 'sport_pro'); assert.equal(m.legacy_tier, 'season_pass'); assert.equal(m.label, 'NFL SEASON PASS'); assert.equal(m.sublabel, 'Season pass');
  assert.equal(m.show_manage, false, 'a one-time pass has no subscription to manage'); assert.equal(m.show_all_access_upgrade, true); assert.equal(m.show_purchase_cta, false);
  /* recurring NFL plans carry no legacy tier */
  const weekly = (await session('weekly@membership.test')).body.membership;
  assert.equal(weekly.legacy_tier, null); assert.equal(weekly.sublabel, null);
});

test('auth-session: All Access -> ALL ACCESS ACTIVE with manage link, no purchase CTA, no upgrade card', async () => {
  const { res, body } = await session('all-access@membership.test');
  assert.equal(body.pro, true); assert.equal(body.access, 'granted'); assert.equal(body.entitlement.source, 'pbe_all_access'); assert.equal(res.headers['set-cookie'], undefined);
  const m = body.membership; assertContractShape(m);
  assert.equal(m.state, 'all_access'); assert.equal(m.label, 'ALL ACCESS ACTIVE'); assert.equal(m.entitled, true);
  assert.equal(m.access_source, 'all_access'); assert.equal(m.product_key, 'pbe_all_access'); assert.equal(m.plan, 'all_access'); assert.equal(m.email, 'all-access@membership.test');
  assert.equal(m.current_period_end, END);
  assert.equal(m.show_manage, true); assert.equal(m.show_purchase_cta, false); assert.equal(m.show_all_access_upgrade, false);
});

test('auth-session: the owner -> OWNER, no manage link, no purchase CTA', async () => {
  const { body } = await session('owner@membership.test');
  assert.equal(body.pro, true); assert.equal(body.role, 'owner');
  const m = body.membership; assertContractShape(m);
  assert.equal(m.state, 'owner'); assert.equal(m.label, 'OWNER'); assert.equal(m.entitled, true);
  assert.equal(m.access_source, 'owner'); assert.equal(m.product_key, 'nfl_pro'); assert.equal(m.plan, 'owner'); assert.equal(m.email, 'owner@membership.test');
  assert.equal(m.show_manage, false); assert.equal(m.show_purchase_cta, false); assert.equal(m.show_all_access_upgrade, false);
});

for (const [name, email] of [['canceled', 'canceled@membership.test'], ['expired', 'expired@membership.test'], ['past_due', 'pastdue@membership.test']]) {
  test(`auth-session: ${name} NFL subscription -> paywalled FREE, no email`, async () => {
    const { res, body } = await session(email);
    assert.equal(body.pro, false); assert.equal(body.paywalled, true); assert.equal(body.user, null);
    assertFree(body.membership);
    assert.ok(res.headers['set-cookie'].some(c => c.startsWith(`${SESSION_COOKIE}=;`)));
  });
}

test('auth-session: membership never contradicts the access verdict, and the client reader never widens it', async () => {
  for (const email of [null, 'mlb-only@membership.test', 'weekly@membership.test', 'season-pass@membership.test', 'all-access@membership.test', 'owner@membership.test', 'canceled@membership.test']) {
    const { body } = await session(email);
    assert.equal(body.membership.entitled, body.pro === true, String(email));
    /* the browser-side reader reproduces the server object exactly */
    assert.deepEqual(M.readMembership(body.membership, 'nfl'), body.membership, String(email));
  }
  /* malformed or forged objects are FREE */
  for (const forged of [null, 'all_access', { state: 'all_access' }, { state: 'owner', entitled: false }, { state: 'vip', entitled: true }, { entitled: true }]) {
    assert.equal(M.readMembership(forged, 'nfl').state, 'free', JSON.stringify(forged));
  }
});

test('auth-diag reports the contract version', () => {
  assert.match(read('api/auth-diag.js'), /membership: \{ contract: MEMBERSHIP_CONTRACT/);
  assert.match(read('api/auth-diag.js'), /import \{ CONTRACT_VERSION as MEMBERSHIP_CONTRACT \} from '\.\/_pbe-membership\.js'/);
});

/* ------------------------------------------------------------ the copies */
test('api/_pbe-membership.js and pbe-membership.js are byte-identical; the CSS ships and the module is exposed on window', () => {
  assert.ok(readFileSync(new URL('../api/_pbe-membership.js', import.meta.url)).equals(readFileSync(new URL('../pbe-membership.js', import.meta.url))));
  assert.equal(M.CONTRACT_VERSION, '1.1.0', 'the copy is the 1.1.0 shared contract (legacy tiers inside sport_pro)');
  assert.deepEqual([...M.LEGACY_TIERS], ['founding', 'season_pass']);
  for (const tier of ['founding', 'season_pass']) assert.match(read('pbe-membership.css'), new RegExp(`\\.pbe-mbr-badge\\.is-${tier}`));
  const html = read('index.html');
  const system = html.indexOf('href="./pbe-system.css'); const mbr = html.indexOf('href="./pbe-membership.css');
  assert.ok(system > 0 && mbr > system, 'pbe-membership.css is linked after pbe-system.css');
  assert.match(html, /<script type="module">\s*import \* as PBEMembership from '\.\/pbe-membership\.js\?v=[^']+';\s*window\.PBEMembership = PBEMembership;/);
  assert.equal(/<script[^>]+type="module"[^>]+src=/.test(html), false, 'the classic <script src> list stays exactly as pinned');
});

/* ------------------------------------------------------------ client builders (no browser) */
const paywallSrc = read('paywall.js');
const PRICING = new Function(`${paywallSrc.slice(paywallSrc.indexOf('const PRICING = Object.freeze({'), paywallSrc.indexOf('window.PBEPricing = PRICING;'))}; return PRICING;`)();

function fakeElement() {
  const el = { style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', classList: { add() {}, toggle() {}, remove() {} } };
  Object.assign(el, { setAttribute() {}, appendChild() {}, before() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentElement() {}, insertAdjacentHTML() {}, addEventListener() {} });
  return el;
}
/* Runs a classic client script against a DOM-less page: every lookup returns
   nothing, every scheduler is inert, so only the pure builders are reachable. */
function run(file, proState) {
  const document = { readyState: 'complete', body: fakeElement(), head: fakeElement(), documentElement: fakeElement(), addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: fakeElement };
  const window = { PBEPricing: PRICING, PBEMembership: M, PBEPro: { state: proState, open() {}, close() {}, paintNotice() {}, refreshAccess: async () => false, denialNote() { return ''; } }, App: {}, location: { href: 'https://nfl.propbetedge.ai/', search: '' }, addEventListener() {}, dispatchEvent() {} };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, URL, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() { return 0; }, queueMicrotask() {}, MutationObserver: class { observe() {} }, CustomEvent: class {}, KeyboardEvent: class {}, localStorage: { getItem() { return null; }, setItem() {} }, fetch: async () => ({}), location: window.location });
  /* page-loader.js loads the NFL All Access hero before the funnel and the
     sales layer; the DOM-less page does the same. */
  vm.runInContext(read('nfl-all-access-hero-v1.js'), ctx, { filename: 'nfl-all-access-hero-v1.js' });
  vm.runInContext(read(file), ctx, { filename: file });
  return window;
}
const member = (state, over = {}) => M.deriveMembership({ sport: 'nfl', entitled: state !== 'free', accessSource: state === 'free' ? null : state === 'sport_pro' ? 'sport' : state, productKey: state === 'all_access' ? 'pbe_all_access' : 'nfl_pro', plan: state === 'sport_pro' ? 'founding_monthly' : state === 'all_access' ? 'all_access' : state === 'owner' ? 'owner' : null, email: state === 'free' ? null : `${state}@membership.test`, currentPeriodEnd: state === 'free' ? null : END, ...over });
const proStateFor = state => ({ loading: false, pro: state !== 'free', access: state === 'free' ? 'anonymous' : 'granted', role: state === 'owner' ? 'owner' : state === 'free' ? null : 'subscriber', user: state === 'free' ? null : { email: `${state}@membership.test` }, subscription: state === 'free' ? null : { current_period_end: END, cancel_at_period_end: false }, membership: member(state), entitlement: null });

const PURCHASE_CTA = /data-funnel-plan=|buy\.stripe\.com|Unlock NFL Pro|pbe-mbr-aa|Get All Access|GET ALL ACCESS|nfl-aa-hero|data-nfl-all-access|pbe-funnel-checkout/;
const visibleText = html => html.replace(/\s(?:href|src)="[^"]*"/g, '');

test('funnel: free readers (signed out and signed in) see the ALL ACCESS hero FIRST, then ONLY WANT NFL?, then both NFL plans', () => {
  const w = run('paywall-funnel-v2.js', proStateFor('free'));
  const F = w.PBECheckoutFunnel.markup;
  for (const html of [F.signedOut(), F.signedInFree('reader@membership.test')]) {
    assert.match(html, /data-funnel-plan="monthly"/); assert.match(html, /data-funnel-plan="weekly"/);
    assert.ok(html.includes(PRICING.monthly.price) && html.includes(PRICING.weekly.price), 'the NFL prices come from window.PBEPricing');
    const hero = html.indexOf('data-nfl-all-access="hero"'); const divider = html.indexOf('data-nfl-all-access="divider"'); const plans = html.indexOf('data-funnel-plan="monthly"');
    assert.ok(hero > -1 && divider > hero && plans > divider, 'ALL ACCESS hero, then ONLY WANT NFL?, then the NFL plans');
    assert.match(html, /GET ALL ACCESS/); assert.ok(html.includes(M.ALL_ACCESS_OFFER.checkoutUrl)); assert.ok(html.includes(M.ALL_ACCESS_OFFER.promoCode));
    assert.doesNotMatch(html, /class="pbe-mbr-aa/, 'the shared card is only the fallback when the NFL hero module is absent');
    assert.match(html, /data-membership="free"/);
    assert.doesNotMatch(html, /UPGRADE TO ALL ACCESS|Upgrade to All Access/);
  }
  assert.equal(F.memberState(proStateFor('free')), 'free');
});

test('funnel: sport_pro -> NFL PRO ACTIVE, plan text, manage link, UPGRADE TO ALL ACCESS hero, no NFL plan cards', () => {
  const w = run('paywall-funnel-v2.js', proStateFor('sport_pro'));
  const html = w.PBECheckoutFunnel.markup.active('sport_pro@membership.test', { current_period_end: END }, false);
  assert.match(html, /data-funnel-state="active-pro" data-membership="sport_pro"/);
  assert.match(html, /NFL PRO ACTIVE/); assert.match(html, /NFL Pro · founding monthly/);
  assert.ok(html.includes(`class="pbe-mbr-manage" href="${M.MANAGE_URL}"`), 'manage link');
  assert.match(html, /UPGRADE TO ALL ACCESS/); assert.match(html, /class="nfl-aa-hero is-modal is-upgrade"/); assert.ok(html.includes(M.ALL_ACCESS_OFFER.checkoutUrl));
  assert.doesNotMatch(html, /data-funnel-plan=|pbe-funnel-checkout|Unlock NFL Pro/);
  assert.doesNotMatch(html, /pbe-mbr-network/, 'the network row is the All Access member\'s');
  assert.doesNotMatch(visibleText(html), /Stripe/);
  assert.equal(w.PBECheckoutFunnel.markup.memberState(proStateFor('sport_pro')), 'sport_pro');
});

test('funnel: all_access -> ALL ACCESS ACTIVE, manage link, network row, NO purchase CTA anywhere', () => {
  const w = run('paywall-funnel-v2.js', proStateFor('all_access'));
  const html = w.PBECheckoutFunnel.markup.active('all_access@membership.test', { current_period_end: END }, false);
  assert.match(html, /data-funnel-state="active-pro" data-membership="all_access"/);
  assert.match(html, /ALL ACCESS ACTIVE/); assert.match(html, /All Access · every PropBetEdge sport/);
  assert.match(html, /Your PropBetEdge All Access desk is live\./);
  assert.ok(html.includes(`class="pbe-mbr-manage" href="${M.MANAGE_URL}"`), 'manage link');
  assert.match(html, /class="pbe-mbr-network"/); assert.match(html, /aria-current="page" class="is-current">NFL</);
  assert.doesNotMatch(html, PURCHASE_CTA);
  assert.doesNotMatch(visibleText(html), /Stripe/);
  assert.equal(w.PBECheckoutFunnel.markup.memberState(proStateFor('all_access')), 'all_access');
});

test('funnel: owner -> OWNER, no manage link, NO purchase CTA', () => {
  const w = run('paywall-funnel-v2.js', proStateFor('owner'));
  const html = w.PBECheckoutFunnel.markup.active('owner@membership.test', null, true);
  assert.match(html, /data-funnel-state="active-owner" data-membership="owner"/);
  assert.match(html, /is-owner[^>]*>OWNER</); assert.match(html, /Owner access/);
  assert.doesNotMatch(html, /pbe-mbr-manage|Manage subscription/);
  assert.doesNotMatch(html, PURCHASE_CTA);
  assert.doesNotMatch(visibleText(html), /Stripe/);
});

test('funnel: a granted verdict whose membership object is missing still renders as a member, never as free', () => {
  const s = { ...proStateFor('sport_pro'), membership: null };
  const w = run('paywall-funnel-v2.js', s);
  assert.equal(w.PBECheckoutFunnel.markup.memberState(s), 'sport_pro');
  assert.equal(w.PBECheckoutFunnel.markup.memberState({ ...s, role: 'owner' }), 'owner');
  /* and a FREE verdict is never lifted by a stale membership object */
  assert.equal(w.PBECheckoutFunnel.markup.memberState({ ...proStateFor('free'), membership: member('all_access') }), 'free');
});

test('header: members show the contract label; free readers keep Sign In / Upgrade; nothing before the answer', () => {
  const w = run('sports-shell-auth-state.js', proStateFor('free'));
  const label = w.PBEShellAuthState.accountLabel;
  assert.equal(label({ loading: true, pro: true, membership: member('all_access') }), 'Account');
  assert.equal(label(proStateFor('free')), 'Sign In');
  assert.equal(label({ ...proStateFor('free'), user: { email: 'reader@membership.test' } }), 'Upgrade');
  assert.equal(label(proStateFor('sport_pro')), 'NFL PRO ACTIVE');
  assert.equal(label(proStateFor('all_access')), 'ALL ACCESS ACTIVE');
  assert.equal(label(proStateFor('owner')), 'OWNER');
  assert.equal(label({ ...proStateFor('sport_pro'), membership: null }), 'NFL Pro', 'legacy fallback when the contract object is absent');
  assert.match(read('sports-shell-v2.js'), /<button class="pbes-head-btn" type="button" id="pbes-account">Account<\/button>/, 'no gold NFL Pro flash before auth resolves');
  assert.doesNotMatch(read('sports-shell-v2.js'), /pbes-head-btn pro/);
});

test('home sales: free readers get the ALL ACCESS hero first, then ONLY WANT NFL? and both NFL plans; All Access and owner get no sales surface', () => {
  const w = run('nfl-pro-sales-v1.js', proStateFor('free'));
  const S = w.NFLProSalesV1.markup;
  const free = S.sales();
  assert.match(free, /data-pro-plan="monthly"/); assert.match(free, /data-pro-plan="weekly">Weekly · /); assert.doesNotMatch(free, /Fight Week/);
  assert.match(free, /class="nfl-aa-hero is-home"/); assert.ok(free.includes(M.ALL_ACCESS_OFFER.checkoutUrl));
  const hero = free.indexOf('data-nfl-all-access="hero"'); const divider = free.indexOf('data-nfl-all-access="divider"'); const plans = free.indexOf('data-pro-plan="monthly"');
  assert.ok(hero > -1 && divider > hero && plans > divider, 'hero, then ONLY WANT NFL?, then the NFL plans');
  assert.doesNotMatch(free, /class="pbe-mbr-aa/);
  const active = S.active();
  assert.match(active, /You have NFL/); assert.match(active, /NFL PRO ACTIVE/); assert.ok(active.includes(M.MANAGE_URL));
  assert.doesNotMatch(active, /pbe-mbr-aa|nfl-aa-hero|data-pro-plan/);
  assert.equal(S.memberState(proStateFor('all_access')), 'all_access'); assert.equal(S.memberState(proStateFor('owner')), 'owner');
  assert.equal(S.memberState(proStateFor('sport_pro')), 'sport_pro'); assert.equal(S.memberState(proStateFor('free')), 'free');
});

test('polish: the member screen is worded per state and manages a subscription only where one exists', () => {
  for (const state of ['sport_pro', 'all_access', 'owner']) {
    const w = run('paywall-polish-v1.js', proStateFor(state));
    const m = w.PBEProPolish.membership();
    assert.equal(m.state, state); assert.equal(m.label, M.membershipLabel(state, 'nfl'));
    assert.equal(m.show_manage, state !== 'owner');
  }
  const copy = run('paywall-polish-v1.js', proStateFor('sport_pro')).PBEProPolish.MEMBER_COPY;
  assert.equal(copy.sport_pro.title, 'You have NFL PropBetEdge Pro.');
  assert.equal(copy.all_access.title, 'You have PropBetEdge All Access.');
  assert.match(copy.owner.title, /Owner/);
  assert.doesNotMatch(JSON.stringify(copy), /Stripe/);
});

test('footer + paywall account copy: label and plan text come from the contract; Stripe is never a state word', () => {
  const footer = read('network-footer-v1.js');
  assert.match(footer, /data-pbe-footer-manage hidden/); assert.match(footer, /manage\.hidden = !showManage/);
  assert.match(footer, /const showManage = pro && \(member \? m\.show_manage === true : s\.role !== 'owner'\)/);
  assert.doesNotMatch(footer, /Stripe subscription active|secure Stripe billing|Stripe billing/);
  const paywall = read('paywall.js');
  assert.match(paywall, /state\.membership = state\.pro \|\| !membership\.entitled \? membership : readMembership\(null\);/, 'membership never claims more than the access verdict');
  assert.match(paywall, /membership:state\.membership/, 'published in pbe:pro-state');
  assert.doesNotMatch(paywall, /Stripe-backed|Verified NFL Pro subscriber/);
  for (const f of ['paywall.js', 'paywall-funnel-v2.js', 'paywall-polish-v1.js', 'network-footer-v1.js', 'nfl-pro-sales-v1.js', 'sports-shell-auth-state.js']) {
    /* "Secure checkout powered by Stripe" describes the checkout and stays; the banned phrases describe a member's STATE. */
    assert.doesNotMatch(read(f), /Stripe-backed|Stripe subscription active|verified against (your )?Stripe|subscription management powered by Stripe|Checking Stripe/i, f);
  }
});
