/* PropBetEdge NFL — current-season statistics.
 *
 * The stats route used to be the 2025 final leaderboard. It is now the current
 * season, accumulated from the box score of every completed regular-season
 * game by the nfl-current worker.
 *
 * Early in a season this is a very small sample, and the view says so in the
 * heading rather than padding it. Two things it never does: invent zeroes for
 * players who have not played, and blend a previous season's totals into a
 * current-season table. If the current season has nothing yet, it says that.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const TABS = [
    ['passing', 'Passing', ['YDS', 'C/ATT', 'TD', 'INT']],
    ['rushing', 'Rushing', ['YDS', 'CAR', 'TD']],
    ['receiving', 'Receiving', ['YDS', 'REC', 'TGT', 'TD']]
  ];
  const state = { data: null, error: null, loading: false, tab: 'passing', search: '', at: 0 };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);

  async function fetchStats(force) {
    if (state.loading) return;
    if (!force && state.data && Date.now() - state.at < 45000) return;
    state.loading = true;
    try {
      const season = window.PBESeason?.season();
      const url = `${API}/api/current-stats${season ? `?season=${encodeURIComponent(season)}` : ''}`;
      const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) throw new Error(body?.unavailable_reason || body?.error || `stats_${r.status}`);
      state.data = body; state.error = body.available === false ? (body.unavailable_reason || 'no current-season statistics yet') : null;
      state.at = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.data = null;
    } finally { state.loading = false; }
  }

  function rows() {
    const cat = state.data?.categories?.[state.tab];
    const q = state.search.trim().toLowerCase();
    return arr(cat?.leaders).filter(r => !q || [r.player, r.team].some(v => String(v || '').toLowerCase().includes(q)));
  }

  function cells(r) {
    if (state.tab === 'passing') return [r.yards, `${r.completions}/${r.attempts}`, r.tds, r.ints];
    if (state.tab === 'rushing') return [r.yards, r.carries, r.tds];
    return [r.yards, r.rec, r.targets, r.tds];
  }

  function tableHtml() {
    const spec = TABS.find(t => t[0] === state.tab);
    const list = rows();
    if (!list.length) {
      return `<div class="pbe6-empty-note">No ${esc(spec[1].toLowerCase())} production has been published for this season yet.</div>`;
    }
    return `<div class="pbe6-table-scroll"><table class="pbe6-table"><thead><tr>
      <th class="rank">#</th><th class="player">Player</th><th class="team">Team</th>
      ${spec[2].map(h => `<th class="mono">${esc(h)}</th>`).join('')}<th class="mono">G</th></tr></thead><tbody>
      ${list.map(r => `<tr data-player="${esc(r.player)}"><td class="rank">${esc(r.rank)}</td>
        <td class="player">${esc(r.player)}${r.position ? ` <small>${esc(r.position)}</small>` : ''}</td>
        <td>${esc(r.team)}</td>
        ${cells(r).map(v => `<td class="mono">${esc(v)}</td>`).join('')}
        <td class="mono">${esc(r.games)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function unavailable(reason) {
    const season = window.PBESeason?.season();
    return `<section class="pbe6-stats"><header class="pbe6-hero">
      <div class="pbe6-kicker">${esc(season || 'CURRENT')} REGULAR SEASON</div>
      <h1 class="pbe6-title">Current data unavailable.</h1>
      <div class="pbe6-copy">Current-season statistics could not be sourced${reason ? ` (${esc(reason)})` : ''}. No previous season is shown in their place. The verified 2025 final leaders remain available in Archives.</div>
      <span class="pbe6-archive-note">FAIL CLOSED</span></header>
      <nav class="pbe6-tabs"><a class="pbe6-tab" href="javascript:void(0)" onclick="App.nav('stats2025')">Open 2025 Stats Archive ↗</a></nav></section>`;
  }

  function render() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    const d = state.data;
    if (!d || d.available === false) { vc.innerHTML = unavailable(state.error || d?.unavailable_reason); return; }

    const fresh = d.freshness || {};
    const stale = fresh.state === 'STALE';
    const games = Number(d.completed_games) || 0;
    const week = window.PBESeason?.week();
    const updated = new Date(d.last_updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

    vc.innerHTML = `<section class="pbe6-stats" data-stale="${stale}">
      <header class="pbe6-hero">
        <div class="pbe6-kicker">${esc(d.season)} NFL ${esc(d.season_type)} SEASON · ${stale ? 'STALE' : 'LIVE'}</div>
        <h1 class="pbe6-title">${esc(d.season)} statistical leaders.<br><em>Through Week ${esc(week ?? '—')}.</em></h1>
        <div class="pbe6-copy">Accumulated from published box scores of completed ${esc(d.season)} regular-season games.
          <strong>${games} completed game${games === 1 ? '' : 's'} league-wide</strong>${games <= 2 ? ' — this is an intentionally small early-season sample, not a full-season table.' : '.'}
          Source: ${esc(d.source?.provider || 'provider')} · updated ${esc(updated)} ET.</div>
        <span class="pbe6-archive-note${stale ? '' : ' is-live'}">${stale ? 'STALE FEED' : 'LIVE'} · ${esc(d.season)} · WEEK ${esc(week ?? '—')}</span>
      </header>
      <nav class="pbe6-tabs">${TABS.map(([k, label]) => `<button class="pbe6-tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${esc(label)}</button>`).join('')}
        <a class="pbe6-tab archive-link" href="javascript:void(0)" onclick="App.nav('stats2025')">2025 Archive ↗</a></nav>
      <div class="pbe6-tools"><input id="pbe6-search" class="pbe6-input" type="search" placeholder="Search player or team…" value="${esc(state.search)}">
        <div class="pbe6-count">${rows().length} player${rows().length === 1 ? '' : 's'} with published ${esc(state.tab)} production</div></div>
      <section class="pbe6-table-wrap">${tableHtml()}</section></section>`;

    vc.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
    const box = vc.querySelector('#pbe6-search');
    if (box) box.addEventListener('input', () => { state.search = box.value; const w = vc.querySelector('.pbe6-table-wrap'); if (w) w.innerHTML = tableHtml(); const c = vc.querySelector('.pbe6-count'); if (c) c.textContent = `${rows().length} player${rows().length === 1 ? '' : 's'} with published ${state.tab} production`; });
  }

  async function load() {
    const vc = document.getElementById('view-container');
    if (vc && !state.data) vc.innerHTML = `<section class="pbe6-stats"><div class="pbe6-empty-note">Loading ${window.PBESeason?.season() || ''} statistics…</div></section>`;
    await fetchStats(true);
    render();
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.stats = load;
    window.PBEStats2026 = { load, render, state };
    return true;
  }

  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
  window.addEventListener('pbe:season-ready', () => { if (window.App?.current === 'stats') fetchStats(true).then(render); });
})();
