/* PropBetEdge NFL — Prop Board v4
 * World-class signal layer over Prop Board v3.
 *
 * Truth contract:
 * - Market data remains the current provider snapshot from Prop Board v3.
 * - Model fields remain server-gated production output from Prop Board v3.
 * - The micro distribution below Book Range is CROSS-BOOK NOW, not historical
 *   line movement. We do not invent 24h history when the backend does not
 *   expose it.
 * - Edge Read text is deterministic from published model + current market data;
 *   it never invents injuries, weather, scheme changes or matchup history.
 */
(() => {
  'use strict';

  const VERSION = 'v4.0.0';
  const SETTINGS_KEY = 'pbe_propboard_v4_settings';
  const PIN_PREFIX = 'pbe_propboard_v4_pins_';
  const DEFAULT_THRESHOLD = 15;

  let observer = null;
  let enhanceTimer = null;
  let delegatesInstalled = false;

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  const fmt = (value, digits = 1) => {
    const n = num(value);
    return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0$/, '') : '—';
  };

  const odds = value => {
    const n = num(value);
    return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—';
  };

  const current = () => window.PBEPropBoardV3 || null;
  const state = () => current()?.state || null;
  const isPro = () => Boolean(window.PBEPro?.state?.pro);
  const eventId = () => String(state()?.eventId || localStorage.getItem('pbe_nfl_event') || 'default');
  const pinKey = () => `${PIN_PREFIX}${eventId()}`;

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function settings() {
    const saved = readJson(SETTINGS_KEY, {});
    return {
      edgeOnly: saved.edgeOnly !== false,
      pinnedOnly: saved.pinnedOnly === true,
      threshold: Number.isFinite(Number(saved.threshold)) ? Math.max(0, Number(saved.threshold)) : DEFAULT_THRESHOLD,
    };
  }

  function saveSettings(patch) {
    const next = { ...settings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  function pins() {
    const saved = readJson(pinKey(), []);
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  }

  function savePins(values) {
    localStorage.setItem(pinKey(), JSON.stringify([...values]));
  }

  function rowByKey(key) {
    return state()?.rows?.find(row => String(row.key) === String(key)) || null;
  }

  function modelGap(row) {
    return num(row?.model?.fair_line_gap_yards ?? row?.model?.model_gap ?? row?.model?.gap);
  }

  function modelFair(row) {
    return num(row?.model?.fair_line ?? row?.model?.projected_line);
  }

  function modelProb(row) {
    let p = num(row?.model?.model_over_at_consensus_pct ?? row?.model?.over_probability_pct ?? row?.model?.probability);
    if (Number.isFinite(p) && p >= 0 && p <= 1) p *= 100;
    return p;
  }

  function pointOf(q) {
    return num(q?.point ?? q?.line);
  }

  function priceOf(q) {
    return num(q?.price ?? q?.american_odds ?? q?.odds);
  }

  function bookOf(q) {
    return q?.book || q?.book_title || q?.sportsbook || q?.book_key || 'Book';
  }

  function currentLineDistribution(row) {
    const quotes = Array.isArray(row?.quotes) ? row.quotes : [];
    const withLine = quotes
      .map(q => ({ q, line: pointOf(q) }))
      .filter(item => Number.isFinite(item.line));
    if (withLine.length < 2) return '';

    const lo = Math.min(...withLine.map(item => item.line));
    const hi = Math.max(...withLine.map(item => item.line));
    const span = hi - lo;
    const dots = withLine.slice(0, 18).map(item => {
      const left = span > 0 ? ((item.line - lo) / span) * 100 : 50;
      const title = `${bookOf(item.q)} · ${fmt(item.line, 1)} · ${odds(priceOf(item.q))}`;
      return `<i class="pbe4-micro-dot" style="left:${left.toFixed(1)}%" title="${esc(title)}"></i>`;
    }).join('');

    return `<div class="pbe4-micro-wrap" title="Current cross-book line distribution. This is not historical line movement.">
      <div class="pbe4-micro"><span></span>${dots}</div>
      <small>CURRENT BOOK DISTRIBUTION</small>
    </div>`;
  }

  function unmodeledMarkup(label) {
    return `<span class="pbe4-unmodeled" title="${esc(label)} is unavailable for this prop. No synthetic model value is substituted." aria-label="Model unavailable">—</span>`;
  }

  function probabilityMarkup(row) {
    const p = modelProb(row);
    if (!Number.isFinite(p)) return unmodeledMarkup('Model probability');
    const pct = Math.max(0, Math.min(100, p));
    return `<div class="pbe4-prob" title="PBE production-model Over probability at the current consensus line">
      <div class="pbe4-prob-top"><strong>${esc(fmt(p, 1))}%</strong><span>PBE OVER</span></div>
      <div class="pbe4-prob-track"><span style="width:${pct.toFixed(1)}%"></span><i style="left:50%"></i></div>
    </div>`;
  }

  function edgeClass(gap) {
    const magnitude = Math.abs(gap);
    if (magnitude >= 20) return 'max';
    if (magnitude >= 10) return 'strong';
    if (magnitude >= 5) return 'medium';
    return 'base';
  }

  function edgeMarkup(row) {
    const gap = modelGap(row);
    if (!Number.isFinite(gap)) return unmodeledMarkup('Model gap');
    const direction = gap >= 0 ? 'pos' : 'neg';
    const magnitude = edgeClass(gap);
    const label = gap >= 0 ? 'PBE fair line above consensus' : 'PBE fair line below consensus';
    return `<span class="pbe3-model-gap pbe4-edge-badge ${direction} ${magnitude}" title="${esc(label)}">${gap > 0 ? '+' : ''}${esc(fmt(gap, 1))}</span>`;
  }

  function commandBarHtml() {
    const cfg = settings();
    const pro = isPro();
    const pinCount = pins().size;
    return `<section class="pbe4-commandbar" aria-label="Prop Board edge controls">
      <div class="pbe4-command-identity"><span class="pbe4-command-kicker">EDGE DESK</span><strong>Surface signal. Suppress noise.</strong><small>Live snapshot · current cross-book distribution · no fabricated history</small></div>
      <div class="pbe4-command-actions">
        <button type="button" class="pbe4-toggle ${pro && cfg.edgeOnly ? 'on' : ''}" data-pbe4-action="edge" aria-pressed="${pro && cfg.edgeOnly ? 'true' : 'false'}" ${pro ? '' : 'disabled'} title="${pro ? 'Hide rows without a production model output' : 'Modeled-only view requires NFL Pro'}"><span></span>Modeled only</button>
        <button type="button" class="pbe4-toggle ${cfg.pinnedOnly ? 'on' : ''}" data-pbe4-action="pinned" aria-pressed="${cfg.pinnedOnly ? 'true' : 'false'}"><span></span>Pinned only <b>${pinCount}</b></button>
        <label class="pbe4-threshold ${pro ? '' : 'disabled'}" title="Browser-local visual alert threshold. This does not create push, email or webhook notifications."><span>Gap alert</span><input type="number" data-pbe4-threshold min="0" max="100" step="1" value="${esc(cfg.threshold)}" ${pro ? '' : 'disabled'}><em>+</em></label>
        <button type="button" class="pbe4-refresh" data-pbe4-action="refresh" title="Refresh the current provider snapshot">↻ Refresh</button>
      </div>
    </section>`;
  }

  function ensureCommandBar(root) {
    const desk = root.querySelector('.pbe3-desk');
    if (!desk) return;
    let bar = desk.querySelector(':scope > .pbe4-commandbar');
    const html = commandBarHtml();
    if (!bar) {
      bar = document.createElement('div');
      bar.innerHTML = html;
      const node = bar.firstElementChild;
      desk.insertBefore(node, desk.firstElementChild);
    } else if (bar.outerHTML !== html) {
      bar.outerHTML = html;
    }
  }

  function enhanceRows(root) {
    const cfg = settings();
    const pro = isPro();
    const pinned = pins();
    const tableRows = [...root.querySelectorAll('.pbe3-table tbody tr[data-row-key]')];

    tableRows.forEach(tr => {
      const row = rowByKey(tr.dataset.rowKey);
      if (!row) return;
      const cells = tr.cells;
      const isPinned = pinned.has(String(row.key));
      const hasModel = Boolean(row.model);

      tr.classList.toggle('pbe4-pinned-row', isPinned);
      tr.classList.toggle('pbe4-modeled-row', hasModel && pro);
      tr.classList.toggle('pbe4-unmodeled-row', !hasModel && pro);
      tr.classList.toggle('pbe4-hidden', Boolean((cfg.pinnedOnly && !isPinned) || (pro && cfg.edgeOnly && !hasModel && !isPinned)));

      if (cells[0] && !cells[0].querySelector('.pbe4-pin')) {
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = `pbe4-pin ${isPinned ? 'on' : ''}`;
        pin.dataset.pbe4Pin = String(row.key);
        pin.setAttribute('aria-label', isPinned ? 'Unpin this prop' : 'Pin this prop');
        pin.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        pin.title = isPinned ? 'Unpin this prop' : 'Pin this prop';
        pin.textContent = isPinned ? '★' : '☆';
        cells[0].prepend(pin);
      } else {
        const pin = cells[0]?.querySelector('.pbe4-pin');
        if (pin) {
          pin.classList.toggle('on', isPinned);
          pin.textContent = isPinned ? '★' : '☆';
          pin.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        }
      }

      if (cells[5] && !cells[5].querySelector('.pbe4-micro-wrap')) {
        const distribution = currentLineDistribution(row);
        if (distribution) cells[5].insertAdjacentHTML('beforeend', distribution);
      }

      if (pro && !hasModel) {
        if (cells[6]) cells[6].innerHTML = unmodeledMarkup('PBE fair line');
        if (cells[7]) cells[7].innerHTML = unmodeledMarkup('Model probability');
        if (cells[8]) cells[8].innerHTML = unmodeledMarkup('Model gap');
        if (cells[10]) cells[10].innerHTML = '<span class="pbe4-market-only" title="Current sportsbook market only. No production model output exists for this row.">—</span>';
      } else if (pro && hasModel) {
        if (cells[7]) cells[7].innerHTML = probabilityMarkup(row);
        if (cells[8]) cells[8].innerHTML = edgeMarkup(row);
        const gap = modelGap(row);
        if (Number.isFinite(gap)) {
          tr.dataset.pbe4Gap = String(gap);
          tr.classList.toggle('pbe4-edge-strong', Math.abs(gap) >= 10);
          tr.classList.toggle('pbe4-edge-max', Math.abs(gap) >= 20);
        }
      }
    });

    const tbody = root.querySelector('.pbe3-table tbody');
    if (tbody) {
      const pinnedRows = [...tbody.querySelectorAll('tr.pbe4-pinned-row:not(.pbe4-hidden)')];
      for (const tr of pinnedRows.reverse()) tbody.prepend(tr);
    }
  }

  function alertRows() {
    if (!isPro()) return [];
    const threshold = settings().threshold;
    return (state()?.rows || [])
      .filter(row => row.model && Number.isFinite(modelGap(row)) && Math.abs(modelGap(row)) >= threshold)
      .sort((a, b) => Math.abs(modelGap(b)) - Math.abs(modelGap(a)));
  }

  function ensureAlertRail(root) {
    const desk = root.querySelector('.pbe3-desk');
    if (!desk) return;
    let rail = root.querySelector('.pbe4-alert-rail');
    const rows = alertRows();
    const threshold = settings().threshold;

    if (!isPro()) {
      if (rail) rail.remove();
      return;
    }

    const html = rows.length
      ? `<section class="pbe4-alert-rail"><div class="pbe4-alert-head"><span>EDGE ALERTS</span><strong>${rows.length} row${rows.length === 1 ? '' : 's'} ≥ ${esc(fmt(threshold, 0))}</strong><small>Browser-local visual threshold · no push/webhook configured</small></div><div class="pbe4-alert-list">${rows.slice(0, 4).map(row => {
          const gap = modelGap(row);
          return `<button type="button" data-pbe4-open="${esc(row.key)}"><span>${esc(row.player)}</span><small>${esc(String(row.market || '').replace(/^player_/, '').replace(/_/g, ' '))}</small><b class="${gap >= 0 ? 'pos' : 'neg'}">${gap > 0 ? '+' : ''}${esc(fmt(gap, 1))}</b></button>`;
        }).join('')}</div></section>`
      : `<section class="pbe4-alert-rail quiet"><div class="pbe4-alert-head"><span>EDGE ALERTS</span><strong>No current gap clears ${esc(fmt(threshold, 0))}</strong><small>Threshold applies only to factual production-model rows</small></div></section>`;

    if (!rail) {
      const bar = desk.querySelector('.pbe4-commandbar');
      (bar || desk.firstElementChild)?.insertAdjacentHTML('afterend', html);
    } else if (rail.outerHTML !== html) {
      rail.outerHTML = html;
    }
  }

  function quoteSummary(q, side) {
    if (!q) return `<span>${esc(side)}</span><strong>—</strong><small>No current quote</small>`;
    return `<span>${esc(side)}</span><strong>${esc(fmt(pointOf(q), 1))} <em>${esc(odds(priceOf(q)))}</em></strong><small>${esc(bookOf(q))}</small>`;
  }

  function mobileModel(row) {
    if (!isPro()) return '<div class="pbe4-mobile-lock">NFL PRO MODEL</div>';
    if (!row.model) return '<div class="pbe4-mobile-unmodeled" title="No production model output">MODEL —</div>';
    const gap = modelGap(row);
    const prob = modelProb(row);
    return `<div class="pbe4-mobile-model"><span>PBE gap</span><b class="${gap >= 0 ? 'pos' : 'neg'}">${gap > 0 ? '+' : ''}${esc(fmt(gap, 1))}</b>${Number.isFinite(prob) ? `<small>${esc(fmt(prob, 1))}% OVER</small>` : ''}</div>`;
  }

  function ensureMobileCards(root) {
    const desk = root.querySelector('.pbe3-desk');
    if (!desk) return;
    let board = desk.querySelector('.pbe4-mobile-board');
    const pinned = pins();
    const visibleKeys = [...root.querySelectorAll('.pbe3-table tbody tr[data-row-key]:not(.pbe4-hidden)')]
      .map(tr => tr.dataset.rowKey)
      .filter(Boolean);
    const rows = visibleKeys.map(rowByKey).filter(Boolean).slice(0, 48);

    const html = `<section class="pbe4-mobile-board" aria-label="Mobile Prop Board">${rows.length ? rows.map(row => {
      const isPinned = pinned.has(String(row.key));
      return `<article class="pbe4-mobile-card ${row.model && isPro() ? 'modeled' : ''}" data-pbe4-open="${esc(row.key)}">
        <header><div><span>${esc(row.player)}</span><small>${esc(String(row.market || '').replace(/^player_/, '').replace(/_/g, ' '))}</small></div><button type="button" class="pbe4-pin ${isPinned ? 'on' : ''}" data-pbe4-pin="${esc(row.key)}" aria-label="${isPinned ? 'Unpin' : 'Pin'} this prop">${isPinned ? '★' : '☆'}</button></header>
        <div class="pbe4-mobile-market"><div>${quoteSummary(row.bestOver, 'BEST OVER')}</div><div>${quoteSummary(row.bestUnder, 'BEST UNDER')}</div><div><span>CONSENSUS</span><strong>${esc(fmt(row.consensus, 1))}</strong><small>${esc(row.bookCount)} books</small></div></div>
        <footer>${mobileModel(row)}<span class="pbe4-mobile-open">OPEN DETAIL →</span></footer>
      </article>`;
    }).join('') : '<div class="pbe4-mobile-empty">No rows match the current filters.</div>'}</section>`;

    if (!board) {
      const scroll = desk.querySelector('.pbe3-table-scroll');
      if (scroll) scroll.insertAdjacentHTML('beforebegin', html);
    } else if (board.outerHTML !== html) {
      board.outerHTML = html;
    }
  }

  function edgeThesis(row) {
    if (!row?.model) return '';
    const gap = modelGap(row);
    const fair = modelFair(row);
    const prob = modelProb(row);
    const consensus = num(row.consensus);
    const lo = num(row.minLine);
    const hi = num(row.maxLine);
    const pieces = [];

    if (Number.isFinite(fair) && Number.isFinite(consensus)) {
      pieces.push(`PBE fair ${fmt(fair, 1)} vs consensus ${fmt(consensus, 1)}`);
    }
    if (Number.isFinite(gap)) {
      pieces.push(`${gap > 0 ? '+' : ''}${fmt(gap, 1)} fair-line gap`);
    }
    if (Number.isFinite(prob)) {
      pieces.push(`${fmt(prob, 1)}% model Over probability at consensus`);
    }
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      pieces.push(`current books span ${fmt(lo, 1)}–${fmt(hi, 1)}`);
    }

    const missing = Array.isArray(row.model.missing_inputs) ? row.model.missing_inputs : [];
    const status = String(row.model.decision_status || row.model.confidence || 'MODEL').replace(/_/g, ' ');
    return `<div class="pbe4-thesis"><div class="pbe4-thesis-kicker">EDGE READ</div><strong>${esc(pieces.join(' · ') || 'Production model context available.')}</strong><p>Status: ${esc(status)}.${missing.length ? ` Missing inputs: ${esc(missing.join(', '))}.` : ''} This read is generated only from the published model output and current sportsbook snapshot; it does not invent historical movement, injuries, weather or matchup causes.</p></div>`;
  }

  function enhanceDrawer() {
    const drawer = document.querySelector('.pbe3-drawer');
    const row = state()?.drawerRow;
    if (!drawer || !row?.model || drawer.querySelector('.pbe4-thesis')) return;
    const modelSection = [...drawer.querySelectorAll('.pbe3-drawer-section')].find(section => section.textContent.includes('PBE Model Context'));
    if (!modelSection) return;
    modelSection.insertAdjacentHTML('beforeend', edgeThesis(row));
  }

  function updateMeta(root) {
    const rows = [...root.querySelectorAll('.pbe3-table tbody tr[data-row-key]')];
    const visible = rows.filter(tr => !tr.classList.contains('pbe4-hidden')).length;
    const modeled = rows.filter(tr => tr.classList.contains('pbe4-modeled-row')).length;
    const identity = root.querySelector('.pbe4-command-identity small');
    if (identity) identity.textContent = `${visible} visible · ${modeled} modeled · live snapshot · cross-book microview is not 24h history`;
  }

  function enhance() {
    const root = document.querySelector('.pbe3-propboard');
    if (!root) {
      enhanceDrawer();
      return;
    }
    root.classList.add('pbe4-worldclass');
    root.dataset.pbe4 = VERSION;
    root.dataset.pbePro = isPro() ? '1' : '0';
    ensureCommandBar(root);
    enhanceRows(root);
    ensureAlertRail(root);
    ensureMobileCards(root);
    updateMeta(root);
    enhanceDrawer();
  }

  function queueEnhance() {
    clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(() => {
      if (observer) observer.disconnect();
      try { enhance(); } catch (error) { console.error('[pbe-propboard-v4]', error?.message || error); }
      observe();
    }, 20);
  }

  function observe() {
    if (!observer) observer = new MutationObserver(queueEnhance);
    observer.disconnect();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function togglePin(key) {
    const values = pins();
    const id = String(key);
    if (values.has(id)) values.delete(id); else values.add(id);
    savePins(values);
    queueEnhance();
  }

  function installDelegates() {
    if (delegatesInstalled) return;
    delegatesInstalled = true;

    document.addEventListener('click', event => {
      const pin = event.target.closest('[data-pbe4-pin]');
      if (pin) {
        event.preventDefault();
        event.stopPropagation();
        togglePin(pin.dataset.pbe4Pin);
        return;
      }

      const action = event.target.closest('[data-pbe4-action]');
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        const cfg = settings();
        if (action.dataset.pbe4Action === 'edge' && isPro()) saveSettings({ edgeOnly: !cfg.edgeOnly });
        if (action.dataset.pbe4Action === 'pinned') saveSettings({ pinnedOnly: !cfg.pinnedOnly });
        if (action.dataset.pbe4Action === 'refresh') current()?.render?.();
        queueEnhance();
        return;
      }

      const opener = event.target.closest('[data-pbe4-open]');
      if (opener) {
        event.preventDefault();
        const key = opener.dataset.pbe4Open;
        if (key) current()?.openDrawer?.(key);
      }
    });

    document.addEventListener('change', event => {
      const input = event.target.closest('[data-pbe4-threshold]');
      if (!input || !isPro()) return;
      const value = Math.max(0, Math.min(100, Number(input.value) || 0));
      saveSettings({ threshold: value });
      queueEnhance();
    });

    window.addEventListener('pbe:pro-state', queueEnhance);
    window.addEventListener('pbe:route-changed', queueEnhance);
    window.addEventListener('pbe:event-changed', queueEnhance);
    window.addEventListener('pbe:upgrades-ready', queueEnhance);
  }

  function init() {
    installDelegates();
    observe();
    queueEnhance();
  }

  window.PBEPropBoardV4 = { version: VERSION, enhance: queueEnhance, settings, pins };
  init();
})();