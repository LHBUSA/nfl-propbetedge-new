/* PBE NFL validation telemetry
 * Polls aggregate public-safe backend telemetry. It never reveals bootstrap
 * selections and never represents the internal SHA-256 chain as third-party
 * notarization.
 */
(() => {
  'use strict';

  const API = '/api/pbe-validation';
  const POLL_MS = 15000;
  let timer = null;
  let busy = false;
  let last = null;

  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
  const metric = (value, suffix = '') => value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}${suffix}`;
  const shortTime = value => {
    if (!value) return '—';
    const d = new Date(value); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', second:'2-digit' });
  };
  const shortDate = value => {
    if (!value) return '—';
    const d = new Date(value); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  };

  function active() {
    return window.App?.current === 'pbepicks' && Boolean(document.querySelector('.pbe2-stage.gated .pbe2-validation'));
  }

  function patchRings(data) {
    const rings = document.querySelectorAll('.pbe2-stage.gated .pbe2-ring');
    const gate = data?.volume_gate;
    if (!gate || rings.length < 2) return;
    const values = [
      [gate.finalized, gate.required_finalized],
      [gate.distinct_weeks, gate.required_weeks]
    ];
    rings.forEach((ring, index) => {
      const [value, required] = values[index];
      const pct = required ? Math.max(0, Math.min(100, Number(value || 0) / Number(required) * 100)) : 0;
      ring.style.setProperty('--p', pct.toFixed(1));
      const strong = ring.querySelector('strong'); if (strong) strong.textContent = String(value ?? 0);
      const label = ring.querySelector('span'); if (label) label.textContent = `of ${required} ${index ? 'weeks' : 'grades'}`;
    });
  }

  function activityHtml(data) {
    const rows = Array.isArray(data?.activity) ? data.activity : [];
    if (!rows.length) {
      return '<div class="pbeval-empty">No persisted validation activity has been recorded yet. This feed stays empty rather than simulating engine messages.</div>';
    }
    return rows.map(row => {
      const kind = String(row.kind || 'ENGINE').toUpperCase();
      return `<div class="pbeval-line"><span class="pbeval-time">${esc(shortTime(row.at))}</span><span class="pbeval-kind ${kind.toLowerCase()}">${esc(kind)}</span><span>${esc(row.message || '')}</span></div>`;
    }).join('');
  }

  function receiptHtml(data) {
    const c = data?.commitments || {};
    const recent = Array.isArray(c.recent) ? c.recent : [];
    const head = c.latest;
    const main = head
      ? `<div class="pbeval-hash"><span>Latest pre-reveal commitment · #${esc(head.seq)}</span><code>${esc(head.chain_hash)}</code><small>Issued ${esc(shortDate(head.issued_at))}. Publicly exposed here after database commitment. Internal SHA-256 chain only; no independent timestamp anchor is configured.</small></div>`
      : '<div class="pbeval-hash"><span>Pre-reveal commitment ledger</span><code>NO COMMITMENT ISSUED YET</code><small>The first bootstrap decision will create a chained SHA-256 receipt in the same database transaction as issuance.</small></div>';
    const list = recent.length
      ? `<div class="pbeval-receipts">${recent.map(row => `<div class="pbeval-receipt"><span>#${esc(row.seq)}</span><code>${esc(row.chain_hash)}</code><time>${esc(shortDate(row.issued_at))}</time></div>`).join('')}</div>`
      : '';
    return `${main}${list}`;
  }

  function stat(label, value, note, cls = '') {
    return `<div class="pbeval-stat"><span>${esc(label)}</span><strong class="${esc(cls)}">${esc(value)}</strong><small>${esc(note)}</small></div>`;
  }

  function performanceHtml(data) {
    const p = data?.bootstrap_performance || {};
    const champion = data?.champion || {};
    const bt = champion.backtest || {};
    const clv = num(p.clv_beat_pct);
    const brier = num(p.brier);
    const units = num(p.units_delta);
    const backtestClv = num(bt.clv_beat_pct);
    const backtestBrier = num(bt.brier);
    const backtestUnits = num(bt.units);
    return `<div class="pbeval-contract">
      ${stat('Bootstrap CLV beat', clv === null ? '—' : metric(clv,'%'), clv === null ? 'waiting for finalized decisions' : 'descriptive OOS tracking metric', clv !== null && clv >= 50 ? 'good' : '')}
      ${stat('Bootstrap Brier', brier === null ? '—' : brier.toFixed(4), brier === null ? 'waiting for graded outcomes' : 'lower is better')}
      ${stat('Bootstrap units', units === null ? '—' : `${units > 0 ? '+' : ''}${units.toFixed(2)}u`, `${Number(p.wins || 0)}-${Number(p.losses || 0)}-${Number(p.pushes || 0)} tracking results`, units !== null && units > 0 ? 'good' : '')}
      ${stat('Commitments', String(data?.commitments?.committed_tracking_count ?? 0), 'tracking decisions hashed pre-reveal', 'gold')}
    </div><div class="pbeval-rule"><div><strong>Actual promotion contract</strong><p>${esc(data?.promotion_contract?.primary || 'Promotion contract unavailable.')} ${esc(data?.promotion_contract?.tie_break || '')}</p><div class="pbeval-baseline"><div class="pbeval-base-cell"><span>Champion backtest CLV</span><b>${backtestClv === null ? 'not published' : `${backtestClv.toFixed(1)}%`}</b></div><div class="pbeval-base-cell"><span>Champion backtest Brier</span><b>${backtestBrier === null ? 'not published' : backtestBrier.toFixed(4)}</b></div><div class="pbeval-base-cell"><span>Champion backtest units</span><b>${backtestUnits === null ? 'not published' : `${backtestUnits > 0 ? '+' : ''}${backtestUnits.toFixed(2)}u`}</b></div></div></div><div class="pbeval-rule-note"><strong style="font-family:inherit;font-size:7px">NO INVENTED ROI HURDLE</strong><br>The production tuner does not use a fixed ROI target. It waits for 100 finalized decisions across 4 weeks, trains a challenger, then compares CLV-beat% and Brier against the champion.</div></div>`;
  }

  function shell(data) {
    const hb = data?.market_heartbeat || {};
    return `<section class="pbeval-shell" id="pbe-validation-telemetry"><div class="pbeval-grid"><section class="pbeval-panel"><div class="pbeval-head"><div><span>Live evaluation telemetry</span><strong>Validation tape</strong></div><span class="pbeval-live"><i></i> FACTUAL POLL · 15S</span></div><div class="pbeval-feed">${activityHtml(data)}</div></section><section class="pbeval-panel"><div class="pbeval-head"><div><span>Cryptographic commitments</span><strong>Pre-reveal receipts</strong></div><span class="pbeval-live">${hb.latest_snapshot_at ? `MARKET ${esc(shortTime(hb.latest_snapshot_at))}` : 'NO MARKET SNAPSHOT'}</span></div><div class="pbeval-proof">${receiptHtml(data)}</div></section></div><section class="pbeval-panel">${performanceHtml(data)}</section></section>`;
  }

  function render(data) {
    if (!active()) return;
    patchRings(data);
    const pipeline = document.querySelector('.pbe2-pipeline');
    if (!pipeline) return;
    const existing = document.getElementById('pbe-validation-telemetry');
    if (existing) existing.outerHTML = shell(data);
    else pipeline.insertAdjacentHTML('afterend', shell(data));
  }

  async function refresh() {
    if (!active() || busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const response = await fetch(API, { cache:'no-store', headers:{ accept:'application/json' } });
      if (!response.ok) return;
      last = await response.json();
      render(last);
    } catch (_) {
      // Existing validation UI remains authoritative if telemetry is unavailable.
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
    setTimeout(refresh, 40);
  }

  const observer = new MutationObserver(() => {
    if (active()) {
      if (last) render(last);
      else refresh();
    }
  });
  observer.observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('pbe:route-changed', schedule);
  window.addEventListener('pbe:upgrades-ready', schedule);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  schedule();
})();
