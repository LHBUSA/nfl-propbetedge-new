/* ALL ACCESS is the PRIMARY offer; NFL Pro is the single-sport alternative
 * (P0 commercial UX correction, 2026-09-24).
 *
 *   order     FREE readers see the ALL ACCESS hero FIRST, then "ONLY WANT
 *             NFL?", then NFL PRO · MONTHLY $9.99 and NFL PRO · WEEKLY $3.99 --
 *             in the purchase funnel AND on the homepage sales band. All
 *             Access is never rendered beneath the NFL plans again.
 *   facts     $29/month · THEEDGE25 · GET ALL ACCESS -> the exact Stripe
 *             Payment Link · WHAT'S INCLUDED -> propbetedge.ai/pro · no Labs.
 *   states    sport_pro -> UPGRADE TO ALL ACCESS, no NFL purchase;
 *             all_access / owner -> no purchase CTA at all.
 *   billing   NFL monthly/weekly price ids and Payment Links unchanged.
 *   scroll    no stylesheet (or index.html) leaves .pbe-pro-modal with
 *             overflow auto/scroll; the terminal sheet makes it visible.
 *   nav       ALL ACCESS is first-class: shell top bar (desktop), bottom tab
 *             bar (phones), drawer; footer carries ALL ACCESS + WHAT'S INCLUDED.
 *
 *   node --test tests/nfl-all-access-hero.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';

const M = await import('../api/_pbe-membership.js');
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const STRIPE_ALL_ACCESS = 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N';
const LEARN = 'https://propbetedge.ai/pro';
const NFL_MONTHLY = { priceId: 'price_1UEWAXF3CaVzg4ORGlsgboLq', url: 'https://buy.stripe.com/eVqeVd1rUcyG5tz2gb7wA0y', price: '$9.99' };
const NFL_WEEKLY = { priceId: 'price_1UEWAOF3CaVzg4ORjkWpwOz9', url: 'https://buy.stripe.com/9B628rb2udCK5tzf2X7wA0x', price: '$3.99' };

const paywallSrc = read('paywall.js');
const PRICING = new Function(`${paywallSrc.slice(paywallSrc.indexOf('const PRICING = Object.freeze({'), paywallSrc.indexOf('window.PBEPricing = PRICING;'))}; return PRICING;`)();
const END = new Date(Date.now() + 9 * 86400000).toISOString();

function fakeElement() {
  const el = { style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', classList: { add() {}, toggle() {}, remove() {} } };
  Object.assign(el, { setAttribute() {}, appendChild() {}, before() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentElement() {}, insertAdjacentHTML() {}, addEventListener() {}, closest() { return null; } });
  return el;
}
function run(files, proState, { membership = M } = {}) {
  const document = { readyState: 'complete', body: fakeElement(), head: fakeElement(), documentElement: fakeElement(), addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: fakeElement };
  const window = { PBEPricing: PRICING, PBEPro: { state: proState, open() {}, close() {}, paintNotice() {}, refreshAccess: async () => false, denialNote() { return ''; } }, App: {}, location: { href: 'https://nfl.propbetedge.ai/', search: '' }, addEventListener() {}, dispatchEvent() {} };
  if (membership) window.PBEMembership = membership;
  window.window = window;
  const ctx = vm.createContext({ window, document, console, URL, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() { return 0; }, queueMicrotask() {}, MutationObserver: class { observe() {} }, CustomEvent: class {}, KeyboardEvent: class {}, localStorage: { getItem() { return null; }, setItem() {} }, fetch: async () => ({}), location: window.location });
  for (const file of files) vm.runInContext(read(file), ctx, { filename: file });
  return window;
}
const member = state => M.deriveMembership({ sport: 'nfl', entitled: state !== 'free', accessSource: state === 'free' ? null : state === 'sport_pro' ? 'sport' : state, productKey: state === 'all_access' ? 'pbe_all_access' : 'nfl_pro', plan: state === 'sport_pro' ? 'founding_monthly' : state === 'all_access' ? 'all_access' : state === 'owner' ? 'owner' : null, email: state === 'free' ? null : `${state}@hero.test`, currentPeriodEnd: state === 'free' ? null : END });
const proStateFor = state => ({ loading: false, pro: state !== 'free', access: state === 'free' ? 'anonymous' : 'granted', role: state === 'owner' ? 'owner' : state === 'free' ? null : 'subscriber', user: state === 'free' ? null : { email: `${state}@hero.test` }, subscription: state === 'free' ? null : { current_period_end: END, cancel_at_period_end: false }, membership: member(state), entitlement: null });
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const PURCHASE_CTA = /data-funnel-plan=|buy\.stripe\.com|Unlock NFL Pro|pbe-mbr-aa|Get All Access|GET ALL ACCESS|nfl-aa-hero|data-nfl-all-access|pbe-funnel-checkout|data-pro-plan/;

/* ------------------------------------------------------------ the hero module */
test('hero: exact copy and destinations, from the shared contract and from the byte-identical fallback', () => {
  for (const membership of [M, null]) {
    const w = run(['nfl-all-access-hero-v1.js'], proStateFor('free'), { membership });
    const H = w.NFLAllAccessHero;
    assert.equal(H.offer().checkoutUrl, STRIPE_ALL_ACCESS); assert.equal(H.offer().price, '$29/month'); assert.equal(H.offer().promoCode, 'THEEDGE25');
    const html = H.heroHtml(member('free'));
    assert.match(html, /class="nfl-aa-hero is-modal" data-nfl-all-access="hero"/);
    assert.match(html, /<span class="nfl-aa-eyebrow">PROPBETEDGE NETWORK<\/span>/);
    assert.match(html, /<h3 class="nfl-aa-title">ALL ACCESS<\/h3>/);
    assert.match(html, /BEST VALUE · MOST COMPLETE/);
    assert.ok(text(html).includes('$29/month'), 'the price reads $29/month');
    assert.ok(text(html).includes('Every current and future PropBetEdge Pro sport.'));
    assert.ok(text(html).includes('MLB · NFL · NBA · NHL · WNBA · UFC plus every Pro sport added next.'));
    assert.ok(text(html).includes('Launch offer: 25% off while active with code THEEDGE25'));
    assert.ok(html.includes(`<a class="nfl-aa-cta" href="${STRIPE_ALL_ACCESS}" rel="noopener" data-pbe-placement="all_access_checkout" data-nfl-all-access-cta="checkout">GET ALL ACCESS</a>`), 'GET ALL ACCESS links to exactly the live Payment Link');
    assert.ok(html.includes(`<a class="nfl-aa-learn" href="${LEARN}" rel="noopener" data-nfl-all-access-cta="learn">WHAT'S INCLUDED</a>`));
    assert.doesNotMatch(html, /Labs|computational/i, 'Labs / future computational products are never sold as included');
    assert.match(H.dividerHtml(), /data-nfl-all-access="divider"[^>]*><span>ONLY WANT NFL\?<\/span>/);
    /* upgrade heading for NFL Pro members; nothing for All Access / owner */
    assert.match(H.heroHtml(member('sport_pro')), /class="nfl-aa-hero is-modal is-upgrade"[\s\S]*<h3 class="nfl-aa-title">UPGRADE TO ALL ACCESS<\/h3>/);
    assert.equal(H.heroHtml(member('all_access')), ''); assert.equal(H.heroHtml(member('owner')), '');
    assert.equal(H.miniHtml(member('all_access')), ''); assert.ok(H.miniHtml(member('free')).includes(STRIPE_ALL_ACCESS));
  }
  assert.ok(readFileSync(new URL('../api/_pbe-membership.js', import.meta.url)).equals(readFileSync(new URL('../pbe-membership.js', import.meta.url))), 'the shared contract copy is untouched');
});

