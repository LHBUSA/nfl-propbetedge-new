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
 *   PBEcast   LIVE      kalshiStrip(entry, { placement: 'pbecast' }) under the hero
 *             SCHEDULE  the full kalshiCard after the pregame preview row — its own
 *                       section, next to (never inside) the sportsbook MARKET tile
 *   Games     kalshiLine on each not-final game card, from one board read
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
    if (entry?.kalshi?.proposition !== TIE_PROPOSITION) return '';
    return `<p class="kx-nfl-tie"><b>NFL tie rule</b> ${esc(TIE_NOTE)}</p>`;
  }
  /* entry is shown only for the event it belongs to */
  const forId = (entry, id) => (entry && (!id || String(entry.event?.canonical_event_id) === String(id)) ? entry : null);

  /* Full card + the NFL tie note beside it. */
  function card(entry, { placement = 'pbecast-preview', colors = {}, id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    if (!K || !e) return '';
    const html = K.kalshiCard(e, { placement, colors });
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

  /* Restrained game-card line. Never on a final game. */
  function line(entry, { final = false, id = null, K = ui() } = {}) {
    const e = forId(entry, id);
    if (final || !K || !e || e.event?.state === 'post') return '';
    return K.kalshiLine(e) || '';
  }

  /* ---- Games board ------------------------------------------------------------ */
  function loadBoard() {
    return ready().then(K => (K ? K.client.loadBoard() : null)).catch(() => null);
  }
  function lineFor(eventId, opts = {}) {
    const K = ui();
    return K?.client ? line(K.client.forEvent(eventId), { ...opts, id: eventId, K }) : '';
  }
  function wire(host) { try { ui()?.wireKalshi?.(host); } catch (_) {} }

  /* ---- PBEcast ------------------------------------------------------------------ */
  /* One selected game at a time. The read starts the moment PBEcast knows the
     game (in parallel with v6's own lanes, never in front of them) and is then
     polled at the client's cadence for the game's phase — live 20 s, pregame
     45 s — while that game stays selected and PBEcast stays mounted. */
  const cast = { id: null, phase: null, entry: null, timer: null, seq: 0, open: false, built: { strip: null, card: null } };
  const castMounted = () => Boolean(root.document?.querySelector?.('.pbecast6'));
  const phaseOf = g => { const s = String(g?.status?.semantics || '').toUpperCase(); return s === 'LIVE' ? 'live' : s === 'SCHEDULE' ? 'pregame' : s === 'FINAL' ? 'final' : null; };

  function castStop() {
    clearTimeout(cast.timer); cast.timer = null; cast.seq += 1;
    cast.id = null; cast.phase = null; cast.entry = null; cast.open = false; cast.built = { strip: null, card: null };
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
    if (!id || cast.phase === 'final' || !cast.phase) return;
    const K = await ready();
    if (!K || seq !== cast.seq) return;
    let entry = null;
    try { entry = forId(await K.client.loadEvent(id), id); } catch (_) { entry = cast.entry; }
    if (seq !== cast.seq) return;
    if (entry !== cast.entry) { cast.entry = entry; root.PBEcastCommand?.render?.(); }
    /* no market yet: look again at the idle cadence; never stops PBEcast */
    castArm(entry ? K.client.pollMsFor(cast.phase) : K.client.pollMsFor('idle'));
  }
  function castSync(id, phase) {
    id = id ? String(id) : '';
    if (!id || !phase || phase === 'final') { if (cast.id) castStop(); return; }
    if (id !== cast.id) {
      castStop();
      cast.id = id; cast.phase = phase;
      /* a board already read elsewhere (Games) paints immediately */
      cast.entry = forId(ui()?.client?.forEvent?.(id) || null, id);
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
      const colors = colorsFor(g.teams);
      const kind = phase === 'live' ? 'strip' : phase === 'pregame' ? 'card' : null;
      if (kind) {
        /* the markup is rebuilt only for a NEW observation, so a v6 repaint
           neither replays nor cuts short the component's change flash */
        const b = cast.built[kind];
        if (!b || b.entry !== cast.entry) {
          cast.built[kind] = { entry: cast.entry, html: kind === 'strip' ? strip(cast.entry, { placement: 'pbecast', colors, id }) : card(cast.entry, { placement: 'pbecast-preview', colors, id }) };
        }
        html = cast.built[kind].html;
        if (kind === 'strip' && cast.open) html = html.replace('<details class="kx-strip"', '<details open class="kx-strip"');
      }
    }
    if (host.dataset.sig === html) return;
    host.innerHTML = html;
    host.dataset.sig = html;
    if (html) wire(host);
  }

  if (typeof root.document !== 'undefined') {
    root.document.addEventListener('toggle', e => {
      if (e.target?.classList?.contains('kx-strip') && e.target.closest?.('.pbecast6')) cast.open = e.target.open;
    }, true);
    root.addEventListener('pbe:route-changed', () => setTimeout(() => { if (!castMounted()) castStop(); }, 0));
    root.document.addEventListener('visibilitychange', () => {
      if (root.document.visibilityState !== 'hidden' && cast.id && castMounted()) castArm(0);
    });
    ready().then(K => { if (K && castMounted()) root.PBEcastCommand?.render?.(); });
  }

  return {
    ready, loadBoard, lineFor, wire, tieNote, card, strip, line, colorsFor,
    pbecast: { mount: castMount, sync: castSync, stop: castStop, state: cast },
    TIE_NOTE, TIE_PROPOSITION
  };
});
