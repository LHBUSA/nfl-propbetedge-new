/* PropBetEdge NFL — TOUCHDOWN TARGET HIT, the browser half.
 *
 * THIS FILE DETECTS NOTHING. The one detector is the Cloudflare Worker
 * nfl-touchdown-target-hit-alerts; the one record is nfl_td_target_hit_events.
 * This module only:
 *   - reads GET /api/pbe-touchdown-targets?view=hits
 *   - reshapes each event for the rail
 *   - hands it to window.PBEBreaking.offer(), the ONE global alert queue,
 *     whose session memory already guarantees an event is shown once per
 *     session and never replayed by a route change or a reload
 * It writes nothing anywhere: no database, no webhook, no Slack, no Discord.
 *
 * THE CURSOR IS THE EVENT ID. The first read is a BOOTSTRAP: since=<now - 3
 * minutes>, so opening the site in the evening does not celebrate an afternoon
 * touchdown. Its next_cursor is an event id, and every read after it is
 * after_id=<id> — never a timestamp again. The id cursor is kept in session
 * (with the time it was last confirmed) so a reload continues from it; a
 * cursor not confirmed within the bootstrap window is dropped and the tab
 * bootstraps afresh rather than replaying the gap. The rail's tdhit:<pick_id>
 * session dedupe stays underneath as the UI safety net.
 */
