/* NFL account surface v3 (2026-10-05): one premium shell, four states, on top
 * of the unchanged passwordless auth + entitlement architecture.
 *
 *   sign-in    a member signing in sees NO purchase clutter: no plans, no
 *              All Access hero, no checkout; one email field and one
 *              "Send secure sign-in link" action against the auth Worker
 *   auth       passwordless only: no password field, no OAuth provider
 *   free       the internal state name FREE is never shown to a customer
 *   members    owner / All Access: no purchase CTA; owner: no manage link;
 *              NFL Pro: the All Access upgrade only when the shared contract
 *              says show_all_access_upgrade; every unlocked tile opens a route
 *              this app actually registers
 *   degraded   identity shown, no price, Retry + Sign out
 *   visual     a real /stadiums asset (CC0), no remote stock imagery
 *   shell      header "Sign In" opens member sign-in; paywall.js announces the
 *              open reason; terminal sheet loaded after the hero sheet; warm
 *              palette only; inputs >= 16px; controls >= 44px on phones
 *
 *   node --test tests/nfl-account-v3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const M = await import('../api/_pbe-membership.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const paywallSrc = read('paywall.js');
const PRICING = new Function(`${paywallSrc.slice(paywallSrc.indexOf('const PRICING = Object.freeze({'), paywallSrc.indexOf('window.PBEPricing = PRICING;'))}; return PRICING;`)();
const END = new Date(Date.now() + 9 * 86400000).toISOString();

function fakeElement() {
  const el = { style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', classList: { add() {}, toggle() {}, remove() {}, contains() { return false; } } };
  Object.assign(el, { setAttribute() {}, appendChild() {}, before() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentElement() {}, insertAdjacentHTML() {}, addEventListener() {}, closest() { return null; } });
  return el;
}
function run(files, proState) {
  const document = { readyState: 'complete', body: fakeElement(), head: fakeElement(), documentElement: fakeElement(), addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: fakeElement };
  const listeners = {};
  const window = { PBEPricing: PRICING, PBEMembership: M, PBEPro: { state: proState, open() {}, close() {}, paintNotice() {}, refreshAccess: async () => false, denialNote() { return ''; } }, App: {}, location: { href: 'https://nfl.propbetedge.ai/', search: '' }, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, dispatchEvent() {}, matchMedia: () => ({ matches: false }) };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, URL, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() { return 0; }, queueMicrotask() {}, MutationObserver: class { observe() {} }, CustomEvent: class {}, KeyboardEvent: class {}, localStorage: { getItem() { return null; }, setItem() {} }, fetch: async () => ({}), location: window.location });
  for (const file of files) vm.runInContext(read(file), ctx, { filename: file });
  window.__listeners = listeners;
  return window;
}
const member = (state, over = {}) => M.deriveMembership({ sport: 'nfl', entitled: state !== 'free', accessSource: state === 'free' ? null : state === 'sport_pro' ? 'sport' : state, productKey: state === 'all_access' ? 'pbe_all_access' : 'nfl_pro', plan: state === 'sport_pro' ? 'founding_monthly' : state === 'all_access' ? 'all_access' : state === 'owner' ? 'owner' : null, email: state === 'free' ? null : `${state}@acct.test`, currentPeriodEnd: state === 'free' ? null : END, ...over });
const proStateFor = state => ({ loading: false, pro: state !== 'free', access: state === 'free' ? 'anonymous' : 'granted', role: state === 'owner' ? 'owner' : state === 'free' ? null : 'subscriber', user: state === 'free' ? null : { email: `${state}@acct.test` }, subscription: state === 'free' ? null : { current_period_end: END, cancel_at_period_end: false }, membership: member(state), entitlement: null });
const FILES = ['nfl-member-presentation-v1.js', 'nfl-all-access-hero-v1.js', 'paywall-funnel-v2.js'];
/* what a customer reads: tags and attribute values stripped */
const visible = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const PURCHASE = /data-funnel-plan=|buy\.stripe\.com|nfl-aa-hero|data-nfl-all-access|pbe-funnel-checkout|Unlock NFL Pro|GET ALL ACCESS/;

