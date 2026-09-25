/* PropBetEdge NFL — MY SUNDAY v1 (every NFL game day, Thursday to Monday)
 *
 * Sole registrant of #mysunday, and the one owner of "Save to My Sunday":
 * every host surface asks this module for its button markup
 * (PBEMySunday.saveButtonHtml(item)) instead of drawing its own, so the
 * saved state is decided in one place and updated in place by key.
 *
 * MODES
 *   synced   NFL Pro / All Access / Owner session: /api/my-sunday (server-
 *            scoped to the verified session; nothing here names an owner).
 *   device   signed out: a device-only list in localStorage. It is never
 *            imported silently — a synced reader who has device items is
 *            OFFERED an explicit, server-validated import.
 *   off      the server flag is off (404 feature_disabled): every control
 *            disappears and the route explains nothing is available.
 * Signing out drops every synced item and alert from memory at once.
 *
 * PHASES per saved game (scoreboard state, never guessed from the clock)
 *   before kickoff  saved research, kickoff, current designation for saved
 *                   players, saved-vs-latest line for saved props (same book,
 *                   same side; line and price shown separately)
 *   in progress     quarter/clock + supported stat progress ("threshold
 *                   passed" is not a result), exact-game PBEcast
 *   final           final box-score stat vs the saved line — labelled
 *                   personal tracking, subject to stat corrections
 *
 * READS. The scoreboard (/api/nfl-live, edge-cached, shared by every reader)
 * refreshes every 60s while a saved game is live and this page is visible.
 * Box scores are read when the page opens and when the reader taps "Update
 * progress" (30s floor) — never on a per-reader timer, because the live box
 * score is not edge-cached. Market snapshots come from nfl-odds (KV, zero
 * provider credits); designations from nfl-intel's change ledger.
 *
 * No stake, no bet, no settlement, no sportsbook. Nothing saved here enters
 * any official PBE record.
 */
