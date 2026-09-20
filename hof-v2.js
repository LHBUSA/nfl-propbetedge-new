/* PropBetEdge NFL — Hall of Fame v3
 *
 * Consumer Hall of Fame research surface backed only by /api/hof-history.
 * That endpoint reads Wikidata CC0 P6930 (Pro Football Hall of Fame ID), which
 * is approved for public display in history/registry/sources.v2.json.
 *
 * The legacy archive/hof.js dataset is deliberately NOT read here. It remains
 * loaded for rollback compatibility, but it has no authority over this route.
 */
(() => {
  'use strict';

  const state = {
    loading: false,
    loaded: false,
    error: null,
    members: [],
    source: null,
    search: '',
    pos: 'all',
    sort: 'name',
  };

  const esc = v => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const arr = v => Array.isArray(v) ? v : [];
  const unique = values => [...new Set(values.filter(Boolean))];

  function positions() {
    return unique(state.members.flatMap(m => arr(m.positions))).sort((a, b) => a.localeCompare(b));
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    const rows = state.members.filter(member => {
      const posOk = state.pos === 'all' || arr(member.positions).includes(state.pos);
      if (!posOk) return false;
      if (!q) return true;
      return [
        member.name,
        member.qid,
        member.hof_id,
        ...arr(member.positions),
        ...arr(member.teams),
      ].some(value => String(value || '').toLowerCase().includes(q));
    });
    rows.sort((a, b) => state.sort === 'name-desc'
      ? b.name.localeCompare(a.name)
      : a.name.localeCompare(b.name));
    return rows;
  }

  function sourceAge() {
    const at = Date.parse(state.source?.retrieved_at || '');
    if (!Number.isFinite(at)) return 'Source snapshot';
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (minutes < 2) return 'Source snapshot · just refreshed';
    if (minutes < 120) return `Source snapshot · ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `Source snapshot · ${hours}h ago`;
    return `Source snapshot · ${Math.round(hours / 24)}d ago`;
  }

  function summary() {
    const rows = filtered();
    const positionCount = unique(state.members.flatMap(m => arr(m.positions))).length;
    const teamCount = unique(state.members.flatMap(m => arr(m.teams))).length;
    return `<div class="pbe9-summary">
      <div class="pbe9-stat"><b>${rows.length}</b><span>Members in current view</span></div>
      <div class="pbe9-stat"><b class="gold">${state.members.length}</b><span>Sourced Hall members</span></div>
      <div class="pbe9-stat"><b>${positionCount || '—'}</b><span>Positions represented</span></div>
      <div class="pbe9-stat"><b>${teamCount || '—'}</b><span>Team affiliations carried</span></div>
    </div>`;
  }

  function memberCard(member) {
    const positionsText = arr(member.positions).join(' · ') || 'HOF';
    const teamsText = arr(member.teams).join(' · ') || 'Team affiliations not carried by source';
    return `<article class="pbe9-member" data-player="${esc(member.name)}">
      <div class="pbe9-member-top">
        <div>
          <div class="pbe9-member-name">${esc(member.name)}</div>
          <div class="pbe9-teams">${esc(teamsText)}</div>
        </div>
        <span class="pbe9-position">${esc(positionsText)}</span>
      </div>
      <div class="pbe9-era">Pro Football Hall of Fame member · source identity ${esc(member.qid || '—')}</div>
      <div class="pbe9-note">Verified through Wikidata’s Pro Football Hall of Fame identifier. No induction year or career note is inferred when the source does not carry it.</div>
    </article>`;
  }

  function groups() {
    const rows = filtered();
    if (!rows.length) return '<div class="pbe9-empty">No Hall of Fame members match the current filters.</div>';

    const byLetter = new Map();
    for (const member of rows) {
      const letter = String(member.name || '#').trim().charAt(0).toUpperCase() || '#';
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(member);
    }

    const letters = [...byLetter.keys()].sort((a, b) =>
      state.sort === 'name-desc' ? b.localeCompare(a) : a.localeCompare(b));

    return letters.map(letter => {
      const list = byLetter.get(letter);
      return `<section class="pbe9-class">
        <div class="pbe9-class-head">
          <div class="pbe9-year">${esc(letter)}</div>
          <span class="pbe9-class-count">${list.length} member${list.length === 1 ? '' : 's'}</span>
          <span class="pbe9-class-line"></span>
        </div>
        <div class="pbe9-member-grid">${list.map(memberCard).join('')}</div>
      </section>`;
    }).join('');
  }

  function errorMarkup() {
    return `<section class="pbe9-hof">
      <header class="pbe9-hero">
        <div>
          <div class="pbe9-kicker">PRO FOOTBALL HALL OF FAME · SOURCED ARCHIVE</div>
          <h1 class="pbe9-title">Canton history.<br><em>Verified at the source.</em></h1>
          <div class="pbe9-copy">The Hall archive is temporarily unavailable from its rights-cleared source. The old unprovenanced dataset is intentionally not used as a fallback.</div>
        </div>
      </header>
      <div class="pbe9-empty"><div><b>Hall of Fame source unavailable.</b><br><button class="pbe9-pos active" data-hof-retry type="button">Retry source</button></div></div>
    </section>`;
  }

  function loadingMarkup() {
    return `<section class="pbe9-hof">
      <header class="pbe9-hero">
        <div>
          <div class="pbe9-kicker">PRO FOOTBALL HALL OF FAME · SOURCED ARCHIVE</div>
          <h1 class="pbe9-title">Canton history.<br><em>Loading the source.</em></h1>
          <div class="pbe9-copy">Reading the rights-cleared Hall member index. No legacy archive claims are shown while the source is loading.</div>
        </div>
      </header>
      <div class="pbe9-empty">Loading Hall of Fame members…</div>
    </section>`;
  }

  function pageMarkup() {
    return `<section class="pbe9-hof">
      <header class="pbe9-hero">
        <div>
          <div class="pbe9-kicker">PRO FOOTBALL HALL OF FAME · SOURCED ARCHIVE</div>
          <h1 class="pbe9-title">The legends.<br><em>The Canton index.</em></h1>
          <div class="pbe9-copy">Search the sourced Pro Football Hall of Fame member index by name, position or team affiliation. Membership is read from Wikidata’s Pro Football Hall of Fame identifier (P6930), a CC0 source approved for public display by the PropBetEdge history rights registry.</div>
          <div class="pbe9-copy pbe9-source-line"><b>${esc(state.source?.name || 'Wikidata')}</b> · CC0 · P6930 · ${esc(sourceAge())}</div>
        </div>
        <aside class="pbe9-hero-side">
          <b>${state.members.length}</b>
          <span>Hall members in the current sourced index · no unsourced induction years</span>
        </aside>
      </header>

      <div id="pbe9-summary">${summary()}</div>

      <section class="pbe9-controls">
        <div class="pbe9-control-top">
          <input id="pbe9-search" class="pbe9-input" type="search" placeholder="Search legend, team, position…" value="${esc(state.search)}">
          <select id="pbe9-sort" class="pbe9-select">
            <option value="name" ${state.sort === 'name' ? 'selected' : ''}>Name A–Z</option>
            <option value="name-desc" ${state.sort === 'name-desc' ? 'selected' : ''}>Name Z–A</option>
          </select>
        </div>
        <div class="pbe9-posbar">
          <button class="pbe9-pos ${state.pos === 'all' ? 'active' : ''}" data-pos="all">All positions</button>
          ${positions().map(p => `<button class="pbe9-pos ${state.pos === p ? 'active' : ''}" data-pos="${esc(p)}">${esc(p)}</button>`).join('')}
        </div>
      </section>

      <div id="pbe9-classes">${groups()}</div>

      <div class="pbe9-source-foot">
        <span>Source: Wikidata structured data · CC0-1.0 · Pro Football Hall of Fame ID (P6930).</span>
        <span>PropBetEdge does not use the retired archive/hof.js claims on this page.</span>
      </div>
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
      wireRetry();
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
      const response = await fetch('/api/hof-history', {
        headers: { accept: 'application/json' },
        cache: force ? 'reload' : 'default',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true || !Array.isArray(body.members)) {
        throw new Error(body?.error || `hof_http_${response.status}`);
      }
      state.members = body.members;
      state.source = body.source || null;
      state.loaded = true;
      state.error = null;
    } catch (error) {
      state.error = String(error?.message || error);
    } finally {
      state.loading = false;
      paint();
    }
  }

  function refresh() {
    const summaryHost = document.getElementById('pbe9-summary');
    if (summaryHost) summaryHost.innerHTML = summary();
    const classHost = document.getElementById('pbe9-classes');
    if (classHost) classHost.innerHTML = groups();
    wireMembers();
  }

  function wireRetry() {
    document.querySelector('[data-hof-retry]')?.addEventListener('click', () => load({ force: true }));
  }

  function wire() {
    document.getElementById('pbe9-search')?.addEventListener('input', event => {
      state.search = event.currentTarget.value || '';
      refresh();
    });
    document.getElementById('pbe9-sort')?.addEventListener('change', event => {
      state.sort = event.currentTarget.value || 'name';
      paint();
    });
    document.querySelectorAll('.pbe9-pos[data-pos]').forEach(button => button.addEventListener('click', () => {
      state.pos = button.dataset.pos || 'all';
      paint();
    }));
    wireMembers();
  }

  function wireMembers() {
    document.querySelectorAll('.pbe9-member[data-player]').forEach(el => el.addEventListener('click', () => {
      try {
        if (window.PlayerModal) PlayerModal.show(el.dataset.player);
      } catch (_) {}
    }));
  }

  function render() {
    return load();
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.hof = render;
    return true;
  }

  window.PBEHofV2 = { render, load, state, filtered };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