test('sign-in: its own state, one email + one secure-link action, no purchase clutter', () => {
  const F = run(FILES, proStateFor('free')).PBECheckoutFunnel.markup;
  const html = F.signIn();
  assert.match(html, /data-funnel-state="signed-out" data-funnel-view="signin" data-membership="free"/);
  assert.match(html, /VERIFIED MEMBER ACCESS/); assert.match(html, /Welcome back\./);
  assert.match(html, /Sign in with the email attached to your PropBetEdge access\./);
  assert.match(html, /<label class="pbe-acct-label" for="pbe-funnel-email">Email address<\/label>/);
  assert.match(html, /id="pbe-funnel-send-link" type="submit">Send secure sign-in link</);
  assert.match(html, /Passwordless secure access\.<\/b> No password required\./);
  assert.match(html, /Need access\?<\/span><button[^>]*id="pbe-funnel-show-join"[^>]*>View membership options</);
  assert.match(html, /PBE Picks · PBE Algo · Player DNA · PBEcast · Model \+ Market · Track Record/);
  assert.doesNotMatch(html, PURCHASE, 'a member signing in is not shown a checkout');
  assert.doesNotMatch(html, /\$\d/, 'no price on the sign-in view');
  assert.equal((html.match(/<input/g) || []).length, 1, 'exactly one field');
});

