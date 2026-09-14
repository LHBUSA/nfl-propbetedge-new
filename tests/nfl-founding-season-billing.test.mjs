import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const funnel = fs.readFileSync(new URL('../paywall-funnel-v2.js', import.meta.url), 'utf8');
const billing = fs.readFileSync(new URL('../workers/nfl-billing/src/index.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../workers/nfl-billing/wrangler.toml', import.meta.url), 'utf8');

const NEW_WEEKLY_PRICE = 'price_1UEWAOF3CaVzg4ORjkWpwOz9';
const NEW_MONTHLY_PRICE = 'price_1UEWAXF3CaVzg4ORGlsgboLq';
const LEGACY_WEEKLY_PRICE = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
const LEGACY_SEASON_PRICE = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const NEW_WEEKLY_LINK = 'https://buy.stripe.com/9B628rb2udCK5tzf2X7wA0x';
const NEW_MONTHLY_LINK = 'https://buy.stripe.com/eVqeVd1rUcyG5tz2gb7wA0y';

/* The one pricing source: window.PBEPricing in paywall.js (loads before every
   module). Evaluated for real, not pattern-matched. */
const paywall = fs.readFileSync(new URL('../paywall.js', import.meta.url), 'utf8');
const PRICING = (() => {
  const block = paywall.slice(paywall.indexOf('const PRICING = Object.freeze({'), paywall.indexOf('window.PBEPricing = PRICING;'));
  return new Function(`${block}; return PRICING;`)();
})();

test('customer-facing Founding Season prices are $9.99 monthly and $3.99 weekly', () => {
  assert.equal(PRICING.monthly.price, '$9.99'); assert.equal(PRICING.monthly.detail, '/ month'); assert.equal(PRICING.monthly.cadence, 'month');
  assert.equal(PRICING.weekly.price, '$3.99'); assert.equal(PRICING.weekly.detail, '/ week'); assert.equal(PRICING.weekly.cadence, 'week');
  assert.deepEqual(PRICING.order, ['monthly', 'weekly']);
  assert.equal(PRICING.summary, '$9.99/month or $3.99/week');
  assert.match(funnel, /const PRICING = window\.PBEPricing;/);
  assert.match(funnel, /const PLANS = \{ monthly: PRICING\.monthly, weekly: PRICING\.weekly \};/);
  assert.match(funnel, /return PLANS\[key\] \? key : 'monthly'/);
  assert.match(funnel, /catch \(_\) \{ return 'monthly'; \}/);
});

test('new Stripe IDs and hosted payment links are the only acquisition contract', () => {
  assert.equal(PRICING.weekly.priceId, NEW_WEEKLY_PRICE); assert.equal(PRICING.monthly.priceId, NEW_MONTHLY_PRICE);
  assert.equal(PRICING.weekly.url, NEW_WEEKLY_LINK); assert.equal(PRICING.monthly.url, NEW_MONTHLY_LINK);
  assert.doesNotMatch(funnel, /fetch\s*\(\s*['"`]\/api\/checkout/);
  const checkout = fs.readFileSync(new URL('../api/checkout.js', import.meta.url), 'utf8');
  assert.ok(checkout.includes(NEW_MONTHLY_PRICE) && checkout.includes(NEW_WEEKLY_PRICE) && checkout.includes(NEW_MONTHLY_LINK) && checkout.includes(NEW_WEEKLY_LINK));
  for (const retired of [LEGACY_WEEKLY_PRICE, LEGACY_SEASON_PRICE, 'fZueVd1rU0PYg8d8Ez7wA05', 'cNidR9eeGbuCe05f2X7wA06']) {
    assert.equal(checkout.includes(retired) || paywall.includes(retired) || funnel.includes(retired), false, `retired ${retired} is never sold`);
  }
});

test('Founding Season has no trial and is clearly recurring/cancelable', () => {
  assert.equal(PRICING.charge, 'Charged today · No free trial · Cancel anytime');
  assert.match(PRICING.monthly.term, /Renews monthly/); assert.match(PRICING.weekly.term, /Renews weekly/);
  assert.match(PRICING.monthly.term, /Cancel anytime/); assert.match(PRICING.weekly.term, /Cancel anytime/);
  assert.match(funnel, /\$\{escapeHtml\(PRICING\.charge\)\}/);
});

test('no customer-facing file states a retired or stale price', () => {
  const root = new URL('..', import.meta.url);
  const client = fs.readdirSync(root).filter(f => /\.(js|html|css)$/.test(f));
  const stale = /\$\s*9\.99\s*(\/|per)\s*(wk|week)|\$99\b|\bseason pass\b|free trial(?!\.| ·|<| handoff)/i;
  for (const f of client) {
    const text = fs.readFileSync(new URL(f, root), 'utf8');
    const hit = text.split(/\r?\n/).find(line => stale.test(line.replace(/No free trial/g, '')));
    assert.equal(hit, undefined, `${f}: ${String(hit).trim().slice(0, 120)}`);
  }
  /* static copy the browser cannot compute: sidebar line and structured data */
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes(`NFL Pro · ${PRICING.shortSummary}`));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(ld.offers.map(o => o.price), PRICING.order.map(k => PRICING[k].amount));
  /* modules name the price only through the canonical source */
  for (const f of ['sgp-lab-v2.js', 'simulator-v2.js', 'market-watch-v3.js', 'prop-board-v3.js', 'player-research-v2.js', 'model-lab.js', 'matchups-v2.js', 'dashboard-v7.js', 'global-polish-v5.js', 'paywall-polish-v1.js']) {
    assert.match(fs.readFileSync(new URL(f, root), 'utf8'), /window\.PBEPricing/, f);
  }
});

test('active NFL Pro uses the same premium presentation authority', () => {
  assert.match(funnel, /data-funnel-state="\$\{owner \? 'active-owner' : 'active-pro'\}"/);
  assert.match(funnel, /Your NFL intelligence desk is live\./);
  assert.match(funnel, /Verified account/);
  assert.match(funnel, /Open Pro Prop Board/);
  assert.match(funnel, /PBE Fair Line · Model Probability · Best Line · PBE Cast · Track Record/);
  assert.match(funnel, /const mode = s\.pro \? \(owner \? 'active-owner' : 'active-pro'\) : s\.user \? 'signed-in-free' : 'signed-out'/);
});

test('Cloudflare billing worker recognizes both legacy and Founding Season entitlements', () => {
  for (const value of [NEW_WEEKLY_PRICE, NEW_MONTHLY_PRICE, LEGACY_WEEKLY_PRICE, LEGACY_SEASON_PRICE]) {
    assert.ok(billing.includes(value), `billing worker must recognize ${value}`);
  }
  assert.match(billing, /Stripe webhook -> Cloudflare Worker -> Supabase entitlement truth/);
  assert.doesNotMatch(billing, /vercel\.app|fetch\s*\(\s*['"`]\/api\/checkout/);
});

test('billing worker is event-driven Cloudflare runtime, never a scheduled GitHub/Vercel job', () => {
  assert.match(wrangler, /name = "propbetedge-nfl-billing"/);
  assert.match(wrangler, /service = "propbetedge-nfl-auth"/);
  assert.doesNotMatch(wrangler, /\[triggers\][\s\S]*crons\s*=/);
  assert.doesNotMatch(wrangler, /vercel/i);
});