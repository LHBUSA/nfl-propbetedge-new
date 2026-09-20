/* PropBetEdge NFL — Records v3
 *
 * Rights-clean historical record surface derived only from the sourced
 * /api/season-history release. Legacy NFL_RECORDS/NFL_MILESTONES are not read.
 */
(() => {
  'use strict';

  const state = {
    loading: false,
    loaded: false,
    error: null,
    data: null,
    tab: 'titles',
    search: '',
  };

  const esc = v => String(v ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const games = () => (Array.isArray(state.data?.seasons) ? state.data.seasons : [])
    .filter(s => s?.championship)
    .map(s => ({ ...s.championship, season_year: Number(s.year), season_qid: s.qid }))
    .sort((a,b) => b.season_year - a.season_year);

  function titleRows() {
    const map = new Map();
    for (const g of games()) {
      if (!g.winner) continue;
      const row = map.get(g.winner) || { name: g.winner, count: 0, years: [] };
      row.count += 1;
      row.years.push(g.season_year);
      map.set(g.winner, row);
    }
    return [...map.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function venueRows() {
    const map = new Map();
    for (const g of games()) {
      if (!g.venue) continue;
      const row = map.get(g.venue) || { name: g.venue, count: 0, years: [] };
      row.count += 1;
      row.years.push(g.season_year);
      map.set(g.venue, row);
    }
    return [...map.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function filteredRows(rows) {
    const q = state.search.trim().toLowerCase();
    return q ? rows.filter(r => [r.name, r.count, ...r.years].some(v => String(v).toLowerCase().includes(q))) : rows;
  }

  function tabs() {
    return [
      ['titles','Championship Titles'],
      ['venues','Championship Venues'],
      ['timeline','Championship Timeline'],
    ].map(([id,label]) => `<button class="pbe10-tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('');
  }

  function featured(rows, noun) {
    const list = filteredRows(rows).slice(0,3);
    if (!list.length) return '';
    return `<div class="pbe10-featured">${list.map((r,i) => `
      <article class="pbe10-feature">
        <span class="pbe10-feature-rank">${i + 1}</span>
        <div class="pbe10-feature-stat">${r.count}</div>
        <div class="pbe10-feature-holder">${esc(r.name)}</div>
        <div class="pbe10-feature-desc">Sourced ${noun}${r.count === 1 ? '' : 's'}</div>
        <div class="pbe10-feature-meta">${r.years.slice().sort((a,b)=>b-a).join(' · ')}</div>
      </article>`).join('')}</div>`;
  }

  function aggregateGrid(rows, noun) {
    const list = filteredRows(rows);
    if (!list.length) return '<div class="pbe10-empty">No sourced rows match the current search.</div>';
    return `${featured(rows, noun)}<div class="pbe10-grid">${list.slice(3).map(r => `
      <article class="pbe10-card">
        <div class="pbe10-card-stat">${r.count}</div>
        <div class="pbe10-card-holder">${esc(r.name)}</div>
        <div class="pbe10-card-desc">Sourced ${noun}${r.count === 1 ? '' : 's'}</div>
        <div class="pbe10-card-meta">${r.years.slice().sort((a,b)=>b-a).join(' · ')}</div>
      </article>`).join('')}</div>`;
  }

  function timeline() {
    const q = state.search.trim().toLowerCase();
    const list = games().filter(g => !q || [g.winner,g.venue,g.name,g.season_year,g.qid].some(v => String(v || '').toLowerCase().includes(q)));
    if (!list.length) return '<div class="pbe10-empty">No sourced championship rows match the current search.</div>';
    return `<section class="pbe10-timeline">${list.map(g => `
      <div class="pbe10-time-row">
        <div class="pbe10-time-year">${esc(g.season_year)}</div>
        <div class="pbe10-time-axis"><span class="pbe10-time-dot"></span></div>
        <div class="pbe10-time-copy"><b>${esc(g.winner || 'Winner not carried')}</b> · ${esc(g.name || 'Super Bowl')}${g.venue ? ` · ${esc(g.venue)}` : ''}</div>
      </div>`).join('')}</section>`;
  }

  function body() {
    if (state.tab === 'venues') return aggregateGrid(venueRows(), 'championship hosted');
    if (state.tab === 'timeline') return timeline();
    return aggregateGrid(titleRows(), 'Super Bowl win');
  }

  function sourceAge() {
    const at = Date.parse(state.data?.source?.retrieved_at || '');
    if (!Number.isFinite(at)) return 'Release snapshot';
    const hours = Math.max(0, Math.round((Date.now() - at) / 3600000));
    if (hours < 1) return 'Release snapshot · refreshed <1h ago';
    if (hours < 48) return `Release snapshot · ${hours}h ago`;
    return `Release snapshot · ${Math.round(hours / 24)}d ago`;
  }

  function loadingMarkup() {
    return `<section class="pbe10-records"><header class="pbe10-hero">
      <div class="pbe10-kicker">NFL RECORD BOOK · SOURCED RELEASE</div>
      <h1 class="pbe10-title">Records that<br><em>we can prove.</em></h1>
      <div class="pbe10-copy">Loading the rights-clean championship record release.</div>
    </header><div class="pbe10-empty">Loading sourced records…</div></section>`;
  }

  function errorMarkup() {
    return `<section class="pbe10-records"><header class="pbe10-hero">
      <div class="pbe10-kicker">NFL RECORD BOOK · SOURCED RELEASE</div>
      <h1 class="pbe10-title">Record book<br><em>temporarily unavailable.</em></h1>
      <div class="pbe10-copy">The sourced release snapshot could not be loaded. The retired unsourced record dataset is not used as a fallback.</div>
    </header><div class="pbe10-empty"><div><b>Record source unavailable.</b><br><button class="pbe10-tab active" data-record-retry type="button">Retry</button></div></div></section>`;
  }

  function pageMarkup() {
    const titles = titleRows();
    const top = titles[0] || null;
    const gameCount = games().length;
    return `<section class="pbe10-records">
      <header class="pbe10-hero">
        <div class="pbe10-kicker">NFL CHAMPIONSHIP RECORD BOOK · RIGHTS-CLEAN RELEASE</div>
        <h1 class="pbe10-title">Records that<br><em>outlive the moment.</em></h1>
        <div class="pbe10-copy">This restored record book is intentionally narrower than the retired unsourced version. It publishes only championship records derivable from the same CC0 release snapshot: title counts, championship venues and the Super Bowl timeline. Player career records return when a rights-clean statistical lane supports them.</div>
        <div class="pbe10-badges">
          <span class="pbe10-badge red">WIKIDATA · CC0</span>
          <span class="pbe10-badge">${gameCount} sourced championship results</span>
          <span class="pbe10-badge">${titles.length} winning team labels</span>
          <span class="pbe10-badge">${top ? `${esc(top.name)} · ${top.count} wins` : 'No leader'}</span>
          <span class="pbe10-badge">${esc(sourceAge())}</span>
        </div>
      </header>
      <section class="pbe10-controls">
        <div class="pbe10-tabs">${tabs()}</div>
        <input id="pbe10-search" class="pbe10-search" type="search" placeholder="Search winner, venue or season…" value="${esc(state.search)}">
      </section>
      <div id="pbe10-body">${body()}</div>
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
      document.querySelector('[data-record-retry]')?.addEventListener('click', () => load({ force: true }));
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
    const host = document.getElementById('pbe10-body');
    if (host) host.innerHTML = body();
  }

  function wire() {
    document.querySelectorAll('.pbe10-tab[data-tab]').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab || 'titles';
      paint();
    }));
    document.getElementById('pbe10-search')?.addEventListener('input', e => {
      state.search = e.currentTarget.value || '';
      refresh();
    });
  }

  function render() { return load(); }
  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.records = render;
    return true;
  }

  window.PBERecordsV2 = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
