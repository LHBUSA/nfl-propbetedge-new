/* PropBetEdge NFL — game context v1: kickoff, where to watch, venue, weather.
 *
 * One strip, one contract, for every game card and the featured next game:
 *
 *   KICKOFF   the kickoff instant in America/New_York, always suffixed ET
 *   WATCH     the schedule authority's broadcast (nfl-schedule), rendered by
 *             PBEBroadcast: verified official links only, unknown = text
 *   VENUE     the stadium ESPN lists for THIS game (neutral sites included)
 *   WEATHER   the nfl-intel kickoff-window forecast (/api/game-weather), joined
 *             to the game by ESPN event id and accepted only when the teams,
 *             kickoff and venue agree — otherwise it is not shown
 *
 * Roof truth comes from the schedule venue (ESPN's indoor flag + the PBE
 * weather authority's retractable list): INDOOR neutralizes weather, a
 * retractable roof is "status not confirmed", an unresolved venue is
 * unavailable. Nothing here estimates a value.
 *
 * One weather read per page (10-minute memo), never one per card.
 *
 * Consumers: games-v2.js (full strip on every card) and pbecast-v6.js (the
 * compact environment row in the selected-game hero). Both build the game from
 * the canonical /api/schedule row with fromSchedule(), so there is one reading
 * of schedule identity, venue, broadcast and weather.
 */
