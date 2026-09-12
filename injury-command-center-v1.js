/* PropBetEdge NFL — League Injury Command Center v1
 * Additive injuries-route surface. It does not replace editorial coverage;
 * it puts the current league-wide injury board first, grouped by all 32 teams.
 */
(() => {
  'use strict';

  const API = '/api/injury-board';
  const ROOT_ID = 'pbe-injury-command-center';
  const state = {
    loading: false,
    loaded: false,
    error: null,
    data: null,
    query: '',
    conference: 'ALL',
    status: 'ALL',
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

  function statusLabel(status, fallback) {
    const map = {
      INJURED_RESERVE: 'IR', PUP: 'PUP', NFI: 'NFI', SUSPENDED: 'Suspended',
      QUESTIONABLE: 'Questionable', DOUBTFUL: 'Doubtful', OUT: 'Out', ACTIVE: 'Active'
    };
    return map[status] || clean(fallback) || clean(status).replace(/_/g,' ') || 'Reported';
  }

  function statusTone(row) {
    if (row?.bucket === 'OUT') return 'is-out';
    if (row?.bucket === 'DOUBTFUL') return 'is-doubtful';
    if (row?.bucket === 'QUESTIONABLE') return 'is-questionable';
    if (row?.bucket === 'ACTIVE') return 'is-active';
    return 'is-other';
  }

  function injuryLabel(row) {
    const injury = row?.injury || {};
    const bits = [injury.type, injury.location, injury.detail]
      .map(clean).filter(Boolean)
      .filter((value,index,array) => array.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
    return bits[0] || clean(injury.label) || 'Not specified';
  }

  function matchStatus(row) {
    if (state.status === 'ALL') return true;
    if (state.status === 'OUT') return row.bucket === 'OUT';
    if (state.status === 'DOUBTFUL') return row.bucket === 'DOUBTFUL';
    if (state.status === 'QUESTIONABLE') return row.bucket === 'QUESTIONABLE';
    if (state.status === 'ACTIVE') return row.bucket === 'ACTIVE';
    return row.bucket === 'OTHER';
  }

  function matchQuery(team, row) {
    const q = state.query.toLowerCase();
    if (!q) return true;
    const hay = [
      team.name, team.abbreviation, team.conference, team.division,
      row?.player?.name, row?.player?.position, injuryLabel(row),
      row?.status_label, row?.status, row?.note
    ].map(clean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function filteredTeams() {
    const teams = Array.isArray(state.data?.teams) ? state.data.teams : [];
    return teams
      .filter(team => state.conference === 'ALL' || team.conference === state.conference)
      .map(team => ({
        ...team,
        visible: (Array.isArray(team.injuries) ? team.injuries : []).filter(row => matchStatus(row) && matchQuery(team,row))
      }))
      .filter(team => {
        if (!state.query && state.status === 'ALL') return true;
        if (team.visible.length) return true;
        if (!state.query) return false;
        const teamHay = `${team.name} ${team.abbreviation} ${team.conference} ${team.division}`.toLowerCase();
        return teamHay.includes(state.query.toLowerCase()) && state.status === 'ALL';
      });
  }

  function metric(label, value, tone='') {
    return `<div class="pbeinj-metric ${tone}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
  }

  function teamIndex(teams) {
    return `<nav class="pbeinj-team-index" aria-label="Jump to team">
      ${teams.map(team => `<button type="button" data-team-jump="${esc(team.abbreviation)}" title="${esc(team.name)}">
        <img src="${esc(team.logo)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">
        <span>${esc(team.abbreviation)}</span>
        <b>${esc(team.counts?.total ?? 0)}</b>
      </button>`).join('')}
    </nav>`;
  }

  function playerRow(row) {
    const player = row.player || {};
    const updated = row.updated_at ? timeAgo(row.updated_at) : 'source time unavailable';
    const headshot = clean(player.headshot);
    return `<article class="pbeinj-player ${statusTone(row)}" data-player-status="${esc(row.bucket || 'OTHER')}">
      <div class="pbeinj-player-id">
        <div class="pbeinj-headshot">${headshot ? `<img src="${esc(headshot)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : `<span>${esc((player.position || 'NFL').slice(0,3))}</span>`}</div>
        <div><strong>${esc(player.name || 'Unknown player')}</strong><span>${esc(player.position || 'Position n/a')}</span></div>
      </div>
      <div class="pbeinj-injury"><span class="pbeinj-mobile-label">INJURY</span><strong>${esc(injuryLabel(row))}</strong>${row.injury?.side ? `<small>${esc(row.injury.side)}</small>` : ''}</div>
      <div class="pbeinj-status"><span class="pbeinj-mobile-label">STATUS</span><b>${esc(statusLabel(row.status,row.status_label))}</b></div>
      <div class="pbeinj-update"><span class="pbeinj-mobile-label">UPDATED</span><strong>${esc(updated)}</strong>${row.note ? `<small>${esc(row.note)}</small>` : ''}</div>
    </article>`;
  }

  function teamCard(team) {
    const rows = team.visible || [];
    const zeroFiltered = rows.length === 0 && ((team.counts?.total || 0) > 0);
    const countText = state.status === 'ALL' && !state.query
      ? `${team.counts?.total || 0} reported`
      : `${rows.length} matching`;
    return `<section class="pbeinj-team" id="pbeinj-team-${esc(team.abbreviation)}" data-team="${esc(team.abbreviation)}">
      <header class="pbeinj-team-head">
        <div class="pbeinj-team-brand">
          <div class="pbeinj-team-logo"><img src="${esc(team.logo)}" alt="${esc(team.name)} logo" loading="lazy" decoding="async" onerror="this.remove()"></div>
          <div><span>${esc(team.conference)} ${esc(team.division)}</span><h3>${esc(team.name)}</h3></div>
        </div>
        <div class="pbeinj-team-counts">
          <strong>${esc(countText)}</strong>
          <span>${team.counts?.out || 0} out/IR · ${team.counts?.questionable || 0} Q · ${team.counts?.doubtful || 0} D</span>
        </div>
      </header>
      ${rows.length ? `<div class="pbeinj-table-head" aria-hidden="true"><span>PLAYER</span><span>INJURY</span><span>STATUS</span><span>UPDATED / SOURCE NOTE</span></div><div class="pbeinj-roster">${rows.map(playerRow).join('')}</div>`
        : `<div class="pbeinj-empty-team"><strong>${zeroFiltered ? 'No injuries match these filters' : 'No current injuries reported'}</strong><span>${zeroFiltered ? 'Change the status or search filter to reveal this team’s current entries.' : 'This team is still shown so the league board always accounts for all 32 clubs.'}</span></div>`}
    </section>`;
  }

  function controls() {
    const statusButtons = [
      ['ALL','All'], ['OUT','Out / IR'], ['DOUBTFUL','Doubtful'],
      ['QUESTIONABLE','Questionable'], ['ACTIVE','Active'], ['OTHER','Other']
    ];
    return `<div class="pbeinj-controls">
      <label class="pbeinj-search"><span>SEARCH</span><input type="search" data-injury-search value="${esc(state.query)}" placeholder="Player, team, position or injury" autocomplete="off"></label>
      <div class="pbeinj-segment" role="group" aria-label="Conference">
        ${['ALL','AFC','NFC'].map(value => `<button type="button" data-conference="${value}" class="${state.conference===value?'is-active':''}">${value}</button>`).join('')}
      </div>
      <div class="pbeinj-status-filter" role="group" aria-label="Injury status">
        ${statusButtons.map(([value,label]) => `<button type="button" data-status="${value}" class="${state.status===value?'is-active':''}">${label}</button>`).join('')}
      </div>
    </div>`;
  }

  function loadingShell() {
    return `<section id="${ROOT_ID}" class="pbeinj-command is-loading" aria-live="polite">
      <div class="pbeinj-kicker">LEAGUE INJURY BOARD</div>
      <div class="pbeinj-loading"><span></span><div><strong>Loading all 32 teams</strong><small>Building the current injury board…</small></div></div>
    </section>`;
  }

  function errorShell() {
    return `<section id="${ROOT_ID}" class="pbeinj-command is-error" aria-live="polite">
      <div class="pbeinj-kicker">LEAGUE INJURY BOARD</div>
      <div class="pbeinj-error"><div><strong>League injury feed is temporarily unavailable</strong><span>${esc(state.error || 'Source unavailable')}</span></div><button type="button" data-injury-retry>Retry</button></div>
    </section>`;
  }

  function boardShell() {
    const data = state.data || {};
    const counts = data.counts || {};
    const teams = filteredTeams();
    const totalVisible = teams.reduce((sum,team)=>sum+team.visible.length,0);
    const freshness = data.source?.fetched_at ? `Source updated ${timeAgo(data.source.fetched_at)}` : 'Source time unavailable';
    return `<section id="${ROOT_ID}" class="pbeinj-command" aria-label="NFL league injury board">
      <header class="pbeinj-hero">
        <div class="pbeinj-hero-copy">
          <span class="pbeinj-kicker">NFL · ALL 32 TEAMS · CURRENT REPORTED DESIGNATIONS</span>
          <h2>League Injury Board</h2>
          <p>Every currently reported injury entry, organized by team. Search the league, isolate a conference or status, then jump straight to any club.</p>
          <div class="pbeinj-fresh"><i></i><span>${esc(freshness)} · ESPN injury report</span></div>
        </div>
        <div class="pbeinj-metrics">
          ${metric('reported players',counts.total ?? 0)}
          ${metric('out / IR',counts.out ?? 0,'is-critical')}
          ${metric('questionable',counts.questionable ?? 0,'is-watch')}
          ${metric('doubtful',counts.doubtful ?? 0)}
        </div>
      </header>
      ${controls()}
      <div class="pbeinj-board-meta"><span><strong>${esc(teams.length)}</strong> teams shown · <strong>${esc(totalVisible)}</strong> matching injury entries</span><span>Current source designations only · no inferred timelines</span></div>
      ${teamIndex(teams)}
      <div class="pbeinj-team-grid">${teams.map(teamCard).join('')}</div>
      <footer class="pbeinj-source">Source: ESPN injury report. PropBetEdge groups and filters the reported records; it does not infer return dates, practice participation, or game-day inactive status.</footer>
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
    const anchor = anchorFor(root);
    const shell = document.createElement('section');
    shell.id = ROOT_ID;
    if (anchor) anchor.insertAdjacentElement('afterend', shell);
    else root.prepend(shell);
    return shell;
  }

  function render({preserveFocus=false}={}) {
    const host = ensureHost();
    if (!host) return false;
    const active = preserveFocus ? document.activeElement : null;
    const selection = active?.matches?.('[data-injury-search]') ? [active.selectionStart,active.selectionEnd] : null;
    host.outerHTML = state.loading && !state.data ? loadingShell() : state.error && !state.data ? errorShell() : boardShell();
    wire();
    if (selection) {
      const input = document.querySelector(`#${ROOT_ID} [data-injury-search]`);
      input?.focus({preventScroll:true});
      try { input?.setSelectionRange(selection[0],selection[1]); } catch {}
    }
    return true;
  }

  function jumpToTeam(abbr) {
    const target = document.getElementById(`pbeinj-team-${abbr}`);
    if (!target) return;
    target.scrollIntoView({behavior:'smooth',block:'start'});
    target.classList.add('is-jumped');
    setTimeout(()=>target.classList.remove('is-jumped'),900);
  }

  function wire() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.querySelector('[data-injury-search]')?.addEventListener('input', event => {
      state.query = clean(event.target.value);
      render({preserveFocus:true});
    });
    root.querySelectorAll('[data-conference]').forEach(button => button.addEventListener('click', () => {
      state.conference = button.dataset.conference || 'ALL'; render();
    }));
    root.querySelectorAll('[data-status]').forEach(button => button.addEventListener('click', () => {
      state.status = button.dataset.status || 'ALL'; render();
    }));
    root.querySelectorAll('[data-team-jump]').forEach(button => button.addEventListener('click', () => jumpToTeam(button.dataset.teamJump)));
    root.querySelector('[data-injury-retry]')?.addEventListener('click', () => load(true));
  }

  async function load(force=false) {
    if (window.App?.current !== 'injuries') return false;
    ensureHost();
    if ((state.loading || state.loaded) && !force) { render(); return true; }
    const request = ++state.request;
    state.loading = true;
    state.error = null;
    render();
    try {
      const response = await fetch(API, { headers:{accept:'application/json'}, cache:'no-store' });
      const body = await response.json().catch(()=>null);
      if (!response.ok || !body?.ok || !Array.isArray(body?.teams)) throw new Error(body?.error || `injury_board_${response.status}`);
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