(() => {
  'use strict';
  const ENDPOINT = '/api/pbe-touchdown-targets?view=hits';
  const POLL_MS = 10000;
  const INITIAL_WINDOW_MS = 3 * 60 * 1000;
  const CURSOR_KEY = 'pbe.tdhit.after_id.v2';

  let afterId = null;     // event id; null until the bootstrap has answered
  let timer = null;
  let inflight = false;

  function readCursor() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CURSOR_KEY) || 'null');
      if (saved && Number.isSafeInteger(saved.id) && saved.id >= 0
          && Number.isFinite(saved.at) && Date.now() - saved.at <= INITIAL_WINDOW_MS) return saved.id;
    } catch (_) {}
    return null;
  }
  function saveCursor(id) {
    afterId = id;
    try { sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ id, at: Date.now() })); } catch (_) {}
  }
  /* The next cursor may never pass an event this response did not return. */
  function nextCursorFrom(j, events, current) {
    const ids = events.map(e => Number(e.id)).filter(Number.isSafeInteger);
    const next = Number(j && j.next_cursor);
    if (ids.length) {
      const maxReturned = Math.max(...ids);
      return Number.isSafeInteger(next) && next <= maxReturned && next >= (current ?? 0) ? next : maxReturned;
    }
    /* nothing returned: a bootstrap adopts the server's high-water id; an
       incremental read stays exactly where it was */
    if (current === null) return Number.isSafeInteger(next) && next >= 0 ? next : null;
    return current;
  }

  /* Shape only. Every value is the server's; nothing is decided here. */
  /* A locked reader's event is a generic notice from the server: an id and
     fixed copy. There is no game, player or play in it to show. */
  function toLockedRailEvent(hit) {
    const PR = window.PBEBreaking && window.PBEBreaking.PRIORITY;
    const CFG = window.PBEBreaking && window.PBEBreaking.CONFIG;
    return {
      key: `tdhit:locked:${hit.id}`,
      family: 'GAME', kind: 'TD_TARGET_HIT', locked: true,
      priority: PR && PR.TD_TARGET_HIT !== undefined ? PR.TD_TARGET_HIT : 2.5,
      label: 'PBE TOUCHDOWN TARGET HIT',
      live: true,
      headline: String(hit.headline || 'One of PBE’s Touchdown Targets just scored.'),
      detail: String(hit.detail || 'Unlock All Access Pro to see the player and model details.'),
      cta: [{ label: 'UNLOCK ALL ACCESS PRO', kind: 'upgrade' }, { label: 'SEE THE RECORD', route: 'trackrecord', kind: 'route' }],
      visible_ms: (CFG && CFG.visible_ms && CFG.visible_ms.TD_TARGET_HIT) || 26000,
      provenance: { semantics: 'LIVE TARGET HIT (identity is Pro)', source: '/api/pbe-touchdown-targets?view=hits' }
    };
  }

  function toRailEvent(hit) {
    if (hit && hit.access === 'locked') return toLockedRailEvent(hit);
    const g = hit.game || {}, pl = hit.player || {}, t = hit.target || {}, play = hit.play || {};
    const cta = [];
    if (/^\d{6,12}$/.test(String(g.espn_id || ''))) {
      cta.push({ label: 'WATCH IN PBECAST', route: 'pbecast', game_id: String(g.espn_id),
                 play_id: play.id || null, kind: 'pbecast' });
    }
    cta.push({ label: 'VIEW TOUCHDOWN TARGETS', route: 'tdtargets', kind: 'route' });
    const PR = window.PBEBreaking && window.PBEBreaking.PRIORITY;
    const CFG = window.PBEBreaking && window.PBEBreaking.CONFIG;
    return {
      key: `tdhit:${hit.pick_id}`,
      family: 'GAME', kind: 'TD_TARGET_HIT',
      priority: PR && PR.TD_TARGET_HIT !== undefined ? PR.TD_TARGET_HIT : 2.5,
      label: t.rank === 'secondary' ? 'SECONDARY TARGET HIT' : 'TOUCHDOWN TARGET HIT',
      live: true,
      headline: `${pl.name || ''} · ${t.rank === 'secondary' ? 'secondary' : 'primary'} target scored`,
      game: { id: g.espn_id, away: g.away, home: g.home, away_score: g.away_score,
              home_score: g.home_score, period: g.period, clock: g.clock },
      player: { name: pl.name, espn_id: pl.espn_id, gsis_id: pl.gsis_id || null, position: pl.position,
                team: pl.team, opponent: pl.opponent, headshot_url: pl.headshot_url || null },
      target: { rank: t.rank, publication_scope: t.publication_scope, scope_label: t.scope_label,
                model_prob: t.model_prob, market_price: t.market_price },
      play: { id: play.id, type: play.type, text: play.text, yards: play.yards, wallclock: play.wallclock },
      live_stats: hit.live_stats || {},
      cta,
      visible_ms: (CFG && CFG.visible_ms && CFG.visible_ms.TD_TARGET_HIT) || 26000,
      provenance: {
        semantics: 'LIVE TARGET HIT', pick_id: hit.pick_id, detected_at: hit.detected_at,
        source: 'nfl_td_target_hit_events via /api/pbe-touchdown-targets?view=hits',
        detection: 'server-side only (nfl-touchdown-target-hit-alerts); the browser detects nothing',
        settlement: 'live hit; the final result settles after the game'
      }
    };
  }

  async function poll() {
    if (inflight || !window.PBEBreaking || typeof window.PBEBreaking.offer !== 'function') return;
    inflight = true;
    try {
      if (afterId === null) afterId = readCursor();
      const query = afterId !== null
        ? `after_id=${afterId}`
        : `since=${encodeURIComponent(new Date(Date.now() - INITIAL_WINDOW_MS).toISOString())}`;
      const r = await fetch(`${ENDPOINT}&${query}`,
        { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      const events = Array.isArray(j.events) ? j.events : [];
      for (const hit of events) {
        if (hit && hit.access === 'locked' && Number.isSafeInteger(Number(hit.id))) {
          window.PBEBreaking.offer(toRailEvent(hit));
        } else if (hit && hit.pick_id) {
          window.PBEBreaking.offer(toRailEvent(hit));
          /* PBEcast's Touchdown Targets card reads its game now instead of on
             its next cadence tick. A hint only: the card re-reads the server. */
          try { window.dispatchEvent(new CustomEvent('pbe:td-target-hit', { detail: { espn_id: String(hit.game?.espn_id || ''), pick_id: hit.pick_id } })); } catch (_) {}
        }
      }
      const next = nextCursorFrom(j, events, afterId);
      if (next !== null) saveCursor(next);
    } catch (_) {
      /* silence: the rail never reports its own plumbing */
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(() => { if (document.visibilityState === 'visible') poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  }
  function stop() { clearInterval(timer); timer = null; }

  window.PBETouchdownHits = { start, stop, poll, _test: { toRailEvent, readCursor, nextCursorFrom, cursor: () => afterId, CURSOR_KEY, POLL_MS, INITIAL_WINDOW_MS } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