test('sign-in request: the existing auth Worker, one request per submit, button locked while in flight', () => {
  const src = read('paywall-funnel-v2.js');
  assert.match(src, /const AUTH_WORKER = 'https:\/\/propbetedge-nfl-auth\.sales-fd3\.workers\.dev';/);
  assert.match(src, /fetch\(`\$\{AUTH_WORKER\}\/v1\/auth\/request`/);
  assert.match(src, /body: JSON\.stringify\(\{ email, purpose: 'signin' \}\)/);
  assert.match(src, /if \(linkRunning\) return;/);
  assert.match(src, /form\.onsubmit = event => \{ event\.preventDefault\(\); signInExisting\(\); \};/, 'assigned, never stacked');
  assert.doesNotMatch(src, /addEventListener\('submit'/);
});

test('passwordless only: no password field and no OAuth provider anywhere on the account surface', () => {
  for (const f of ['paywall-funnel-v2.js', 'paywall.js', 'sports-shell-auth-state.js', 'nfl-account-v3.css']) {
    const src = read(f);
    assert.doesNotMatch(src, /type="password"|autocomplete="(current|new)-password"/i, f);
    assert.doesNotMatch(src, /google|facebook|apple id|oauth|(sign in|continue) with (google|facebook|apple)/i, f);
  }
});

test('get access: value first, All Access hero, ONLY WANT NFL?, NFL plans from window.PBEPricing, "Already a member? Sign in"', () => {
  const F = run(FILES, proStateFor('free')).PBECheckoutFunnel.markup;
  const html = F.signedOut();
  assert.match(html, /data-funnel-view="join"/);
  const hero = html.indexOf('data-nfl-all-access="hero"'); const divider = html.indexOf('data-nfl-all-access="divider"');
  const monthly = html.indexOf('data-funnel-plan="monthly"'); const checkout = html.indexOf('id="pbe-funnel-checkout"'); const member = html.indexOf('id="pbe-funnel-show-signin"');
  assert.ok(hero > -1 && divider > hero && monthly > divider && checkout > monthly && member > checkout);
  assert.match(html, /Already a member\?<\/span><button[^>]*>Sign in</);
  assert.ok(html.includes(`<strong>${PRICING.monthly.price}</strong>`) && html.includes(`<strong>${PRICING.weekly.price}</strong>`));
  assert.doesNotMatch(read('paywall-funnel-v2.js'), /\$9\.99|\$3\.99|\$29/, 'no price constant restated in the funnel');
  /* the story column leads with value */
  const story = F.story('join');
  assert.match(story, /PROPBETEDGE NFL · INTELLIGENCE BUILT TO BE GRADED/);
  assert.match(story, /The pick is only<br><em>the beginning\.<\/em>/);
  for (const name of ['PBE Algo', 'Official PBE Picks', 'Player DNA', 'Model \\+ Market', 'PBEcast', 'Track Record', 'Game Center', 'Simulation \\+ Research']) assert.match(story, new RegExp(`<b>${name}</b>`));
});

test('the internal FREE state is never customer-facing in any rendered state', () => {
  const free = run(FILES, proStateFor('free')).PBECheckoutFunnel.markup;
  const views = [free.signedOut(), free.signIn(), free.signedInFree('reader@acct.test'), free.story('join'), free.story('signin'), free.story('check')];
  for (const state of ['sport_pro', 'all_access', 'owner']) {
    const w = run(FILES, proStateFor(state));
    views.push(w.PBECheckoutFunnel.markup.active(`${state}@acct.test`, { current_period_end: END }, state === 'owner'), w.PBECheckoutFunnel.markup.story('member'));
  }
  views.push(run(['sports-shell-auth-state.js'], proStateFor('free')).PBEShellAuthState.degradedMarkup({ user: { email: 'm@acct.test' }, error: 'Access check degraded (x).' }));
  for (const html of views) assert.doesNotMatch(visible(html), /\bFREE\b|Free access/);
});

test('signed in without access: the account is acknowledged, then the options', () => {
  const html = run(FILES, { ...proStateFor('free'), user: { email: 'reader@acct.test' } }).PBECheckoutFunnel.markup.signedInFree('reader@acct.test');
  assert.match(html, /<span>SIGNED IN<\/span><strong>reader@acct\.test<\/strong>/);
  assert.match(html, /Your account is ready\.<br>Choose your access\./);
  assert.match(html, /id="pbe-funnel-signout"/);
  assert.ok(html.indexOf('SIGNED IN') < html.indexOf('data-nfl-all-access="hero"'));
});

test('members: owner / All Access / NFL Pro dashboards with truthful status and no stray purchase or manage CTAs', () => {
  const owner = run(FILES, proStateFor('owner')).PBECheckoutFunnel.markup.active('owner@acct.test', null, true);
  assert.match(owner, /NFL · VERIFIED OWNER/); assert.match(owner, /Owner access is active\./); assert.match(owner, /is-owner[^>]*>VERIFIED OWNER</);
  assert.doesNotMatch(owner, PURCHASE); assert.doesNotMatch(owner, /pbe-mbr-manage|Manage/);
  assert.match(owner, /Every NFL Pro feature · no subscription required/);

  const all = run(FILES, proStateFor('all_access')).PBECheckoutFunnel.markup.active('all_access@acct.test', { current_period_end: END }, false);
  /* all_access is PRESENTED as Platinum Member; the contract state is untouched */
  assert.match(all, /NFL · PLATINUM MEMBER/); assert.match(all, /Your full NFL desk<br><em>is unlocked\.<\/em>/);
  assert.match(all, /data-membership="all_access"/); assert.match(all, /is-all_access is-platinum[^>]*>◆ PLATINUM</);
  assert.match(all, /PropBetEdge All Access · 10 sports \+ Predictions/); assert.match(all, /PLATINUM ACCESS ACTIVE/);
  assert.match(all, /Your PropBetEdge All Access membership unlocks the full network — 10 sports plus PropBetEdge Predictions\./);
  assert.doesNotMatch(all, /Platinum plan|PLATINUM PLAN|FREE/);
  assert.doesNotMatch(all, PURCHASE);
  assert.ok(all.includes(`class="pbe-mbr-manage" href="${M.MANAGE_URL}"`)); assert.match(all, />Manage membership ↗</);
  assert.match(all, /class="pbe-acct-network"><span>YOUR NETWORK<\/span><a class="pbe-acct-network-link" href="\/all-access"/, 'the network link stays on NFL');

  const pro = run(FILES, proStateFor('sport_pro')).PBECheckoutFunnel.markup;
  const withUpgrade = pro.active('sport_pro@acct.test', { current_period_end: END }, false, member('sport_pro'));
  assert.match(withUpgrade, /NFL PRO MEMBER/); assert.doesNotMatch(withUpgrade, /PLATINUM/); assert.match(withUpgrade, /UPGRADE TO ALL ACCESS/);
  assert.doesNotMatch(withUpgrade, /data-funnel-plan=|pbe-funnel-checkout|Unlock NFL Pro/);
  const noFlag = pro.active('sport_pro@acct.test', { current_period_end: END }, false, { ...member('sport_pro'), show_all_access_upgrade: false });
  assert.doesNotMatch(noFlag, /UPGRADE TO ALL ACCESS|nfl-aa-hero/, 'the upgrade follows the shared contract flag');

  for (const html of [owner, all, withUpgrade]) {
    assert.match(html, /id="pbe-funnel-open-board" type="button">Open Pro Prop Board</);
    assert.match(html, /id="pbe-funnel-refresh" type="button">Refresh verified access</);
    assert.match(html, /<small>Verified account<\/small>/);
  }
});

test('every unlocked tile opens a route this app registers', () => {
  const html = run(FILES, proStateFor('owner')).PBECheckoutFunnel.markup.active('owner@acct.test', null, true);
  const routes = [...html.matchAll(/data-acct-route="([a-z0-9]+)"/g)].map(m => m[1]);
  assert.equal(routes.length, 9);
  const sources = readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.js')).map(read).join('\n');
  for (const route of routes) assert.match(sources, new RegExp(`VIEWS\\.${route}\\s*=`), route);
});

test('degraded: identity, no price, no unsubscribed claim, Retry + Sign out', () => {
  const S = run(['sports-shell-auth-state.js'], proStateFor('free')).PBEShellAuthState;
  const html = S.degradedMarkup({ user: { email: 'member@acct.test' }, error: 'Access check degraded (entitlement_503).' });
  assert.match(html, /data-pbe-auth-degraded="1"/);
  assert.match(html, /Signed in — access check temporarily unavailable/);
  assert.match(html, /member@acct\.test/);
  assert.match(html, /data-pbe-auth-retry>Retry access check</); assert.match(html, /data-pbe-auth-signout>Sign out</);
  assert.doesNotMatch(html, /\$\d|data-funnel-plan|buy\.stripe\.com|Upgrade/);
  assert.equal(S.accountLabel({ user: { email: 'member@acct.test' }, stage: 'entitlement_lookup_failed', degraded: true }), 'Access Check');
});

test('visual: a real CC0 stadium asset from /stadiums, no remote stock imagery, no league or team marks', () => {
  const src = read('paywall-funnel-v2.js');
  for (const file of ['lambeau-bgsm.webp', 'lambeau-bg.webp']) {
    assert.match(src, new RegExp(`'/stadiums/${file.replace('.', '\\.')}'`));
    assert.ok(existsSync(new URL(`../stadiums/${file}`, import.meta.url)), file);
  }
  assert.match(read('stadium-selector-v1.js'), /file:'lambeau'[^}]*licence:'CC0'/);
  const imgs = [...src.matchAll(/https?:\/\/[^'"`\s)]+\.(?:png|jpe?g|webp|svg)/g)].map(m => m[0]);
  assert.deepEqual(imgs, ['https://propbetedge.ai/logo/pbe-full-400.png'], 'only the PropBetEdge mark is remote');
  assert.doesNotMatch(src + read('nfl-account-v3.css'), /teamlogos|shield|unsplash|pexels|gettyimages/i);
});

test('shell: header Sign In opens member sign-in; paywall announces the reason; signOut is exported; listeners are not stacked', () => {
  assert.match(read('sports-shell-v2.js'), /window\.PBEPro\.open\('account'\)/);
  assert.match(paywallSrc, /window\.dispatchEvent\(new CustomEvent\('pbe:pro-open',\{ detail:\{ reason:String\(reason \|\| ''\) \} \}\)\);\r?\n    renderModal\(\);/);
  assert.match(paywallSrc, /    refreshAccess,\r?\n    signOut,/);
  const funnel = read('paywall-funnel-v2.js');
  assert.match(funnel, /const SIGNIN_REASONS = new Set\(\['account', 'signin', 'auth-failed', 'auth-incomplete', 'checkout-success'\]\);/);
  /* the open event picks the view; the next render honours it */
  const w = run(FILES, proStateFor('free'));
  assert.equal(w.__listeners['pbe:pro-open']?.length, 1, 'one open listener');
  assert.equal(w.__listeners.pageshow?.length, 1, 'back/forward cache release');
  /* the surface is re-wired by property assignment, never addEventListener */
  const wire = funnel.slice(funnel.indexOf('function wire(host)'), funnel.indexOf('function mountPurchaseState()'));
  assert.doesNotMatch(wire, /addEventListener/);
  /* older layers stand down for the v3 shell */
  assert.match(read('paywall-polish-v1.js'), /if\(pitch\.closest\('\.pbe-acct'\)\)return;/);
  assert.match(read('paywall-polish-v1.js'), /if\(root\.dataset\.acct==='v3'\)return;/);
  assert.match(read('nfl-pro-sales-v1.js'), /if \(root\.dataset\.acct === 'v3'\)/);
});

test('sheet: loaded after the hero sheet, warm palette only, 16px inputs, 44px phone controls, one scroll context', () => {
  const loader = read('page-loader.js');
  const hero = loader.indexOf("{css:'./nfl-all-access-hero-v1.css'}"); const acct = loader.indexOf("{css:'./nfl-account-v3.css'}");
  assert.ok(hero > -1 && acct > hero, 'terminal after the hero sheet');
  const css = read('nfl-account-v3.css');
  /* no navy / blue / cold grey: no colour where blue leads (the verified
     green #7fe0a4 is green-led: the brief's verified/unlocked colour) */
  const cold = (r, g, b) => b > r && b >= g;
  for (const hex of css.match(/#[0-9a-f]{6}\b/gi) || []) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!cold(r, g, b), `cold colour ${hex}`);
  }
  for (const rgba of css.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) || []) {
    const [r, g, b] = rgba.replace('rgba(', '').split(',').map(Number);
    assert.ok(!cold(r, g, b), `cold colour ${rgba}`);
  }
  assert.match(css, /\.pbe-acct \.pbe-pro-email\{[^}]*font:500 16px/);
  assert.match(css, /@media \(max-width:900px\)\{[\s\S]*\.pbe-acct \.pbe-funnel-signin-link\{min-height:44px\}|\.pbe-acct \.pbe-funnel-signin-link\{[^}]*min-height:44px/);
  assert.match(css, /#pbe-pro-backdrop \.pbe-acct #pbe-funnel-refresh,#pbe-pro-backdrop \.pbe-acct \.pbe-mbr-manage,#pbe-pro-backdrop \.pbe-acct \.pbe-pro-cta\.secondary\{min-height:46px!important\}/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.doesNotMatch(css, /overflow(?:-y)?\s*:\s*(?:auto|scroll)/, 'the backdrop stays the one scroll context');
});

/* ------------------------------------------------------------ B1: lapsed readers stay signed in */
const lapsedState = (reason) => ({ ...proStateFor('free'), access: 'no_entitlement', user: { email: 'lapsed@acct.test' }, entitlement: { reason } });

test('B1 lapsed: SIGNED IN + email, "NFL Pro access is no longer active.", RENEW NFL PRO, VIEW ALL ACCESS -> /all-access, SIGN OUT; no FREE, no anonymous view', () => {
  for (const reason of ['expired', 'canceled', 'payment_failed']) {
    const s = lapsedState(reason);
    const w = run(FILES, s);
    const html = w.PBECheckoutFunnel.markup.signedInFree('lapsed@acct.test');
    assert.match(html, /data-funnel-view="lapsed"/, reason);
    assert.match(html, /<span>SIGNED IN<\/span><strong>lapsed@acct\.test<\/strong>/);
    assert.match(html, /NFL Pro access<br>is no longer active\./);
    assert.match(html, /id="pbe-funnel-checkout" type="button" data-funnel-renew="1"/, 'the primary action is the existing NFL Pro checkout, labelled Renew');
    assert.match(html, /data-funnel-plan="monthly"/); assert.match(html, /data-funnel-plan="weekly"/);
    assert.match(html, /<a class="pbe-pro-cta secondary" href="\/all-access" data-nfl-all-access-cta="view">View All Access<\/a>/);
    assert.match(html, /id="pbe-funnel-signout" type="button">Sign out</);
    assert.doesNotMatch(html, /\bFREE\b|Choose your access|Welcome back|View membership options/);
    assert.doesNotMatch(html, /pbe-funnel-email/, 'no email field: renewal is tied to the verified email');
  }
  /* the renew label comes from the same selection painter as Unlock NFL Pro */
  const funnel = read('paywall-funnel-v2.js');
  assert.match(funnel, /btn\.dataset\.funnelRenew === '1' \? 'Renew NFL Pro' : 'Unlock NFL Pro'/);
  /* a verified email that never had NFL Pro is told the truth: not "renew" */
  const never = run(FILES, lapsedState('no_subscription')).PBECheckoutFunnel.markup.signedInFree('lapsed@acct.test');
  assert.match(never, /data-funnel-view="inactive"/); assert.match(never, /NFL Pro isn’t active<br>on this account\./); assert.match(never, /data-funnel-renew="0"/);
  assert.doesNotMatch(never, /no longer active/);
});

test('B1 lapsed: the header reads Renew; paywall.js keeps the verified identity while pro still requires granted', () => {
  const w = run(['sports-shell-auth-state.js'], proStateFor('free'));
  assert.equal(w.PBEShellAuthState.accountLabel(lapsedState('expired')), 'Renew');
  const paywall = read('paywall.js');
  assert.doesNotMatch(paywall, /if \(access === 'no_entitlement'\) \{ state\.session = null; state\.user = null; \}/);
  assert.match(paywall, /state\.pro = Boolean\(valid && payload\?\.pro === true && access === 'granted'\);/);
  assert.match(paywall, /params\.get\('pbe_account'\) !== 'renew'/, '/all-access hands the reader back to the account sheet');
});
