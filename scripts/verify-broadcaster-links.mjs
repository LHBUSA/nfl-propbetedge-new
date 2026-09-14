/* Re-verify every URL in the broadcaster registry.
 *
 *   PBE_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" \
 *     node scripts/verify-broadcaster-links.mjs [--user-data-dir=DIR]
 *
 * Loads each registry URL in real headless Chrome (several broadcasters reset
 * plain HTTP clients), follows redirects, and prints the main-document HTTP
 * status, redirect chain, final URL, title and whether the final host is still
 * on that provider's allow-list. It changes nothing: update broadcasters.js by
 * hand from its output, and set link_status 'unverified' for anything that is
 * not a 200 on an allowed host.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROADCASTERS, isAllowedDestination } from '../workers/nfl-schedule/broadcasters.js';

const CHROME = process.env.PBE_CHROME || '/usr/bin/google-chrome';
const PORT = 9400 + (process.pid % 400);
const argDir = process.argv.find(a => a.startsWith('--user-data-dir='))?.slice(16);
const dir = argDir || mkdtempSync(join(tmpdir(), 'pbe-links-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

const targets = Object.values(BROADCASTERS).flatMap(p => [['watch_url', p.watch_url], ['official_url', p.official_url]].filter(([, u]) => u).map(([field, url]) => ({ id: p.id, field, url })));
const rows = [];
try {
  let wsu;
  for (let i = 0; i < 80 && !wsu; i++) { try { wsu = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsu) await sleep(250); }
  if (!wsu) throw new Error('devtools_unavailable');
  const ws = new WebSocket(wsu); await new Promise(r => { ws.onopen = r; });
  let id = 1; const pending = new Map(); let docs = [];
  const send = (method, params = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document') docs.push({ frame: m.params.frameId, url: m.params.response.url, status: m.params.response.status });
    if (m.method === 'Network.requestWillBeSent' && m.params.type === 'Document' && m.params.redirectResponse) docs.push({ frame: m.params.frameId, url: m.params.redirectResponse.url, status: m.params.redirectResponse.status, to: m.params.request.url });
  };
  await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
  const top = (await send('Page.getFrameTree')).frameTree.frame.id;
  for (const t of targets) {
    docs = [];
    const checked_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await send('Page.navigate', { url: t.url }).catch(() => {});
    await sleep(7000);
    const val = async x => { try { return (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.value; } catch { return null; } };
    const chain = docs.filter(d => d.frame === top);
    const final = chain.filter(d => !d.to).at(-1);
    const responseUrl = final?.url || null;
    rows.push({ ...t, checked_at, status: final?.status ?? null, redirects: chain.filter(d => d.to).map(d => `${d.status} -> ${d.to}`), final_url: responseUrl, title: String(await val('document.title') || '').slice(0, 90), final_host_allowed: responseUrl ? isAllowedDestination(t.id, responseUrl) : false });
    console.log(JSON.stringify(rows.at(-1)));
  }
  ws.close();
} finally {
  try { chrome.kill(); } catch {}
  await sleep(1000);
  if (!argDir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
const bad = rows.filter(r => r.status !== 200 || !r.final_host_allowed);
console.log(`\n${rows.length} URLs checked, ${bad.length} not verifiable: ${bad.map(r => `${r.id}.${r.field}`).join(', ') || 'none'}`);
process.exitCode = bad.length ? 1 : 0;
