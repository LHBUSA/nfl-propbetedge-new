/* PropBetEdge NFL — broadcast / where-to-watch client (v1)
 *
 * The one browser owner of TV network labels. It renders what the canonical
 * schedule authority (nfl-schedule, via the gateway's /api/schedule) says a
 * game's broadcast is. It never talks to ESPN or to a broadcaster, never maps
 * a weekday or time slot to a network, and never builds a URL: a link is shown
 * only when the authority hands over a verified destination AND that
 * destination's host is on the provider's allow-list below.
 *
 *   PBEBroadcast.html(broadcast, {away, home, mode, lead})  -> label HTML
 *   PBEBroadcast.slot({event | game | away+home+kickoff, ...}) -> label HTML,
 *       or an empty placeholder filled in once /api/schedule has loaded
 *   PBEBroadcast.text(broadcast)                            -> plain text
 *
 * mode 'link' (default) makes each network with a verified destination a
 * secondary external link; mode 'text' is for labels that sit inside a
 * button (score rail chips, board tiles), where a nested link is invalid.
 * States: VERIFIED/STALE -> network(s); UNASSIGNED -> "TV TBA";
 * UNAVAILABLE / missing -> nothing.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const TTL_MS = 10 * 60000;
  const RETRY_MS = 5 * 60000;

  /* Must equal workers/nfl-schedule/broadcasters.js hosts (enforced by
     tests/nfl-schedule-broadcast.test.mjs). */
  const HOSTS = {
    cbs: ['www.cbs.com', 'www.cbssports.com'],
    fox: ['www.foxsports.com'],
    nbc: ['www.nbcsports.com'],
    espn: ['www.espn.com'],
    abc: ['abc.com'],
    nfl_network: ['www.nfl.com'],
    prime_video: ['www.amazon.com', 'www.primevideo.com'],
    peacock: ['www.peacocktv.com'],
    netflix: ['www.netflix.com']
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const state = { loadedAt: 0, promise: null, error: null, disabled: false, games: [], byEvent: new Map(), byGame: new Map() };

  function safeUrl(d) {
    if (!d || typeof d !== 'object' || d.verified !== true) return null;
    const hosts = HOSTS[d.provider_id];
    if (!hosts) return null;
    let u;
    try { u = new URL(String(d.url)); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname)) return null;
    return u.href;
  }

  function names(b) {
    return [...arr(b.networks), ...arr(b.streaming), ...arr(b.unclassified)].map(n => String(n ?? '').trim()).filter(Boolean)
      .filter((n, i, all) => all.indexOf(n) === i);
  }

  function text(b) {
    if (typeof b === 'string') return b.trim();
    if (!b || typeof b !== 'object') return '';
    if (b.status === 'VERIFIED' || b.status === 'STALE') return names(b).join(' / ');
    if (b.status === 'UNASSIGNED') return 'TV TBA';
    return '';
  }

  function html(b, opts = {}) {
    const lead = opts.lead || '';
    const mode = opts.mode === 'text' ? 'text' : 'link';
    if (typeof b === 'string') return b.trim() ? `${esc(lead)}<span class="pbe-tv"><span class="pbe-tv-name">${esc(b.trim())}</span></span>` : '';
    if (!b || typeof b !== 'object') return '';
    if (b.status === 'UNASSIGNED') return `${esc(lead)}<span class="pbe-tv is-tba" data-broadcast-status="UNASSIGNED">TV TBA</span>`;
    if (b.status !== 'VERIFIED' && b.status !== 'STALE') return '';
    const list = names(b);
    if (!list.length) return '';
    const dests = arr(b.destinations);
    const matchup = opts.away && opts.home ? `${opts.away} at ${opts.home}` : 'this game';
    const parts = list.map(name => {
      const d = dests.find(x => x && x.provider === name);
      const href = mode === 'link' ? safeUrl(d) : null;
      if (!href) return `<span class="pbe-tv-name">${esc(name)}</span>`;
      return `<a class="pbe-tv-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`Watch / view ${matchup} broadcast information on ${name} (opens ${name} in a new tab)`)}">${esc(name)}<span class="pbe-tv-ext" aria-hidden="true">↗</span></a>`;
    });
    return `${esc(lead)}<span class="pbe-tv" data-broadcast-status="${esc(b.status)}"${b.verified_at ? ` title="${esc(`TV: ${list.join(' / ')} · verified ${b.verified_at}`)}"` : ''}>${parts.join('<span class="pbe-tv-sep"> / </span>')}</span>`;
  }

  /* ---- identity --------------------------------------------------------- */
  const SCHEDULE_CODE = { LAR: 'LA' };
  const DIRECTORY_CODE = { LA: 'LAR' };
  function teams() { try { return window.NFL_TEAMS || (typeof NFL_TEAMS !== 'undefined' ? NFL_TEAMS : {}); } catch { return {}; } }
  function scheduleCode(nameOrCode) {
    const text = String(nameOrCode ?? '').trim().toLowerCase();
    if (!text) return null;
    const all = Object.values(teams());
    const hit = all.find(t => text === String(t.abbr || '').toLowerCase() || text === String(t.name || '').toLowerCase());
    if (hit) return SCHEDULE_CODE[hit.abbr] || hit.abbr;
    if (text === 'la') return 'LA';
    return null;
  }
  function teamName(code) { const t = teams()[DIRECTORY_CODE[code] || code]; return t?.name || code; }
  function easternDate(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const g = k => p.find(x => x.type === k)?.value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }

  function ingest(payload) {
    const games = arr(payload?.games).filter(g => g && typeof g === 'object' && g.broadcast && typeof g.broadcast === 'object');
    if (!games.length) return false;
    state.games = games;
    state.byEvent = new Map(games.filter(g => g.espn_event_id).map(g => [String(g.espn_event_id), g]));
    state.byGame = new Map(games.map(g => [String(g.game_id), g]));
    state.loadedAt = Date.now();
    state.error = null;
    state.promise = Promise.resolve(state);
    try { window.dispatchEvent(new CustomEvent('pbe:broadcast-ready')); } catch {}
    return true;
  }

  function load(force = false) {
    const fresh = Date.now() - state.loadedAt < (state.error ? RETRY_MS : TTL_MS);
    /* A schedule that carries no broadcast objects is an authority that has
       not shipped yet, not a transient failure: stop asking for this page. */
    if (state.disabled || (!force && state.promise && fresh)) return state.promise;
    state.loadedAt = Date.now();
    state.promise = fetch(`${API}/api/schedule?season=2026`, { headers: { Accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(p => { if (!ingest(p)) { state.disabled = true; throw new Error('schedule_without_broadcast'); } return state; })
      .catch(e => { state.error = e instanceof Error ? e.message : String(e); state.loadedAt = Date.now(); return state; });
    return state.promise;
  }

  /* A game from any surface -> its canonical schedule row. ESPN event id or
     schedule game id first; otherwise both teams AND the Eastern kickoff date,
     only when that is unique. */
  function find(q = {}) {
    if (q.event != null && q.event !== '') return state.byEvent.get(String(q.event)) || null;
    if (q.game != null && q.game !== '') return state.byGame.get(String(q.game)) || null;
    const a = scheduleCode(q.away), h = scheduleCode(q.home), day = easternDate(q.kickoff);
    if (!a || !h || !day) return null;
    const hits = state.games.filter(g => g.away_team === a && g.home_team === h && g.gameday === day);
    return hits.length === 1 ? hits[0] : null;
  }

  function slotAttrs(q) {
    return ['event', 'game', 'away', 'home', 'kickoff', 'mode', 'lead']
      .filter(k => q[k] != null && q[k] !== '').map(k => ` data-tv-${k}="${esc(q[k])}"`).join('');
  }
  function fill(q) {
    const g = find(q);
    if (!g) return '';
    return html(g.broadcast, { away: q.awayName || teamName(g.away_team), home: q.homeName || teamName(g.home_team), mode: q.mode, lead: q.lead });
  }
  function slot(q = {}) {
    load();
    if (state.games.length) return fill(q);
    return `<span class="pbe-tv-slot"${slotAttrs(q)}></span>`;
  }
  function hydrate(root) {
    if (!root?.querySelectorAll || !state.games.length) return;
    root.querySelectorAll('.pbe-tv-slot:empty').forEach(el => {
      const d = el.dataset;
      const out = fill({ event: d.tvEvent, game: d.tvGame, away: d.tvAway, home: d.tvHome, kickoff: d.tvKickoff, mode: d.tvMode, lead: d.tvLead, awayName: d.tvAway, homeName: d.tvHome });
      if (out) el.innerHTML = out;
    });
  }

  /* The broadcaster link is secondary: a click on it must never also trigger
     the card or row it sits in (those open PropBetEdge game context). Capture
     phase stops the event before any card handler; the link's own default
     navigation still happens. */
  document.addEventListener('click', e => { if (e.target?.closest?.('.pbe-tv-link')) e.stopPropagation(); }, true);
  window.addEventListener('pbe:broadcast-ready', () => hydrate(document));

  window.PBEBroadcast = { load, ingest, find, html, text, slot, hydrate, state, HOSTS, safeUrl };
})();
