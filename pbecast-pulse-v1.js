/* PropBetEdge NFL — PBEcast GAME PULSE (additive to PBEcast v6)
 *
 * The focused game's live win probability, read from the state PBEcast v6
 * already holds. No request, no timer, no route: v6's detail lane fetches
 * /api/nfl-live?event=X (ESPN site summary `winprobability`) and this module
 * only derives from state.detail.win_probability.
 *
 * SOURCE CONTRACT
 *   state.detail.win_probability[] = { play_id, home_win_percentage, tie_percentage }
 *   home_win_percentage and tie_percentage are fractions 0..1 as ESPN
 *   publishes them; away = 1 - home - tie. This is the SOURCE's live win
 *   probability, not a PropBetEdge model, and it is labelled that way.
 *
 * WHAT IS DERIVED, AND NOTHING ELSE
 *   swing       the change between two consecutive valid observations, owned
 *               by the team whose probability rose, in percentage points
 *   last swing  the most recent swing >= SWING_PP
 *   biggest     the largest swing in the series so far
 *   The play a swing is attached to is the published play whose id the
 *   observation carries. The play's own published type and clock are shown;
 *   no cause is ever inferred. An observation with no matching play says only
 *   "after play <id>".
 *
 * MEANINGFUL-SWING RULE: SWING_PP = 5 percentage points.
 *   Measured over 106 completed games (2025 weeks 1/4/8/12/16/18 and 2026
 *   week 1; 154-226 observations each, 99.4% of play_ids matched a published
 *   play): consecutive |delta| has median 1.1, p75 2.6, p90 5.0, p95 7.2.
 *   5 points is the p90 of all moves — about 17 per game at the median, and
 *   105 of 106 games have at least one. 3 would admit one move in five; 8
 *   leaves 5 games with no swing at all and 10 leaves 17. One fixed rule for
 *   every game; nothing is tuned per game, team or quarter.
 *
 * FAIL CLOSED. Scheduled or unavailable games, an empty or malformed series,
 * or a series whose play ids match none of this game's published plays (a
 * previous game's data) render nothing. No synthetic curve, no 50/50.
 */
