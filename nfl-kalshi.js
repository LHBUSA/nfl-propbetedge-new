/* PropBetEdge NFL — Kalshi Market Intelligence (contract market-intel/1)
 *
 * The shared component lives in vendor/kalshi/ and is vendored UNCHANGED from
 * propbetedge-workers/workers/propsports-markets/client/. It is an ES module;
 * this site's runtime is classic scripts, so this file is the bridge: it
 * import()s the two vendored modules once and publishes them on
 * window.PBEKalshi (+ 'pbe:kalshi-ready'), the same way index.html exposes the
 * shared membership module on window.PBEMembership.
 *
 * Placements (all optional layers; nothing waits on them):
 *   PBEcast   ONE Market Pulse module directly under the hero (scoreboard) for the
 *             whole game lifecycle (MLB PBEcast standard, propbetedge-v2 6f34d67),
 *             with a lifecycle label: MARKET OPEN · PRE-MATCH / LIVE MARKET /
 *             GAME FINAL · MARKET STILL TRADING (full compact kalshiCard: Mid-market
 *             per side, Updated Ns ago, stored movement + sparkline, bid/ask, View
 *             market on Kalshi), then "How the market closed" in the same place:
 *             MARKET CLOSED · AWAITING SETTLEMENT / MARKET SETTLED. A stale in-game
 *             quote is labelled MARKET OPEN · QUOTE STALE, never LIVE. Its own
 *             section, never inside the sportsbook MARKET tile.
 *   Rail      PBEcast game rail (Sunday board tiles + v6 rail buttons): one compact
 *             "MKT IND 65.5¢ · WSH 34.5¢" footer per game only for exact (event + both team ids), displayable, fresh
 *             two-sided markets (kalshiLine rules); one shared-client board read per
 *             refresh; patched in place (v6 rail DOM otherwise untouched)
 *   Games     kalshiLine on each not-final game card, marketCloseLine on a FINAL
 *             card, from one board read
 *
 * Market history (shared client marketHistoryCard / marketCloseLine): a FINAL game
 * is not a settled market. CLOSED shows "awaiting settlement" and is re-read every
 * 5 min until SETTLED; SETTLED is never polled again. Only stored values; the
 * final trade and settlement are the venue's (Kalshi), never ours.
 *
 * Truth rules kept here on top of the component's own:
 *  - the browser never calls Kalshi: every read goes to our propsports-markets
 *    Worker (the vendored client's default base);
 *  - no entry -> nothing rendered; a failed read never blocks or delays PBEcast;
 *  - an entry is shown only for the ESPN event id it was asked for;
 *  - NFL game contracts resolve 50¢ per team on a tie (API proposition
 *    team_wins_game_tie_half); the vendored note only says "$1 if that outcome
 *    happens", so an NFL tie note is added next to the card.
 *
 * Pure HTML helpers are exported for tests/nfl-kalshi-ui.test.mjs (UMD).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root.document !== 'undefined') root.PBENflKalshi = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SPORT = 'nfl';
  const TIE_PROPOSITION = 'team_wins_game_tie_half';
  const TIE_NOTE = 'A tie pays 50¢ per contract.';
  const VENDOR = './vendor/kalshi/';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ui = () => root.PBEKalshi || null;

  /* ---- boot: load the vendored ES modules once ------------------------------ */
  let readyPromise = null;
  function ready() {
    if (root.PBEKalshi?.client) return Promise.resolve(root.PBEKalshi);
    if (readyPromise) return readyPromise;
    if (typeof root.document === 'undefined') return Promise.resolve(null);
    const v = root.PBEUpgrades?.version ? `?v=${encodeURIComponent(root.PBEUpgrades.version)}` : '';
    readyPromise = Promise.all([import(`${VENDOR}kalshi-market-ui.js${v}`), import(`${VENDOR}kalshi-market-client.js${v}`)])
      .then(([kui, kclient]) => {
        root.PBEKalshi = { ...kui, createKalshiClient: kclient.createKalshiClient, POLL_MS: kclient.POLL_MS, client: kclient.createKalshiClient({ sport: SPORT }) };
        root.dispatchEvent?.(new CustomEvent('pbe:kalshi-ready'));
        return root.PBEKalshi;
      })
      .catch(error => { console.warn('[pbe-kalshi] component unavailable', error?.message || error); return null; });
    return readyPromise;
  }

  /* ---- pure HTML ------------------------------------------------------------- */
  const hex = v => { const s = String(v || '').trim(); const h = s.startsWith('#') ? s : `#${s}`; return /^#[0-9a-f]{6}$/i.test(h) ? h : null; };
  /* Team stripe colours keyed by role, from the game's own teams (ESPN colour)
     or the site's team table. Absent stays absent; the component falls back. */
  function colorsFor(teams) {
    const table = root.NFL_TEAMS || {};
    const pick = t => hex(t?.color) || hex(table[t?.abbreviation || t?.abbr]?.color);
    const out = {};
    const a = pick(teams?.away), h = pick(teams?.home);
    if (a) out.away = a;
    if (h) out.home = h;
    return out;
  }

  function tieNote(entry) {
    if ((entry?.kalshi?.proposition || entry?.market?.proposition) !== TIE_PROPOSITION) return '';
    return `<p class="kx-nfl-tie"><b>NFL tie rule</b> ${esc(TIE_NOTE)}</p>`;
  }
  /* entry is shown only for the event it belongs to */
  const forId = (entry, id) => (entry && (!id || String(entry.event?.canonical_event_id) === String(id)) ? entry : null);

  /* Full card + the NFL tie note beside it. */
  function card(entry, { placement = 'pbecast-preview', colors = {}, id = null, compact = false, K = ui() } = {}) {
    const e = forId(entry, id);
    if (!K || !e) return '';
    const html = K.kalshiCard(e, { placement, colors, compact });
    if (!html) return '';
    return `<div class="kx-nfl" data-kx-nfl="${esc(placement)}">${html}${tieNote(e)}</div>`;
  }

  /* One-line strip; the tie note sits inside the expanded view, next to the
     compact card. open: keep a reader-opened strip open across repaints. */
  function strip(entry, { placement = 'pbecast', colors = {}, id = null, open = false, K = ui() } = {}) {
    const e = forId(entry, id);
    if (!K || !e) return '';
    let html = K.kalshiStrip(e, { placement, colors });
    if (!html) return '';
    const note = tieNote(e);
    if (note) html = html.replace(/<\/details>\s*$/, `${note}</details>`);
    if (open) html = html.replace('<details class="kx-strip"', '<details open class="kx-strip"');
    return `<div class="kx-nfl kx-nfl--strip" data-kx-nfl="${esc(placement)}">${html}</div>`;
  }

  /* Restrained game-card line. Never on a final game (that card gets closeLine). */
  function line(entry, { final = false, id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    if (final || !K || !e || e.event?.state === 'post') return '';
    return K.kalshiLine(e) || '';
  }

  /* ---- market history ------------------------------------------------------------ */
  const CLOSED_POLL_MS = 5 * 60 * 1000;
  const lifecycleOf = entry => String(entry?.market?.lifecycle || '').toUpperCase();
  const isDone = entry => { const lc = lifecycleOf(entry); return lc === 'CLOSED' || lc === 'SETTLED'; };

  /* "How the market closed": only for a CLOSED/SETTLED market with stored history
     (event endpoint). Anything else -> nothing, never a placeholder. */
  function history(entry, { placement = 'pbecast-history', id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    if (!K?.marketHistoryCard || !e || !isDone(e) || !e.market_history) return '';
    const html = K.marketHistoryCard(e, { placement });
    if (!html) return '';
    return `<div class="kx-nfl kx-nfl--history" data-kx-nfl="${esc(placement)}">${html}${tieNote(e)}</div>`;
  }

  /* Result-card line for a FINAL game (board entry). Empty when nothing was recorded. */
  function closeLine(entry, { id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    if (!K?.marketCloseLine || !e) return '';
    return K.marketCloseLine(e) || '';
  }

  /* PBEcast module: lifecycle label over the full compact card, or the history
     card once the market has CLOSED / SETTLED. [phase key, label] or null. */
  function castPhase(entry, phase) {
    if (!entry) return null;
    const lc = lifecycleOf(entry);
    if (lc === 'SETTLED') return ['settled', 'MARKET SETTLED'];
    if (lc === 'CLOSED') return ['closed', 'MARKET CLOSED · AWAITING SETTLEMENT'];
    if (phase === 'final') return ['final-open', 'GAME FINAL · MARKET STILL TRADING'];
    if (phase === 'live') return entry.kalshi?.freshness === 'stale' ? ['stale', 'MARKET OPEN · QUOTE STALE'] : ['live', 'LIVE MARKET'];
    if (phase === 'pregame') return ['pre', 'MARKET OPEN · PRE-MATCH'];
    return null;
  }
  function castModule(entry, phase, { colors = {}, id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    const p = castPhase(e, phase);
    if (!K || !p) return '';
    /* closed / settled: the history card; without a stored history yet, the settled card (never nothing after the final) */
    const body = (isDone(e) ? history(e, { placement: 'pbecast-history', id, K }) : '') || card(e, { placement: 'pbecast', colors, id, compact: true, K });
    if (!body) return '';
    return `<div class="cast-mkt" data-phase="${p[0]}"><div class="cast-mkt-phase"><span class="cast-mkt-dot" aria-hidden="true"></span>${esc(p[1])}</div>${body}</div>`;
  }

  /* PBEcast rail footer text: exact event + both ESPN team ids (away / home order),
     and only what a game card would show (kalshiLine). Not on final games. */
  const cents = bp => `${(bp / 100).toFixed(1)}¢`;
  function railText(entry, game, K = ui()) {
    if (!K || !entry || !game) return '';
    const s = String(game.status?.semantics || '').toUpperCase();
    if (s !== 'LIVE' && s !== 'SCHEDULE') return '';
    if (String(entry.event?.canonical_event_id ?? '') !== String(game.id)) return '';
    if (!K.kalshiLine(entry)) return '';
    const outs = entry.kalshi?.outcomes || [];
    if (outs.length !== 2) return '';
    const away = outs.find(o => o.role === 'away'), home = outs.find(o => o.role === 'home');
    const a = game.teams?.away, h = game.teams?.home;
    if (!away || !home || a?.id == null || h?.id == null) return '';
    if (String(away.team_id) !== String(a.id) || String(home.team_id) !== String(h.id)) return '';
    if (!Number.isFinite(away.mid_bp) || !Number.isFinite(home.mid_bp)) return '';
    return `${a.abbreviation || away.abbr} ${cents(away.mid_bp)} · ${h.abbreviation || home.abbr} ${cents(home.mid_bp)}`;
  }
  function railMarkup(text) {
    return `<em class="kx-nfl-rail" title="Kalshi prediction market · Mid-market (not sportsbook odds)"><b>MKT</b><span>${esc(text)}</span></em>`;
  }
  /* write / update / remove one rail button's footer in place; nothing else changes */
  function patchRailChip(btn, text) {
    const el = btn.querySelector('.kx-nfl-rail');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { btn.insertAdjacentHTML('beforeend', railMarkup(text)); return; }
    const px = el.querySelector('span');
    if (px && px.textContent !== text) px.textContent = text;
  }

  /* Next read for the selected game: SETTLED -> none; CLOSED -> 5 min; a FINAL
     game whose market is still open -> idle cadence until it closes; a FINAL game
     with no market -> none; otherwise the client's live/pregame/idle cadence. */
  function nextPollMs(entry, phase, K) {
    const lc = lifecycleOf(entry);
    if (lc === 'SETTLED') return null;
    if (lc === 'CLOSED') return CLOSED_POLL_MS;
    if (phase === 'final') return entry ? K.client.pollMsFor('idle') : null;
    return entry ? K.client.pollMsFor(phase) : K.client.pollMsFor('idle');
  }

  /* ---- Games board ------------------------------------------------------------ */
  function loadBoard() {
    return ready().then(K => (K ? K.client.loadBoard() : null)).catch(() => null);
  }
  function lineFor(eventId, opts = {}) {
    const K = ui();
    if (!K?.client) return '';
    const e = K.client.forEvent(eventId);
    return opts.final ? closeLine(e, { id: eventId, K }) : line(e, { ...opts, id: eventId, K });
  }
  function wire(host) { try { ui()?.wireKalshi?.(host); } catch (_) {} }

  /* ---- PBEcast ------------------------------------------------------------------ */
  /* One selected game at a time. The read starts the moment PBEcast knows the
     game (in parallel with v6's own lanes, never in front of them) and is then
     polled at the client's cadence for the game's phase — live 20 s, pregame
     45 s — while that game stays selected and PBEcast stays mounted. A FINAL
     game is read too: its history card follows the market to CLOSED (5 min)
     and SETTLED (no more reads) with no release. */
  const cast = { id: null, phase: null, entry: null, timer: null, seq: 0, built: { module: null } };
  const castMounted = () => Boolean(root.document?.querySelector?.('.pbecast6'));
  const phaseOf = g => { const s = String(g?.status?.semantics || '').toUpperCase(); return s === 'LIVE' ? 'live' : s === 'SCHEDULE' ? 'pregame' : s === 'FINAL' ? 'final' : null; };

  function castStop() {
    clearTimeout(cast.timer); cast.timer = null; cast.seq += 1;
    cast.id = null; cast.phase = null; cast.entry = null; cast.built = { module: null };
  }
  function castArm(delay) {
    clearTimeout(cast.timer);
    const seq = cast.seq;
    cast.timer = setTimeout(() => {
      if (seq !== cast.seq) return;
      if (!castMounted()) { castStop(); return; }
      if (root.document?.visibilityState === 'hidden') { castArm(delay); return; }
      castFetch();
    }, delay);
  }
  async function castFetch() {
    const seq = cast.seq, id = cast.id;
    if (!id || !cast.phase) return;
    const K = await ready();
    if (!K || seq !== cast.seq) return;
    let entry = null;
    try { entry = forId(await K.client.loadEvent(id), id); } catch (_) { entry = cast.entry; }
    if (seq !== cast.seq) return;
    if (entry !== cast.entry) { cast.entry = entry; root.PBEcastCommand?.render?.(); }
    /* no market yet: look again at the idle cadence; never stops PBEcast */
    const ms = nextPollMs(entry, cast.phase, K);
    if (ms != null) castArm(ms); else clearTimeout(cast.timer);
  }
  function castSync(id, phase) {
    id = id ? String(id) : '';
    if (!id || !phase) { if (cast.id) castStop(); return; }
    if (id !== cast.id) {
      castStop();
      cast.id = id; cast.phase = phase;
      /* a board already read elsewhere (Games) paints immediately; a FINAL game
         waits for the event read (the board carries no market_history) */
      cast.entry = phase === 'final' ? null : forId(ui()?.client?.forEvent?.(id) || null, id);
      castFetch();
      return;
    }
    if (phase !== cast.phase) { cast.phase = phase; castArm(0); }
  }

  /* Called by pbecast-command-v1.js render() with its host node and v6 state. */
  function castMount(host, v6) {
    if (!host) return;
    const g = v6?.detail?.game;
    const id = String(v6?.activeId || '');
    const own = g && id && String(g.id) === id;
    const phase = own ? phaseOf(g) : null;
    castSync(own ? id : '', phase);
    let html = '';
    if (own && cast.entry && cast.id === id) {
      /* the markup is rebuilt only for a NEW observation (or a phase change), so
         a v6 repaint neither replays nor cuts short the component's change flash */
      const b = cast.built.module;
      if (!b || b.entry !== cast.entry || b.phase !== phase) {
        cast.built.module = { entry: cast.entry, phase, html: castModule(cast.entry, phase, { colors: colorsFor(g.teams), id }) };
      }
      html = cast.built.module.html;
    }
    if (host.dataset.sig !== html) {
      host.innerHTML = html;
      host.dataset.sig = html;
      if (html) wire(host);
    }
    railRefresh(v6);
  }

  /* PBEcast rail: ONE shared-client board read per refresh (15 s TTL, one
     in-flight request; a render inside the TTL reuses it), off v6's lanes. */
  let railInFlight = false;
  function railApply(v6) {
    const K = ui();
    const scope = root.document?.querySelector?.('.pbecast6');
    if (!K?.client || !scope) return;
    const games = new Map();
    for (const gm of [...(v6?.scoreboard?.games || []), v6?.detail?.game].filter(Boolean)) games.set(String(gm.id), gm);
    /* the Sunday board tiles (the visible game rail) and v6's own rail buttons */
    scope.querySelectorAll('.pbecb-tile[data-game], [data-cast6-rail] button[data-game]').forEach(btn => {
      const gm = games.get(String(btn.dataset.game));
      patchRailChip(btn, gm ? railText(K.client.forEvent(gm.id), gm, K) : '');
    });
  }
  function railRefresh(v6) {
    railApply(v6);
    if (railInFlight || typeof root.document === 'undefined') return;
    railInFlight = true;
    ready().then(K => (K ? K.client.loadBoard() : null)).then(() => railApply(root.PBEcastV6?.state || v6)).catch(() => {}).finally(() => { railInFlight = false; });
  }

  if (typeof root.document !== 'undefined') {
    root.addEventListener('pbe:route-changed', () => setTimeout(() => { if (!castMounted()) castStop(); }, 0));
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.visibilityState !== 'hidden' && cast.id && castMounted() && lifecycleOf(cast.entry) !== 'SETTLED') castArm(0);
    });
    /* the board read starts as soon as the component is ready, so rail footers are
       usually present in the first board paint (no tile growth after it) */
    ready().then(K => { if (K && castMounted()) { K.client.loadBoard().catch(() => null); root.PBEcastCommand?.render?.(); } });
  }

  return {
    ready, loadBoard, lineFor, wire, tieNote, card, strip, line, history, closeLine, nextPollMs, colorsFor,
    castPhase, castModule, railText, patchRailChip,
    pbecast: { mount: castMount, sync: castSync, stop: castStop, state: cast },
    TIE_NOTE, TIE_PROPOSITION, CLOSED_POLL_MS
  };
});
