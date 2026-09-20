/* PropBetEdge NFL — Season Archive v3
 *
 * Rights-clean consumer season archive backed only by /api/season-history.
 * The endpoint serves a versioned Wikidata CC0 release snapshot. The legacy
 * archive season encyclopedia has no authority over this route.
 */
(() => {
  'use strict';

  const state = {
    loading: false,
    loaded: false,
    error: null,
    data: null,
    tab: 'timeline',
    year: null,
  };

  const esc = v => String(v ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const seasons = () => Array.isArray(state.data?.seasons) ? state.data.seasons : [];
  const completed = () => seasons().filter(s => Number(s.year) < 2026 || s.championship);
  const latestYear = () => {
    const rows = completed();
    return rows.length ? Math.max(...rows.map(s => Number(s.year) || 0)) : null;
  };
  const seasonByYear = year => completed().find(s => Number(s.year) === Number(year)) || null;
  const championshipRows = () => completed().filter(s => s.championship?.winner);

  function sourceAge() {
    const at = Date.parse(state.data?.source?.retrieved_at || '');
    if (!Number.isFinite(at)) return 'Release snapshot';
    const hours = Math.max(0, Math.round((Date.now() - at) / 3600000));
    if (hours < 1) return 'Release snapshot · refreshed <1h ago';
    if (hours < 48) return `Release snapshot · ${hours}h ago`;
    return `Release snapshot · ${Math.round(hours / 24)}d ago`;
  }

  function tabs() {
    return [
      ['timeline', 'Season Timeline'],
      ['champions', 'Super Bowl Champions'],
    ].map(([id,label]) =>
      `<button class="pbe8-tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`
    ).join('');
  }

  function yearRail() {
    return `<div class="pbe8-yearrail">${completed().slice().sort((a,b)=>b.year-a.year).map(s =>
      `<button class="pbe8-year ${Number(state.year) === Number(s.year) ? 'active' : ''}" data-year="${s.year}">${s.year}</button>`
    ).join('')}</div>`;
  }

  function sourcePanel(s) {
    const c = s?.championship || null;
    return `<section class="pbe8-awards">
      <div class="pbe8-panel-head"><strong>Source record</strong><span>Wikidata · CC0</span></div>
      <div class="pbe8-award-row"><div class="pbe8-award-label">Season item</div><div class="pbe8-award-value">${esc(s?.qid || '—')}</div></div>
      <div class="pbe8-award-row"><div class="pbe8-award-label">Season label</div><div class="pbe8-award-value">${esc(s?.label || '—')}</div></div>
      <div class="pbe8-award-row"><div class="pbe8-award-label">Championship</div><div class="pbe8-award-value">${esc(c?.name || 'Not carried for this season')}</div></div>
      <div class="pbe8-award-row"><div class="pbe8-award-label">Decided</div><div class="pbe8-award-value">${esc(c?.decided_on || '—')}</div></div>
      <div class="pbe8-award-row"><div class="pbe8-award-label">Venue</div><div class="pbe8-award-value">${esc(c?.venue || 'Not carried')}</div></div>
    </section>`;
  }

  function timeline() {
    const s = seasonByYear(state.year);
    if (!s) return '<div class="pbe8-empty">No sourced NFL season is available for this selection.</div>';
    const c = s.championship || null;
    return `${yearRail()}
      <div class="pbe8-season-grid">
        <section class="pbe8-champ">
          <div class="pbe8-sbnum">${esc(c?.name?.replace(/^Super Bowl\s+/i, '') || s.year)}</div>
          <div class="pbe8-champ-label">${esc(s.year)} NFL SEASON · SOURCED ARCHIVE</div>
          <div class="pbe8-champ-team">
            <div>
              <div class="pbe8-champ-name">${esc(c?.winner || 'Season indexed')}</div>
              <div class="pbe8-champ-meta">${c ? `${esc(c.name)} · ${esc(c.decided_on || 'date unavailable')}` : 'No Super Bowl result is attached to this season in the current source snapshot.'}</div>
            </div>
          </div>
          <div class="pbe8-score">${c?.winner ? 'CHAMPION' : 'SEASON'}</div>
          <div class="pbe8-score-label">${c?.winner ? 'Verified winner from source' : 'Verified season identity'}</div>
          <div class="pbe8-champ-cards">
            <div class="pbe8-mini"><span>Season QID</span><b>${esc(s.qid || '—')}</b></div>
            <div class="pbe8-mini"><span>Championship QID</span><b>${esc(c?.qid || '—')}</b></div>
          </div>
        </section>
        ${sourcePanel(s)}
      </div>
      <section class="pbe8-story">
        <strong>What this release intentionally does not infer</strong>
        <p>Scores, runner-up, Super Bowl MVP, league MVP, awards, statistical leaders and narrative storylines are not published here unless they arrive through a rights-clean sourced lane. Missing fields stay missing.</p>
      </section>`;
  }

  function champions() {
    const rows = championshipRows().slice().sort((a,b)=>b.year-a.year);
    if (!rows.length) return '<div class="pbe8-empty">No sourced Super Bowl winners are available.</div>';
    return `<div class="pbe8-card-grid">${rows.map(s => {
      const c = s.championship;
      return `<article class="pbe8-card" data-year="${s.year}">
        <div class="pbe8-card-top">
          <div class="pbe8-card-title">${esc(c.winner)}</div>
          <span class="pbe8-card-meta">${esc(c.name || '')}</span>
        </div>
        <div class="pbe8-card-big">${esc(s.year)}</div>
        <div class="pbe8-card-copy">${esc(c.decided_on || 'Date unavailable')}${c.venue ? ` · ${esc(c.venue)}` : ''}</div>
        <div class="pbe8-tags"><span class="pbe8-tag">${esc(c.qid || 'SOURCE')}</span></div>
      </article>`;
    }).join('')}</div>`;
  }

  function body() {
    return state.tab === 'champions' ? champions() : timeline();
  }

  function loadingMarkup() {
    return `<section class="pbe8-archive">
      <header class="pbe8-hero">
        <div class="pbe8-kicker">NFL SEASON ARCHIVE · SOURCED RELEASE</div>
        <h1 class="pbe8-title">Every season.<br><em>Only sourced facts.</em></h1>
        <div class="pbe8-copy">Loading the rights-clean NFL season history release snapshot.</div>
      </header>
      <div class="pbe8-empty">Loading season history…</div>
    </section>`;
  }

  function errorMarkup() {
    return `<section class="pbe8-archive">
      <header class="pbe8-hero">
        <div class="pbe8-kicker">NFL SEASON ARCHIVE · SOURCED RELEASE</div>
        <h1 class="pbe8-title">Season history<br><em>temporarily unavailable.</em></h1>
        <div class="pbe8-copy">The sourced release snapshot could not be loaded. The retired legacy encyclopedia is intentionally not used as a fallback.</div>
      </header>
      <div class="pbe8-empty"><div><b>Season history source unavailable.</b><br><button class="pbe8-tab active" data-season-retry type="button">Retry</button></div></div>
    </section>`;
  }

  function pageMarkup() {
    const rows = completed();
    const years = rows.map(s => Number(s.year)).filter(Number.isFinite);
    const min = years.length ? Math.min(...years) : '—';
    const max = years.length ? Math.max(...years) : '—';
    return `<section class="pbe8-archive">
      <header class="pbe8-hero">
        <div class="pbe8-kicker">NFL SEASON ENCYCLOPEDIA · RIGHTS-CLEAN RELEASE</div>
        <h1 class="pbe8-title">Every season tells<br><em>a sourced story.</em></h1>
        <div class="pbe8-copy">Browse the verified NFL season spine and sourced Super Bowl winners from the PropBetEdge history graph. Every displayed fact comes from the versioned CC0 release snapshot; unsupported legacy fields are not guessed back into the page.</div>
        <div class="pbe8-badges">
          <span class="pbe8-badge gold">WIKIDATA · CC0</span>
          <span class="pbe8-badge">${rows.length} NFL seasons</span>
          <span class="pbe8-badge">${min}–${max}</span>
          <span class="pbe8-badge">${esc(sourceAge())}</span>
        </div>
      </header>
      <nav class="pbe8-tabs">${tabs()}</nav>
      <div id="pbe8-body">${body()}</div>
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
      document.querySelector('[data-season-retry]')?.addEventListener('click', () => load({ force: true }));
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
      if (!state.year) state.year = latestYear();
    } catch (error) {
      state.error = String(error?.message || error);
    } finally {
      state.loading = false;
      paint();
    }
  }

  function refreshBody() {
    const host = document.getElementById('pbe8-body');
    if (host) host.innerHTML = body();
    wireBody();
  }

  function wire() {
    document.querySelectorAll('.pbe8-tab[data-tab]').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab || 'timeline';
      refreshBody();
    }));
    wireBody();
  }

  function wireBody() {
    document.querySelectorAll('.pbe8-year').forEach(b => b.addEventListener('click', () => {
      state.year = Number(b.dataset.year);
      refreshBody();
    }));
    document.querySelectorAll('.pbe8-card[data-year]').forEach(card => card.addEventListener('click', () => {
      state.year = Number(card.dataset.year);
      state.tab = 'timeline';
      paint();
    }));
  }

  function render() { return load(); }
  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.seasonhistory = render;
    App.VIEWS['season-history'] = render;
    return true;
  }

  window.PBESeasonArchiveV2 = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
