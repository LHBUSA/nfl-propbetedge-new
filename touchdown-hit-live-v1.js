/* PropBetEdge NFL — TOUCHDOWN TARGET HIT, the browser half.
 *
 * THIS FILE DETECTS NOTHING. The one detector is the Cloudflare Worker
 * nfl-touchdown-target-hit-alerts; the one record is nfl_td_target_hit_events.
 * This module only:
 *   - reads GET /api/pbe-touchdown-targets?view=hits&since=<cursor>
 *   - reshapes each event for the rail
 *   - hands it to window.PBEBreaking.offer(), the ONE global alert queue,
 *     whose session memory already guarantees an event is shown once per
 *     session and never replayed by a route change or a reload
 * It writes nothing anywhere: no database, no webhook, no Slack, no Discord.
 *
 * NO BACKFILL. The first read asks only for the last three minutes, so opening
 * the site in the evening does not celebrate an afternoon touchdown. After
 * that the cursor is the newest detected_at seen, kept for the session.
 */
(() => {
  'use strict';
  const ENDPOINT = '/api/pbe-touchdown-targets?view=hits';
  const POLL_MS = 10000;
  const INITIAL_WINDOW_MS = 3 * 60 * 1000;
  const CURSOR_KEY = 'pbe.tdhit.cursor.v1';

  let cursor = null;
  let timer = null;
  let inflight = false;

  function readCursor() {
    try {
      const raw = sessionStorage.getItem(CURSOR_KEY);
      const t = Date.parse(raw || '');
      /* A cursor older than the initial window is not reused: a tab reopened
         hours later starts fresh rather than replaying the gap. */
      if (Number.isFinite(t) && Date.now() - t <= INITIAL_WINDOW_MS) return new Date(t).toISOString();
    } catch (_) {}
    return new Date(Date.now() - INITIAL_WINDOW_MS).toISOString();
  }
  function saveCursor(value) {
    cursor = value;
    try { sessionStorage.setItem(CURSOR_KEY, value); } catch (_) {}
  }

  /* Shape only. Every value is the server's; nothing is decided here. */
  function toRailEvent(hit) {
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
      const since = cursor || readCursor();
      const r = await fetch(`${ENDPOINT}&since=${encodeURIComponent(since)}`,
        { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      const hits = Array.isArray(j.hits) ? j.hits : [];
      for (const hit of hits) {
        if (hit && hit.pick_id) window.PBEBreaking.offer(toRailEvent(hit));
      }
      saveCursor(typeof j.cursor === 'string' && j.cursor ? j.cursor : since);
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

  window.PBETouchdownHits = { start, stop, poll, _test: { toRailEvent, readCursor, CURSOR_KEY, POLL_MS, INITIAL_WINDOW_MS } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
