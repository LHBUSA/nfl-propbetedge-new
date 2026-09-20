/* PropBetEdge NFL — Super Bowls v3
 *
 * Rights-clean Super Bowl archive backed only by /api/season-history.
 * Winner, date and venue are published only when carried by the CC0 source.
 */
(() => {
  'use strict';

  const state = {
    loading: false,
    loaded: false,
    error: null,
    data: null,
    era: 'all',
    search: '',
  };

  const esc = v => String(v ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const games = () => (Array.isArray(state.data?.seasons) ? state.data.seasons : [])
    .filter(s => s?.championship)
    .map(s => ({ ...s.championship, season_year: Number(s.year), season_qid: s.qid }))
    .sort((a,b) => b.season_year - a.season_year);

  function roman(name) {
    return String(name || '').replace(/^Super Bowl\s+/i, '') || 'SB';
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    return games().filter(sb => {
      const y = Number(sb.season_year) || 0;
      let eraOk = true;
      if (state.era === '2020s') eraOk = y >= 2020;
      if (state.era === '2010s') eraOk = y >= 2010 && y < 2020;
      if (state.era === '2000s') eraOk = y >= 2000 && y < 2010;
      if (state.era === '1990s') eraOk = y >= 1990 && y < 2000;
      if (state.era === 'classic') eraOk = y < 1990;
      const qOk = !q || [sb.winner, sb.venue, sb.name, sb.season_year, sb.qid, sb.winner_qid]
        .some(v => String(v || '').toLowerCase().includes(q));
      return eraOk && qOk;
    });
  }

  function dynasty() {
    const counts = new Map();
    for (const sb of games()) {
      if (!sb.winner) continue;
      const row = counts.get(sb.winner) || { name: sb.winner, wins: 0, years: [] };
      row.wins += 1;
      row.years.push(sb.season_year);
      counts.set(sb.winner, row);
    }
    return [...counts.values()].sort((a,b) => b.wins - a.wins || a.name.localeCompare(b.name));
  }

  function sourceAge() {
    const at = Date.parse(state.data?.source?.retrieved_at || '');
    if (!Number.isFinite(at)) return 'Release snapshot';
    const hours = Math.max(0, Math.round((Date.now() - at) / 3600000));
    if (hours < 1) return 'Release snapshot · refreshed <1h ago';
    if (hours < 48) return `Release snapshot · ${hours}h ago`;
    return `Release snapshot · ${Math.round(hours / 24)}d ago`;
  }

  function summary() {
    const all = games();
    const winners = new Set(all.map(sb => sb.winner).filter(Boolean));
    const venues = new Set(all.map(sb => sb.venue).filter(Boolean));
    const top = dynasty()[0] || null;
    return `<div class="pbe11-summary">
      <div class="pbe11-stat"><b>${all.length}</b><span>Sourced Super Bowl results</span></div>
      <div class="pbe11-stat"><b class="gold">${winners.size}</b><span>Winning team labels</span></div>
      <div class="pbe11-stat"><b class="blue">${top?.wins || '—'}</b><span>Most wins in source · ${esc(top?.name || '—')}</span></div>
      <div class="pbe11-stat"><b>${venues.size || '—'}</b><span>Venues carried by source</span></div>
    </div>`;
  }

  function latestCard() {
    const sb = games()[0];
    if (!sb) return '';
    return `<aside class="pbe11-latest">
      <div class="pbe11-latest-label">LATEST SOURCED CHAMPIONSHIP · ${esc(sb.name || 'Super Bowl')}</div>
      <div class="pbe11-latest-title">${esc(sb.winner || 'Winner not carried')}</div>
      <div class="pbe11-latest-score">CHAMPION</div>
      <div class="pbe11-latest-meta">${esc(sb.decided_on || 'Date unavailable')}<br>${esc(sb.venue || 'Venue not carried')}</div>
      <div class="pbe11-latest-mvp"><span>Source identity</span><b>${esc(sb.qid || '—')}</b></div>
    </aside>`;
  }

  function dynastyHtml() {
    const rows = dynasty().slice(0, 8);
    return `<section class="pbe11-dynasty">
      <div class="pbe11-panel-head"><strong>Championship Board</strong><span>Computed only from sourced winners</span></div>
      <div class="pbe11-dynasty-grid">${rows.map(row => `
        <div class="pbe11-dynasty-card">
          <div class="pbe11-dynasty-top"><div class="pbe11-dynasty-name">${esc(row.name)}</div></div>
          <div class="pbe11-dynasty-wins">${row.wins}</div>
          <div class="pbe11-dynasty-copy">Sourced Super Bowl win${row.wins === 1 ? '' : 's'}</div>
          <div class="pbe11-dynasty-copy">${row.years.sort((a,b)=>b-a).join(' · ')}</div>
        </div>`).join('')}
      </div>
    </section>`;
  }

  function card(sb) {
    return `<article class="pbe11-card">
      <span class="pbe11-roman">${esc(roman(sb.name))}</span>
      <div class="pbe11-card-head">
        <div>
          <div class="pbe11-card-title">${esc(sb.name || 'Super Bowl')}</div>
          <div class="pbe11-card-date">${esc(sb.decided_on || 'Date unavailable')}</div>
        </div>
        <span class="pbe11-year">${esc(sb.season_year)}</span>
      </div>
      <div class="pbe11-matchup">
        <div class="pbe11-team-line winner">
          <b>${esc(sb.winner || 'Winner not carried')}</b>
          <span>${sb.winner ? 'Verified winner' : 'Source gap'}</span>
        </div>
      </div>
      <div class="pbe11-score">${sb.winner ? 'CHAMPION' : '—'}</div>
      <div class="pbe11-venue">${esc(sb.venue || 'Venue not carried')}</div>
      <div class="pbe11-mvp">Source: <b>${esc(sb.qid || '—')}</b></div>
    </article>`;
  }

  function grid() {
    const list = filtered();
    return list.length
      ? `<div class="pbe11-grid">${list.map(card).join('')}</div>`
      : '<div class="pbe11-empty">No sourced Super Bowl results match the current filters.</div>';
  }

  function loadingMarkup() {
    return `<section class="pbe11-sb"><header class="pbe11-hero"><div>
      <div class="pbe11-kicker">SUPER BOWL ARCHIVE · SOURCED RELEASE</div>
      <h1 class="pbe11-title">Every champion.<br><em>Loading the source.</em></h1>
      <div class="pbe11-copy">Loading the rights-clean championship release snapshot.</div>
    </div></header><div class="pbe11-empty">Loading Super Bowl history…</div></section>`;
  }

  function errorMarkup() {
    return `<section class="pbe11-sb"><header class="pbe11-hero"><div>
      <div class="pbe11-kicker">SUPER BOWL ARCHIVE · SOURCED RELEASE</div>
      <h1 class="pbe11-title">Championship history<br><em>temporarily unavailable.</em></h1>
      <div class="pbe11-copy">The sourced release snapshot could not be loaded. The retired legacy archive is not used as a fallback.</div>
    </div></header><div class="pbe11-empty"><div><b>Super Bowl source unavailable.</b><br><button class="pbe11-era-btn active" data-sb-retry type="button">Retry</button></div></div></section>`;
  }

  function pageMarkup() {
    const all = games();
    const years = all.map(g => Number(g.season_year)).filter(Number.isFinite);
    return `<section class="pbe11-sb">
      <header class="pbe11-hero">
        <div>
          <div class="pbe11-kicker">SUPER BOWL ARCHIVE · RIGHTS-CLEAN RELEASE</div>
          <h1 class="pbe11-title">Every sourced champion.<br><em>No invented box score.</em></h1>
          <div class="pbe11-copy">A championship archive from the PropBetEdge history release: Super Bowl identity, winner, decision date and venue only where carried by the CC0 source. Runner-up, score, MVP and narrative notes stay absent until a rights-clean lane supports them.</div>
          <div class="pbe11-badges">
            <span class="pbe11-badge blue">WIKIDATA · CC0</span>
            <span class="pbe11-badge">${all.length} championship results</span>
            <span class="pbe11-badge">${years.length ? Math.min(...years) : '—'}–${years.length ? Math.max(...years) : '—'}</span>
            <span class="pbe11-badge">${esc(sourceAge())}</span>
          </div>
        </div>
        ${latestCard()}
      </header>
      <div id="pbe11-summary">${summary()}</div>
      <section class="pbe11-controls">
        <div class="pbe11-era">${[['all','All Eras'],['2020s','2020s'],['2010s','2010s'],['2000s','2000s'],['1990s','1990s'],['classic','Classic']]
          .map(([id,label]) => `<button class="pbe11-era-btn ${state.era === id ? 'active' : ''}" data-era="${id}">${label}</button>`).join('')}</div>
        <input id="pbe11-search" class="pbe11-search" type="search" placeholder="Search winner, venue, Super Bowl or source ID…" value="${esc(state.search)}">
      </section>
      ${dynastyHtml()}
      <div id="pbe11-grid">${grid()}</div>
    </section>`;
  }

  function paint() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    if (state.loading && !state.loaded) {
      vc.innerHTML = loadingMarkup();
      return;
    }
    if (state.error && !state.loaded) {
      vc.innerHTML = errorMarkup();
      document.querySelector('[data-sb-retry]')?.addEventListener('click', () => load({ force: true }));
      return;
    }
    vc.innerHTML = pageMarkup();
    wire();
  }

  async function load({ force = false } = {}) {
    if (state.loading) return;
    if (state.loaded && !force) {
      paint();
      return;
    }
    state.loading = true;
    state.error = null;
    paint();
    try {
      const response = await fetch('/api/season-history', {
        headers: { accept: 'application/json' },
        cache: force ? 'reload' : 'default',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true || !Array.isArray(body.seasons)) {
        throw new Error(body?.error || `season_history_http_${response.status}`);
      }
      state.data = body;
      state.loaded = true;
    } catch (error) {
      state.error = String(error?.message || error);
    } finally {
      state.loading = false;
      paint();
    }
  }

  function refresh() {
    const host = document.getElementById('pbe11-grid');
    if (host) host.innerHTML = grid();
  }

  function wire() {
    document.querySelectorAll('.pbe11-era-btn[data-era]').forEach(b => b.addEventListener('click', () => {
      state.era = b.dataset.era || 'all';
      paint();
    }));
    document.getElementById('pbe11-search')?.addEventListener('input', e => {
      state.search = e.currentTarget.value || '';
      refresh();
    });
  }

  function render() { return load(); }
  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.sb = render;
    return true;
  }

  window.PBESuperBowlsV2 = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
