/* ============================================================================
   PropBetEdge NFL — QB DNA  ·  prototype route /#qbdna
   ----------------------------------------------------------------------------
   Reads /api/qb-dna, /api/qb-dna/prop-history, /api/qb-dna/compare and
   /api/qb-dna/game-context. It renders ONLY what those APIs return.

   The rules this view enforces at render time, not just in the API:
     · a percentage is never printed without its N
     · an unavailable value prints its reason where the number would have been
     · a delta is always relative to the player's OWN baseline, labelled as such
     · a sample label describes SIZE, and the copy never upgrades it to a claim
     · the DATA WINDOW is always on screen, so a completed season can never be
       mistaken for current form
     · a quarterback with no NFL history shows NFL SAMPLE UNAVAILABLE, never
       zeros, and never college numbers
     · a threshold is only ever calculated against a real line — the current
       market's, or one explicitly typed. No default is invented.

   This route is NOT in the main navigation. It is reached by hash only.
   ========================================================================== */
(() => {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MARKET_UNAVAILABLE = 'CURRENT MARKET UNAVAILABLE';
  const SAMPLE_UNAVAILABLE = 'NFL SAMPLE UNAVAILABLE';

  const state = {
    tab: 'overview',
    playerId: '00-0033873',          // Patrick Mahomes
    comparePlayerId: '00-0034857',   // Josh Allen
    market: 'passing_yards',
    line: '',                        // empty = use the current market line
    eventId: null,
    players: null, dna: null, prop: null, cmp: null, ctxCmp: null, ctx: null, slate: null,
    loading: false, error: null
  };

  const MARKET_LABELS = {
    passing_yards: 'Passing yards', passing_attempts: 'Attempts',
    completions: 'Completions', passing_touchdowns: 'Passing TDs',
    interceptions: 'Interceptions'
  };

  async function get(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok === false) {
      throw new Error((j && (j.detail || j.error)) || `HTTP ${r.status}`);
    }
    return j;
  }

  /* ---- primitives -------------------------------------------------------- */

  const samp = label => label
    ? `<span class="qbd-samp" data-s="${esc(label)}">${esc(label)}</span>` : '';

  const TRACK = 200;   // must match --qbd-track in qb-dna-v1.css
  const pct1 = v => (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const num1 = v => (typeof v === 'number' ? v.toFixed(1) : v);

  /** A number with its unit, or an explicit unavailable state. Never a bare dash. */
  function stat(key, value, unitOrNull, nLine) {
    const empty = value === null || value === undefined;
    return `<div class="qbd-stat${empty ? ' is-empty' : ''}">
      <div class="qbd-stat-k">${esc(key)}</div>
      <div class="qbd-stat-v">${empty ? 'Not available'
        : esc(value) + (unitOrNull ? `<small>${esc(unitOrNull)}</small>` : '')}</div>
      <div class="qbd-stat-n">${nLine || ''}</div>
    </div>`;
  }

  /** A rate is only ever printed as numerator / denominator. */
  function rateLine(r) {
    if (!r || r.pct === null || r.pct === undefined) return 'no denominator';
    return `${esc(r.numerator)} / ${esc(r.denominator)}`;
  }

  /* The delta domain is chosen from the values actually on screen, rounded up to
     a readable step, with a 10% floor so a quiet set of splits does not get
     magnified into drama. Anything beyond the domain is clamped. */
  function domainOf(values) {
    const max = Math.max(10, ...values.filter(v => typeof v === 'number').map(Math.abs));
    for (const step of [10, 15, 20, 25, 30, 40, 50, 75, 100]) if (max <= step) return step;
    return Math.ceil(max / 25) * 25;
  }

  function deltaCell(pct, domain) {
    if (pct === null || pct === undefined) return '<div class="qbd-delta"></div>';
    const d = domain || 40;
    const clamped = Math.max(-d, Math.min(d, pct));
    const bar = Math.abs(clamped) / d * (TRACK / 2);
    const neg = clamped < 0;
    return `<div class="qbd-delta" style="--bar:${bar.toFixed(1)}px">
      <div class="qbd-delta-fill${neg ? ' is-neg' : ''}"
        style="${neg ? 'right:50%' : 'left:50%'};width:${bar.toFixed(1)}px"></div>
      <div class="qbd-delta-num ${neg ? 'at-l' : 'at-r'}">${esc(pct1(pct))}</div>
    </div>`;
  }

  function axis(domain, valueLabel) {
    return `<div class="qbd-axis">
      <div class="qbd-axis-head">Condition &middot; games</div>
      <div class="qbd-axis-track"><span>&minus;${domain}%</span>
        <span>own baseline</span><span>+${domain}%</span></div>
      <div class="qbd-axis-val">${esc(valueLabel)}</div>
    </div>`;
  }

  /** The window banner. Always on screen — this is what stops a completed
      season being read as current form. */
  function windowStrip() {
    const w = (state.dna && state.dna.data_window)
      || (state.players && state.players.data_window);
    if (!w) return '';
    const g = w.latest_completed_game || {};
    return `<div class="qbd-window">
      <span class="qbd-window-k">Data through</span>
      <b>${esc(w.data_through)}</b>
      <span class="qbd-window-sep"></span>
      <span class="qbd-window-k">Last completed game</span>
      <b>${esc(g.matchup || '—')}</b>
      <span class="qbd-window-m">${esc(g.season)} ${esc(g.season_type)} wk ${esc(g.week)}</span>
      <span class="qbd-window-sep"></span>
      <span class="qbd-window-k">Seasons</span>
      <b>${esc(w.seasons[0])}&ndash;${esc(w.latest_season)}</b>
      ${w.note ? `<span class="qbd-window-note">${esc(w.note)}</span>` : ''}
    </div>`;
  }

  /* ---- NO HISTORY -------------------------------------------------------- */

  function noHistory() {
    const d = state.dna;
    const p = d.player;
    return `<section class="qbd-panel qbd-unavail">
      <div class="qbd-panel-head">
        <h3>${esc(SAMPLE_UNAVAILABLE)}</h3>
        <span>${esc(p.name)}${p.current_team ? ' · ' + esc(p.current_team) : ''}</span>
      </div>
      <div class="qbd-panel-body">
        <p class="qbd-unavail-lead">${esc(d.reason)}</p>
        <div class="qbd-rail">
          ${stat('NFL games', null, null, 'nothing to count')}
          ${stat('Baseline', null, null, 'requires at least one completed game')}
          ${stat('Condition splits', null, null, 'requires at least one completed game')}
          ${stat('Threshold history', null, null, 'requires at least one completed game')}
        </div>
        <p class="qbd-caveat">${esc(d.disclosure)}
          ${p.experience_years !== null && p.experience_years !== undefined
            ? ` Listed NFL experience: ${esc(p.experience_years)} year${p.experience_years === 1 ? '' : 's'}.` : ''}
          ${p.market_priced_2026
            ? ' The current market is pricing this quarterback, but we have no NFL history to measure that line against.'
            : ''}</p>
      </div>
      <div class="qbd-key">
        <i>Identity resolved: GSIS ${esc(p.gsis_id)}${p.espn_id ? ' · ESPN ' + esc(p.espn_id) : ''}
           &mdash; the player is known, the history is not.</i>
      </div>
    </section>`;
  }

  /* ---- OVERVIEW ---------------------------------------------------------- */

  function overview() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return todayPanel() + noHistory();

    const b = d.baseline;
    const py = b.passing_yards || {};

    const railHtml = `<div class="qbd-rail">
      ${stat('Passing yards / game', py.mean, 'avg',
        `median ${esc(py.median)} · N=${esc(b.games)} games`)}
      ${stat('Completion', b.completion_pct.pct, '%', `${rateLine(b.completion_pct)} attempts`)}
      ${stat('Yards / attempt', b.ypa.value, 'y',
        `${esc(b.ypa.numerator)} yds / ${esc(b.ypa.denominator)} att`)}
      ${stat('TD rate', b.td_rate.pct, '%', `${rateLine(b.td_rate)} attempts`)}
      ${stat('INT rate', b.int_rate.pct, '%', `${rateLine(b.int_rate)} attempts`)}
      ${stat('Sack rate', b.sack_rate.pct, '%', `${rateLine(b.sack_rate)} dropbacks`)}
      ${stat('Record as starter', b.wins === null ? null : `${b.wins}-${b.losses}`, null,
        `${esc(b.games_with_result)} games with a recorded result`)}
      ${stat('Spread', py.p25 === undefined ? null : `${py.p25}-${py.p75}`, 'p25-75',
        `low ${esc(py.min)} · high ${esc(py.max)} · sd ${esc(py.std)}`)}
    </div>`;

    // LAST 5 / LAST 10 / CURRENT SEASON / CAREER, each with its N
    const order = ['last_5', 'last_10', 'current_season', 'career'];
    const windows = order.map(k => {
      const w = d.recent[k];
      if (!w || !w.available) {
        return `<div class="qbd-cmprow"><div class="a">${esc((w && w.label) || k)}</div>
          <div class="k">&mdash;</div>
          <div class="b qbd-cond-why">${esc((w && w.reason) || 'no games')}</div></div>`;
      }
      const s = w.passing_yards || {};
      return `<div class="qbd-cmprow">
        <div class="a">${esc(w.label)} <em>N=${esc(w.games)}${
          w.shortfall_note ? ' · ' + esc(w.shortfall_note) : ''}</em></div>
        <div class="k">${esc(num1(s.mean))} avg</div>
        <div class="b">${samp(w.sample_label)}
          <em>${esc(w.completion_pct.pct)}% cmp · ${rateLine(w.completion_pct)}</em></div>
      </div>`;
    }).join('');

    const log = d.game_log.map(g => `<tr>
      <td class="t-txt">${esc(g.date)}</td>
      <td class="t-txt">${esc(g.season)} W${esc(g.week)}</td>
      <td class="t-txt">${g.home ? 'vs' : '@'} ${esc(g.opponent)}</td>
      <td class="t-num">${esc(g.passing_yards)}</td>
      <td class="t-num">${esc(g.completions)}/${esc(g.attempts)}</td>
      <td class="t-num">${esc(g.touchdowns)}</td>
      <td class="t-num">${esc(g.interceptions)}</td>
      <td class="t-txt">${g.result ? `<span class="qbd-${g.result.toLowerCase()}">${g.result}</span>` : '—'}</td>
      <td class="t-txt">${g.environment_status === 'ok'
        ? `${esc(g.temp_f)}&deg;F · ${esc(g.wind_mph)} mph`
        : `<span class="qbd-cond-why">${esc(g.roof === 'dome' || g.roof === 'closed'
            ? 'roofed' : 'not resolved')}</span>`}</td>
    </tr>`).join('');

    return `
    ${todayPanel()}
    <section class="qbd-panel">
      <div class="qbd-panel-head">
        <h3>Baseline · every game in the window</h3>
        <span>${esc(d.window.seasons[0])}&ndash;${esc(d.window.seasons[d.window.seasons.length - 1])}
          · ${esc(d.window.games)} games · ${esc(d.window.date_range[0])} to ${esc(d.window.date_range[1])}</span>
      </div>
      ${railHtml}
      <div class="qbd-key">
        <i>Every figure above is counted from ${esc(d.window.games)} completed games. No projection, no model.</i>
        ${samp(b.sample_label)}
      </div>
    </section>

    <section class="qbd-panel">
      <div class="qbd-panel-head"><h3>Recency</h3><span>passing yards per game</span></div>
      ${windows}
      <div class="qbd-key"><i>Each window carries its own N. A window that cannot be
        filled says how many games actually exist rather than quietly shortening itself.</i></div>
    </section>

    <section class="qbd-panel">
      <div class="qbd-panel-head"><h3>Recent games</h3><span>last ${esc(d.game_log.length)}</span></div>
      <div class="qbd-tablewrap"><table class="qbd-table">
        <thead><tr><th>Date</th><th>Season</th><th>Opp</th><th>Yds</th><th>C/Att</th>
          <th>TD</th><th>INT</th><th>Res</th><th>Conditions</th></tr></thead>
        <tbody>${log}</tbody>
      </table></div>
    </section>`;
  }

  /* ---- TODAY (real upcoming game) ---------------------------------------- */

  function marketCell(m) {
    if (!m) return `<b class="na">${esc(MARKET_UNAVAILABLE)}</b>`;
    return `<b>${esc(m.line)}</b><em>${esc(m.book_count)} book${m.book_count === 1 ? '' : 's'}${
      m.line_low !== m.line_high ? ` · ${esc(m.line_low)}–${esc(m.line_high)}` : ''}</em>`;
  }

  function todayMarkets() {
    const c = state.ctx;
    if (!c) return '';
    const mk = c.markets;
    if (!mk || !mk.available) {
      return `<div class="qbd-mkt-none">${esc(MARKET_UNAVAILABLE)} &mdash;
        ${esc((mk && mk.reason) || 'no market source response')}</div>`;
    }
    const mine = mk.players.find(p => p.gsis_id === state.playerId);
    if (!mine) {
      return `<div class="qbd-mkt-none">${esc(MARKET_UNAVAILABLE)} &mdash;
        the current market does not price this quarterback for this game.
        ${mk.players.length ? 'Priced here: ' + esc(mk.players.map(p => p.player_name).join(', ')) + '.' : ''}</div>`;
    }
    const all = ['passing_yards', 'passing_attempts', 'completions',
                 'passing_touchdowns', 'interceptions'];
    return `<div class="qbd-mkt">
      ${all.map(k => `<div class="qbd-mkt-row">
        <span>${esc(MARKET_LABELS[k])}</span>
        ${marketCell(mine.markets[k])}
      </div>`).join('')}
    </div>
    <div class="qbd-mkt-src">Current market via the existing PropBetEdge market source${
      mk.source && mk.source.provider_last_update
        ? ' · updated ' + esc(mk.source.provider_last_update) : ''}</div>`;
  }

  function todayPanel() {
    const c = state.ctx;
    if (!c) return '';
    const g = c.game, ctx = c.context, f = c.forecast;
    const weatherReason = (c.unresolved || []).find(u => u.field === 'weather');

    const env = [
      ['Venue', g.venue ? g.venue.venue : g.espn_venue],
      ['Roof', ctx.roof || null],
      ['Surface', g.surface || null],
      ['Kickoff local', ctx.kickoff_local_hour === undefined ? null
        : `${ctx.kickoff_local_date} ${String(ctx.kickoff_local_hour).padStart(2, '0')}:00`],
      ['Temperature', f ? `${f.temp_f}°F` : null],
      ['Wind', f ? `${f.wind_mph} mph` : null],
      ['Precipitation', f ? (ctx.precip === 'none' ? 'none forecast' : ctx.precip) : null]
    ].map(([k, v]) => `<div class="qbd-env-row"><span>${esc(k)}</span>${
      v ? `<b>${esc(v)}</b>`
        : `<b class="na">${esc((weatherReason || (c.unresolved || [])[0] || {}).reason
            || 'not resolved')}</b>`}</div>`).join('');

    const w = state.ctxCmp;
    const dom = w ? domainOf([
      ...Object.values(w.windows).map(x => x.vs_baseline ? x.vs_baseline.pct : null),
      w.vs_opponent && w.vs_opponent.available ? w.vs_opponent.vs_baseline_pct : null
    ]) : 10;

    const rows = w ? Object.entries(w.windows).map(([k, x]) => x.available
      ? `<div class="qbd-cond-row">
           <div class="qbd-cond-label">${esc(x.label)}</div>
           <div class="qbd-cond-n">N=${esc(x.games)}</div>
           ${deltaCell(x.vs_baseline ? x.vs_baseline.pct : null, dom)}
           <div class="qbd-cond-val">${esc(num1(x.passing_yards_avg))}</div>
           ${samp(x.sample_label)}
         </div>`
      : `<div class="qbd-cond-row is-off">
           <div class="qbd-cond-label">${esc(x.label)}</div>
           <div class="qbd-cond-why">${esc(x.reason)}</div>
         </div>`).join('') : '';

    const unev = w && w.unevaluated.length
      ? `<div class="qbd-key">${w.unevaluated.map(u =>
          `<i>${esc(u.condition)}: ${esc(u.reason)}</i>`).join('')}</div>` : '';

    const opp = w && w.vs_opponent ? (w.vs_opponent.available
      ? `<div class="qbd-cond-row">
           <div class="qbd-cond-label">Career vs ${esc(w.vs_opponent.opponent)}</div>
           <div class="qbd-cond-n">N=${esc(w.vs_opponent.games)}</div>
           ${deltaCell(w.vs_opponent.vs_baseline_pct, dom)}
           <div class="qbd-cond-val">${esc(num1(w.vs_opponent.passing_yards_avg))}</div>
           ${samp(w.vs_opponent.sample_label)}
         </div>`
      : `<div class="qbd-cond-row is-off">
           <div class="qbd-cond-label">Career vs ${esc(w.vs_opponent.opponent)}</div>
           <div class="qbd-cond-why">${esc(w.vs_opponent.reason)}</div>
         </div>`) : '';

    const noHist = state.dna && state.dna.history_available === false;

    return `<section class="qbd-panel">
      <div class="qbd-panel-head">
        <h3>Next game · context and current market</h3>
        <span>schedule, venue and forecast fetched live</span>
      </div>
      <div class="qbd-today">
        <div class="qbd-today-id">
          <div class="qbd-today-match">${esc(g.label)}</div>
          <div class="qbd-today-when">${esc(new Date(g.kickoff_utc).toUTCString())}</div>
          <div class="qbd-today-env">${env}</div>
          <div class="qbd-today-sub">Current QB props</div>
          ${todayMarkets()}
          <div class="qbd-today-prov">
            <div>ESPN event <b>${esc(g.espn_event_id)}</b></div>
            <div>roof and surface from <b>${esc(g.roof_source === 'pbe_venue_table'
              ? 'our venue table' : 'ESPN only')}</b></div>
            <div>${c.forecast ? 'forecast <b>Open-Meteo</b>, venue local hour '
              + esc(c.forecast.hour_local.slice(11)) : 'no forecast fetched'}</div>
          </div>
        </div>
        <div>
          ${noHist
            ? `<div class="qbd-unavail-inline">${esc(SAMPLE_UNAVAILABLE)} &mdash;
                 this quarterback has no completed NFL game, so there is no history to
                 place these conditions against.</div>`
            : `${rows ? axis(dom, 'yds / game') : ''}
               ${rows || '<div class="qbd-loading">No condition window resolved for this game.</div>'}
               ${opp}${unev}`}
        </div>
      </div>
      ${noHist ? '' : `<div class="qbd-key">
        <i>Each row compares this quarterback against HIS OWN baseline
           (${w ? esc(num1(w.baseline.passing_yards_avg)) : '—'} yds/game over
           N=${w ? esc(w.baseline.games) : '—'}), not against the league.</i>
      </div>`}
    </section>`;
  }

  /* ---- CONDITIONS -------------------------------------------------------- */

  function conditions() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return noHistory();

    const dom = domainOf(Object.values(d.conditions).map(c => c.baseline_delta_pct));
    const rows = Object.entries(d.conditions).map(([, c]) => {
      if (!c.available) {
        return `<div class="qbd-cond-row is-off">
          <div class="qbd-cond-label">${esc(c.label || '')}</div>
          <div class="qbd-cond-why">${esc(c.reason || 'unavailable')}</div></div>`;
      }
      if (!c.games) {
        return `<div class="qbd-cond-row is-off">
          <div class="qbd-cond-label">${esc(c.label)}</div>
          <div class="qbd-cond-why">no game in this window &mdash; not zero, simply none</div></div>`;
      }
      const note = c.coverage && c.coverage.note
        ? `<div class="qbd-cond-why">${esc(c.coverage.note)}</div>` : '';
      return `<div class="qbd-cond-row">
        <div class="qbd-cond-label">${esc(c.label)}</div>
        <div class="qbd-cond-n">N=${esc(c.games)}</div>
        ${deltaCell(c.baseline_delta_pct, dom)}
        <div class="qbd-cond-val">${esc(num1(c.passing_yards_avg))}</div>
        ${samp(c.sample_label)}
        ${note}
      </div>`;
    }).join('');

    const gate = d.advanced_availability;
    const seasons = d.window.seasons;
    const latest = seasons[seasons.length - 1];
    const gateRows = Object.entries(gate.by_field).map(([f, v]) => {
      const g = v.seasons[latest] || Object.values(v.seasons)[0];
      return `<div class="qbd-gate-row">
        <div class="qbd-gate-f">${esc(f)}</div>
        <div class="qbd-gate-s" data-st="${esc(g.status)}">${esc(g.status.replace(/_/g, ' '))}${
          g.coverage_pct === null ? '' : ` · ${esc(g.coverage_pct)}%`}</div>
        <div class="qbd-gate-why">${esc(g.reason)}</div>
      </div>`;
    }).join('');

    return `
    <section class="qbd-panel">
      <div class="qbd-panel-head">
        <h3>Condition splits · passing yards per game</h3>
        <span>baseline ${esc(d.sample.baseline_mean)} over N=${esc(d.sample.baseline_games)}</span>
      </div>
      ${axis(dom, 'yds / game')}
      <div class="qbd-cond">${rows}</div>
      <div class="qbd-key">
        <i>The bar is movement from this quarterback's own baseline, scaled to &plusmn;${dom}%.</i>
        <i>Roofed games are excluded from every weather window by construction.</i>
      </div>
    </section>

    <section class="qbd-panel">
      <div class="qbd-panel-head">
        <h3>Advanced fields · withheld</h3>
        <span>${esc(latest)} coverage · serve threshold ${esc(gate.policy.serve_threshold_pct)}%</span>
      </div>
      <div class="qbd-gate">${gateRows}</div>
      <div class="qbd-key"><i>${esc(gate.policy.rule)}</i></div>
    </section>`;
  }

  /* ---- PROPS ------------------------------------------------------------- */

  function props() {
    const p = state.prop;
    if (!p) return '<div class="qbd-loading">Loading threshold history&hellip;</div>';

    if (p.history_available === false) return noHistory();

    // the market is not offering this market for this QB in this game
    if (p.market_state === MARKET_UNAVAILABLE) {
      const offered = p.current_market && p.current_market.markets
        ? Object.keys(p.current_market.markets) : [];
      return `<section class="qbd-panel qbd-unavail">
        <div class="qbd-panel-head"><h3>${esc(MARKET_UNAVAILABLE)}</h3>
          <span>${esc(p.market_label)} · ${esc(p.player.name)}</span></div>
        <div class="qbd-panel-body">
          <p class="qbd-unavail-lead">${esc(p.reason)}</p>
          <p class="qbd-caveat">${esc(p.note)}</p>
          ${offered.length ? `<div class="qbd-key"><i>Offered for this quarterback in this game:
            ${esc(offered.map(k => MARKET_LABELS[k] || k).join(', '))}.</i></div>` : ''}
        </div>
      </section>`;
    }

    const f = p.full_history;
    if (!f || !f.available) {
      return `<section class="qbd-panel"><div class="qbd-panel-body">
        <div class="qbd-error">${esc((f && f.reason) || 'no threshold history')}</div></div></section>`;
    }

    const ls = p.line_source || {};
    const isMarket = ls.source === 'current_market';
    const lineBadge = isMarket
      ? '<span class="qbd-linebadge is-market">Current market line</span>'
      : '<span class="qbd-linebadge">Line supplied</span>';

    const pctOf = n => (100 * n / f.total).toFixed(1);
    /* A segment narrower than the label is drawn without text rather than with
       a clipped fragment. The count is still stated in the legend and the rail,
       so nothing is lost — a truncated "PUS" would only look like a defect. */
    const seg = (cls, label, n) => {
      if (!n) return '';
      const w = 100 * n / f.total;
      return `<div class="${cls}" style="width:${w.toFixed(1)}%" title="${label} ${n}">${
        w >= 9 ? `${label} ${n}` : ''}</div>`;
    };
    const bar = `<div class="qbd-obar">
      ${seg('o', 'OVER', f.over)}${seg('p', 'PUSH', f.push)}${seg('u', 'UNDER', f.under)}
    </div>
    <div class="qbd-obar-legend"><span>${esc(f.over)} over</span>
      <span>N=${esc(f.total)} games</span><span>${esc(f.under)} under</span></div>`;

    const w = p.windowed;
    const windowed = !w ? '' : `<section class="qbd-panel">
      <div class="qbd-panel-head"><h3>Within ${esc(w.condition_label || w.condition)}</h3>
        <span>${w.available ? `N=${esc(w.total)}` : 'unavailable'}</span></div>
      <div class="qbd-panel-body">
        ${w.available
          ? `<div class="qbd-statement">${esc(w.statement)} &middot; ${esc(w.sample_label)}</div>
             <p class="qbd-caveat">Mean ${esc(w.mean)}, median ${esc(w.median)} inside this window.
             This is a count of past games, not a probability for the next one.</p>`
          : `<div class="qbd-cond-why">${esc(w.reason)}</div>`}
      </div></section>`;

    const log = p.game_log.map(g => `<tr>
      <td class="t-txt">${esc(g.date)}</td>
      <td class="t-txt">${esc(g.season)} W${esc(g.week)}</td>
      <td class="t-txt">${g.home ? 'vs' : '@'} ${esc(g.opponent)}</td>
      <td class="t-num">${esc(g.value)}</td>
      <td class="t-txt"><span class="${g.outcome === 'OVER' ? 'qbd-w'
        : g.outcome === 'UNDER' ? 'qbd-l' : ''}">${esc(g.outcome)}</span></td>
      <td class="t-txt">${g.environment_status === 'ok'
        ? `${esc(g.temp_f)}&deg;F · ${esc(g.wind_mph)} mph`
        : `<span class="qbd-cond-why">${esc(g.roof === 'dome' || g.roof === 'closed'
            ? 'roofed' : 'not resolved')}</span>`}</td>
    </tr>`).join('');

    return `
    <section class="qbd-panel">
      <div class="qbd-panel-head">
        <h3>${esc(p.market_label)} &middot; at ${esc(p.line)}</h3>
        <span>${lineBadge}${isMarket && ls.books
          ? ` &middot; ${esc(ls.books)} book${ls.books === 1 ? '' : 's'}`
            + (ls.line_low !== ls.line_high ? ` &middot; ${esc(ls.line_low)}–${esc(ls.line_high)}` : '')
          : ''}</span>
      </div>
      <div class="qbd-panel-body">
        ${bar}
        <div class="qbd-statement">${esc(f.statement)} &middot; ${esc(f.sample_label)}</div>
        <p class="qbd-caveat">${esc(p.disclosure.caveat)}${isMarket
          ? ` The line is the current market's consensus, read from the existing PropBetEdge market source${
              ls.provider_last_update ? ` (updated ${esc(ls.provider_last_update)})` : ''}.`
          : ''}</p>
      </div>
      <div class="qbd-rail">
        ${stat('Mean', f.mean, null, `across N=${esc(f.total)} games`)}
        ${stat('Median', f.median, null, 'half above, half below')}
        ${stat('Cleared', f.over, `of ${f.total}`, `${esc(f.over_pct)}% of games in the window`)}
        ${stat('Push', f.push, `of ${f.total}`, f.push ? 'landed exactly on the number' : 'no exact landings')}
      </div>
    </section>
    ${windowed}
    <section class="qbd-panel">
      <div class="qbd-panel-head"><h3>Game by game</h3><span>most recent ${esc(p.game_log.length)}</span></div>
      <div class="qbd-tablewrap"><table class="qbd-table">
        <thead><tr><th>Date</th><th>Season</th><th>Opp</th><th>Result</th>
          <th>vs line</th><th>Conditions</th></tr></thead>
        <tbody>${log}</tbody></table></div>
    </section>`;
  }

  /* ---- COMPARE ----------------------------------------------------------- */

  function compare() {
    const c = state.cmp;
    if (!c || c.mode !== 'players') return '<div class="qbd-loading">Loading comparison&hellip;</div>';
    const A = c.baseline.a, B = c.baseline.b;
    if (!A || !B) {
      return `<section class="qbd-panel qbd-unavail"><div class="qbd-panel-head">
        <h3>${esc(SAMPLE_UNAVAILABLE)}</h3><span>comparison needs history on both sides</span></div>
        <div class="qbd-panel-body"><p class="qbd-unavail-lead">
        ${esc(!A ? c.player_a.name : c.player_b.name)} has no completed NFL game in our window,
        so there is nothing to compare.</p></div></section>`;
    }

    const row = (label, av, bv, better, aSub, bSub) => {
      const aLead = better === 'a', bLead = better === 'b';
      return `<div class="qbd-cmprow">
        <div class="a ${aLead ? 'qbd-lead' : ''}">${esc(av)}${aSub ? `<em>${esc(aSub)}</em>` : ''}</div>
        <div class="k">${esc(label)}</div>
        <div class="b ${bLead ? 'qbd-lead' : ''}">${bSub ? `<em>${esc(bSub)}</em>` : ''}${esc(bv)}</div>
      </div>`;
    };
    const cmpNum = (x, y, higherIsBetter = true) =>
      x === y ? null : (higherIsBetter ? (x > y ? 'a' : 'b') : (x < y ? 'a' : 'b'));
    const nOf = r => (r && r.denominator ? `${r.numerator}/${r.denominator}` : 'no denominator');
    const gOf = x => `N=${x.games}`;

    const head = `<div class="qbd-vs">
      <div class="qbd-vs-side">
        <div class="qbd-vs-name">${esc(c.player_a.name)}</div>
        <div class="qbd-vs-meta">${esc(c.player_a.team || '')} &middot; N=${esc(A.games)} games</div>
      </div>
      <div class="qbd-vs-mid">VS</div>
      <div class="qbd-vs-side b">
        <div class="qbd-vs-name">${esc(c.player_b.name)}</div>
        <div class="qbd-vs-meta">${esc(c.player_b.team || '')} &middot; N=${esc(B.games)} games</div>
      </div>
    </div>`;

    const rows = [
      row('Yds / game', num1(A.passing_yards_avg), num1(B.passing_yards_avg),
          cmpNum(A.passing_yards_avg, B.passing_yards_avg), gOf(A), gOf(B)),
      row('Completion %', `${A.completion_pct.pct}%`, `${B.completion_pct.pct}%`,
          cmpNum(A.completion_pct.pct, B.completion_pct.pct),
          nOf(A.completion_pct), nOf(B.completion_pct)),
      row('Yds / attempt', A.ypa.value.toFixed(2), B.ypa.value.toFixed(2),
          cmpNum(A.ypa.value, B.ypa.value), nOf(A.ypa), nOf(B.ypa)),
      row('Att / game', num1(A.attempts_avg), num1(B.attempts_avg), null, gOf(A), gOf(B)),
      row('TD / game', num1(A.tds_avg), num1(B.tds_avg),
          cmpNum(A.tds_avg, B.tds_avg), gOf(A), gOf(B)),
      row('INT / game', num1(A.ints_avg), num1(B.ints_avg),
          cmpNum(A.ints_avg, B.ints_avg, false), gOf(A), gOf(B)),
      row('Sack rate', `${A.sack_rate.pct}%`, `${B.sack_rate.pct}%`,
          cmpNum(A.sack_rate.pct, B.sack_rate.pct, false),
          nOf(A.sack_rate), nOf(B.sack_rate)),
      row('Record', `${A.wins}-${A.losses}`, `${B.wins}-${B.losses}`, null,
          `${A.games_with_result || A.games} games`, `${B.games_with_result || B.games} games`)
    ].join('');

    const h = c.head_to_head;
    const h2h = h.available
      ? `<section class="qbd-panel">
          <div class="qbd-panel-head"><h3>Actual meetings</h3>
            <span>${esc(h.games)} games &middot; ${esc(h.sample_label)}</span></div>
          <div class="qbd-vs">
            <div class="qbd-vs-side"><div class="qbd-vs-name">${esc(num1(h.a.passing_yards_avg))}</div>
              <div class="qbd-vs-meta">avg yds &middot; ${esc(h.a.wins)}-${esc(h.a.losses)} &middot; N=${esc(h.games)}</div></div>
            <div class="qbd-vs-mid">H2H</div>
            <div class="qbd-vs-side b"><div class="qbd-vs-name">${esc(num1(h.b.passing_yards_avg))}</div>
              <div class="qbd-vs-meta">avg yds &middot; ${esc(h.b.wins)}-${esc(h.b.losses)} &middot; N=${esc(h.games)}</div></div>
          </div>
          <div class="qbd-tablewrap"><table class="qbd-table">
            <thead><tr><th>Date</th><th>Wk</th><th>${esc(c.player_a.name)}</th><th>Res</th>
              <th>${esc(c.player_b.name)}</th><th>Res</th></tr></thead>
            <tbody>${h.meetings.map(m => `<tr>
              <td class="t-txt">${esc(m.date)}</td>
              <td class="t-txt">${esc(m.season)} W${esc(m.week)}</td>
              <td>${esc(m.a.passing_yards)} yds &middot; ${esc(m.a.td)} TD &middot; ${esc(m.a.int)} INT</td>
              <td class="t-txt"><span class="qbd-${String(m.a.result).toLowerCase()}">${esc(m.a.result)}</span></td>
              <td>${m.b ? `${esc(m.b.passing_yards)} yds &middot; ${esc(m.b.td)} TD &middot; ${esc(m.b.int)} INT` : '—'}</td>
              <td class="t-txt">${m.b ? `<span class="qbd-${String(m.b.result).toLowerCase()}">${esc(m.b.result)}</span>` : '—'}</td>
            </tr>`).join('')}</tbody></table></div>
          <div class="qbd-key"><i>Games in which both quarterbacks actually appeared,
            matched on game id. ${esc(h.sample_label)} &mdash; a size label, not a claim.</i></div>
        </section>`
      : `<section class="qbd-panel"><div class="qbd-panel-head"><h3>Actual meetings</h3><span>none</span></div>
          <div class="qbd-panel-body"><div class="qbd-cond-why">${esc(h.reason)}</div></div></section>`;

    const condRows = Object.entries(c.conditions).map(([, x]) => x.available
      ? `<div class="qbd-cmprow">
          <div class="a">${esc(num1(x.a.passing_yards_avg))}
            <em>N=${esc(x.a.games)} · ${esc(pct1(x.a_vs_own_baseline))}</em></div>
          <div class="k">${esc(x.label)}</div>
          <div class="b">${esc(num1(x.b.passing_yards_avg))}
            <em>N=${esc(x.b.games)} · ${esc(pct1(x.b_vs_own_baseline))}</em></div>
        </div>`
      : `<div class="qbd-cmprow"><div class="a qbd-cond-why">${esc(x.games_a)} games</div>
          <div class="k">${esc(x.label)}</div>
          <div class="b qbd-cond-why">${esc(x.reason)}</div></div>`).join('');

    return `<section class="qbd-panel">
      <div class="qbd-panel-head"><h3>Baseline comparison</h3>
        <span>each quarterback over his own full window</span></div>
      ${head}${rows}
      <div class="qbd-key"><i>Gold marks the higher figure. It is a comparison of
        counted history over different sample sizes (N=${esc(A.games)} vs N=${esc(B.games)}),
        not a ranking.</i></div>
    </section>
    ${h2h}
    <section class="qbd-panel">
      <div class="qbd-panel-head"><h3>By condition</h3>
        <span>each side also shown against his OWN baseline</span></div>
      ${condRows}
    </section>`;
  }

  /* ---- SOURCES ----------------------------------------------------------- */

  function sources() {
    const p = state.dna && state.dna.provenance;
    if (!p) return '';
    const lines = [
      ['Historical play and game data', 'nflverse', 'CC BY 4.0'],
      ['Historical and current weather', 'Open-Meteo', 'CC BY 4.0'],
      ['Current schedule and game context', 'ESPN public endpoints', ''],
      ['Current markets', 'existing PropBetEdge market source', '']
    ];
    return `<details class="qbd-sources">
      <summary>Sources and attribution</summary>
      <div class="qbd-sources-body">
        <div class="qbd-src">
          ${lines.map(([what, who, lic]) => `<div class="qbd-src-item">
            <b>${esc(what)}</b><span>${esc(who)}${lic ? ' · ' + esc(lic) : ''}</span></div>`).join('')}
        </div>
        <div class="qbd-src" style="margin-top:14px">
          ${p.sources.map(s => `<div class="qbd-src-item">
            <span>${esc(s.attribution || s.name)}${s.url ? ' — ' + esc(s.url) : ''}</span>
          </div>`).join('')}
        </div>
        <div class="qbd-src" style="margin-top:14px">
          ${p.notes.map(n => `<div class="qbd-src-item"><span>${esc(n)}</span></div>`).join('')}
        </div>
        <div class="qbd-src-stamp">Dataset snapshot ${esc(p.dataset_generated_at)}
          · data through ${esc(p.data_through)}</div>
      </div>
    </details>`;
  }

  /* ---- shell ------------------------------------------------------------- */

  const TABS = [['overview', 'Overview'], ['props', 'Props'],
                ['conditions', 'Conditions'], ['compare', 'Compare']];

  function playerOptions(selectedId) {
    if (!state.players) return `<option>${esc(selectedId)}</option>`;
    const opt = p => `<option value="${esc(p.gsis_id)}"${p.gsis_id === selectedId ? ' selected' : ''}>${
      esc(p.name)} · ${esc(p.team_2026 || p.team || '')} · ${
      p.history_available ? esc(p.games) + 'g' : 'no NFL history'}</option>`;
    const priced = state.players.players.filter(p => p.market_priced_2026);
    const active = state.players.players.filter(p => !p.market_priced_2026 && p.active_2026);
    const rest = state.players.players.filter(p => !p.active_2026);
    return `${priced.length ? `<optgroup label="Priced by the current market">${
        priced.map(opt).join('')}</optgroup>` : ''}
      ${active.length ? `<optgroup label="On a 2026 roster">${active.map(opt).join('')}</optgroup>` : ''}
      ${rest.length ? `<optgroup label="Historical">${rest.map(opt).join('')}</optgroup>` : ''}`;
  }

  function marketOptions() {
    // offer the markets the current game actually has, then the rest
    const mine = state.ctx && state.ctx.markets && state.ctx.markets.available
      ? (state.ctx.markets.players.find(p => p.gsis_id === state.playerId) || null) : null;
    return Object.entries(MARKET_LABELS).map(([k, v]) => {
      const has = mine ? Boolean(mine.markets[k]) : null;
      const suffix = has === null ? '' : has ? ` · ${mine.markets[k].line}` : ' · no market';
      return `<option value="${k}"${state.market === k ? ' selected' : ''}>${esc(v)}${esc(suffix)}</option>`;
    }).join('');
  }

  function controls() {
    const gameOpts = state.slate ? state.slate.games.map(g =>
      `<option value="${esc(g.espn_event_id)}"${g.espn_event_id === state.eventId ? ' selected' : ''}>${
        esc(g.label)}</option>`).join('') : '';

    return `<div class="qbd-bar">
      <div class="qbd-field"><label for="qbd-p">Quarterback</label>
        <select class="qbd-select" id="qbd-p" data-k="playerId">${playerOptions(state.playerId)}</select></div>
      ${gameOpts ? `<div class="qbd-field"><label for="qbd-g">Game</label>
        <select class="qbd-select" id="qbd-g" data-k="eventId">${gameOpts}</select></div>` : ''}
      ${state.tab === 'compare' ? `<div class="qbd-field"><label for="qbd-p2">Against</label>
        <select class="qbd-select" id="qbd-p2" data-k="comparePlayerId">${playerOptions(state.comparePlayerId)}</select></div>` : ''}
      ${state.tab === 'props' ? `
        <div class="qbd-field"><label for="qbd-m">Market</label>
          <select class="qbd-select" id="qbd-m" data-k="market">${marketOptions()}</select></div>
        <div class="qbd-field"><label for="qbd-l">Line</label>
          <input class="qbd-input" id="qbd-l" data-k="line" type="number" step="0.5"
            value="${esc(state.line)}" placeholder="market" inputmode="decimal">
          <span class="qbd-hint">blank = current market</span></div>` : ''}
    </div>`;
  }

  function bodyHtml() {
    if (state.error) return `<div class="qbd-error">${esc(state.error)}</div>`;
    if (state.loading && !state.dna) return '<div class="qbd-loading">Loading quarterback history&hellip;</div>';
    if (state.tab === 'props') return props();
    if (state.tab === 'conditions') return conditions();
    if (state.tab === 'compare') return compare();
    return overview();
  }

  function render() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    const d = state.dna;
    const noHist = d && d.history_available === false;
    vc.innerHTML = `<section class="qbd">
      <header class="qbd-mast">
        <div>
          <div class="qbd-eyebrow">QB DNA · prototype · public-source warehouse</div>
          <h1 class="qbd-title">${d ? esc(d.player.name) : 'Quarterback'} <em>intelligence</em></h1>
          <p class="qbd-sub">Counted history for one quarterback: his baseline, how he has actually
            performed in each condition relative to that baseline, how often the current market's
            number has been cleared, and how he compares with another quarterback in games they
            both played.</p>
        </div>
        <div class="qbd-mastmeta">
          ${d ? `<div>GSIS <b>${esc(d.player.gsis_id)}</b></div>
                 <div>ESPN <b>${esc(d.player.espn_id || 'none')}</b></div>
                 <div>PFR <b>${esc(d.player.pfr_id || 'none')}</b></div>
                 <div>resolved by <b>${esc(d.player.matched_by)}</b></div>
                 ${noHist ? `<div class="qbd-mastflag">${esc(SAMPLE_UNAVAILABLE)}</div>` : ''}` : ''}
        </div>
      </header>
      ${windowStrip()}
      <div class="qbd-proto">
        <strong>Prototype · not in navigation</strong>
        Historical figures are counted from completed games in our own public-source warehouse.
        Current schedule, venue and forecast are fetched live; current lines come from the
        existing PropBetEdge market source. Nothing here is a projection, a probability or
        betting advice.
      </div>
      ${controls()}
      <nav class="qbd-tabs">${TABS.map(([k, v]) =>
        `<button class="qbd-tab${state.tab === k ? ' is-on' : ''}" data-tab="${k}">${v}</button>`).join('')}</nav>
      <div class="qbd-body">${bodyHtml()}${sources()}</div>
    </section>`;
    wire();
  }

  function wire() {
    document.querySelectorAll('.qbd-tab').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      load();
    }));
    document.querySelectorAll('[data-k]').forEach(el => {
      el.addEventListener('change', () => {
        const k = el.dataset.k;
        state[k] = el.value;
        if (k === 'playerId') {
          state.dna = null; state.prop = null; state.cmp = null; state.ctxCmp = null;
          /* Release the selected game too. A quarterback's context must default
             to HIS OWN next game — holding the previous selection would show a
             New Orleans passer the Kansas City matchup. Picking a game
             explicitly still overrides this on the next change. */
          state.eventId = null; state.ctx = null;
        }
        if (k === 'market' || k === 'line') state.prop = null;
        if (k === 'comparePlayerId') state.cmp = null;
        if (k === 'eventId') { state.ctx = null; state.ctxCmp = null; state.prop = null; }
        load();
      });
    });
  }

  /* ---- data -------------------------------------------------------------- */

  let seq = 0;

  async function load() {
    const mine = ++seq;
    state.loading = true; state.error = null;
    render();
    const stale = () => mine !== seq;
    try {
      if (!state.players) state.players = await get('/api/qb-dna?list=1');
      if (stale()) return;
      if (!state.dna) state.dna = await get(`/api/qb-dna?player_id=${encodeURIComponent(state.playerId)}`);
      if (stale()) return;

      // the game context feeds the overview panel AND the props line, so it is
      // resolved for both tabs
      if (!state.ctx || (state.tab === 'overview' && !state.ctxCmp)) await loadContext();
      if (stale()) return;

      if (state.tab === 'props' && !state.prop) {
        const q = [`player_id=${encodeURIComponent(state.playerId)}`,
                   `market=${encodeURIComponent(state.market)}`];
        // A typed line wins. Otherwise the CURRENT MARKET line for this game.
        // If neither exists nothing is calculated — no default is invented here
        // any more than it is in the API.
        if (state.line !== '' && Number.isFinite(Number(state.line))) {
          q.push(`line=${encodeURIComponent(state.line)}`);
        } else if (state.ctx && state.ctx.market_event_id) {
          q.push(`event_id=${encodeURIComponent(state.ctx.market_event_id)}`);
        } else {
          state.prop = {
            history_available: true, market: state.market,
            market_label: MARKET_LABELS[state.market],
            market_state: MARKET_UNAVAILABLE,
            reason: 'no current market event is matched to the selected game',
            note: 'No default line is inserted. Type a line to test one explicitly.',
            player: state.dna.player
          };
          state.loading = false; render(); return;
        }
        state.prop = await get('/api/qb-dna/prop-history?' + q.join('&'));
      } else if (state.tab === 'compare' && !state.cmp) {
        state.cmp = await get('/api/qb-dna/compare?'
          + `player_a=${encodeURIComponent(state.playerId)}`
          + `&player_b=${encodeURIComponent(state.comparePlayerId)}`);
      }
      if (stale()) return;
    } catch (e) {
      if (stale()) return;
      state.error = `Could not load QB DNA: ${e.message}`;
    }
    state.loading = false;
    render();
  }

  /** The next-game panel. A failure here must NOT take down the history view. */
  async function loadContext() {
    try {
      if (!state.slate) state.slate = await get('/api/qb-dna/game-context');
      if (!state.slate.games.length) return;
      if (!state.eventId) {
        const team = state.dna.player.current_team || null;
        const mine = state.slate.games.find(g => g.home_team === team || g.away_team === team);
        state.eventId = (mine || state.slate.games[0]).espn_event_id;
      }
      state.ctx = await get(`/api/qb-dna/game-context?event_id=${encodeURIComponent(state.eventId)}`);
      state.ctxCmp = null;
      if (state.dna.history_available === false) return;
      const g = state.ctx.game, c = state.ctx.context;
      if (!c || !c.roof) return;
      const isHome = g.home_team === state.dna.player.current_team;
      const q = [`player_id=${encodeURIComponent(state.playerId)}`, `roof=${c.roof}`,
                 `home=${isHome}`, `opponent=${isHome ? g.away_team : g.home_team}`,
                 `primetime=${c.primetime}`];
      if (c.temp_f !== undefined) q.push(`temp_f=${c.temp_f}`);
      if (c.wind_mph !== undefined) q.push(`wind_mph=${c.wind_mph}`);
      if (c.precip !== undefined) q.push(`precip=${c.precip}`);
      state.ctxCmp = await get('/api/qb-dna/compare?' + q.join('&'));
    } catch (e) {
      state.ctx = null; state.ctxCmp = null;
      console.warn('[qbdna] next-game context unavailable:', e.message);
    }
  }

  function view() { if (!state.dna) load(); else render(); }

  function install() {
    if (!window.App || !window.App.VIEWS) return false;
    App.VIEWS.qbdna = view;
    App.VIEWS['qb-dna'] = view;
    return true;
  }

  window.PBEQBDna = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
  window.addEventListener('pbe:upgrades-ready', install);
})();
