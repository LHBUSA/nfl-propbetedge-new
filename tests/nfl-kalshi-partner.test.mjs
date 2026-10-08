/* Kalshi PERPETUALS partner offer on NFL (kalshi-partner/2, owner 2026-10-07).
 *
 * One footer module in the network footer's All Access area. Copy + link come only from the vendored
 * /kalshi-partner.js (byte-identical to propbetedge-workers/workers/propsports-markets/client/kalshi-partner.js).
 * Same-origin fixed rewrites only. Never in picks, prop cards, PBEcast or the Kalshi market components; direct
 * "Open on Kalshi" market links stay untouched. Offer economics never appear in this repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, REPO), 'utf8');
const P = await import(new URL('kalshi-partner.js', REPO));
const CANONICAL = 'D:/Workers/propbetedge-workers/workers/propsports-markets/client/kalshi-partner.js';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('vendored kalshi-partner.js is byte-identical to the canonical client (skipped when the canonical is absent)', (t) => {
  if (!existsSync(CANONICAL)) return t.skip('canonical client not on this machine');
  assert.equal(sha(readFileSync(new URL('kalshi-partner.js', REPO))), sha(readFileSync(CANONICAL)));
});

test('vercel.json: two fixed same-origin rewrites to propsports-markets, no destination parameter', () => {
  const v = JSON.parse(read('vercel.json'));
  assert.deepEqual(v.rewrites, [
    { source: '/go/kalshi-perps', destination: 'https://propsports-markets.sales-fd3.workers.dev/go/kalshi-perps' },
    { source: '/go/kalshi-perps/config', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/partner/kalshi' }
  ]);
  assert.ok(!v.redirects);
});

test('footer: exactly one offer slot, after the All Access console, mounted with the footer variant + NFL attribution', () => {
  const src = read('network-footer-v1.js');
  assert.equal((src.match(/data-pbe-kxo hidden/g) || []).length, 1);
  assert.equal((src.match(/partnerOffer\(/g) || []).length, 1);
  assert.match(src, /placement: 'sport_footer', product: 'nfl', sport: 'nfl'/);
  assert.match(src, /\{ variant: 'footer' \}/);
  assert.match(src, /loadPartnerConfig\('\/go\/kalshi-perps\/config'\)/);
  assert.match(src, /import\('\/kalshi-partner\.js\?v=/);
  assert.ok(src.indexOf('data-pbe-kxo hidden') > src.indexOf('pbe-footer-account-card'), 'inside the commercial/account area');
  assert.ok(src.indexOf('data-pbe-kxo hidden') < src.indexOf('EDITORIAL &amp; LEGAL'));
  assert.match(src, /document\.querySelector\('\.kxo'\)\) return/, 'never a second offer on the page');
  assert.match(read('network-footer-v1.css'), /\.pbe-network-kxo \.kxo__cta\{/);
});

test('placement rule: the offer is nowhere else -- not picks, props, PBEcast, games, or the vendored Kalshi market UI', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, REPO), { withFileTypes: true })) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory()) { if (!/^(node_modules|\.git|tests|archive|research|data|history|docs|migrations|og|stadiums|release)$/.test(e.name)) walk(`${p}/`); continue; }
      if (!/\.(js|mjs|html)$/.test(e.name) || p === 'kalshi-partner.js' || p === 'network-footer-v1.js') continue;
      const s = read(p);
      if (/kalshi-partner|kalshi-perps|partnerOffer|\bkxo\b/.test(s)) offenders.push(p);
    }
  };
  walk('');
  assert.deepEqual(offenders, []);
  for (const f of ['vendor/kalshi/kalshi-market-ui.js', 'vendor/kalshi/kalshi-market-client.js']) {
    if (existsSync(new URL(f, REPO))) assert.doesNotMatch(read(f), /kalshi-perps|kalshi\.com\/p\/|referral=/, f);
  }
});

test('no offer economics or referral identity hardcoded in shipped NFL source', () => {
  for (const f of ['network-footer-v1.js', 'network-footer-v1.css', 'vercel.json', 'index.html', 'all-access.html']) {
    const s = read(f);
    assert.doesNotMatch(s, /38800c96|kalshi\.com\/p\/|referral=/, f);
  }
  /* the files this rollout owns carry no economics at all; copy lives only in the vendored client + the server config */
  for (const f of ['network-footer-v1.js', 'vercel.json']) assert.doesNotMatch(read(f), /\$50|10%|3 months|30%|1 year/, f);
});

test('client contract: footer variant renders one disclosed, sponsored, first-party link; disabled -> nothing', () => {
  const cfg = P.normalizeConfig({ contract: 'kalshi-partner/2', enabled: true, path: '/go/kalshi-perps', program: 'perpetuals',
    offer: { qualifying_volume: '$25', user_discount: '15%', user_discount_term: '2 months', pbe_revenue_share: '20%', pbe_revenue_term: '2 years', last_verified_at: '2026-10-07T00:00:00Z' } });
  const html = P.partnerOffer(cfg, { placement: 'sport_footer', product: 'nfl', sport: 'nfl' }, { variant: 'footer' });
  assert.equal((html.match(/<aside class="kxo kxo--footer"/g) || []).length, 1);
  assert.match(html, /href="\/go\/kalshi-perps\?placement=sport_footer&amp;product=nfl&amp;sport=nfl"/);
  assert.match(html, /rel="sponsored noopener noreferrer"/);
  assert.match(html, /may receive compensation/);
  assert.doesNotMatch(html, /kalshi\.com/);
  assert.equal(P.partnerOffer(P.PARTNER_DISABLED, { placement: 'sport_footer' }, { variant: 'footer' }), '');
  assert.equal(P.partnerOffer(P.normalizeConfig(null), {}, { variant: 'footer' }), '');
});
