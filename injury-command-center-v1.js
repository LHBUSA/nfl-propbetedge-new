/* PropBetEdge NFL — Injury Explorer v2
 * Selector-driven injury experience. Full data remains available, but the
 * default view never expands the entire league into one wall of rows.
 */
(() => {
  'use strict';

  const GATEWAY = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const API = GATEWAY + '/api/injuries';
  const ROOT_ID = 'pbe-injury-command-center';

  const state = {
    loading: false,
    loaded: false,
    error: null,
    data: null,
    selectedTeam: 'AUTO',
    status: 'IMPACT',
    position: 'ALL',
    query: '',
    expanded: false,
    request: 0
  };

  let burstToken = 0;

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();

  function timeAgo(value) {
    const t = Date.parse(value || '');
    if (!Number.isFinite(t)) return 'time unavailable';
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  function statusLabel(row) {
    const map = {
      INJURED_RESERVE: 'IR',
      PUP: 'PUP',
      NFI: 'NFI',
      SUSPENDED: 'Suspended',
      QUESTIONABLE: 'Questionable',
      DOUBTFUL: 'Doubtful',
      OUT: 'Out',
      ACTIVE: 'Active'
    };
    return map[row?.status] || clean(row?.status_label) || clean(row?.status).replace(/_/g,' ') || 'Reported';
  }

  function injuryLabel(row) {
    const injury = row?.injury || {};
    return clean(injury.type) || clean(injury.label) || clean(injury.location) || 'Not specified';
  }

  function isImpact(row) {
    return row?.bucket !== 'ACTIVE';
  }

  function bucketRank(row) {
    return ({ OUT: 0, DOUBTFUL: 1, QUESTIONABLE: 2, OTHER: 3, ACTIVE: 4 })[row?.bucket] ?? 5;
  }

  function teamImpactCount(team) {
    const rows = Array.isArray(team?.injuries) ? team.injuries : [];
    return rows.reduce((n, row) => n + (isImpact(row) ? 1 : 0), 0);
  }

  function teams() {
    return Array.isArray(state.data?.teams) ? state.data.teams : [];
  }

  function selectedTeams() {
    if (state.selectedTeam === 'AUTO') return [];
    if (state.selectedTeam === 'ALL') return teams();
    return teams().filter(team => team.abbreviation === state.selectedTeam);
  }

  function positionsForTeam(team) {
    const set = new Set();
    (team?.injuries || []).forEach(row => {
      const pos = clean(row?.player?.position).toUpperCase();
      if (pos) set.add(pos);
    });
    return [...set].sort();
  }

  function matchesStatus(row) {
    if (state.status === 'ALL') return true;
    if (state.status === 'IMPACT') return isImpact(row);
    return row?.bucket === state.status;
  }

  function matchesPosition(row) {
    return state.position === 'ALL' || clean(row?.player?.position).toUpperCase() === state.position;
  }

  function matchesQuery(row) {
    const q = state.query.toLowerCase();
    if (!q) return true;
    const hay = [
      row?.player?.name,
      row?.player?.position,
      injuryLabel(row),
      statusLabel(row),
      row?.note
    ].map(clean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function filteredRows(team) {
    return (Array.isArray(team?.injuries) ? team.injuries : [])
      .filter(row => matchesStatus(row) && matchesPosition(row) && matchesQuery(row))
      .sort((a,b) => bucketRank(a) - bucketRank(b) || Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
  }

  function tone(row) {
    if (row?.bucket === 'OUT') return 'is-out';
    if (row?.bucket === 'DOUBTFUL') return 'is-doubtful';
    if (row?.bucket === 'QUESTIONABLE') return 'is-questionable';
    if (row?.bucket === 'ACTIVE') return 'is-active';
    return 'is-other';
  }

  function metric(label, value, toneClass='') {
    return `<div class="pbeinj-metric ${toneClass}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
  }

  function controls() {
    const allTeams = teams();
    const selected = state.selectedTeam === 'AUTO' ? null : allTeams.find(t => t.abbreviation === state.selectedTeam);
    const positions = selected ? positionsForTeam(selected) : [];
    const statuses = [
      ['IMPACT','Injured / Questionable'],
      ['OUT','Out / IR'],
      ['QUESTIONABLE','Questionable'],
      ['DOUBTFUL','Doubtful'],
      ['ACTIVE','Active / Cleared'],
      ['ALL','All Reports']
    ];

    return `<div class="pbeinj-controls">
      <label class="pbeinj-field">
        <span>TEAM</span>
        <select data-team-select>
          <option value="AUTO"${state.selectedTeam === 'AUTO' ? ' selected' : ''}>Choose a team</option>
          ${allTeams.map(team => `<option value="${esc(team.abbreviation)}"${state.selectedTeam === team.abbreviation ? ' selected' : ''}>${esc(team.name)} · ${teamImpactCount(team)} impact</option>`).join('')}
          <option value="ALL"${state.selectedTeam === 'ALL' ? ' selected' : ''}>All teams — compact results</option>
        </select>
      </label>

      <label class="pbeinj-field">
        <span>STATUS</span>
        <select data-status-select>
          ${statuses.map(([value,label]) => `<option value="${value}"${state.status === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>

      <label class="pbeinj-field">
        <span>POSITION</span>
        <select data-position-select ${selected ? '' : 'disabled'}>
          <option value="ALL">All positions</option>
          ${positions.map(pos => `<option value="${esc(pos)}"${state.position === pos ? ' selected' : ''}>${esc(pos)}</option>`).join('')}
        </select>
      </label>

      <label class="pbeinj-field pbeinj-search">
        <span>SEARCH</span>
        <input type="search" data-injury-search value="${esc(state.query)}" placeholder="Player or injury" autocomplete="off">
      </label>
    </div>`;
  }

  function leaguePicker() {
    const sorted = [...teams()].sort((a,b) =>
      teamImpactCount(b) - teamImpactCount(a) ||
      String(a.name).localeCompare(String(b.name))
    );

    return `<section class="pbeinj-picker">
      <div class="pbeinj-picker-head">
        <div>
          <span>SELECT A TEAM</span>
          <h3>Start with the club you care about</h3>
        </div>
        <p>Impact count excludes Active / cleared entries so the first number is actually useful.</p>
      </div>
      <div class="pbeinj-team-picker">
        ${sorted.map(team => {
          const impact = teamImpactCount(team);
          return `<button type="button" data-pick-team="${esc(team.abbreviation)}" class="${impact ? '' : 'is-clear'}">
            <img src="${esc(team.logo)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">
            <span><strong>${esc(team.abbreviation)}</strong><small>${esc(team.name)}</small></span>
            <b>${impact}</b>
          </button>`;
        }).join('')}
      </div>
    </section>`;
  }

  function playerRow(row) {
    const player = row?.player || {};
    const headshot = clean(player.headshot);
    const note = clean(row?.note);
    return `<article class="pbeinj-player ${tone(row)}">
      <div class="pbeinj-player-id">
        <div class="pbeinj-headshot">
          ${headshot ? `<img src="${esc(headshot)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : `<span>${esc((player.position || 'NFL').slice(0,3))}</span>`}
        </div>
        <div>
          <strong>${esc(player.name || 'Unknown player')}</strong>
          <span>${esc(player.position || 'Position n/a')}</span>
        </div>
      </div>
      <div class="pbeinj-injury">
        <span class="pbeinj-mobile-label">INJURY</span>
        <strong>${esc(injuryLabel(row))}</strong>
        ${row?.injury?.side ? `<small>${esc(row.injury.side)}</small>` : ''}
      </div>
      <div class="pbeinj-status">
        <span class="pbeinj-mobile-label">STATUS</span>
        <b>${esc(statusLabel(row))}</b>
      </div>
      <div class="pbeinj-update">
        <span class="pbeinj-mobile-label">UPDATED</span>
        <strong>${esc(timeAgo(row?.updated_at))}</strong>
        ${note ? `<small>${esc(note)}</small>` : ''}
      </div>
    </article>`;
  }

  function teamPanel(team, compact=false) {
    const rows = filteredRows(team);
    const limit = compact ? 6 : 12;
    const shown = state.expanded ? rows : rows.slice(0, limit);
    const stale = !!team?.source_stale;

    return `<section class="pbeinj-team ${stale ? 'is-source-stale' : ''}">
      <header class="pbeinj-team-head">
        <div class="pbeinj-team-brand">
          <div class="pbeinj-team-logo"><img src="${esc(team.logo)}" alt="" onerror="this.remove()"></div>
          <div>
            <span>${esc(team.conference)} ${esc(team.division)}${stale ? ' · SOURCE STALE' : ''}</span>
            <h3>${esc(team.name)}</h3>
          </div>
        </div>
        <div class="pbeinj-team-counts">
          <strong>${rows.length} matching</strong>
          <span>${team.counts?.out || 0} out/IR · ${team.counts?.questionable || 0} Q · ${team.counts?.doubtful || 0} D</span>
        </div>
      </header>

      ${shown.length
        ? `<div class="pbeinj-table-head" aria-hidden="true"><span>PLAYER</span><span>INJURY</span><span>STATUS</span><span>UPDATED / NOTE</span></div>
           <div class="pbeinj-roster">${shown.map(playerRow).join('')}</div>`
        : `<div class="pbeinj-empty-team"><strong>No matching injury entries</strong><span>Try another status, position, or search.</span></div>`}

      ${rows.length > limit
        ? `<div class="pbeinj-show-more"><button type="button" data-toggle-expanded>${state.expanded ? 'Show fewer' : `Show all ${rows.length}`}</button></div>`
        : ''}
    </section>`;
  }

  function resultsBody() {
    if (state.selectedTeam === 'AUTO') return leaguePicker();

    if (state.selectedTeam === 'ALL') {
      const list = teams()
        .map(team => ({ team, rows: filteredRows(team) }))
        .filter(item => item.rows.length)
        .sort((a,b) => b.rows.length - a.rows.length);

      return `<section class="pbeinj-all-results">
        <div class="pbeinj-all-head">
          <strong>${list.length} teams match</strong>
          <span>Compact league view. Choose a team above for full detail.</span>
        </div>
        <div class="pbeinj-all-grid">
          ${list.map(({team,rows}) => `<button type="button" data-pick-team="${esc(team.abbreviation)}">
            <img src="${esc(team.logo)}" alt="" loading="lazy" onerror="this.remove()">
            <span><strong>${esc(team.name)}</strong><small>${rows.length} matching · ${team.counts?.out || 0} out/IR</small></span>
            <b>View</b>
          </button>`).join('')}
        </div>
      </section>`;
    }

    const team = teams().find(item => item.abbreviation === state.selectedTeam);
    return team ? teamPanel(team) : leaguePicker();
  }

  function loadingShell() {
    return `<section id="${ROOT_ID}" class="pbeinj-command is-loading" aria-live="polite">
      <div class="pbeinj-loading"><span></span><div><strong>Loading injury data</strong><small>Preparing the team selector…</small></div></div>
    </section>`;
  }

  function errorShell() {
    return `<section id="${ROOT_ID}" class="pbeinj-command is-error" aria-live="polite">
      <div class="pbeinj-error">
        <div><strong>Injury feed is temporarily unavailable</strong><span>${esc(state.error || 'Source unavailable')}</span></div>
        <button type="button" data-injury-retry>Retry</button>
      </div>
    </section>`;
  }

  function boardShell() {
    const data = state.data || {};
    const counts = data.counts || {};
    const partial = !!data.source?.partial;
    const failedTeams = Array.isArray(data.source?.failed_teams) ? data.source.failed_teams : [];
    const freshness = data.source?.fetched_at ? `Updated ${timeAgo(data.source.fetched_at)}` : 'Source time unavailable';

    return `<section id="${ROOT_ID}" class="pbeinj-command" aria-label="NFL injury explorer">
      <header class="pbeinj-hero">
        <div>
          <span class="pbeinj-kicker">NFL INJURY INTELLIGENCE</span>
          <h2>Injury Explorer</h2>
          <p>Pick a team and status. Full league data stays available without dumping hundreds of rows onto the page.</p>
          <div class="pbeinj-fresh ${partial ? 'is-partial' : ''}">
            <i></i><span>${esc(freshness)}${partial ? ` · partial source${failedTeams.length ? ` · stale: ${failedTeams.join(', ')}` : ''}` : ''}</span>
          </div>
        </div>
        <div class="pbeinj-metrics">
          ${metric('reported',counts.total ?? 0)}
          ${metric('out / IR',counts.out ?? 0,'is-critical')}
          ${metric('questionable',counts.questionable ?? 0,'is-watch')}
        </div>
      </header>
      ${controls()}
      ${resultsBody()}
      <footer class="pbeinj-source">${esc(clean(data.source?.note) || 'Current reported designations only; no inferred timelines.')}</footer>
    </section>`;
  }

  function hostRoot() {
    if (window.App?.current !== 'injuries') return null;
    return document.querySelector('.pbe13-news.pbe13-injury-editorial');
  }

  function anchorFor(root) {
    return root?.querySelector('.pbe13-truth') || root?.querySelector('.pbe13-masthead');
  }

  function ensureHost() {
    const root = hostRoot();
    if (!root) return null;
    let host = document.getElementById(ROOT_ID);
    if (host && root.contains(host)) return host;

    const shell = document.createElement('section');
    shell.id = ROOT_ID;
    const anchor = anchorFor(root);
    if (anchor) anchor.insertAdjacentElement('afterend', shell);
    else root.prepend(shell);
    return shell;
  }

  function render({ preserveFocus=false }={}) {
    const host = ensureHost();
    if (!host) return false;

    const active = preserveFocus ? document.activeElement : null;
    const selection = active?.matches?.('[data-injury-search]') ? [active.selectionStart,active.selectionEnd] : null;

    host.outerHTML = state.loading && !state.data
      ? loadingShell()
      : state.error && !state.data
        ? errorShell()
        : boardShell();

    wire();

    if (selection) {
      const input = document.querySelector(`#${ROOT_ID} [data-injury-search]`);
      input?.focus({ preventScroll:true });
      try { input?.setSelectionRange(selection[0],selection[1]); } catch {}
    }
    return true;
  }

  function resetTeamFilters() {
    state.position = 'ALL';
    state.query = '';
    state.expanded = false;
  }

  function selectTeam(abbr) {
    state.selectedTeam = abbr || 'AUTO';
    resetTeamFilters();
    render();
    document.getElementById(ROOT_ID)?.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  function wire() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    root.querySelector('[data-team-select]')?.addEventListener('change', event => {
      selectTeam(event.target.value);
    });

    root.querySelector('[data-status-select]')?.addEventListener('change', event => {
      state.status = event.target.value || 'IMPACT';
      state.expanded = false;
      render();
    });

    root.querySelector('[data-position-select]')?.addEventListener('change', event => {
      state.position = event.target.value || 'ALL';
      state.expanded = false;
      render();
    });

    root.querySelector('[data-injury-search]')?.addEventListener('input', event => {
      state.query = clean(event.target.value);
      state.expanded = false;
      render({ preserveFocus:true });
    });

    root.querySelectorAll('[data-pick-team]').forEach(button => button.addEventListener('click', () => {
      selectTeam(button.dataset.pickTeam);
    }));

    root.querySelector('[data-toggle-expanded]')?.addEventListener('click', () => {
      state.expanded = !state.expanded;
      render();
    });

    root.querySelector('[data-injury-retry]')?.addEventListener('click', () => load(true));
  }

  async function load(force=false) {
    if (window.App?.current !== 'injuries') return false;
    ensureHost();
    if ((state.loading || state.loaded) && !force) {
      render();
      return true;
    }

    const request = ++state.request;
    state.loading = true;
    state.error = null;
    render();

    try {
      const response = await fetch(API, { headers:{ accept:'application/json' }, cache:'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok || !Array.isArray(body?.teams)) {
        throw new Error(body?.error || `injury_board_${response.status}`);
      }
      if (request !== state.request) return false;
      state.data = body;
      state.loaded = true;
      state.error = null;
    } catch (error) {
      if (request !== state.request) return false;
      state.error = clean(error?.message || error) || 'injury_feed_unavailable';
    } finally {
      if (request === state.request) state.loading = false;
    }

    render();
    return !state.error;
  }

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    if (!state.loaded && !state.loading) load();
    else render();
    return true;
  }

  function burst() {
    const token = ++burstToken;
    [0,80,220,520,1100,2100,4200].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('DOMContentLoaded', burst, { once:true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryCommandCenterV1 = { load, enhance, burst, state };
})();