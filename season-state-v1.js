/* PropBetEdge NFL — season state, in one place.
 *
 * The product used to carry the season in a dozen places at once: a "2025
 * Final Standings" nav item, a stats view whose heading said 2025, a hardcoded
 * DEFAULT_EVENT repeated across eleven modules, and copy that assumed the
 * season had not started. When 2026 kicked off, none of it knew.
 *
 * This is the only module that answers "what season, week and game state is
 * it". Everything else reads window.PBESeason or listens for pbe:season-ready.
 * Nothing else may hardcode a season.
 *
 * It fails closed. If the contract cannot be fetched, PBESeason.data stays
 * null, PBESeason.error is set, and dependent surfaces are expected to say
 * "current data unavailable" rather than fall back to last season.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const EVENT_KEY = 'pbe_nfl_event';
  const REFRESH_MS = 90000;

  const state = { data: null, error: null, ready: false, fetchedAt: 0, timer: null };
  const listeners = [];

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);

  async function json(url, ms = 12000) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' }, signal: ctrl?.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } finally { if (t) clearTimeout(t); }
  }

  /* ---- the contract ----------------------------------------------------- */
  async function load() {
    try {
      const d = await json(`${API}/api/season`);
      if (!d || d.ok === false || !d.season) throw new Error('season_unresolved');
      state.data = d; state.error = null; state.fetchedAt = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      /* Deliberately not clearing a previously good contract: a transient
         failure should leave the last known season in place, marked stale by
         its own freshness block, rather than blank the product. */
    }
    state.ready = true;
    publish();
    return state.data;
  }

  function publish() {
    const detail = { season: state.data, error: state.error };
    try { window.dispatchEvent(new CustomEvent('pbe:season-ready', { detail })); } catch (_) {}
    listeners.splice(0).forEach(fn => { try { fn(state.data, state.error); } catch (_) {} });
    paintStrip();
    resolveDefaultEvent();
  }

  /* ---- default event ---------------------------------------------------
     Eleven modules resolve their event as
       ?event= || localStorage.pbe_nfl_event || DEFAULT_EVENT
     and that constant is a dead id that no longer appears in the odds feed at
     all. Rather than edit eleven copies, we keep the stored value pointed at
     a real, current event: whatever is live, else the next kickoff. A
     completed game never becomes the default.

     The season contract speaks ESPN event ids and the market speaks the odds
     provider's ids, so the two are matched on teams and kickoff rather than
     on an id that does not cross over. */
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  function teamMatch(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  async function resolveDefaultEvent() {
    const next = state.data?.next_game;
    if (!next) return;
    let stored = null;
    try { stored = localStorage.getItem(EVENT_KEY); } catch (_) {}

    try {
      const payload = await json(`${API}/api/odds`);
      const rows = Array.isArray(payload) ? payload : arr(payload?.events || payload?.games || payload?.data);
      if (!rows.length) return;
      const ids = new Set(rows.map(r => String(r?.id || r?.event_id || '')).filter(Boolean));

      /* Only intervene when the stored event is absent or no longer a real
         market. A deliberate user selection is left alone. */
      if (stored && ids.has(String(stored))) return;

      const want = { away: next.away?.display_name || next.away?.abbreviation, home: next.home?.display_name || next.home?.abbreviation };
      const hit = rows.find(r => {
        const a = r?.away_team || r?.away || r?.awayTeam, h = r?.home_team || r?.home || r?.homeTeam;
        return teamMatch(a, want.away) && teamMatch(h, want.home);
      }) || rows.find(r => {
        const t = Date.parse(r?.commence_time || r?.start || '');
        return Number.isFinite(t) && Math.abs(t - Date.parse(next.kickoff)) < 36e5;
      });
      if (!hit) return;
      const id = String(hit.id || hit.event_id || '');
      if (!id || id === stored) return;
      try { localStorage.setItem(EVENT_KEY, id); } catch (_) {}
      state.defaultEvent = { id, name: next.name, kickoff: next.kickoff, replaced: stored || null };
      try { window.dispatchEvent(new CustomEvent('pbe:event-changed', { detail: { event: id, reason: 'season-default' } })); } catch (_) {}
    } catch (_) { /* market unavailable: leave the stored event untouched */ }
  }

  /* ---- dashboard season strip ------------------------------------------
     A single honest line at the top of the homepage: which season and week we
     are in, what finished last, and what is next. It is additive — it does not
     restyle or replace anything the dashboard already renders. */
  function fmtKick(v) {
    if (!v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
  }

  function stripHtml() {
    const d = state.data;
    if (!d) {
      return `<div class="pbe-season-strip is-unavailable" data-pbe-season-strip>
        <span class="pbe-season-badge warn">SEASON STATE UNAVAILABLE</span>
        <span class="pbe-season-copy">Current season could not be sourced. No archived season is shown in its place.</span></div>`;
    }
    const live = Number(d.live_games) || 0;
    const fresh = d.freshness || {};
    const stale = fresh.state === 'STALE';
    const lf = d.latest_final, ng = d.next_game;
    const badge = live > 0 ? `<span class="pbe-season-badge live"><i></i>${live} GAME${live > 1 ? 'S' : ''} LIVE</span>`
      : `<span class="pbe-season-badge on">${esc(d.season)} ${esc(d.season_type)} · WEEK ${esc(d.current_week)}</span>`;
    const parts = [];
    if (live === 0) parts.push(`<span class="pbe-season-item"><b>${esc(d.season)} ${esc(d.season_type)}</b><span>Week ${esc(d.current_week)}</span></span>`);
    if (lf) parts.push(`<span class="pbe-season-item"><b>FINAL · ${esc(lf.away?.abbreviation)} ${esc(lf.away?.score)}–${esc(lf.home?.score)} ${esc(lf.home?.abbreviation)}</b><span>Last completed</span></span>`);
    if (ng) parts.push(`<span class="pbe-season-item"><b>${esc(ng.name)}</b><span>${esc(fmtKick(ng.kickoff))}</span></span>`);
    parts.push(`<span class="pbe-season-item"><b>${esc(d.completed_games_in_window)}</b><span>Completed</span></span>`);
    parts.push(`<span class="pbe-season-item"><b>${esc(d.upcoming_games)}</b><span>Upcoming</span></span>`);
    return `<div class="pbe-season-strip${stale ? ' is-stale' : ''}" data-pbe-season-strip>
      ${badge}<div class="pbe-season-items">${parts.join('')}</div>
      <span class="pbe-season-stamp">${stale ? 'STALE · ' : ''}UPDATED ${esc(new Date(d.last_updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>`;
  }

  function paintStrip() {
    if (window.App?.current !== 'home') return;
    const vc = document.getElementById('view-container');
    if (!vc || !vc.firstElementChild) return;
    const html = stripHtml();
    const existing = vc.querySelector('[data-pbe-season-strip]');
    if (existing) { if (existing.outerHTML !== html) existing.outerHTML = html; return; }
    vc.firstElementChild.insertAdjacentHTML('beforebegin', html);
  }

  /* ---- public surface --------------------------------------------------- */
  window.PBESeason = {
    get data() { return state.data; },
    get error() { return state.error; },
    get ready() { return state.ready; },
    season: () => state.data?.season ?? null,
    seasonType: () => state.data?.season_type ?? null,
    week: () => state.data?.current_week ?? null,
    started: () => state.data?.season_started === true,
    latestFinal: () => state.data?.latest_final ?? null,
    nextGame: () => state.data?.next_game ?? null,
    /* A surface may only say LIVE when the contract is inside its own SLA. */
    liveLabelPermitted: () => state.data?.freshness?.live_labeling_permitted === true,
    refresh: load,
    onReady(fn) { if (state.ready) { try { fn(state.data, state.error); } catch (_) {} } else listeners.push(fn); }
  };

  /* The dashboard re-renders its own container on refresh, which removes an
     element inserted above it. Rather than teach every dashboard generation
     about this strip, watch the container and put it back whenever it is
     missing while home is on screen. The re-insert is guarded so the observer
     cannot see its own write and loop. */
  let restoring = false;
  function watchContainer() {
    const vc = document.getElementById('view-container');
    if (!vc || vc.__pbeSeasonWatched) return !!vc;
    vc.__pbeSeasonWatched = true;
    new MutationObserver(() => {
      if (restoring) return;
      if (window.App?.current !== 'home') return;
      if (vc.querySelector('[data-pbe-season-strip]')) return;
      restoring = true;
      try { paintStrip(); } finally { setTimeout(() => { restoring = false; }, 0); }
    }).observe(vc, { childList: true });
    return true;
  }

  load();
  state.timer = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, REFRESH_MS);
  window.addEventListener('pbe:route-changed', () => { watchContainer(); paintStrip(); });
  if (!watchContainer()) document.addEventListener('DOMContentLoaded', watchContainer, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden' && Date.now() - state.fetchedAt > REFRESH_MS) load(); });
})();