/* ------------------------------------------------------------ the purchase funnel */
test('funnel: FREE -> hero FIRST, then ONLY WANT NFL?, then NFL PRO MONTHLY $9.99 / WEEKLY $3.99 (signed out and signed in)', () => {
  const w = run(['nfl-all-access-hero-v1.js', 'paywall-funnel-v2.js'], proStateFor('free'));
  const F = w.PBECheckoutFunnel.markup;
  for (const html of [F.signedOut(), F.signedInFree('reader@hero.test')]) {
    const hero = html.indexOf('data-nfl-all-access="hero"');
    const divider = html.indexOf('data-nfl-all-access="divider"');
    const monthly = html.indexOf('data-funnel-plan="monthly"');
    const weekly = html.indexOf('data-funnel-plan="weekly"');
    const cta = html.indexOf('id="pbe-funnel-checkout"');
    assert.ok(hero > -1 && divider > hero && monthly > divider && weekly > monthly && cta > weekly, 'hero -> ONLY WANT NFL? -> monthly -> weekly -> NFL checkout');
    assert.ok(html.lastIndexOf('data-nfl-all-access="hero"') === hero, 'exactly one hero');
    assert.ok(html.includes(`href="${STRIPE_ALL_ACCESS}"`) && html.includes('GET ALL ACCESS'));
    assert.ok(text(html).includes('$29/month') && text(html).includes('THEEDGE25'));
    assert.match(html, /NFL PRO · MONTHLY/); assert.match(html, /NFL PRO · WEEKLY/);
    assert.ok(html.includes('<strong>$9.99</strong><span>/ month</span>') && html.includes('<strong>$3.99</strong><span>/ week</span>'), 'NFL prices unchanged');
    assert.doesNotMatch(html, /class="pbe-mbr-aa/, 'the contract card (fallback) is not rendered when the hero is');
    assert.doesNotMatch(html, /Labs/i);
  }
  /* the hero module absent -> the shared card is the fallback, still above the plans */
  const f = run(['paywall-funnel-v2.js'], proStateFor('free')).PBECheckoutFunnel.markup.signedOut();
  assert.ok(f.indexOf('class="pbe-mbr-aa') > -1 && f.indexOf('class="pbe-mbr-aa') < f.indexOf('data-funnel-plan="monthly"'), 'fallback card sits above the NFL plans too');
});

test('funnel: sport_pro -> active NFL membership + UPGRADE TO ALL ACCESS, no NFL purchase; all_access / owner -> no purchase CTA', () => {
  const pro = run(['nfl-all-access-hero-v1.js', 'paywall-funnel-v2.js'], proStateFor('sport_pro')).PBECheckoutFunnel.markup.active('sport_pro@hero.test', { current_period_end: END }, false);
  assert.match(pro, /NFL PRO ACTIVE/); assert.match(pro, /UPGRADE TO ALL ACCESS/); assert.ok(pro.includes(STRIPE_ALL_ACCESS));
  assert.doesNotMatch(pro, /data-funnel-plan=|pbe-funnel-checkout|Unlock NFL Pro|ONLY WANT NFL/);
  for (const [state, owner] of [['all_access', false], ['owner', true]]) {
    const html = run(['nfl-all-access-hero-v1.js', 'paywall-funnel-v2.js'], proStateFor(state)).PBECheckoutFunnel.markup.active(`${state}@hero.test`, owner ? null : { current_period_end: END }, owner);
    assert.match(html, new RegExp(`data-membership="${state}"`));
    assert.doesNotMatch(html, PURCHASE_CTA, `${state}: no purchase CTA`);
  }
});

test('home sales: FREE -> hero band FIRST, then ONLY WANT NFL?, then the NFL plan buttons; sidebar mini leads with All Access', () => {
  const w = run(['nfl-all-access-hero-v1.js', 'nfl-pro-sales-v1.js'], proStateFor('free'));
  const free = w.NFLProSalesV1.markup.sales();
  const hero = free.indexOf('class="nfl-aa-hero is-home"'); const divider = free.indexOf('data-nfl-all-access="divider"'); const grid = free.indexOf('class="pbeprosell-grid"'); const monthly = free.indexOf('data-pro-plan="monthly"');
  assert.ok(hero > -1 && divider > hero && grid > divider && monthly > grid, 'hero -> ONLY WANT NFL? -> NFL pitch + plans');
  assert.ok(free.includes(STRIPE_ALL_ACCESS) && free.includes('GET ALL ACCESS') && text(free).includes('THEEDGE25'));
  assert.match(free, /class="nfl-aa-home-price"><strong>\$29<\/strong>/);
  assert.doesNotMatch(free.slice(monthly), /nfl-aa-hero|pbe-mbr-aa/, 'nothing about All Access is rendered after the NFL plans');
  assert.doesNotMatch(w.NFLProSalesV1.markup.active(), /nfl-aa-hero|pbe-mbr-aa|data-pro-plan/);
  const sales = read('nfl-pro-sales-v1.js');
  const sidebar = sales.slice(sales.indexOf('function sidebarMarkup'), sales.indexOf('function mountSidebar'));
  assert.ok(sidebar.indexOf('${allAccessMini()}') > -1 && sidebar.indexOf('${allAccessMini()}') < sidebar.indexOf('data-pro-plan="monthly">Unlock PBE Picks'), 'the sidebar card leads with All Access');
  assert.match(sales, /features\.insertAdjacentElement\('afterend', note\)/, 'the releases note lives in the pitch column, not between the reader and the plans');
});

/* ------------------------------------------------------------ billing unchanged */
test('NFL monthly / weekly Stripe destinations and price ids are unchanged', () => {
  assert.equal(PRICING.monthly.priceId, NFL_MONTHLY.priceId); assert.equal(PRICING.monthly.url, NFL_MONTHLY.url); assert.equal(PRICING.monthly.price, NFL_MONTHLY.price);
  assert.equal(PRICING.weekly.priceId, NFL_WEEKLY.priceId); assert.equal(PRICING.weekly.url, NFL_WEEKLY.url); assert.equal(PRICING.weekly.price, NFL_WEEKLY.price);
  assert.equal(M.ALL_ACCESS_OFFER.checkoutUrl, STRIPE_ALL_ACCESS);
  assert.doesNotMatch(read('nfl-all-access-hero-v1.js'), /stripe\.com\/(?!8x2eVdgmOaqy4pv8Ez7wA0N)/, 'the hero knows exactly one Stripe link');
});

/* ------------------------------------------------------------ zero internal scrollbars */
function modalBlocks(css) {
  /* every declaration block whose selector list names .pbe-pro-modal itself */
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(',').map(s => s.trim());
    if (selectors.some(s => /(^|[\s>+~])\.pbe-pro-modal(?![\w-])/.test(s))) out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}
test('no stylesheet leaves .pbe-pro-modal with an internal scrollbar; the terminal sheet makes it overflow:visible with no max-height', () => {
  const sheets = readdirSync(new URL('..', import.meta.url)).filter(f => f.endsWith('.css'));
  assert.ok(sheets.length > 40);
  const inline = [...read('index.html').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x => x[1]).join('\n');
  let seen = 0;
  for (const [name, css] of [...sheets.map(f => [f, read(f)]), ['index.html <style>', inline]]) {
    for (const block of modalBlocks(css)) {
      seen++;
      assert.doesNotMatch(block.body, /overflow(?:-y|-x)?\s*:\s*(?:auto|scroll)/i, `${name}: ${block.selector} scrolls internally`);
      assert.doesNotMatch(block.body, /max-height\s*:\s*(?:min\(|calc\(|\d)/i, `${name}: ${block.selector} caps the card height (which forces a scrollbar)`);
    }
  }
  assert.ok(seen >= 8, 'the modal rules were actually scanned');
  const terminal = read('nfl-all-access-hero-v1.css');
  assert.match(terminal, /\.pbe-pro-modal\{[^}]*overflow:visible!important/);
  assert.match(terminal, /\.pbe-pro-modal\{[^}]*max-height:none!important/);
  assert.match(terminal, /html\.pbe-pro-open,html\.pbe-pro-open body\{overflow:hidden!important/, 'the page is locked: the backdrop is the one scroll context');
  assert.match(terminal, /@media \(max-width:900px\)\{[\s\S]*\.pbe-pro-backdrop\{padding:0!important/, 'phones: full-screen sheet');
  assert.match(read('paywall.js'), /document\.documentElement\.classList\.add\('pbe-pro-open'\)/);
  assert.match(read('paywall.js'), /document\.documentElement\.classList\.remove\('pbe-pro-open'\)/);
  /* the loader: hero module before the funnel + sales, the terminal sheet after them */
  const loader = read('page-loader.js');
  const heroJs = loader.indexOf("js:'./nfl-all-access-hero-v1.js'"); const funnel = loader.indexOf("js:'./paywall-funnel-v2.js'"); const sales = loader.indexOf("js:'./nfl-pro-sales-v1.js'"); const heroCss = loader.indexOf("css:'./nfl-all-access-hero-v1.css'");
  assert.ok(heroJs > -1 && heroJs < funnel && funnel < sales && sales < heroCss);
});

/* ------------------------------------------------------------ navigation + footer */
test('navigation: ALL ACCESS is first-class on desktop (shell top bar, no More menu) and on phones (bottom tab bar), plus the drawer', () => {
  const shell = read('sports-shell-v2.js');
  assert.match(shell, /<a class="pbes-head-btn pbes-head-aa" id="pbes-all-access" href="https:\/\/propbetedge\.ai\/pro" rel="noopener"[^>]*>ALL ACCESS<\/a><button class="pbes-head-btn" type="button" id="pbes-search">/, 'top bar, before Search and Account');
  const html = read('index.html');
  assert.match(html, /<a class="mbn-allaccess" id="mbn-allaccess" href="https:\/\/propbetedge\.ai\/pro" rel="noopener"[^>]*><div class="mbn-icon">★<\/div><span>ALL ACCESS<\/span><\/a>/, 'bottom tab bar item');
  assert.equal((html.match(/class="mbn-item/g) || []).length, 5, 'the five app tabs are untouched (mobile-nav-gate counts them)');
  assert.match(html, /<a class="nav-item ext nav-item-aa" href="https:\/\/propbetedge\.ai\/pro" rel="noopener">[\s\S]*?ALL ACCESS/, 'drawer entry');
  const css = read('nfl-all-access-hero-v1.css');
  assert.match(css, /\.mobile-bottom-nav-inner\{grid-template-columns:repeat\(6,1fr\)!important\}/);
  assert.match(css, /\.mbn-allaccess\{[^}]*min-height:44px;min-width:44px/);
  assert.match(css, /@media \(max-width:900px\)\{#pbe-sports-shell \.pbes-head-btn\.pbes-head-aa\{display:none!important\}\}/, 'the top-bar pill yields to the tab on phones');
});

test('footer: ALL ACCESS and WHAT\'S INCLUDED both resolve to propbetedge.ai/pro', () => {
  const footer = read('network-footer-v1.js');
  assert.match(footer, /const ALL_ACCESS = 'https:\/\/propbetedge\.ai\/pro';/);
  assert.match(footer, /<a href="\$\{ALL_ACCESS\}" rel="noopener" class="pbe-footer-aa-link" data-pbe-footer-all-access>ALL ACCESS ↗<\/a>/);
  assert.match(footer, /<a href="\$\{ALL_ACCESS\}" rel="noopener" data-pbe-footer-all-access-included>WHAT'S INCLUDED ↗<\/a>/);
  assert.match(footer, /<a href="\$\{ALL_ACCESS\}" rel="noopener" class="pbe-footer-aa-link">ALL ACCESS<\/a>/);
});
