/* PropBetEdge NFL — current-season standings.
 *
 * The standings route used to be a frozen 2025 archive. It is now the live
 * current-season table, derived from completed regular-season results by the
 * nfl-current worker and refreshed on a schedule. The 2025 archive still
 * exists, on its own route, labelled as history.
 *
 * Nothing here is hardcoded. If the contract cannot be sourced the view says
 * so and shows nothing, rather than presenting a previous season under a
 * current-season heading.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const state = { data: null, error: null, loading: false, conf: 'all', at: 0 };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  async function fetchStandings(force) {
    if (state.loading) return;
    if (!force && state.data && Date.now() - state.at < 45000) return;
    state.loading = true;
    try {
      const season = window.PBESeason?.season();
      const url = `${API}/api/standings${season ? `?season=${encodeURIComponent(season)}` : ''}`;
      const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || body.available === false || !arr(body.divisions).length) {
        throw new Error(body?.unavailable_reason || body?.error || `standings_${r.status}`);
      }
      state.data = body; state.error = null; state.at = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      if (!state.data) state.data = null;
    } finally { state.loading = false; }
  }

  function crest(abbr, size) {
    const t = (window.NFL_TEAMS || []).find?.(x => x.abbr === abbr);
    const logo = t?.logo || '';
    return logo ? `<img src="${esc(logo)}" width="${size}" height="${size}" alt="" decoding="async">` : `<b class="pbe7-crest-fallback">${esc(abbr)}</b>`;
  }

  function teamRow(t, rank) {
    const diff = num(t.differential);
    const played = num(t.games_played) || 0;
    return `<div class="pbe7-team-row${rank === 0 ? ' divlead' : ''}${played ? '' : ' is-unplayed'}" data-team="${esc(t.abbreviation)}">
      <div class="pbe7-team-seed${played && num(t.wins) > 0 ? ' playoff' : ''}">${rank + 1}</div>
      <div>${t.logo ? `<img src="${esc(t.logo)}" width="24" height="24" alt="" decoding="async">` : crest(t.abbreviation, 24)}</div>
      <div><div class="pbe7-team-name">${esc(t.display_name)}</div>
        <div class="pbe7-team-note">${played ? `${played} game${played > 1 ? 's' : ''} played` : 'no games played yet'}</div></div>
      <div class="pbe7-metric"><b class="win">${esc(t.record)}</b><span>REC</span></div>
      <div class="pbe7-metric mobile-hide"><b>${played ? (num(t.win_pct) ?? 0).toFixed(3) : '—'}</b><span>PCT</span></div>
      <div class="pbe7-metric hide-mid mobile-hide"><b>${played ? esc(t.points_for) : '—'}</b><span>PF</span></div>
      <div class="pbe7-metric hide-mid mobile-hide"><b class="pbe7-diff ${(diff ?? 0) >= 0 ? 'pos' : 'neg'}">${played ? `${diff > 0 ? '+' : ''}${diff}` : '—'}</b><span>DIFF</span></div>
    </div>`;
  }

  function divisionHtml(d) {
    return `<section class="pbe7-division">
      <div class="pbe7-div-head"><strong>${esc(d.division)}</strong><span>${esc(state.data.season)} · live</span></div>
      ${d.teams.map(teamRow).join('')}</section>`;
  }

  function unavailable(reason) {
    return `<section class="pbe7-standings"><header class="pbe7-hero"><div>
      <div class="pbe7-kicker">CURRENT SEASON STANDINGS</div>
      <h1 class="pbe7-title">Current data unavailable.</h1>
      <div class="pbe7-copy">Live standings could not be sourced${reason ? ` (${esc(reason)})` : ''}. No previous season is shown in their place. The 2025 final standings remain available in Archives.</div>
      <span class="pbe7-archive">FAIL CLOSED</span>
    </div></header></section>`;
  }

  function render() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    const d = state.data;
    if (!d) { vc.innerHTML = unavailable(state.error); return; }

    const fresh = d.freshness || {};
    const stale = fresh.state === 'STALE';
    const divisions = state.conf === 'all' ? d.divisions : d.divisions.filter(x => x.conference === state.conf);
    const played = num(d.completed_games) || 0;
    const updated = new Date(d.last_updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

    vc.innerHTML = `<section class="pbe7-standings" data-stale="${stale}">
      <header class="pbe7-hero"><div>
        <div class="pbe7-kicker">${esc(d.season)} NFL ${esc(d.season_type)} SEASON · ${stale ? 'STALE' : 'LIVE'}</div>
        <h1 class="pbe7-title">${esc(d.season)} NFL Standings.<br><em>Updating themselves.</em></h1>
        <div class="pbe7-copy">Derived from completed ${esc(d.season)} regular-season results. ${played} game${played === 1 ? '' : 's'} completed league-wide. Source: ${esc(d.source?.provider || 'provider')} · current through ${esc(updated)} ET.</div>
        <span class="pbe7-archive${stale ? '' : ' is-live'}">${stale ? 'STALE FEED' : 'LIVE'} · ${esc(d.season)}</span>
      </div>
      <aside class="pbe7-hero-side"><strong>${played}</strong><span>Completed regular-season game${played === 1 ? '' : 's'} behind this table</span></aside></header>

      <nav class="pbe7-controls">
        <button class="pbe7-btn ${state.conf === 'all' ? 'active' : ''}" data-conf="all">All NFL</button>
        <button class="pbe7-btn ${state.conf === 'AFC' ? 'active' : ''}" data-conf="AFC">AFC</button>
        <button class="pbe7-btn ${state.conf === 'NFC' ? 'active' : ''}" data-conf="NFC">NFC</button>
        <a class="pbe7-btn" href="javascript:void(0)" onclick="App.nav('standings2025')">2025 Final Standings ↗</a>
      </nav>
      <div id="pbe7-confs">${divisions.map(divisionHtml).join('')}</div>
    </section>`;

    vc.querySelectorAll('[data-conf]').forEach(b => b.addEventListener('click', () => { state.conf = b.dataset.conf; render(); }));
  }

  async function load() {
    const vc = document.getElementById('view-container');
    if (vc && !state.data) vc.innerHTML = `<section class="pbe7-standings"><div class="pbe7-empty">Loading ${window.PBESeason?.season() || ''} standings…</div></section>`;
    await fetchStandings(true);
    render();
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.standings = load;
    window.PBEStandings2026 = { load, render, state };
    return true;
  }

  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
  /* Follow the season contract: when a game goes final the standings behind it
     have changed, so re-read them the next time this route is on screen. */
  window.addEventListener('pbe:season-ready', () => {
    if (window.App?.current === 'standings') { fetchStandings(true).then(render); }
  });
})();
