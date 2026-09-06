/* ============================================================================
   PropBetEdge NFL — QB DNA v2
   ----------------------------------------------------------------------------
   The quarterback intelligence product. Sole UI authority for the qbdna route.

   Reads /api/qb-dna, /api/qb-dna/prop-lab, /api/qb-dna/compare and
   /api/qb-dna/game-context. It DRAWS; it does not calculate. Every figure,
   every split, every signal classification and every chart series is computed
   in the engine, so the surface can never disagree with the API about a number.

   What the first viewport must answer, in order:
     who he is · who he plays next · what today's numbers are · what conditions
     move him · where his history is strong and weak · how today compares.

   Truth rules carried over unchanged:
     · real photographs only — no PBE mark, no initials disc, no generic helmet
     · a percentage never appears without its numerator, denominator or N
     · an unavailable value states its reason where the number would have been
     · a movement is only called a strength or a watchout when the sample
       supports it; the engine decides that, not this file
     · "historical clear rate", never "chance"
   ========================================================================== */
(() => {
  'use strict';

  const PD = window.PBEPlayerDNA;

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MARKET_UNAVAILABLE = 'Market unavailable';
  const SAMPLE_UNAVAILABLE = 'No NFL game sample yet';
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tab: 'overview',
    playerId: '00-0033873',
    comparePlayerId: '00-0034857',
    eventId: null,
    openMarket: 'passing_yards',
    players: null, dna: null, lab: null, cmp: null, ctxCmp: null, ctx: null, slate: null,
    loading: false, error: null
  };

  async function get(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok === false) {
      throw new Error((j && (j.detail || j.error)) || `HTTP ${r.status}`);
    }
    return j;
  }

  /* ---- formatting -------------------------------------------------------- */
  const n1 = v => (typeof v === 'number' ? v.toFixed(1) : v);
  const pctSigned = v => (typeof v === 'number' ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—');
  const samp = l => (l ? `<span class="q2-samp" data-s="${esc(l)}">${esc(l)}</span>` : '');
  /** numerator/denominator, so a rate is never printed bare */
  const den = r => (r && r.denominator ? `${r.numerator}/${r.denominator}` : 'no denominator');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function longDate(iso) {
    const d = new Date(iso + (iso.length === 10 ? 'T12:00:00Z' : ''));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  function kickoffLabel(iso) {
    const d = new Date(iso);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    // the shell presents Eastern time product-wide; match it
    const et = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
      minute: '2-digit', hour12: true
    }).formatToParts(d);
    const g = t => (et.find(x => x.type === t) || {}).value || '';
    return `${g('weekday') || day} · ${g('hour')}:${g('minute')} ${g('dayPeriod')} ET`;
  }

  /* ---- identity media ----------------------------------------------------
     Real photographs only. An identity with no resolvable photo renders an
     explicit absence; it never borrows a mark to stand in for a face. */
  const IMG_FAIL = "this.classList.add('is-broken');this.removeAttribute('src')";

  const SEARCH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10.6 10.6 L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  </svg>`;

  function headshot(player, size, cls) {
    const url = player && player.media && player.media.headshot_url;
    const name = (player && player.name) || 'Quarterback';
    if (!url) {
      return `<span class="q2-face q2-face-none ${cls || ''}" style="--face:${size}px"
        role="img" aria-label="No photograph available for ${esc(name)}"
        title="${esc((player && player.media && player.media.unavailable_reason)
          || 'no photograph available')}"><i>No photo</i></span>`;
    }
    return `<img class="q2-face ${cls || ''}" style="--face:${size}px" src="${esc(url)}"
      alt="${esc(name)}" width="${size}" height="${size}"
      loading="lazy" decoding="async" onerror="${IMG_FAIL}">`;
  }
  function crest(team, size, cls) {
    const url = team && team.media && team.media.logo_url;
    if (!url) return '';
    return `<img class="q2-crest ${cls || ''}" style="--crest:${size}px" src="${esc(url)}"
      alt="${esc(team.name || team.abbreviation || '')}" width="${size}" height="${size}"
      loading="lazy" decoding="async" onerror="${IMG_FAIL}">`;
  }
  function matchupLine(game, size) {
    if (!game) return '';
    if (!game.away || !game.home) return `<span>${esc(game.label)}</span>`;
    const side = t => `${crest(t, size)}<b>${esc(t.abbreviation)}</b>`;
    return `<span class="q2-match">${side(game.away)}<em>@</em>${side(game.home)}</span>`;
  }

  /* ======================================================================
     CHARTS — canvas, drawn from series the API already computed.
     No library, no animation loop, one restrained entrance unless the
     viewer has asked for reduced motion.
     ====================================================================== */

  /* A chart competes with dense type around it, so its ink is pitched a step
     brighter than the panel chrome. Muted bars read as disabled, not subtle. */
  const CHART = {
    ink: '#14110d', line: 'rgba(255,245,220,.09)', lineStrong: 'rgba(255,245,220,.22)',
    text: '#a5a096', paper: '#e8e1d4', gold: '#e9c75a',
    pos: '#5cbb85', neg: '#e04a5f', dim: '#6b665e',
    posFill: 'rgba(92,187,133,.78)', negFill: 'rgba(224,74,95,.72)'
  };

  function fitCanvas(cv, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || cv.parentElement.clientWidth || 600;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /**
   * Game-by-game outcomes as bars, with the current line, the mean and the
   * median drawn across them. Answers "is he trending over or under today's
   * number" without the reader doing any arithmetic.
   */
  function drawSeries(cv, opts) {
    const games = (opts.games || []).filter(g => typeof g.value === 'number');
    if (!games.length) return;
    const { ctx, w, h } = fitCanvas(cv, opts.height || 190);
    const padL = 34, padR = 10, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const vals = games.map(g => g.value);
    const refs = [opts.line, opts.mean, opts.median].filter(v => typeof v === 'number');
    const max = Math.max(...vals, ...refs) * 1.08;
    const min = 0;
    const y = v => padT + ih - ((v - min) / (max - min)) * ih;
    const bw = Math.max(3, Math.min(26, iw / games.length - 3));
    const step = iw / games.length;

    ctx.clearRect(0, 0, w, h);

    // horizontal guides
    ctx.strokeStyle = CHART.line; ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = min + (max - min) * (i / ticks);
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(String(Math.round(v)), padL - 6, yy);
    }

    // bars, coloured by their relation to the line when there is one
    games.forEach((g, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const top = y(g.value);
      const over = typeof opts.line === 'number' ? g.value > opts.line
        : (typeof opts.mean === 'number' ? g.value > opts.mean : true);
      const push = typeof opts.line === 'number' && g.value === opts.line;
      ctx.fillStyle = push ? CHART.dim : over ? CHART.posFill : CHART.negFill;
      ctx.fillRect(x, top, bw, padT + ih - top);
      ctx.strokeStyle = push ? CHART.dim : over ? CHART.pos : CHART.neg;
      ctx.lineWidth = 1.25;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(top) + 0.5, Math.round(bw), Math.round(padT + ih - top));
    });

    // reference lines
    const ref = (v, colour, dash, label) => {
      if (typeof v !== 'number') return;
      const yy = Math.round(y(v)) + 0.5;
      ctx.save();
      ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.restore();
      if (label) {
        ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
        const t = `${label} ${v}`;
        const tw = ctx.measureText(t).width + 8;
        ctx.fillStyle = CHART.ink;
        ctx.fillRect(w - padR - tw, yy - 7, tw, 14);
        ctx.strokeStyle = colour; ctx.lineWidth = 1;
        ctx.strokeRect(w - padR - tw + 0.5, yy - 6.5, tw - 1, 13);
        ctx.fillStyle = colour; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(t, w - padR - 4, yy);
      }
    };
    ref(opts.median, CHART.dim, [2, 3], null);
    ref(opts.mean, CHART.text, [4, 4], 'AVG');
    ref(opts.line, CHART.gold, [], 'LINE');

    // sparse x labels so the axis never turns into a smear
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.ceil(games.length / (w < 520 ? 4 : 8));
    games.forEach((g, i) => {
      if (i % every && i !== games.length - 1) return;
      ctx.fillText(g.opponent ? (g.home ? 'vs ' : '@ ') + g.opponent : String(g.week ?? ''),
        padL + i * step + step / 2, padT + ih + 7);
    });
  }

  /**
   * Distribution of every completed outcome against today's line. The reader
   * should see where the number sits inside what has actually happened.
   */
  function drawDistribution(cv, opts) {
    const vals = (opts.values || []).filter(v => typeof v === 'number');
    if (!vals.length) return;
    const { ctx, w, h } = fitCanvas(cv, opts.height || 150);
    const padL = 10, padR = 10, padT = 16, padB = 30;
    const iw = w - padL - padR, ih = h - padT - padB;
    const lo = 0;
    const hi = Math.max(...vals, opts.line || 0) * 1.06;
    const x = v => padL + ((v - lo) / (hi - lo)) * iw;

    const BUCKETS = Math.max(8, Math.min(24, Math.round(iw / 26)));
    const bw = (hi - lo) / BUCKETS;
    const bins = new Array(BUCKETS).fill(0).map(() => ({ over: 0, under: 0, push: 0 }));
    for (const v of vals) {
      const b = Math.min(BUCKETS - 1, Math.floor((v - lo) / bw));
      const k = typeof opts.line !== 'number' ? 'over'
        : v > opts.line ? 'over' : v < opts.line ? 'under' : 'push';
      bins[b][k]++;
    }
    const peak = Math.max(...bins.map(b => b.over + b.under + b.push)) || 1;

    ctx.clearRect(0, 0, w, h);
    // baseline
    ctx.strokeStyle = CHART.lineStrong; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + ih + 0.5); ctx.lineTo(w - padR, padT + ih + 0.5); ctx.stroke();

    const cw = iw / BUCKETS;
    bins.forEach((b, i) => {
      const total = b.over + b.under + b.push;
      if (!total) return;
      const bx = padL + i * cw + 1;
      const bwid = Math.max(2, cw - 2);
      let yy = padT + ih;
      const seg = (count, fill, stroke) => {
        if (!count) return;
        const hgt = (count / peak) * ih;
        yy -= hgt;
        ctx.fillStyle = fill; ctx.fillRect(bx, yy, bwid, hgt);
        ctx.strokeStyle = stroke; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(bx) + 0.5, Math.round(yy) + 0.5, Math.round(bwid), Math.round(hgt));
      };
      seg(b.under, CHART.negFill, CHART.neg);
      seg(b.push, 'rgba(107,102,94,.9)', CHART.dim);
      seg(b.over, CHART.posFill, CHART.pos);
    });

    // today's line, drawn through the distribution
    if (typeof opts.line === 'number') {
      const lx = Math.round(x(opts.line)) + 0.5;
      ctx.strokeStyle = CHART.gold; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, padT - 6); ctx.lineTo(lx, padT + ih); ctx.stroke();
      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
      const t = String(opts.line);
      const tw = ctx.measureText(t).width + 10;
      const bx = Math.max(padL, Math.min(w - padR - tw, lx - tw / 2));
      ctx.fillStyle = CHART.gold;
      ctx.fillRect(bx, 0, tw, 14);
      ctx.fillStyle = CHART.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, bx + tw / 2, 7);
    }

    // axis
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * (i / 4);
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(String(Math.round(v)), x(v), padT + ih + 8);
    }
  }

  /** Paint every canvas the current render put on the page. */
  function paintCharts() {
    document.querySelectorAll('canvas[data-chart]').forEach(cv => {
      let cfg;
      try { cfg = JSON.parse(cv.dataset.cfg || '{}'); } catch { return; }
      if (cv.dataset.chart === 'series') drawSeries(cv, cfg);
      else if (cv.dataset.chart === 'dist') drawDistribution(cv, cfg);
      if (!REDUCED) {
        cv.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      }
    });
  }

  /* ======================================================================
     HERO
     ====================================================================== */

  function heroLines() {
    const c = state.ctx;
    if (!c || !c.markets || !c.markets.available) {
      return `<div class="q2-hero-lines is-none">${esc(MARKET_UNAVAILABLE)}</div>`;
    }
    const mine = c.markets.players.find(p => p.gsis_id === state.playerId);
    if (!mine) {
      return `<div class="q2-hero-lines is-none">${esc(MARKET_UNAVAILABLE)} · no current market prices this quarterback for this game</div>`;
    }
    const order = ['passing_yards', 'completions', 'passing_touchdowns',
                   'passing_attempts', 'interceptions'];
    const cards = order.filter(k => mine.markets[k]).map(k => {
      const m = mine.markets[k];
      return `<button type="button" class="q2-hero-line" data-jump="${esc(k)}">
        <span>${esc(LABELS[k])}</span><b>${esc(m.line)}</b>
        <em>${esc(m.book_count)} book${m.book_count === 1 ? '' : 's'}</em>
      </button>`;
    }).join('');
    return cards ? `<div class="q2-hero-lines">${cards}</div>` : '';
  }

  const LABELS = {
    passing_yards: 'Pass yds', passing_attempts: 'Attempts', completions: 'Completions',
    passing_touchdowns: 'Pass TD', interceptions: 'Interceptions'
  };

  function heroNext() {
    const c = state.ctx;
    if (!c) return '';
    const g = c.game, ctx = c.context, f = c.forecast;
    const env = [];
    if (f) {
      env.push(`${f.temp_f}°F`, `${f.wind_mph} mph`);
      env.push(ctx.precip === 'none' ? 'no precipitation' : ctx.precip);
    }
    if (ctx && ctx.roof) env.push(ctx.roof === 'closed' ? 'Roof closed' : 'Outdoor');
    const venue = g.venue ? g.venue.venue : g.espn_venue;
    return `<div class="q2-hero-next">
      <div class="q2-hero-next-k">Next</div>
      <div class="q2-hero-next-m">${matchupLine(g, 26)}</div>
      <div class="q2-hero-next-w">${esc(kickoffLabel(g.kickoff_utc))}</div>
      ${venue ? `<div class="q2-hero-next-v">${esc(venue)}</div>` : ''}
      ${env.length ? `<div class="q2-hero-next-e">${env.map(e => `<span>${esc(e)}</span>`).join('')}</div>`
        : `<div class="q2-hero-next-e is-none">${esc(PD.softReason(((c.unresolved || [])[0] || {}).reason)
            || 'conditions not resolved')}</div>`}
    </div>`;
  }

  function hero() {
    const d = state.dna;
    if (!d) return '<header class="q2-hero is-loading"><div class="q2-hero-copy"></div></header>';
    const p = d.player;
    const t = p.team;
    const noHist = d.history_available === false;
    return `<header class="q2-hero">
      <div class="q2-hero-top">
        <div class="q2-hero-lead">
          <div class="q2-hero-eyebrow">QB DNA</div>
          ${PD.familySwitch('qbdna')}
        </div>
        ${t ? `<div class="q2-hero-club">${crest(t, 30)}<span>${esc(t.name || t.abbreviation)}</span></div>` : ''}
      </div>
      <div class="q2-hero-body">
        <button type="button" class="q2-hero-face" data-picker="playerId"
          title="Change quarterback">${headshot(p, 148)}
          <span class="q2-hero-face-cta">Change</span></button>
        <div class="q2-hero-copy">
          <h1 class="q2-hero-name">${esc(p.name)}</h1>
          <div class="q2-hero-meta">${esc(p.position || 'QB')}
            <i></i>${esc((t && (t.name || t.abbreviation)) || p.current_team || '')}</div>
          <!-- The headshot stays clickable, but the affordance cannot live in a
               hover state: a reader has to SEE that the quarterback is a choice. -->
          <button type="button" class="q2-change" data-picker="playerId">
            ${SEARCH_ICON}Change QB<em aria-hidden="true">&#9662;</em>
          </button>
          ${noHist ? `<div class="q2-hero-flag">${esc(SAMPLE_UNAVAILABLE)}</div>` : ''}
          ${heroNext()}
        </div>
      </div>
      ${heroLines()}
    </header>`;
  }

  /* ======================================================================
     STATUS RAIL — truth, refined, not dominant
     ====================================================================== */
  function statusRail() {
    const w = (state.dna && state.dna.data_window)
      || (state.players && state.players.data_window);
    if (!w) return '';
    const games = state.players && state.players.provenance
      ? state.players.provenance.qb_games_in_dataset : null;
    return `<div class="q2-rail">
      <span>History through <b>${esc(longDate(w.data_through))}</b></span>
      <span>${esc(w.seasons[0])}&ndash;${esc(w.latest_season)}</span>
      ${games ? `<span>${esc(games.toLocaleString())} QB games</span>` : ''}
      ${(w.seasons_without_play_by_play || []).length
        ? `<span class="q2-rail-note">${esc(w.seasons_without_play_by_play.join(', '))}
             has no completed game yet</span>` : ''}
    </div>`;
  }

  /* ======================================================================
     OVERVIEW
     ====================================================================== */

  function bigStat(k, v, unit, sub, tone) {
    const empty = v === null || v === undefined;
    return `<div class="q2-big${empty ? ' is-empty' : ''}${tone ? ' t-' + tone : ''}">
      <div class="q2-big-k">${esc(k)}</div>
      <div class="q2-big-v">${empty ? 'Not available'
        : esc(v) + (unit ? `<small>${esc(unit)}</small>` : '')}</div>
      <div class="q2-big-n">${sub || ''}</div>
    </div>`;
  }

  function snapshot() {
    const b = state.dna.baseline;
    const py = b.passing_yards || {};
    return `<section class="q2-panel">
      <div class="q2-head"><h2>QB snapshot</h2>
        <span>career in window · ${esc(b.games)} games</span></div>
      <div class="q2-bigs">
        ${bigStat('Pass yds / game', py.mean, null, `median ${esc(py.median)} · N=${esc(b.games)}`)}
        ${bigStat('Completion', b.completion_pct.pct, '%', den(b.completion_pct) + ' att')}
        ${bigStat('Yards / attempt', b.ypa.value, null, den(b.ypa) + ' att')}
        ${bigStat('TD rate', b.td_rate.pct, '%', `${b.td_rate.numerator} TD · ${b.td_rate.denominator} att`)}
        ${bigStat('INT rate', b.int_rate.pct, '%', `${b.int_rate.numerator} INT · ${b.int_rate.denominator} att`)}
        ${bigStat('Record', b.wins === null ? null : `${b.wins}-${b.losses}`, null,
          `${esc(b.games_with_result)} games decided`)}
      </div>
    </section>`;
  }

  function form() {
    const d = state.dna;
    const fs = d.form_series;
    const line = currentLine('passing_yards');
    const cfg = JSON.stringify({
      games: fs.games, mean: fs.mean, median: fs.median,
      line: typeof line === 'number' ? line : null, height: 210
    });
    const order = ['last_5', 'last_10', 'current_season', 'career'];
    const chips = order.map(k => {
      const w = d.recent[k];
      if (!w || !w.available) return '';
      const s = w.passing_yards || {};
      return `<div class="q2-formchip">
        <div class="q2-formchip-k">${esc(w.label)}</div>
        <div class="q2-formchip-v">${esc(n1(s.mean))}<small>yds</small></div>
        <div class="q2-formchip-n">N=${esc(w.games)}${
          w.shortfall_note ? ' · ' + esc(w.shortfall_note) : ''} · ${esc(w.completion_pct.pct)}% cmp</div>
        ${samp(w.sample_label)}
      </div>`;
    }).join('');

    return `<section class="q2-panel">
      <div class="q2-head"><h2>Form</h2>
        <span>passing yards, last ${esc(fs.games.length)} games${
          typeof line === 'number' ? ` · current line ${esc(line)}` : ''}</span></div>
      <div class="q2-formchips">${chips}</div>
      <div class="q2-chart">
        <canvas data-chart="series" data-cfg='${esc(cfg)}' aria-label="Passing yards by game"></canvas>
      </div>
      <div class="q2-legend">
        <i class="k-over"></i>${typeof line === 'number' ? 'Over the line' : 'Above average'}
        <i class="k-under"></i>${typeof line === 'number' ? 'Under the line' : 'Below average'}
        ${typeof line === 'number' ? '<i class="k-line"></i>Current market line' : ''}
        <i class="k-avg"></i>Career average
      </div>
    </section>`;
  }

  function signalCard(x, tier) {
    return `<article class="q2-sig t-${tier}">
      <div class="q2-sig-top">
        <div class="q2-sig-label">${esc(x.label)}</div>
        <div class="q2-sig-move">${esc(pctSigned(x.baseline_delta_pct))}</div>
      </div>
      <div class="q2-sig-val">${esc(n1(x.passing_yards_avg))}<small>yds / game</small></div>
      <div class="q2-sig-meta">
        ${x.record ? `<span>${esc(x.record)}</span>` : ''}
        <span>N=${esc(x.games)}</span>
        ${samp(x.sample_label)}
      </div>
    </article>`;
  }

  function dna() {
    const g = state.dna.dna_signals;
    if (!g) return '';
    const has = g.strengths.length + g.watchouts.length + g.signals.length;
    return `<section class="q2-panel">
      <div class="q2-head"><h2>Historical DNA</h2>
        <span>versus his own baseline of ${esc(g.baseline_mean)} yds / game over N=${esc(g.baseline_n)}</span></div>
      ${has ? `
        ${g.strengths.length ? `<div class="q2-sigrow">
          <div class="q2-sigrow-k">Strength</div>
          <div class="q2-sigs">${g.strengths.map(x => signalCard(x, 'up')).join('')}</div>
        </div>` : ''}
        ${g.watchouts.length ? `<div class="q2-sigrow">
          <div class="q2-sigrow-k">Watchout</div>
          <div class="q2-sigs">${g.watchouts.map(x => signalCard(x, 'down')).join('')}</div>
        </div>` : ''}
        ${g.signals.length ? `<div class="q2-sigrow">
          <div class="q2-sigrow-k">Signal <em>small sample</em></div>
          <div class="q2-sigs">${g.signals.map(x => signalCard(x, 'sig')).join('')}</div>
        </div>` : ''}`
      : '<div class="q2-empty">No condition moves this quarterback far enough from his own baseline to report.</div>'}
      ${g.insufficient.length ? `<div class="q2-insuf">
        <div class="q2-insuf-k">Too few games to call either way</div>
        <div class="q2-insuf-list">${g.insufficient.map(x =>
          `<span>${esc(x.label)} <b>${esc(pctSigned(x.baseline_delta_pct))}</b> N=${esc(x.games)}</span>`).join('')}</div>
        <p>${esc(g.policy.rule)}</p>
      </div>` : ''}
    </section>`;
  }

  /** The current market line for a market, or null. */
  function currentLine(market) {
    const c = state.ctx;
    if (!c || !c.markets || !c.markets.available) return null;
    const mine = c.markets.players.find(p => p.gsis_id === state.playerId);
    const m = mine && mine.markets[market];
    return m && Number.isFinite(Number(m.line)) ? Number(m.line) : null;
  }

  function todaysTest() {
    const w = state.ctxCmp, c = state.ctx;
    if (!c || !w) return '';
    const g = c.game;
    const line = currentLine('passing_yards');
    /* The window shown is the SPECIFIC one this game falls into — the same key
       the prop lab measures its similar-conditions clear rate over, so the two
       cards on this panel are talking about the same set of games. */
    const key = similarCondition();
    const lead = key ? w.windows[key] : null;
    const lab = state.lab && state.lab.history_available
      ? (state.lab.markets || []).find(m => m.market === 'passing_yards' && m.available) : null;
    const sim = lab && lab.windows.similar_conditions;

    const facts = [
      ['Current pass line', typeof line === 'number' ? line : null,
        typeof line === 'number' ? 'current market' : MARKET_UNAVAILABLE],
      ['Career baseline', w.baseline.passing_yards_avg, `N=${w.baseline.games} games`],
      lead ? [lead.label, lead.passing_yards_avg,
        `${pctSigned(lead.vs_baseline.pct)} vs baseline · N=${lead.games}`] : null,
      sim && sim.available ? ['Cleared in similar conditions', `${sim.over}/${sim.total}`,
        `${sim.over_pct}% historical clear rate · ${sim.sample_label}`] : null
    ].filter(Boolean);

    return `<section class="q2-panel q2-today">
      <div class="q2-head"><h2>Today's test</h2>
        <span>this game placed against his own history</span></div>
      <div class="q2-today-grid">
        <div class="q2-today-game">
          <div class="q2-today-match">${matchupLine(g, 30)}</div>
          <div class="q2-today-venue">${esc((g.venue && g.venue.venue) || g.espn_venue || '')}</div>
          <div class="q2-today-when">${esc(kickoffLabel(g.kickoff_utc))}</div>
          ${c.forecast ? `<div class="q2-today-env">
              <span>${esc(c.forecast.temp_f)}°F</span>
              <span>${esc(c.forecast.wind_mph)} mph</span>
              <span>${esc(c.context.precip === 'none' ? 'Dry' : c.context.precip)}</span>
              <span>${esc(c.context.roof === 'closed' ? 'Roof closed' : 'Outdoor')}</span>
            </div>`
            : `<div class="q2-today-env is-none">${esc(PD.softReason(((c.unresolved || [])
                .find(u => u.field === 'weather') || {}).reason) || 'no forecast')}</div>`}
        </div>
        <div class="q2-today-facts">
          ${facts.map(([k, v, sub]) => `<div class="q2-today-fact${v === null ? ' is-empty' : ''}">
            <div class="q2-today-fact-k">${esc(k)}</div>
            <div class="q2-today-fact-v">${v === null ? '—' : esc(n1(v))}</div>
            <div class="q2-today-fact-s">${esc(sub)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="q2-foot">Historical clear rate over completed games. Not a probability
        for this game, not a projection, not betting advice.</div>
    </section>`;
  }

  function overview() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return noHistoryPanel();
    return `${todaysTest()}${snapshot()}${form()}${dna()}`;
  }

  function noHistoryPanel() {
    const d = state.dna, p = d.player;
    return `<section class="q2-panel q2-unavail">
      <div class="q2-head"><h2>${esc(SAMPLE_UNAVAILABLE)}</h2><span>identity resolved · history not</span></div>
      <div class="q2-pad">
        <p class="q2-lead">${esc(d.reason)}</p>
        <div class="q2-bigs">
          ${bigStat('NFL games', null, null, 'nothing to count')}
          ${bigStat('Baseline', null, null, 'needs one completed game')}
          ${bigStat('Condition splits', null, null, 'needs one completed game')}
          ${bigStat('Prop history', null, null, 'needs one completed game')}
        </div>
        <p class="q2-note">${esc(d.disclosure)}${p.market_priced_2026
          ? ' The current market is pricing him, but there is no NFL history to measure that line against.'
          : ''}</p>
      </div>
    </section>`;
  }

  /* ======================================================================
     PROP LAB
     ====================================================================== */

  function marketCard(c) {
    if (!c.available) {
      return `<article class="q2-mkt is-off">
        <div class="q2-mkt-k">${esc(c.market_label)}</div>
        <div class="q2-mkt-off">${esc(MARKET_UNAVAILABLE)}</div>
        <div class="q2-mkt-why">${esc(c.reason)}</div>
      </article>`;
    }
    const open = state.openMarket === c.market;
    const w = c.windows;
    const cell = x => x.available
      ? `<div class="q2-mkt-w"><span>${esc(x.label)}</span>
           <b>${esc(x.over)}/${esc(x.total)}</b><em>${esc(x.over_pct)}%</em></div>`
      : `<div class="q2-mkt-w is-off"><span>${esc(x.label)}</span><em>—</em></div>`;
    return `<article class="q2-mkt${open ? ' is-open' : ''}">
      <button type="button" class="q2-mkt-hit" data-market="${esc(c.market)}"
        aria-expanded="${open}">
        <div class="q2-mkt-k">${esc(c.market_label)}</div>
        <div class="q2-mkt-line">${esc(c.line)}</div>
        <div class="q2-mkt-books">${esc(c.line_source.books)} book${
          c.line_source.books === 1 ? '' : 's'}${
          c.line_source.line_low !== c.line_source.line_high
            ? ` · ${esc(c.line_source.line_low)}–${esc(c.line_source.line_high)}` : ''}</div>
        <div class="q2-mkt-ws">
          ${cell(w.career)}${cell(w.current_season)}${cell(w.last_10)}${cell(w.similar_conditions)}
        </div>
        <div class="q2-mkt-more">${open ? 'Hide history' : 'Show history'}</div>
      </button>
    </article>`;
  }

  function propDetail() {
    const lab = state.lab;
    const c = (lab.markets || []).find(m => m.market === state.openMarket && m.available)
      || (lab.markets || []).find(m => m.available);
    if (!c) return '';
    const cfg = JSON.stringify({ values: c.distribution.map(d => d.value), line: c.line, height: 170 });
    const seriesCfg = JSON.stringify({
      games: c.distribution.slice(-20), line: c.line,
      mean: c.windows.career.mean, median: c.windows.career.median, height: 200
    });
    const wins = ['career', 'current_season', 'last_10', 'last_5', 'similar_conditions'];
    const rows = wins.map(k => {
      const x = c.windows[k];
      if (!x.available) {
        return `<tr class="is-off"><td class="t-txt">${esc(x.label)}</td>
          <td colspan="5" class="t-txt q2-why">${esc(x.reason)}</td></tr>`;
      }
      return `<tr>
        <td class="t-txt">${esc(x.label)}</td>
        <td class="t-num">${esc(x.over)}</td>
        <td class="t-num">${esc(x.under)}</td>
        <td class="t-num">${esc(x.push)}</td>
        <td class="t-num">${esc(x.total)}</td>
        <td class="t-num q2-hit">${esc(x.over_pct)}%</td>
        <td class="t-txt">${samp(x.sample_label)}</td>
      </tr>`;
    }).join('');

    return `<section class="q2-panel">
      <div class="q2-head"><h2>${esc(c.market_label)} · ${esc(c.line)}</h2>
        <span>every completed game against today's number</span></div>
      <div class="q2-dist">
        <div class="q2-dist-c">
          <div class="q2-sub">Distribution of ${esc(c.distribution.length)} completed games</div>
          <div class="q2-chart"><canvas data-chart="dist" data-cfg='${esc(cfg)}'
            aria-label="Distribution against the current line"></canvas></div>
        </div>
        <div class="q2-dist-c">
          <div class="q2-sub">Last ${esc(Math.min(20, c.distribution.length))} games</div>
          <div class="q2-chart"><canvas data-chart="series" data-cfg='${esc(seriesCfg)}'
            aria-label="Recent games against the current line"></canvas></div>
        </div>
      </div>
      <div class="q2-legend">
        <i class="k-over"></i>Over <i class="k-under"></i>Under
        <i class="k-push"></i>Push <i class="k-line"></i>Current line
      </div>
      <div class="q2-tablewrap"><table class="q2-table">
        <thead><tr><th>Window</th><th>Over</th><th>Under</th><th>Push</th><th>N</th>
          <th>Clear rate</th><th>Sample</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="q2-foot">${esc(state.lab.disclosure.caveat)}</div>
    </section>`;
  }

  function props() {
    const lab = state.lab;
    if (!lab) return '<div class="q2-loading">Loading current markets&hellip;</div>';
    if (lab.history_available === false) return noHistoryPanel();
    const offered = (lab.markets || []).filter(m => m.available);
    if (!offered.length) {
      return `<section class="q2-panel q2-unavail">
        <div class="q2-head"><h2>${esc(MARKET_UNAVAILABLE)}</h2><span>no QB market for this game</span></div>
        <div class="q2-pad"><p class="q2-lead">${esc((lab.markets[0] || {}).reason
          || 'the market source is not offering quarterback passing markets for this game')}</p>
          <p class="q2-note">No default line is inserted. Without a real number there is
            nothing to count against.</p></div>
      </section>`;
    }
    return `<section class="q2-panel">
      <div class="q2-head"><h2>Prop lab</h2>
        <span>${esc(offered.length)} market${offered.length === 1 ? '' : 's'} currently offered${
          lab.unavailable_count ? ` · ${esc(lab.unavailable_count)} not offered` : ''}</span></div>
      <div class="q2-mkts">${(lab.markets || []).map(marketCard).join('')}</div>
      <div class="q2-foot">Clear rate is the share of completed games that finished above
        the current number. ${esc(lab.disclosure.caveat)}</div>
    </section>
    ${propDetail()}`;
  }

  /* ======================================================================
     CONDITIONS
     ====================================================================== */

  function condRow(c, domain) {
    if (!c.available) {
      return `<div class="q2-crow is-off"><div class="q2-crow-k">${esc(c.label || '')}</div>
        <div class="q2-why">${esc(c.reason || 'unavailable')}</div></div>`;
    }
    if (!c.games) {
      return `<div class="q2-crow is-off"><div class="q2-crow-k">${esc(c.label)}</div>
        <div class="q2-why">no game in this window &mdash; not zero, simply none</div></div>`;
    }
    const p = c.baseline_delta_pct;
    const half = 95;   // px, half the track; see --q2-track in the stylesheet
    const bar = typeof p === 'number' ? Math.min(half, Math.abs(p) / domain * half) : 0;
    return `<div class="q2-crow">
      <div class="q2-crow-k">${esc(c.label)}</div>
      <div class="q2-crow-rec">${c.record ? esc(c.record) : '—'}
        <em>${c.win_pct && c.win_pct.pct !== null ? esc(c.win_pct.pct) + '% W' : 'no decided games'}</em></div>
      <div class="q2-crow-n">N=${esc(c.games)}</div>
      <div class="q2-bar" style="--bar:${bar.toFixed(1)}px">
        <span class="q2-bar-fill${p < 0 ? ' neg' : ''}"
          style="${p < 0 ? 'right:50%' : 'left:50%'};width:${bar.toFixed(1)}px"></span>
        <b class="${p < 0 ? 'at-l' : 'at-r'}${bar / half > 0.55 ? ' inside' : ''}">${esc(pctSigned(p))}</b>
      </div>
      <div class="q2-crow-v">${esc(n1(c.passing_yards_avg))}</div>
      <div class="q2-crow-x">${esc(c.completion_pct.pct)}%<em>cmp</em></div>
      <div class="q2-crow-x">${esc(n1(c.tds_avg))}<em>td</em></div>
      <div class="q2-crow-x">${esc(n1(c.ints_avg))}<em>int</em></div>
      <div class="q2-crow-s">${samp(c.sample_label)}</div>
    </div>`;
  }

  function conditions() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return noHistoryPanel();
    const groups = d.condition_groups || {};
    /* Each group is scaled to its OWN largest movement. A single -37% wind
       outlier would otherwise flatten every temperature and location bar into
       a stub, hiding the differences a reader came to see. The scale is stated
       on each group's header so the bars are never read across groups. */
    const domainFor = rows => {
      const m = Math.max(...rows.map(c => Math.abs(c.baseline_delta_pct || 0)), 0);
      for (const step of [5, 10, 15, 20, 25, 30, 40, 50]) if (m <= step) return step;
      return Math.ceil(m / 10) * 10;
    };

    const order = ['location', 'venue', 'temperature', 'precipitation', 'wind', 'context', 'market'];
    const blocks = order.map(gk => {
      const rows = Object.values(d.conditions)
        .filter(c => c.group === gk && !c.rollup);
      if (!rows.length) return '';
      const domain = domainFor(rows.filter(c => c.available && c.games));
      return `<section class="q2-panel">
        <div class="q2-head"><h2>${esc(groups[gk] || gk)}</h2>
          <span>vs own baseline ${esc(d.sample.baseline_mean)} yds / game</span></div>
        <div class="q2-chead">
          <span>Condition</span><span>W-L</span><span>Games</span>
          <span class="q2-chead-bar">&minus;${domain}% · baseline · +${domain}%</span>
          <span>Yds/g</span><span>Cmp</span><span>TD</span><span>INT</span><span>Sample</span>
        </div>
        <div class="q2-crows">${rows.map(c => condRow(c, domain)).join('')}</div>
      </section>`;
    }).join('');

    return `<div class="q2-condintro">Every figure is measured against this
      quarterback's own baseline, not against the league. Roofed games are excluded
      from weather windows by construction.</div>${blocks}`;
  }

  /* ======================================================================
     COMPARE
     ====================================================================== */

  /* Metric semantics. A bigger number is not automatically better, and volume
     is not quality — attempts and record are shown without a winner. */
  const CMP_METRICS = [
    { k: 'passing_yards_avg', label: 'Pass yds / game', better: 'high', fmt: n1 },
    { k: 'completion_pct', label: 'Completion', better: 'high', rate: true },
    { k: 'ypa', label: 'Yards / attempt', better: 'high', ratio: true },
    { k: 'tds_avg', label: 'Pass TD / game', better: 'high', fmt: n1 },
    { k: 'td_rate', label: 'TD rate', better: 'high', rate: true },
    { k: 'int_rate', label: 'INT rate', better: 'low', rate: true, note: 'lower is better' },
    { k: 'sack_rate', label: 'Sack rate', better: 'low', rate: true, note: 'lower is better' },
    { k: 'attempts_avg', label: 'Attempts / game', better: null, fmt: n1, note: 'volume, not quality' }
  ];

  function compare() {
    const c = state.cmp;
    if (!c || c.mode !== 'players') return '<div class="q2-loading">Loading comparison&hellip;</div>';
    const A = c.baseline.a, B = c.baseline.b;
    if (!A || !B) {
      return `<section class="q2-panel q2-unavail"><div class="q2-head">
        <h2>${esc(SAMPLE_UNAVAILABLE)}</h2><span>both sides need history</span></div>
        <div class="q2-pad"><p class="q2-lead">${esc(!A ? c.player_a.name : c.player_b.name)}
        has no completed NFL game in our window, so there is nothing to compare.</p></div></section>`;
    }

    const face = (pl, games, side) => `<div class="q2-vs-side ${side}">
      <button type="button" class="q2-vs-face" data-picker="${side === 'a' ? 'playerId' : 'comparePlayerId'}"
        title="Change quarterback">${headshot(pl, 108)}
        ${crest(pl.team_identity, 34, 'q2-vs-crest')}
        <span class="q2-hero-face-cta">Change</span></button>
      <div class="q2-vs-name">${esc(pl.name)}</div>
      <div class="q2-vs-team">${esc((pl.team_identity
        && (pl.team_identity.name || pl.team_identity.abbreviation)) || pl.team || '')}</div>
      <div class="q2-vs-n">N=${esc(games)} games</div>
      <button type="button" class="q2-change sm"
        data-picker="${side === 'a' ? 'playerId' : 'comparePlayerId'}">
        ${SEARCH_ICON}Change<em aria-hidden="true">&#9662;</em>
      </button>
    </div>`;

    const val = (side, m) => {
      const o = side[m.k];
      if (m.rate) return o && o.pct !== null ? o.pct : null;
      if (m.ratio) return o && o.value !== null ? o.value : null;
      return typeof o === 'number' ? o : null;
    };
    const sub = (side, m) => {
      const o = side[m.k];
      if (m.rate || m.ratio) return den(o);
      return `N=${side.games}`;
    };

    const rows = CMP_METRICS.map(m => {
      const av = val(A, m), bv = val(B, m);
      let lead = null;
      if (m.better && typeof av === 'number' && typeof bv === 'number' && av !== bv) {
        lead = m.better === 'high' ? (av > bv ? 'a' : 'b') : (av < bv ? 'a' : 'b');
      }
      const span = Math.max(Math.abs(av || 0), Math.abs(bv || 0)) || 1;
      const barW = v => (typeof v === 'number' ? Math.max(4, Math.abs(v) / span * 100) : 0);
      const suffix = m.rate ? '%' : '';
      return `<div class="q2-cmprow">
        <div class="q2-cmp-a ${lead === 'a' ? 'lead' : ''}">
          <b>${av === null ? '—' : esc(m.fmt ? m.fmt(av) : av)}${esc(suffix)}</b>
          <em>${esc(sub(A, m))}</em>
          <span class="q2-cmp-bar"><i style="width:${barW(av)}%"></i></span>
        </div>
        <div class="q2-cmp-k">${esc(m.label)}${m.note ? `<em>${esc(m.note)}</em>` : ''}</div>
        <div class="q2-cmp-b ${lead === 'b' ? 'lead' : ''}">
          <b>${bv === null ? '—' : esc(m.fmt ? m.fmt(bv) : bv)}${esc(suffix)}</b>
          <em>${esc(sub(B, m))}</em>
          <span class="q2-cmp-bar"><i style="width:${barW(bv)}%"></i></span>
        </div>
      </div>`;
    }).join('');

    /* CONDITION BATTLE — each side against HIS OWN baseline. */
    const battleRows = Object.values(c.conditions)
      .filter(x => x.available && !x.rollup)
      .sort((a, b) => Math.abs(b.a_vs_own_baseline || 0) - Math.abs(a.a_vs_own_baseline || 0))
      .slice(0, 12)
      .map(x => {
        const dom = 25;
        const bar = (v, side) => {
          const w = typeof v === 'number' ? Math.min(100, Math.abs(v) / dom * 100) : 0;
          return `<span class="q2-bt-bar ${side}"><i class="${v < 0 ? 'neg' : ''}"
            style="width:${w.toFixed(1)}%"></i></span>`;
        };
        return `<div class="q2-btrow">
          <div class="q2-bt-v a ${x.a_vs_own_baseline < 0 ? 'neg' : ''}">
            ${esc(pctSigned(x.a_vs_own_baseline))}<em>N=${esc(x.a.games)}</em></div>
          ${bar(x.a_vs_own_baseline, 'a')}
          <div class="q2-bt-k">${esc(x.label)}</div>
          ${bar(x.b_vs_own_baseline, 'b')}
          <div class="q2-bt-v b ${x.b_vs_own_baseline < 0 ? 'neg' : ''}">
            ${esc(pctSigned(x.b_vs_own_baseline))}<em>N=${esc(x.b.games)}</em></div>
        </div>`;
      }).join('');

    const h = c.head_to_head;
    const h2h = h.available
      ? `<section class="q2-panel">
          <div class="q2-head"><h2>Actual meetings</h2>
            <span>${esc(h.games)} games · ${esc(h.sample_label)}</span></div>
          <div class="q2-h2h">
            <div class="q2-h2h-side">
              <div class="q2-h2h-rec">${esc(h.a.wins)}&ndash;${esc(h.a.losses)}</div>
              <div class="q2-h2h-ypg">${esc(n1(h.a.passing_yards_avg))}<small>yds / game</small></div>
              <div class="q2-h2h-who">${esc(c.player_a.name)}</div>
            </div>
            <div class="q2-h2h-mid">${esc(h.games)}<span>meetings</span></div>
            <div class="q2-h2h-side b">
              <div class="q2-h2h-rec">${esc(h.b.wins)}&ndash;${esc(h.b.losses)}</div>
              <div class="q2-h2h-ypg">${esc(n1(h.b.passing_yards_avg))}<small>yds / game</small></div>
              <div class="q2-h2h-who">${esc(c.player_b.name)}</div>
            </div>
          </div>
          <div class="q2-tablewrap"><table class="q2-table">
            <thead><tr><th>Date</th><th>Wk</th><th>${esc(c.player_a.name)}</th><th></th>
              <th>${esc(c.player_b.name)}</th><th></th></tr></thead>
            <tbody>${h.meetings.map(m => `<tr>
              <td class="t-txt">${esc(m.date)}</td>
              <td class="t-txt">${esc(m.season)} W${esc(m.week)}</td>
              <td>${esc(m.a.passing_yards)} yds · ${esc(m.a.td)} TD · ${esc(m.a.int)} INT</td>
              <td class="t-txt"><span class="q2-${String(m.a.result).toLowerCase()}">${esc(m.a.result)}</span></td>
              <td>${m.b ? `${esc(m.b.passing_yards)} yds · ${esc(m.b.td)} TD · ${esc(m.b.int)} INT` : '—'}</td>
              <td class="t-txt">${m.b ? `<span class="q2-${String(m.b.result).toLowerCase()}">${esc(m.b.result)}</span>` : '—'}</td>
            </tr>`).join('')}</tbody></table></div>
        </section>`
      : `<section class="q2-panel"><div class="q2-head"><h2>Actual meetings</h2><span>none</span></div>
          <div class="q2-pad"><p class="q2-why">${esc(h.reason)}</p></div></section>`;

    return `<section class="q2-panel q2-vspanel">
      <div class="q2-vs">
        ${face(c.player_a, A.games, 'a')}
        <div class="q2-vs-mid">VS</div>
        ${face(c.player_b, B.games, 'b')}
      </div>
    </section>
    <section class="q2-panel">
      <div class="q2-head"><h2>Career baseline</h2>
        <span>each quarterback over his own full window</span></div>
      <div class="q2-cmprows">${rows}</div>
      <div class="q2-foot">Gold marks the better figure where "better" is defined —
        a lower interception rate is better, and attempts are volume rather than quality,
        so neither is scored. Sample sizes differ: N=${esc(A.games)} and N=${esc(B.games)}.</div>
    </section>
    <section class="q2-panel">
      <div class="q2-head"><h2>Condition battle</h2>
        <span>each side versus HIS OWN baseline</span></div>
      <div class="q2-btrows">${battleRows}</div>
      <div class="q2-foot">Not a comparison of raw output. Each percentage is how far that
        quarterback moves from his own average in that condition, which is why two very
        different passers can be read side by side.</div>
    </section>
    ${h2h}`;
  }

  /* ======================================================================
     PLAYER PICKER
     ====================================================================== */


  /* ======================================================================
     SOURCES & METHODOLOGY — everything technical lives here
     ====================================================================== */

  function sources() {
    const d = state.dna;
    const p = d && d.provenance;
    if (!p) return '';
    const gate = d.advanced_availability;
    const seasons = d.window ? d.window.seasons : [];
    const latest = seasons[seasons.length - 1];
    const gateRows = gate ? Object.entries(gate.by_field).map(([f, v]) => {
      const g = v.seasons[latest] || Object.values(v.seasons)[0];
      return `<div class="q2-gate-row"><span>${esc(f)}</span>
        <b data-st="${esc(g.status)}">${esc(g.status.replace(/_/g, ' '))}${
          g.coverage_pct === null ? '' : ` · ${esc(g.coverage_pct)}%`}</b>
        <em>${esc(g.reason)}</em></div>`;
    }).join('') : '';

    const pl = d.player || {};
    return `<details class="q2-sources">
      <summary>Sources &amp; methodology</summary>
      <div class="q2-sources-body">
        <div class="q2-scols">
          <div>
            <h4>Where the data comes from</h4>
            <ul>
              <li><b>Historical play and game data</b><span>nflverse · CC BY 4.0</span></li>
              <li><b>Historical and current weather</b><span>Open-Meteo · CC BY 4.0</span></li>
              <li><b>Schedule, venue and identity media</b><span>ESPN public endpoints</span></li>
              <li><b>Current markets</b><span>the existing PropBetEdge market source</span></li>
            </ul>
            <p class="q2-attr">${p.sources.map(s => esc(s.attribution || s.name)).join('<br>')}</p>
          </div>
          <div>
            <h4>How the numbers are made</h4>
            <ul class="q2-rules">
              ${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}
              <li>Rates are stored and served as a numerator over a denominator, so a
                  zero denominator can never be read as zero per cent.</li>
              <li>A market nobody is offering is reported as unavailable. No default
                  line is ever inserted.</li>
            </ul>
          </div>
        </div>
        ${gate ? `<h4>Data availability</h4>
          <p class="q2-note">${esc(gate.policy.rule)}</p>
          <div class="q2-gate">${gateRows}</div>` : ''}
        <h4>Data provenance</h4>
        <div class="q2-prov">
          <span>GSIS <b>${esc(pl.gsis_id || '—')}</b></span>
          <span>ESPN <b>${esc(pl.espn_id || '—')}</b></span>
          <span>PFR <b>${esc(pl.pfr_id || '—')}</b></span>
          <span>resolved by <b>${esc(pl.matched_by || '—')}</b></span>
          <span>snapshot <b>${esc(p.dataset_generated_at)}</b></span>
        </div>
      </div>
    </details>`;
  }

  /* ======================================================================
     SHELL
     ====================================================================== */

  const TABS = [['overview', 'Overview'], ['props', 'Prop lab'],
                ['conditions', 'Conditions'], ['compare', 'Compare']];

  function gameSelect() {
    if (!state.slate || !state.slate.games.length) return '';
    return `<label class="q2-gamesel"><span>Game</span>
      <select data-k="eventId">${state.slate.games.map(g =>
        `<option value="${esc(g.espn_event_id)}"${g.espn_event_id === state.eventId ? ' selected' : ''}>${
          esc(g.label)}</option>`).join('')}</select></label>`;
  }

  function body() {
    if (state.error) return `<div class="q2-error">${esc(state.error)}</div>`;
    if (!state.dna) return '<div class="q2-loading">Loading quarterback intelligence&hellip;</div>';
    if (state.tab === 'props') return props();
    if (state.tab === 'conditions') return conditions();
    if (state.tab === 'compare') return compare();
    return overview();
  }

  function render() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = `<div class="q2">
      ${hero()}
      ${statusRail()}
      <nav class="q2-tabs" role="tablist">
        ${TABS.map(([k, v]) => `<button type="button" role="tab" class="q2-tab${
          state.tab === k ? ' is-on' : ''}" data-tab="${k}"
          aria-selected="${state.tab === k}">${v}</button>`).join('')}
        ${gameSelect()}
      </nav>
      <div class="q2-body">${body()}${sources()}</div>
    </div>`;
    wire();
    PD.wireFamily();
    paintCharts();
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paintCharts, 160);
  }

  function wire() {
    document.querySelectorAll('.q2-tab').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab; load();
    }));
    document.querySelectorAll('[data-k="eventId"]').forEach(el =>
      el.addEventListener('change', () => {
        state.eventId = el.value; state.ctx = null; state.ctxCmp = null; state.lab = null; load();
      }));
    document.querySelectorAll('[data-market]').forEach(b =>
      b.addEventListener('click', () => { state.openMarket = b.dataset.market; render(); }));
    document.querySelectorAll('[data-jump]').forEach(b =>
      b.addEventListener('click', () => {
        state.openMarket = b.dataset.jump; state.tab = 'props'; load();
      }));
    /* The picker is PORTALLED to a body-level modal root. A descendant of this
       product's stacking context cannot rise above the sports shell, however
       high its z-index, so it has to leave the subtree entirely. */
    document.querySelectorAll('[data-picker]').forEach(b =>
      b.addEventListener('click', () => {
        const target = b.dataset.picker;
        PD.openPicker({
          players: (state.players && state.players.players) || [],
          positionNoun: 'quarterback',
          returnFocusTo: b,
          currentId: target === 'comparePlayerId' ? state.comparePlayerId : state.playerId,
          onPick: id => {
            if (target === 'comparePlayerId') { state.comparePlayerId = id; state.cmp = null; }
            else {
              state.playerId = id;
              state.dna = null; state.lab = null; state.cmp = null;
              state.ctxCmp = null; state.ctx = null; state.eventId = null;
            }
            load();
          }
        });
      }));


  }



  /* ---- data -------------------------------------------------------------- */

  let seq = 0;
  async function load() {
    const mine = ++seq;
    state.error = null;
    render();
    const stale = () => mine !== seq;
    try {
      if (!state.players) state.players = await get('/api/qb-dna?list=1');
      if (stale()) return;
      if (!state.dna) state.dna = await get(`/api/qb-dna?player_id=${encodeURIComponent(state.playerId)}`);
      if (stale()) return;
      if (!state.ctx) await loadContext();
      if (stale()) return;

      if (state.tab === 'props' && !state.lab) {
        state.lab = state.ctx && state.ctx.market_event_id
          ? await get('/api/qb-dna/prop-lab?'
              + `player_id=${encodeURIComponent(state.playerId)}`
              + `&event_id=${encodeURIComponent(state.ctx.market_event_id)}`
              + (similarCondition() ? `&condition=${encodeURIComponent(similarCondition())}` : ''))
          : { history_available: state.dna.history_available !== false, markets: [{
              available: false, market_label: 'Quarterback markets',
              reason: 'no current market event is matched to the selected game' }],
              disclosure: { caveat: '' } };
      } else if (state.tab === 'compare' && !state.cmp) {
        state.cmp = await get('/api/qb-dna/compare?'
          + `player_a=${encodeURIComponent(state.playerId)}`
          + `&player_b=${encodeURIComponent(state.comparePlayerId)}`);
      } else if (state.tab === 'overview' && !state.lab && state.ctx && state.ctx.market_event_id) {
        // the overview's Today's Test wants the similar-conditions clear rate
        state.lab = await get('/api/qb-dna/prop-lab?'
          + `player_id=${encodeURIComponent(state.playerId)}`
          + `&event_id=${encodeURIComponent(state.ctx.market_event_id)}`
          + (similarCondition() ? `&condition=${encodeURIComponent(similarCondition())}` : ''));
      }
      if (stale()) return;
    } catch (e) {
      if (stale()) return;
      state.error = `Could not load QB DNA: ${e.message}`;
    }
    render();
  }

  /* "Similar conditions" has to mean something. `outdoor` covers most of a
     quarterback's career and `home` covers half of it — a clear rate over
     either is just his career rate wearing a different label. So the window is
     chosen from the SPECIFIC bands this game actually falls into, in order of
     how much they narrow the field, and only if enough games back it. */
  const SPECIFIC = ['snow', 'rain', 'wind_20_plus', 'wind_15_plus', 'arctic_sub20',
                    'freezing_20_32', 'warm_70_plus', 'cold_33_50', 'wind_10_plus',
                    'mild_51_70', 'dry', 'primetime', 'divisional', 'dome'];
  function similarCondition() {
    const w = state.ctxCmp;
    if (!w) return null;
    const usable = SPECIFIC.filter(k => {
      const x = w.windows[k];
      return x && x.available && x.games >= 5;
    });
    return usable[0] || null;
  }

  async function loadContext() {
    try {
      if (!state.slate) state.slate = await get('/api/qb-dna/game-context');
      if (!state.slate.games.length) return;
      if (!state.eventId) {
        const team = (state.dna.player.team && state.dna.player.team.abbreviation)
          || state.dna.player.current_team || null;
        const mineG = state.slate.games.find(g => g.home_team === team || g.away_team === team);
        state.eventId = (mineG || state.slate.games[0]).espn_event_id;
      }
      state.ctx = await get(`/api/qb-dna/game-context?event_id=${encodeURIComponent(state.eventId)}`);
      state.ctxCmp = null;
      if (state.dna.history_available === false) return;
      const g = state.ctx.game, c = state.ctx.context;
      if (!c || !c.roof) return;
      const team = (state.dna.player.team && state.dna.player.team.abbreviation)
        || state.dna.player.current_team;
      const isHome = g.home_team === team;
      const q = [`player_id=${encodeURIComponent(state.playerId)}`, `roof=${c.roof}`,
                 `home=${isHome}`, `opponent=${isHome ? g.away_team : g.home_team}`,
                 `primetime=${c.primetime}`];
      if (c.temp_f !== undefined) q.push(`temp_f=${c.temp_f}`);
      if (c.wind_mph !== undefined) q.push(`wind_mph=${c.wind_mph}`);
      if (c.precip !== undefined) q.push(`precip=${c.precip}`);
      state.ctxCmp = await get('/api/qb-dna/compare?' + q.join('&'));
    } catch (e) {
      state.ctx = null; state.ctxCmp = null;
      console.warn('[qbdna] game context unavailable:', e.message);
    }
  }

  /* A hand-off from PBE BREAKING may name a player and a game; it is applied
     before the first paint so the reader lands on the right athlete. */
  function view() {
    if (PD.applyFocus) PD.applyFocus(state, 'qbdna');
    if (!state.dna) load(); else render();
  }

  function install() {
    if (!window.App || !window.App.VIEWS) return false;
    App.VIEWS.qbdna = view;
    App.VIEWS['qb-dna'] = view;
    return true;
  }

  window.addEventListener('resize', onResize);
  window.PBEQBDna = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
  window.addEventListener('pbe:upgrades-ready', install);
})();
