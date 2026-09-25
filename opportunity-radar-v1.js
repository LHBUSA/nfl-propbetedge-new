/* PropBetEdge NFL — OPPORTUNITY RADAR v1
 *
 * Sole registrant of the `usage` route (old #usage links keep working; the
 * app-core alias map also sends #opportunity here). It replaces Usage
 * Research v3, whose 2025 archive renderer is no longer loaded — two
 * renderers never compete for one route.
 *
 * Data: /api/opportunity (pbe-opportunity/v1, built by nfl-replay from the
 * nflverse play-by-play). Every number on screen is a count with its team
 * denominator, or a share computed from them upstream. Labels and insight
 * sentences are the contract's own deterministic output; this file never
 * writes a sentence about a player the contract did not. No snap share, no
 * route data: the contract declares them unsupported and so does the UI.
 *
 * Identity: players are keyed by nflverse gsis id with the ESPN id the
 * contract resolved. Names, positions and photos come from the Player DNA
 * index (/api/{qb,wr,rb,te}-dna?list=1) by gsis id — never by name. A player
 * outside that index keeps the play-by-play short name and no position.
 *
 * Also publishes, for other surfaces:
 *   PBEOpportunityRadar.railHtml()     homepage "Role changes" (<= 3, never padded)
 *   PBEOpportunityRadar.forPlayer(id)  one player's row by gsis or ESPN id
 *   PBEPlayerIndex                     gsis/espn -> {name, position, team, headshot}
 */