(() => {
  'use strict';

  const SWING_PP = 5;
  const TOP_SWINGS = 5;
  const EPS = 1e-9;

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const fin = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const semOf = d => String(d?.source?.semantics || d?.game?.status?.semantics || '').toUpperCase();

  /* ---- series ---------------------------------------------------------------
     Valid observations only. A row with no finite home probability, or one
     outside 0..1, is dropped rather than repaired. Consecutive rows for the
     same play keep the later one: a republished observation is a correction,
     not a second move. */
  function series(rows) {
    const out = [];
    for (const r of arr(rows)) {
      const home = fin(r?.home_win_percentage);
      if (home === null || home < 0 || home > 1) continue;
      const tieRaw = r?.tie_percentage;
      const tie = tieRaw === null || tieRaw === undefined || tieRaw === '' ? 0 : fin(tieRaw);
      if (tie === null || tie < 0 || home + tie > 1 + 1e-6) continue;
      const playId = r?.play_id === null || r?.play_id === undefined ? '' : String(r.play_id);
      const obs = { play_id: playId, home, tie, away: Math.max(0, 1 - home - tie) };
      const prev = out[out.length - 1];
      if (prev && playId && prev.play_id === playId) out[out.length - 1] = obs;
      else out.push(obs);
    }
    return out.map((o, i) => ({ ...o, index: i }));
  }

  function playIndex(detail) {
    const map = new Map();
    for (const p of arr(detail?.plays)) if (p?.id != null) map.set(String(p.id), p);
    for (const dr of arr(detail?.drives)) for (const p of arr(dr?.plays)) if (p?.id != null && !map.has(String(p.id))) map.set(String(p.id), p);
    return map;
  }

  function derive(detail, { activeId = null } = {}) {
    const g = detail?.game;
    if (!g) return null;
    const sem = semOf(detail);
    if (sem !== 'LIVE' && sem !== 'FINAL') return null;
    if (activeId != null && String(g.id ?? '') !== String(activeId)) return null;
    const obs = series(detail?.win_probability);
    if (!obs.length) return null;
    const plays = playIndex(detail);
    const matched = obs.filter(o => o.play_id && plays.has(o.play_id)).length;
    if (plays.size > 0 && obs.length >= 5 && matched === 0) return null;

    const teams = { away: g?.teams?.away || {}, home: g?.teams?.home || {} };
    const swings = [];
    for (let i = 1; i < obs.length; i++) {
      const a = obs[i - 1], b = obs[i];
      const dh = b.home - a.home, da = b.away - a.away;
      const side = dh >= da ? 'home' : 'away';
      const magnitude = Math.max(Math.abs(dh), Math.abs(da));
      const p = b.play_id ? plays.get(b.play_id) || null : null;
      swings.push({
        index: i, play_id: b.play_id, side, team: teams[side]?.abbreviation || (side === 'home' ? 'HOME' : 'AWAY'),
        pp: Math.round(magnitude * 1000) / 10, magnitude,
        meaningful: magnitude * 100 >= SWING_PP - EPS,
        before: { home: a.home, away: a.away }, after: { home: b.home, away: b.away },
        play: p ? { id: String(p.id), type: p.type || null, period: fin(p.period), clock: p.clock || null } : null
      });
    }
    const meaningful = swings.filter(s => s.meaningful);
    let biggest = null;
    for (const s of swings) if (s.magnitude > EPS && (!biggest || s.magnitude > biggest.magnitude)) biggest = s;
    return {
      semantics: sem, gameId: String(g.id ?? ''), threshold: SWING_PP,
      observations: obs, current: obs[obs.length - 1], matched, teams,
      swings, meaningfulCount: meaningful.length,
      last: meaningful.length ? meaningful[meaningful.length - 1] : null,
      biggest,
      top: [...meaningful].sort((x, y) => y.magnitude - x.magnitude || x.index - y.index).slice(0, TOP_SWINGS)
    };
  }

  /* ---- presentation ----------------------------------------------------------- */
  const pct = v => `${(v * 100).toFixed(1)}%`;
  const when = p => (p?.period ? `${p.period > 4 ? 'OT' : `Q${p.period}`}${p.clock ? ` ${p.clock}` : ''}` : '');

  function stateLine(detail) {
    const g = detail?.game || {}, st = g.status || {}, sit = g.situation || {};
    const sem = semOf(detail);
    const a = g?.teams?.away || {}, h = g?.teams?.home || {};
    if (sem === 'FINAL') return [st.short_detail || 'Final', `${a.abbreviation || 'AWY'} ${a.score ?? '—'} – ${h.score ?? '—'} ${h.abbreviation || 'HME'}`].join(' · ');
    /* possession by team id, field position only as v6 verifies it: ESPN's
       possession_text is the spot of the ball, never the team */
    const V6 = typeof window !== 'undefined' ? window.PBEcastV6 : null;
    const ball = sit.possession_id != null ? (String(sit.possession_id) === String(a.id) ? a.abbreviation : String(sit.possession_id) === String(h.id) ? h.abbreviation : null) : null;
    const spot = V6?.fieldPositionText?.(g) || '';
    return [st.short_detail || [st.period ? `Q${st.period}` : '', st.clock || ''].join(' ').trim(), ball ? `${ball} ball` : '', sit.down_distance_text ? `${sit.down_distance_text}${spot ? ` at ${spot}` : ''}` : (spot ? `ball on ${spot}` : '')]
      .map(x => String(x || '').trim()).filter(Boolean).join(' · ');
  }

  function swingLabel(s) {
    return `+${s.pp.toFixed(1)} ${s.team}`;
  }
  function swingContext(s) {
    if (s.play) return [s.play.type, when(s.play)].filter(Boolean).join(' · ') || `after play ${s.play_id}`;
    return s.play_id ? `after play ${s.play_id}` : `after observation ${s.index + 1}`;
  }
  function swingCard(kind, s, model) {
    const title = kind === 'both' ? 'LAST SWING · BIGGEST SO FAR' : kind === 'last' ? 'LAST SWING' : 'BIGGEST SWING';
    if (!s) {
      const note = kind === 'last'
        ? (model.observations.length < 2 ? 'Swings begin at the second observation.' : `No move of ${model.threshold} points or more yet.`)
        : 'No probability movement yet.';
      return `<div class="pbepulse-swing is-none"><span class="pbecb-eye">${title}</span><b>—</b><small>${esc(note)}</small></div>`;
    }
    const below = kind === 'biggest' && !s.meaningful;
    const body = `<span class="pbecb-eye">${title}${below ? ` · UNDER ${model.threshold} PTS` : ''}</span><b class="side-${s.side}">${esc(swingLabel(s))}</b><small>${esc(swingContext(s))}</small>`;
    return s.play
      ? `<button type="button" class="pbepulse-swing" data-pulse-play="${esc(s.play.id)}" aria-label="${esc(`${title}: ${swingLabel(s)}, ${swingContext(s)}. Show the play.`)}">${body}<em>Show play →</em></button>`
      : `<div class="pbepulse-swing">${body}</div>`;
  }

  /* Home probability on y (home at the top), observation order on x. Area is
     split at 50%: the home team's colour above, the away team's below, each
     labelled with its abbreviation so identity never rests on colour. */
  function chartHtml(model) {
    const obs = model.observations, n = obs.length;
    const a = model.teams.away.abbreviation || 'AWY', h = model.teams.home.abbreviation || 'HME';
    const W = 1000, H = 100;
    const x = i => (n === 1 ? W : (i / (n - 1)) * W);
    const y = v => (1 - v) * H;
    const pts = obs.map(o => `${x(o.index).toFixed(1)},${y(o.home).toFixed(2)}`);
    const line = n === 1 ? `M0,${y(obs[0].home).toFixed(2)} L${W},${y(obs[0].home).toFixed(2)}` : `M${pts.join(' L')}`;
    const area = n === 1
      ? `M0,50 L0,${y(obs[0].home).toFixed(2)} L${W},${y(obs[0].home).toFixed(2)} L${W},50 Z`
      : `M0,50 L${pts.join(' L')} L${W},50 Z`;
    const plays = new Map(model.swings.filter(s => s.play).map(s => [s.index, s.play]));
    /* quarter boundaries: first observation whose matched play opens a later period */
    const ticks = [];
    let lastPeriod = null;
    for (const s of model.swings) {
      const p = s.play?.period;
      if (p == null) continue;
      if (lastPeriod != null && p > lastPeriod) ticks.push({ index: s.index, label: p > 4 ? 'OT' : `Q${p}` });
      lastPeriod = Math.max(lastPeriod ?? p, p);
    }
    const marks = [];
    const addMark = (s, cls) => { if (!s) return; const at = marks.find(m => m.s.index === s.index); if (at) { at.cls += ` ${cls}`; return; } marks.push({ s, cls }); };
    addMark(model.biggest, 'is-biggest');
    addMark(model.last, 'is-last');
    if (model.semantics === 'FINAL') model.top.forEach(s => addMark(s, 'is-top'));
    const left = i => `${((n === 1 ? 1 : i / (n - 1)) * 100).toFixed(2)}%`;
    const top = v => `${((1 - v) * 100).toFixed(2)}%`;
    const tipData = obs.map(o => {
      const p = plays.get(o.index) || null;
      return [o.home, o.away, p ? [p.type, when(p)].filter(Boolean).join(' · ') : ''];
    });
    return `<figure class="pbepulse-chart" data-pulse-chart data-n="${n}" data-away="${esc(a)}" data-home="${esc(h)}" data-tips="${esc(JSON.stringify(tipData))}">
      <div class="pbepulse-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs><clipPath id="pbepulse-up"><rect x="0" y="0" width="${W}" height="50"/></clipPath><clipPath id="pbepulse-down"><rect x="0" y="50" width="${W}" height="50"/></clipPath></defs>
          ${ticks.map(t => `<line class="q" x1="${x(t.index).toFixed(1)}" x2="${x(t.index).toFixed(1)}" y1="0" y2="${H}"/>`).join('')}
          <line class="mid" x1="0" x2="${W}" y1="50" y2="50"/>
          <path class="area home" clip-path="url(#pbepulse-up)" d="${area}"/>
          <path class="area away" clip-path="url(#pbepulse-down)" d="${area}"/>
          <path class="line" d="${line}"/>
        </svg>
        ${ticks.map(t => `<span class="pbepulse-q" style="left:${left(t.index)}">${esc(t.label)}</span>`).join('')}
        ${marks.map(({ s, cls }) => s.play
          ? `<button type="button" class="pbepulse-mark ${cls}" style="left:${left(s.index)};top:${top(s.after.home)}" data-pulse-play="${esc(s.play.id)}" aria-label="${esc(`${swingLabel(s)}, ${swingContext(s)}. Show the play.`)}"><i></i></button>`
          : `<span class="pbepulse-mark ${cls}" style="left:${left(s.index)};top:${top(s.after.home)}" aria-hidden="true"><i></i></span>`).join('')}
        <span class="pbepulse-edge top">${esc(h)}</span><span class="pbepulse-edge mid">50%</span><span class="pbepulse-edge bottom">${esc(a)}</span>
        <div class="pbepulse-hair" hidden><i></i><div class="pbepulse-tip"></div></div>
      </div>
      <figcaption>${esc(h)} win probability above the line, ${esc(a)} below · ${esc(n)} observation${n === 1 ? '' : 's'} in game order</figcaption>
    </figure>`;
  }

  /* Live: the last meaningful swing beside the biggest so far, one card when
     they are the same move. Final: the ranked Largest Swings list is the
     replay's index, so the cards are not repeated above it; a final game with
     no swing of the threshold still shows its biggest move, marked under it. */
  function swingsHtml(model, final) {
    if (final) return model.top.length ? '' : `<div class="pbepulse-swings is-one">${swingCard('biggest', model.biggest, model)}</div>`;
    if (model.last && model.last === model.biggest) return `<div class="pbepulse-swings is-one">${swingCard('both', model.last, model)}</div>`;
    return `<div class="pbepulse-swings">${swingCard('last', model.last, model)}${swingCard('biggest', model.biggest, model)}</div>`;
  }

  function html(model) {
    if (!model) return '';
    const final = model.semantics === 'FINAL';
    const cur = model.current;
    const a = model.teams.away, h = model.teams.home;
    const logo = t => (t?.logo ? `<img src="${esc(t.logo)}" width="28" height="28" alt="" loading="lazy" decoding="async">` : '');
    const tie = cur.tie >= 0.005 ? `<span class="pbepulse-tie">TIE ${pct(cur.tie)}</span>` : '';
    const top = final && model.top.length ? `<div class="pbepulse-top"><span class="pbecb-eye">LARGEST SWINGS · ${esc(model.threshold)}+ PTS</span><ol>${model.top.map(s => `<li>${s.play
      ? `<button type="button" data-pulse-play="${esc(s.play.id)}"><b class="side-${s.side}">${esc(swingLabel(s))}</b><span>${esc(swingContext(s))}</span><em>Show play →</em></button>`
      : `<div><b class="side-${s.side}">${esc(swingLabel(s))}</b><span>${esc(swingContext(s))}</span></div>`}</li>`).join('')}</ol></div>` : '';
    return `<section class="pbepulse ${final ? 'is-final' : 'is-live'}" aria-label="Game Pulse">
      <header>
        <div><span class="pbecb-eye">${final ? 'PBE REPLAY · GAME PULSE' : 'GAME PULSE · LIVE WIN PROBABILITY'}</span><h2>${final ? 'How the win probability moved' : 'How much each play mattered'}</h2></div>
        <p class="pbepulse-state" data-pulse-state></p>
      </header>
      <div class="pbepulse-now" role="group" aria-label="${esc(`${final ? 'Final' : 'Current'} win probability: ${a.abbreviation || 'Away'} ${pct(cur.away)}, ${h.abbreviation || 'Home'} ${pct(cur.home)}`)}">
        <div class="pbepulse-team away">${logo(a)}<b>${esc(a.abbreviation || 'AWY')}</b><strong>${pct(cur.away)}</strong></div>
        <div class="pbepulse-bar" aria-hidden="true"><i class="away" style="width:${(cur.away * 100).toFixed(2)}%"></i><i class="home" style="width:${(cur.home * 100).toFixed(2)}%"></i></div>
        <div class="pbepulse-team home"><strong>${pct(cur.home)}</strong><b>${esc(h.abbreviation || 'HME')}</b>${logo(h)}</div>
        ${tie}
      </div>
      ${chartHtml(model)}
      ${swingsHtml(model, final)}
      ${top}
      <footer class="pbepulse-foot">Live win probability as published by ESPN · ${esc(model.observations.length)} observations${model.matched < model.observations.length ? ` · ${esc(model.matched)} matched to a published play` : ''}. Source probability, not a PropBetEdge model or prediction. A swing is the change between two consecutive observations; ${esc(model.threshold)} points or more counts as meaningful. PBEcast shows the play a swing followed and does not infer why it moved.</footer>
    </section>`;
  }

  /* ---- mount: called by the command layer's render(), never on a clock ---- */
  function mount(host, v6State) {
    if (!host) return null;
    const detail = v6State?.detail;
    const model = derive(detail, { activeId: v6State?.activeId ?? null });
    const next = html(model);
    if (host.dataset.sig !== next) { host.innerHTML = next; host.dataset.sig = next; }
    const line = host.querySelector('[data-pulse-state]');
    if (line) { const t = stateLine(detail); if (line.textContent !== t) line.textContent = t; }
    return model;
  }

  /* Crosshair + tooltip. Pointer-driven only: no timer, no animation loop. */
  let hovered = null;
  function hideHair(fig) { const hair = fig?.querySelector('.pbepulse-hair'); if (hair) hair.hidden = true; }
  function hover(e) {
    const fig = e.target?.closest?.('.pbepulse [data-pulse-chart]') || null;
    if (hovered && hovered !== fig) hideHair(hovered);
    hovered = fig;
    if (!fig) return;
    if (e.target.closest('.pbepulse-mark')) { hideHair(fig); return; }
    const plot = fig.querySelector('.pbepulse-plot'), hair = fig.querySelector('.pbepulse-hair');
    const r = plot.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { hair.hidden = true; return; }
    let tips; try { tips = JSON.parse(fig.dataset.tips || '[]'); } catch { tips = []; }
    const n = tips.length; if (!n) return;
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    const [home, away, ctx] = tips[i];
    hair.hidden = false;
    hair.style.left = `${n === 1 ? 100 : (i / (n - 1)) * 100}%`;
    hair.querySelector('i').style.top = `${(1 - home) * 100}%`;
    const tip = hair.querySelector('.pbepulse-tip');
    tip.textContent = '';
    const row = (k, v) => { const d = document.createElement('div'); const b = document.createElement('b'); b.textContent = k; const s = document.createElement('span'); s.textContent = v; d.append(b, s); tip.append(d); };
    row(fig.dataset.home, pct(home)); row(fig.dataset.away, pct(away));
    if (ctx) { const c = document.createElement('small'); c.textContent = ctx; tip.append(c); }
    tip.classList.toggle('flip', i / Math.max(1, n - 1) > 0.6);
  }
  if (typeof document !== 'undefined') document.addEventListener('pointermove', hover, { passive: true });

  const api = { SWING_PP, series, derive, html, mount, stateLine, swingContext };
  if (typeof window !== 'undefined') window.PBEcastPulse = api;
})();