(function (root) {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const TTL_MS = 10 * 60000;
  const ET = 'America/New_York';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const isNum = v => typeof v === 'number' && Number.isFinite(v);

  /* nflverse and ESPN spell three clubs differently. */
  const TEAM = { LA: 'LAR', WAS: 'WSH', JAC: 'JAX' };
  const team = v => { const c = String(v ?? '').trim().toUpperCase(); return TEAM[c] || c; };
  const venueKey = v => String(v ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /* ---- time -------------------------------------------------------------- */
  function kickoffParts(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return null;
    const time = d.toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });
    return {
      time: `${time} ET`,
      day: d.toLocaleDateString('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' }),
      longDay: d.toLocaleDateString('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric' })
    };
  }

  /* ---- the game, from the canonical schedule row --------------------------- */
  /* row: one nfl-schedule /api/schedule game. opts.state: SCHEDULE|LIVE|FINAL
     from the surface's own score semantics. */
  function fromSchedule(row, opts = {}) {
    if (!row || typeof row !== 'object') return null;
    const st = String(opts.state || '').toUpperCase();
    const kickoff = opts.kickoff_utc || (row.kickoff && typeof row.kickoff === 'object' ? row.kickoff.utc : null) || null;
    return {
      espn_event_id: row.espn_event_id ? String(row.espn_event_id) : null,
      away_team: row.away_team || null,
      home_team: row.home_team || null,
      kickoff_utc: kickoff,
      venue: row.venue && typeof row.venue === 'object' ? row.venue : null,
      broadcast: row.broadcast ?? null,
      final: st === 'FINAL',
      state_label: st === 'LIVE' ? 'Live' : st === 'FINAL' ? 'Final' : 'Scheduled',
      away_name: opts.away_name || row.away_team || null,
      home_name: opts.home_name || row.home_team || null
    };
  }

  /* ---- weather ------------------------------------------------------------ */
  /* input: game {espn_event_id, away_team, home_team, kickoff_utc, venue, final}
     wx:    { status: 'ok'|'loading'|'error', body } from /api/game-weather */
  function weatherModel(game, wx, now = Date.now()) {
    if (game.final) return { kind: 'final', roof: game.venue?.status === 'VERIFIED' ? (game.venue.roof?.state || null) : null };
    const v = game.venue;
    if (!v || v.status !== 'VERIFIED') return { kind: 'unavailable', title: 'Weather unavailable', detail: 'Venue not confirmed' };
    const roof = v.roof?.state;
    if (!['OUTDOOR', 'INDOOR', 'ROOF_STATUS_UNKNOWN'].includes(roof)) {
      return { kind: 'unavailable', title: 'Weather unavailable', detail: v.neutral_site ? 'Neutral-site venue not resolved for a forecast' : 'Roof state not confirmed' };
    }

    const roofLabel = roof === 'INDOOR' ? 'DOME / INDOOR' : roof === 'ROOF_STATUS_UNKNOWN' ? 'RETRACTABLE ROOF' : 'OUTDOOR';
    const roofNote = roof === 'INDOOR'
      ? 'Outdoor conditions only — fixed roof'
      : roof === 'ROOF_STATUS_UNKNOWN'
        ? 'Outdoor conditions · roof status not confirmed'
        : 'Weather applies to the field';

    if (!wx || wx.status === 'loading') {
      return {
        kind: roof === 'INDOOR' ? 'indoor' : roof === 'ROOF_STATUS_UNKNOWN' ? 'retractable' : 'loading',
        title: roof === 'OUTDOOR' ? 'Reading local forecast…' : roofLabel,
        detail: 'Reading local forecast…',
        roof_context: roofNote
      };
    }

    const body = wx.body;
    if (wx.status !== 'ok' || !body?.ok) {
      return {
        kind: roof === 'INDOOR' ? 'indoor' : roof === 'ROOF_STATUS_UNKNOWN' ? 'retractable' : 'unavailable',
        title: roof === 'OUTDOOR' ? 'Weather unavailable' : roofLabel,
        detail: 'Local forecast unavailable',
        roof_context: roofNote
      };
    }

    const kick = Date.parse(game.kickoff_utc || '');
    const row = arr(body.games).find(r => String(r.event_id) === String(game.espn_event_id));
    if (!row) {
      const horizon = now + (isNum(body.horizon_hours) ? body.horizon_hours : 192) * 3600000;
      if (Number.isFinite(kick) && kick > horizon) return { kind: 'pending', title: 'Forecast pending', detail: 'Outside the forecast window', roof_context: roofNote };
      return {
        kind: roof === 'INDOOR' ? 'indoor' : roof === 'ROOF_STATUS_UNKNOWN' ? 'retractable' : 'unavailable',
        title: roof === 'OUTDOOR' ? 'Weather unavailable' : roofLabel,
        detail: 'Local forecast unavailable',
        roof_context: roofNote
      };
    }

    const rowKick = Date.parse(row.kickoff_utc || '');
    const agrees = team(row.away_team) === team(game.away_team) && team(row.home_team) === team(game.home_team)
      && Number.isFinite(rowKick) && Number.isFinite(kick) && Math.abs(rowKick - kick) <= 5 * 60000
      && venueKey(row.venue?.name) === venueKey(v.name)
      && row.roof?.state === roof;
    if (!agrees) return { kind: 'unavailable', title: 'Weather unavailable', detail: 'Forecast did not match this game', rejected: true };

    const f = row.forecast;
    if (!row.available || !f || !isNum(f.temp_f)) {
      return {
        kind: roof === 'INDOOR' ? 'indoor' : roof === 'ROOF_STATUS_UNKNOWN' ? 'retractable' : 'unavailable',
        title: roof === 'OUTDOOR' ? 'Weather unavailable' : roofLabel,
        detail: 'Local forecast unavailable',
        roof_context: roofNote
      };
    }

    const stale = Boolean(body.stale);
    const lines = [
      isNum(f.wind_mph) ? `Wind ${f.wind_mph} mph` : null,
      isNum(f.gust_mph) ? `Gusts ${f.gust_mph} mph` : null,
      isNum(f.precip_probability_pct) ? `Rain ${f.precip_probability_pct}%` : null,
      roofNote
    ].filter(Boolean);

    return {
      kind: 'forecast',
      title: `${roofLabel} · ${f.temp_f}°F${f.condition ? ` · ${f.condition}` : ''}`,
      lines,
      alerts: arr(row.nws).map(a => a.event).filter(Boolean),
      event_id: row.event_id,
      fetched_at: body.fetched_at,
      stale,
      roof_context: roofNote
    };
  }

  /* ---- HTML -------------------------------------------------------------- */
  function cell(cls, label, value, detail, extra = '') {
    return `<div class="pbe-gctx-cell ${cls}"${extra}><span class="pbe-gctx-k">${esc(label)}</span><b>${value}</b>${detail ? `<small>${detail}</small>` : ''}</div>`;
  }

  function watchHtml(broadcast, away, home) {
    const B = root.PBEBroadcast;
    if (broadcast && typeof broadcast === 'object') {
      const html = B?.html?.(broadcast, { away, home }) || '';
      if (html) return html;
      return '<span class="pbe-gctx-na">Broadcast unavailable</span>';
    }
    return '<span class="pbe-gctx-na">Broadcast unavailable</span>';
  }

  function html(game, wx, opts = {}) {
    const k = kickoffParts(game.kickoff_utc);
    const v = game.venue;
    const w = weatherModel(game, wx, opts.now);
    const kick = cell('is-kick', game.state_label || 'Kickoff', k ? esc(k.time) : 'Time TBA', k ? esc(k.day) : '');
    const watch = cell('is-watch', 'Watch', watchHtml(game.broadcast, game.away_name, game.home_name), '');
    const venue = v?.status === 'VERIFIED'
      ? cell('is-venue', 'Venue', esc(v.name), esc([v.city, v.state].filter(Boolean).join(', ')))
      : cell('is-venue', 'Venue', '<span class="pbe-gctx-na">Venue unavailable</span>', '');
    let weather = '';
    if (w.kind !== 'final') {
      const title = w.kind === 'forecast' ? esc(w.title) : `<span class="pbe-gctx-state">${esc(w.title)}</span>`;
      const detail = w.kind === 'forecast'
        ? `${esc(w.lines.join(' · '))}${w.alerts.length ? `<em class="pbe-gctx-alert">NWS: ${esc(w.alerts.join(', '))}</em>` : ''}`
        : esc(w.detail || '');
      const title_attr = w.kind === 'forecast' ? ` title="${esc(`Kickoff-window forecast (Open-Meteo, CC BY 4.0). Temperature at kickoff; wind, gusts and rain chance are the worst hour of the window. Updated ${w.fetched_at || ''}`)}"` : '';
      weather = cell(`is-weather is-${w.kind}`, 'Weather', title, detail, `${title_attr} data-wx-kind="${esc(w.kind)}"${w.event_id ? ` data-wx-event="${esc(w.event_id)}"` : ''}`);
    }
    return `<div class="pbe-gctx${opts.featured ? ' is-featured' : ''}" data-gctx-event="${esc(game.espn_event_id || '')}">${kick}${watch}${venue}${weather}</div>`;
  }

  /* ---- compact environment row (PBEcast hero) ------------------------------ */
  /* The same weatherModel, one line. selectedEventId is the game the surface
     is showing: a schedule row for any other event renders nothing but an
     explicit unavailable state, so another game's weather cannot appear. */
  function environmentModel(game, wx, opts = {}) {
    const sel = opts.selectedEventId != null ? String(opts.selectedEventId) : null;
    if (!game) return { kind: 'unavailable', title: 'Weather unavailable', detail: opts.scheduleLoading ? 'Reading schedule…' : 'Game not on the 2026 schedule' };
    if (sel && String(game.espn_event_id) !== sel) return { kind: 'unavailable', title: 'Weather unavailable', detail: 'Schedule identity did not match this game', rejected: true };
    const m = weatherModel(game, wx, opts.now);
    if (m.kind !== 'final') return m;
    /* a completed game: the roof is still a fact, a kickoff forecast is not kept */
    if (m.roof === 'INDOOR') return { kind: 'indoor', title: 'Indoor', detail: 'Weather neutralized' };
    if (m.roof === 'ROOF_STATUS_UNKNOWN') return { kind: 'retractable', title: 'Retractable roof', detail: 'Status not confirmed' };
    if (game.venue?.neutral_site === true) return { kind: 'unavailable', title: 'Weather unavailable', detail: 'Neutral-site venue not resolved for a forecast' };
    return { kind: 'final', title: 'Game final', detail: 'Kickoff forecast not retained' };
  }

  function environmentHtml(game, wx, opts = {}) {
    const m = environmentModel(game, wx, opts);
    const detail = m.kind === 'forecast'
      ? `${esc(m.lines.join(' · '))}${m.alerts.length ? ` <em class="pbe-env-alert">NWS: ${esc(m.alerts.join(', '))}</em>` : ''}`
      : esc(m.detail || '');
    const venue = game?.venue?.status === 'VERIFIED' ? game.venue : null;
    const attrs = [
      `data-env-event="${esc(opts.selectedEventId ?? '')}"`,
      `data-wx-kind="${esc(m.kind)}"`,
      m.event_id ? `data-wx-event="${esc(m.event_id)}"` : '',
      venue ? `data-env-venue="${esc(venue.name)}"` : '',
      venue?.roof?.state ? `data-env-roof="${esc(venue.roof.state)}"` : ''
    ].filter(Boolean).join(' ');
    const title = m.kind === 'forecast' ? ` title="${esc(`Kickoff-window forecast (Open-Meteo, CC BY 4.0) for ${venue?.name || 'this venue'}. Temperature at kickoff; wind, gusts and rain chance are the worst hour of the window.`)}"` : '';
    return `<div class="pbe-env is-${esc(m.kind)}" ${attrs}${title}><span class="pbe-env-k">Weather</span><b>${esc(m.title || '')}</b>${detail ? `<small>${detail}</small>` : ''}</div>`;
  }

  /* ---- the one weather read ------------------------------------------------ */
  const state = { status: 'idle', body: null, at: 0, promise: null };
  function load(force = false) {
    if (!force && state.promise && Date.now() - state.at < TTL_MS) return state.promise;
    state.at = Date.now();
    if (state.status !== 'ok') state.status = 'loading';
    state.promise = fetch(`${API}/api/game-weather`, { headers: { accept: 'application/json' } })
      .then(r => r.json().then(body => ({ ok: r.ok, body })).catch(() => ({ ok: false, body: null })))
      .then(({ ok, body }) => { state.status = ok && body?.ok ? 'ok' : 'error'; state.body = body; return state; })
      .catch(() => { state.status = 'error'; state.body = null; return state; })
      .finally(() => { try { root.dispatchEvent(new CustomEvent('pbe:game-weather')); } catch (_) {} });
    return state.promise;
  }

  root.PBEGameContext = { html, weatherModel, fromSchedule, environmentModel, environmentHtml, kickoffParts, load, state, _team: team, _venueKey: venueKey };
})(typeof window !== 'undefined' ? window : globalThis);
