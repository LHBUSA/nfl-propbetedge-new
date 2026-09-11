/* PropBetEdge NFL — Today's PBE Card (v3)
 *
 * The one client owner of the PBE Card server contract (/api/pbe-picks,
 * contract pbe-card-v3). Every surface — PBE Picks, Dashboard, Matchup,
 * PBEcast — renders from this store, so there is exactly one read and no
 * decision logic in the browser:
 *
 *   NFL Pro   view=current   the real current decisions, each labelled by
 *                            its own publication_scope (PBE VALIDATION SIGNAL
 *                            or OFFICIAL PBE PICK)
 *   everyone  view=preview   the same decisions, locked: game, market, issue
 *                            time. The selection is never in the response, so
 *                            there is nothing here to hide with CSS.
 *
 * Truth rules. Nothing is inferred or embellished: every number on a card is a
 * field of the response. A missing value renders as a dash. WHY IT CLEARED
 * shows only the server's threshold checks and frozen flags. A degraded engine
 * never renders a pre-kickoff signal as live.
 *
 * No timer of its own: surfaces call ensure() when they paint; reads are
 * TTL-guarded and shared.
 */
(() => {
  'use strict';

  const API = '/api/pbe-picks';
  const TTL = { current: 60000, preview: 60000, history: 300000 };
  const store = {
    mode: null,            // 'pro' | 'public'
    data: null, error: null, at: 0, busy: null, status: null,
    history: { data: null, error: null, at: 0, busy: null },
    open: new Set(),
  };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const isPro = () => window.PBEPro?.state?.pro === true;
  const ET = { timeZone: 'America/New_York' };

  /* ---- formatting --------------------------------------------------------- */
  const american = v => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n)}`; };
  const line = v => { const n = num(v); if (n === null) return '—'; if (n === 0) return 'PK'; return `${n > 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(1)}`; };
  const pct = v => { const n = num(v); return n === null ? '—' : `${(n * 100).toFixed(1)}%`; };
  const pp = v => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}`; };
  const units = v => { const n = num(v); return n === null ? '—' : `${n.toFixed(2)}u`; };
  const signedUnits = v => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}u`; };
  function etTime(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); }
  function etDay(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }); }
  function etStamp(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : `${etDay(v)} · ${etTime(v)} ET`; }
  function ago(v) {
    const t = Date.parse(v || ''); if (!Number.isFinite(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function until(v) {
    const t = Date.parse(v || ''); if (!Number.isFinite(t)) return '';
    const s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return 'kicked off';
    if (s < 3600) return `in ${Math.round(s / 60)}m`;
    if (s < 172800) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
    return `in ${Math.round(s / 86400)}d`;
  }
  const MARKET = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' };

  function logo(team, size = 40) {
    if (!team) return '';
    let src = '';
    try { src = window.PBENFLMediaV2?.teamLogo?.(team) || ''; } catch (_) { src = ''; }
    if (!src) {
      const slug = ({ WAS: 'wsh', WSH: 'wsh', LA: 'lar' }[team] || String(team).toLowerCase()).replace(/[^a-z]/g, '');
      src = slug ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${slug}.png` : '';
    }
    return src ? `<img src="${esc(src)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : '';
  }

  /* nflverse id -> comparable team pair (LAR->LA, WSH->WAS on both sides). */
  const NFLVERSE = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX' };
  const code = v => { const c = String(v || '').toUpperCase().trim(); return NFLVERSE[c] || c; };
  function pairOf(gameId) { const m = /^\d{4}_\d{2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gameId || '')); return m ? `${code(m[1])}|${code(m[2])}` : null; }

  /* ---- data ---------------------------------------------------------------- */
  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch (_) { body = null; }
    if (!r.ok) { const e = new Error(body?.error || `HTTP ${r.status}`); e.status = r.status; e.body = body; throw e; }
    return body;
  }

  function emit() { window.dispatchEvent(new CustomEvent('pbe:card-ready', { detail: { mode: store.mode, ok: Boolean(store.data) } })); }

  /* The server decides entitlement. The browser only chooses which view to
   * ask for; a Pro request that is refused falls back to the locked preview. */
  function ensure(force = false) {
    const want = isPro() ? 'pro' : 'public';
    if (store.busy) return store.busy;
    const fresh = store.mode === want && store.at && Date.now() - store.at < TTL[want === 'pro' ? 'current' : 'preview'];
    if (!force && fresh) return Promise.resolve(store.data);
    const url = `${API}?view=${want === 'pro' ? 'current' : 'preview'}`;
    store.busy = getJson(url)
      .then(body => { store.mode = want; store.data = body; store.error = null; store.status = 200; return body; })
      .catch(async error => {
        store.status = error.status || null;
        if (want === 'pro' && [401, 403].includes(error.status)) {
          try { const body = await getJson(`${API}?view=preview`); store.mode = 'public'; store.data = body; store.error = null; return body; } catch (e) { error = e; }
        }
        store.error = error.body?.error || error.message || 'unavailable';
        if (store.mode !== want) store.data = null;
        return store.data;
      })
      .finally(() => { store.at = Date.now(); store.busy = null; emit(); });
    return store.busy;
  }

  function ensureHistory(force = false) {
    const h = store.history;
    if (!isPro()) return Promise.resolve(null);
    if (h.busy) return h.busy;
    if (!force && h.at && Date.now() - h.at < TTL.history) return Promise.resolve(h.data);
    h.busy = getJson(`${API}?view=validation-history`)
      .then(body => { h.data = body; h.error = null; return body; })
      .catch(error => { h.error = error.body?.error || error.message; return null; })
      .finally(() => { h.at = Date.now(); h.busy = null; emit(); });
    return h.busy;
  }

  const cards = () => (store.mode === 'pro' ? arr(store.data?.picks) : []);
  const previews = () => (store.mode === 'public' ? arr(store.data?.previews) : []);
  function forGame({ away, home, espnId } = {}) {
    const key = away && home ? `${code(away)}|${code(home)}` : null;
    const match = row => (espnId && row?.game?.espn_id && String(row.game.espn_id) === String(espnId)) || (key && pairOf(row.game_id) === key);
    return { cards: cards().filter(match), previews: previews().filter(match) };
  }

  /* ---- shared fragments --------------------------------------------------- */
  const mode = () => store.data?.display_mode || 'VALIDATION';
  function ribbon(data = store.data) {
    const m = data?.display_mode;
    if (m === 'DEGRADED') return '<div class="pbec-ribbon is-degraded"><i></i><b>ENGINE DEGRADED</b><span>Signals below are shown as last confirmed by the engine, not as live decisions.</span></div>';
    if (m === 'OFFICIAL') return `<div class="pbec-ribbon is-official"><i></i><b>OFFICIAL PBE CARD</b><span>Champion v${esc(data?.champion_version ?? '—')} · every official pick enters the permanent Official Track Record.</span></div>`;
    return '<div class="pbec-ribbon is-validation"><i></i><b>LIVE VALIDATION</b><span>Real pre-game decisions from a champion still under validation · not the Official Track Record.</span></div>';
  }
  function scopeChip(c) {
    return c.publication_scope === 'official'
      ? `<span class="pbec-scope is-official">${esc(c.label || 'OFFICIAL PBE PICK')}</span>`
      : `<span class="pbec-scope is-validation">${esc(c.label || 'PBE VALIDATION SIGNAL')}</span>`;
  }
  function lifeChip(lifecycle, c) {
    const labels = { ACTIVE: c && c.actionable === false ? 'LAST CONFIRMED' : 'ACTIVE', LOCKED: 'PICK LOCKED', FINAL: 'FINAL' };
    return `<span class="pbec-life lc-${esc(String(lifecycle || '').toLowerCase())}${c && c.actionable === false && lifecycle === 'ACTIVE' ? ' is-stale' : ''}">${esc(labels[lifecycle] || lifecycle || '')}</span>`;
  }
  function matchupHtml(m, size = 34) {
    if (!m) return '';
    return `<span class="pbec-matchup">${logo(m.away, size)}<b>${esc(m.away)}</b><em>@</em>${logo(m.home, size)}<b>${esc(m.home)}</b></span>`;
  }
  function priceParts(c) {
    const s = c.selection || {};
    if (c.market === 'moneyline') return { main: `${s.team || '—'}`, sub: 'MONEYLINE', price: american(c.issue?.price) };
    if (c.market === 'total') return { main: `${s.over_under || '—'} ${num(c.issue?.line) ?? '—'}`, sub: 'GAME TOTAL', price: american(c.issue?.price) };
    return { main: `${s.team || '—'} ${line(c.issue?.line)}`, sub: 'POINT SPREAD', price: american(c.issue?.price) };
  }
  function fairValue(c) {
    const f = num(c.model?.fair_line);
    if (f === null) return '—';
    if (c.market === 'moneyline') return american(f);
    if (c.market === 'spread') return line(f);
    return `${f}`;
  }
  function edgeMeter(c) {
    const m = num(c.model?.prob), k = num(c.market_prob);
    if (m === null || k === null) return '';
    const lo = Math.max(0, Math.min(m, k) * 100), hi = Math.min(100, Math.max(m, k) * 100);
    return `<div class="pbec-meter" role="img" aria-label="Market ${esc(pct(k))}, PBE model ${esc(pct(m))}">
      <div class="pbec-meter-track"><span class="pbec-meter-gap" style="left:${lo.toFixed(2)}%;width:${Math.max(0.6, hi - lo).toFixed(2)}%"></span>
      <i class="pbec-meter-mkt" style="left:${(k * 100).toFixed(2)}%"></i><i class="pbec-meter-pbe" style="left:${(m * 100).toFixed(2)}%"></i></div>
      <div class="pbec-meter-legend"><span><i class="mkt"></i>Market ${esc(pct(k))}</span><span><i class="pbe"></i>PBE ${esc(pct(m))}</span></div></div>`;
  }
  function spark(path) {
    const pts = arr(path).map(p => num(p.line) ?? num(p.price)).filter(v => v !== null);
    if (pts.length < 2) return '';
    const min = Math.min(...pts), max = Math.max(...pts), span = Math.max(1e-6, max - min);
    const d = pts.map((v, i) => `${(i / (pts.length - 1) * 100).toFixed(1)},${(26 - ((v - min) / span) * 22).toFixed(1)}`).join(' ');
    return `<svg class="pbec-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${d}"/></svg>`;
  }

  /* ---- MARKET SINCE ISSUE -------------------------------------------------- */
  function marketBlock(c) {
    const m = c.market_since_issue;
    if (!m) return '';
    if (!m.available) {
      return `<section class="pbec-block pbec-market"><header><span>MARKET SINCE ISSUE</span></header><p class="pbec-muted">No market snapshot for this selection has been captured since the issue time. The issued call stands as issued.</p></section>`;
    }
    const dir = m.direction === 'toward' ? ['toward', 'Market moved toward the signal'] : m.direction === 'against' ? ['against', 'Market moved against the signal'] : ['flat', 'No material move since issue'];
    const cur = m.current || {};
    const isMl = c.market === 'moneyline';
    const nowText = isMl ? american(cur.price) : `${line(cur.line)} · ${american(cur.price)}`;
    const issueText = isMl ? american(m.issue?.price) : `${line(m.issue?.line)} · ${american(m.issue?.price)}`;
    const delta = isMl ? (num(m.price_delta) === null ? '' : `${num(m.price_delta) > 0 ? '+' : ''}${num(m.price_delta)} cents`) : (num(m.line_delta) === null ? '' : `${num(m.line_delta) > 0 ? '+' : ''}${num(m.line_delta)} pts`);
    return `<section class="pbec-block pbec-market is-${dir[0]}"><header><span>MARKET SINCE ISSUE</span><b>${esc(dir[1])}</b></header>
      <div class="pbec-market-row">
        <div><small>Issued</small><strong>${esc(issueText)}</strong><em>${esc(etStamp(m.issue?.captured_at))}</em></div>
        <div class="pbec-market-arrow">${spark(m.path)}<span>${esc(delta)}</span></div>
        <div><small>${m.basis === 'close' ? 'Close' : 'Latest snapshot'}</small><strong>${esc(nowText)}</strong><em>${esc(etStamp(cur.captured_at))} · ${esc(ago(cur.captured_at))}</em></div>
      </div>
      <p class="pbec-muted">${num(cur.market_prob) !== null ? `De-vigged market now ${esc(pct(cur.market_prob))} vs ${esc(pct(c.market_prob))} at issue. ` : ''}Consensus tape from the scheduled ingest; snapshots are not live prices. The issued line and price never change.</p>
    </section>`;
  }

  /* ---- LIVE / FINAL -------------------------------------------------------- */
  function liveBlock(c) {
    if (c.lifecycle !== 'LOCKED') return '';
    const g = c.game;
    const score = g && num(g.away_score) !== null && num(g.home_score) !== null && g.state !== 'SCHEDULE'
      ? `<span class="pbec-score">${esc(c.matchup?.away)} <b>${esc(g.away_score)}</b> — <b>${esc(g.home_score)}</b> ${esc(c.matchup?.home)}</span>` : '';
    const prog = c.progress ? `<strong class="pbec-progress is-${esc(c.progress.state)}">${esc(c.progress.text)}</strong>` : '<strong class="pbec-progress">Awaiting live score</strong>';
    return `<section class="pbec-block pbec-live"><header><span><i class="pbec-dot"></i>PICK LOCKED · ${esc(g?.state === 'FINAL' ? 'FINAL — AWAITING GRADE' : g?.state === 'LIVE' ? 'IN PLAY' : 'KICKED OFF')}</span>${g?.detail ? `<b>${esc(g.detail)}</b>` : ''}</header>
      <div class="pbec-live-row">${score}${prog}</div>
      <div class="pbec-live-foot"><span>Selection frozen at kickoff: ${esc(c.selection?.display)} ${esc(american(c.issue?.price))}</span>${g?.espn_id ? `<button type="button" class="pbec-link" data-pbec-cast="${esc(g.espn_id)}">Follow in PBEcast →</button>` : ''}</div>
    </section>`;
  }
  function finalBlock(c) {
    if (c.lifecycle !== 'FINAL') return '';
    const gr = c.grade || {};
    const r = String(gr.result || 'pending').toUpperCase();
    const close = c.market_since_issue?.close;
    return `<section class="pbec-block pbec-final is-${esc(String(gr.result || 'pending').toLowerCase())}">
      <div class="pbec-stamp">${esc(r)}</div>
      <dl class="pbec-final-grid">
        <div><dt>Units</dt><dd>${esc(signedUnits(gr.units_delta))}</dd></div>
        <div><dt>Closing line</dt><dd>${close ? esc(c.market === 'moneyline' ? american(close.price) : `${line(close.line)} · ${american(close.price)}`) : '—'}</dd></div>
        <div><dt>CLV</dt><dd>${num(gr.clv_points) !== null ? esc(`${num(gr.clv_points) > 0 ? '+' : ''}${num(gr.clv_points)} pts`) : num(gr.clv_prob) !== null ? esc(`${pp(gr.clv_prob)}pp`) : '—'}${typeof gr.clv_beat === 'boolean' ? ` <small>${gr.clv_beat ? 'beat close' : 'missed close'}</small>` : ''}</dd></div>
        <div><dt>Brier</dt><dd>${num(gr.brier) !== null ? esc(num(gr.brier).toFixed(3)) : '—'}</dd></div>
      </dl>
      <p class="pbec-muted">${c.publication_scope === 'official' ? 'Recorded in the Official Track Record.' : 'Recorded in Validation History only — never in the Official Track Record.'}</p>
    </section>`;
  }

  /* ---- AUDIT: why it cleared, receipt, events ------------------------------ */
  const EVENT_LABEL = {
    NEW_PBE_SIGNAL: 'Signal issued', PRICE_MOVED_THROUGH_ISSUE_LINE: 'Market moved off the issue line',
    SIGNAL_SUPERSEDED: 'Superseded', SIGNAL_WITHDRAWN: 'Withdrawn', PICK_LOCKED: 'Locked at kickoff', FINAL_GRADE: 'Graded from the final',
  };
  function auditBlock(c) {
    const w = c.why_cleared;
    const rc = c.receipt;
    const checks = arr(w?.checks).map(k => {
      let body = '';
      if (k.key === 'edge') body = `${k.value_pp > 0 ? '+' : ''}${k.value_pp}pp vs ${k.threshold_pp}pp threshold · cleared by ${k.margin_pp}pp`;
      else if (k.key === 'confidence') body = `Persisted ${k.persisted ?? '—'} · rule gives ${k.recomputed ?? '—'}`;
      else if (k.key === 'stake') body = `Persisted ${units(k.persisted)} · rule gives ${units(k.recomputed)}`;
      return `<li class="${k.pass ? 'pass' : 'fail'}"><i aria-hidden="true">${k.pass ? '✓' : '!'}</i><div><b>${esc(k.label)}</b><small>${esc(body)}</small></div></li>`;
    }).join('');
    const flags = arr(w?.frozen_flags).map(f => `<span>${esc(f.label)}</span>`).join('');
    const events = arr(c.events).map(e => `<li><time>${esc(etStamp(e.at))}</time><b>${esc(EVENT_LABEL[e.type] || e.type)}</b>${e.detail?.from !== undefined ? `<small>${esc(line(e.detail.from))} → ${esc(line(e.detail.to))}</small>` : ''}</li>`).join('');
    const v = rc?.verified || {};
    return `<details class="pbec-audit" data-pbec-audit="${esc(c.id)}"${store.open.has(c.id) ? ' open' : ''}><summary><span>Why it cleared · receipt · timeline</span><i aria-hidden="true"></i></summary>
      <div class="pbec-audit-grid">
        <section><h4>Why it cleared</h4>${checks ? `<ul class="pbec-checks">${checks}</ul>` : '<p class="pbec-muted">No persisted evidence packet for this decision.</p>'}
          ${flags ? `<h5>Frozen at issue</h5><div class="pbec-flags">${flags}</div>` : ''}
          <p class="pbec-muted">Deterministic checks re-derived from the persisted decision and its frozen feature snapshot. No written rationale is generated.</p></section>
        <section><h4>Issuance receipt</h4>${rc ? `<dl class="pbec-receipt">
            <div><dt>Chain hash</dt><dd><code>${esc(rc.chain_hash)}</code></dd></div>
            <div><dt>Payload SHA-256</dt><dd><code>${esc(rc.payload_sha256)}</code></dd></div>
            <div><dt>Sequence</dt><dd>#${esc(rc.seq)} · ${esc(rc.receipt_version)} · ${esc(rc.publication_scope)}</dd></div>
            <div><dt>Issued</dt><dd>${esc(etStamp(rc.issued_at))}</dd></div>
          </dl><ul class="pbec-verify"><li class="${v.payload_hash ? 'pass' : 'fail'}">Payload digest recomputed</li><li class="${v.issued_terms ? 'pass' : 'fail'}">Issued terms match the receipt</li><li class="${v.chain_link === true ? 'pass' : v.chain_link === false ? 'fail' : ''}">Chain link ${v.chain_link === true ? 'verified' : v.chain_link === false ? 'not reproduced' : 'not checked'}</li></ul>
          <p class="pbec-muted">Internal SHA-256 tamper evidence written in the same transaction as the decision. Not third-party notarization.</p>` : '<p class="pbec-muted">Receipt unavailable.</p>'}</section>
        <section><h4>Timeline</h4>${events ? `<ol class="pbec-events">${events}</ol>` : '<p class="pbec-muted">No events.</p>'}</section>
      </div>
    </details>`;
  }

  /* ---- THE PICK CARD -------------------------------------------------------- */
  function pickCard(c, { featured = false, strongest = false } = {}) {
    const p = priceParts(c);
    const scope = c.publication_scope === 'official' ? 'official' : 'validation';
    return `<article class="pbec-card is-${scope} lc-${esc(String(c.lifecycle).toLowerCase())}${featured ? ' is-featured' : ''}${c.actionable === false && c.lifecycle === 'ACTIVE' ? ' is-unconfirmed' : ''}" data-pbec-card="${esc(c.id)}">
      <header class="pbec-card-head">${scopeChip(c)}${lifeChip(c.lifecycle, c)}${strongest ? '<span class="pbec-strong">STRONGEST EDGE ON THE CARD</span>' : ''}<span class="pbec-kick">${esc(MARKET[c.market] || c.market)} · ${esc(etStamp(c.kickoff_ts))}${c.lifecycle === 'ACTIVE' ? ` · ${esc(until(c.kickoff_ts))}` : ''}</span></header>
      <div class="pbec-card-body">
        <div class="pbec-sel">
          ${matchupHtml(c.matchup, featured ? 40 : 30)}
          <div class="pbec-sel-label">SELECTION · ${esc(p.sub)}</div>
          <div class="pbec-sel-main">${esc(p.main)}<span>${esc(p.price)}</span></div>
          ${edgeMeter(c)}
        </div>
        <dl class="pbec-terms">
          <div><dt>Issue price</dt><dd>${esc(c.market === 'moneyline' ? american(c.issue?.price) : `${line(c.issue?.line)} · ${american(c.issue?.price)}`)}</dd></div>
          <div><dt>PBE fair value</dt><dd>${esc(fairValue(c))}<small>${esc(pct(c.model?.prob))} model</small></dd></div>
          <div><dt>Market probability</dt><dd>${esc(pct(c.market_prob))}<small>de-vigged at issue</small></dd></div>
          <div class="is-edge"><dt>Edge</dt><dd>${esc(pp(c.edge_pct))}<small>pp vs market</small></dd></div>
          <div><dt>Confidence</dt><dd class="pbec-grade">${esc(c.confidence_bucket || '—')}</dd></div>
          <div><dt>Risk</dt><dd>${esc(units(c.stake_units))}<small>quarter-Kelly</small></dd></div>
          <div class="is-wide"><dt>Issued at</dt><dd>${esc(etStamp(c.issue?.at))}<small>model v${esc(c.model?.version ?? '—')} · receipt ${esc(String(c.receipt?.chain_hash || '').slice(0, 10))}…</small></dd></div>
        </dl>
      </div>
      ${liveBlock(c)}${finalBlock(c)}${c.lifecycle !== 'FINAL' ? marketBlock(c) : ''}
      ${auditBlock(c)}
      <footer class="pbec-card-foot">${esc(c.tag || '')}</footer>
    </article>`;
  }

  /* ---- LOCKED PREVIEW (free) ------------------------------------------------ */
  function lockedCard(pv) {
    return `<article class="pbec-card is-locked lc-${esc(String(pv.lifecycle).toLowerCase())}">
      <header class="pbec-card-head"><span class="pbec-scope is-${pv.publication_scope === 'official' ? 'official' : 'validation'}">${esc(pv.label)}</span>${lifeChip(pv.lifecycle)}<span class="pbec-kick">${esc(MARKET[pv.market] || pv.market)} · ${esc(etStamp(pv.kickoff_ts))}</span></header>
      <div class="pbec-card-body is-locked">
        <div class="pbec-sel">${matchupHtml(pv.matchup, 30)}
          <div class="pbec-sel-label">SELECTION · ${esc((MARKET[pv.market] || pv.market).toUpperCase())}</div>
          <div class="pbec-lockline" aria-label="Selection locked"><i aria-hidden="true"></i><span>Selection, line and price are NFL Pro</span></div>
        </div>
        <dl class="pbec-terms is-locked"><div><dt>Issued</dt><dd>${esc(etStamp(pv.issued_at))}</dd></div><div><dt>Edge · confidence · risk</dt><dd>NFL Pro</dd></div></dl>
      </div>
    </article>`;
  }

  /* ---- HERO: TODAY'S PBE CARD ------------------------------------------------ */
  function heroHtml() {
    const d = store.data || {};
    const pro = store.mode === 'pro';
    const s = d.summary || {};
    const f = d.freshness || {};
    const strongest = pro && s.strongest ? cards().find(c => c.id === s.strongest.id) : null;
    const tiles = [
      ['Active signals', `${num(s.active) ?? 0}`, `${num(s.locked) ?? 0} locked · ${num(s.final) ?? 0} final this week`],
      ['Strongest signal', strongest ? `${strongest.selection?.display || '—'} ${american(strongest.issue?.price)}` : pro ? '—' : 'NFL Pro', strongest ? `${pp(strongest.edge_pct)}pp edge · ${strongest.matchup?.away} @ ${strongest.matchup?.home}` : pro ? 'No active signal' : 'Highest persisted edge on the card'],
      ['Next kickoff', s.next_kickoff ? etStamp(s.next_kickoff) : '—', s.next_kickoff ? until(s.next_kickoff) : 'No pending kickoff'],
      ['Last engine evaluation', ago(f.last_evaluation_at || d.last_evaluation_at), f.last_evaluation_at || d.last_evaluation_at ? etStamp(f.last_evaluation_at || d.last_evaluation_at) : 'No run recorded'],
      ['Market tape', f.tape_captured_at ? ago(f.tape_captured_at) : pro ? '—' : 'NFL Pro', f.tape_captured_at ? `${f.tape_state === 'STALE' ? 'STALE · ' : ''}${etStamp(f.tape_captured_at)}` : pro ? 'No snapshot' : 'Snapshot freshness per signal'],
    ];
    const weekRecord = pro && s.week_record ? `<div class="pbec-hero-week"><span>${d.display_mode === 'OFFICIAL' ? 'This week' : 'Validation · this week'}</span><b>${s.week_record.win}-${s.week_record.loss}${s.week_record.push ? `-${s.week_record.push}` : ''}</b><em>${esc(signedUnits(s.week_units))}</em></div>` : '';
    return `<section class="pbec-hero is-${esc(String(d.display_mode || 'VALIDATION').toLowerCase())}">
      ${ribbon(d)}
      <div class="pbec-hero-main">
        <div class="pbec-hero-title"><span class="pbec-eyebrow">${esc(d.season ?? '')} · WEEK ${esc(d.week ?? '—')} · ${pro ? 'NFL PRO' : 'PREVIEW'}</span><h1>Today's <em>PBE Card</em></h1>
          <p>${pro ? 'Every current decision the engine holds, exactly as issued — selection, price, probability and edge from the persisted decision, the market since, and the receipt behind it.' : 'The engine has made these decisions. The selections, lines and prices are delivered only to verified NFL Pro members — they are not in this page.'}</p></div>
        ${weekRecord}
      </div>
      <div class="pbec-hero-tiles">${tiles.map(([k, v, sub]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong><small>${esc(sub)}</small></div>`).join('')}</div>
    </section>`;
  }

  function emptyHtml() {
    const d = store.data || {};
    return `<section class="pbec-empty"><b>No current decisions on the card</b><span>${d.display_mode === 'DEGRADED' ? 'The engine is degraded; nothing is presented as live.' : 'The engine evaluated the slate and holds no qualifying decision right now. Nothing is manufactured to fill the card.'}</span></section>`;
  }

  function withdrawnHtml() {
    const w = arr(store.data?.withdrawn);
    if (!w.length) return '';
    return `<section class="pbec-withdrawn"><header><span>WITHDRAWN BEFORE KICKOFF</span><small>Audit events, not picks. The edge collapsed below the kill threshold and the engine stood down.</small></header>
      <ul>${w.map(x => `<li>${matchupHtml(x.matchup, 22)}<span>${esc(MARKET[x.market] || x.market)}</span><time>${esc(x.withdrawn_at ? etStamp(x.withdrawn_at) : '—')}</time></li>`).join('')}</ul></section>`;
  }

  function unlockHtml() {
    return `<section class="pbec-unlock"><div><span class="pbec-eyebrow">NFL PRO</span><h2>Unlock today's PBE card</h2>
      <p>Exact selection, issue line and price, PBE model probability, de-vigged market probability, edge, confidence, risk units, market movement since issue and the SHA-256 receipt — for every decision on the card.</p></div>
      <button type="button" class="pbec-cta" data-pbec-upgrade>Unlock today's PBE card</button></section>`;
  }

  /* The flagship section on the PBE Picks page. */
  function flagshipHtml() {
    if (!store.data) {
      if (store.error) return `<section class="pbec-empty is-error"><b>PBE Card unavailable</b><span>${esc(store.error)}. A failed read is never shown as an empty card.</span><button type="button" class="pbec-link" data-pbec-retry>Retry</button></section>`;
      return '<section class="pbec-empty"><b>Loading today\'s PBE card</b><span>Reading the engine\'s current decisions.</span></section>';
    }
    const pro = store.mode === 'pro';
    const list = pro ? cards() : previews();
    const s = store.data.summary || {};
    const strongestId = pro ? s.strongest?.id : null;
    const ordered = pro ? [...list.filter(c => c.id === strongestId), ...list.filter(c => c.id !== strongestId)] : list;
    const body = !list.length ? emptyHtml()
      : pro ? `<div class="pbec-grid">${ordered.map((c, i) => pickCard(c, { featured: i === 0 && c.id === strongestId, strongest: c.id === strongestId })).join('')}</div>`
        : `<div class="pbec-grid is-locked">${list.map(lockedCard).join('')}</div>${unlockHtml()}`;
    return `<div class="pbec">${heroHtml()}${body}${pro ? withdrawnHtml() : ''}${pro ? historyHtml() : ''}</div>`;
  }

  /* ---- VALIDATION HISTORY (Pro) -------------------------------------------- */
  function historyHtml() {
    const h = store.history;
    const d = h.data;
    const s = d?.summary;
    const rows = arr(d?.picks);
    return `<details class="pbec-history" data-pbec-history${store.open.has('history') ? ' open' : ''}><summary><div><span class="pbec-eyebrow">VALIDATION HISTORY · NFL PRO</span><strong>Every graded validation signal this season</strong></div><i aria-hidden="true"></i></summary>
      <p class="pbec-muted">Separate from the Official Track Record and never merged into it. Withdrawn decisions are listed as audit events, not results.</p>
      ${!d ? `<div class="pbec-empty">${h.error ? `<b>History unavailable</b><span>${esc(h.error)}</span>` : '<b>Open to load</b>'}</div>`
        : `<div class="pbec-history-kpis"><div><span>Record</span><b>${s.win}-${s.loss}${s.push ? `-${s.push}` : ''}</b></div><div><span>Units</span><b>${esc(signedUnits(s.units))}</b></div><div><span>CLV beat</span><b>${s.clv_beat_pct === null ? '—' : `${s.clv_beat_pct}%`}</b></div><div><span>Withdrawn</span><b>${esc(s.withdrawn)}</b></div></div>
        ${rows.length ? `<div class="pbec-table"><table><thead><tr><th>Kickoff</th><th>Selection</th><th>Issue</th><th>Edge</th><th>Conf</th><th>Risk</th><th>Result</th><th>Units</th><th>Receipt</th></tr></thead><tbody>${rows.map(c => `<tr><td>${esc(etDay(c.kickoff_ts))}<small>W${esc(c.week)}</small></td><td><b>${esc(c.selection?.display)}</b><small>${esc(c.matchup?.away)} @ ${esc(c.matchup?.home)}</small></td><td>${esc(c.market === 'moneyline' ? american(c.issue?.price) : `${line(c.issue?.line)} · ${american(c.issue?.price)}`)}</td><td>${esc(pp(c.edge_pct))}</td><td>${esc(c.confidence_bucket)}</td><td>${esc(units(c.stake_units))}</td><td><span class="pbec-res is-${esc(String(c.grade?.result || '').toLowerCase())}">${esc(String(c.grade?.result || '—').toUpperCase())}</span></td><td>${esc(signedUnits(c.grade?.units_delta))}</td><td><code>${esc(String(c.receipt?.chain_hash || '').slice(0, 10))}…</code></td></tr>`).join('')}</tbody></table></div>` : '<div class="pbec-empty"><b>No graded validation signals yet this season</b></div>'}`}
    </details>`;
  }

  /* ---- Dashboard / game / matchup / PBEcast modules ------------------------ */
  function compactCard(c) {
    const p = priceParts(c);
    return `<button type="button" class="pbec-mini is-${c.publication_scope === 'official' ? 'official' : 'validation'} lc-${esc(String(c.lifecycle).toLowerCase())}" data-route="pbepicks">
      <span class="pbec-mini-top">${matchupHtml(c.matchup, 18)}${lifeChip(c.lifecycle, c)}</span>
      <strong>${esc(p.main)} <em>${esc(p.price)}</em></strong>
      <span class="pbec-mini-stats"><b>${esc(pp(c.edge_pct))}pp</b> edge · ${esc(c.confidence_bucket || '—')} · ${esc(units(c.stake_units))}${c.lifecycle === 'LOCKED' && c.progress ? ` · ${esc(c.progress.text)}` : c.lifecycle === 'FINAL' && c.grade ? ` · ${esc(String(c.grade.result).toUpperCase())}` : ''}</span>
    </button>`;
  }
  function dashboardHtml() {
    ensure();
    const d = store.data;
    const head = t => `<div class="pbecc-head"><div><span class="pbecc-eyebrow">TODAY'S PBE CARD${d ? ` · WEEK ${esc(d.week ?? '')}` : ''}</span><h2>${esc(t)}</h2></div><button type="button" data-route="pbepicks">Full card →</button></div>`;
    if (!d) return `<section class="pbecc-panel pbec-dash">${head('The engine\'s current decisions')}<div class="pbecc-empty ${store.error ? 'is-error' : ''}"><b>${store.error ? 'PBE Card unavailable' : 'Reading the card'}</b><span>${store.error ? `${esc(store.error)}. A failed read is never shown as an empty card.` : 'Current decisions from the engine.'}</span></div></section>`;
    const pro = store.mode === 'pro';
    const s = d.summary || {};
    const label = d.display_mode === 'OFFICIAL' ? 'OFFICIAL PBE PICKS' : d.display_mode === 'DEGRADED' ? 'ENGINE DEGRADED' : 'PBE VALIDATION SIGNALS';
    if (pro) {
      const list = cards();
      const top = [...list.filter(c => c.id === s.strongest?.id), ...list.filter(c => c.id !== s.strongest?.id && c.lifecycle !== 'FINAL')].slice(0, 4);
      return `<section class="pbecc-panel pbec-dash is-${esc(String(d.display_mode).toLowerCase())}">${head(`${num(s.active) ?? 0} active · ${num(s.locked) ?? 0} locked`)}
        <p class="pbec-dash-mode">${esc(label)} · ${d.display_mode === 'VALIDATION' ? 'real pre-game decisions, not the Official Track Record' : d.display_mode === 'DEGRADED' ? 'shown as last confirmed, not live' : `champion v${esc(d.champion_version)}`}</p>
        ${top.length ? `<div class="pbec-mini-grid">${top.map(compactCard).join('')}</div>` : '<div class="pbecc-empty"><b>No current decisions</b><span>Nothing is manufactured to fill the card.</span></div>'}
      </section>`;
    }
    const list = previews().filter(p => p.lifecycle !== 'FINAL').slice(0, 4);
    return `<section class="pbecc-panel pbec-dash is-locked">${head(`${num(s.active) ?? 0} active signals on the card`)}
      <p class="pbec-dash-mode">${esc(label)} · selections are delivered only to NFL Pro</p>
      ${list.length ? `<ul class="pbec-dash-locked">${list.map(p => `<li>${matchupHtml(p.matchup, 18)}<span>${esc(MARKET[p.market] || p.market)}</span><i aria-hidden="true"></i></li>`).join('')}</ul>` : ''}
      <button type="button" class="pbec-cta is-small" data-pbec-upgrade>Unlock today's PBE card</button>
    </section>`;
  }

  /* A badge on a scoreboard game card. Pro sees the selection; free sees that
   * a signal exists. */
  function gameBadge({ away, home, espnId }) {
    const hit = forGame({ away, home, espnId });
    const c = hit.cards.find(x => x.lifecycle !== 'FINAL') || hit.cards[0];
    if (c) {
      const more = hit.cards.length > 1 ? ` +${hit.cards.length - 1}` : '';
      return `<button type="button" class="pbec-badge is-${c.publication_scope === 'official' ? 'official' : 'validation'}" data-route="pbepicks" title="${esc(c.label)}"><i></i>${esc(c.publication_scope === 'official' ? 'PBE PICK' : 'PBE SIGNAL')} · ${esc(c.selection?.display)}${esc(more)}</button>`;
    }
    const pv = hit.previews.find(x => x.lifecycle !== 'FINAL');
    return pv ? `<button type="button" class="pbec-badge is-locked" data-pbec-upgrade title="Unlock today's PBE card"><i></i>PBE SIGNAL · ${hit.previews.filter(x => x.lifecycle !== 'FINAL').length} LOCKED</button>` : '';
  }

  /* The decision module on a matchup page or PBEcast: every current decision
   * on this game, in full for Pro and locked for everyone else. */
  function gameModule({ away, home, espnId, surface = 'matchup' }) {
    ensure();
    if (!store.data) return '';
    const hit = forGame({ away, home, espnId });
    const title = surface === 'pbecast' ? 'Original PBE decision' : 'PBE decision on this game';
    if (hit.cards.length) {
      return `<section class="pbec pbec-module is-${surface}"><header class="pbec-module-head"><span class="pbec-eyebrow">${esc(title.toUpperCase())}</span>${ribbon()}</header>
        <div class="pbec-grid is-module">${hit.cards.map(c => pickCard(c)).join('')}</div></section>`;
    }
    if (hit.previews.length) {
      return `<section class="pbec pbec-module is-${surface}"><header class="pbec-module-head"><span class="pbec-eyebrow">${esc(title.toUpperCase())}</span></header>
        <div class="pbec-grid is-module is-locked">${hit.previews.map(lockedCard).join('')}</div>${unlockHtml()}</section>`;
    }
    return '';
  }

  /* A placeholder any template can drop in; filled when the card lands. */
  function slot({ away, home, espnId, surface = 'matchup' }) {
    return `<div data-pbec-slot data-away="${esc(away || '')}" data-home="${esc(home || '')}" data-espn="${esc(espnId || '')}" data-surface="${esc(surface)}"></div>`;
  }
  function fillSlots() {
    document.querySelectorAll('[data-pbec-slot]').forEach(el => {
      const html = gameModule({ away: el.dataset.away, home: el.dataset.home, espnId: el.dataset.espn, surface: el.dataset.surface });
      if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
    });
  }

  /* ---- events --------------------------------------------------------------- */
  document.addEventListener('toggle', e => {
    const el = e.target;
    if (el?.matches?.('[data-pbec-audit]')) { if (el.open) store.open.add(el.dataset.pbecAudit); else store.open.delete(el.dataset.pbecAudit); }
    if (el?.matches?.('[data-pbec-history]')) {
      if (el.open) { store.open.add('history'); ensureHistory(); } else store.open.delete('history');
    }
  }, true);
  document.addEventListener('click', e => {
    const up = e.target.closest?.('[data-pbec-upgrade]');
    if (up) { e.preventDefault(); if (window.PBEPro?.open) window.PBEPro.open('upgrade'); else document.getElementById('pbe-pro-account')?.click(); return; }
    const cast = e.target.closest?.('[data-pbec-cast]');
    if (cast) { e.preventDefault(); try { sessionStorage.setItem('pbe.pbecast.focus', JSON.stringify({ game_id: cast.dataset.pbecCast })); } catch (_) {} window.App?.nav?.('pbecast'); return; }
    const retry = e.target.closest?.('[data-pbec-retry]');
    if (retry) { e.preventDefault(); ensure(true); return; }
    const route = e.target.closest?.('.pbec [data-route], .pbec-dash [data-route], .pbec-mini[data-route], .pbec-badge[data-route]');
    if (route && !route.closest('.pbecc')) { e.preventDefault(); window.App?.nav?.(route.dataset.route); }
  });
  let lastPro = null;
  window.addEventListener('pbe:pro-state', ev => {
    const pro = ev?.detail?.pro === true;
    if (pro !== lastPro) { lastPro = pro; store.history = { data: null, error: null, at: 0, busy: null }; ensure(true); }
  });
  window.addEventListener('pbe:card-ready', fillSlots);

  window.PBECard = {
    version: 3, store, ensure, ensureHistory, cards, previews, forGame,
    flagshipHtml, heroHtml, pickCard, lockedCard, dashboardHtml, gameBadge, gameModule, slot, fillSlots,
  };
})();
