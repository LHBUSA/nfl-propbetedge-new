/* ============================================================================
   PropBetEdge NFL — PLAYER DNA shared infrastructure
   ----------------------------------------------------------------------------
   One implementation of everything the four Player DNA products (QB, WR, RB,
   TE) have in common, so a fix lands once and every position inherits it.

   Exposed as window.PBEPlayerDNA:
     · identity media  — real headshots and crests, never a substitute mark
     · charts          — the canvas series and distribution renderers
     · picker          — the player switcher, PORTALLED to a global modal root
     · family switcher — movement between the four products
     · formatting      — the shared number and sample grammar

   WHY THE PICKER IS PORTALLED
   Each product's root (.q2) is position:relative with a z-index, which creates
   a stacking context. A descendant cannot escape it, so however large the
   picker's own z-index, it stays trapped beneath the sports shell (2500), the
   mobile overlay (2600) and the drawer (2700). Raising the number inside the
   subtree cannot fix that; the element has to leave the subtree.

   MEASURED z-index LADDER in this product:
       2500 sports shell     2600 mobile overlay    2700 sidebar drawer
       4200 prop board       4700 player research   4750 team research
       4850 event selector   4900 command palette   4950 stadium control
       5000 paywall  <- deliberately above everything; auth must never be hidden
       9500 pbecast overlay  9999 skip link
   The picker sits at 4980: above every navigation layer and every peer modal,
   and still below the paywall.
   ========================================================================== */
