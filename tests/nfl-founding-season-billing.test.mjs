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

test('customer-facing Founding Season prices are $9.99 monthly and $3.99 weekly', () => {
  assert.match(funnel, /price:\s*'\$9\.99'[\s\S]*detail:\s*'\/ month'/);
  assert.match(funnel, /price:\s*'\$3\.99'[\s\S]*detail:\s*'\/ week'/);
  assert.match(funnel, /return PLANS\[key\] \? key : 'monthly'/);
  assert.match(funnel, /catch \(_\) \{ return 'monthly'; \}/);
});

test('new Stripe IDs and hosted payment links are the only acquisition contract', () => {
  for (const value of [NEW_WEEKLY_PRICE, NEW_MONTHLY_PRICE, NEW_WEEKLY_LINK, NEW_MONTHLY_LINK]) {
    assert.ok(funnel.includes(value), `missing ${value}`);
  }
  assert.doesNotMatch(funnel, /fetch\s*\(\s*['"`]\/api\/checkout/);
  assert.doesNotMatch(funnel, /SEASON PASS|\$99\b|\$9\.99\s*\/\s*week/i);
});

test('Founding Season has no trial and is clearly recurring/cancelable', () => {
  assert.match(funnel, /No free trial/);
  assert.match(funnel, /Renews monthly/);
  assert.match(funnel, /Renews weekly/);
  assert.match(funnel, /Cancel anytime/);
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
