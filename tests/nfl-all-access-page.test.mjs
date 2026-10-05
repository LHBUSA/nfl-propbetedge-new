/* NFL-native All Access page + Platinum Member presentation (owner decision
 * 2026-10-05).
 *
 *   offer      $29/month · exactly 10 sports (Golf, F1 Intelligence included)
 *              + PropBetEdge Predictions as a separate intelligence product ·
 *              value line "10 sports + PropBetEdge Predictions." · no stale
 *              eight-sport list, no "Soccer · Soccer".
 *   registry   the hero card and the page network grid are generated from
 *              network-family.json; adding a sport to the registry changes
 *              them or fails here.
 *   links      WHAT'S INCLUDED / ALL ACCESS / network links -> /all-access on
 *              NFL; only GET ALL ACCESS / UPGRADE TO ALL ACCESS use the
 *              existing Stripe Payment Link from the shared contract.
 *   page       a real static page: canonical to itself, no redirect, no
 *              meta refresh, no iframe. States come from /api/auth-session
 *              only; any outage renders the access check, never a sale.
 *   vocabulary all_access -> PLATINUM MEMBER, owner -> VERIFIED OWNER,
 *              sport_pro -> NFL PRO MEMBER (display only; state unchanged).
 *
 *   node --test tests/nfl-all-access-page.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { networkBlock, currentBlock } from '../scripts/build-all-access-page.mjs';

const M = await import('../api/_pbe-membership.js');
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const family = JSON.parse(read('network-family.json'));
const STRIPE = 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function hero() {
  const window = { PBEMembership: M };
  window.window = window;
  vm.runInNewContext(read('nfl-all-access-hero-v1.js'), { window });
  return window.NFLAllAccessHero;
}
function presentation() {
  const window = {};
  window.window = window;
  vm.runInNewContext(read('nfl-member-presentation-v1.js'), { window });
  return window.PBENflMember;
}
function page() {
  const panel = { dataset: {}, innerHTML: '', addEventListener() {}, contains() { return true; }, querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {}, focus() {} };
  const document = { documentElement: { dataset: {} }, getElementById: (id) => (id === 'nflaa-access' ? panel : null), querySelectorAll() { return []; } };
  const window = { PBEMembership: M, addEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false }) };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, URL, setTimeout() { return 0; }, clearTimeout() {}, AbortController, CustomEvent: class { constructor(t) { this.type = t; } }, fetch: () => new Promise(() => {}), location: { reload() {} } });
  for (const f of ['nfl-member-presentation-v1.js', 'nfl-all-access-hero-v1.js', 'nfl-all-access-page-v1.js']) vm.runInContext(read(f), ctx, { filename: f });
  return window.NFLAllAccessPage;
}
const member = (state) => M.deriveMembership({ sport: 'nfl', entitled: true, accessSource: state === 'sport_pro' ? 'sport' : state, productKey: state === 'all_access' ? 'pbe_all_access' : 'nfl_pro', plan: 'monthly', email: `${state}@page.test`, currentPeriodEnd: new Date(Date.now() + 9 * 864e5).toISOString() });
const granted = (state) => ({ valid: true, pro: true, access: 'granted', role: state === 'owner' ? 'owner' : 'subscriber', user: { email: `${state}@page.test` }, membership: member(state), stage: 'ok', degraded: false });

/* ------------------------------------------------------------ the offer, 1-9 */
test('offer: $29/month, exactly 10 sports incl. Golf + F1 Intelligence, Predictions separate, exact value line', () => {
  const H = hero();
  assert.equal(H.offer().price, '$29/month');                                     // 1
  assert.equal(H.FAMILY.sports.length, 10);                                        // 2
  assert.ok(H.SPORT_NAMES.includes('Golf'));                                       // 3
  assert.ok(H.SPORT_NAMES.includes('F1 Intelligence'));                            // 4
  assert.deepEqual([...H.PRODUCT_NAMES], ['PropBetEdge Predictions']);             // 5
  assert.ok(!H.FAMILY.sports.some((s) => /predictions/i.test(`${s.key} ${s.name}`)), 'Predictions is not a sport'); // 6
  assert.equal(H.VALUE_LINE, '10 sports + PropBetEdge Predictions.');              // 7
  const html = text(H.heroHtml({ state: 'free' }));
  assert.ok(html.includes('10 sports + PropBetEdge Predictions.'));
  assert.ok(html.includes('MLB · NFL · NBA · WNBA · NHL · UFC · Tennis · Soccer · Golf · F1 Intelligence'));
  const pg = read('all-access.html');
  assert.ok(text(pg).includes('10 sports + PropBetEdge Predictions.'), 'page headline value');
  assert.match(pg, /<strong>\$29<\/strong><span>\/month<\/span>/);
});

