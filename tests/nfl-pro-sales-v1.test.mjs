import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sales = fs.readFileSync(new URL('../nfl-pro-sales-v1.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../nfl-pro-sales-v1.css', import.meta.url), 'utf8');
const loader = fs.readFileSync(new URL('../page-loader.js', import.meta.url), 'utf8');
const paywall = fs.readFileSync(new URL('../paywall.js', import.meta.url), 'utf8');
const funnel = fs.readFileSync(new URL('../paywall-funnel-v2.js', import.meta.url), 'utf8');
const polish = fs.readFileSync(new URL('../paywall-polish-v1.js', import.meta.url), 'utf8');

function assertNoPremiumRead(source, label) {
  for (const path of ['/api/pro-model', '/api/pbe-picks', '/api/pbe-prop-picks']) {
    assert.equal(source.includes(path), false, `${label} must never fetch ${path}`);
  }
}

test('NFL Pro sales surface is loaded by the production page loader', () => {
  assert.match(loader, /nfl-pro-sales-v1\.css/);
  assert.match(loader, /nfl-pro-sales-v1\.js/);
});

test('sales surface leads with the automated learning picker and accountability', () => {
  assert.match(sales, /A picker built to learn/);
  assert.match(sales, /from every finalized grade/);
  assert.match(sales, /AUTOMATED LEARNING PICKER/);
  assert.match(sales, /EVALUATE/);
  assert.match(sales, /PICK/);
  assert.match(sales, /LOCK/);
  assert.match(sales, /GRADE/);
  assert.match(sales, /LEARN/);
  assert.match(sales, /The model makes the call\. The system remembers it\./);
});

test('public conversion surface does not read or leak premium decisions', () => {
  assertNoPremiumRead(sales, 'nfl-pro-sales-v1.js');
  assert.doesNotMatch(sales, /fetch\s*\(/);
  assert.match(sales, /window\.PBEPricing/);
  assert.match(sales, /window\.PBEPro\?\.open/);
});

test('locked preview contains product fields, not fabricated pick values', () => {
  for (const field of ['Official PBE Pick', 'Issued line + odds', 'Model probability', 'PBE Edge / comparison', 'Model version + provenance']) {
    assert.ok(sales.includes(field), `missing locked field ${field}`);
  }
  assert.match(sales, /PRO OUTPUT/);
});

test('premium styling is responsive and reduced-motion safe', () => {
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test('checkout messaging sells the live product instead of future validation', () => {
  assert.doesNotMatch(paywall, /Premium modules as they clear validation/i);
  assert.doesNotMatch(funnel, /premium research as it clears validation/i);
  assert.match(paywall, /Official PBE Picks/);
  assert.match(funnel, /PBE Picks/);
});

test('active member surface celebrates NFL PropBetEdge Pro and exposes Stripe management', () => {
  assert.match(sales, /You have NFL/);
  assert.match(sales, /PropBetEdge Pro/);
  assert.match(sales, /Manage subscription/);
  assert.match(sales, /billing\.stripe\.com\/p\/login\/cNi3cv2vY7em3lr4oj7wA00/);
  assert.doesNotMatch(sales, /isOwner|owner preview/i);

  assert.match(polish, /You have NFL PropBetEdge Pro\./);
  assert.match(polish, /Manage subscription/);
  assert.match(polish, /billing\.stripe\.com\/p\/login\/cNi3cv2vY7em3lr4oj7wA00/);
  assert.match(polish, /active-owner/);
  assert.match(polish, /root\.dataset\.funnelState='active-pro'/);
});
