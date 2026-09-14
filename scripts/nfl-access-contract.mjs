/* NFL access contract for post-deploy and browser smokes (Access V2).
 *
 * Replaces scripts/qa-entitled-api.mjs, which was written for the removed
 * site-wide wall (nfl-access-gate-v1.js, 224d20d): there `data-pbe-access` on
 * <html> meant "this tree is paywalled", the workspace never loaded without a
 * `granted` verdict, and a smoke needed a QA subscriber harness to see any page.
 *
 * Access V2 (1551b3a) is different and this module tests THAT:
 *   - the application shell always loads; `data-pbe-access` is only the
 *     reader's verdict (anonymous | no_entitlement | granted | unavailable),
 *     written by paywall.js, never a wall;
 *   - premium data is refused at its own boundary: 401 signed out, 403 signed in
 *     without a qualifying purchase, 503 when the entitlement cannot be checked;
 *   - the Official Track Record and the publication gate are public counts; the
 *     validation detail is NFL Pro.
 *
 * Live production can only be exercised as an anonymous (or forged-cookie)
 * reader: nothing here mints a production session or entitlement. 403, 503 and
 * the entitled-Pro path are proven against the same handler code by the
 * controlled suites (tests/nfl-auth-access-v2.test.mjs,
 * tests/nfl-auth-model-boundary.test.mjs, tests/pbe-track-record-v3.test.mjs).
 *
 * The judge* functions are pure so tests/nfl-auth-smoke-contract.test.mjs can
 * prove every rule fails when it should.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { SELECTION_FIELDS } from '../workers/nfl-picks-engine-shared/publication.mjs';

export const ACCESS_VERDICTS = Object.freeze(['anonymous', 'no_entitlement', 'granted', 'unavailable']);
export const SESSION_COOKIE = 'pbe_nfl_session_v2';

/* ------------------------------------------------------------------ shell */

/* Evaluated in the page. The old wall showed nothing but a status line until a
   `granted` verdict loaded the workspace; so "no wall" is: the workspace booted
   (App + a registered view), the shell is visible, the view renders, and no
   upgrade modal opened on its own. */
export const SHELL_PROBE = `(()=>{
  const html=document.documentElement,shell=document.querySelector('#pbe-sports-shell,.shell'),vc=document.querySelector('#view-container');
  const visible=el=>{if(!el)return false;const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0.05&&r.width>0&&r.height>0};
  const backdrop=document.getElementById('pbe-pro-backdrop');
  return{
    verdict:html.dataset.pbeAccess??null,
    app:typeof window.App?.nav==='function',
    views:window.App?.VIEWS?Object.keys(window.App.VIEWS).length:0,
    shell:visible(shell),
    viewChars:(vc?.textContent||'').trim().length,
    bodyHidden:!visible(document.body),
    modalOpen:!!backdrop?.classList.contains('open'),
    gateScript:!!document.querySelector('script[src*="nfl-access-gate"]')
  };
})()`;

export function judgeShell(s, { expect = 'anonymous' } = {}) {
  if (!s || typeof s !== 'object') return `shell probe failed (${String(s)})`;
  if (!ACCESS_VERDICTS.includes(s.verdict)) return `access verdict unresolved (${s.verdict ?? 'none'}): paywall.js never finished its session check`;
  if (expect && s.verdict !== expect) return `expected a ${expect} reader, got ${s.verdict}`;
  if (s.gateScript) return 'site-wide access gate script is loaded';
  if (!s.app || !(s.views > 0)) return `workspace did not boot for a ${s.verdict} reader (site-wide wall)`;
  if (s.bodyHidden || !s.shell) return `application shell hidden for a ${s.verdict} reader (site-wide wall)`;
  if (!(s.viewChars > 80)) return `public view did not render for a ${s.verdict} reader (${s.viewChars} chars)`;
  if (s.modalOpen) return 'upgrade modal opened without a Pro action (a wall by another name)';
  return null;
}

/* ------------------------------------------------------------------ premium */

/* Every browser-reachable premium read. `decision` needs an id; a random UUID
   proves the refusal happens before any lookup. */
export const PREMIUM_ROUTES = Object.freeze([
  { name: 'pro-model', path: '/api/pro-model?event_id=post-deploy-smoke' },
  { name: 'pbe-picks current', path: '/api/pbe-picks?view=current' },
  { name: 'pbe-picks validation-history', path: '/api/pbe-picks?view=validation-history' },
  { name: 'pbe-picks decision', path: () => `/api/pbe-picks?view=decision&id=${randomUUID()}` },
  { name: 'pbe-prop-picks current', path: '/api/pbe-prop-picks?view=current' },
]);

