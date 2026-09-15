/* PropBetEdge NFL — the one way into PBEcast for a chosen game.
 *
 * Every surface that opens a specific game (Dashboard hero and cards, Games
 * cards, the top score rail, PBE Picks cards, What Changed, PropChain, breaking
 * alerts) calls PBEGameHandoff.open(espnEventId, {kickoff, play_id, source}).
 *
 * The contract is a one-shot session request, 'pbe.pbecast.focus', written
 * before navigating. PBEcast v6 consumes it exactly once when the route mounts
 * (App.nav re-runs the view on the same route too, so a click made while
 * PBEcast is open takes the same path) and treats the id as an EXPLICIT
 * selection: no board, date, persisted game or provider week can replace it.
 * A copy is held in memory so a browser that refuses sessionStorage still
 * opens the chosen game.
 *
 * Identity is the ESPN event id only. Nothing here chooses a game.
 */
(() => {
  'use strict';
  const KEY = 'pbe.pbecast.focus';
  const validId = id => /^\d{6,12}$/.test(String(id ?? '').trim());
  let pending = null;

  function open(id, opts = {}) {
    const gameId = String(id ?? '').trim();
    if (!validId(gameId)) return false;
    pending = {
      game_id: gameId,
      kickoff: opts.kickoff || null,
      play_id: opts.play_id ? String(opts.play_id) : null,
      source: opts.source || null,
      at: Date.now()
    };
    try { sessionStorage.setItem(KEY, JSON.stringify(pending)); } catch (_) {}
    if (typeof window.App?.nav === 'function') window.App.nav('pbecast');
    else location.hash = 'pbecast';
    return true;
  }

  /* Consumed exactly once. The session copy wins (it survives a reload that
     happens between the click and the mount); the memory copy is the fallback. */
  function take() {
    let req = null;
    try { const raw = sessionStorage.getItem(KEY); if (raw) { sessionStorage.removeItem(KEY); req = JSON.parse(raw); } } catch (_) {}
    req = req || pending;
    pending = null;
    return req && validId(req.game_id) ? { ...req, game_id: String(req.game_id) } : null;
  }

  window.PBEGameHandoff = { KEY, open, take, validId };
})();