test('no customer-facing NFL file carries the stale offer: eight-sport list, "Soccer · Soccer", "every PropBetEdge sport", old tagline as the value', () => {
  const root = new URL('..', import.meta.url);
  /* The vendored shared contract (pbe-membership.js / api/_pbe-membership.js) is
     copied verbatim from propbetedge-workers; its tagline is upstream's to change. */
  const files = readdirSync(root).filter((f) => /\.(js|html)$/.test(f) && f !== 'pbe-membership.js');
  const eight = /MLB · NFL · NBA · NHL · WNBA · UFC · Tennis · Soccer(?! · Golf)/;               // 8
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, eight, `${f}: stale eight-sport list`);
    assert.doesNotMatch(src, /Soccer · Soccer/, `${f}: duplicated Soccer`);                      // 9
    assert.doesNotMatch(src, /every PropBetEdge sport|every PropBetEdge Pro sport|every Pro sport →|\b(11|eleven) sports\b/i, `${f}: stale or wrong count copy`);
  }
  assert.doesNotMatch(read('nfl-all-access-hero-v1.js'), /esc\(o\.tagline\)/, 'the hero no longer leads with the old tagline');
});

/* ------------------------------------------------------------ registry parity */
test('parity: the hero card and the page grid are generated from network-family.json', () => {
  const H = hero();
  const pick = (e) => ({ key: e.key, label: e.label, name: e.name, url: e.url });
  assert.deepEqual(JSON.parse(JSON.stringify(H.FAMILY)), { sports: family.sports.map(pick), products: family.products.map(pick) }, 'hero FAMILY block == network-family.json (regenerate after a registry change)');
  const html = read('all-access.html');
  assert.equal(currentBlock(html), networkBlock(), 'all-access.html network block is stale: node scripts/build-all-access-page.mjs');
  for (const s of family.sports) assert.ok(html.includes(`data-net-key="${s.key}"`), s.key);
  for (const p of family.products) assert.match(html, new RegExp(`class="nflaa-net-tile is-product" href="${p.url.replace(/[./]/g, '\\$&')}"`));
  assert.equal((html.match(/data-net="sports"/g) || []).length, 1);
  assert.match(html, /<span class="nflaa-k">SPORTS · 10<\/span>/);
  assert.match(html, /data-net-key="nfl" aria-current="page">[\s\S]*?YOU ARE HERE/);
});

