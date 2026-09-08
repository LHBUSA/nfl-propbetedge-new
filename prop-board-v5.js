/* PropBetEdge NFL — Prop Board v5
 *
 * The ONE presentation authority for the #propboard route.
 *
 *   data truth ........ PBEPropBoardV3.load()   (provider snapshot + server-gated PBE model)
 *   presentation ...... this file, one deterministic paint from that state
 *   styling ........... prop-board-v5.css, on pbe-tokens.css / pbe-system.css
 *
 * Nothing here mutates another renderer's DOM, observes the document, or
 * invents a value. Sportsbook quotes are sportsbook quotes; PBE fair line,
 * probability and gap are separate model outputs and are shown only where
 * the model published them. The cross-book distribution in a row's detail
 * is the CURRENT snapshot, never historical line movement.
 *
 * Layout: ≥1024px a seven-column scan table; 761–1023px two-column cards;
 * ≤760px one card per prop. Row detail (all book quotes, distribution,
 * model, metadata) expands inline.
 */
(() => {
  'use strict';

  const VERSION = 'v5.0.0';
  /* Same keys as the retired v4 layer so existing pins and settings survive. */
  const SETTINGS_KEY = 'pbe_propboard_v4_settings';
  const PIN_PREFIX = 'pbe_propboard_v4_pins_';
  const ROSTER_KEY = 'pbe_propboard_roster_v1';
  const DEFAULT_THRESHOLD = 15;
  const TABLE_MIN = 1024;
  const CARD_TWO_COL_MIN = 761;

  const v3 = () => window.PBEPropBoardV3 || null;
  const data = () => v3()?.state || null;
  const H = () => v3()?.helpers || {};
  const isPro = () => Boolean(window.PBEPro?.state?.pro);

  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : NaN; };
  const fmt = (value, digits = 1) => { const n = num(value); return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0$/, '') : '—'; };
  const odds = value => { const n = num(value); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—'; };
  const signed = value => { const n = num(value); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${fmt(n, 1)}` : '—'; };
  const age = value => {
    if (!value) return 'unknown';
    const d = new Date(value); if (Number.isNaN(d.getTime())) return String(value);
    const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return `${s}s ago`; const m = Math.round(s / 60); if (m < 60) return `${m}m ago`; return `${Math.round(m / 60)}h ago`;
  };
  const kickoff = value => { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const shortDate = value => { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

  /* ------------------------------------------------------------ ui state */
  const ui = {
    market: 'all',          // 'all' | family | market key
    search: '',
    book: '',
    sort: 'default',
    more: false,
    expanded: new Set(),
    loading: false,
    error: null,
    layout: null,           // 'table' | 'cards2' | 'cards1'
    deepLinkDone: '',
    roster: null,           // Map(lowercase name → {team, position})
  };

  function readJson(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? fallback : v; } catch (_) { return fallback; } }
  function settings() {
    const saved = readJson(SETTINGS_KEY, {});
    return { modeledOnly: saved.edgeOnly === true, pinnedOnly: saved.pinnedOnly === true, threshold: Number.isFinite(Number(saved.threshold)) ? Math.max(0, Number(saved.threshold)) : DEFAULT_THRESHOLD };
  }
  function saveSettings(patch) { const cur = readJson(SETTINGS_KEY, {}); const next = { ...cur, ...patch }; if ('modeledOnly' in patch) { next.edgeOnly = patch.modeledOnly; delete next.modeledOnly; } localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); }
  const eventId = () => String(data()?.eventId || localStorage.getItem('pbe_nfl_event') || 'default');
  function pins() { const saved = readJson(`${PIN_PREFIX}${eventId()}`, []); return new Set(Array.isArray(saved) ? saved.map(String) : []); }
  function savePins(set) { localStorage.setItem(`${PIN_PREFIX}${eventId()}`, JSON.stringify([...set])); }

  /* ------------------------------------------------ roster (team · pos) */
  /* Team and position come from the Player DNA index (real roster data,
     already served by this product). Best effort: a player outside the four
     DNA indexes simply shows no team line. Nothing is guessed. */
  async function loadRoster() {
    if (ui.roster) return ui.roster;
    try {
      const cached = JSON.parse(sessionStorage.getItem(ROSTER_KEY) || 'null');
      if (cached && Date.now() - cached.at < 3600000) { ui.roster = new Map(Object.entries(cached.map)); return ui.roster; }
    } catch (_) {}
    const map = {};
    await Promise.all(['qb', 'wr', 'rb', 'te'].map(async pos => {
      try {
        const r = await fetch(`/api/${pos}-dna?list=1`, { headers: { accept: 'application/json' } });
        if (!r.ok) return;
        const j = await r.json();
        for (const p of (Array.isArray(j?.players) ? j.players : [])) {
          const name = String(p?.name || '').trim().toLowerCase(); if (!name) continue;
          map[name] = { team: p.team_2026 || p.team || '', position: p.position || pos.toUpperCase() };
        }
      } catch (_) {}
    }));
    ui.roster = new Map(Object.entries(map));
    try { sessionStorage.setItem(ROSTER_KEY, JSON.stringify({ at: Date.now(), map })); } catch (_) {}
    return ui.roster;
  }
  const identity = name => ui.roster?.get(String(name || '').trim().toLowerCase()) || null;

  /* ------------------------------------------------------- row reading */
  const meta = market => (v3()?.marketMeta || (m => ({ label: m, family: 'other', short: m })))(market);
  const gapOf = row => H().modelGap ? H().modelGap(row) : NaN;
  const fairOf = row => H().modelFair ? H().modelFair(row) : NaN;
  const probOf = row => { let p = H().modelProb ? H().modelProb(row) : NaN; if (Number.isFinite(p) && p >= 0 && p <= 1) p *= 100; return p; };
  const pointOf = q => H().pointOf ? H().pointOf(q) : num(q?.point ?? q?.line);
  const priceOf = q => H().priceOf ? H().priceOf(q) : num(q?.price);
  const bookOf = q => (H().bookOf ? H().bookOf(q) : (q?.book || '')) || '';
  const sideOf = q => H().sideOf ? H().sideOf(q) : String(q?.direction || '').toUpperCase();
  const updatedOf = q => H().updatedOf ? H().updatedOf(q) : (q?.last_update || null);
  const modeled = row => Boolean(row?.model) && isPro();

  /* Status is one word the reader can trust. */
  function status(row) {
    if (modeled(row)) return { key: 'modeled', label: String(row.model.decision_status || 'MODELED').replace(/_/g, ' ').toUpperCase() };
    if (isPro()) return { key: 'market', label: 'MARKET ONLY' };
    return { key: 'market', label: 'MARKET' };
  }
  /* Sportsbook identity marks: the same short codes Market Watch uses,
     matched by regex on the provider's book title. Text only: the repo holds
     no sportsbook logo assets and none are invented here. */
  const BOOK_CODES = [[/draftkings/i, 'DK'], [/fanduel/i, 'FD'], [/betmgm|mgm/i, 'MGM'], [/caesars/i, 'CZR'], [/betrivers|bet rivers/i, 'BR'], [/bet365/i, '365'], [/fanatics/i, 'FAN'], [/espn\s*bet/i, 'ESPN'], [/hard\s*rock/i, 'HR'], [/bally/i, 'BLY'], [/bovada/i, 'BOV'], [/betonline/i, 'BOL'], [/betus/i, 'BUS'], [/mybookie/i, 'MB'], [/fliff/i, 'FLF'], [/lowvig/i, 'LV'], [/betanysports/i, 'BAS']];
  function bookMark(name) { const n = String(name || ''); for (const [re, code] of BOOK_CODES) if (re.test(n)) return code; const w = n.replace(/[^a-z0-9 ]/gi, '').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : String(w[0] || '??').slice(0, 2)).toUpperCase(); }

  /* ------------------------------------------------------------ filters */
  function rows() { return Array.isArray(data()?.rows) ? data().rows : []; }
  function visibleRows() {
    const cfg = settings(); const pinned = pins(); const q = ui.search.trim().toLowerCase();
    let list = rows().filter(row => {
      const m = meta(row.market);
      const marketOk = ui.market === 'all' || row.family === ui.market || row.market === ui.market;
      const searchOk = !q || row.player.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
      const bookOk = !ui.book || row.books.includes(ui.book);
      const modeledOk = !(isPro() && cfg.modeledOnly) || Boolean(row.model) || pinned.has(String(row.key));
      const pinnedOk = !cfg.pinnedOnly || pinned.has(String(row.key));
      return marketOk && searchOk && bookOk && modeledOk && pinnedOk;
    });
    const byDefault = (a, b) => (Boolean(a.model) !== Boolean(b.model) ? (a.model ? -1 : 1) : a.family !== b.family ? a.family.localeCompare(b.family) : a.market !== b.market ? a.market.localeCompare(b.market) : a.player.localeCompare(b.player));
    if (ui.sort === 'player') list.sort((a, b) => a.player.localeCompare(b.player));
    else if (ui.sort === 'line') list.sort((a, b) => (num(b.consensus) || 0) - (num(a.consensus) || 0));
    else if (ui.sort === 'books') list.sort((a, b) => b.bookCount - a.bookCount || a.player.localeCompare(b.player));
    else if (ui.sort === 'edge' && isPro()) list.sort((a, b) => (Math.abs(gapOf(b)) || 0) - (Math.abs(gapOf(a)) || 0));
    else { list.sort(byDefault); list = [...list.filter(r => pinned.has(String(r.key))), ...list.filter(r => !pinned.has(String(r.key)))]; }
    return list;
  }

  /* ------------------------------------------------------------- markup */
  function headerHtml() {
    const d = data(); const b = d?.board || {}; const ev = b.event || {};
    const away = ev.away_team || ev.away || 'Away', home = ev.home_team || ev.home || 'Home';
    const updated = b.captured_at_et || shortDate(b.captured_at || b.provider_last_update) || '—';
    const stale = b.ingest?.status === 'LATEST_INGEST_UNAVAILABLE';
    const missing = Array.isArray(d?.missingMarkets) ? d.missingMarkets : [];
    return `<header class="pbe5-head">
      <div class="pbe5-head-id"><h1>Prop Board</h1><p>NFL player prop markets across sportsbooks<span class="pbe5-head-ev"> · <b>${esc(away)} @ ${esc(home)}</b>${kickoff(ev.commence_time) ? ` · ${esc(kickoff(ev.commence_time))}` : ''}</span></p></div>
      <div class="pbe5-head-tools">
        <div class="pbe5-updated ${stale ? 'is-stale' : ''}"><span>${stale ? 'LAST VERIFIED MARKET' : 'LAST UPDATED'}</span><b>${esc(updated)}</b>${stale ? '<i>LATEST INGEST UNAVAILABLE</i>' : ''}${missing.length ? `<i>PARTIAL · ${esc(missing.map(m => meta(m).short).join(', '))} unavailable</i>` : ''}</div>
        <button type="button" class="pbe5-btn" data-pbe5="refresh" title="Re-read the current market snapshot">Refresh</button>
      </div>
    </header>`;
  }

  function filtersHtml() {
    const cfg = settings(); const pro = isPro();
    const books = [...new Set(rows().flatMap(r => r.books))].sort();
    const families = [['all', 'All markets'], ['passing', 'Passing'], ['receiving', 'Receiving'], ['rushing', 'Rushing'], ['td', 'Touchdowns']];
    const markets = (v3()?.MARKETS || []).map(m => [m, meta(m).label]);
    const d = data(); const ev = d?.board?.event || {};
    const evLabel = ev.away_team && ev.home_team ? `${esc(ev.away_team.split(' ').pop())} @ ${esc(ev.home_team.split(' ').pop())}` : 'Select game';
    const pinCount = pins().size;
    return `<section class="pbe5-filters" aria-label="Prop Board filters">
      <button type="button" class="pbe5-filter pbe5-event" data-pbe5="event" title="Change the game"><span>Game</span><b>${evLabel}</b></button>
      <label class="pbe5-filter"><span>Market</span><select data-pbe5-market>${families.map(([k, l]) => `<option value="${k}" ${ui.market === k ? 'selected' : ''}>${l}</option>`).join('')}<optgroup label="Specific market">${markets.map(([k, l]) => `<option value="${k}" ${ui.market === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup></select></label>
      <label class="pbe5-filter pbe5-search"><span>Player</span><input type="search" data-pbe5-search placeholder="Search player or prop" value="${esc(ui.search)}" autocomplete="off"></label>
      <label class="pbe5-filter"><span>Sportsbook</span><select data-pbe5-book><option value="">All books</option>${books.map(bk => `<option value="${esc(bk)}" ${ui.book === bk ? 'selected' : ''}>${esc(bk)}</option>`).join('')}</select></label>
      <button type="button" class="pbe5-toggle ${pro && cfg.modeledOnly ? 'on' : ''}" data-pbe5="modeled" aria-pressed="${pro && cfg.modeledOnly ? 'true' : 'false'}" ${pro ? '' : 'disabled title="Modeled-only view is part of NFL Pro"'}><i></i>Modeled only</button>
      <button type="button" class="pbe5-toggle pbe5-more ${ui.more || cfg.pinnedOnly ? 'on' : ''}" data-pbe5="more" aria-expanded="${ui.more ? 'true' : 'false'}">More filters${cfg.pinnedOnly ? ' · pinned' : ''}</button>
      ${ui.more ? `<div class="pbe5-more-panel">
        <label class="pbe5-filter"><span>Sort</span><select data-pbe5-sort><option value="default" ${ui.sort === 'default' ? 'selected' : ''}>Board order</option><option value="player" ${ui.sort === 'player' ? 'selected' : ''}>Player A–Z</option><option value="line" ${ui.sort === 'line' ? 'selected' : ''}>Highest line</option><option value="books" ${ui.sort === 'books' ? 'selected' : ''}>Most books</option>${pro ? `<option value="edge" ${ui.sort === 'edge' ? 'selected' : ''}>Largest edge</option>` : ''}</select></label>
        <button type="button" class="pbe5-toggle ${cfg.pinnedOnly ? 'on' : ''}" data-pbe5="pinned" aria-pressed="${cfg.pinnedOnly ? 'true' : 'false'}"><i></i>Pinned only <b>${pinCount}</b></button>
        <label class="pbe5-filter pbe5-threshold ${pro ? '' : 'is-off'}"><span>Edge alert ≥</span><input type="number" data-pbe5-threshold min="0" max="100" step="1" value="${esc(cfg.threshold)}" ${pro ? '' : 'disabled'}></label>
        <small>Pins, sort and the edge alert threshold are stored in this browser only.</small>
      </div>` : ''}
    </section>`;
  }

  function signalHtml() {
    const all = rows();
    if (!isPro()) {
      return `<section class="pbe5-signal pbe5-signal-locked"><div><b>Unlock PBE model</b><span>Fair line · probability · model gap</span></div><button type="button" class="pbe5-btn gold" onclick="PBEPro.open('upgrade')">Unlock NFL Pro</button></section>`;
    }
    const modeledRows = all.filter(r => r.model && Number.isFinite(gapOf(r))).sort((a, b) => Math.abs(gapOf(b)) - Math.abs(gapOf(a)));
    const top = modeledRows[0];
    const books = new Set(all.flatMap(r => r.books)).size;
    const live = (v3()?.MARKETS || []).length - (data()?.missingMarkets?.length || 0);
    const alerts = modeledRows.filter(r => Math.abs(gapOf(r)) >= settings().threshold).length;
    return `<section class="pbe5-signal" aria-label="Signal summary">
      <div><span>Modeled props</span><b>${modeledRows.length}</b></div>
      <div class="pbe5-signal-top" ${top ? `data-pbe5-open="${esc(top.key)}" role="button" tabindex="0"` : ''}><span>Top gap</span><b>${top ? `${esc(top.player)} <em class="${gapOf(top) >= 0 ? 'pos' : 'neg'}">${esc(signed(gapOf(top)))}</em>` : '—'}</b></div>
      <div><span>Active books</span><b>${books}</b></div>
      <div><span>Markets live</span><b>${live}/${(v3()?.MARKETS || []).length}</b></div>
      <div><span>Edge alerts ≥ ${esc(fmt(settings().threshold, 0))}</span><b>${alerts}</b></div>
    </section>`;
  }

  function quoteHtml(q, side) {
    if (!q) return `<div class="pbe5-quote is-empty"><b>—</b><small>No ${side.toLowerCase()} quote</small></div>`;
    const book = bookOf(q) || 'Book';
    return `<div class="pbe5-quote"><b>${esc(fmt(pointOf(q), 1))}</b><em>${esc(odds(priceOf(q)))}</em><small><i class="pbe5-mark" aria-hidden="true">${esc(bookMark(book))}</i>${esc(book)}</small></div>`;
  }
  function modelCells(row) {
    if (!isPro()) return `<td class="pbe5-td-fair"><span class="pbe5-gated" title="PBE fair line is part of NFL Pro">—</span></td><td class="pbe5-td-edge"><span class="pbe5-gated" title="PBE model gap is part of NFL Pro">—</span></td>`;
    if (!row.model) return `<td class="pbe5-td-fair"><span class="pbe5-none" title="No production model output for this prop. Nothing is substituted.">—</span></td><td class="pbe5-td-edge"><span class="pbe5-none">—</span></td>`;
    const gap = gapOf(row);
    return `<td class="pbe5-td-fair"><b class="pbe5-fair">${esc(fmt(fairOf(row), 1))}</b></td><td class="pbe5-td-edge">${Number.isFinite(gap) ? `<b class="pbe5-edge ${gap >= 0 ? 'pos' : 'neg'} ${Math.abs(gap) >= settings().threshold ? 'alert' : ''}">${esc(signed(gap))}</b>` : '<span class="pbe5-none">—</span>'}</td>`;
  }
  function playerCell(row, pinned) {
    const id = identity(row.player); const m = meta(row.market);
    return `<div class="pbe5-player">
      <button type="button" class="pbe5-pin ${pinned ? 'on' : ''}" data-pbe5-pin="${esc(row.key)}" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(row.player)} ${esc(m.label)}">${pinned ? '★' : '☆'}</button>
      <div><a href="javascript:void(0)" class="pbe5-name" data-pbe5-player="${esc(row.player)}">${esc(row.player)}</a><small>${id ? `${esc(id.team)} · ${esc(id.position)} · ` : ''}${esc(m.label)}</small></div>
    </div>`;
  }

  function tableRowHtml(row, pinned) {
    const st = status(row); const open = ui.expanded.has(row.key);
    return `<tr class="pbe5-row ${open ? 'is-open' : ''} ${pinned ? 'is-pinned' : ''}" data-pbe5-row="${esc(row.key)}" aria-expanded="${open ? 'true' : 'false'}">
      <td class="pbe5-td-player">${playerCell(row, pinned)}</td>
      <td class="pbe5-td-cons"><b class="pbe5-cons">${esc(fmt(row.consensus, 1))}</b><small>${row.bookCount} book${row.bookCount === 1 ? '' : 's'}</small></td>
      <td class="pbe5-td-over">${quoteHtml(row.bestOver, 'Over')}</td>
      <td class="pbe5-td-under">${quoteHtml(row.bestUnder, 'Under')}</td>
      ${modelCells(row)}
      <td class="pbe5-td-status"><span class="pbe5-status ${st.key}">${esc(st.label)}</span><i class="pbe5-chev" aria-hidden="true"></i></td>
    </tr>${open ? `<tr class="pbe5-detail-row"><td colspan="7">${detailHtml(row)}</td></tr>` : ''}`;
  }

  function cardHtml(row, pinned) {
    const st = status(row); const open = ui.expanded.has(row.key); const gap = gapOf(row);
    const model = !isPro() ? `<div><span>PBE fair</span><b class="pbe5-gated">—</b></div><div><span>Edge</span><b class="pbe5-gated">—</b></div>`
      : !row.model ? `<div><span>PBE fair</span><b class="pbe5-none">—</b></div><div><span>Edge</span><b class="pbe5-none">—</b></div>`
      : `<div><span>PBE fair</span><b class="pbe5-fair">${esc(fmt(fairOf(row), 1))}</b></div><div><span>Edge</span><b class="pbe5-edge ${gap >= 0 ? 'pos' : 'neg'}">${esc(signed(gap))}</b></div>`;
    return `<article class="pbe5-card ${open ? 'is-open' : ''} ${pinned ? 'is-pinned' : ''}" data-pbe5-row="${esc(row.key)}" aria-expanded="${open ? 'true' : 'false'}">
      <header>${playerCell(row, pinned)}<span class="pbe5-status ${st.key}">${esc(st.label)}</span></header>
      <div class="pbe5-card-cons"><span>Consensus</span><b>${esc(fmt(row.consensus, 1))}</b><small>${row.bookCount} book${row.bookCount === 1 ? '' : 's'}</small></div>
      <div class="pbe5-card-quotes"><div><span>Best over</span>${quoteHtml(row.bestOver, 'Over')}</div><div><span>Best under</span>${quoteHtml(row.bestUnder, 'Under')}</div></div>
      <div class="pbe5-card-model">${model}</div>
      <button type="button" class="pbe5-card-open" data-pbe5-toggle="${esc(row.key)}">${open ? 'Hide details' : 'View all books / details'}</button>
      ${open ? detailHtml(row) : ''}
    </article>`;
  }

  function detailHtml(row) {
    const b = data()?.board || {};
    const byBook = new Map();
    for (const q of row.quotes) { const k = bookOf(q) || 'Book'; if (!byBook.has(k)) byBook.set(k, { book: k, over: null, under: null, updated: null }); const e = byBook.get(k); const s = sideOf(q); if (s === 'OVER' && (!e.over || priceOf(q) > priceOf(e.over))) e.over = q; if (s === 'UNDER' && (!e.under || priceOf(q) > priceOf(e.under))) e.under = q; const u = updatedOf(q); if (u && (!e.updated || u > e.updated)) e.updated = u; }
    const books = [...byBook.values()].sort((x, y) => x.book.localeCompare(y.book));
    const bestO = row.bestOver ? bookOf(row.bestOver) : null, bestU = row.bestUnder ? bookOf(row.bestUnder) : null;
    const lines = row.quotes.map(pointOf).filter(Number.isFinite);
    const lo = lines.length ? Math.min(...lines) : NaN, hi = lines.length ? Math.max(...lines) : NaN, span = hi - lo;
    const dist = lines.length >= 2 ? `<div class="pbe5-dist"><div class="pbe5-dist-track">${row.quotes.filter(q => Number.isFinite(pointOf(q))).slice(0, 24).map(q => `<i style="left:${(span > 0 ? ((pointOf(q) - lo) / span) * 100 : 50).toFixed(1)}%" title="${esc(bookOf(q))} · ${esc(sideOf(q))} ${esc(fmt(pointOf(q), 1))} ${esc(odds(priceOf(q)))}"></i>`).join('')}${Number.isFinite(row.consensus) && span > 0 ? `<b style="left:${(((row.consensus - lo) / span) * 100).toFixed(1)}%" title="Consensus ${esc(fmt(row.consensus, 1))}"></b>` : ''}</div><div class="pbe5-dist-scale"><span>${esc(fmt(lo, 1))}</span><span>consensus ${esc(fmt(row.consensus, 1))}</span><span>${esc(fmt(hi, 1))}</span></div></div>` : `<p class="pbe5-muted">${lines.length ? 'One line across books.' : 'Binary market — no line range.'}</p>`;
    const model = !isPro() ? `<div class="pbe5-detail-lock"><b>Unlock PBE model</b><span>Fair line · probability · model gap for supported props. Sportsbook quotes stay visible either way.</span><button type="button" class="pbe5-btn gold" onclick="PBEPro.open('upgrade')">Unlock NFL Pro</button></div>`
      : !row.model ? `<p class="pbe5-muted">No production model output for this prop. The model publishes only where its inputs and market are supported; nothing is substituted.</p>`
      : `<dl class="pbe5-kv"><div><dt>PBE fair line</dt><dd class="pbe5-fair">${esc(fmt(fairOf(row), 1))}</dd></div><div><dt>PBE over probability</dt><dd>${Number.isFinite(probOf(row)) ? esc(fmt(probOf(row), 1)) + '%' : '—'}</dd></div><div><dt>Model gap</dt><dd class="pbe5-edge ${gapOf(row) >= 0 ? 'pos' : 'neg'}">${esc(signed(gapOf(row)))}</dd></div><div><dt>Status</dt><dd>${esc(String(row.model.decision_status || row.model.confidence || 'MODELED').replace(/_/g, ' '))}</dd></div>${Array.isArray(row.model.missing_inputs) && row.model.missing_inputs.length ? `<div><dt>Missing inputs</dt><dd>${esc(row.model.missing_inputs.join(', '))}</dd></div>` : ''}</dl><p class="pbe5-muted">Model output is PBE analysis, not a sportsbook quote and not a guarantee.</p>`;
    return `<div class="pbe5-detail">
      <section><h3>All current book quotes <small>${books.length} book${books.length === 1 ? '' : 's'}</small></h3>
        <table class="pbe5-quotes"><thead><tr><th>Book</th><th>Over</th><th>Under</th><th>Updated</th></tr></thead><tbody>${books.map(e => `<tr><td><i class="pbe5-mark" aria-hidden="true">${esc(bookMark(e.book))}</i>${esc(e.book)}</td><td class="${e.book === bestO ? 'is-best' : ''}">${e.over ? `<b>${esc(fmt(pointOf(e.over), 1))}</b> <em>${esc(odds(priceOf(e.over)))}</em>` : '<span class="pbe5-none">—</span>'}</td><td class="${e.book === bestU ? 'is-best' : ''}">${e.under ? `<b>${esc(fmt(pointOf(e.under), 1))}</b> <em>${esc(odds(priceOf(e.under)))}</em>` : '<span class="pbe5-none">—</span>'}</td><td><small>${esc(age(e.updated))}</small></td></tr>`).join('') || '<tr><td colspan="4"><span class="pbe5-muted">The provider returned a summary without individual book quotes.</span></td></tr>'}</tbody></table>
      </section>
      <section><h3>Cross-book distribution <small>CURRENT SNAPSHOT · NOT HISTORICAL MOVEMENT</small></h3>${dist}</section>
      <section><h3>PBE model</h3>${model}</section>
      <section><h3>Market metadata</h3><dl class="pbe5-kv"><div><dt>Books quoting</dt><dd>${row.bookCount}</dd></div><div><dt>Status</dt><dd>${esc(status(row).label)}</dd></div><div><dt>Row updated</dt><dd>${esc(age(row.updated))}</dd></div><div><dt>Snapshot captured</dt><dd>${esc(b.captured_at_et || shortDate(b.captured_at) || '—')}</dd></div><div><dt>Provider freshness</dt><dd>${esc(age(b.provider_last_update))}</dd></div><div><dt>Source</dt><dd>${esc(String(b.source?.semantics || 'UNAVAILABLE').replace(/_/g, ' '))}</dd></div></dl></section>
    </div>`;
  }

  function boardHtml() {
    const list = visibleRows(); const pinned = pins();
    if (!list.length) return `<div class="pbe5-empty"><b>No props match these filters.</b><span>Clear the search, market or sportsbook filter to see the full board.</span></div>`;
    if (ui.layout === 'table') {
      const pro = isPro();
      return `<div class="pbe5-table-wrap"><table class="pbe5-table"><thead><tr><th>Player / prop</th><th>Consensus</th><th>Best over</th><th>Best under</th><th class="${pro ? '' : 'is-gated'}">PBE fair${pro ? '' : ' <i>PRO</i>'}</th><th class="${pro ? '' : 'is-gated'}">Edge${pro ? '' : ' <i>PRO</i>'}</th><th>Status</th></tr></thead><tbody>${list.map(r => tableRowHtml(r, pinned.has(String(r.key)))).join('')}</tbody></table></div>`;
    }
    return `<div class="pbe5-cards ${ui.layout === 'cards2' ? 'two' : ''}">${list.map(r => cardHtml(r, pinned.has(String(r.key)))).join('')}</div>`;
  }

  function footHtml() {
    const list = visibleRows();
    return `<footer class="pbe5-foot"><span>${list.length} of ${rows().length} props</span><span>Sportsbook quotes are provider quotes. PBE fair line, probability and gap are separate model outputs.</span></footer>`;
  }

  function shellHtml() { return `<section class="pbe5" data-pbe5="${VERSION}" data-pbe-pro="${isPro() ? '1' : '0'}">${headerHtml()}${filtersHtml()}${signalHtml()}<div class="pbe5-board" id="pbe5-board">${boardHtml()}</div>${footHtml()}</section>`; }
  function loadingHtml() { return `<section class="pbe5"><header class="pbe5-head"><div class="pbe5-head-id"><h1>Prop Board</h1><p>Reading the current market snapshot…</p></div></header><div class="pbe5-skeleton">${'<div></div>'.repeat(8)}</div></section>`; }
  function errorHtml(error) { return `<section class="pbe5"><header class="pbe5-head"><div class="pbe5-head-id"><h1>Prop Board</h1><p>Market board unavailable</p></div></header><div class="pbe5-empty"><b>${esc(error?.message || 'The market snapshot did not return a usable board for this event.')}</b><span><button type="button" class="pbe5-btn" data-pbe5="refresh">Retry</button> <button type="button" class="pbe5-btn" data-pbe5="event">Change game</button></span></div></section>`; }

  /* --------------------------------------------------------------- paint */
  function layoutFor(width) { return width >= TABLE_MIN ? 'table' : width >= CARD_TWO_COL_MIN ? 'cards2' : 'cards1'; }
  function root() { return document.querySelector('#view-container .pbe5'); }
  function paintBoard() { const el = document.getElementById('pbe5-board'); if (el) el.innerHTML = boardHtml(); const f = root()?.querySelector('.pbe5-foot'); if (f) f.outerHTML = footHtml(); }
  function paintFilters() { const el = root()?.querySelector('.pbe5-filters'); if (el) el.outerHTML = filtersHtml(); const s = root()?.querySelector('.pbe5-signal'); if (s) s.outerHTML = signalHtml(); }
  function paint() {
    const vc = document.getElementById('view-container'); if (!vc) return;
    ui.layout = layoutFor(window.innerWidth);
    vc.innerHTML = shellHtml();
    applyDeepLink();
  }

  /* The provider event is shared across surfaces through ?event= and
     localStorage (PBEEventSelector). v3 captured it once at parse time, so a
     game chosen after load used to leave the board on the previous game. */
  function syncEvent(id) {
    const s = data(); if (!s) return;
    let want = id || '';
    if (!want) { try { want = new URLSearchParams(location.search).get('event') || ''; } catch (_) {} }
    if (!want) { try { want = localStorage.getItem('pbe_nfl_event') || ''; } catch (_) {} }
    if (want && want !== s.eventId) { s.eventId = want; ui.expanded.clear(); }
  }

  async function render() {
    if (ui.loading) return;
    const vc = document.getElementById('view-container'); if (!vc || !v3()?.load) return;
    ui.loading = true; ui.error = null; ui.expanded.clear();
    syncEvent();
    vc.innerHTML = loadingHtml();
    try {
      await Promise.all([v3().load(), loadRoster()]);
      paint();
    } catch (error) {
      ui.error = error; vc.innerHTML = errorHtml(error);
    } finally { ui.loading = false; }
  }

  /* ?player=Drake%20Maye#propboard: narrow the board to that player once.
     (The global router opens the Player Research drawer for the same link.) */
  function applyDeepLink() {
    let player = ''; try { player = new URLSearchParams(location.search).get('player') || ''; } catch (_) {}
    if (!player || ui.deepLinkDone === player) return;
    ui.deepLinkDone = player;
    ui.search = player; paintFilters(); paintBoard();
    /* app-core-v3 opens the Player Research drawer for ?player= itself */
  }

  /* ------------------------------------------------------------- events */
  let resizeTimer = null;
  function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!root()) return; const next = layoutFor(window.innerWidth); if (next !== ui.layout) { ui.layout = next; paintBoard(); } }, 120); }

  function toggleRow(key) { if (ui.expanded.has(key)) ui.expanded.delete(key); else ui.expanded.add(key); paintBoard(); const el = root()?.querySelector(`[data-pbe5-row="${CSS.escape(key)}"]`); if (el && ui.expanded.has(key)) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function togglePin(key) { const set = pins(); const id = String(key); if (set.has(id)) set.delete(id); else set.add(id); savePins(set); paintFilters(); paintBoard(); }

  function onClick(event) {
    const r = root(); if (!r || !r.contains(event.target)) return;
    const pin = event.target.closest('[data-pbe5-pin]'); if (pin) { event.preventDefault(); event.stopPropagation(); togglePin(pin.dataset.pbe5Pin); return; }
    const name = event.target.closest('[data-pbe5-player]'); if (name) { event.preventDefault(); event.stopPropagation(); window.PBEPlayerResearch?.show?.(name.dataset.pbe5Player); return; }
    const open = event.target.closest('[data-pbe5-open]'); if (open) { const key = open.dataset.pbe5Open; if (key && !ui.expanded.has(key)) toggleRow(key); else if (key) root()?.querySelector(`[data-pbe5-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const tog = event.target.closest('[data-pbe5-toggle]'); if (tog) { event.preventDefault(); toggleRow(tog.dataset.pbe5Toggle); return; }
    const action = event.target.closest('[data-pbe5]'); const act = action?.dataset?.pbe5;
    if (act === 'refresh') { render(); return; }
    if (act === 'event') { if (window.PBEEventSelector?.open) window.PBEEventSelector.open(); else v3()?.changeEvent?.(); return; }
    if (act === 'modeled') { if (!isPro()) return; saveSettings({ modeledOnly: !settings().modeledOnly }); paintFilters(); paintBoard(); return; }
    if (act === 'pinned') { saveSettings({ pinnedOnly: !settings().pinnedOnly }); paintFilters(); paintBoard(); return; }
    if (act === 'more') { ui.more = !ui.more; paintFilters(); return; }
    if (event.target.closest('.pbe5-detail, .pbe5-filters, .pbe5-card-open, a, button, select, input, label')) return;
    const row = event.target.closest('[data-pbe5-row]'); if (row) toggleRow(row.dataset.pbe5Row);
  }
  function onInput(event) { const s = event.target.closest('[data-pbe5-search]'); if (s && root()) { ui.search = s.value || ''; paintBoard(); } }
  function onChange(event) {
    if (!root()) return;
    const m = event.target.closest('[data-pbe5-market]'); if (m) { ui.market = m.value || 'all'; paintBoard(); return; }
    const b = event.target.closest('[data-pbe5-book]'); if (b) { ui.book = b.value || ''; paintBoard(); return; }
    const so = event.target.closest('[data-pbe5-sort]'); if (so) { ui.sort = so.value || 'default'; paintBoard(); return; }
    const t = event.target.closest('[data-pbe5-threshold]'); if (t && isPro()) { saveSettings({ threshold: Math.max(0, Math.min(100, Number(t.value) || 0)) }); paintFilters(); paintBoard(); }
  }
  function onKey(event) { if (event.key !== 'Enter' && event.key !== ' ') return; const row = event.target.closest?.('[data-pbe5-row], [data-pbe5-open]'); if (!row || event.target.closest('a, button, input, select')) return; event.preventDefault(); toggleRow(row.dataset.pbe5Row || row.dataset.pbe5Open); }

  function install() {
    if (!window.App?.VIEWS) return false;
    window.App.VIEWS.propboard = render;
    return true;
  }
  window.PBEPropBoardV5 = { version: VERSION, render, ui, settings, pins, visibleRows };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  /* PRO state flips repaint from the already-loaded state when the model is
     already present, and re-load (via v3) when it is not. */
  window.addEventListener('pbe:event-changed', event => { syncEvent(event.detail?.eventId); });
  window.addEventListener('pbe:pro-state', () => { if (!root() || ui.loading) return; if (isPro() && !data()?.model) render(); else paint(); });
})();
