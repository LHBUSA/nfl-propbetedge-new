/* PBE Card canary harness — browser/tab lifecycle regressions.
 *
 * Runs the real scripts/pbe-card-gate.mjs in real Chrome against a local
 * stand-in for the sign-in origin (the gate's --harness-selftest refuses any
 * non-localhost target, so this can never touch or shortcut production). The
 * test plays the operator over DevTools, exactly as a person would in the
 * canary window.
 *
 * The regression that matters: on 2026-09-11 the real canary died with
 * "canary_window_closed_before_sign_in" because it was bound to the gold tab.
 * Opening the link in a second tab and closing the gold tab must now leave the
 * run alive and authenticated.
 *
 * Needs Chrome (PBE_CHROME or the default Windows path); skipped otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HAVE_CHROME = existsSync(CHROME);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- stand-in origin: the same four routes the canary relies on ---------- */
function standIn({ proEmails }) {
  const tokens = new Map(), sessions = new Map();
  const state = { lastLink: null, authEmailPosts: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = /(?:^|;\s*)pbe_nfl_session_v2=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><body><div id="view-container"></div><script>
        window.PBEPro = { open() {
          if (document.getElementById('pbe-pro-email')) return;
          document.body.insertAdjacentHTML('beforeend', '<input id="pbe-pro-email" type="email"><button id="pbe-pro-signin">Sign in</button>');
          document.getElementById('pbe-pro-signin').onclick = () => fetch('/api/auth-email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('pbe-pro-email').value }) });
        } };
      </script></body></html>`);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth-email') {
      let body = ''; req.on('data', c => { body += c; });
      return req.on('end', () => {
        const email = String(JSON.parse(body || '{}').email || '').toLowerCase();
        const token = randomBytes(24).toString('hex');
        tokens.set(token, email);
        state.authEmailPosts += 1;
        state.lastLink = `http://${req.headers.host}/api/auth-verify?token=${token}`;
        json(200, { ok: true, provider: 'resend', auth_issuer: 'propbetedge' });
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth-verify') {
      const email = tokens.get(url.searchParams.get('token') || '');
      if (!email) { res.writeHead(302, { location: '/?auth=invalid' }); return res.end(); }
      tokens.delete(url.searchParams.get('token'));
      const sid = randomBytes(24).toString('hex');
      sessions.set(sid, email);
      res.writeHead(302, { location: '/?auth=complete&session=established', 'set-cookie': `pbe_nfl_session_v2=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/auth-session') {
      const email = cookie && sessions.get(cookie);
      if (!email) return json(200, { valid: false, pro: false, stage: 'no_cookie' });
      const pro = proEmails.includes(email);
      return json(200, { valid: true, pro, stage: pro ? 'entitlement_active' : 'entitlement_missing' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth-logout') {
      if (cookie) sessions.delete(cookie);
      return json(200, { ok: true, stage: 'cleared' }, { 'set-cookie': 'pbe_nfl_session_v2=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
    }
    json(404, { error: 'not_found' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}` })));
}

/* ---- the gate, as a child process ----------------------------------------- */
function runGate({ origin, port, email, timeoutMs = 60000 }) {
  const out = mkdtempSync(join(tmpdir(), 'pbe-harness-out-'));
  const child = spawn(process.execPath, ['scripts/pbe-card-gate.mjs', '--canary', '--harness-selftest', '--live', '--headless', '--settle', '800', '--out', out], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PBE_TARGET: origin, PBE_GATE_PORT: String(port), PBE_PRO_EMAIL: email, PBE_LOGIN_TIMEOUT_MS: String(timeoutMs), PBE_CHROME: CHROME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const done = new Promise(resolve => child.on('exit', code => resolve({ code, output })));
  return { child, done, output: () => output };
}
async function waitFor(pred, ms, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(step); }
  return null;
}

/* ---- the operator, over DevTools ----------------------------------------- */
async function operator(port) {
  const v = await waitFor(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } }, 15000);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let n = 1; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const id = n++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return {
    pages: async () => ((await send('Target.getTargets')).targetInfos || []).filter(t => t.type === 'page'),
    openTab: url => send('Target.createTarget', { url }),
    closeTab: targetId => send('Target.closeTarget', { targetId }),
    closeBrowser: () => send('Browser.close'),
    close: () => { try { ws.close(); } catch {} },
  };
}
const freePort = () => 9300 + Math.floor(Math.random() * 400);
const leftoverProfiles = () => readdirSync(tmpdir()).filter(n => n.startsWith('pbe-cardgate-')).length;

