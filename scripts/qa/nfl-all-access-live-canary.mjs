#!/usr/bin/env node
// LIVE canary for the NFL All Access bridge against the deployed auth Worker.
//
//   node scripts/qa/nfl-all-access-live-canary.mjs --email=<all-access canary email> [--control=<email>]
//     [--auth=https://propbetedge-nfl-auth.sales-fd3.workers.dev] [--secrets=D:/Workers/secrets]
//
// Uses the server-to-server purchase-delivery endpoint (NFL_AUTH_INTERNAL_TOKEN),
// the only NFL surface that reports the true access decision: `sent` (or a
// Resend failure after the gate passed) proves the email may open NFL Pro,
// `not_entitled` proves it may not. A fresh delivery key is minted per run so
// the delivery ledger never answers `already_sent`. The public request endpoint
// is deliberately enumeration-safe and cannot be used for this.
//
// The token is read from a file and never printed.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const AUTH = arg('auth', 'https://propbetedge-nfl-auth.sales-fd3.workers.dev').replace(/\/$/, '');
const EMAIL = arg('email', '');
const CONTROL = arg('control', `canary-nfl-nobody-${randomBytes(3).toString('hex')}@example.com`);
const SECRETS = arg('secrets', 'D:/Workers/secrets');
if (!EMAIL) { console.error('--email is required'); process.exit(2); }
const TOKEN = readFileSync(join(SECRETS, 'nfl-auth-internal-token'), 'utf8').replace(/^\uFEFF/, '').trim();

const health = await (await fetch(`${AUTH}/health`)).json();
console.log(JSON.stringify({ auth: AUTH, version: health.version, entitlement_gate: health.entitlement_gate, all_access_bridge: health.all_access_bridge ?? 'absent (pre-bridge Worker)' }, null, 2));

async function decide(email) {
  const key = `checkout:cs_test_canaryallaccess${Date.now()}${randomBytes(4).toString('hex')}`;
  const r = await fetch(`${AUTH}/internal/v1/purchase-delivery`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, delivery_key: key }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, result: body.result };
}

const target = await decide(EMAIL);
const control = await decide(CONTROL);
const GATE_PASSED = new Set(['sent', 'resend_failed', 'already_sent', 'in_progress']);
const out = {
  all_access_email: { email: EMAIL, ...target, nfl_pro: GATE_PASSED.has(target.result) },
  control_email: { email: CONTROL, ...control, nfl_pro: GATE_PASSED.has(control.result) },
};
out.pass = out.all_access_email.nfl_pro === true && out.control_email.result === 'not_entitled';
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