(() => {
  'use strict';

  const ROUTE = 'usage';
  const PAGE = 24;
  const DNA_ROUTE = { QB: 'qbdna', RB: 'rbdna', WR: 'wrdna', TE: 'tedna' };
  /* nflverse -> the ESPN abbreviations this product displays everywhere else. */
  const DISPLAY_TEAM = { LA: 'LAR', WAS: 'WSH' };
  const NFLVERSE_TEAM = { LAR: 'LA', WSH: 'WAS' };
  const LABEL = {
    EXPANDING: { text: 'Role expanding', cls: 'up', glyph: '▲' },
    DECLINING: { text: 'Role declining', cls: 'down', glyph: '▼' },
    STABLE: { text: 'Stable', cls: 'flat', glyph: '■' },
    INSUFFICIENT_SAMPLE: { text: 'Insufficient sample', cls: 'thin', glyph: '○' }
  };
  const STATE_COPY = {
    READY: 'Ready',
    UPDATING: 'Updating',
    NOT_YET_PUBLISHED: 'Not yet published',
    UNAVAILABLE: 'Temporarily unavailable'
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const teamOut = abbr => DISPLAY_TEAM[abbr] || abbr || '';
  const teamIn = abbr => NFLVERSE_TEAM[String(abbr || '').toUpperCase()] || String(abbr || '').toUpperCase();
  const fmtPct = v => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
  const fmtPp = v => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} pts`);
  const track = (name, params = {}) => { try { window.gtag?.('event', name, { pbe_surface: 'nfl', ...params }); } catch (_) {} };

  /* ------------------------------------------------------------ player index */

  const INDEX_KEY = 'pbe_player_index_v1';
  const playerIndex = { byGsis: new Map(), byEspn: new Map(), loading: null, ready: false };
  function loadPlayerIndex() {
    if (playerIndex.ready) return Promise.resolve(playerIndex);
    if (playerIndex.loading) return playerIndex.loading;
    playerIndex.loading = (async () => {
      let rows = null;
      try {
        const cached = JSON.parse(sessionStorage.getItem(INDEX_KEY) || 'null');
        if (cached && Date.now() - cached.at < 3600000 && Array.isArray(cached.rows)) rows = cached.rows;
      } catch (_) {}
      if (!rows) {
        rows = [];
        await Promise.all(['qb', 'wr', 'rb', 'te'].map(async pos => {
          try {
            const r = await fetch(`/api/${pos}-dna?list=1`, { headers: { accept: 'application/json' } });
            if (!r.ok) return;
            const j = await r.json();
            for (const p of (Array.isArray(j?.players) ? j.players : [])) {
              if (!p?.gsis_id) continue;
              rows.push({ g: p.gsis_id, e: p.espn_id ? String(p.espn_id) : null, n: p.name || '', p: p.position || pos.toUpperCase(), t: p.team_2026 || p.team || '', h: p?.media?.headshot_url || '', a: p.active_2026 === true });
            }
          } catch (_) {}
        }));
        try { if (rows.length) sessionStorage.setItem(INDEX_KEY, JSON.stringify({ at: Date.now(), rows })); } catch (_) {}
      }
      for (const row of rows) {
        const v = { gsis: row.g, espn: row.e, name: row.n, position: row.p, team: row.t, headshot: row.h, active: row.a };
        playerIndex.byGsis.set(row.g, v);
        if (row.e) playerIndex.byEspn.set(row.e, v);
      }
      playerIndex.ready = true;
      return playerIndex;
    })();
    return playerIndex.loading;
  }
  window.PBEPlayerIndex = {
    load: loadPlayerIndex,
    byGsis: id => playerIndex.byGsis.get(String(id || '')) || null,
    byEspn: id => playerIndex.byEspn.get(String(id || '')) || null,
    /* Exactly one indexed player with this full name on one of these teams,
       or null. Used only where a provider names a player by string (Prop
       Board quotes); never by surname, never across other teams. */
    find(name, teams) {
      const want = String(name || '').trim().toLowerCase();
      const on = new Set((teams || []).filter(Boolean).map(t => String(t).toUpperCase()));
      if (!want || !on.size) return null;
      const hits = [...playerIndex.byGsis.values()].filter(p => p.name.toLowerCase() === want && on.has(String(p.team || '').toUpperCase()));
      return hits.length === 1 ? hits[0] : null;
    },
    get ready() { return playerIndex.ready; }
  };

  /* ------------------------------------------------------------------- store */

  const store = { season: null, data: null, state: null, error: null, loadedAt: 0, loading: null };
  const ui = { pos: 'ALL', team: 'ALL', q: '', window: 'latest', label: 'ALL', sort: 'movement', shown: PAGE, distTeam: null };

  function seasonNow() {
    const s = window.PBESeason?.season?.();
    return Number.isInteger(s) ? s : null;
  }
  function waitForSeason(timeout = 6000) {
    const s = seasonNow();
    if (s) return Promise.resolve(s);
    return new Promise(resolve => {
      const done = () => resolve(seasonNow());
      const t = setTimeout(done, timeout);
      window.PBESeason?.onReady?.(() => { clearTimeout(t); done(); });
      window.addEventListener('pbe:season-ready', () => { clearTimeout(t); done(); }, { once: true });
    });
  }

  /* One request per five minutes per tab, shared by the route, the homepage
     rail, My Sunday and Game Script Lab. */
  function load({ force = false } = {}) {
    if (store.loading) return store.loading;
    if (!force && store.data && Date.now() - store.loadedAt < 300000) return Promise.resolve(store);
    store.loading = (async () => {
      try {
        const season = await waitForSeason();
        if (!season) { store.state = 'NOT_YET_PUBLISHED'; store.error = 'season_unknown'; return store; }
        store.season = season;
        const [res] = await Promise.all([
          fetch(`/api/opportunity?season=${season}&view=radar`, { headers: { accept: 'application/json' } }),
          loadPlayerIndex()
        ]);
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) { store.state = 'UNAVAILABLE'; store.error = `http_${res.status}`; return store; }
        if (body.state === 'NOT_YET_PUBLISHED') { store.state = 'NOT_YET_PUBLISHED'; store.data = null; return store; }
        if (body.state !== 'READY' || Number(body.season) !== season) { store.state = 'UNAVAILABLE'; store.error = 'contract_mismatch'; return store; }
        store.data = body;
        store.state = updatingAgainstScoreboard(body) ? 'UPDATING' : 'READY';
        store.error = null;
        store.loadedAt = Date.now();
      } catch (error) {
        store.state = store.data ? store.state : 'UNAVAILABLE';
        store.error = String(error?.message || error);
      } finally {
        store.loading = null;
        window.dispatchEvent(new CustomEvent('pbe:opportunity-ready', { detail: { state: store.state } }));
      }
      return store;
    })();
    return store.loading;
  }

  /* UPDATING: the scoreboard has a final the play-by-play does not have yet.
     nflverse publishes the morning after a game; until then the radar says so
     rather than presenting last week as the latest. */
  function nflverseId(game) {
    if (!game?.away?.abbreviation || !game?.home?.abbreviation || !game.week || !game.season) return null;
    return `${game.season}_${String(game.week).padStart(2, '0')}_${teamIn(game.away.abbreviation)}_${teamIn(game.home.abbreviation)}`;
  }
  function updatingAgainstScoreboard(body) {
    const final = window.PBESeason?.latestFinal?.();
    if (!final || final.season_type !== 'REG' || Number(final.season) !== Number(body.season)) return false;
    const id = nflverseId(final);
    return Boolean(id && Array.isArray(body.coverage?.game_ids) && !body.coverage.game_ids.includes(id));
  }

  /* ------------------------------------------------------------ row helpers */

  function identity(row) {
    const idx = window.PBEPlayerIndex.byGsis(row.gsis) || (row.espn && window.PBEPlayerIndex.byEspn(row.espn)) || null;
    return {
      name: idx?.name || row.name || 'Unknown player',
      short: row.name || '',
      position: idx?.position || '',
      headshot: idx?.headshot || (row.espn && /^\d+$/.test(row.espn) ? `https://a.espncdn.com/i/headshots/nfl/players/full/${row.espn}.png` : ''),
      indexed: Boolean(idx)
    };
  }
  function forPlayer(id) {
    const key = String(id || '');
    return store.data?.players?.find(p => p.gsis === key || p.espn === key) || null;
  }
  function windowOf(row) {
    return ui.window === 'season' ? row.season : ui.window === 'recent' ? row.recent : row.latest;
  }
  function primaryShare(row, w = windowOf(row)) {
    return row.metric === 'carry' ? w?.cs : w?.ts;
  }
  function primaryDelta(row) {
    return row.metric === 'carry' ? row.delta?.cs : row.delta?.ts;
  }

  function faceHtml(row, id, size = 'md') {
    const initials = id.name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
    const img = id.headshot ? `<img src="${esc(id.headshot)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '';
    return `<span class="por-face por-face-${size}" aria-hidden="true"><b>${esc(initials || '·')}</b>${img}</span>`;
  }

  /* A compact per-game share line. Each point is that game's count over that
     game's team total; the dashed rule is the prior-window share. */
  function sparkHtml(row) {
    const metric = row.metric === 'carry' ? ['c', 'tc'] : ['t', 'tt'];
    const pts = (row.series || []).map(s => (s[metric[1]] > 0 ? s[metric[0]] / s[metric[1]] : null));
    const valid = pts.filter(v => v !== null);
    if (valid.length < 2) return `<span class="por-spark por-spark-empty">${valid.length ? '1 game' : 'no games'}</span>`;
    const W = 120, H = 34, pad = 3;
    const max = Math.max(0.2, ...valid) * 1.1;
    const step = (W - pad * 2) / Math.max(1, pts.length - 1);
    const xy = pts.map((v, i) => (v === null ? null : [pad + i * step, H - pad - (v / max) * (H - pad * 2)]));
    const d = xy.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const prior = row.metric === 'carry' ? row.prior?.cs : row.prior?.ts;
    const py = prior === null || prior === undefined ? null : H - pad - ((prior / 100) / max) * (H - pad * 2);
    const label = `${row.metric === 'carry' ? 'Carry' : 'Target'} share by game: ${row.series.map(s => `Week ${s.w} ${s[metric[1]] ? ((s[metric[0]] / s[metric[1]]) * 100).toFixed(1) : '—'}%`).join(', ')}`;
    return `<svg class="por-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${py === null ? '' : `<line x1="${pad}" x2="${W - pad}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" class="por-spark-prior"/>`}<path d="${d}" class="por-spark-line"/>${xy.filter(Boolean).map((p, i, a) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === a.length - 1 ? 2.8 : 1.8}" class="${i === a.length - 1 ? 'por-spark-last' : 'por-spark-dot'}"/>`).join('')}</svg>`;
  }

  function labelChip(label) {
    const L = LABEL[label] || LABEL.INSUFFICIENT_SAMPLE;
    return `<span class="por-label por-label-${L.cls}"><i aria-hidden="true">${L.glyph}</i>${L.text}</span>`;
  }

  function metricCell(title, count, total, share, delta, unit) {
    return `<div class="por-metric"><span class="por-metric-k">${title}</span><b class="por-metric-v">${fmtPct(share)}</b><span class="por-metric-n">${count ?? 0} of ${total ?? 0} ${unit}</span>${delta === undefined ? '' : `<span class="por-metric-d ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${ui.window === 'latest' ? `${fmtPp(delta)} vs prior` : ''}</span>`}</div>`;
  }

  function windowCaption(row) {
    const w = windowOf(row);
    if (ui.window === 'latest') return `${esc(row.latest_label)} ${row.latest_game?.opponent ? `vs ${esc(teamOut(row.latest_game.opponent))}` : ''}`;
    return `${w.games} game${w.games === 1 ? '' : 's'} · weeks ${esc(w.weeks.join(', '))}`;
  }

  function nextGameFor(team) {
    const sched = window.PBESeason?.data?.team_schedule?.[teamOut(team)] || null;
    return sched?.next || null;
  }

  function actionsHtml(row, id) {
    const pos = id.position;
    const acts = [];
    if (DNA_ROUTE[pos]) acts.push(`<button type="button" class="por-act" data-por-dna="${esc(row.gsis)}" data-por-pos="${esc(pos)}">Player DNA</button>`);
    const next = nextGameFor(row.team);
    if (next) acts.push(`<button type="button" class="por-act" data-por-matchup="${esc(teamOut(row.team))}">Matchup</button>`);
    if (next) acts.push(`<button type="button" class="por-act" data-por-props="${esc(teamOut(row.team))}" data-por-name="${esc(id.name)}">Prop Board</button>`);
    if (tdTargetFor(row.gsis)) acts.push('<button type="button" class="por-act" data-por-td="1">TD Targets</button>');
    const save = window.PBEMySunday?.saveButtonHtml?.({
      type: 'player', espn_id: row.espn, gsis_id: row.gsis, team: teamOut(row.team), season: store.data?.season,
      label: id.name, context: { source: 'opportunity_radar', label: row.label, metric: row.metric, latest_share: primaryShare(row, row.latest), data_through: store.data?.data_through?.game_id || null, revision: store.data?.source?.revision || null }
    }) || '';
    return `<div class="por-acts">${acts.join('')}${save}</div>`;
  }

  function tdTargetFor(gsis) {
    const games = window.PBETouchdownTargets?.store?.slate?.games;
    if (!Array.isArray(games)) return null;
    for (const g of games) for (const t of [g.primary, g.secondary]) if (t && String(t.player?.gsis_id || t.player?.player_id || '') === String(gsis)) return t;
    return null;
  }

  function cardHtml(row) {
    const id = identity(row);
    const w = windowOf(row);
    const isLatest = ui.window === 'latest';
    const insights = (row.insights || []).slice(0, 3);
    const notes = row.notes || [];
    return `<article class="por-card" data-por-player="${esc(row.gsis)}">
      <header class="por-card-head">
        ${faceHtml(row, id)}
        <div class="por-who"><strong class="por-name">${esc(id.name)}</strong><span class="por-sub">${esc(teamOut(row.team))}${id.position ? ` · ${esc(id.position)}` : ''}</span></div>
        ${labelChip(row.label)}
      </header>
      <div class="por-headline">
        <div class="por-headline-main"><span class="por-kicker">${row.metric === 'carry' ? 'Carry share' : 'Target share'} · ${windowCaption(row)}</span><b>${fmtPct(primaryShare(row))}</b>${isLatest && primaryDelta(row) !== null && primaryDelta(row) !== undefined ? `<span class="por-delta ${primaryDelta(row) > 0 ? 'up' : primaryDelta(row) < 0 ? 'down' : ''}">${fmtPp(primaryDelta(row))} vs prior ${row.prior?.games || 0}</span>` : ''}</div>
        ${sparkHtml(row)}
      </div>
      <div class="por-metrics">
        ${metricCell('Targets', w.t, w.tt, w.ts, isLatest ? row.delta?.ts : undefined, 'team targets')}
        ${metricCell('Carries', w.c, w.tc, w.cs, isLatest ? row.delta?.cs : undefined, 'designed runs')}
        ${metricCell('Red zone', w.rz, w.trz, w.rs, isLatest ? row.delta?.rs : undefined, 'RZ opps')}
      </div>
      ${insights.length || notes.length ? `<ul class="por-insights">${[...notes, ...insights].map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>` : ''}
      <footer class="por-foot"><span class="por-sample">Sample: ${row.season.games} game${row.season.games === 1 ? '' : 's'} with ${esc(teamOut(row.team))}${row.no_recorded?.length ? ` · ${row.no_recorded.length} team game${row.no_recorded.length === 1 ? '' : 's'} without a recorded target or carry` : ''}</span>${actionsHtml(row, id)}</footer>
    </article>`;
  }

  /* --------------------------------------------------------------- filtering */

  function rows() {
    const all = store.data?.players || [];
    const q = ui.q.trim().toLowerCase();
    let list = all.filter(row => {
      if (ui.team !== 'ALL' && teamOut(row.team) !== ui.team) return false;
      if (ui.label !== 'ALL' && row.label !== ui.label) return false;
      const id = identity(row);
      if (ui.pos !== 'ALL' && id.position !== ui.pos) return false;
      if (q && !id.name.toLowerCase().includes(q) && !String(row.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (ui.sort === 'movement' && ui.window === 'latest') {
      const rank = r => (r.label === 'EXPANDING' || r.label === 'DECLINING' ? 0 : r.label === 'STABLE' ? 1 : 2);
      list = list.slice().sort((a, b) => rank(a) - rank(b) || Math.abs(primaryDelta(b) || 0) - Math.abs(primaryDelta(a) || 0) || volume(b) - volume(a));
    } else if (ui.sort === 'share') {
      list = list.slice().sort((a, b) => (primaryShare(b) || 0) - (primaryShare(a) || 0) || volume(b) - volume(a));
    } else {
      list = list.slice().sort((a, b) => volume(b) - volume(a));
    }
    return list;
  }
  const volume = row => { const w = windowOf(row); return (w?.t || 0) + (w?.c || 0); };

  /* ---------------------------------------------------------------- sections */

  function freshnessHtml() {
    const d = store.data;
    if (!d) return '';
    const through = d.data_through;
    const pub = d.source?.asset_last_modified ? new Date(d.source.asset_last_modified) : null;
    const ing = d.source?.ingested_at ? new Date(d.source.ingested_at) : null;
    const fmt = t => (t && !Number.isNaN(t.getTime()) ? t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }) : '—');
    return `<div class="por-fresh" role="status"><span class="por-state por-state-${esc(String(store.state).toLowerCase())}">${esc(STATE_COPY[store.state] || store.state)}</span><span>Data through <b>${through ? `Week ${through.week}` : '—'}</b> · ${d.coverage?.games_complete ?? 0} games</span><span>Published ${esc(fmt(pub))}</span><span>Checked ${esc(fmt(ing))}</span>${store.state === 'UPDATING' ? '<span class="por-fresh-note">The latest final is not in the play-by-play yet — it publishes the morning after a game.</span>' : ''}</div>`;
  }

  function highlightsHtml() {
    const ids = store.data?.highlights || [];
    const list = ids.map(id => forPlayer(id)).filter(Boolean);
    if (!list.length) return `<section class="por-panel por-highlights"><div class="por-panel-head"><strong>Role changes</strong><span>Latest week</span></div><p class="por-empty">No player in the latest week of play-by-play cleared the movement rules. Nothing is shown to fill the space.</p></section>`;
    return `<section class="por-panel por-highlights"><div class="por-panel-head"><strong>Role changes</strong><span>Latest week · ${list.length} of up to 3</span></div><div class="por-hl-grid">${list.map(row => {
      const id = identity(row);
      const ins = row.insights?.find(i => /_(EXPANDING|DECLINING)$/.test(i.code)) || row.insights?.[0];
      return `<button type="button" class="por-hl" data-por-focus="${esc(row.gsis)}">${faceHtml(row, id, 'sm')}<span class="por-hl-body"><span class="por-hl-top"><b>${esc(id.name)}</b>${labelChip(row.label)}</span><span class="por-hl-text">${esc(ins?.text || '')}</span></span></button>`;
    }).join('')}</div></section>`;
  }

  function controlsHtml() {
    const teams = [...new Set((store.data?.players || []).map(r => teamOut(r.team)))].sort();
    const seg = (name, value, opts) => `<div class="por-seg" role="group" aria-label="${esc(name)}">${opts.map(([v, t]) => `<button type="button" data-por-set="${esc(name)}" data-value="${esc(v)}" aria-pressed="${value === v}">${esc(t)}</button>`).join('')}</div>`;
    return `<div class="por-controls">
      <label class="por-search"><span class="por-sr">Search players</span><input type="search" placeholder="Search players" value="${esc(ui.q)}" data-por-q autocomplete="off"></label>
      ${seg('window', ui.window, [['latest', 'Latest game'], ['recent', 'Recent'], ['season', 'Season']])}
      ${seg('pos', ui.pos, [['ALL', 'All'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']])}
      <label class="por-select"><span>Team</span><select data-por-team><option value="ALL">All teams</option>${teams.map(t => `<option value="${esc(t)}"${ui.team === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="por-select"><span>Movement</span><select data-por-label>${[['ALL', 'All'], ['EXPANDING', 'Role expanding'], ['DECLINING', 'Role declining'], ['STABLE', 'Stable'], ['INSUFFICIENT_SAMPLE', 'Insufficient sample']].map(([v, t]) => `<option value="${v}"${ui.label === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="por-select"><span>Sort</span><select data-por-sort>${[['movement', 'Biggest movement'], ['share', 'Highest share'], ['volume', 'Most opportunities']].map(([v, t]) => `<option value="${v}"${ui.sort === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>`;
  }

  function listHtml() {
    const list = rows();
    if (!list.length) return '<p class="por-empty">No players match these filters.</p>';
    const shown = list.slice(0, ui.shown);
    return `<div class="por-count">${list.length} player${list.length === 1 ? '' : 's'}${ui.window === 'latest' && ui.sort === 'movement' ? ' · sorted by measured movement' : ''}</div><div class="por-grid">${shown.map(cardHtml).join('')}</div>${list.length > shown.length ? `<button type="button" class="por-more" data-por-more>Show ${Math.min(PAGE, list.length - shown.length)} more</button>` : ''}`;
  }

  /* How teammates split the team's targets, carries and red-zone chances,
     season to date. Parts plus the named remainder add back to the total. */
  function distributionHtml() {
    const dist = store.data?.distribution || {};
    const teams = Object.keys(dist).map(teamOut).sort();
    if (!teams.length) return '';
    const sel = ui.distTeam && teams.includes(ui.distTeam) ? ui.distTeam : (ui.team !== 'ALL' ? ui.team : teams[0]);
    const d = dist[teamIn(sel)];
    if (!d) return '';
    const bar = (title, key, total, remainder, remainderLabel) => {
      const people = d.players.filter(p => p[key] > 0).sort((a, b) => b[key] - a[key]);
      const top = people.slice(0, 5);
      const rest = people.slice(5).reduce((s, p) => s + p[key], 0);
      const segs = [...top.map(p => ({ label: window.PBEPlayerIndex.byGsis(p.gsis)?.name || p.name || p.gsis, n: p[key] })), ...(rest ? [{ label: `${people.length - 5} others`, n: rest, other: true }] : []), ...(remainder ? [{ label: remainderLabel, n: remainder, residual: true }] : [])];
      const whole = total + (remainder || 0);
      if (!whole) return `<div class="por-dist-row"><div class="por-dist-title"><strong>${title}</strong><span>none recorded</span></div></div>`;
      return `<div class="por-dist-row"><div class="por-dist-title"><strong>${title}</strong><span>${total} ${title.toLowerCase()}${remainder ? ` + ${remainder} ${esc(remainderLabel.toLowerCase())}` : ''}</span></div><div class="por-dist-bar" role="img" aria-label="${esc(segs.map(s => `${s.label} ${s.n}`).join(', '))}">${segs.map((s, i) => `<i class="${s.residual ? 'res' : s.other ? 'oth' : `c${i}`}" style="flex:${s.n}"></i>`).join('')}</div><ul class="por-dist-legend">${segs.map((s, i) => `<li><i class="${s.residual ? 'res' : s.other ? 'oth' : `c${i}`}"></i>${esc(s.label)} <b>${s.n}</b> <span>${((s.n / whole) * 100).toFixed(1)}%</span></li>`).join('')}</ul></div>`;
    };
    const T = d.totals;
    return `<section class="por-panel por-dist"><div class="por-panel-head"><strong>Team distribution</strong><label class="por-select"><span class="por-sr">Team</span><select data-por-dist>${teams.map(t => `<option value="${esc(t)}"${t === sel ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
      <p class="por-panel-sub">${esc(sel)} · season to date · ${d.games} game${d.games === 1 ? '' : 's'}</p>
      ${bar('Targets', 't', T.targets, T.untargeted_attempts, 'Attempts with no intended receiver')}
      ${bar('Carries', 'c', T.designed_runs - T.unattributed_runs, T.unattributed_runs, 'Runs without a credited carrier')}
      ${bar('Red zone', 'rz', T.rz_targets + T.rz_carries, 0, '')}
      <p class="por-panel-foot">${T.scrambles} quarterback scramble${T.scrambles === 1 ? '' : 's'} and ${T.sacks} sack${T.sacks === 1 ? '' : 's'} are not targets or carries and are shown here only as counts.</p></section>`;
  }

  function methodologyHtml() {
    const d = store.data;
    const def = d?.definitions || {};
    const rules = d?.rules;
    const uns = d?.unsupported || {};
    return `<details class="por-method"><summary>How Opportunity Radar measures roles</summary><div class="por-method-body">
      <dl>${['target', 'target_share', 'carry', 'carry_share', 'red_zone', 'rz_share', 'appearance', 'latest', 'prior', 'recent', 'season'].filter(k => def[k]).map(k => `<dt>${esc(k.replace(/_/g, ' '))}</dt><dd>${esc(def[k])}</dd>`).join('')}</dl>
      ${rules ? `<h4>Movement labels (${esc(rules.version)})</h4><p>The latest appearance is compared with up to ${rules.prior_window} earlier appearances with the same team. <b>Role expanding</b> needs a target-share gain of ${rules.target.delta_pp}+ points on ${rules.target.expand_min_latest}+ targets, or a carry-share gain of ${rules.carry.delta_pp}+ points on ${rules.carry.expand_min_latest}+ carries. <b>Role declining</b> is the same drop from a prior role of ${rules.target.decline_min_prior_per_game}+ targets or ${rules.carry.decline_min_prior_per_game}+ carries per game. <b>Insufficient sample</b>: the latest game had fewer than ${rules.target.min_latest_team} team targets / ${rules.carry.min_latest_team} designed runs, there is no prior appearance with this team, or the player has no recorded target or carry in his team's latest game. Labels describe measured changes; they are not predictions and carry no confidence score.</p>` : ''}
      <h4>Not measured here</h4><ul>${Object.values(uns).map(v => `<li>${esc(v)}</li>`).join('')}</ul>
      <p class="por-source">Source: ${esc(d?.source?.dataset || 'nflverse play-by-play')} (${esc(d?.source?.license || 'CC-BY-4.0')}, ${esc(d?.source?.attribution || 'nflverse')}). Revision ${esc(d?.source?.revision || '—')} · ${esc(d?.version || '')} · ${esc(d?.metric_version || '')}. 2025 and earlier seasons are archived separately and never mixed into these numbers.</p>
    </div></details>`;
  }

  function shellHtml() {
    const s = store.state;
    const hero = `<header class="por-hero"><div><span class="por-eyebrow">Research · ${store.season || ''} season</span><h1 class="por-title">Opportunity Radar</h1><p class="por-lede">Who is gaining or losing targets, carries and red-zone chances — measured from this season's play-by-play, every share shown with its count.</p></div></header>`;
    if (!store.data) {
      const copy = s === 'NOT_YET_PUBLISHED' ? 'No play-by-play has been published for this season yet. It appears the morning after the first games.' : s === 'UNAVAILABLE' ? 'Opportunity data could not be loaded. Nothing is shown in its place. Try again shortly.' : 'Loading this season\'s opportunity data…';
      return `<section class="por-wrap" data-por>${hero}<div class="por-fresh" role="status"><span class="por-state por-state-${esc(String(s || 'loading').toLowerCase())}">${esc(STATE_COPY[s] || 'Loading')}</span></div><p class="por-empty por-empty-lg">${esc(copy)}</p>${s === 'UNAVAILABLE' ? '<button type="button" class="por-more" data-por-retry>Retry</button>' : ''}</section>`;
    }
    return `<section class="por-wrap" data-por>${hero}${freshnessHtml()}${highlightsHtml()}${controlsHtml()}<div data-por-list>${listHtml()}</div>${distributionHtml()}${methodologyHtml()}</section>`;
  }

  /* ------------------------------------------------------------------ render */

  function paint() {
    const vc = document.getElementById('view-container');
    if (!vc || window.App?.current !== ROUTE) return;
    vc.innerHTML = shellHtml();
  }
  function paintList() {
    const host = document.querySelector('[data-por-list]');
    if (host) host.innerHTML = listHtml(); else paint();
  }

  function applyParams() {
    const p = window.App?.params || {};
    if (p.team && /^[A-Za-z]{2,3}$/.test(p.team)) ui.team = String(p.team).toUpperCase();
    if (p.pos && /^(QB|RB|WR|TE)$/i.test(p.pos)) ui.pos = String(p.pos).toUpperCase();
    if (p.player) ui.q = String(p.player).slice(0, 40);
  }

  async function render() {
    applyParams();
    paint();
    const was = store.data;
    await load();
    if (window.App?.current === ROUTE) paint();
    if (store.data && store.data !== was) track('pbe_opportunity_view', { pbe_state: String(store.state || '').toLowerCase() });
  }

  /* One delegated handler for the route; nothing binds per card. */
  function onClick(event) {
    const root = event.target.closest?.('[data-por]');
    if (!root) return;
    const t = event.target.closest('button, [data-por-focus]');
    if (!t) return;
    if (t.dataset.porSet) { ui[t.dataset.porSet] = t.dataset.value; ui.shown = PAGE; paint(); return; }
    if (t.hasAttribute('data-por-more')) { ui.shown += PAGE; paintList(); return; }
    if (t.hasAttribute('data-por-retry')) { load({ force: true }).then(paint); return; }
    if (t.dataset.porFocus) { const row = forPlayer(t.dataset.porFocus); if (row) { ui.q = identity(row).name; ui.team = 'ALL'; ui.pos = 'ALL'; ui.label = 'ALL'; ui.window = 'latest'; paint(); document.querySelector('.por-grid')?.scrollIntoView({ block: 'start' }); } return; }
    if (t.dataset.porDna) { openDna(t.dataset.porDna, t.dataset.porPos); return; }
    if (t.dataset.porMatchup) { openGame(t.dataset.porMatchup, 'matchups'); return; }
    if (t.dataset.porProps) { openGame(t.dataset.porProps, 'propboard'); return; }
    if (t.dataset.porTd) { window.App?.nav('tdtargets'); }
  }
  function onInput(event) {
    const el = event.target;
    if (!el.closest?.('[data-por]')) return;
    if (el.matches('[data-por-q]')) { ui.q = el.value; ui.shown = PAGE; clearTimeout(onInput.t); onInput.t = setTimeout(paintList, 120); }
  }
  function onChange(event) {
    const el = event.target;
    if (!el.closest?.('[data-por]')) return;
    if (el.matches('[data-por-team]')) { ui.team = el.value; ui.shown = PAGE; paint(); }
    else if (el.matches('[data-por-label]')) { ui.label = el.value; ui.shown = PAGE; paint(); }
    else if (el.matches('[data-por-sort]')) { ui.sort = el.value; ui.shown = PAGE; paintList(); }
    else if (el.matches('[data-por-dist]')) { ui.distTeam = el.value; paint(); }
  }

  function openDna(gsis, position) {
    const route = DNA_ROUTE[String(position || '').toUpperCase()];
    if (!route) return;
    try { sessionStorage.setItem('pbe.playerdna.focus', JSON.stringify({ route, player_id: String(gsis), event_id: null, source: 'opportunity' })); } catch (_) {}
    window.App?.nav(route);
  }

  /* Matchup and Prop Board key on the odds provider's event id. The team's next
     game comes from the season contract; the provider event is found by the
     two teams it names. If none matches, the route opens on its own default. */
  function openGame(team, route) {
    const next = nextGameFor(teamIn(team));
    const events = window.PBEEventSelector?.state?.events || [];
    const T = window.NFL_TEAMS || {};
    const nameOf = abbr => String((T[abbr] || T[abbr === 'WSH' ? 'WAS' : abbr === 'WAS' ? 'WSH' : abbr] || {}).name || '').toLowerCase();
    if (next) {
      const want = [nameOf(next.away?.abbreviation), nameOf(next.home?.abbreviation)].filter(Boolean);
      const hit = events.find(e => want.length === 2 && want.includes(String(e.away_team || '').toLowerCase()) && want.includes(String(e.home_team || '').toLowerCase()));
      if (hit?.id) {
        try { localStorage.setItem('pbe_nfl_event', hit.id); } catch (_) {}
        window.dispatchEvent(new CustomEvent('pbe:event-changed', { detail: { eventId: hit.id, event: hit, reason: 'opportunity-radar' } }));
      }
    }
    window.App?.nav(route);
  }

  /* --------------------------------------------------------- homepage rail */

  let railRequested = false;
  function railHtml() {
    if (!store.data && !store.loading && !railRequested) { railRequested = true; load(); }
    if (!store.data) return '';
    const list = (store.data.highlights || []).map(forPlayer).filter(Boolean);
    if (!list.length) return '';
    return `<section class="por-rail" data-por-rail><div class="por-rail-head"><strong>Role changes</strong><span>Opportunity Radar · Week ${esc(store.data.data_through?.week ?? '')}</span></div>${list.map(row => {
      const id = identity(row);
      const ins = row.insights?.find(i => /_(EXPANDING|DECLINING)$/.test(i.code));
      return `<button type="button" class="por-rail-row" data-route="usage" data-por-rail-player="${esc(row.gsis)}">${faceHtml(row, id, 'sm')}<span class="por-rail-body"><span class="por-rail-top"><b>${esc(id.name)}</b><span class="por-sub">${esc(teamOut(row.team))}${id.position ? ` · ${esc(id.position)}` : ''}</span>${labelChip(row.label)}</span><span class="por-rail-text">${esc(ins?.text || '')}</span></span></button>`;
    }).join('')}<button type="button" class="por-rail-all" data-route="usage">Open Opportunity Radar →</button></section>`;
  }
  /* A rail row opens the radar focused on that player. The command center's
     own [data-route] handler performs the navigation. */
  document.addEventListener('click', event => {
    const row = event.target.closest?.('[data-por-rail-player]');
    if (!row) return;
    const p = forPlayer(row.dataset.porRailPlayer);
    if (p) { ui.q = identity(p).name; ui.team = 'ALL'; ui.pos = 'ALL'; ui.label = 'ALL'; ui.window = 'latest'; }
  }, true);

  /* ----------------------------------------------------------------- install */

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  window.addEventListener('pbe:mysunday-changed', () => { if (window.App?.current === ROUTE && store.data) paintList(); });
  window.addEventListener('pbe:td-targets-ready', () => { if (window.App?.current === ROUTE && store.data) paintList(); });

  function install() { if (!window.App?.VIEWS) return false; window.App.VIEWS[ROUTE] = render; return true; }
  /* Open the radar on one player (My Sunday, rails). */
  function focusPlayer(id) {
    const row = forPlayer(id);
    const name = row ? identity(row).name : window.PBEPlayerIndex.byGsis(id)?.name || window.PBEPlayerIndex.byEspn(id)?.name || '';
    Object.assign(ui, { q: name, team: 'ALL', pos: 'ALL', label: 'ALL', window: 'latest', shown: PAGE });
    window.App?.nav(ROUTE);
  }
  window.PBEOpportunityRadar = { version: 1, route: ROUTE, store, load, render, railHtml, forPlayer, identity, teamOut, teamIn, nextGameFor, openDna, openGame, focusPlayer };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
})();