(() => {
  'use strict';

  const ROUTE = 'mysunday';
  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEVICE_KEY = 'pbe_mysunday_device_v1';
  const MARKET_STAT = {
    player_pass_yds: { group: 'passing', label: 'YDS', unit: 'passing yards' },
    player_pass_completions: { group: 'passing', label: 'C/ATT', part: 0, unit: 'completions' },
    player_pass_attempts: { group: 'passing', label: 'C/ATT', part: 1, unit: 'pass attempts' },
    player_pass_tds: { group: 'passing', label: 'TD', unit: 'passing TDs' },
    player_pass_interceptions: { group: 'passing', label: 'INT', unit: 'interceptions' },
    player_reception_yds: { group: 'receiving', label: 'YDS', unit: 'receiving yards' },
    player_receptions: { group: 'receiving', label: 'REC', unit: 'receptions' },
    player_rush_yds: { group: 'rushing', label: 'YDS', unit: 'rushing yards' },
    player_rush_attempts: { group: 'rushing', label: 'CAR', unit: 'rush attempts' },
    player_anytime_td: { anytime: true, unit: 'touchdowns' }
  };
  const KIND_COPY = { AVAILABILITY: 'Availability', GAME_STATUS: 'Game status', MARKET_MOVE: 'Market move', PROP_LINE: 'Line move', PROP_PRICE: 'Price move' };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const track = (name, params = {}) => { try { window.gtag?.('event', name, { pbe_surface: 'nfl', ...params }); } catch (_) {} };
  const fmtTime = t => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }); };
  const odds = p => (p === null || p === undefined ? '—' : p > 0 ? `+${p}` : String(p));

  /* The same canonical key the server derives (workers/nfl-my-sunday/src/core.js),
     used here only to show saved state; the server's key is authoritative. */
  function fnv(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  function keyOf(it) {
    const player = it.espn_id ? `e${it.espn_id}` : it.gsis_id ? `g${it.gsis_id}` : null;
    switch (it.type) {
      case 'game': return it.event_id ? `game:${it.event_id}` : null;
      case 'player': return player ? `player:${player}` : null;
      case 'prop': { const side = it.side === 'yes' ? 'over' : it.side === 'no' ? 'under' : it.side; return `prop:${it.odds_event_id || it.event_id}:${player || `n${fnv(String(it.provider_player || '').toLowerCase())}`}:${it.market}:${side}`; }
      case 'pick': return it.pick_ref ? `pick:${it.pick_ref}` : null;
      case 'td_target': return it.event_id && player ? `td:${it.event_id}:${player}` : null;
      case 'scenario': { const s = it.context?.scenario || {}; return `scenario:${it.team}:${it.season}:${fnv(JSON.stringify([it.team, it.season, s.state, s.volume, s.pass_rate, s.data_revision, s.calc_version]))}`; }
      default: return null;
    }
  }

  /* ---------------------------------------------------------------- store */

  const store = { mode: 'unknown', items: [], alerts: [], alertsState: null, loadedAt: 0, loading: null, error: null, flagOff: false };
  const live = { board: null, boardAt: 0, boxes: new Map(), boxAt: 0, markets: new Map(), intel: null, timer: null };

  const synced = () => store.mode === 'synced';
  function device() { try { const v = JSON.parse(localStorage.getItem(DEVICE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
  function writeDevice(list) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify(list.slice(0, 50))); } catch (_) {} }

  function itemsNow() { return synced() ? store.items : device(); }
  function savedKeys() { return new Set(itemsNow().map(i => i.item_key)); }

  async function api(method, op, body) {
    const r = await fetch(`/api/my-sunday${op ? `?op=${op}` : ''}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'POST' ? { 'content-type': 'application/json', 'x-pbe-csrf': '1', accept: 'application/json' } : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, body: json };
  }

  function entitled() { return window.PBEPro?.state?.pro === true; }

  async function load({ force = false } = {}) {
    if (store.loading) return store.loading;
    if (!force && store.loadedAt && Date.now() - store.loadedAt < 30000) return store;
    store.loading = (async () => {
      try {
        const r = await api('GET');
        if (r.status === 404 && r.body?.error === 'feature_disabled') { store.flagOff = true; store.mode = 'off'; store.items = []; store.alerts = []; }
        else if (r.status === 200 && r.body) { store.flagOff = false; store.mode = 'synced'; store.items = r.body.items || []; store.alerts = r.body.alerts || []; store.alertsState = r.body.alerts_state || null; store.error = null; }
        else if (r.status === 401 || r.status === 403) { store.flagOff = false; store.mode = 'device'; store.items = []; store.alerts = []; }
        else { store.mode = entitled() ? 'synced' : 'device'; store.error = r.body?.error || `http_${r.status}`; }
        store.loadedAt = Date.now();
      } catch (e) { store.error = String(e?.message || e); store.mode = store.mode === 'unknown' ? 'device' : store.mode; }
      finally { store.loading = null; changed(); }
      return store;
    })();
    return store.loading;
  }

  function changed() {
    const keys = savedKeys();
    document.querySelectorAll('[data-pms-key]').forEach(btn => {
      const on = keys.has(btn.dataset.pmsKey);
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('[data-pms-text]').textContent = on ? 'Saved' : 'Save';
      btn.hidden = store.mode === 'off';
    });
    paintDock();
    window.dispatchEvent(new CustomEvent('pbe:mysunday-changed', { detail: { mode: store.mode, count: itemsNow().length } }));
    if (window.App?.current === ROUTE) paint();
  }

  /* ---------------------------------------------------------- the button */

  function saveButtonHtml(item) {
    if (store.mode === 'off' || !item) return '';
    const key = keyOf(item);
    if (!key) return '';
    const on = savedKeys().has(key);
    return `<button type="button" class="pms-save" data-pms-key="${esc(key)}" data-pms-item="${esc(JSON.stringify(item))}" aria-pressed="${on}" title="Save to My Sunday"><i aria-hidden="true">★</i><span data-pms-text>${on ? 'Saved' : 'Save'}</span></button>`;
  }

  /* A Prop Board quote names its game by team names and its player by the
     provider's string. The ESPN game is the scoreboard game with those two
     teams kicking off within a day of the market's commence time; the player
     is the ONE Player DNA index entry with that exact full name on either of
     the two teams. Anything else stays unresolved (saved, but without stat
     progress) — never a guess. */
  async function resolveProp(item) {
    const need = item.needs_resolution;
    delete item.needs_resolution;
    if (!need) return item;
    if (!live.board) await refreshBoard();
    const low = v => String(v || '').trim().toLowerCase();
    const t = Date.parse(need.commence || '');
    const game = (live.board || []).find(g => low(g.teams?.away?.display_name) === low(need.away) && low(g.teams?.home?.display_name) === low(need.home) && (!Number.isFinite(t) || Math.abs(Date.parse(g.date) - t) < 86400000));
    if (game) item.event_id = String(game.id);
    if (!item.espn_id && window.PBEPlayerIndex?.find && game) {
      await window.PBEPlayerIndex.load?.();
      const hit = window.PBEPlayerIndex.find(item.provider_player, [game.teams?.away?.abbreviation, game.teams?.home?.abbreviation]);
      if (hit) { item.espn_id = hit.espn || undefined; item.gsis_id = hit.gsis || undefined; }
    }
    if (item.label && game) item.label = item.label.slice(0, 80);
    return item;
  }

  async function toggle(btn) {
    let item;
    try { item = JSON.parse(btn.dataset.pmsItem); } catch (_) { return; }
    if (item.type === 'prop' && !savedKeys().has(btn.dataset.pmsKey)) item = await resolveProp(item);
    const key = btn.dataset.pmsKey;
    const on = savedKeys().has(key);
    btn.disabled = true;
    try {
      if (synced()) {
        const r = on ? await api('POST', 'remove', { item_key: key }) : await api('POST', 'save', { item });
        if (r.status >= 400) { note(r.body?.error === 'limit_reached' ? 'My Sunday is full (200 items). Remove something first.' : r.status === 401 || r.status === 403 ? 'Sign in to NFL Pro to sync My Sunday.' : 'Could not save right now. Nothing was changed.'); await load({ force: true }); return; }
        await load({ force: true });
      } else {
        const list = device();
        if (on) writeDevice(list.filter(i => i.item_key !== key));
        else { if (list.length >= 50) { note('This device holds 50 saved items. Sign in to NFL Pro for 200, synced across devices.'); return; } writeDevice([{ ...item, item_key: key, saved_at: new Date().toISOString() }, ...list]); }
        changed();
      }
      if (!on) track('pbe_research_save', { item_type: item.type, pbe_mode: store.mode });
      else note('Removed from My Sunday.');
      if (!on) note(`Saved to My Sunday${synced() ? '' : ' on this device'}.`);
    } finally { btn.disabled = false; }
  }

  let noteTimer = null;
  function note(text) {
    let el = document.getElementById('pms-note');
    if (!el) { el = document.createElement('div'); el.id = 'pms-note'; el.className = 'pms-note'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = text; el.classList.add('is-on');
    clearTimeout(noteTimer); noteTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  }

  /* ------------------------------------------------------ persistent dock */

  /* The persistent control sits at the end of the shell's TODAY row, right
     after PBEcast (tablet and up): the header's right side is already full.
     On phones the shell rows collapse, so it is a compact star + count above
     the bottom navigation instead. Re-inserted if the shell repaints. */
  function paintDock() {
    let dock = document.getElementById('pms-dock');
    const n = itemsNow().length;
    const unread = synced() ? store.alerts.filter(a => !a.read_at).length : 0;
    const show = store.mode !== 'off' && (n || unread);
    const anchor = document.querySelector('#pbe-sports-shell .pbes-primary [data-route="pbecast"]');
    let head = document.getElementById('pms-head');
    if (anchor && window.innerWidth > 620) {
      if (dock) dock.hidden = true;
      if (!show) { if (head) head.hidden = true; return; }
      if (!head || !head.isConnected || head.parentNode !== anchor.parentNode) {
        head?.remove();
        head = document.createElement('button');
        head.id = 'pms-head'; head.type = 'button'; head.className = 'pbes-nav-btn pms-head';
        head.addEventListener('click', () => window.App?.nav(ROUTE));
        anchor.parentNode.insertBefore(head, anchor.nextSibling);
      }
      head.hidden = false;
      head.classList.toggle('active', window.App?.current === ROUTE);
      head.setAttribute('aria-label', `My Sunday: ${n} saved${unread ? `, ${unread} new alert${unread === 1 ? '' : 's'}` : ''}`);
      head.innerHTML = `<i aria-hidden="true">★</i>My Sunday<b>${n}</b>${unread ? `<em>${unread}</em>` : ''}`;
      return;
    }
    if (head) head.hidden = true;
    if (!show || window.App?.current === ROUTE) { if (dock) dock.hidden = true; return; }
    if (!dock) {
      dock = document.createElement('button');
      dock.id = 'pms-dock'; dock.type = 'button'; dock.className = 'pms-dock';
      dock.addEventListener('click', () => window.App?.nav(ROUTE));
      document.body.appendChild(dock);
    }
    dock.hidden = false;
    dock.setAttribute('aria-label', `My Sunday: ${n} saved${unread ? `, ${unread} new alert${unread === 1 ? '' : 's'}` : ''}`);
    dock.innerHTML = `<i aria-hidden="true">★</i><span>My Sunday</span><b>${n}</b>${unread ? `<em>${unread}</em>` : ''}`;
  }

  /* ------------------------------------------------------------ live data */

  async function getJson(url) { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

  async function refreshBoard() {
    try { const b = await getJson('/api/nfl-live'); live.board = Array.isArray(b?.games) ? b.games : []; live.boardAt = Date.now(); } catch (_) { /* keep the last board; it is labelled with its time */ }
  }
  const boardGame = id => (live.board || []).find(g => String(g.id) === String(id)) || null;
  function gameOf(id) { return boardGame(id) || live.boxes.get(String(id))?.game || null; }
  function phase(game) {
    const s = game?.status?.semantics || '';
    if (s === 'LIVE') return 'live';
    if (s === 'FINAL') return 'final';
    const name = String(game?.status?.name || '');
    if (/POSTPONED|CANCELED|CANCELLED|SUSPENDED|DELAYED/i.test(name)) return 'disrupted';
    return game ? 'pre' : 'unknown';
  }

  async function refreshBoxes(force = false) {
    if (!force && Date.now() - live.boxAt < 30000) return;
    live.boxAt = Date.now();
    const events = [...new Set(itemsNow().filter(i => i.event_id && ['prop', 'td_target', 'game', 'pick'].includes(i.item_type || i.type)).map(i => String(i.event_id)))];
    await Promise.all(events.map(async id => {
      const g = boardGame(id);
      if (g && phase(g) === 'pre') return;
      try { live.boxes.set(id, { ...(await getJson(`/api/nfl-live?event=${encodeURIComponent(id)}`)), fetched_at: new Date().toISOString() }); } catch (_) {}
    }));
  }

  async function refreshMarkets() {
    const props = itemsNow().filter(i => (i.item_type || i.type) === 'prop' && i.odds_event_id);
    const events = [...new Set(props.map(p => p.odds_event_id))];
    await Promise.all(events.map(async ev => {
      const markets = [...new Set(props.filter(p => p.odds_event_id === ev).map(p => p.market))];
      try { live.markets.set(ev, await getJson(`${API}/api/odds/board?event_id=${encodeURIComponent(ev)}&markets=${encodeURIComponent(markets.join(','))}`)); } catch (_) {}
    }));
  }

  async function refreshIntel() {
    try { live.intel = await getJson(`${API}/api/changes?window_hours=168`); } catch (_) { live.intel = null; }
  }

  function statFor(item) {
    const box = live.boxes.get(String(item.event_id));
    const espn = String(item.espn_id || '');
    if (!box || !espn) return null;
    const spec = MARKET_STAT[item.market];
    if (!spec) return null;
    const groups = (box.player_stats || []).flatMap(t => t.groups || []);
    const find = name => { for (const g of groups) if (g.name === name) { const a = (g.athletes || []).find(x => String(x.athlete?.id) === espn); if (a) return { a, labels: g.labels || [] }; } return null; };
    const val = (hit, label, part) => { if (!hit) return null; const i = hit.labels.indexOf(label); if (i < 0) return null; const raw = String(hit.a.stats?.[i] ?? ''); const s = part === undefined ? raw : raw.split('/')[part]; const n = Number(s); return Number.isFinite(n) ? n : null; };
    let value = null, dnp = false, present = false;
    if (spec.anytime) {
      const r = find('rushing'), c = find('receiving');
      present = Boolean(r || c);
      value = present ? (val(r, 'TD') || 0) + (val(c, 'TD') || 0) : null;
      dnp = [r, c].some(h => h?.a?.did_not_play);
    } else {
      const hit = find(spec.group);
      present = Boolean(hit);
      value = val(hit, spec.label, spec.part);
      dnp = Boolean(hit?.a?.did_not_play);
    }
    return { value, dnp, present, unit: spec.unit, fetched_at: box.fetched_at, semantics: box.source?.semantics || null };
  }

  function progressHtml(item, game) {
    const ph = phase(game);
    if ((item.item_type || item.type) !== 'prop') return '';
    if (ph === 'pre' || ph === 'unknown') return '';
    if (!item.espn_id) return '<p class="pms-muted">Player identity was not resolved when this prop was saved, so stat progress is unavailable.</p>';
    const s = statFor(item);
    if (!s) return `<p class="pms-muted">Box score not loaded yet. <button type="button" class="pms-link" data-pms-update>Update progress</button></p>`;
    if (!s.present) return `<p class="pms-muted">No ${esc(s.unit)} recorded for this player in the box score${ph === 'final' ? '' : ' yet'}.${ph === 'final' ? ' Not scored as zero: the box score may not list him.' : ''}</p>`;
    if (s.dnp) return '<p class="pms-muted">Listed as did not play.</p>';
    const line = item.saved_line;
    const anytime = item.market === 'player_anytime_td';
    const over = item.side === 'over';
    const target = anytime ? 1 : line;
    const passed = anytime ? s.value >= 1 : s.value > line;
    const when = `box score ${new Date(s.fetched_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    if (ph === 'live') {
      const pct = anytime ? (s.value >= 1 ? 100 : 0) : Math.max(0, Math.min(100, (s.value / Math.max(line, 0.5)) * 100));
      return `<div class="pms-progress"><div class="pms-bar" role="img" aria-label="${esc(`${s.value} of ${target} ${s.unit}`)}"><i style="width:${pct.toFixed(1)}%"></i></div><p><b>${esc(s.value)}</b> ${esc(s.unit)} · line ${esc(anytime ? 'any TD' : line)}${passed ? ` · <span class="pms-flag">${over ? 'Past the line' : 'Over the line'} — game in progress, not a result</span>` : ''} <small>(${esc(when)})</small> <button type="button" class="pms-link" data-pms-update>Update progress</button></p></div>`;
    }
    if (ph === 'final') {
      const push = !anytime && s.value === line;
      const cleared = anytime ? (over ? s.value >= 1 : s.value < 1) : over ? s.value > line : s.value < line;
      const verdict = push ? 'Landed exactly on the saved line' : cleared ? `Cleared the saved ${esc(item.side)}` : `Did not clear the saved ${esc(item.side)}`;
      return `<div class="pms-final ${push ? '' : cleared ? 'is-yes' : 'is-no'}"><b>Final: ${esc(s.value)} ${esc(s.unit)}</b><span>${verdict} (${esc(anytime ? 'anytime TD' : line)}). Personal tracking from the final ${esc(when)} — stat corrections can change it; nothing is settled here.</span></div>`;
    }
    return '';
  }

  function marketCompareHtml(item, game) {
    if ((item.item_type || item.type) !== 'prop' || phase(game) !== 'pre') return '';
    const board = live.markets.get(item.odds_event_id);
    if (!board) return '';
    const who = String(item.context?.provider_player || '').toLowerCase();
    const side = item.side;
    const sideOf = x => { const r = String(x?.direction || x?.outcome || x?.side || x?.name || '').trim().toUpperCase(); return r === 'OVER' || r === 'YES' ? 'over' : r === 'UNDER' || r === 'NO' ? 'under' : null; };
    const q = (board.quotes || []).find(x => String(x.player || x.player_name || x.description || '').toLowerCase() === who && x.market === item.market && (x.book || x.book_title || x.sportsbook || x.book_key) === item.saved_book && sideOf(x) === side);
    if (!q) return `<p class="pms-muted">${esc(item.saved_book || 'The saved book')} has no current ${esc(side)} quote in the latest snapshot. That is not a line move.</p>`;
    const line = Number(q.point ?? q.line), price = Number(q.price ?? q.american_odds ?? q.odds);
    const lineMoved = Number.isFinite(line) && item.saved_line !== null && line !== item.saved_line;
    const priceMoved = Number.isFinite(price) && item.saved_price !== null && price !== item.saved_price;
    return `<dl class="pms-compare"><div><dt>Saved</dt><dd>${esc(item.saved_line ?? '—')} <small>${esc(odds(item.saved_price))}</small></dd></div><div><dt>Latest · same book</dt><dd class="${lineMoved ? 'moved' : ''}">${esc(Number.isFinite(line) ? line : '—')} <small class="${priceMoved ? 'moved' : ''}">${esc(odds(Number.isFinite(price) ? price : null))}</small></dd></div><div><dt>Snapshot</dt><dd><small>${esc(fmtTime(board.captured_at || board.provider_last_update))}</small></dd></div></dl>`;
  }

  function designationFor(espn) {
    const list = live.intel?.changes || [];
    const hit = list.find(c => c.kind === 'INJURY_STATUS' && String(c.player?.espn_id) === String(espn));
    return hit ? { status: hit.status, when: hit.observed_at, headline: hit.headline } : null;
  }

  /* ---------------------------------------------------------------- render */

  function groupItems() {
    const list = itemsNow();
    const byGame = new Map(), loose = [];
    for (const it of list) {
      if (it.event_id) { const k = String(it.event_id); if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(it); }
      else loose.push(it);
    }
    const order = { live: 0, pre: 1, disrupted: 1, unknown: 2, final: 3 };
    const games = [...byGame.entries()].map(([id, items]) => ({ id, items, game: gameOf(id) })).sort((a, b) => (order[phase(a.game)] - order[phase(b.game)]) || String(a.game?.date || '').localeCompare(String(b.game?.date || '')));
    return { games, loose };
  }

  function gameHead(g) {
    const game = g.game;
    const ph = phase(game);
    const away = game?.teams?.away?.abbreviation || '', home = game?.teams?.home?.abbreviation || '';
    const title = away && home ? `${away} @ ${home}` : g.items[0]?.label || `Game ${g.id}`;
    const state = ph === 'live' ? `<span class="pms-state live">Live · ${esc(game.status?.short_detail || game.status?.detail || '')}</span>`
      : ph === 'final' ? `<span class="pms-state final">${esc(game.status?.detail || 'Final')}</span>`
      : ph === 'disrupted' ? `<span class="pms-state warn">${esc(game.status?.detail || 'Status changed')}</span>`
      : ph === 'pre' ? `<span class="pms-state">Kickoff ${esc(fmtTime(game.date))}</span>` : '<span class="pms-state">Game status not on the current scoreboard</span>';
    const score = (ph === 'live' || ph === 'final') ? `<b class="pms-score">${esc(game.teams?.away?.score ?? '')}–${esc(game.teams?.home?.score ?? '')}</b>` : '';
    return `<header class="pms-game-head"><div><strong>${esc(title)}</strong>${state}</div>${score}<button type="button" class="pms-act" data-pms-cast="${esc(g.id)}"${game?.date ? ` data-pms-kick="${esc(game.date)}"` : ''}>${ph === 'live' ? 'Game Center' : ph === 'final' ? 'Replay' : 'Preview'}</button></header>`;
  }

  function itemRow(it, game) {
    const type = it.item_type || it.type;
    const alerts = synced() ? store.alerts.filter(a => a.item_key === it.item_key) : [];
    const desig = it.espn_id && phase(game) !== 'final' ? designationFor(it.espn_id) : null;
    const typeLabel = { game: 'Game', player: 'Player', prop: 'Prop', pick: 'PBE pick', td_target: 'TD target', scenario: 'Scenario' }[type] || type;
    let detail = '';
    if (type === 'prop') detail = `<p class="pms-sub">Saved ${esc(it.side)} ${esc(it.saved_line ?? '')} ${esc(odds(it.saved_price))} at ${esc(it.saved_book || '—')} · snapshot ${esc(fmtTime(it.market_captured_at))}</p>`;
    if (type === 'pick') detail = `<p class="pms-sub">Reference to the published pick ${esc(it.pick_ref)}. Its official record lives in PBE Picks and is not changed by saving it.</p>`;
    if (type === 'scenario') { const s = it.context?.scenario || {}; detail = `<p class="pms-sub">${esc(s.state)} · ${esc(s.volume)} plays · ${s.pass_rate === null || s.pass_rate === undefined ? 'team pass rate' : `${Math.round(s.pass_rate * 100)}% dropbacks`} · data ${esc(s.data_revision)} · ${esc(s.calc_version)}</p><p class="pms-scenario-note">Scenario estimate — not an official PBE prediction.</p>`; }
    if (type === 'player') { const row = window.PBEOpportunityRadar?.forPlayer?.(it.gsis_id || it.espn_id); if (row) detail = `<p class="pms-sub">Opportunity Radar: ${esc(row.label.replace(/_/g, ' ').toLowerCase())} · ${esc(row.latest_label)}</p>`; }
    return `<li class="pms-item"><div class="pms-item-main"><span class="pms-type">${esc(typeLabel)}</span><strong>${esc(it.label)}</strong>${detail}
      ${desig ? `<p class="pms-desig">Current designation: <b>${esc(desig.status)}</b> <small>(${esc(fmtTime(desig.when))}, ESPN injury report)</small></p>` : ''}
      ${marketCompareHtml(it, game)}${progressHtml(it, game)}
      ${alerts.length ? `<ul class="pms-item-alerts">${alerts.slice(0, 3).map(alertLine).join('')}</ul>` : ''}</div>
      <div class="pms-item-acts">${type === 'scenario' ? '<button type="button" class="pms-act" data-pms-route="matchups">Game Script Lab</button>' : ''}${type === 'pick' ? '<button type="button" class="pms-act" data-pms-route="pbepicks">PBE Picks</button>' : ''}${type === 'player' || type === 'prop' || type === 'td_target' ? `<button type="button" class="pms-act" data-pms-route="usage" data-pms-player="${esc(it.gsis_id || it.espn_id || '')}">Radar</button>` : ''}<button type="button" class="pms-act pms-remove" data-pms-remove="${esc(it.item_key)}" aria-label="Remove ${esc(it.label)}">Remove</button></div></li>`;
  }

  function alertLine(a) {
    const p = a.payload || {};
    const change = a.kind === 'AVAILABILITY' ? `${p.previous ? `${esc(p.previous)} → ` : ''}<b>${esc(p.current)}</b>`
      : a.kind === 'GAME_STATUS' ? `<b>${esc(p.current || p.headline)}</b>`
      : a.kind === 'MARKET_MOVE' ? `${esc(p.market)} ${esc(p.selection)}: ${p.movement !== 'price' ? `line ${esc(p.line_from)} → <b>${esc(p.line_to)}</b>` : ''}${p.movement === 'line_and_price' ? ' · ' : ''}${p.movement !== 'line' ? `price ${esc(odds(p.price_from))} → <b>${esc(odds(p.price_to))}</b>` : ''} <small>(consensus)</small>`
      : a.kind === 'PROP_LINE' ? `${esc(p.book)} ${esc(p.side)} line ${esc(p.line_from)} → <b>${esc(p.line_to)}</b>`
      : a.kind === 'PROP_PRICE' ? `${esc(p.book)} ${esc(p.side)} ${esc(p.line_to)} price ${esc(odds(p.price_from))} → <b>${esc(odds(p.price_to))}</b>` : esc(p.headline || a.kind);
    return `<li class="pms-alert ${a.read_at ? '' : 'is-new'}" data-pms-alert="${esc(a.alert_id)}"><span class="pms-alert-kind">${esc(KIND_COPY[a.kind] || a.kind)}</span><span class="pms-alert-text">${change}</span><small>${esc(fmtTime(a.observed_at))}${p.source ? ` · ${esc(p.source)}` : ''}</small></li>`;
  }

  function alertsHtml() {
    if (!synced()) return '';
    const list = store.alerts;
    const unread = list.filter(a => !a.read_at);
    const stateNote = store.alertsState === 'SOURCE_UNAVAILABLE' ? '<p class="pms-muted">The shared change feed did not answer on the last check. Alerts already recorded stay; nothing is inferred from the gap.</p>' : store.alertsState === 'NOT_YET_RUN' ? '<p class="pms-muted">Alerts start with the next shared check (every 10 minutes).</p>' : '';
    if (!list.length) return `<section class="pms-panel"><div class="pms-panel-head"><strong>Alerts</strong><span>Availability · game status · saved markets</span></div>${stateNote}<p class="pms-muted">No changes to your saved items since you saved them.</p></section>`;
    const byKey = new Map(itemsNow().map(i => [i.item_key, i]));
    return `<section class="pms-panel"><div class="pms-panel-head"><strong>Alerts</strong><span>${unread.length} new</span>${unread.length ? '<button type="button" class="pms-link" data-pms-read-all>Mark all read</button>' : ''}</div>${stateNote}<ul class="pms-alerts">${list.slice(0, 20).map(a => `${alertLine(a).replace('</li>', `<small class="pms-alert-item">${esc(byKey.get(a.item_key)?.label || a.item_key)}</small></li>`)}`).join('')}</ul></section>`;
  }

  function bannerHtml() {
    if (store.mode === 'synced') {
      const dev = device();
      return dev.length ? `<div class="pms-banner"><p><b>${dev.length} item${dev.length === 1 ? '' : 's'}</b> saved on this device before you signed in. They are not in your account unless you import them.</p><div><button type="button" class="pms-act" data-pms-import>Import to my account</button><button type="button" class="pms-link" data-pms-discard>Keep them device-only</button></div></div>` : '<p class="pms-sync">Synced to your NFL Pro account · available on every device you sign in on.</p>';
    }
    if (store.mode === 'device') return `<div class="pms-banner"><p>Saved on <b>this device only</b>. NFL Pro and All Access sync My Sunday to your account and add alerts for availability, game status and saved-market changes.</p><div><button type="button" class="pms-act" data-pms-upgrade>See NFL Pro</button></div></div>`;
    return '';
  }

  function shellHtml() {
    const hero = `<header class="pms-hero"><span class="pms-eyebrow">Your game day</span><h1 class="pms-title">My Sunday</h1><p class="pms-lede">The games, players, props and scenarios you saved — before kickoff, during the game, and after the final. Personal research tracking: no bets, no settlement, nothing counted in PBE's record.</p></header>`;
    if (store.mode === 'off') return `<section class="pms-wrap" data-pms>${hero}<p class="pms-muted">My Sunday is not available right now.</p></section>`;
    if (store.mode === 'unknown') return `<section class="pms-wrap" data-pms>${hero}<p class="pms-muted">Loading your saved items…</p></section>`;
    const { games, loose } = groupItems();
    const empty = !games.length && !loose.length;
    return `<section class="pms-wrap" data-pms>${hero}${bannerHtml()}${store.error && synced() ? '<p class="pms-muted">Your saved items could not be refreshed. What is shown was loaded earlier.</p>' : ''}${alertsHtml()}
      ${empty ? `<section class="pms-panel pms-empty"><strong>Nothing saved yet</strong><p>Use <span class="pms-inline-save">★ Save</span> on Opportunity Radar, game cards, Player DNA, Prop Board, PBE Picks, Touchdown Targets or a Game Script Lab scenario.</p><div class="pms-item-acts"><button type="button" class="pms-act" data-pms-route="usage">Opportunity Radar</button><button type="button" class="pms-act" data-pms-route="games">Games</button><button type="button" class="pms-act" data-pms-route="propboard">Prop Board</button></div></section>` : ''}
      ${games.map(g => `<section class="pms-game">${gameHead(g)}<ul class="pms-items">${g.items.map(it => itemRow(it, g.game)).join('')}</ul></section>`).join('')}
      ${loose.length ? `<section class="pms-game"><header class="pms-game-head"><div><strong>Players &amp; research</strong><span class="pms-state">Not tied to one game</span></div></header><ul class="pms-items">${loose.map(it => itemRow(it, null)).join('')}</ul></section>` : ''}
      <p class="pms-foot">Scores and clock: shared scoreboard${live.boardAt ? `, ${esc(new Date(live.boardAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}` : ''}. Stat progress: ESPN box score on open and on "Update progress". Designations: ESPN injury report via PropBetEdge's change ledger. Lines: PropBetEdge market snapshot.</p>
    </section>`;
  }

  function paint() {
    const vc = document.getElementById('view-container');
    if (!vc || window.App?.current !== ROUTE) return;
    const open = document.activeElement?.dataset?.pmsRemove || null;
    vc.innerHTML = shellHtml();
    if (open) vc.querySelector(`[data-pms-remove="${CSS.escape(open)}"]`)?.focus();
  }

  function schedule() {
    clearTimeout(live.timer);
    if (window.App?.current !== ROUTE || document.visibilityState === 'hidden') return;
    const anyLive = groupItems().games.some(g => phase(g.game) === 'live');
    if (!anyLive) return;
    live.timer = setTimeout(async () => { await refreshBoard(); paint(); schedule(); }, 60000);
  }

  async function render() {
    paint();
    await load({ force: true });
    if (itemsNow().length) track('pbe_mysunday_return', { pbe_mode: store.mode });
    await Promise.all([refreshBoard(), refreshIntel(), refreshMarkets()]);
    await refreshBoxes(true);
    paint();
    schedule();
  }

  /* -------------------------------------------------------- homepage rail */

  function railHtml() {
    if (store.mode === 'off' || store.mode === 'unknown') return '';
    const list = itemsNow();
    if (!list.length) return '';
    const unread = synced() ? store.alerts.filter(a => !a.read_at).length : 0;
    const top = list.slice(0, 3);
    return `<section class="pms-rail"><div class="pms-rail-head"><strong>My Sunday</strong><span>${list.length} saved${unread ? ` · ${unread} new alert${unread === 1 ? '' : 's'}` : ''}${synced() ? '' : ' · this device'}</span></div><ul>${top.map(i => `<li><span class="pms-type">${esc({ game: 'Game', player: 'Player', prop: 'Prop', pick: 'Pick', td_target: 'TD', scenario: 'Scenario' }[i.item_type || i.type] || '')}</span>${esc(i.label)}</li>`).join('')}</ul><button type="button" class="pms-act" data-route="${ROUTE}">Open My Sunday →</button></section>`;
  }

  /* --------------------------------------------------------------- events */

  document.addEventListener('click', async event => {
    const save = event.target.closest?.('[data-pms-key]');
    if (save) { event.preventDefault(); event.stopPropagation(); toggle(save); return; }
    const root = event.target.closest?.('[data-pms]');
    if (!root) return;
    const t = event.target.closest('button');
    if (!t) return;
    if (t.dataset.pmsRemove) {
      const key = t.dataset.pmsRemove;
      if (synced()) { await api('POST', 'remove', { item_key: key }); await load({ force: true }); }
      else { writeDevice(device().filter(i => i.item_key !== key)); changed(); }
      note('Removed from My Sunday.');
      return;
    }
    if (t.hasAttribute('data-pms-update')) { t.disabled = true; await refreshBoxes(true); await refreshBoard(); paint(); return; }
    if (t.dataset.pmsCast) { window.PBEGameHandoff?.open?.(t.dataset.pmsCast, { kickoff: t.dataset.pmsKick, source: 'my-sunday' }); return; }
    if (t.dataset.pmsPlayer && window.PBEOpportunityRadar?.focusPlayer) { window.PBEOpportunityRadar.focusPlayer(t.dataset.pmsPlayer); return; }
    if (t.dataset.pmsRoute) { window.App?.nav(t.dataset.pmsRoute); return; }
    if (t.hasAttribute('data-pms-upgrade')) { window.PBEPro?.open?.('upgrade'); return; }
    if (t.hasAttribute('data-pms-discard')) { note('Device items stay on this device only.'); t.closest('.pms-banner')?.remove(); return; }
    if (t.hasAttribute('data-pms-import')) {
      const items = device().map(({ item_key, saved_at, ...rest }) => rest);
      const r = await api('POST', 'import', { items });
      if (r.status === 200) { const ok = new Set((r.body.results || []).map((x, i) => (x.ok ? i : -1)).filter(i => i >= 0)); writeDevice(device().filter((_, i) => !ok.has(i))); note(`Imported ${r.body.imported}, ${r.body.already_saved} already saved${r.body.rejected ? `, ${r.body.rejected} could not be imported` : ''}.`); }
      else note('Import failed. Your device items are unchanged.');
      await load({ force: true });
      return;
    }
    if (t.hasAttribute('data-pms-read-all')) {
      const ids = store.alerts.filter(a => !a.read_at).map(a => a.alert_id).slice(0, 100);
      track('pbe_alert_open', { pbe_count_bucket: ids.length > 5 ? '6+' : String(ids.length) });
      await api('POST', 'read', { ids }); await load({ force: true });
    }
  });

  /* Signed out, or no longer entitled: every synced item and alert leaves
     memory at once. Device items were never the account's. */
  window.addEventListener('pbe:pro-state', e => {
    const pro = e.detail?.pro === true;
    if (!pro && synced()) { store.items = []; store.alerts = []; store.mode = 'device'; changed(); }
    load({ force: true });
  });
  window.addEventListener('resize', () => { clearTimeout(paintDock.t); paintDock.t = setTimeout(paintDock, 150); });
  window.addEventListener('pbe:upgrades-ready', paintDock);
  window.addEventListener('pbe:route-changed', () => { paintDock(); if (window.App?.current !== ROUTE) clearTimeout(live.timer); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(); if (window.App?.current === ROUTE) schedule(); } else clearTimeout(live.timer); });

  function install() { if (!window.App?.VIEWS) return false; window.App.VIEWS[ROUTE] = render; return true; }
  window.PBEMySunday = { version: 1, route: ROUTE, store, load, saveButtonHtml, railHtml, keyOf, render };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
  load();
})();
