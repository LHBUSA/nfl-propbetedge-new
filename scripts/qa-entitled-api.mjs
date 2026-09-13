/* QA entitlement for browser smokes that load the NFL workspace.
 *
 * NFL is a subscription product: once the tree carries the access gate
 * (nfl-access-gate-v1.js), the workspace loads only for a verified NFL
 * entitlement and every paid /api route checks it server-side. A smoke that
 * opens production with branch statics and no subscriber therefore sees the
 * wall, correctly. Production is never bypassed and no real cookie is used.
 *
 * Instead, the smoke answers same-origin /api/* requests with the checked-out
 * branch's own handlers, run by scripts/nfl-access-local-server.mjs (--odds
 * live: gateway reads go to the public gateway's KV snapshot, zero provider
 * spend), under the QA subscriber identity established through the real
 * /api/auth-verify handler. This is the same mechanism the paywall browser
 * gate uses.
 *
 * A tree without the harness has no paywall: startEntitledApi() returns null
 * and the smoke keeps reading production APIs as before. assertAccess() makes
 * the combination explicit so a paywalled tree can never pass silently without
 * a subscriber, and an entitled run must actually be granted.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startEntitledApi({ repo, email = 'pro@qa.test', log = () => {} } = {}) {
  const script = join(repo, 'scripts', 'nfl-access-local-server.mjs');
  if (!existsSync(script)) return null;
  const port = 8600 + Math.floor(Math.random() * 90);
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, [script, '--port', String(port), '--odds', 'live'], { stdio: 'ignore' });
  const stop = () => { try { child.kill(); } catch (_) {} };
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${base}/api/auth-session`)).ok; } catch (_) {} if (!up) await sleep(250); }
    if (!up) throw new Error('qa_harness_not_ready');
    const { token } = await (await fetch(`${base}/__qa/magic?email=${encodeURIComponent(email)}`)).json();
    const verify = await fetch(`${base}/api/auth-verify?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const set = (verify.headers.getSetCookie?.() || []).find(c => c.startsWith('pbe_nfl_session_v2=') && !/Max-Age=0/.test(c));
    if (!set) throw new Error('qa_session_not_established');
    const cookie = set.split(';')[0];
    log(`QA entitlement: branch API handlers at ${base} as ${email}`);
    return {
      base, email, stop,
      /* Fulfil one paused CDP request for a same-origin /api/* URL. */
      async fulfill(send, params, origin) {
        const u = new URL(params.request.url);
        const h = params.request.headers || {};
        try {
          const headers = { accept: h.Accept || h.accept || 'application/json', cookie };
          if (params.request.postData) headers['content-type'] = h['Content-Type'] || h['content-type'] || 'application/json';
          const r = await fetch(`${base}${u.pathname}${u.search}`, { method: params.request.method, headers, body: params.request.postData, redirect: 'manual' });
          const body = Buffer.from(await r.arrayBuffer());
          const responseHeaders = [{ name: 'content-type', value: r.headers.get('content-type') || 'application/json' }, { name: 'cache-control', value: 'no-store' }];
          const loc = r.headers.get('location');
          if (loc) responseHeaders.push({ name: 'location', value: loc.replace(base, origin) });
          await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: r.status, responseHeaders, body: body.toString('base64') });
        } catch (_) {
          await send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 502, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'qa_harness_unreachable' })).toString('base64') }).catch(() => {});
        }
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

/* verdict = document.documentElement.dataset.pbeAccess as read in the page
   (undefined/null on a tree without the access gate). */
export function accessProblem(verdict, entitled) {
  const gated = typeof verdict === 'string' && verdict.length > 0;
  if (gated && !entitled) return `paywalled tree (access=${verdict}) but no QA entitlement harness: the protected page cannot be tested`;
  if (entitled && verdict !== 'granted') return `QA subscriber was not granted access (access=${verdict ?? 'no gate'})`;
  return null;
}
