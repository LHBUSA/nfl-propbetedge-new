/* PropBetEdge NFL — the two intelligence layers, on every Player DNA product.
 *
 * A DNA page is built on seasons of history. That history is the right basis
 * for a model and the wrong thing to call "current", so this adds the missing
 * half rather than replacing anything:
 *
 *   2026 CURRENT      what this player has actually done in completed 2026
 *                     regular-season games, from published box scores
 *   HISTORICAL        the 2025-and-prior sample the DNA page already draws
 *
 * The two are rendered as separate cards and never merged into one number. A
 * combination of current form and historical prior, if the model layer ever
 * wants one, has to be an explicit and deterministic step somewhere else.
 *
 * The rule that governs the current card: a missing sample is not a zero. A
 * player whose team has not kicked off shows "no completed 2026 game yet", not
 * 0 yards on 0 attempts. The API distinguishes those cases and so does this.
 *
 * It attaches itself. The four DNA products expose {render, load, state} and
 * all four render a .q2-hero, so this observes the route and the container and
 * injects after the hero — no edits to qb/wr/rb/te-dna.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const PRODUCTS = {
    qbdna: { global: 'PBEQBDna', noun: 'quarterback', order: ['passing', 'rushing'] },
    wrdna: { global: 'PBEWRDna', noun: 'receiver', order: ['receiving', 'rushing'] },
    rbdna: { global: 'PBERBDna', noun: 'running back', order: ['rushing', 'receiving'] },
    tedna: { global: 'PBETEDna', noun: 'tight end', order: ['receiving', 'rushing'] }
  };
  const MARK = 'data-pbe-current-layer';
  const cache = new Map();          // espn_id -> payload
  let inflight = null, lastKey = null, restoring = false;

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  function active() {
    const route = window.App?.current;
    const spec = PRODUCTS[route];
    if (!spec) return null;
    const mod = window[spec.global];
    const dna = mod?.state?.dna;
    const p = dna?.player;
    if (!p) return null;
    return {
      route, spec, dna,
      espnId: String(p.espn_id || ''),
      team: String(p.current_team || p.team?.abbreviation || ''),
      name: String(p.name || ''),
      historyAvailable: dna.history_available !== false
    };
  }

  async function fetchCurrent(espnId, team) {
    const key = `${espnId}|${team}`;
    if (cache.has(key)) return cache.get(key);
    const r = await fetch(`${API}/api/current-player?espn_id=${encodeURIComponent(espnId)}&team=${encodeURIComponent(team)}`,
      { cache: 'no-store', headers: { accept: 'application/json' } });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`current_player_${r.status}`);
    cache.set(key, body);
    return body;
  }

  /* ---- current card ------------------------------------------------------ */
  const STAT_LABEL = {
    passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving'
  };

  function statLine(kind, s) {
    if (!s) return '';
    const bits = [];
    const push = (v, label) => { if (v !== null && v !== undefined) bits.push(`<span><b>${esc(v)}</b>${esc(label)}</span>`); };
    if (kind === 'passing') {
      push(s.yards, 'pass yds'); push(`${s.completions}/${s.attempts}`, 'c/att');
      push(s.tds, 'TD'); push(s.ints, 'INT');
      if (s.completion_pct !== null) push(`${s.completion_pct}%`, 'cmp');
      if (s.yards_per_attempt !== null) push(s.yards_per_attempt, 'Y/A');
    } else if (kind === 'rushing') {
      push(s.yards, 'rush yds'); push(s.carries, 'car'); push(s.tds, 'TD');
      if (s.yards_per_carry !== null) push(s.yards_per_carry, 'Y/C');
    } else {
      push(s.yards, 'rec yds'); push(s.receptions, 'rec'); push(s.targets, 'tgt'); push(s.tds, 'TD');
      if (s.catch_rate !== null) push(`${s.catch_rate}%`, 'catch');
    }
    return `<div class="pbe-cl-line"><span class="pbe-cl-line-k">${esc(STAT_LABEL[kind])}</span>
      <div class="pbe-cl-line-v">${bits.join('')}</div></div>`;
  }

  function currentCard(payload, spec) {
    if (!payload || payload.ok === false) {
      return `<article class="pbe-cl-card is-current is-none">
        <header><span class="pbe-cl-tag warn">2026 CURRENT SAMPLE</span></header>
        <div class="pbe-cl-none">Current-season observations unavailable. No prior season is shown in their place.</div>
      </article>`;
    }
    if (!payload.available) {
      /* The distinction that matters: nothing to observe versus observed
         nothing. Neither is rendered as a zero. */
      const teamGames = payload.team?.completed_games ?? 0;
      const headline = payload.reason === 'no_completed_team_game'
        ? 'No completed 2026 regular-season game yet'
        : 'No recorded participation in a completed 2026 game';
      return `<article class="pbe-cl-card is-current is-none">
        <header><span class="pbe-cl-tag warn">2026 CURRENT SAMPLE</span>
          <span class="pbe-cl-sub">${esc(payload.team?.abbreviation || '')} · ${esc(teamGames)} team game${teamGames === 1 ? '' : 's'} completed</span></header>
        <div class="pbe-cl-none"><b>${esc(headline)}</b>
          <span>${esc(payload.unavailable_reason || '')}</span>
          <em>No current-season figure is shown, because a missing sample is not a zero.</em></div>
      </article>`;
    }

    const g = payload.games_played;
    const lg = payload.last_game;
    const lines = spec.order.map(k => statLine(k, payload.stats?.[k])).filter(Boolean).join('')
      || '<div class="pbe-cl-none"><b>No production recorded in this category</b></div>';
    const thin = payload.sample?.thin;
    const when = payload.last_updated ? new Date(payload.last_updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';

    return `<article class="pbe-cl-card is-current">
      <header><span class="pbe-cl-tag live">2026 CURRENT</span>
        <span class="pbe-cl-sub">${esc(g)} game${g === 1 ? '' : 's'} played${thin ? ' · small current-season sample' : ''}</span></header>
      <div class="pbe-cl-lines">${lines}</div>
      ${lg ? `<div class="pbe-cl-last"><span class="pbe-cl-last-k">Last game</span>
        <span class="pbe-cl-last-v">Week ${esc(lg.week)} ${lg.at_home ? 'vs' : 'at'} ${esc(lg.opponent)} · ${esc(lg.result)}</span></div>` : ''}
      <footer class="pbe-cl-foot">Box scores of completed 2026 regular-season games${when ? ` · updated ${esc(when)} ET` : ''}</footer>
    </article>`;
  }

  /* ---- historical card --------------------------------------------------- */
  function historicalCard(ctx) {
    const d = ctx.dna;
    if (!ctx.historyAvailable) {
      return `<article class="pbe-cl-card is-baseline is-none">
        <header><span class="pbe-cl-tag">HISTORICAL BASELINE</span></header>
        <div class="pbe-cl-none"><b>Historical sample unavailable</b>
          <span>No prior-season NFL sample exists for this ${esc(ctx.spec.noun)}.</span>
          <em>Nothing is manufactured; verified 2026 observations accumulate above as games complete.</em></div>
      </article>`;
    }
    const dw = d.data_window || {}, prov = d.provenance || {}, samp = d.sample || {};
    const seasons = Array.isArray(dw.seasons) ? dw.seasons : [];
    const span = seasons.length ? `${seasons[0]}–${seasons[seasons.length - 1]}` : '';
    const games = num(samp.baseline_games) ?? num(d.career?.games);
    const through = dw.data_through || prov.data_through || '';
    const latest = dw.latest_completed_game;
    return `<article class="pbe-cl-card is-baseline">
      <header><span class="pbe-cl-tag">HISTORICAL BASELINE</span>
        <span class="pbe-cl-sub">${esc(span)} NFL sample${samp.label ? ` · ${esc(samp.label)}` : ''}</span></header>
      <div class="pbe-cl-lines">
        <div class="pbe-cl-line"><span class="pbe-cl-line-k">Sample</span>
          <div class="pbe-cl-line-v"><span><b>${esc(games ?? '—')}</b>games</span>
          ${seasons.length ? `<span><b>${esc(seasons.length)}</b>seasons</span>` : ''}</div></div>
        ${latest ? `<div class="pbe-cl-line"><span class="pbe-cl-line-k">Through</span>
          <div class="pbe-cl-line-v"><span><b>${esc(latest.matchup || '')}</b>${esc(latest.date || '')}</span></div></div>` : ''}
      </div>
      <footer class="pbe-cl-foot">Prior-season and career facts${through ? ` through ${esc(through)}` : ''}. Never presented as 2026 production; the DNA metrics below are drawn from this sample.</footer>
    </article>`;
  }

  function bandHtml(ctx, payload) {
    return `<section class="pbe-cl-band" ${MARK}>
      <div class="pbe-cl-head"><span>Two layers</span>
        <small>Current-season observations and historical baseline are kept separate and never combined into one figure.</small></div>
      <div class="pbe-cl-grid">${currentCard(payload, ctx.spec)}${historicalCard(ctx)}</div>
    </section>`;
  }

  /* ---- mounting ---------------------------------------------------------- */
  function place(html) {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    const hero = vc.querySelector('.q2-hero');
    if (!hero) return;
    const existing = vc.querySelector(`[${MARK}]`);
    if (existing) { if (existing.outerHTML !== html) existing.outerHTML = html; return; }
    hero.insertAdjacentHTML('afterend', html);
  }

  async function sync(force) {
    const ctx = active();
    if (!ctx) return;
    const key = `${ctx.route}|${ctx.espnId}|${ctx.team}`;
    if (!force && key === lastKey && document.querySelector(`[${MARK}]`)) return;
    lastKey = key;

    if (!ctx.espnId) { place(bandHtml(ctx, { ok: false })); return; }
    /* Paint the historical half immediately; the current half fills in. */
    place(bandHtml(ctx, null));
    try {
      const token = key;
      inflight = token;
      const payload = await fetchCurrent(ctx.espnId, ctx.team);
      if (inflight !== token) return;               // player changed mid-flight
      const now = active();
      if (!now || `${now.route}|${now.espnId}|${now.team}` !== token) return;
      place(bandHtml(now, payload));
    } catch (_) {
      const now = active();
      if (now) place(bandHtml(now, { ok: false }));
    }
  }

  /* The DNA products re-render their own container on every player change and
     on chart repaints, which removes anything inserted after the hero. Watch
     and restore, guarded so the observer cannot see its own write. */
  function watch() {
    const vc = document.getElementById('view-container');
    if (!vc || vc.__pbeCurrentLayerWatched) return !!vc;
    vc.__pbeCurrentLayerWatched = true;
    new MutationObserver(() => {
      if (restoring) return;
      if (!PRODUCTS[window.App?.current]) return;
      if (!vc.querySelector('.q2-hero')) return;
      if (vc.querySelector(`[${MARK}]`)) return;
      restoring = true;
      try { sync(true); } finally { setTimeout(() => { restoring = false; }, 0); }
    }).observe(vc, { childList: true, subtree: true });
    return true;
  }

  window.PBECurrentLayer = { sync, active, cache };

  window.addEventListener('pbe:route-changed', () => { watch(); setTimeout(() => sync(true), 60); });
  /* A completed game changes what "current" means, so drop the per-player cache
     when the season contract reports a new final. */
  let lastFinalId = null;
  window.addEventListener('pbe:season-ready', e => {
    const id = e?.detail?.season?.latest_final?.id || null;
    if (id !== lastFinalId) { lastFinalId = id; cache.clear(); sync(true); }
  });
  if (!watch()) document.addEventListener('DOMContentLoaded', watch, { once: true });
  setTimeout(() => { watch(); sync(true); }, 1200);
})();