/* ------------------------------------------------------------ links 10-11 */
test('links: information stays on NFL (/all-access); only explicit purchase CTAs use the contract Stripe link', () => {
  const H = hero();
  assert.equal(M.ALL_ACCESS_OFFER.checkoutUrl, STRIPE);                                          // 11
  assert.equal(presentation().ALL_ACCESS_CHECKOUT_URL, STRIPE);
  const html = H.heroHtml({ state: 'free' });
  assert.ok(html.includes(`<a class="nfl-aa-learn" href="/all-access" data-nfl-all-access-cta="learn">WHAT'S INCLUDED</a>`)); // 10
  assert.ok(html.includes(`<a class="nfl-aa-cta" href="${STRIPE}"`) && html.includes('>GET ALL ACCESS</a>'));
  /* every Stripe link on the page is an explicit purchase action */
  const pg = read('all-access.html');
  const stripe = [...pg.matchAll(/<a [^>]*href="https:\/\/buy\.stripe\.com[^"]*"[^>]*>([^<]*)<\/a>/g)];
  assert.equal(stripe.length, 1); assert.equal(stripe[0][1], 'GET ALL ACCESS'); assert.match(stripe[0][0], /data-nflaa-checkout/);
  const js = read('nfl-all-access-page-v1.js');
  for (const m of js.matchAll(/href="\$\{esc\(checkoutUrl\(\)\)\}"[^>]*>([^<]*)</g)) assert.match(m[1], /^(GET ALL ACCESS|UPGRADE TO ALL ACCESS)$/);
  for (const f of ['network-footer-v1.js', 'sports-shell-v2.js', 'index.html']) assert.doesNotMatch(read(f), /href="https:\/\/propbetedge\.ai\/pro"|const ALL_ACCESS = 'https:/, f);
});

test('page: a real indexable NFL page -- canonical to itself, no redirect / meta refresh / iframe, consent + footer loaded', () => {
  const html = read('all-access.html');
  const js = read('nfl-all-access-page-v1.js');
  assert.match(html, /<link rel="canonical" href="https:\/\/nfl\.propbetedge\.ai\/all-access">/);
  assert.match(html, /<title>PropBetEdge All Access on NFL — 10 sports \+ PropBetEdge Predictions \| PropBetEdge NFL<\/title>/);
  assert.match(html, /<meta name="robots" content="index,follow/);
  assert.doesNotMatch(html, /http-equiv="refresh"|<iframe|location\.(replace|assign)|window\.location\s*=/i);
  assert.doesNotMatch(js, /location\.(replace|assign|href\s*=)|window\.location\s*=|<iframe/);
  assert.match(html, /<script src="\/pbe-consent-v1\.js"><\/script>/);
  assert.ok(html.indexOf('/pbe-consent-v1.js') < html.indexOf('G-BRS48R8PG9'), 'analytics stays behind the consent runtime');
  assert.match(html, /<script src="\.\/network-footer-v1\.js"><\/script>/);
  assert.match(html, /<main id="main-content">\s*<div id="view-container">/, 'the shared footer mounts after #view-container');
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.cleanUrls, true, 'served at /all-access');
  assert.ok(!vercel.redirects && !vercel.rewrites, 'no redirect or rewrite');
});

/* ------------------------------------------------------------ states + vocabulary 12-14 */
test('vocabulary: all_access -> PLATINUM MEMBER, owner -> VERIFIED OWNER, sport_pro -> NFL PRO MEMBER; never a Platinum plan', () => {
  const P = presentation();
  const aa = P.display(member('all_access'));
  assert.equal(aa.designation, 'PLATINUM MEMBER'); assert.equal(aa.badge, '◆ PLATINUM'); assert.equal(aa.status, 'PLATINUM ACCESS ACTIVE'); // 12
  assert.equal(aa.eyebrow, 'NFL · PLATINUM MEMBER'); assert.equal(aa.product, 'PropBetEdge All Access · 10 sports + Predictions');
  assert.equal(P.display(member('owner')).designation, 'VERIFIED OWNER');                      // 13
  assert.equal(P.display(member('sport_pro')).designation, 'NFL PRO MEMBER');                  // 14
  assert.equal(P.display({ entitled: false, state: 'free' }), null, 'no designation (and never FREE) without access');
  assert.match(P.badgeHtml(member('all_access')), /data-pbe-membership="all_access">◆ PLATINUM</, 'the contract state rides along unchanged');
  for (const f of ['nfl-member-presentation-v1.js', 'nfl-all-access-page-v1.js', 'paywall-funnel-v2.js']) assert.doesNotMatch(read(f), /Platinum plan|PLATINUM PLAN|platinum_/i, f);
});

test('page states come from the server verdict only; outages render the access check, never a sale; members see no purchase CTA', () => {
  const Pg = page();
  const v = Pg.viewFor;
  assert.equal(v({ valid: false, pro: false, access: 'anonymous', user: null }).kind, 'anonymous');
  assert.deepEqual({ ...v({ valid: false, pro: false, access: 'no_entitlement', paywalled: true, user: null, entitlement: { reason: 'expired' } }) }, { kind: 'anonymous', denied: 'expired' });
  for (const s of ['sport_pro', 'all_access', 'owner']) assert.equal(v(granted(s)).kind, s);
  assert.equal(v({ ...granted('sport_pro'), membership: null, role: 'owner' }).kind, 'owner', 'legacy owner flag');
  /* never inferred: pro without granted, granted without pro */
  assert.equal(v({ ...granted('all_access'), access: 'anonymous' }).kind, 'signed_in');
  assert.equal(v({ ...granted('all_access'), pro: false }).kind, 'check');
  for (const bad of [{ valid: true, pro: false, access: 'unavailable', user: { email: 'x@page.test' } }, { valid: true, pro: false, access: 'anonymous', user: { email: 'x@page.test' }, stage: 'entitlement_lookup_failed' }, { valid: false, access: 'unavailable', degraded: true, error: 'session_check_failed' }]) {
    assert.equal(v(bad).kind, 'check', JSON.stringify(bad));
  }
  assert.equal(v({ valid: true }, { httpOk: false }).kind, 'check', 'non-200');
  assert.deepEqual({ ...v(null, { failed: true, priorEmail: 'kept@page.test' }) }, { kind: 'check', email: 'kept@page.test' }, 'a failed refresh keeps the identity');

  const PURCHASE = /buy\.stripe\.com|GET ALL ACCESS|UPGRADE TO ALL ACCESS|\$29/;
  const html = (view) => Pg.markup(view);
  for (const s of ['all_access', 'owner']) assert.doesNotMatch(html(v(granted(s))), PURCHASE, `${s}: no purchase CTA`);
  assert.doesNotMatch(html({ kind: 'check', email: 'x@page.test' }), PURCHASE, 'outage: no sale');
  assert.match(html(v(granted('all_access'))), /PROPBETEDGE ALL ACCESS · PLATINUM MEMBER[\s\S]*Your network<br><em>is unlocked\.<\/em>[\s\S]*◆ PLATINUM[\s\S]*PropBetEdge All Access · active[\s\S]*MANAGE MEMBERSHIP[\s\S]*REFRESH VERIFIED ACCESS/);
  assert.match(html(v(granted('owner'))), /PROPBETEDGE · VERIFIED OWNER[\s\S]*Owner access<br><em>is active\.<\/em>/);
  assert.doesNotMatch(html(v(granted('owner'))), /MANAGE MEMBERSHIP|billing\.stripe\.com/, 'owner: no billing CTA');
  const pro = html(v(granted('sport_pro')));
  assert.match(pro, /NFL PRO MEMBER[\s\S]*Your NFL desk<br><em>is already unlocked\.<\/em>/);
  assert.match(pro, /UPGRADING ADDS/); assert.match(pro, />UPGRADE TO ALL ACCESS</); assert.ok(pro.includes(`href="${STRIPE}"`));
  for (const name of ['MLB', 'NBA', 'WNBA', 'NHL', 'UFC', 'Tennis', 'Soccer', 'Golf', 'F1 Intelligence', '◆ PropBetEdge Predictions']) assert.ok(pro.includes(`>${name}</li>`), name);
  assert.ok(!pro.includes('>NFL</li>'), 'NFL Pro is never sold back to an NFL Pro member');
  const anon = html(v({ valid: false, access: 'anonymous' }));
  assert.match(anon, />GET ALL ACCESS</); assert.match(anon, />SIGN IN</); assert.match(anon, /THEEDGE25/);
  for (const view of [anon, pro, html(v(granted('all_access'))), html(v(granted('owner'))), html({ kind: 'check' }), html({ kind: 'signed_in', email: 'r@page.test' })]) {
    assert.doesNotMatch(text(view), /\bFREE\b/, 'no visible FREE');
  }
});

test('B1 lapsed on /all-access: signed in with the email, RENEW NFL PRO, VIEW ALL ACCESS, SIGN OUT -- never the anonymous sale', () => {
  const Pg = page();
  const lapsed = { valid: true, pro: false, access: 'no_entitlement', paywalled: true, user: { email: 'lapsed@page.test' }, entitlement: { reason: 'expired' }, subscription: null, degraded: false, session_cleared: false };
  const v = Pg.viewFor(lapsed);
  assert.deepEqual({ ...v }, { kind: 'lapsed', email: 'lapsed@page.test', reason: 'expired' });
  const html = Pg.markup(v);
  assert.match(html, /SIGNED IN <b>lapsed@page\.test<\/b>/);
  assert.match(html, /NFL Pro access<br><em>is no longer active\.<\/em>/);
  assert.match(html, /<a class="nflaa-cta" href="\/\?pbe_account=renew" data-nflaa-renew>RENEW NFL PRO<\/a>/);
  assert.match(html, />VIEW ALL ACCESS</); assert.match(html, /data-nflaa-signout>SIGN OUT</);
  assert.doesNotMatch(text(html), /\bFREE\b|GET ALL ACCESS|\$29/);
  /* the old anonymous answer (no identity) still renders the anonymous page */
  assert.equal(Pg.viewFor({ ...lapsed, valid: false, user: null }).kind, 'anonymous');
  /* never-subscribed verified email: not "renew" */
  assert.match(Pg.markup(Pg.viewFor({ ...lapsed, entitlement: { reason: 'no_subscription' } })), />GET NFL PRO</);
});
