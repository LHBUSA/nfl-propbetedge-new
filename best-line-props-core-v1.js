/* PropBetEdge NFL — Best Line player-props core.
 *
 * Pure decisions, no I/O and no DOM. best-line-v1.js owns fetching and
 * rendering; this file decides which games the Player Props selector offers,
 * which one it opens by default, and what a board's prices may be called.
 *
 *   · a game that has kicked off stays selectable when nfl-odds holds a
 *     verified pre-game player board for it, and is labelled KICKED OFF
 *   · a game that has not kicked off is always selectable, props or not, so a
 *     NOT_OFFERED_AT_INGEST answer stays visible and truthful
 *   · the default is the game nearest to now that has player-prop coverage,
 *     never the first future game whose props have not been posted
 *   · every served market carries its own captured_at; nothing is ever
 *     called live or current after kickoff
 */
(function (root) {
  'use strict';

  const AVAILABILITY = Object.freeze({
    current: 'IN_SNAPSHOT',
    verified: 'LAST_VERIFIED_PREGAME_SNAPSHOT',
    never: 'NOT_OFFERED_AT_INGEST',
    notRequested: 'NOT_REQUESTED_BY_INGEST',
  });
  const KICKED_OFF_LABEL = 'KICKED OFF — PRE-GAME MARKET SNAPSHOT';

  const arr = v => (Array.isArray(v) ? v : []);
  const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : NaN; };

  /* A coverage payload counts only when nfl-odds v3.1+ produced it. An older
     worker answers the same path with its featured slate, which says nothing
     about player props. */
  function coverageUsable(coverage) { return coverage?.semantics === 'PLAYER_PROP_COVERAGE' && Array.isArray(coverage?.events); }

  /* Join Best Line's game list with nfl-odds prop coverage. Without usable
     coverage a started game stays listed: its board read is authoritative and
     says what it holds. */
  function propEvents(events, coverage, nowMs) {
    const usable = coverageUsable(coverage);
    const byId = new Map(usable ? coverage.events.map(c => [String(c.id), c]) : []);
    return arr(events)
      .map(e => {
        const c = byId.get(String(e?.id));
        const kickoff = ms(e?.kickoff || e?.commence_time || c?.commence_time);
        const current = arr(c?.current_markets);
        const verified = arr(c?.verified_markets);
        return {
          id: String(e?.id || ''),
          away: e?.away || c?.away_team || '',
          home: e?.home || c?.home_team || '',
          kickoff: Number.isFinite(kickoff) ? new Date(kickoff).toISOString() : null,
          started: Number.isFinite(kickoff) ? kickoff <= nowMs : Boolean(e?.started),
          markets: new Set([...current, ...verified]),
          coverage_known: Boolean(c),
        };
      })
      .filter(e => e.id && (!e.started || e.markets.size > 0 || !usable))
      .sort((a, b) => (ms(a.kickoff) || 0) - (ms(b.kickoff) || 0));
  }

  /* Nearest game to now with coverage for the chosen market, then with any
     player-prop coverage, then the next game that has not kicked off. Ties go
     to a game whose prices can still be taken. */
  function defaultEvent(list, market, nowMs) {
    const nearest = pool => pool.slice().sort((a, b) =>
      Math.abs((ms(a.kickoff) || 0) - nowMs) - Math.abs((ms(b.kickoff) || 0) - nowMs)
      || Number(a.started) - Number(b.started))[0] || null;
    return nearest(list.filter(e => e.markets.has(market)))
      || nearest(list.filter(e => e.markets.size > 0))
      || list.find(e => !e.started)
      || list[0]
      || null;
  }

  /* Keep an explicit choice while it is still offered; otherwise the default. */
  function resolveSelection(list, selectedId, market, nowMs) {
    if (selectedId && list.some(e => e.id === String(selectedId))) return String(selectedId);
    return defaultEvent(list, market, nowMs)?.id || null;
  }

  /* What a board lets the page say about one market. */
  function marketState(board, market, nowMs) {
    const availability = board?.market_availability?.[market] || null;
    const provenance = board?.market_provenance?.[market] || null;
    const kickoff = ms(board?.event?.commence_time);
    const started = board?.event?.started === true || (Number.isFinite(kickoff) && kickoff <= nowMs);
    const quotes = arr(board?.quotes).filter(q => q?.market === market);
    const served = availability === AVAILABILITY.current || availability === AVAILABILITY.verified;
    let headline = null;
    if (served && started) headline = KICKED_OFF_LABEL;
    else if (availability === AVAILABILITY.verified) headline = 'LAST VERIFIED PRE-GAME SNAPSHOT';
    else if (availability === AVAILABILITY.current) headline = 'MARKET SNAPSHOT';
    return {
      availability, started, served, quotes, headline,
      captured_at: served ? (provenance?.captured_at || null) : null,
      captured_at_et: served ? (provenance?.captured_at_et || null) : null,
      batch_id: served ? (provenance?.batch_id || null) : null,
      /* a legacy board (pre nfl-odds v3.1) has no per-market provenance; it
         can never claim a capture time it did not record */
      provenance_missing: served && !provenance,
      live: false,
    };
  }

  root.PBEBestLinePropsCore = { version: 1, AVAILABILITY, KICKED_OFF_LABEL, coverageUsable, propEvents, defaultEvent, resolveSelection, marketState };
})(typeof window !== 'undefined' ? window : globalThis);