test('regression: the link opens in a second tab and the gold tab closes — the canary survives and authenticates', { skip: !HAVE_CHROME && 'Chrome not installed', timeout: 90000 }, async () => {
  const site = await standIn({ proEmails: ['pro@harness.test'] });
  const port = freePort();
  const before = leftoverProfiles();
  const gate = runGate({ origin: site.origin, port, email: 'pro@harness.test' });
  try {
    assert.ok(await waitFor(() => /LOGIN waiting/.test(gate.output()), 30000), `gate never reached the sign-in wait:\n${gate.output()}`);
    assert.equal(site.state.authEmailPosts, 1);
    const op = await operator(port);
    const gold = (await op.pages()).find(p => p.url.startsWith(site.origin));
    assert.ok(gold, 'gold tab present');
    await op.openTab(site.state.lastLink);        // the operator pastes the link into a NEW tab…
    await op.closeTab(gold.targetId);             // …and closes the original gold tab
    op.close();
    const { code, output } = await gate.done;
    assert.equal(code, 0, output);
    assert.match(output, /LIFECYCLE .*TAB closed tab#1 \(was being driven; re-attaching to a surviving tab\)/);
    assert.match(output, /LIFECYCLE .*AUTH landed in tab#2/);
    assert.match(output, /LIFECYCLE .*AUTH session valid=true pro=true stage=entitlement_active \(probed in tab#2\)/);
    assert.match(output, /LOGIN outcome: authenticated/);
    assert.match(output, /SELFTEST PASSED · outcome authenticated · logout 200 · valid after logout false/);
    assert.match(output, /CLEANUP chrome exited: yes · profile deleted: yes · canary chrome processes remaining: 0/);
    assert.doesNotMatch(output, /token=[0-9a-f]{8}/, 'a sign-in token was printed');
    assert.equal(leftoverProfiles(), before);
  } finally { gate.child.kill(); site.server.close(); }
});

test('Chrome itself exiting fails the canary immediately and cleanly', { skip: !HAVE_CHROME && 'Chrome not installed', timeout: 90000 }, async () => {
  const site = await standIn({ proEmails: ['pro@harness.test'] });
  const port = freePort();
  const before = leftoverProfiles();
  const gate = runGate({ origin: site.origin, port, email: 'pro@harness.test' });
  try {
    assert.ok(await waitFor(() => /LOGIN waiting/.test(gate.output()), 30000), gate.output());
    const op = await operator(port);
    const closedAt = Date.now();
    await op.closeBrowser();
    op.close();
    const { code, output } = await gate.done;
    assert.equal(code, 1, output);
    assert.ok(Date.now() - closedAt < 15000, 'did not fail fast');
    assert.match(output, /LIFECYCLE .*BROWSER exited/);
    assert.match(output, /LOGIN outcome: browser_exited/);
    assert.match(output, /CLEANUP chrome exited: yes · profile deleted: yes · canary chrome processes remaining: 0/);
    assert.equal(leftoverProfiles(), before);
  } finally { gate.child.kill(); site.server.close(); }
});

test('a link that is never opened is reported as auth never landed, not as a closed window', { skip: !HAVE_CHROME && 'Chrome not installed', timeout: 90000 }, async () => {
  const site = await standIn({ proEmails: ['pro@harness.test'] });
  const port = freePort();
  const gate = runGate({ origin: site.origin, port, email: 'pro@harness.test', timeoutMs: 7000 });
  try {
    assert.ok(await waitFor(() => /LOGIN waiting/.test(gate.output()), 30000), gate.output());
    /* The operator closes the gold tab but never opens the link. */
    const op = await operator(port);
    const gold = (await op.pages()).find(p => p.url.startsWith(site.origin));
    await op.openTab('about:blank');
    await op.closeTab(gold.targetId);
    op.close();
    const { code, output } = await gate.done;
    assert.equal(code, 1, output);
    assert.match(output, /LIFECYCLE .*TAB closed tab#1/);
    assert.match(output, /LIFECYCLE .*AUTH never landed/);
    assert.match(output, /LOGIN outcome: auth_never_landed/);
    assert.doesNotMatch(output, /BROWSER exited \(process|canary_window_closed/);
    assert.match(output, /CLEANUP chrome exited: yes · profile deleted: yes · canary chrome processes remaining: 0/);
  } finally { gate.child.kill(); site.server.close(); }
});

test('signed in but not Pro stops before any gated test and signs out', { skip: !HAVE_CHROME && 'Chrome not installed', timeout: 90000 }, async () => {
  const site = await standIn({ proEmails: [] });
  const port = freePort();
  const gate = runGate({ origin: site.origin, port, email: 'free@harness.test' });
  try {
    assert.ok(await waitFor(() => /LOGIN waiting/.test(gate.output()), 30000), gate.output());
    const op = await operator(port);
    await op.openTab(site.state.lastLink);
    op.close();
    const { code, output } = await gate.done;
    assert.equal(code, 5, output);
    assert.match(output, /LOGIN outcome: signed_in_not_pro/);
    assert.match(output, /STOPPED · f\*\*\*@harness\.test signed in \(valid=true\) but \/api\/auth-session reports pro=false/);
    assert.doesNotMatch(output, /pro\/pbepicks/);
    assert.match(output, /CLEANUP chrome exited: yes · profile deleted: yes · canary chrome processes remaining: 0/);
  } finally { gate.child.kill(); site.server.close(); }
});

test('the harness self-test refuses any non-localhost target', async () => {
  const child = spawn(process.execPath, ['scripts/pbe-card-gate.mjs', '--canary', '--harness-selftest', '--live'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, PBE_TARGET: 'https://nfl.propbetedge.ai', PBE_PRO_EMAIL: 'pro@harness.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(output, /--harness-selftest runs only with --canary against a localhost PBE_TARGET/);
});