(() => {
  'use strict';

  const ROOT_ID = 'pbe-player-dna-modal-root';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---- identity media ---------------------------------------------------- */
  const IMG_FAIL = "this.classList.add('is-broken');this.removeAttribute('src')";
  const SEARCH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
    <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10.6 10.6 L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

  function headshot(player, size, noun) {
    const url = player && player.media && player.media.headshot_url;
    const name = (player && player.name) || noun || 'Player';
    if (!url) {
      return `<span class="q2-face q2-face-none" style="--face:${size}px" role="img"
        aria-label="No photograph available for ${esc(name)}"
        title="${esc((player && player.media && player.media.unavailable_reason)
          || 'no photograph available')}"><i>Photo unavailable</i></span>`;
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

  /* ---- the global modal root -------------------------------------------- */
  function modalRoot() {
    let el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ROOT_ID;
      // attached to BODY, so it is a sibling of the shell rather than a
      // descendant of any product's stacking context
      document.body.appendChild(el);
    } else if (el.parentElement !== document.body) {
      document.body.appendChild(el);
    }
    return el;
  }

  /* ---- the player picker ------------------------------------------------- */
  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  let openState = null;

  function groupsFor(players, query) {
    const q = String(query || '').trim().toLowerCase();
    const match = p => !q || p.name.toLowerCase().includes(q)
      || String(p.team_2026 || p.team || '').toLowerCase().includes(q);
    return [
      ['Priced by the current market', players.filter(p => p.market_priced_2026 && match(p))],
      ['On a 2026 roster', players.filter(p => !p.market_priced_2026 && p.active_2026 && match(p))],
      ['Historical', players.filter(p => !p.active_2026 && match(p))]
    ].filter(([, rows]) => rows.length);
  }

  function listHtml(players, query, positionNoun, currentId) {
    const groups = groupsFor(players, query);
    if (!groups.length) return `<div class="q2-empty">No ${esc(positionNoun)} matches that search.</div>`;
    return groups.map(([label, rows]) => `<div class="q2-picker-group">
      <div class="q2-picker-glabel">${esc(label)} <em>${rows.length}</em></div>
      ${rows.slice(0, 140).map(p => `<button type="button" class="q2-picker-row${
          p.gsis_id === currentId ? ' is-current' : ''}" data-pick="${esc(p.gsis_id)}"${
          p.gsis_id === currentId ? ' aria-current="true"' : ''}>
        ${headshot(p, 40, positionNoun)}
        <span class="q2-picker-copy"><b>${esc(p.name)}${
          p.gsis_id === currentId ? '<i class="q2-picker-now">Open now</i>' : ''}</b>
          <em>${esc(p.team_2026 || p.team || '')}${p.position ? ' · ' + esc(p.position) : ''}
            · ${p.history_available ? esc(p.games) + ' games' : 'no NFL history'}</em></span>
        ${crest(p.team_media, 20)}
      </button>`).join('')}
    </div>`).join('');
  }

  /**
   * Open the shared player picker.
   * @param {object}   o
   * @param {Array}    o.players        the index rows to offer
   * @param {string}   o.positionNoun   "quarterback" | "receiver" | ...
   * @param {Function} o.onPick         called with the chosen gsis id
   * @param {Element}  o.returnFocusTo  focus goes back here on close
   */
  function openPicker(o) {
    closePicker();
    const root = modalRoot();
    const players = o.players || [];
    const noun = o.positionNoun || 'player';
    let query = '';

    root.innerHTML = `<div class="pdna-modal" role="dialog" aria-modal="true"
        aria-label="Choose a ${esc(noun)}">
      <div class="pdna-modal-panel">
        <div class="q2-picker-head">
          <input type="search" class="q2-picker-input" id="pdna-picker-q"
            placeholder="Search ${esc(noun)}s" autocomplete="off"
            aria-label="Search ${esc(noun)}s">
          <button type="button" class="q2-picker-x" data-close aria-label="Close">&times;</button>
        </div>
        <div class="q2-picker-body" id="pdna-picker-body">${listHtml(players, '', noun, o.currentId || null)}</div>
      </div>
    </div>`;

    const overlay = root.querySelector('.pdna-modal');
    const input = root.querySelector('#pdna-picker-q');
    const body = root.querySelector('#pdna-picker-body');

    // the page behind a modal must not scroll, and must not jump when the
    // scrollbar disappears
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;
    document.body.classList.add('pdna-modal-open');

    const wireRows = () => {
      body.querySelectorAll('[data-pick]').forEach(b =>
        b.addEventListener('click', () => {
          const id = b.dataset.pick;
          closePicker();
          if (typeof o.onPick === 'function') o.onPick(id);
        }));
    };
    wireRows();

    input.addEventListener('input', () => {
      query = input.value;
      body.innerHTML = listHtml(players, query, noun, o.currentId || null);
      body.scrollTop = 0;
      wireRows();
    });
    root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closePicker));
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePicker(); });

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key !== 'Tab') return;
      // focus stays inside the modal while it is open
      const items = [...overlay.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    /* A soft keyboard shrinks the visual viewport rather than the layout
       viewport, which is what leaves a search field hidden underneath it. */
    const vv = window.visualViewport;
    const onViewport = () => {
      if (!vv) return;
      overlay.style.setProperty('--pdna-vh', `${vv.height}px`);
      overlay.style.setProperty('--pdna-vtop', `${vv.offsetTop}px`);
    };
    if (vv) {
      onViewport();
      vv.addEventListener('resize', onViewport);
      vv.addEventListener('scroll', onViewport);
    }

    openState = { root, onKey, prevOverflow, prevPad, vv, onViewport,
                  returnFocusTo: o.returnFocusTo || null };
    // focus the search field, but do not scroll the page to reach it
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } }, 20);
  }

  function closePicker() {
    if (!openState) return;
    const s = openState;
    openState = null;
    document.removeEventListener('keydown', s.onKey, true);
    if (s.vv) {
      s.vv.removeEventListener('resize', s.onViewport);
      s.vv.removeEventListener('scroll', s.onViewport);
    }
    document.body.style.overflow = s.prevOverflow;
    document.body.style.paddingRight = s.prevPad;
    document.body.classList.remove('pdna-modal-open');
    s.root.innerHTML = '';
    // focus returns to the control that opened it
    if (s.returnFocusTo && document.body.contains(s.returnFocusTo)) {
      try { s.returnFocusTo.focus({ preventScroll: true }); } catch { s.returnFocusTo.focus(); }
    }
  }

  const isPickerOpen = () => Boolean(openState);

  /* A source's failure detail belongs in the methodology panel, not in the
     hero: "forecast unavailable: This operation was aborted" is a transport
     error, and a reader only needs the first clause. Any other reason (a
     roof, a neutral site, no hour in the window) is product truth and stays. */
  const softReason = r => {
    const s = String(r || '').trim();
    if (!s) return '';
    const m = /^(forecast unavailable|weather unavailable|nws unavailable)\s*:/i.exec(s);
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' for this game' : s;
  };

  /* ---- cross-product focus hand-off --------------------------------------
     PBE BREAKING (a corroborated name in a headline, or a club in a weather
     alert) can ask a product to open on a specific player and game. The
     request is a one-shot token in session storage, consumed by the product
     it names and by nobody else, so a stale request can never redirect a
     later, unrelated visit. */
  const FOCUS_KEY = 'pbe.playerdna.focus';
  function takeFocus(route) {
    try {
      const raw = sessionStorage.getItem(FOCUS_KEY);
      if (!raw) return null;
      const f = JSON.parse(raw);
      if (!f || f.route !== route) return null;
      sessionStorage.removeItem(FOCUS_KEY);
      return (f.player_id || f.event_id) ? f : null;
    } catch { return null; }
  }
  /**
   * Apply a focus request to a product's state and say whether a reload is
   * needed. Every product keeps the same derived-state fields, so the reset
   * lives here once rather than four times.
   */
  function applyFocus(state, route) {
    const f = takeFocus(route);
    if (!f) return false;
    let changed = false;
    if (f.player_id && f.player_id !== state.playerId) {
      state.playerId = f.player_id;
      state.dna = null; state.lab = null; state.cmp = null;
      state.ctxCmp = null; state.ctx = null; state.eventId = null;
      changed = true;
    }
    if (f.event_id && f.event_id !== state.eventId) {
      state.eventId = f.event_id;
      state.ctx = null; state.ctxCmp = null; state.lab = null;
      changed = true;
    }
    return changed;
  }

  /* ---- the product family ------------------------------------------------ */
  const FAMILY = [
    { route: 'qbdna', short: 'QB', label: 'QB DNA' },
    { route: 'wrdna', short: 'WR', label: 'WR DNA' },
    { route: 'rbdna', short: 'RB', label: 'RB DNA' },
    { route: 'tedna', short: 'TE', label: 'TE DNA' }
  ];

  /** A restrained switch between the four products, for the page header. */
  function familySwitch(activeRoute) {
    return `<nav class="pdna-family" aria-label="Player DNA products">
      ${FAMILY.map(f => `<button type="button" class="pdna-family-btn${
        f.route === activeRoute ? ' is-on' : ''}" data-family="${f.route}"
        aria-current="${f.route === activeRoute ? 'page' : 'false'}"
        title="${esc(f.label)}">${esc(f.short)}</button>`).join('')}
    </nav>`;
  }
  function wireFamily(scope) {
    (scope || document).querySelectorAll('[data-family]').forEach(b =>
      b.addEventListener('click', () => {
        const r = b.dataset.family;
        if (window.App && typeof App.nav === 'function') App.nav(r);
        else location.hash = r;
      }));
  }

  /* ---- charts ------------------------------------------------------------
     One canvas implementation, drawn from series the engines already computed.
     No library, no animation loop, one entrance unless motion is reduced. */
  const REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHART = {
    ink: '#14110d', line: 'rgba(255,245,220,.09)', lineStrong: 'rgba(255,245,220,.22)',
    text: '#a5a096', gold: '#e9c75a', pos: '#5cbb85', neg: '#e04a5f', dim: '#6b665e',
    posFill: 'rgba(92,187,133,.78)', negFill: 'rgba(224,74,95,.72)'
  };
  function fitCanvas(cv, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 600;
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
  function paintCharts(scope) {
    (scope || document).querySelectorAll('canvas[data-chart]').forEach(cv => {
      let cfg; try { cfg = JSON.parse(cv.dataset.cfg || '{}'); } catch { return; }
      if (cv.dataset.chart === 'series') drawSeries(cv, cfg);
      else if (cv.dataset.chart === 'dist') drawDistribution(cv, cfg);
      if (!REDUCED) cv.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    });
  }

  /* ---- shared formatting grammar ---------------------------------------- */
  const n1 = v => (typeof v === 'number' ? v.toFixed(1) : v);
  const pctSigned = v => (typeof v === 'number' ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—');
  const samp = l => (l ? `<span class="q2-samp" data-s="${esc(l)}">${esc(l)}</span>` : '');
  const den = r => (r && r.denominator ? `${r.numerator}/${r.denominator}` : 'no denominator');
  /** American odds carry a sign; without it the number is not a price. */
  const priceLabel = v => (typeof v === 'number' ? (v > 0 ? '+' + v : String(v)) : '—');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const longDate = iso => {
    const d = new Date(iso + (String(iso).length === 10 ? 'T12:00:00Z' : ''));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  function kickoffLabel(iso) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
      minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
    const g = t => (parts.find(x => x.type === t) || {}).value || '';
    return `${g('weekday')} · ${g('hour')}:${g('minute')} ${g('dayPeriod')} ET`;
  }
  /** A specific condition window, in order of how much it narrows the field. */
  const SPECIFIC_CONDITIONS = ['snow', 'rain', 'wind_20_plus', 'wind_15_plus', 'arctic_sub20',
    'freezing_20_32', 'warm_70_plus', 'cold_33_50', 'wind_10_plus', 'mild_51_70',
    'dry', 'primetime', 'divisional', 'dome'];
  function similarCondition(ctxCmp, minGames) {
    if (!ctxCmp) return null;
    const min = minGames || 5;
    return SPECIFIC_CONDITIONS.find(k => {
      const x = ctxCmp.windows && ctxCmp.windows[k];
      return x && x.available && x.games >= min;
    }) || null;
  }

  window.PBEPlayerDNA = {
    esc, headshot, crest, matchupLine, SEARCH_ICON, IMG_FAIL,
    modalRoot, openPicker, closePicker, isPickerOpen, takeFocus, applyFocus, softReason,
    FAMILY, familySwitch, wireFamily,
    paintCharts, drawSeries, drawDistribution,
    n1, pctSigned, samp, den, priceLabel, longDate, kickoffLabel,
    SPECIFIC_CONDITIONS, similarCondition
  };
})();
