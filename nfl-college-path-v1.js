/* PropBetEdge NFL — College Path, on every Player DNA product (QB/RB/WR/TE).
 *
 * The verified career path BEFORE the NFL: institution, programme, conference,
 * years, the head coach in post while the player was there, and the route into
 * professional football.
 *
 * It attaches itself the way the Career Ledger and the Current layer do —
 * observes the route and the container, inserts after whichever of them is on
 * screen — so none of the four DNA products is edited.
 *
 * NO PERFORMANCE DATA. There are no college statistics here, no recruiting
 * stars, no talent composite, no SP+, no FPI and no scouting grade. We hold no
 * rights to any of them (history/docs/COLLEGE_DATA_RIGHTS.md), and the API
 * refuses them on the way out. This section is a career-path layer, and it is
 * finished as one.
 *
 * ABSENCE IS NOT EVIDENCE. The data behind this comes from Wikidata, which
 * holds items for people notable enough to have one. A player with no record
 * here renders "College history not yet resolved" — a statement about our data.
 * It must never read as "no college" or "did not play college football", and
 * the API sends absence_is_not_evidence on every response to keep that explicit.
 *
 * One read per player, from a static release artifact. No timers, no polling:
 * a 2013 season does not change while the tab is open.
 */
(() => {
  'use strict';

  const PRODUCTS = { qbdna: 'PBEQBDna', wrdna: 'PBEWRDna', rbdna: 'PBERBDna', tedna: 'PBETEDna' };
  const MARK = 'data-pbe-college-path';

  const state = { key: null, espnId: null, payload: null, error: null, token: 0 };
  const cache = new Map();

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);

  function active() {
    const route = window.App?.current;
    const g = PRODUCTS[route];
    if (!g) return null;
    const p = window[g]?.state?.dna?.player;
    const espnId = String(p?.espn_id || '');
    return espnId ? { route, espnId } : null;
  }

  /* ---- data ------------------------------------------------------------------ */
  async function fetchPath(espnId) {
    if (cache.has(espnId)) return cache.get(espnId);
    const r = await fetch(`/api/nfl-college-path?espn_id=${encodeURIComponent(espnId)}`,
      { headers: { accept: 'application/json' } });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`college_path_${r.status}`);
    /* Only a real answer is memoised. A 503 must be retried on the next visit,
       not remembered as though it were the player's history. */
    if (body.ok) cache.set(espnId, body);
    return body;
  }

  /* ---- render ---------------------------------------------------------------- */
  const ROUTE_LABEL = {
    draft: 'Entered via the draft',
    supplemental_draft: 'Entered via the supplemental draft',
    undrafted_free_agent: 'Entered as an undrafted free agent',
    other_league: 'Entered from another league',
    unknown: 'Route into professional football not recorded',
  };

  function schoolRow(s, i, total) {
    const meta = [s.conference, s.years].filter(Boolean).map(esc).join(' · ');
    return `
      <li class="pbe-cp-row${i === total - 1 ? ' is-last' : ''}">
        <div class="pbe-cp-axis"><i></i></div>
        <div class="pbe-cp-body">
          <h4>${esc(s.school || 'Institution not named')}</h4>
          ${meta ? `<p class="pbe-cp-meta">${meta}</p>` : ''}
          ${s.program && s.program !== s.school ? `<p class="pbe-cp-prog">${esc(s.program)}</p>` : ''}
          <p class="pbe-cp-basis" title="${esc(s.basis_note || '')}">${esc(s.basis_note || '')}</p>
          ${s.date_precision && s.date_precision !== 'day' && s.years
            ? `<p class="pbe-cp-prec">Dated to the ${esc(s.date_precision)}</p>` : ''}
        </div>
      </li>`;
  }

  function coachBlock(coaches) {
    if (!coaches.length) {
      return `<div class="pbe-cp-block">
        <h5>Coaching context</h5>
        <p class="pbe-cp-none">No head-coach tenure is dated across these years in the sources we hold.</p>
      </div>`;
    }
    return `<div class="pbe-cp-block">
      <h5>Coaching context</h5>
      <ul class="pbe-cp-coaches">
        ${coaches.map(c => `<li><b>${esc(c.coach)}</b>${c.years
          ? `<span${c.years_note ? ` title="${esc(c.years_note)}" class="is-open"` : ''}>${esc(c.years)}</span>` : ''}${
          c.program ? `<em>${esc(c.program)}</em>` : ''}</li>`).join('')}
      </ul>
    </div>`;
  }

  function transitionBlock(t) {
    if (!t) return '';
    const detail = t.detail_available
      ? `<p class="pbe-cp-meta">Round ${esc(t.draft_round ?? '—')} · Pick ${esc(t.draft_overall_pick ?? '—')}</p>`
      /* Round and pick are widely known facts. That is not a licence: every
         draft-detail source in the registry is do_not_use, so the honest state
         is to say we do not carry them rather than to look them up elsewhere. */
      : `<p class="pbe-cp-none">Round and pick are not carried — no rights-clean source supplies them.</p>`;
    return `<div class="pbe-cp-block">
      <h5>Pro transition</h5>
      <p class="pbe-cp-route"><b>${esc(ROUTE_LABEL[t.entry_route] || ROUTE_LABEL.unknown)}</b>${
        t.entry_year ? ` <span>${esc(t.entry_year)}</span>` : ''}</p>
      ${detail}
    </div>`;
  }

  function foot(p) {
    const src = arr(p.provenance?.sources).join(' · ');
    const when = p.provenance?.retrieved_at ? String(p.provenance.retrieved_at).slice(0, 10) : null;
    if (!src && !when) return '';
    return `<p class="pbe-cp-foot">${esc(src)}${when ? ` · retrieved ${esc(when)}` : ''}</p>`;
  }

  function html(p) {
    /* The two "we do not have this" states. Neither says anything about the
       player, and both say so in words rather than by showing an empty box. */
    if (p.state === 'UNRESOLVED' || p.state === 'AMBIGUOUS') {
      return `<section class="pbe-cp is-none" ${MARK} aria-label="College path">
        <header class="pbe-cp-head">
          <span class="pbe-cp-eyebrow">COLLEGE PATH</span>
        </header>
        <p class="pbe-cp-empty"><b>${esc(p.label)}</b></p>
        <p class="pbe-cp-note">${p.state === 'AMBIGUOUS'
          ? 'Two identifiers disagreed about which player this is, so nothing is shown rather than a guess.'
          : 'This layer is built from open sources that do not cover every player. It is not a finding about this player.'}</p>
      </section>`;
    }

    const schools = arr(p.schools);
    return `<section class="pbe-cp" ${MARK} aria-label="College path">
      <header class="pbe-cp-head">
        <div>
          <span class="pbe-cp-eyebrow">COLLEGE PATH</span>
          <span class="pbe-cp-sub">BEFORE THE NFL</span>
        </div>
        <span class="pbe-cp-tag">NO PERFORMANCE DATA</span>
      </header>

      <ol class="pbe-cp-time">
        ${schools.map((s, i) => schoolRow(s, i, schools.length)).join('')}
      </ol>

      ${coachBlock(arr(p.coaches))}
      ${transitionBlock(p.transition)}
      ${foot(p)}
    </section>`;
  }

  /* ---- attach ---------------------------------------------------------------- */
  function paint() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    const existing = vc.querySelector(`[${MARK}]`);
    if (!PRODUCTS[window.App?.current]) { existing?.remove(); return; }

    const p = state.payload;
    /* A failed read removes the section rather than rendering an error box: the
       profile is complete without it, and a red box would imply the player. */
    if (!p || p.ok === false) { existing?.remove(); return; }

    const markup = html(p);
    if (existing) { existing.outerHTML = markup; return; }
    const anchor = vc.querySelector('[data-pbe-current-layer]')
      || vc.querySelector('[data-pbe-career-ledger]')
      || vc.querySelector('.q2-hero');
    if (!anchor) return;
    anchor.insertAdjacentHTML('afterend', markup);
  }

  async function sync() {
    const ctx = active();
    if (!ctx) { state.key = null; state.payload = null; return; }
    const key = `${ctx.route}|${ctx.espnId}`;
    const token = ++state.token;
    if (key === state.key && state.payload) { paint(); return; }
    state.key = key; state.espnId = ctx.espnId; state.payload = null; state.error = null;
    try {
      const body = await fetchPath(ctx.espnId);
      if (token !== state.token) return;
      state.payload = body;
    } catch (e) {
      if (token !== state.token) return;
      state.error = e.message;
    }
    paint();
  }

  /* The DNA products re-render their container on player change and chart
     repaints, which removes anything inserted after the hero. */
  let restoring = false;
  function watch() {
    const vc = document.getElementById('view-container');
    if (!vc || vc.__pbeCollegeWatched) return !!vc;
    vc.__pbeCollegeWatched = true;
    new MutationObserver(() => {
      if (restoring) return;
      if (!PRODUCTS[window.App?.current]) return;
      if (!vc.querySelector('.q2-hero')) return;
      const ctx = active();
      const present = vc.querySelector(`[${MARK}]`);
      if (present && ctx && `${ctx.route}|${ctx.espnId}` === state.key) return;
      restoring = true;
      try { sync(); } finally { setTimeout(() => { restoring = false; }, 0); }
    }).observe(vc, { childList: true, subtree: true });
    return true;
  }

  window.PBECollegePath = { sync, state, html, cache };
  window.addEventListener('pbe:route-changed', () => {
    watch();
    if (!active()) { state.key = null; return; }
    setTimeout(sync, 80);
  });
  if (!watch()) document.addEventListener('DOMContentLoaded', watch, { once: true });
  setTimeout(() => { watch(); sync(); }, 1300);
})();
