/* NFL sign-in / purchase-access emails carry the standard PropBetEdge sign-off
 * (PropBetEdge · The Sports Intelligence Network · propbetedge.ai · X: @PROPBETEDGE)
 * BELOW the CTA and the expiry/security line, and nothing about auth changed.
 * Renders only; no email is sent.
 *
 *   node --test tests/nfl-auth-email-signoff.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { mailHtml, mailText, EMAIL_SIGNOFF_HTML, EMAIL_SIGNOFF_TEXT } = await import('../workers/nfl-auth/src/index-v5.js');
const SRC = readFileSync(new URL('../workers/nfl-auth/src/index-v5.js', import.meta.url), 'utf8');

/* A real-shaped link: the Worker builds `${app}/api/auth-verify?token=${encodeURIComponent(token)}`. */
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFAYi5jbyJ9.c2ln-_x';
const LINK = `https://nfl.propbetedge.ai/api/auth-verify?token=${encodeURIComponent(TOKEN)}`;
const STALE_CI = /MLBHRALERTSPBE|propbetedgeai|X \/ Twitter|twitter\.com/i;
const noStale = (s) => { assert.doesNotMatch(s, STALE_CI); assert.doesNotMatch(s, /x\.com\/propbetedge["'/]/); }; // lowercase handle: case-sensitive

for (const purpose of ['signin', 'purchase']) {
  test(`${purpose} HTML: link exact, CTA unchanged, sign-off below the security line`, () => {
    const html = mailHtml(LINK, purpose);
    assert.equal(html.split(`href="${LINK}"`).length - 1, 1, 'sign-in URL inserted exactly once, unaltered');
    const cta = html.indexOf('>OPEN PROPBETEDGE NFL</a>');
    const security = html.indexOf('This link expires in 15 minutes. If you did not request or purchase NFL Pro, ignore this message.</p>');
    const signoff = html.indexOf(EMAIL_SIGNOFF_HTML);
    assert.ok(cta > 0 && security > cta && signoff > security, 'order: CTA -> expiry/security -> sign-off');
    assert.ok(html.indexOf('The Sports Intelligence Network') > security, 'no marketing above the CTA');
    assert.match(html, /<a href="https:\/\/x\.com\/PROPBETEDGE"[^>]*>@PROPBETEDGE<\/a>/);
    assert.match(html, /<a href="https:\/\/propbetedge\.ai"[^>]*>propbetedge\.ai<\/a>/);
    noStale(html);
    assert.ok(html.endsWith('</body></html>'));
  });

  test(`${purpose} text: link exact, expiry wording kept, plaintext sign-off`, () => {
    const text = mailText(LINK, purpose);
    assert.ok(text.includes(`\n${LINK}\n`), 'link on its own line, unaltered');
    assert.ok(text.includes('This secure link expires in 15 minutes.'));
    assert.ok(text.endsWith('\n\n--\nPropBetEdge\nThe Sports Intelligence Network\nhttps://propbetedge.ai\nX: @PROPBETEDGE — https://x.com/PROPBETEDGE'));
    assert.equal(text.indexOf('PropBetEdge\nThe Sports'), text.length - EMAIL_SIGNOFF_TEXT.length + '\n\n--\n'.length);
    noStale(text);
  });
}

test('purchase and sign-in emails still differ appropriately', () => {
  assert.match(mailHtml(LINK, 'purchase'), /Your NFL Pro access is ready\./);
  assert.match(mailHtml(LINK, 'purchase'), /Stripe has confirmed your NFL Pro purchase/);
  assert.match(mailHtml(LINK, 'signin'), /Your secure NFL sign-in is ready\./);
  assert.doesNotMatch(mailHtml(LINK, 'signin'), /Stripe has confirmed/);
  assert.match(mailText(LINK, 'purchase'), /^Your PropBetEdge NFL Pro purchase is confirmed\./);
  assert.match(mailText(LINK, 'signin'), /^Your PropBetEdge NFL sign-in link is ready\./);
  assert.match(SRC, /subject:purpose==='purchase'\?'PropBetEdge NFL Pro — your access is ready':'PropBetEdge NFL — secure sign-in'/);
});

test('auth semantics pinned: token TTL, session length, link shape, sender, one-time ledger', () => {
  assert.match(SRC, /const MAGIC_TTL=15\*60;/);
  assert.match(SRC, /const SESSION_TTL=30\*24\*60\*60;/);
  assert.match(SRC, /const FROM_EMAIL='PropBetEdge Picks <picks@propbetedge\.ai>';/);
  assert.match(SRC, /const link=`\$\{app\}\/api\/auth-verify\?token=\$\{encodeURIComponent\(token\)\}`;/);
  assert.match(SRC, /body:JSON\.stringify\(\{from:FROM_EMAIL,to:\[email\],subject:/);
  assert.match(SRC, /sign\(\{email,type:'magic',purpose,iat:now,exp:now\+MAGIC_TTL,jti:crypto\.randomUUID\(\)\},signing\.primary\)/);
  assert.match(SRC, /export class MagicLinkLedger/);
});

test('rendered emails carry no credentials or secrets', () => {
  const all = ['signin', 'purchase'].flatMap(p => [mailHtml(LINK, p), mailText(LINK, p)]).join('\n');
  assert.doesNotMatch(all, /Bearer|RESEND_API_KEY|SUPABASE|service_role|NFL_SESSION_SIGNING_SECRET|re_[A-Za-z0-9]{8,}|sk_(?:live|test)_/);
});