/* The model host itself: no server credential, no model. */
export const DIRECT_MODEL = 'https://nfl-api.propbetedge.ai/api/picks/pass?event_id=post-deploy-smoke';

const LEAK = /"(selection|selection_team|side|market_price|market_line|model_prob|model_line|edge_pct|stake_units|features|picks|passes|projection)"\s*:/;

export function judgeRefusal(r, { status = [401], label = '' } = {}) {
  if (!r) return `${label}: no response`;
  if (!status.includes(r.status)) return `${label}: expected ${status.join('/')} got ${r.status}`;
  if (LEAK.test(r.text || '')) return `${label}: refusal body carries premium fields`;
  if (/max-age=[1-9]|s-maxage=[1-9]/.test(r.cacheControl || '')) return `${label}: refusal is publicly cacheable (${r.cacheControl})`;
  return null;
}

/* A session token with owner/Pro claims signed by a key production does not
   hold. It must read as signed out (401), never as a signed-in reader. */
export function forgedSessionCookie(email = 'owner@forged.invalid') {
  const b64u = v => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const t = Math.floor(Date.now() / 1000);
  const data = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email, type: 'session', role: 'owner', pro: true, iat: t, exp: t + 600, jti: randomUUID() }))}`;
  return `${SESSION_COOKIE}=${data}.${b64u(createHmac('sha256', `forged:${randomUUID()}`).update(data).digest())}`;
}

/* ------------------------------------------------------------------ track record */

export function selectionKeys(payload, path = '$', out = []) {
  if (Array.isArray(payload)) payload.forEach((v, i) => selectionKeys(v, `${path}[${i}]`, out));
  else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (SELECTION_FIELDS.includes(k)) out.push(`${path}.${k}`);
      selectionKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const int = v => Number.isInteger(v) && v >= 0;

/* Public Track Record contract over view=state, view=preview and
   view=trackrecord. Values are read, never hard-coded: 19/100 today is a
   different number tomorrow, but the relations below hold on every day. */
export function judgeTrackRecord({ state, preview, trackrecord }) {
  const problems = [];
  const p = m => problems.push(m);
  if (!state || typeof state !== 'object') return ['view=state unreadable'];
  /* the publication gate: >= 100 finalized AND >= 4 weeks, published as counts */
  if (state.graded_sample_required !== 100) p(`graded_sample_required ${state.graded_sample_required} (gate is 100)`);
  if (state.distinct_weeks_required !== 4) p(`distinct_weeks_required ${state.distinct_weeks_required} (gate is 4)`);
  if (!int(state.graded_sample) || !int(state.distinct_weeks)) p('gate progress is not a pair of counts');
  if (int(state.graded_sample_tracking) && int(state.graded_sample_official)
    && state.graded_sample !== state.graded_sample_tracking + state.graded_sample_official) p('graded_sample != tracking + official observations');
  const open = state.graded_sample >= 100 && state.distinct_weeks >= 4;
  if (state.auto_tuner !== (open ? 'ELIGIBLE' : 'GATED')) p(`auto_tuner ${state.auto_tuner} disagrees with ${state.graded_sample}/100, ${state.distinct_weeks}/4`);
  if (state.publication !== (state.champion_trained === true ? 'ALLOWED' : 'GATED')) p(`publication ${state.publication} disagrees with champion_trained=${state.champion_trained}`);
  /* validation and official totals are separate objects, never summed */
  const tr = state.decisions?.tracking, off = state.decisions?.official;
  if (!tr || !off || tr === off) p('decisions.tracking / decisions.official missing or merged');
  else {
    for (const [scope, d] of [['tracking', tr], ['official', off]]) for (const k of ['total', 'open', 'graded']) if (!int(d[k])) p(`decisions.${scope}.${k} is not a count`);
    if (off.graded > off.total || tr.graded > tr.total) p('graded exceeds total');
  }
  const leaks = selectionKeys(state);
  if (leaks.length) p(`view=state exposes decision content: ${leaks.slice(0, 4).join(', ')}`);
  if (preview) {
    const pl = selectionKeys(preview);
    if (pl.length) p(`view=preview exposes decision content: ${pl.slice(0, 4).join(', ')}`);
  }
  /* the official record is official only */
  if (!trackrecord || typeof trackrecord !== 'object') p('view=trackrecord unreadable');
  else {
    if (trackrecord.publication_scope !== 'official') p(`trackrecord publication_scope ${trackrecord.publication_scope}`);
    const picks = Array.isArray(trackrecord.picks) ? trackrecord.picks : null;
    if (!picks) p('trackrecord.picks missing');
    else {
      if (picks.some(r => r.publication_scope && r.publication_scope !== 'official')) p('trackrecord carries a non-official row');
      if (off && int(off.total) && picks.length > off.total) p(`trackrecord lists ${picks.length} rows but official total is ${off.total}`);
      if (off && off.total === 0 && (picks.length || trackrecord.total_count)) p('official total is 0 but trackrecord lists rows');
      if (picks.some(r => /VALIDATION/i.test(String(r.label || '')))) p('a validation signal is in the official record');
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ live runner */

async function get(url, { cookie } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) }, redirect: 'manual', cache: 'no-store', signal: controller.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, text, json, cacheControl: r.headers.get('cache-control') || '' };
  } catch (error) {
    return { status: 0, text: String(error?.message || error), json: null, cacheControl: '' };
  } finally { clearTimeout(timer); }
}

export async function runLiveContract({ origin, log = console.log }) {
  const failures = [];
  const check = (label, problem) => { log(`${problem ? 'FAIL' : 'ok  '} ${label}${problem ? ` — ${problem}` : ''}`); if (problem) failures.push(`${label}: ${problem}`); };

  log('=== PUBLIC ===');
  const home = await get(`${origin}/`);
  check('app shell document 200', home.status === 200 && /page-loader\.js/.test(home.text) && !/nfl-access-gate/.test(home.text) ? null : `status ${home.status}${/nfl-access-gate/.test(home.text) ? ', loads the access gate' : ''}`);
  const session = await get(`${origin}/api/auth-session`);
  check('auth-session anonymous verdict', session.status === 200 && session.json?.access === 'anonymous' && session.json?.pro === false ? null : `status ${session.status} access=${session.json?.access} pro=${session.json?.pro}`);

  log('=== PREMIUM BOUNDARIES (anonymous) ===');
  for (const route of PREMIUM_ROUTES) {
    const path = typeof route.path === 'function' ? route.path() : route.path;
    const r = await get(`${origin}${path}`);
    check(`${route.name} signed out -> 401`, judgeRefusal(r, { status: [401], label: route.name }) || (r.json?.error === 'sign_in_required' ? null : `error=${r.json?.error}`));
  }
  log('=== PREMIUM BOUNDARIES (forged owner session) ===');
  const forged = forgedSessionCookie();
  for (const route of PREMIUM_ROUTES.slice(0, 3)) {
    const path = typeof route.path === 'function' ? route.path() : route.path;
    const r = await get(`${origin}${path}`, { cookie: forged });
    check(`${route.name} forged session -> 401`, judgeRefusal(r, { status: [401], label: route.name }));
  }
  const forgedSession = await get(`${origin}/api/auth-session`, { cookie: forged });
  check('auth-session forged session is not signed in', forgedSession.json?.valid !== true && forgedSession.json?.pro !== true && forgedSession.json?.role !== 'owner' ? null : `valid=${forgedSession.json?.valid} pro=${forgedSession.json?.pro} role=${forgedSession.json?.role}`);
  const direct = await get(DIRECT_MODEL);
  check('model host without server credential -> 401', judgeRefusal(direct, { status: [401], label: 'nfl-api /api/picks/pass' }));

  log('=== TRACK RECORD (public) ===');
  const [state, preview, trackrecord] = await Promise.all(['state', 'preview', 'trackrecord'].map(v => get(`${origin}/api/pbe-picks?view=${v}`)));
  check('view=state 200', state.status === 200 ? null : `status ${state.status}`);
  check('view=preview 200', preview.status === 200 ? null : `status ${preview.status}`);
  check('view=trackrecord 200', trackrecord.status === 200 ? null : `status ${trackrecord.status}`);
  const problems = judgeTrackRecord({ state: state.json, preview: preview.json, trackrecord: trackrecord.json });
  check('public Track Record contract', problems.length ? problems.join('; ') : null);
  const s = state.json || {};
  log(`live gate              : ${s.graded_sample}/${s.graded_sample_required} finalized, ${s.distinct_weeks}/${s.distinct_weeks_required} weeks, publication ${s.publication}, engine ${s.engine_health}`);
  log(`live decisions         : validation ${JSON.stringify(s.decisions?.tracking)} official ${JSON.stringify(s.decisions?.official)}`);
  log(`official record rows   : ${Array.isArray(trackrecord.json?.picks) ? trackrecord.json.picks.length : '—'}`);
  return failures;
}
