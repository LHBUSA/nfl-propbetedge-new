/* PropBetEdge NFL — Career Ledger, on every Player DNA product (QB/RB/WR/TE).
 *
 * Factual history, directly under the player hero:  CAREER | SEASONS | GAME LOG
 *
 * The analytical DNA below it (historical baseline, conditions, signals, Prop
 * Lab) is untouched and still draws its own sample; this is the record, not a
 * model input, and nothing here feeds a baseline.
 *
 * Label: CAREER only when the API proves debut -> today coverage; otherwise
 * TRACKED HISTORY with the missing seasons named.
 *
 * LIVE: when the player's game is live the API adds the published box-score
 * line to the verified career once (deduplicated by event id). The UPDATED
 * counter advances every second locally from box_score_fetched_at; the data is
 * re-read on the live cadence (LIVE_POLL_MS), only while this route is open,
 * the tab is visible, the same player is selected and the game is still live.
 * No one-second network loop, no global timer.
 *
 * It attaches itself like player-current-layer-v1.js: observes the route and
 * the container and inserts after .q2-hero, without editing the DNA products.
 */
(() => {
  'use strict';

  const PRODUCTS = { qbdna: 'PBEQBDna', wrdna: 'PBEWRDna', rbdna: 'PBERBDna', tedna: 'PBETEDna' };
  const MARK = 'data-pbe-career-ledger';
  /* PBEcast's summary lane re-reads the box score about every 12s; the ledger
     rides the same order of cadence. */
  const LIVE_POLL_MS = 15000;
  /* Kickoff discovery: one read a minute, only inside the ten minutes before a
     scheduled kickoff (and while it has not flipped live yet). */
  const PREKICK_POLL_MS = 60000;
  const PREKICK_WINDOW_MS = 10 * 60000;

  const LABEL = {
    games: 'G', starts: 'GS', cmp: 'CMP', att: 'ATT', pyd: 'PASS YDS', ptd: 'PASS TD', int: 'INT', cmp_pct: 'CMP%', ypa: 'Y/A',
    car: 'CAR', ryd: 'RUSH YDS', rtd: 'RUSH TD', rec: 'REC', tgt: 'TGT', recyd: 'REC YDS', rectd: 'REC TD'
  };
  const LONG = {
    games: 'Games', starts: 'Starts', cmp: 'Completions', att: 'Attempts', pyd: 'Passing yards', ptd: 'Passing TD', int: 'Interceptions',
    cmp_pct: 'Completion %', ypa: 'Yards / attempt', car: 'Rush attempts', ryd: 'Rushing yards', rtd: 'Rushing TD', rec: 'Receptions',
    tgt: 'Targets', recyd: 'Receiving yards', rectd: 'Receiving TD'
  };

  const state = {
    key: null, espnId: null, payload: null, error: null, loading: false, token: 0,
    tab: 'career', seasonType: 'REG', logSeason: null, logType: 'ALL',
    poll: null, tick: null, fetches: 0
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);
  const fmt = (v, k) => {
    if (v === null || v === undefined) return '—';
    if (k === 'cmp_pct') return `${v}%`;
    return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
  };

  function active() {
    const route = window.App?.current;
    const g = PRODUCTS[route];
    if (!g) return null;
    const p = window[g]?.state?.dna?.player;
    const espnId = String(p?.espn_id || '');
    return p ? { route, espnId } : null;
  }

  /* ---- data ------------------------------------------------------------------ */
  async function fetchCareer(espnId) {
    state.fetches += 1;
    const r = await fetch(`/api/player-career?espn_id=${encodeURIComponent(espnId)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`player_career_${r.status}`);
    return body;
  }

  function stopTimers() {
    clearTimeout(state.poll); state.poll = null;
    clearInterval(state.tick); state.tick = null;
  }

  /* The only decision about re-reading. Exposed for the acceptance test. */
  function nextPollDelay(payload, now = Date.now(), visible = true) {
    if (!visible || !payload || payload.ok === false) return null;
    if (payload.live) return LIVE_POLL_MS;
    const t = payload.today;
    if (t?.state === 'SCHEDULE') {
      const until = Date.parse(t.kickoff || '') - now;
      if (Number.isFinite(until) && until <= PREKICK_WINDOW_MS && until > -3 * 3600000) return PREKICK_POLL_MS;
    }
    return null;
  }

  function schedule() {
    clearTimeout(state.poll); state.poll = null;
    const delay = nextPollDelay(state.payload, Date.now(), document.visibilityState !== 'hidden');
    if (delay == null) return;
    const token = state.token, key = state.key;
    state.poll = setTimeout(async () => {
      state.poll = null;
      const ctx = active();
      if (!ctx || `${ctx.route}|${ctx.espnId}` !== key || token !== state.token || document.visibilityState === 'hidden') return;
      try {
        const body = await fetchCareer(ctx.espnId);
        if (token !== state.token) return;
        state.payload = body; state.error = null;
      } catch (e) { state.error = e.message; }
      paint();
      schedule();
    }, delay);
  }

  /* The UPDATED counter: a local second hand over the provider's fetch stamp. */
  function ensureTick() {
    const liveNow = !!state.payload?.live && document.visibilityState !== 'hidden';
    if (!liveNow) { clearInterval(state.tick); state.tick = null; return; }
    if (state.tick) return;
    state.tick = setInterval(() => {
      const el = document.querySelector(`[${MARK}] [data-cl-age]`);
      if (!el || !state.payload?.live) { clearInterval(state.tick); state.tick = null; return; }
      el.textContent = ageText(state.payload.live.box_score_fetched_at);
    }, 1000);
  }
  function ageText(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return 'UPDATED —';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? `UPDATED ${s}s AGO` : `UPDATED ${Math.round(s / 60)}m AGO`;
  }

  /* ---- render ----------------------------------------------------------------- */
  function tiles(fields, t, liveT) {
    return `<dl class="pbe-car-tiles">${fields.map(k => {
      const unsupported = arr(state.payload?.unsupported_fields).includes(k);
      const v = liveT ? liveT[k] : t?.[k];
      const moved = liveT && t && liveT[k] !== t[k] && liveT[k] != null;
      return `<div class="${moved ? 'is-moving' : ''}${unsupported ? ' is-unsupported' : ''}" ${unsupported ? 'title="Not published by the provider for any season"' : v == null ? 'title="Not published for every game in this set"' : ''}><dt><span class="pbe-car-l">${esc(LONG[k] || k)}</span><span class="pbe-car-s" aria-hidden="true">${esc(LABEL[k] || k)}</span></dt><dd>${esc(fmt(v, k))}</dd></div>`;
    }).join('')}</dl>`;
  }

  function careerTab(p) {
    const f = arr(p.stat_fields);
    const live = p.live;
    const reg = p.totals?.regular_season, post = p.totals?.postseason;
    const liveReg = live?.season_type === 'REG' ? live.totals?.regular_season : null;
    const livePost = live?.season_type === 'POST' ? live.totals?.postseason : null;
    const seasons = new Set(arr(p.seasons).filter(s => s.season_type === 'REG').map(s => s.season));
    const span = p.career_span ? `${p.career_span.from}–${p.career_span.to}` : '—';
    const liveBanner = live ? `<div class="pbe-car-live" role="status">
        <span class="pbe-car-livepill"><i aria-hidden="true"></i>LIVE ${esc(p.label === 'CAREER' ? 'CAREER' : 'TRACKED')} TOTALS</span>
        <span>through <b>${esc(live.through || 'live')}</b>${live.score ? ` · ${esc(live.score)}` : ''}</span>
        <span class="pbe-car-age" data-cl-age>${esc(ageText(live.box_score_fetched_at))}</span>
        <small>Verified history through the prior final plus this game's currently published box score. It is replaced by the final line when the game ends.</small>
      </div>` : '';
    return `${liveBanner}
      <div class="pbe-car-block"><h4>Regular season${liveReg ? ' · live' : ''}</h4>${tiles(f, reg, liveReg)}</div>
      ${post?.games || livePost ? `<div class="pbe-car-block is-post"><h4>Postseason${livePost ? ' · live' : ''}</h4>${tiles(f.filter(k => k !== 'starts'), post, livePost)}</div>` : ''}
      <dl class="pbe-car-facts">
        <div><dt>Seasons played</dt><dd>${esc(seasons.size)}</dd></div>
        <div><dt>Career span</dt><dd>${esc(span)}</dd></div>
        <div><dt>${p.player?.active ? 'Current team' : 'Last team'}</dt><dd>${esc((p.player?.active ? p.player?.current_team : arr(p.player?.teams).slice(-1)[0]) || '—')}</dd></div>
        <div><dt>Teams</dt><dd>${esc(arr(p.player?.teams).join(' · ') || '—')}</dd></div>
      </dl>`;
  }

  function seasonsTab(p) {
    const f = arr(p.stat_fields).filter(k => k !== 'starts');
    const rows = arr(p.seasons).filter(s => s.season_type === state.seasonType);
    const hasPost = arr(p.seasons).some(s => s.season_type === 'POST');
    return `<div class="pbe-car-controls">
        <div class="pbe-car-seg" role="group" aria-label="Season type">
          <button type="button" data-cl-stype="REG" aria-pressed="${state.seasonType === 'REG'}">Regular season</button>
          <button type="button" data-cl-stype="POST" aria-pressed="${state.seasonType === 'POST'}"${hasPost ? '' : ' disabled'}>Postseason</button>
        </div></div>
      ${rows.length ? `<div class="pbe-car-scroll"><table class="pbe-car-table"><thead><tr><th scope="col">Season</th><th scope="col">Team</th>${f.map(k => `<th scope="col" title="${esc(LONG[k])}">${esc(LABEL[k])}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(s => `<tr${s.provisional ? ' class="is-live"' : ''}><th scope="row">${esc(s.season)}${s.provisional ? ' <em>LIVE</em>' : ''}</th><td>${esc(s.teams.join('/'))}</td>${f.map(k => `<td>${esc(fmt(s[k], k))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="pbe-car-empty">No games of this type in the ledger.</div>'}`;
  }

  function logTab(p) {
    const f = arr(p.stat_fields).filter(k => !['games', 'starts', 'cmp_pct', 'ypa'].includes(k));
    const all = arr(p.game_log);
    const seasons = [...new Set(all.map(g => g.season))].sort((a, b) => b - a);
    if (state.logSeason == null || !seasons.includes(state.logSeason)) state.logSeason = seasons[0] ?? null;
    const rows = all.filter(g => g.season === state.logSeason && (state.logType === 'ALL' || g.season_type === state.logType));
    const date = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); };
    return `<div class="pbe-car-controls">
        <label class="pbe-car-select"><span>Season</span><select data-cl-logseason aria-label="Game log season">${seasons.map(s => `<option value="${esc(s)}"${s === state.logSeason ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <div class="pbe-car-seg" role="group" aria-label="Game type">
          ${['ALL', 'REG', 'POST'].map(t => `<button type="button" data-cl-logtype="${t}" aria-pressed="${state.logType === t}">${t === 'ALL' ? 'All' : t === 'REG' ? 'Regular' : 'Postseason'}</button>`).join('')}
        </div>
        <span class="pbe-car-count">${esc(rows.length)} game${rows.length === 1 ? '' : 's'}</span></div>
      ${rows.length ? `<div class="pbe-car-scroll"><table class="pbe-car-table is-log"><thead><tr><th scope="col">Date</th><th scope="col">Wk</th><th scope="col">Opp</th><th scope="col">Result</th>${f.map(k => `<th scope="col" title="${esc(LONG[k])}">${esc(LABEL[k])}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(g => `<tr class="${g.status === 'LIVE' ? 'is-live' : ''}"><th scope="row">${esc(date(g.date))}${g.season_type === 'POST' ? ' <em>POST</em>' : ''}</th><td>${esc(g.week ?? '')}</td><td>${g.home ? 'vs' : '@'} ${esc(g.opponent || '')}${g.team ? ` <small>${esc(g.team)}</small>` : ''}</td><td>${g.status === 'LIVE' ? '<b class="pbe-car-livetag">LIVE</b>' : esc(g.result || '—')}</td>${f.map(k => `<td>${esc(fmt(g.stats?.[k], k))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="pbe-car-empty">No games for this filter.</div>'}`;
  }

  function coverageNote(p) {
    const c = p.coverage || {};
    const notes = arr(c.provider_reconciliation?.notes);
    const tracked = p.label !== 'CAREER';
    return `<footer class="pbe-car-foot">
      ${tracked ? `<p class="pbe-car-why"><b>Tracked history, not a full career.</b> ${esc(arr(c.why_not_career).slice(0, 4).join(' · ') || 'Debut-to-today coverage is not proven.')}${arr(c.why_not_career).length > 4 ? ` · +${esc(arr(c.why_not_career).length - 4)} more` : ''}</p>`
        : `<p>Every regular-season game from ${esc(c.debut_season)} through ${p.player?.active ? 'today' : esc(p.career_span?.to ?? '')} is in the ledger, reconciled season by season against the provider.</p>`}
      <p>ESPN game logs, joined on the ESPN athlete id. Totals are sums of the games below; games started is not published by the source and shows —. Pro Bowl games are not counted.</p>
      ${notes.length ? `<details class="pbe-car-notes"><summary>Provider surfaces disagree on ${esc(notes.length)} figure${notes.length === 1 ? '' : 's'}</summary><ul>${notes.slice(0, 12).map(n => `<li>${esc(n.season)} ${esc(LONG[n.field] || n.field)}: game log ${esc(n.ledger)}, season row ${esc(n.provider)}</li>`).join('')}</ul></details>` : ''}
    </footer>`;
  }

  function sectionHtml() {
    const p = state.payload;
    if (!p) {
      return `<section class="pbe-car" ${MARK} aria-busy="true"><div class="pbe-car-head"><span class="pbe-car-eyebrow">CAREER LEDGER</span></div><div class="pbe-car-empty">${state.error ? `Career ledger unavailable (${esc(state.error)}). Nothing is estimated in its place.` : 'Reading the game-by-game record…'}</div></section>`;
    }
    if (p.ok === false) {
      const text = p.error === 'not_tracked' ? 'This player is not in the Career Ledger yet. No history is matched by name.' : `Career ledger unavailable (${p.error || 'error'}). Nothing is estimated in its place.`;
      return `<section class="pbe-car" ${MARK}><div class="pbe-car-head"><span class="pbe-car-eyebrow">CAREER LEDGER</span></div><div class="pbe-car-empty">${esc(text)}</div></section>`;
    }
    const tabs = [['career', p.label === 'CAREER' ? 'Career' : 'Tracked history'], ['seasons', 'Seasons'], ['log', 'Game log']];
    const body = state.tab === 'seasons' ? seasonsTab(p) : state.tab === 'log' ? logTab(p) : careerTab(p);
    const span = p.career_span ? `${p.career_span.from}–${p.career_span.to}` : '';
    return `<section class="pbe-car${p.live ? ' is-live' : ''}" ${MARK} data-cl-label="${esc(p.label)}" data-cl-espn="${esc(p.player?.espn_id)}">
      <div class="pbe-car-head">
        <div><span class="pbe-car-eyebrow${p.label === 'CAREER' ? '' : ' is-tracked'}">${esc(p.label)}</span>
          <span class="pbe-car-sub">${esc([p.player?.position, span, `${arr(p.seasons).filter(s => s.season_type === 'REG').length} seasons`].filter(Boolean).join(' · '))}</span></div>
        <div class="pbe-car-tabs" role="tablist" aria-label="Career ledger">${tabs.map(([k, t]) => `<button type="button" role="tab" data-cl-tab="${k}" aria-selected="${state.tab === k}">${esc(t)}</button>`).join('')}</div>
      </div>
      <div class="pbe-car-body" role="tabpanel">${body}</div>
      ${coverageNote(p)}
    </section>`;
  }

  function paint() {
    const vc = document.getElementById('view-container');
    const hero = vc?.querySelector('.q2-hero');
    if (!hero) return;
    const html = sectionHtml();
    const existing = vc.querySelector(`[${MARK}]`);
    if (existing) {
      if (existing.__pbeSig !== html) {
        existing.insertAdjacentHTML('afterend', html);
        existing.remove();
        vc.querySelector(`[${MARK}]`).__pbeSig = html;
      }
    } else {
      hero.insertAdjacentHTML('afterend', html);
      vc.querySelector(`[${MARK}]`).__pbeSig = html;
    }
    ensureTick();
  }

  async function sync(force) {
    const ctx = active();
    if (!ctx) { stopTimers(); state.key = null; return; }
    const key = `${ctx.route}|${ctx.espnId}`;
    if (!force && key === state.key && document.querySelector(`[${MARK}]`)) return;
    if (key !== state.key) {
      /* A different player: nothing of the previous one survives, including
         its live poll. */
      stopTimers();
      state.token += 1; state.key = key; state.espnId = ctx.espnId;
      state.payload = null; state.error = null; state.tab = 'career'; state.logSeason = null; state.logType = 'ALL'; state.seasonType = 'REG';
    }
    if (!ctx.espnId) { state.payload = { ok: false, error: 'no_espn_id' }; paint(); return; }
    if (state.payload) { paint(); if (!state.poll) schedule(); return; }
    paint();
    const token = state.token;
    try {
      const body = await fetchCareer(ctx.espnId);
      if (token !== state.token) return;
      state.payload = body;
    } catch (e) {
      if (token !== state.token) return;
      state.error = e.message;
    }
    paint();
    schedule();
  }

  /* ---- interaction ----------------------------------------------------------- */
  document.addEventListener('click', e => {
    const root = e.target.closest?.(`[${MARK}]`);
    if (!root) return;
    const tab = e.target.closest('[data-cl-tab]');
    const st = e.target.closest('[data-cl-stype]');
    const lt = e.target.closest('[data-cl-logtype]');
    if (tab) state.tab = tab.dataset.clTab;
    else if (st && !st.disabled) state.seasonType = st.dataset.clStype;
    else if (lt) state.logType = lt.dataset.clLogtype;
    else return;
    paint();
    root.ownerDocument.querySelector(`[${MARK}] [data-cl-tab="${state.tab}"]`)?.focus?.();
  });
  document.addEventListener('change', e => {
    const sel = e.target.closest?.(`[${MARK}] [data-cl-logseason]`);
    if (!sel) return;
    state.logSeason = Number(sel.value);
    paint();
    document.querySelector(`[${MARK}] [data-cl-logseason]`)?.focus?.();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { stopTimers(); return; }
    /* Back on screen: one read if the game was live, then the normal cadence. */
    const ctx = active();
    if (ctx && `${ctx.route}|${ctx.espnId}` === state.key && state.payload?.live) {
      const token = state.token;
      fetchCareer(ctx.espnId).then(b => { if (token === state.token) { state.payload = b; paint(); schedule(); } }).catch(() => schedule());
    } else ensureTick();
  });

  /* The DNA products re-render their container on player change and chart
     repaints, which removes anything inserted after the hero. */
  let restoring = false;
  function watch() {
    const vc = document.getElementById('view-container');
    if (!vc || vc.__pbeCareerWatched) return !!vc;
    vc.__pbeCareerWatched = true;
    new MutationObserver(() => {
      if (restoring) return;
      if (!PRODUCTS[window.App?.current]) { if (state.poll || state.tick) stopTimers(); return; }
      if (!vc.querySelector('.q2-hero')) return;
      const ctx = active();
      const present = vc.querySelector(`[${MARK}]`);
      if (present && ctx && `${ctx.route}|${ctx.espnId}` === state.key) return;
      restoring = true;
      try { sync(false); } finally { setTimeout(() => { restoring = false; }, 0); }
    }).observe(vc, { childList: true, subtree: true });
    return true;
  }

  window.PBECareerLedger = { sync, state, nextPollDelay, LIVE_POLL_MS, PREKICK_POLL_MS };
  window.addEventListener('pbe:route-changed', () => {
    watch();
    if (!active()) { stopTimers(); state.key = null; return; }
    setTimeout(() => sync(false), 60);
  });
  if (!watch()) document.addEventListener('DOMContentLoaded', watch, { once: true });
  setTimeout(() => { watch(); sync(false); }, 1200);
})();
