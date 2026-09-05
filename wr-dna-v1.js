/* ============================================================================
   PropBetEdge NFL — WR DNA v1   ·   route /#wrdna
   ----------------------------------------------------------------------------
   The receiver sibling of QB DNA. It shares the Player DNA design system
   (player-dna-v1.css, the .q2- namespace), the identity media layer, the
   market reader and the sample-label grammar — so the two products read as
   one family — and it owns receiver metrics, receiver signals and the one
   dimension a quarterback product does not have: WHO IS THROWING HIM THE BALL.

   It DRAWS. Every figure, split, signal and series is computed in the engine.

   Truth rules carried over unchanged:
     · real photographs only — no PBE mark, no initials disc
     · a percentage never appears without its numerator, denominator or N
     · an unavailable value states its reason where the number would have been
     · "historical clear rate", never "chance"
     · these are counted facts and current market context, NOT PropBetEdge
       model picks and NOT a projection
   ========================================================================== */
(() => {
  'use strict';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MARKET_UNAVAILABLE = 'CURRENT MARKET UNAVAILABLE';
  const SAMPLE_UNAVAILABLE = 'NFL SAMPLE UNAVAILABLE';
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tab: 'overview',
    playerId: '00-0036322',          // Justin Jefferson
    comparePlayerId: '00-0036900',   // Ja'Marr Chase
    eventId: null,
    openMarket: 'receiving_yards',
    formMetric: 'value',             // value | targets | receptions
    pickerOpen: false, pickerFor: 'playerId', pickerQuery: '',
    players: null, dna: null, lab: null, cmp: null, ctxCmp: null, ctx: null, slate: null,
    error: null
  };

  const LABELS = {
    receiving_yards: 'Rec yds', receptions: 'Receptions', anytime_td: 'Anytime TD'
  };

  async function get(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok === false) {
      throw new Error((j && (j.detail || j.error)) || `HTTP ${r.status}`);
    }
    return j;
  }

  /* ---- formatting, shared grammar with QB DNA ---------------------------- */
  const n1 = v => (typeof v === 'number' ? v.toFixed(1) : v);
  const pctSigned = v => (typeof v === 'number' ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—');
  const samp = l => (l ? `<span class="q2-samp" data-s="${esc(l)}">${esc(l)}</span>` : '');
  const den = r => (r && r.denominator ? `${r.numerator}/${r.denominator}` : 'no denominator');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const longDate = iso => {
    const d = new Date(iso + (iso.length === 10 ? 'T12:00:00Z' : ''));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  /** American odds carry a sign; without it the number is not a price. */
  const priceLabel = v => (typeof v === 'number' ? (v > 0 ? '+' + v : String(v)) : '—');

  function kickoffLabel(iso) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
      minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
    const g = t => (parts.find(x => x.type === t) || {}).value || '';
    return `${g('weekday')} · ${g('hour')}:${g('minute')} ${g('dayPeriod')} ET`;
  }

  /* ---- identity media ---------------------------------------------------- */
  const IMG_FAIL = "this.classList.add('is-broken');this.removeAttribute('src')";
  const SEARCH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10.6 10.6 L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

  function headshot(player, size) {
    const url = player && player.media && player.media.headshot_url;
    const name = (player && player.name) || 'Receiver';
    if (!url) {
      return `<span class="q2-face q2-face-none" style="--face:${size}px" role="img"
        aria-label="No photograph available for ${esc(name)}"
        title="${esc((player && player.media && player.media.unavailable_reason)
          || 'no photograph available')}"><i>No photo</i></span>`;
    }
    return `<img class="q2-face" style="--face:${size}px" src="${esc(url)}" alt="${esc(name)}"
      width="${size}" height="${size}" loading="lazy" decoding="async" onerror="${IMG_FAIL}">`;
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

  /* ---- charts: same canvas architecture as QB DNA ------------------------ */
  const CHART = {
    ink: '#14110d', line: 'rgba(255,245,220,.09)', lineStrong: 'rgba(255,245,220,.22)',
    text: '#a5a096', gold: '#e9c75a', pos: '#5cbb85', neg: '#e04a5f', dim: '#6b665e',
    posFill: 'rgba(92,187,133,.78)', negFill: 'rgba(224,74,95,.72)'
  };
  function fitCanvas(cv, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || cv.parentElement.clientWidth || 600;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function drawSeries(cv, o) {
    const games = (o.games || []).filter(g => typeof g.value === 'number');
    if (!games.length) return;
    const { ctx, w, h } = fitCanvas(cv, o.height || 200);
    const padL = 34, padR = 10, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const refs = [o.line, o.mean, o.median].filter(v => typeof v === 'number');
    const max = Math.max(...games.map(g => g.value), ...refs, 1) * 1.08;
    const y = v => padT + ih - (v / max) * ih;
    const step = iw / games.length;
    const bw = Math.max(3, Math.min(26, step - 3));
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = CHART.line; ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = max * (i / 4), yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(String(Math.round(v)), padL - 6, yy);
    }
    games.forEach((g, i) => {
      const x = padL + i * step + (step - bw) / 2, top = y(g.value);
      const over = typeof o.line === 'number' ? g.value > o.line
        : (typeof o.mean === 'number' ? g.value > o.mean : true);
      const push = typeof o.line === 'number' && g.value === o.line;
      ctx.fillStyle = push ? CHART.dim : over ? CHART.posFill : CHART.negFill;
      ctx.fillRect(x, top, bw, padT + ih - top);
      ctx.strokeStyle = push ? CHART.dim : over ? CHART.pos : CHART.neg; ctx.lineWidth = 1.25;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(top) + 0.5,
        Math.round(bw), Math.round(padT + ih - top));
    });
    const ref = (v, colour, dash, label) => {
      if (typeof v !== 'number') return;
      const yy = Math.round(y(v)) + 0.5;
      ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke(); ctx.restore();
      if (!label) return;
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
      const t = `${label} ${v}`, tw = ctx.measureText(t).width + 8;
      ctx.fillStyle = CHART.ink; ctx.fillRect(w - padR - tw, yy - 7, tw, 14);
      ctx.strokeStyle = colour; ctx.lineWidth = 1;
      ctx.strokeRect(w - padR - tw + 0.5, yy - 6.5, tw - 1, 13);
      ctx.fillStyle = colour; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(t, w - padR - 4, yy);
    };
    ref(o.median, CHART.dim, [2, 3], null);
    ref(o.mean, CHART.text, [4, 4], 'AVG');
    ref(o.line, CHART.gold, [], 'LINE');
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.ceil(games.length / (w < 520 ? 4 : 8));
    games.forEach((g, i) => {
      if (i % every && i !== games.length - 1) return;
      ctx.fillText(g.opponent ? (g.home ? 'vs ' : '@ ') + g.opponent : '',
        padL + i * step + step / 2, padT + ih + 7);
    });
  }
  function drawDistribution(cv, o) {
    const vals = (o.values || []).filter(v => typeof v === 'number');
    if (!vals.length) return;
    const { ctx, w, h } = fitCanvas(cv, o.height || 160);
    const padL = 10, padR = 10, padT = 16, padB = 30;
    const iw = w - padL - padR, ih = h - padT - padB;
    const hi = Math.max(...vals, o.line || 0, 1) * 1.06;
    const x = v => padL + (v / hi) * iw;
    const B = Math.max(8, Math.min(24, Math.round(iw / 26)));
    const bwv = hi / B;
    const bins = new Array(B).fill(0).map(() => ({ over: 0, under: 0, push: 0 }));
    for (const v of vals) {
      const b = Math.min(B - 1, Math.floor(v / bwv));
      const k = typeof o.line !== 'number' ? 'over'
        : v > o.line ? 'over' : v < o.line ? 'under' : 'push';
      bins[b][k]++;
    }
    const peak = Math.max(...bins.map(b => b.over + b.under + b.push)) || 1;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = CHART.lineStrong; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT + ih + .5); ctx.lineTo(w - padR, padT + ih + .5); ctx.stroke();
    const cw = iw / B;
    bins.forEach((b, i) => {
      const total = b.over + b.under + b.push;
      if (!total) return;
      const bx = padL + i * cw + 1, bwid = Math.max(2, cw - 2);
      let yy = padT + ih;
      const seg = (c, fill, stroke) => {
        if (!c) return;
        const hgt = (c / peak) * ih; yy -= hgt;
        ctx.fillStyle = fill; ctx.fillRect(bx, yy, bwid, hgt);
        ctx.strokeStyle = stroke; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(bx) + .5, Math.round(yy) + .5, Math.round(bwid), Math.round(hgt));
      };
      seg(b.under, CHART.negFill, CHART.neg);
      seg(b.push, 'rgba(107,102,94,.9)', CHART.dim);
      seg(b.over, CHART.posFill, CHART.pos);
    });
    if (typeof o.line === 'number') {
      const lx = Math.round(x(o.line)) + .5;
      ctx.strokeStyle = CHART.gold; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, padT - 6); ctx.lineTo(lx, padT + ih); ctx.stroke();
      ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
      const t = String(o.line), tw = ctx.measureText(t).width + 10;
      const bx = Math.max(padL, Math.min(w - padR - tw, lx - tw / 2));
      ctx.fillStyle = CHART.gold; ctx.fillRect(bx, 0, tw, 14);
      ctx.fillStyle = CHART.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, bx + tw / 2, 7);
    }
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = CHART.text; ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const v = hi * (i / 4);
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(String(Math.round(v)), x(v), padT + ih + 8);
    }
  }
  function paintCharts() {
    document.querySelectorAll('#view-container canvas[data-chart]').forEach(cv => {
      let cfg; try { cfg = JSON.parse(cv.dataset.cfg || '{}'); } catch { return; }
      if (cv.dataset.chart === 'series') drawSeries(cv, cfg);
      else if (cv.dataset.chart === 'dist') drawDistribution(cv, cfg);
      if (!REDUCED) cv.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    });
  }

  /* ---- HERO -------------------------------------------------------------- */

  function currentLine(market) {
    const c = state.ctx;
    if (!c || !c.markets || !c.markets.available) return null;
    const mine = c.markets.players.find(p => p.gsis_id === state.playerId);
    const m = mine && mine.markets[market];
    return m && Number.isFinite(Number(m.line)) ? Number(m.line) : null;
  }

  function heroLines() {
    const c = state.ctx;
    if (!c || !c.markets || !c.markets.available) {
      return `<div class="q2-hero-lines is-none">${esc(MARKET_UNAVAILABLE)}</div>`;
    }
    const mine = c.markets.players.find(p => p.gsis_id === state.playerId);
    if (!mine) {
      return `<div class="q2-hero-lines is-none">${esc(MARKET_UNAVAILABLE)} — this receiver
        is not priced for this game</div>`;
    }
    const cards = ['receiving_yards', 'receptions', 'anytime_td']
      .filter(k => mine.markets[k]).map(k => {
        const m = mine.markets[k];
        const td = k === 'anytime_td';
        // an American price is meaningless without its sign
        const shown = td && typeof m.line === 'number'
          ? (m.line > 0 ? '+' + m.line : String(m.line)) : m.line;
        return `<button type="button" class="q2-hero-line" data-jump="${esc(k)}">
          <span>${esc(LABELS[k])}</span><b>${esc(shown ?? '—')}</b>
          <em>${td ? `best price · ${esc(m.book_count)} book${m.book_count === 1 ? '' : 's'}`
            : `${esc(m.book_count)} book${m.book_count === 1 ? '' : 's'}`}</em>
        </button>`;
      }).join('');
    return cards ? `<div class="q2-hero-lines">${cards}</div>` : '';
  }

  function heroNext() {
    const c = state.ctx;
    if (!c) return '';
    const g = c.game, ctx = c.context, f = c.forecast;
    const env = [];
    if (f) env.push(`${f.temp_f}°F`, `${f.wind_mph} mph`,
      ctx.precip === 'none' ? 'no precipitation' : ctx.precip);
    if (ctx && ctx.roof) env.push(ctx.roof === 'closed' ? 'Roof closed' : 'Outdoor');
    const venue = g.venue ? g.venue.venue : g.espn_venue;
    return `<div class="q2-hero-next">
      <div class="q2-hero-next-k">Next</div>
      <div class="q2-hero-next-m">${matchupLine(g, 26)}</div>
      <div class="q2-hero-next-w">${esc(kickoffLabel(g.kickoff_utc))}</div>
      ${venue ? `<div class="q2-hero-next-v">${esc(venue)}</div>` : ''}
      ${env.length ? `<div class="q2-hero-next-e">${env.map(e => `<span>${esc(e)}</span>`).join('')}</div>`
        : `<div class="q2-hero-next-e is-none">${esc(((c.unresolved || [])[0] || {}).reason
            || 'conditions not resolved')}</div>`}
    </div>`;
  }

  function hero() {
    const d = state.dna;
    if (!d) return '<header class="q2-hero"></header>';
    const p = d.player, t = p.team;
    const noHist = d.history_available === false;
    return `<header class="q2-hero">
      <div class="q2-hero-top">
        <div class="q2-hero-eyebrow">WR DNA</div>
        ${t ? `<div class="q2-hero-club">${crest(t, 30)}<span>${esc(t.name || t.abbreviation)}</span></div>` : ''}
      </div>
      <div class="q2-hero-body">
        <button type="button" class="q2-hero-face" data-picker="playerId" title="Change receiver">
          ${headshot(p, 148)}<span class="q2-hero-face-cta">Change</span></button>
        <div class="q2-hero-copy">
          <h1 class="q2-hero-name">${esc(p.name)}</h1>
          <div class="q2-hero-meta">${esc(p.position || 'WR')}
            <i></i>${esc((t && (t.name || t.abbreviation)) || p.current_team || '')}</div>
          <button type="button" class="q2-change" data-picker="playerId">
            ${SEARCH_ICON}Change WR<em aria-hidden="true">&#9662;</em></button>
          ${noHist ? `<div class="q2-hero-flag">${esc(SAMPLE_UNAVAILABLE)}</div>` : ''}
          ${heroNext()}
        </div>
      </div>
      ${heroLines()}
    </header>`;
  }

  function statusRail() {
    const w = (state.dna && state.dna.data_window) || (state.players && state.players.data_window);
    if (!w) return '';
    const games = state.players && state.players.provenance
      ? state.players.provenance.receiver_games_in_dataset : null;
    return `<div class="q2-rail">
      <span>History through <b>${esc(longDate(w.data_through))}</b></span>
      <span>${esc(w.seasons[0])}&ndash;${esc(w.latest_season)}</span>
      ${games ? `<span>${esc(games.toLocaleString())} receiver games</span>` : ''}
      <span>WR only</span>
    </div>`;
  }

  /* ---- OVERVIEW ---------------------------------------------------------- */

  function bigStat(k, v, unit, sub) {
    const empty = v === null || v === undefined;
    return `<div class="q2-big${empty ? ' is-empty' : ''}">
      <div class="q2-big-k">${esc(k)}</div>
      <div class="q2-big-v">${empty ? 'Not available'
        : esc(v) + (unit ? `<small>${esc(unit)}</small>` : '')}</div>
      <div class="q2-big-n">${sub || ''}</div>
    </div>`;
  }

  function snapshot() {
    const b = state.dna.baseline;
    const ry = b.receiving_yards || {};
    return `<section class="q2-panel">
      <div class="q2-head"><h2>WR snapshot</h2>
        <span>career in window · ${esc(b.games)} games</span></div>
      <div class="q2-bigs">
        ${bigStat('Rec yds / game', ry.mean, null, `median ${esc(ry.median)} · N=${esc(b.games)}`)}
        ${bigStat('Targets / game', b.targets_per_game.mean, null, `${esc(b.targets)} career targets`)}
        ${bigStat('Receptions / game', b.receptions_per_game.mean, null, `${esc(b.receptions)} career`)}
        ${bigStat('Target share', b.target_share.pct, '%', `${den(b.target_share)} team targets`)}
        ${bigStat('Catch rate', b.catch_rate.pct, '%', `${den(b.catch_rate)} targets`)}
        ${bigStat('Yards / target', b.yards_per_target.value, null, `${den(b.yards_per_target)} targets`)}
        ${bigStat('Air yds / game', b.air_yards_per_game.mean, null,
          `${esc(b.air_yards_share.pct === null ? '—' : b.air_yards_share.pct + '%')} of team air yards`)}
        ${bigStat('TD games', b.td_games, `of ${b.games}`, `${esc(b.td_game_rate.pct)}% of games`)}
      </div>
    </section>`;
  }

  function form() {
    const d = state.dna, fs = d.form_series;
    const metric = state.formMetric;
    const line = metric === 'value' ? currentLine('receiving_yards')
      : metric === 'receptions' ? currentLine('receptions') : null;
    const games = fs.games.map(g => ({ ...g, value: g[metric] }));
    const mean = metric === 'value' ? fs.mean
      : +(games.reduce((a, g) => a + (g.value || 0), 0) / (games.length || 1)).toFixed(1);
    const cfg = JSON.stringify({ games, mean, median: metric === 'value' ? fs.median : null,
                                 line: typeof line === 'number' ? line : null, height: 210 });
    const chips = ['last_5', 'last_10', 'current_season', 'career'].map(k => {
      const w = d.recent[k];
      if (!w || !w.available) return '';
      const s = w.receiving_yards || {};
      return `<div class="q2-formchip">
        <div class="q2-formchip-k">${esc(w.label)}</div>
        <div class="q2-formchip-v">${esc(n1(s.mean))}<small>yds</small></div>
        <div class="q2-formchip-n">N=${esc(w.games)}${w.shortfall_note ? ' · ' + esc(w.shortfall_note) : ''}
          · ${esc(n1(w.targets_per_game.mean))} tgt/g · ${esc(w.catch_rate.pct)}% catch</div>
        ${samp(w.sample_label)}
      </div>`;
    }).join('');
    const MET = [['value', 'Yards'], ['targets', 'Targets'], ['receptions', 'Receptions']];
    return `<section class="q2-panel">
      <div class="q2-head"><h2>Usage &amp; form</h2>
        <div class="q2-seg">${MET.map(([k, l]) =>
          `<button type="button" class="q2-seg-btn${metric === k ? ' is-on' : ''}"
            data-metric="${k}">${l}</button>`).join('')}</div></div>
      <div class="q2-formchips">${chips}</div>
      <div class="q2-chart"><canvas data-chart="series" data-cfg='${esc(cfg)}'
        aria-label="Receiver usage by game"></canvas></div>
      <div class="q2-legend">
        <i class="k-over"></i>${typeof line === 'number' ? 'Over the line' : 'Above average'}
        <i class="k-under"></i>${typeof line === 'number' ? 'Under the line' : 'Below average'}
        ${typeof line === 'number' ? '<i class="k-line"></i>Current market line' : ''}
        <i class="k-avg"></i>Average
      </div>
    </section>`;
  }

  function sigCard(x, tier) {
    return `<article class="q2-sig t-${tier}">
      <div class="q2-sig-top"><div class="q2-sig-label">${esc(x.label)}</div>
        <div class="q2-sig-move">${esc(pctSigned(x.baseline_delta_pct))}</div></div>
      <div class="q2-sig-val">${esc(n1(x.receiving_yards_avg))}<small>yds / game</small></div>
      <div class="q2-sig-meta">
        <span>${esc(n1(x.targets_avg))} tgt/g</span>
        <span>${esc(x.catch_rate.pct)}% catch</span>
        <span>N=${esc(x.games)}</span>${samp(x.sample_label)}
      </div>
    </article>`;
  }

  function dna() {
    const g = state.dna.dna_signals;
    if (!g) return '';
    const any = g.strengths.length + g.watchouts.length + g.signals.length;
    return `<section class="q2-panel">
      <div class="q2-head"><h2>Receiver DNA</h2>
        <span>versus his own baseline of ${esc(g.baseline_mean)} yds / game over N=${esc(g.baseline_n)}</span></div>
      ${any ? `
        ${g.strengths.length ? `<div class="q2-sigrow"><div class="q2-sigrow-k">Strength</div>
          <div class="q2-sigs">${g.strengths.map(x => sigCard(x, 'up')).join('')}</div></div>` : ''}
        ${g.watchouts.length ? `<div class="q2-sigrow"><div class="q2-sigrow-k">Watchout</div>
          <div class="q2-sigs">${g.watchouts.map(x => sigCard(x, 'down')).join('')}</div></div>` : ''}
        ${g.signals.length ? `<div class="q2-sigrow">
          <div class="q2-sigrow-k">Signal <em>small sample</em></div>
          <div class="q2-sigs">${g.signals.map(x => sigCard(x, 'sig')).join('')}</div></div>` : ''}`
        : '<div class="q2-empty">No condition moves this receiver far enough from his own baseline to report.</div>'}
      ${g.insufficient.length ? `<div class="q2-insuf">
        <div class="q2-insuf-k">Too few games to call either way</div>
        <div class="q2-insuf-list">${g.insufficient.map(x =>
          `<span>${esc(x.label)} <b>${esc(pctSigned(x.baseline_delta_pct))}</b> N=${esc(x.games)}</span>`).join('')}</div>
        <p>${esc(g.policy.rule)}</p></div>` : ''}
    </section>`;
  }

  /** The dimension a quarterback product does not have. */
  function qbConnection() {
    const c = state.dna.qb_connection;
    if (!c || !c.connections.length) return '';
    const top = c.connections[0];
    return `<section class="q2-panel">
      <div class="q2-head"><h2>QB connection</h2>
        <span>${esc(c.total_passers)} passer${c.total_passers === 1 ? '' : 's'} with 5+ targets</span></div>
      <div class="q2-tablewrap"><table class="q2-table q2-qbc">
        <thead><tr><th>Quarterback</th><th>Games</th><th>Tgt/g</th><th>Rec/g</th>
          <th>Yds/g</th><th>Catch</th><th>Yds/tgt</th><th>TD</th><th>Sample</th></tr></thead>
        <tbody>${c.connections.map(x => `<tr>
          <td class="t-txt q2-qbc-who">${esc(x.name)}
            <em>${esc(x.teams.join(', '))} · ${esc(x.date_range[0])} to ${esc(x.date_range[1])}</em></td>
          <td class="t-num">${esc(x.games)}</td>
          <td class="t-num">${esc(x.targets_per_game)}</td>
          <td class="t-num">${esc(x.receptions_per_game)}</td>
          <td class="t-num q2-qbc-y">${esc(x.receiving_yards_per_game)}</td>
          <td class="t-num">${esc(x.catch_rate.pct)}%<em class="q2-den">${esc(den(x.catch_rate))}</em></td>
          <td class="t-num">${esc(x.yards_per_target.value)}</td>
          <td class="t-num">${esc(x.touchdowns)}</td>
          <td class="t-txt">${samp(x.sample_label)}</td>
        </tr>`).join('')}</tbody></table></div>
      <div class="q2-foot">${esc(c.method)} ${esc(c.disclaimer)}
        Most targets came from <b>${esc(top.name)}</b> (${esc(top.targets)} over N=${esc(top.games)}).</div>
    </section>`;
  }

  function todaysTest() {
    const w = state.ctxCmp, c = state.ctx;
    if (!c || !w) return '';
    const g = c.game;
    const line = currentLine('receiving_yards');
    const key = similarCondition();
    const lead = key ? w.windows[key] : null;
    const lab = state.lab && state.lab.history_available
      ? (state.lab.markets || []).find(m => m.market === 'receiving_yards' && m.available) : null;
    const sim = lab && lab.windows.similar_conditions;
    const qbNow = todaysPasser();

    const facts = [
      ['Current rec yds line', typeof line === 'number' ? line : null,
        typeof line === 'number' ? 'current market' : MARKET_UNAVAILABLE],
      ['Career baseline', w.baseline.receiving_yards_avg, `N=${w.baseline.games} games`],
      lead ? [lead.label, lead.receiving_yards_avg,
        `${pctSigned(lead.vs_baseline.pct)} vs baseline · N=${lead.games}`] : null,
      sim && sim.available ? ['Cleared in similar conditions', `${sim.over}/${sim.total}`,
        `${sim.over_pct}% historical clear rate · ${sim.sample_label}`] : null,
      qbNow ? [`With ${qbNow.name}`, qbNow.receiving_yards_per_game,
        `yds/game · ${qbNow.targets_per_game} tgt/g · N=${qbNow.games} · ${qbNow.sample_label}`] : null
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
              <span>${esc(c.forecast.temp_f)}°F</span><span>${esc(c.forecast.wind_mph)} mph</span>
              <span>${esc(c.context.precip === 'none' ? 'Dry' : c.context.precip)}</span>
              <span>${esc(c.context.roof === 'closed' ? 'Roof closed' : 'Outdoor')}</span></div>`
            : `<div class="q2-today-env is-none">${esc(((c.unresolved || [])
                .find(u => u.field === 'weather') || {}).reason || 'no forecast')}</div>`}
        </div>
        <div class="q2-today-facts">
          ${facts.map(([k, v, sub]) => `<div class="q2-today-fact${v === null ? ' is-empty' : ''}">
            <div class="q2-today-fact-k">${esc(k)}</div>
            <div class="q2-today-fact-v">${v === null ? '—' : esc(n1(v))}</div>
            <div class="q2-today-fact-s">${esc(sub)}</div></div>`).join('')}
        </div>
      </div>
      <div class="q2-foot">Historical clear rate over completed games. Not a probability for
        this game, not a projection, not betting advice, and not a PropBetEdge model pick.</div>
    </section>`;
  }

  /** The passer this receiver's team is expected to start, from the market. */
  function todaysPasser() {
    const d = state.dna;
    if (!d || !d.qb_connection || !state.ctx) return null;
    const mk = state.ctx.markets;
    if (!mk || !mk.available) return null;
    // the QB priced for THIS receiver's team in this game, matched on the
    // connection's own passer names rather than on a roster guess
    const names = new Set(mk.players.map(p => p.player_name));
    return d.qb_connection.connections.find(c => names.has(c.name)) || null;
  }

  function overview() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return noHistoryPanel();
    return `${todaysTest()}${snapshot()}${form()}${qbConnection()}${dna()}`;
  }

  function noHistoryPanel() {
    const d = state.dna, p = d.player;
    return `<section class="q2-panel q2-unavail">
      <div class="q2-head"><h2>${esc(SAMPLE_UNAVAILABLE)}</h2>
        <span>identity resolved · history not</span></div>
      <div class="q2-pad">
        <p class="q2-lead">${esc(d.reason)}</p>
        <div class="q2-bigs">
          ${bigStat('NFL games', null, null, 'nothing to count')}
          ${bigStat('Baseline', null, null, 'needs one completed game')}
          ${bigStat('Condition splits', null, null, 'needs one completed game')}
          ${bigStat('QB connection', null, null, 'needs one completed game')}
        </div>
        <p class="q2-note">${esc(d.disclosure)}${p.market_priced_2026
          ? ' The current market is pricing him, but there is no NFL history to measure that against.'
          : ''}</p>
      </div>
    </section>`;
  }

  /* ---- PROP LAB ---------------------------------------------------------- */

  function marketCard(c) {
    if (!c.available) {
      return `<article class="q2-mkt is-off">
        <div class="q2-mkt-k">${esc(c.market_label)}</div>
        <div class="q2-mkt-off">${esc(MARKET_UNAVAILABLE)}</div>
        <div class="q2-mkt-why">${esc(c.reason)}</div></article>`;
    }
    const open = state.openMarket === c.market;
    const w = c.windows;
    const isTd = c.kind === 'price';
    const cell = x => {
      if (!x.available) {
        return `<div class="q2-mkt-w is-off"><span>${esc(x.label)}</span><em>—</em></div>`;
      }
      return isTd
        ? `<div class="q2-mkt-w"><span>${esc(x.label)}</span>
             <b>${esc(x.td_games)}/${esc(x.total)}</b><em>${esc(x.td_game_rate.pct)}%</em></div>`
        : `<div class="q2-mkt-w"><span>${esc(x.label)}</span>
             <b>${esc(x.over)}/${esc(x.total)}</b><em>${esc(x.over_pct)}%</em></div>`;
    };
    return `<article class="q2-mkt${open ? ' is-open' : ''}">
      <button type="button" class="q2-mkt-hit" data-market="${esc(c.market)}" aria-expanded="${open}">
        <div class="q2-mkt-k">${esc(c.market_label)}${isTd ? ' <i>price</i>' : ''}</div>
        <div class="q2-mkt-line">${esc(isTd ? priceLabel(c.market_price) : c.line)}</div>
        <div class="q2-mkt-books">${isTd
          ? `best price · ${esc(c.line_source.books)} book${c.line_source.books === 1 ? '' : 's'}`
          : `${esc(c.line_source.books)} book${c.line_source.books === 1 ? '' : 's'}`}</div>
        <div class="q2-mkt-ws">${cell(w.career)}${cell(w.current_season)}
          ${cell(w.last_10)}${cell(w.similar_conditions)}</div>
        <div class="q2-mkt-more">${open ? 'Hide history' : 'Show history'}</div>
      </button>
    </article>`;
  }

  function propDetail() {
    const lab = state.lab;
    const c = (lab.markets || []).find(m => m.market === state.openMarket && m.available)
      || (lab.markets || []).find(m => m.available);
    if (!c) return '';
    const isTd = c.kind === 'price';
    const wins = ['career', 'current_season', 'last_10', 'last_5', 'similar_conditions'];
    const rows = wins.map(k => {
      const x = c.windows[k];
      if (!x.available) {
        return `<tr class="is-off"><td class="t-txt">${esc(x.label)}</td>
          <td colspan="6" class="t-txt q2-why">${esc(x.reason)}</td></tr>`;
      }
      return isTd
        ? `<tr><td class="t-txt">${esc(x.label)}</td><td class="t-num">${esc(x.td_games)}</td>
             <td class="t-num">${esc(x.no_td_games)}</td><td class="t-num">—</td>
             <td class="t-num">${esc(x.total)}</td>
             <td class="t-num q2-hit">${esc(x.td_game_rate.pct)}%</td>
             <td class="t-txt">${samp(x.sample_label)}</td></tr>`
        : `<tr><td class="t-txt">${esc(x.label)}</td><td class="t-num">${esc(x.over)}</td>
             <td class="t-num">${esc(x.under)}</td><td class="t-num">${esc(x.push)}</td>
             <td class="t-num">${esc(x.total)}</td>
             <td class="t-num q2-hit">${esc(x.over_pct)}%</td>
             <td class="t-txt">${samp(x.sample_label)}</td></tr>`;
    }).join('');

    const distCfg = JSON.stringify({ values: c.distribution.map(d => d.value),
      line: isTd ? null : c.line, height: 170 });
    const seriesCfg = JSON.stringify({ games: c.distribution.slice(-20),
      line: isTd ? null : c.line,
      mean: isTd ? null : c.windows.career.mean,
      median: isTd ? null : c.windows.career.median, height: 200 });

    return `<section class="q2-panel">
      <div class="q2-head"><h2>${esc(c.market_label)} · ${esc(isTd ? priceLabel(c.market_price) : c.line)}</h2>
        <span>${isTd ? 'games with a receiving touchdown' : "every completed game against today's number"}</span></div>
      ${isTd ? `<div class="q2-foot">${esc(c.note)}</div>` : ''}
      <div class="q2-dist">
        <div class="q2-dist-c"><div class="q2-sub">Distribution of ${esc(c.distribution.length)} games</div>
          <div class="q2-chart"><canvas data-chart="dist" data-cfg='${esc(distCfg)}'></canvas></div></div>
        <div class="q2-dist-c"><div class="q2-sub">Last ${esc(Math.min(20, c.distribution.length))} games</div>
          <div class="q2-chart"><canvas data-chart="series" data-cfg='${esc(seriesCfg)}'></canvas></div></div>
      </div>
      <div class="q2-tablewrap"><table class="q2-table">
        <thead><tr><th>Window</th><th>${isTd ? 'TD games' : 'Over'}</th>
          <th>${isTd ? 'No TD' : 'Under'}</th><th>Push</th><th>N</th>
          <th>${isTd ? 'TD game rate' : 'Clear rate'}</th><th>Sample</th></tr></thead>
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
        <div class="q2-head"><h2>${esc(MARKET_UNAVAILABLE)}</h2><span>no receiving market for this game</span></div>
        <div class="q2-pad"><p class="q2-lead">${esc((lab.markets[0] || {}).reason
          || 'the market source is not offering receiving markets for this receiver')}</p>
        <p class="q2-note">No default line is inserted.</p></div></section>`;
    }
    return `<section class="q2-panel">
      <div class="q2-head"><h2>Prop lab</h2>
        <span>${esc(offered.length)} market${offered.length === 1 ? '' : 's'} currently offered${
          lab.unavailable_count ? ` · ${esc(lab.unavailable_count)} not offered` : ''}</span></div>
      <div class="q2-mkts">${(lab.markets || []).map(marketCard).join('')}</div>
      <div class="q2-foot">Clear rate is the share of completed games that finished above the
        current number. ${esc(lab.disclosure.caveat)}</div>
    </section>${propDetail()}`;
  }

  /* ---- CONDITIONS -------------------------------------------------------- */

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
    const half = 95;
    const bar = typeof p === 'number' ? Math.min(half, Math.abs(p) / domain * half) : 0;
    return `<div class="q2-crow">
      <div class="q2-crow-k">${esc(c.label)}</div>
      <div class="q2-crow-rec">${esc(n1(c.targets_avg))}<em>tgt / g</em></div>
      <div class="q2-crow-n">N=${esc(c.games)}</div>
      <div class="q2-bar" style="--bar:${bar.toFixed(1)}px">
        <span class="q2-bar-fill${p < 0 ? ' neg' : ''}"
          style="${p < 0 ? 'right:50%' : 'left:50%'};width:${bar.toFixed(1)}px"></span>
        <b class="${p < 0 ? 'at-l' : 'at-r'}${bar / half > 0.55 ? ' inside' : ''}">${esc(pctSigned(p))}</b>
      </div>
      <div class="q2-crow-v">${esc(n1(c.receiving_yards_avg))}</div>
      <div class="q2-crow-x">${esc(n1(c.receptions_avg))}<em>rec</em></div>
      <div class="q2-crow-x">${esc(c.catch_rate.pct)}%<em>catch</em></div>
      <div class="q2-crow-x">${esc(c.target_share.pct)}%<em>tgt sh</em></div>
      <div class="q2-crow-s">${samp(c.sample_label)}</div>
    </div>`;
  }

  function conditions() {
    const d = state.dna;
    if (!d) return '';
    if (d.history_available === false) return noHistoryPanel();
    const groups = d.condition_groups || {};
    const domainFor = rows => {
      const m = Math.max(...rows.map(c => Math.abs(c.baseline_delta_pct || 0)), 0);
      for (const step of [5, 10, 15, 20, 25, 30, 40, 50]) if (m <= step) return step;
      return Math.ceil(m / 10) * 10;
    };
    const order = ['location', 'venue', 'temperature', 'precipitation', 'wind', 'context', 'market'];
    const blocks = order.map(gk => {
      const rows = Object.values(d.conditions).filter(c => c.group === gk && !c.rollup);
      if (!rows.length) return '';
      const domain = domainFor(rows.filter(c => c.available && c.games));
      return `<section class="q2-panel">
        <div class="q2-head"><h2>${esc(groups[gk] || gk)}</h2>
          <span>vs own baseline ${esc(d.sample.baseline_mean)} yds / game</span></div>
        <div class="q2-chead">
          <span>Condition</span><span>Targets</span><span>Games</span>
          <span class="q2-chead-bar">&minus;${domain}% · baseline · +${domain}%</span>
          <span>Yds/g</span><span>Rec</span><span>Catch</span><span>Tgt sh</span><span>Sample</span>
        </div>
        <div class="q2-crows">${rows.map(c => condRow(c, domain)).join('')}</div>
      </section>`;
    }).join('');
    return `<div class="q2-condintro">Every figure is measured against this receiver's own
      baseline, not against the league. Roofed games are excluded from weather windows by
      construction, and team win-loss is deliberately not the headline here — a receiver's
      production is not the same question as his team's result.</div>${blocks}`;
  }

  /* ---- COMPARE ----------------------------------------------------------- */

  const CMP = [
    { k: 'receiving_yards_avg', label: 'Rec yds / game', better: 'high', fmt: n1 },
    { k: 'targets_avg', label: 'Targets / game', better: 'high', fmt: n1 },
    { k: 'receptions_avg', label: 'Receptions / game', better: 'high', fmt: n1 },
    { k: 'target_share', label: 'Target share', better: 'high', rate: true },
    { k: 'catch_rate', label: 'Catch rate', better: 'high', rate: true },
    { k: 'yards_per_reception', label: 'Yards / reception', better: 'high', ratio: true },
    { k: 'yards_per_target', label: 'Yards / target', better: 'high', ratio: true },
    { k: 'air_yards_avg', label: 'Air yards / game', better: null, fmt: n1, note: 'usage, not quality' },
    { k: 'yac_avg', label: 'YAC / game', better: 'high', fmt: n1 },
    { k: 'td_game_rate', label: 'TD game rate', better: 'high', rate: true }
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
        title="Change receiver">${headshot(pl, 108)}
        ${crest(pl.team_identity, 34, 'q2-vs-crest')}
        <span class="q2-hero-face-cta">Change</span></button>
      <div class="q2-vs-name">${esc(pl.name)}</div>
      <div class="q2-vs-team">${esc((pl.team_identity
        && (pl.team_identity.name || pl.team_identity.abbreviation)) || pl.team || '')}</div>
      <div class="q2-vs-n">N=${esc(games)} games</div>
      <button type="button" class="q2-change sm"
        data-picker="${side === 'a' ? 'playerId' : 'comparePlayerId'}">
        ${SEARCH_ICON}Change<em aria-hidden="true">&#9662;</em></button>
    </div>`;

    const val = (s, m) => {
      const o = s[m.k];
      if (m.rate) return o && o.pct !== null ? o.pct : null;
      if (m.ratio) return o && o.value !== null ? o.value : null;
      return typeof o === 'number' ? o : null;
    };
    const sub = (s, m) => ((m.rate || m.ratio) ? den(s[m.k]) : `N=${s.games}`);

    const rows = CMP.map(m => {
      const av = val(A, m), bv = val(B, m);
      let lead = null;
      if (m.better && typeof av === 'number' && typeof bv === 'number' && av !== bv) {
        lead = m.better === 'high' ? (av > bv ? 'a' : 'b') : (av < bv ? 'a' : 'b');
      }
      const span = Math.max(Math.abs(av || 0), Math.abs(bv || 0)) || 1;
      const bw = v => (typeof v === 'number' ? Math.max(4, Math.abs(v) / span * 100) : 0);
      const sfx = m.rate ? '%' : '';
      return `<div class="q2-cmprow">
        <div class="q2-cmp-a ${lead === 'a' ? 'lead' : ''}">
          <b>${av === null ? '—' : esc(m.fmt ? m.fmt(av) : av)}${esc(sfx)}</b>
          <em>${esc(sub(A, m))}</em><span class="q2-cmp-bar"><i style="width:${bw(av)}%"></i></span></div>
        <div class="q2-cmp-k">${esc(m.label)}${m.note ? `<em>${esc(m.note)}</em>` : ''}</div>
        <div class="q2-cmp-b ${lead === 'b' ? 'lead' : ''}">
          <b>${bv === null ? '—' : esc(m.fmt ? m.fmt(bv) : bv)}${esc(sfx)}</b>
          <em>${esc(sub(B, m))}</em><span class="q2-cmp-bar"><i style="width:${bw(bv)}%"></i></span></div>
      </div>`;
    }).join('');

    const battle = Object.values(c.conditions)
      .filter(x => x.available && !x.rollup)
      .sort((a, b) => Math.abs(b.a_vs_own_baseline || 0) - Math.abs(a.a_vs_own_baseline || 0))
      .slice(0, 12).map(x => {
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

    return `<section class="q2-panel q2-vspanel">
      <div class="q2-vs">${face(c.player_a, A.games, 'a')}
        <div class="q2-vs-mid">VS</div>${face(c.player_b, B.games, 'b')}</div>
    </section>
    <section class="q2-panel">
      <div class="q2-head"><h2>Career baseline</h2>
        <span>each receiver over his own full window</span></div>
      <div class="q2-cmprows">${rows}</div>
      <div class="q2-foot">Gold marks the better figure where "better" is defined. Air yards
        are usage rather than quality, so they are not scored. Sample sizes differ:
        N=${esc(A.games)} and N=${esc(B.games)}.</div>
    </section>
    <section class="q2-panel">
      <div class="q2-head"><h2>Condition response</h2>
        <span>each side versus HIS OWN baseline</span></div>
      <div class="q2-btrows">${battle}</div>
      <div class="q2-foot">Not a comparison of raw output. Each percentage is how far that
        receiver moves from his own average in that condition.</div>
    </section>`;
  }

  /* ---- PICKER ------------------------------------------------------------ */

  function picker() {
    if (!state.pickerOpen) return '';
    const list = (state.players && state.players.players) || [];
    const q = state.pickerQuery.trim().toLowerCase();
    const match = p => !q || p.name.toLowerCase().includes(q)
      || String(p.team_2026 || p.team || '').toLowerCase().includes(q);
    const groups = [
      ['Priced by the current market', list.filter(p => p.market_priced_2026 && match(p))],
      ['On a 2026 roster', list.filter(p => !p.market_priced_2026 && p.active_2026 && match(p))],
      ['Historical', list.filter(p => !p.active_2026 && match(p))]
    ].filter(([, r]) => r.length);
    const total = groups.reduce((a, [, r]) => a + r.length, 0);
    return `<div class="q2-picker" role="dialog" aria-modal="true" aria-label="Choose a receiver">
      <div class="q2-picker-panel">
        <div class="q2-picker-head">
          <input type="search" id="q2-picker-q" class="q2-picker-input" placeholder="Search receivers"
            value="${esc(state.pickerQuery)}" autocomplete="off" aria-label="Search receivers">
          <button type="button" class="q2-picker-x" data-picker-close aria-label="Close">&times;</button>
        </div>
        <div class="q2-picker-body">
          ${total ? groups.map(([label, rows]) => `<div class="q2-picker-group">
            <div class="q2-picker-glabel">${esc(label)} <em>${rows.length}</em></div>
            ${rows.slice(0, 120).map(p => `<button type="button" class="q2-picker-row" data-pick="${esc(p.gsis_id)}">
              ${headshot(p, 40)}
              <span class="q2-picker-copy"><b>${esc(p.name)}</b>
                <em>${esc(p.team_2026 || p.team || '')} · WR ·
                  ${p.history_available ? esc(p.games) + ' games' : 'no NFL history'}</em></span>
              ${crest(p.team_media, 20)}
            </button>`).join('')}
          </div>`).join('') : '<div class="q2-empty">No receiver matches that search.</div>'}
        </div>
      </div>
    </div>`;
  }

  /* ---- SOURCES ----------------------------------------------------------- */

  function sources() {
    const p = state.dna && state.dna.provenance;
    if (!p) return '';
    return `<details class="q2-sources">
      <summary>Sources &amp; methodology</summary>
      <div class="q2-sources-body">
        <div class="q2-scols">
          <div><h4>Where the data comes from</h4>
            <ul>
              <li><b>Historical play and game data</b><span>nflverse · CC BY 4.0</span></li>
              <li><b>Historical and current weather</b><span>Open-Meteo · CC BY 4.0</span></li>
              <li><b>Schedule, venue and identity media</b><span>ESPN public endpoints</span></li>
              <li><b>Current markets</b><span>the existing PropBetEdge market source</span></li>
            </ul>
            <p class="q2-attr">${p.sources.map(s => esc(s.attribution || s.name)).join('<br>')}</p>
          </div>
          <div><h4>How a receiver is counted</h4>
            <ul class="q2-rules">
              ${Object.entries(p.count_rules || {}).map(([k, v]) =>
                `<li><b>${esc(k.replace(/_/g, ' '))}</b>${esc(v)}</li>`).join('')}
            </ul>
          </div>
        </div>
        <h4>Withheld</h4>
        <ul class="q2-rules">${(p.withheld_fields || []).map(f =>
          `<li><b>${esc(f.field)}</b>${esc(f.reason)}</li>`).join('')}</ul>
        <h4>Rules</h4>
        <ul class="q2-rules">${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        <h4>Data provenance</h4>
        <div class="q2-prov">
          <span>GSIS <b>${esc(state.dna.player.gsis_id || '—')}</b></span>
          <span>ESPN <b>${esc(state.dna.player.espn_id || '—')}</b></span>
          <span>PFR <b>${esc(state.dna.player.pfr_id || '—')}</b></span>
          <span>resolved by <b>${esc(state.dna.player.matched_by || '—')}</b></span>
          <span>snapshot <b>${esc(p.dataset_generated_at)}</b></span>
        </div>
      </div>
    </details>`;
  }

  /* ---- SHELL ------------------------------------------------------------- */

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
    if (!state.dna) return '<div class="q2-loading">Loading receiver intelligence&hellip;</div>';
    if (state.tab === 'props') return props();
    if (state.tab === 'conditions') return conditions();
    if (state.tab === 'compare') return compare();
    return overview();
  }

  function render() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = `<div class="q2 q2-wr">
      ${hero()}${statusRail()}
      <nav class="q2-tabs" role="tablist">
        ${TABS.map(([k, v]) => `<button type="button" role="tab" class="q2-tab${
          state.tab === k ? ' is-on' : ''}" data-tab="${k}" aria-selected="${state.tab === k}">${v}</button>`).join('')}
        ${gameSelect()}
      </nav>
      <div class="q2-body">${body()}${sources()}</div>
      ${picker()}
    </div>`;
    wire();
    paintCharts();
  }

  let resizeTimer = null;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paintCharts, 160); };

  function wire() {
    document.querySelectorAll('.q2-tab').forEach(b =>
      b.addEventListener('click', () => { state.tab = b.dataset.tab; load(); }));
    document.querySelectorAll('[data-k="eventId"]').forEach(el =>
      el.addEventListener('change', () => {
        state.eventId = el.value; state.ctx = null; state.ctxCmp = null; state.lab = null; load();
      }));
    document.querySelectorAll('[data-metric]').forEach(b =>
      b.addEventListener('click', () => { state.formMetric = b.dataset.metric; render(); }));
    document.querySelectorAll('[data-market]').forEach(b =>
      b.addEventListener('click', () => { state.openMarket = b.dataset.market; render(); }));
    document.querySelectorAll('[data-jump]').forEach(b =>
      b.addEventListener('click', () => { state.openMarket = b.dataset.jump; state.tab = 'props'; load(); }));
    document.querySelectorAll('[data-picker]').forEach(b =>
      b.addEventListener('click', () => {
        state.pickerFor = b.dataset.picker; state.pickerOpen = true; state.pickerQuery = '';
        render();
        const i = document.getElementById('q2-picker-q'); if (i) i.focus();
      }));
    document.querySelectorAll('[data-picker-close]').forEach(b => b.addEventListener('click', closePicker));
    const q = document.getElementById('q2-picker-q');
    if (q) {
      q.addEventListener('input', () => {
        state.pickerQuery = q.value;
        const body = document.querySelector('.q2-picker-body');
        if (!body) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = picker();
        body.innerHTML = tmp.querySelector('.q2-picker-body').innerHTML;
        wirePickerRows();
      });
    }
    wirePickerRows();
    const overlay = document.querySelector('.q2-picker');
    if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closePicker(); });
    document.addEventListener('keydown', escClose);
  }
  function wirePickerRows() {
    document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.pick;
      if (state.pickerFor === 'comparePlayerId') { state.comparePlayerId = id; state.cmp = null; }
      else {
        state.playerId = id;
        state.dna = null; state.lab = null; state.cmp = null;
        state.ctxCmp = null; state.ctx = null; state.eventId = null;
      }
      state.pickerOpen = false;
      load();
    }));
  }
  function escClose(e) { if (e.key === 'Escape' && state.pickerOpen) closePicker(); }
  function closePicker() {
    state.pickerOpen = false;
    document.removeEventListener('keydown', escClose);
    render();
  }

  /* ---- data -------------------------------------------------------------- */

  const SPECIFIC = ['snow', 'rain', 'wind_20_plus', 'wind_15_plus', 'arctic_sub20',
                    'freezing_20_32', 'warm_70_plus', 'cold_33_50', 'wind_10_plus',
                    'mild_51_70', 'dry', 'primetime', 'divisional', 'dome'];
  function similarCondition() {
    const w = state.ctxCmp;
    if (!w) return null;
    return SPECIFIC.find(k => {
      const x = w.windows[k];
      return x && x.available && x.games >= 5;
    }) || null;
  }

  let seq = 0;
  async function load() {
    const mine = ++seq;
    state.error = null;
    render();
    const stale = () => mine !== seq;
    try {
      if (!state.players) state.players = await get('/api/wr-dna?list=1');
      if (stale()) return;
      if (!state.dna) state.dna = await get(`/api/wr-dna?player_id=${encodeURIComponent(state.playerId)}`);
      if (stale()) return;
      if (!state.ctx) await loadContext();
      if (stale()) return;

      const needLab = (state.tab === 'props' || state.tab === 'overview') && !state.lab;
      if (needLab && state.ctx && state.ctx.market_event_id) {
        state.lab = await get('/api/wr-dna/prop-lab?'
          + `player_id=${encodeURIComponent(state.playerId)}`
          + `&event_id=${encodeURIComponent(state.ctx.market_event_id)}`
          + (similarCondition() ? `&condition=${encodeURIComponent(similarCondition())}` : ''));
      } else if (needLab) {
        state.lab = { history_available: state.dna.history_available !== false,
          markets: [{ available: false, market_label: 'Receiving markets',
            reason: 'no current market event is matched to the selected game' }],
          disclosure: { caveat: '' } };
      }
      if (state.tab === 'compare' && !state.cmp) {
        state.cmp = await get('/api/wr-dna/compare?'
          + `player_a=${encodeURIComponent(state.playerId)}`
          + `&player_b=${encodeURIComponent(state.comparePlayerId)}`);
      }
      if (stale()) return;
    } catch (e) {
      if (stale()) return;
      state.error = `Could not load WR DNA: ${e.message}`;
    }
    render();
  }

  async function loadContext() {
    try {
      // the schedule/venue/forecast resolver is shared with QB DNA
      if (!state.slate) state.slate = await get('/api/qb-dna/game-context');
      if (!state.slate.games.length) return;
      if (!state.eventId) {
        const team = (state.dna.player.team && state.dna.player.team.abbreviation)
          || state.dna.player.current_team || null;
        const mineG = state.slate.games.find(g => g.home_team === team || g.away_team === team);
        state.eventId = (mineG || state.slate.games[0]).espn_event_id;
      }
      state.ctx = await get(`/api/qb-dna/game-context?event_id=${encodeURIComponent(state.eventId)}`
        + '&kind=receiving');
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
      state.ctxCmp = await get('/api/wr-dna/compare?' + q.join('&'));
    } catch (e) {
      state.ctx = null; state.ctxCmp = null;
      console.warn('[wrdna] game context unavailable:', e.message);
    }
  }

  function view() { if (!state.dna) load(); else render(); }

  function install() {
    if (!window.App || !window.App.VIEWS) return false;
    App.VIEWS.wrdna = view;
    App.VIEWS['wr-dna'] = view;
    return true;
  }

  window.addEventListener('resize', onResize);
  window.PBEWRDna = { render, load, state };
  install();
  document.addEventListener('DOMContentLoaded', install, { once: true });
  window.addEventListener('pbe:upgrades-ready', install);
})();
