/* Asserts the dashboard-v8 observer loop alarm is installed AND silent.
 *
 * Two failure modes are covered:
 *   1. A feedback loop is running in production  -> alarm.count > 0.
 *   2. The alarm itself was removed or broken    -> no window.__PBE_OBSERVER_ALARM,
 *      which would make (1) undetectable.
 *
 * It then actively provokes a mutation storm to prove the detector still works,
 * because a guard that cannot fire is not a guard.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.env.PBE_URL || 'https://nfl.propbetedge.ai';
const CHROME = process.env.PBE_CHROME
  || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome');
const LOG = 'observer-alarm.log';

const out = l => { try { appendFileSync(LOG, l + String.fromCharCode(10)); } catch (_) {} console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9820 + Math.floor(Math.random() * 90);
const dir = mkdtempSync(join(tmpdir(), 'pbe-alarm-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

function finish(code) {
  try { chrome.kill(); } catch (_) {}
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300);
}
const hard = setTimeout(() => { out('HARD_DEADLINE'); finish(3); }, 150000);
hard.unref?.();

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('devtools_unavailable');
}

let id = 1;
const pending = new Map();
const consoleErrors = [];

const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => {
  const myId = id++;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res, rej) => pending.set(myId, { resolve: res, reject: rej }));
};
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    consoleErrors.push(text.slice(0, 240));
  }
};

await send('Runtime.enable');
await send('Page.enable');
out(`TARGET ${URL_TARGET}`);
await send('Page.navigate', { url: URL_TARGET });
await sleep(11000);

async function probe(expr, ms = 6000) {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true }),
      sleep(ms).then(() => { throw new Error('WEDGED'); }),
    ]);
    return r.result?.value;
  } catch (e) { return `<${e.message}>`; }
}

if (await probe('1+1') !== 2) { out('RESULT MAIN THREAD WEDGED'); ws.close(); finish(1); }

let pass = true;

/* 1. The alarm must exist. */
const installed = await probe('!!window.__PBE_OBSERVER_ALARM');
out(`alarm installed        : ${installed}`);
if (installed !== true) {
  out('FAIL the observer loop alarm is missing — a feedback loop would be silent');
  pass = false;
}

/* 2. It must be silent under normal operation. */
const state = await probe('JSON.stringify({count:window.__PBE_OBSERVER_ALARM?.count,peak:window.__PBE_OBSERVER_ALARM?.peak})');
out(`alarm state            : ${state}`);
if (installed === true) {
  const count = Number(JSON.parse(typeof state === 'string' ? state : '{}')?.count ?? -1);
  if (count !== 0) {
    out(`FAIL observer loop alarm fired ${count} time(s) in normal operation`);
    pass = false;
  }
}
const loopErrors = consoleErrors.filter(t => t.includes('[pbe-observer-loop]'));
out(`console loop errors    : ${loopErrors.length}`);
if (loopErrors.length) { loopErrors.slice(0, 3).forEach(e => out(`  ${e}`)); pass = false; }

/* 3. The detector must still be capable of firing. A guard that cannot fire is
 *    not a guard, so provoke a mutation storm with no user input. */
if (installed === true) {
  await probe(`(() => {
    const host = document.querySelector('#view-container') || document.body;
    const probeEl = document.createElement('div');
    probeEl.id = '__pbe_alarm_probe';
    host.appendChild(probeEl);
    for (let i = 0; i < 120; i += 1) {
      probeEl.appendChild(document.createElement('span'));
    }
    return true;
  })()`, 8000);
  await sleep(1200);
  const after = await probe('JSON.stringify({count:window.__PBE_OBSERVER_ALARM?.count,peak:window.__PBE_OBSERVER_ALARM?.peak})');
  out(`after synthetic storm  : ${after}`);
  const peak = Number(JSON.parse(typeof after === 'string' ? after : '{}')?.peak ?? 0);
  if (!(peak > 0)) {
    out('FAIL the alarm never observed any fires — detector is not wired to the observer');
    pass = false;
  }
  await probe(`document.getElementById('__pbe_alarm_probe')?.remove()`);
}

out(`RESULT ${pass ? 'PASS' : 'FAIL'}`);
ws.close();
finish(pass ? 0 : 1);
