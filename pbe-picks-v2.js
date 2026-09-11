/* PropBetEdge NFL — PBE Picks + Verified Track Record v2
 *
 * Product hierarchy:
 *   PBE Picks    -> the decision first. Pro-only proprietary economics.
 *   Track Record -> public accountability, official publication only.
 *
 * Truth rules:
 * - PBE Card v3 (pbe-card-v3.js) owns the decisions: NFL Pro sees current
 *   tracking rows as PBE VALIDATION SIGNALs, labelled per row; free users see
 *   locked previews. This file owns the governance deep dive under the card
 *   and the Official Track Record, which stays official-only.
 * - empty/gated/degraded are distinct states.
 * - receipt hashes are an INTERNAL SHA-256 chained tamper-evidence system,
 *   explicitly not represented as independent third-party notarization.
 * - model/backtest comparison renders only fields the backend actually has.
 * - engine HEALTH is separate from publication. It comes from the durable run
 *   ledger (engine_runtime); a stale or unknown engine renders DEGRADED, never
 *   as a healthy validation page.
 */
(() => {
  'use strict';

  const API = '/api/pbe-picks';
  const state = {
    governance: null,
    current: null,
    track: null,
    trackFilter: {
      market: 'all', model: 'all', confidence: 'all', week: 'all',
      weather: 'all', division: 'all', timing: 'all', result: 'all'
    },
    chartMode: 'equity',
    expanded: null,
    loadId: 0,
  };

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  /* Number(null) is 0 and 0 is finite: absent must stay absent, never 0. */
  const num = value => { if (value === null || value === undefined || value === '') return null; const x = Number(value); return Number.isFinite(x) ? x : null; };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const isPro = () => window.PBEPro?.state?.pro === true;

  async function json(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = null; }
    if (!response.ok) {
      const error = new Error(body?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function american(value) {
    const x = num(value); if (x === null) return '—';
    return x > 0 ? `+${Math.round(x)}` : `${Math.round(x)}`;
  }
  function probability(value) {
    const x = num(value); if (x === null) return '—';
    const pct = x <= 1 ? x * 100 : x;
    return `${pct.toFixed(1)}%`;
  }
  function edge(value) {
    const x = num(value); if (x === null) return '—';
    const pp = Math.abs(x) <= 1 ? x * 100 : x;
    return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
  }
  function line(value) {
    const x = num(value); if (x === null) return '—';
    return `${x > 0 ? '+' : ''}${Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1)}`;
  }
  function date(value) {
    if (!value) return '—'; const d = new Date(value); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  }
  function dateTime(value) {
    if (!value) return '—'; const d = new Date(value); if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
  }
  function marketLabel(market) {
    return ({ spread: 'Spread', moneyline: 'Moneyline', total: 'Total' }[market] || String(market || 'Market'));
  }
  function selection(row) {
    if (row?.market === 'total') return `${String(row.selection_over_under || row.side || 'TOTAL').toUpperCase()} ${line(row.market_line)}`;
    const team = row?.selection_team || String(row?.side || '').split(/\s+/)[0] || 'TEAM';
    return row?.market === 'moneyline' ? `${team} ML` : `${team} ${line(row.market_line)}`;
  }
  function result(row) {
    const r = String(row?.grade?.result || '').toLowerCase();
    if (r) return r;
    if (row?.status === 'killed') return 'void';
    return String(row?.status || 'pending').toLowerCase();
  }
  function flatProfit(row) {
    const r = result(row);
    if (r === 'loss') return -1;
    if (r === 'push') return 0;
    if (r !== 'win') return null;
    const price = num(row.market_price); if (price === null || price === 0) return null;
    return price > 0 ? price / 100 : 100 / Math.abs(price);
  }
  function settled(row) { return ['win', 'loss', 'push'].includes(result(row)); }

  function teamLogo(team) {
    if (!team) return '';
    try { if (window.PBENFLMediaV2?.teamLogo) return window.PBENFLMediaV2.teamLogo(team); } catch (_) {}
    const raw = String(team).replace(/[^A-Za-z]/g, '').toUpperCase();
    const clean = raw === 'WAS' ? 'wsh' : raw.toLowerCase();
    return clean ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${clean}.png` : '';
  }
  function teamImg(team) {
    const src = teamLogo(team);
    return src
      ? `<img src="${esc(src)}" alt="${esc(team)} logo" loading="lazy" onerror="this.style.display='none'">`
      : `<span class="pbe2-team-fallback">${esc(team || 'NFL')}</span>`;
  }
  function matchup(row) {
    const away = row?.matchup?.away_team, home = row?.matchup?.home_team;
    return away && home ? `${away} @ ${home}` : `Game ${String(row?.game_id || '').slice(-8) || '—'}`;
  }
  function matchupMarks(row) {
    const away = row?.matchup?.away_team, home = row?.matchup?.home_team;
    if (!away && !home) return '';
    return `<span class="pbe2-matchup-logos">${teamImg(away)}${teamImg(home)}</span>`;
  }

  function summary(rows) {
    const all = Array.isArray(rows) ? rows : [];
    const settledRows = all.filter(settled);
    const decisions = settledRows.filter(row => ['win', 'loss'].includes(result(row)));
    const wins = decisions.filter(row => result(row) === 'win').length;
    const losses = decisions.length - wins;
    const pushes = settledRows.filter(row => result(row) === 'push').length;
    const profit = settledRows.reduce((sum, row) => sum + (flatProfit(row) ?? 0), 0);
    const roi = settledRows.length ? profit / settledRows.length * 100 : null;
    const winRate = decisions.length ? wins / decisions.length * 100 : null;
    const clvRows = all.filter(row => typeof row?.grade?.clv_beat === 'boolean');
    const clvBeat = clvRows.length ? clvRows.filter(row => row.grade.clv_beat).length / clvRows.length * 100 : null;
    const briers = all.map(row => num(row?.grade?.brier)).filter(value => value !== null);
    const brier = briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null;

    let running = 0, peak = 0, maxDrawdown = 0, currentDrawdown = 0;
    const chronological = settledRows.slice().reverse();
    const curve = chronological.map(row => {
      running += flatProfit(row) ?? 0;
      peak = Math.max(peak, running);
      currentDrawdown = running - peak;
      maxDrawdown = Math.min(maxDrawdown, currentDrawdown);
      return { row, equity: running, drawdown: currentDrawdown };
    });

    return { all, settledRows, decisions, wins, losses, pushes, profit, roi, winRate, clvRows, clvBeat, brier, curve, maxDrawdown };
  }

  function switcher(active) {
    return `<div class="pbe2-view-switch">
      <button type="button" class="${active === 'pbepicks' ? 'active' : ''}" data-pbe2-route="pbepicks">PBE Picks</button>
      <button type="button" class="${active === 'trackrecord' ? 'active' : ''}" data-pbe2-route="trackrecord">Track Record</button>
    </div>`;
  }
  function topline(active, data) {
    const gated = data?.champion_trained !== true;
    const degraded = healthOf(data) !== 'HEALTHY';
    const mode = degraded ? 'Engine degraded' : gated ? 'Validation mode' : 'Production champion';
    const scope = active === 'trackrecord' ? 'official publication only' : gated ? 'Pro validation signals' : 'official picks';
    return `<div class="pbe2-topline"><div class="pbe2-eyebrow"><i class="pbe2-live-dot ${degraded ? 'degraded' : gated ? 'gated' : ''}"></i>${mode} · v${esc(data?.champion_version ?? '—')} · ${scope}</div>${switcher(active)}</div>`;
  }

  /* ---- engine runtime (durable run ledger) ---------------------------- */
  const LANE_ORDER = ['nfl-game-picks-orchestrator', 'nfl-odds-snapshot', 'nfl-game-grader', 'nfl-weight-tuner'];
  function healthOf(data) { return String(data?.engine_health || 'UNKNOWN').toUpperCase(); }
  function lane(data, key) { return data?.engine_runtime?.lanes?.[key] || null; }
  function ago(value) {
    const t = Date.parse(value || ''); if (!Number.isFinite(t)) return 'never';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 129600) return `${(s / 3600).toFixed(1)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function laneStateLabel(state) {
    return ({ HEALTHY: 'Healthy', DEGRADED: 'Degraded', STALE: 'Stale', UNKNOWN: 'No run recorded' }[state] || state || '—');
  }
  function lanes(data) {
    const all = data?.engine_runtime?.lanes || {};
    return LANE_ORDER.map(key => all[key]).filter(Boolean);
  }
  function degradedBanner(data) {
    const bad = lanes(data).filter(l => l.critical !== false && l.state !== 'HEALTHY');
    const reason = data?.engine_runtime?.unavailable_reason;
    return `<section class="pbe2-degraded"><span>ENGINE DEGRADED</span><h2>The Picks Engine is not running normally</h2><p>This state comes from the engine's own persisted run records, not from this page. Nothing below should be read as a live evaluation until every critical lane reports healthy.</p><ul>${bad.length ? bad.map(l => `<li><b>${esc(l.label || l.lane)}</b> — ${esc(laneStateLabel(l.state))}${l.reason ? ` · ${esc(l.reason)}` : ''} · last run ${esc(ago(l.last_tick_at))}</li>`).join('') : `<li>${esc(reason || 'Run ledger unavailable')}</li>`}</ul></section>`;
  }
  function engineProgress(data) {
    const d = data?.decisions || {};
    const tr = d.tracking || {};
    const orch = lane(data, 'nfl-game-picks-orchestrator');
    const detail = orch?.detail || {};
    const c = orch?.counts || {};
    /* nflverse codes the Rams LA; the rest of the product says LAR. */
    const next = detail.next_game
      ? `${String(detail.next_game.matchup).replace(/\bLA\b/, 'LAR')} · ${dateTime(detail.next_game.kickoff_ts)}`
      : data?.current?.next_game ? `${data.current.next_game.name} · ${dateTime(data.current.next_game.kickoff)}` : '—';
    const evaluated = orch?.last_work_at
      ? `${ago(orch.last_work_at)} · ${num(c.evaluated_games) ?? 0} game${num(c.evaluated_games) === 1 ? '' : 's'} evaluated`
      : 'No evaluation recorded';
    const outcome = orch?.last_work_at
      ? `${num(c.emitted) ?? 0} new · ${num(c.kept) ?? 0} held · ${num(c.pass) ?? 0} passed · ${num(c.killed) ?? 0} killed`
      : '';
    const final = data?.current?.latest_final;
    const tiles = [
      ['Tracking decisions', `${num(tr.total) ?? 0}`, `${num(tr.open) ?? 0} open · ${num(tr.graded) ?? 0} graded · ${num(tr.superseded) ?? 0} superseded`],
      ['Finalized', `${num(data?.graded_sample) ?? 0}`, `of ${num(data?.graded_sample_required) ?? 100} needed · ${num(data?.distinct_weeks) ?? 0}/${num(data?.distinct_weeks_required) ?? 4} weeks`],
      ['Last engine evaluation', evaluated, outcome],
      ['Next eligible game', next, final ? `Latest final: ${final.away} ${final.away_score}–${final.home_score} ${final.home}` : ''],
    ];
    /* A weekly, non-critical lane that has not reached its first run is waiting,
     * not failing. It never makes the engine read as degraded. */
    const laneRows = lanes(data).map(l => {
      const waiting = l.critical === false && l.state === 'UNKNOWN';
      const state = waiting ? 'WAITING' : l.state;
      const line = waiting ? 'Weekly · first run pending' : `${laneStateLabel(l.state)} · last run ${ago(l.last_tick_at)}`;
      return `<div class="pbe2-lane" data-state="${esc(state)}"><i></i><div><strong>${esc(l.label || l.lane)}</strong><span>${esc(line)}</span></div></div>`;
    }).join('');
    return `<section class="pbe2-engine" aria-label="Picks Engine live progress"><div class="pbe2-engine-head"><span>Live engine · ${esc(data?.current?.season ?? d.season ?? '')} ${esc(data?.current?.season_type || '')} week ${esc(data?.current?.week ?? '—')}</span><b data-state="${esc(healthOf(data))}">${esc(laneStateLabel(healthOf(data)))}</b></div><div class="pbe2-engine-grid">${tiles.map(([label, value, sub]) => `<div class="pbe2-engine-tile"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`).join('')}</div><div class="pbe2-lanes">${laneRows || '<div class="pbe2-lane" data-state="UNKNOWN"><i></i><div><strong>Run ledger</strong><span>unavailable</span></div></div>'}</div><p class="pbe2-engine-note">Tracking decisions are real pregame decisions, frozen before kickoff and graded from the official final. NFL Pro sees the current ones as PBE Validation Signals. They are never official picks and never enter the Official Track Record.</p></section>`;
  }

  function validation(data) {
    const grades = Number(data?.graded_sample || 0), gradeReq = Number(data?.graded_sample_required || 100);
    const weeks = Number(data?.distinct_weeks || 0), weekReq = Number(data?.distinct_weeks_required || 4);
    const gradePct = gradeReq ? clamp(grades / gradeReq * 100, 0, 100) : 0;
    const weekPct = weekReq ? clamp(weeks / weekReq * 100, 0, 100) : 0;
    return `<section class="pbe2-stage gated"><div class="pbe2-gridwash"></div><div class="pbe2-validation">
      <div><div class="pbe2-kicker">PBE Picks Engine</div><h1>Earn the edge.<br><em>Then publish it.</em></h1><p class="pbe2-validation-copy">The production model is evaluating real NFL slates in bootstrap tracking mode. NFL Pro members see those decisions live as PBE Validation Signals. They build the learning sample, but they are not official picks and can never be retroactively converted into the Official Track Record.</p><div class="pbe2-validation-proof"><span>100 finalized decisions</span><span>4 distinct weeks</span><span>champion-only publication</span><span>no backfilled picks</span></div></div>
      <div class="pbe2-gates"><div class="pbe2-ring" style="--p:${gradePct.toFixed(1)}"><div><strong>${grades}</strong><span>of ${gradeReq} grades</span></div></div><div class="pbe2-ring" style="--p:${weekPct.toFixed(1)}"><div><strong>${weeks}</strong><span>of ${weekReq} weeks</span></div></div><div class="pbe2-gate-caption">Official publication remains closed until both gates are satisfied and a trained champion is promoted.</div></div>
    </div></section>${engineProgress(data)}<div class="pbe2-pipeline"><div class="${healthOf(data) === 'HEALTHY' ? 'active' : ''}"><span>01</span><strong>Track live</strong></div><div class="${grades > 0 ? 'active' : ''}"><span>02</span><strong>Grade final</strong></div><div><span>03</span><strong>Validate</strong></div><div><span>04</span><strong>Publish</strong></div></div>`;
  }

  /* The card first (pbe-card-v3.js owns it and its entitlement), then the
   * engine behind it. Health comes first in the deep dive: a degraded engine
   * is never presented as a healthy validation page. */
  function paintPicks() {
    const vc = document.getElementById('view-container'); if (!vc || window.App?.current !== 'pbepicks') return;
    const governance = state.governance;
    const card = window.PBECard ? window.PBECard.flagshipHtml() : '';
    const deep = !governance ? ''
      : `<div class="pbe2-deep-head"><span>The engine behind the card</span><small>Publication gate, finalized sample and live run ledger</small></div>${healthOf(governance) !== 'HEALTHY' ? degradedBanner(governance) : ''}${governance.champion_trained !== true ? validation(governance) : engineProgress(governance)}`;
    const html = `<section class="pbe2-wrap">${topline('pbepicks', governance || {})}${card}${deep}</section>`;
    if (vc.dataset.pbe2Sig === html) return;
    const open = vc.querySelector('.pbec-history')?.open;
    vc.innerHTML = html; vc.dataset.pbe2Sig = html;
    if (open) vc.querySelector('.pbec-history')?.setAttribute('open', '');
    wire();
  }

  async function renderPicks() {
    const vc = document.getElementById('view-container'); if (!vc) return;
    const run = ++state.loadId;
    vc.dataset.pbe2Sig = '';
    vc.innerHTML = '<section class="pbe2-wrap"><div class="pbe2-loading"><div class="pbe2-loading-mark"></div><strong>Loading today&#39;s PBE card</strong><span>Current decisions and publication state</span></div></section>';
    try {
      const [governance] = await Promise.all([json(`${API}?view=state`), window.PBECard?.ensure?.()]);
      if (run !== state.loadId || window.App?.current !== 'pbepicks') return;
      state.governance = governance;
      state.current = window.PBECard?.store?.data || null;
      paintPicks();
    } catch (error) {
      if (run !== state.loadId || window.App?.current !== 'pbepicks') return;
      vc.innerHTML = '<section class="pbe2-wrap"><section class="pbe2-error"><span>SOURCE</span><h2>Picks Engine unavailable</h2><p>The page will not turn a backend failure into a fake empty slate.</p><button type="button" class="pbe2-btn" data-pbe2-retry-picks>Retry</button></section></section>';
      wire();
    }
  }
  window.addEventListener('pbe:card-ready', () => {
    state.current = window.PBECard?.store?.data || null;
    if (window.App?.current === 'pbepicks' && state.governance) paintPicks();
  });

  function filterOptions(rows, key) {
    return [...new Set(rows.map(row => String(row?.[key] ?? '')).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  }
  function filteredRows(rows) {
    const f = state.trackFilter;
    return rows.filter(row => {
      if (f.market !== 'all' && row.market !== f.market) return false;
      if (f.model !== 'all' && String(row.model_version) !== f.model) return false;
      if (f.confidence !== 'all' && String(row.confidence_bucket || '').toUpperCase() !== f.confidence) return false;
      if (f.week !== 'all' && String(row.week) !== f.week) return false;
      if (f.weather !== 'all' && String(row?.context?.weather || 'standard').toLowerCase() !== f.weather) return false;
      if (f.division !== 'all' && String(Boolean(row?.context?.divisional)) !== String(f.division === 'yes')) return false;
      if (f.timing !== 'all' && String(row?.context?.timing || '') !== f.timing) return false;
      if (f.result !== 'all' && result(row) !== f.result) return false;
      return true;
    });
  }
  function select(name, label, values, current, formatter = value => value) {
    return `<label><span>${esc(label)}</span><select data-pbe2-filter="${esc(name)}"><option value="all">All</option>${values.map(value => `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(formatter(value))}</option>`).join('')}</select></label>`;
  }
  function filterBar(allRows, filtered) {
    const models = filterOptions(allRows, 'model_version');
    const weeks = filterOptions(allRows, 'week');
    const confidence = [...new Set(allRows.map(row => String(row.confidence_bucket || '').toUpperCase()).filter(Boolean))].sort();
    const style = `<style>.pbe2-filterbar{display:flex;flex-wrap:wrap;gap:7px;align-items:end;margin:12px 0}.pbe2-filterbar label{display:flex;flex-direction:column;gap:4px}.pbe2-filterbar label>span{font-size:10px;font-weight:900;letter-spacing:.8px;color:rgba(255,255,255,.25);text-transform:uppercase}.pbe2-filterbar select{height:34px;min-width:96px;padding:0 25px 0 9px;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:#071019;color:rgba(255,255,255,.67);font-size:11px;font-weight:800;outline:none}.pbe2-filter-count{margin-left:auto;padding-bottom:8px;font-size:11px;color:rgba(255,255,255,.32)}@media(max-width:760px){.pbe2-filter-count{width:100%;margin:0}}</style>`;
    return `${style}<div class="pbe2-filterbar">${select('market','Market',['spread','moneyline','total'],state.trackFilter.market,marketLabel)}${select('model','Model',models,state.trackFilter.model,value => `v${value}`)}${select('confidence','Confidence',confidence,state.trackFilter.confidence)}${select('week','Week',weeks,state.trackFilter.week,value => `Week ${value}`)}${select('weather','Weather',['standard','dome','wind','cold'],state.trackFilter.weather,value => ({standard:'Standard',dome:'Dome',wind:'Wind 15+',cold:'Cold 25-'}[value]))}${select('division','Divisional',['yes','no'],state.trackFilter.division,value => value === 'yes' ? 'Divisional' : 'Non-divisional')}${select('timing','Issued',['lt24','24to72','gt72'],state.trackFilter.timing,value => ({lt24:'<24h to kick','24to72':'24–72h','gt72':'72h+'}[value]))}${select('result','Result',['win','loss','push'],state.trackFilter.result,value => value.toUpperCase())}<div class="pbe2-filter-count">${filtered.length} of ${allRows.length} official decisions</div></div>`;
  }

  function zeroTrack(data) {
    return `${topline('trackrecord', data)}<section class="pbe2-stage"><div class="pbe2-gridwash"></div><div class="pbe2-track-zero"><div><div class="pbe2-kicker">Verified Live Track Record</div><h1>Start at zero.<br>Publish everything.</h1><div class="record">0<span>–0</span></div><p>No official customer-facing pick has reached the verified ledger yet. Bootstrap tracking decisions are intentionally excluded. When the first official pick is issued, its timestamp and immutable economics receive a chained SHA-256 receipt before any result exists.</p></div><aside class="pbe2-zero-card"><span>Verification layer</span><strong>Receipt ledger armed</strong><small>Each future issuance is hashed from the frozen decision payload and linked to the prior receipt. This is internal tamper evidence — not an independent third-party notarization.</small></aside></div></section>`;
  }

  function trackHero(rows, data) {
    const s = summary(rows);
    const roiClass = s.roi === null ? 'neutral' : s.roi > 0 ? '' : s.roi < 0 ? 'negative' : 'neutral';
    return `${topline('trackrecord', data)}<section class="pbe2-stage"><div class="pbe2-gridwash"></div><div class="pbe2-track-hero"><div><div class="pbe2-track-main-label">Verified live performance · actual issue prices</div><div class="pbe2-track-roi ${roiClass}">${s.roi === null ? '—' : `${s.roi > 0 ? '+' : ''}${s.roi.toFixed(1)}%`}</div><div class="pbe2-track-sub">ROI is flat 1u using the immutable issue price — not closing odds, not a best-number reconstruction. Losses remain in the ledger.</div></div><div class="pbe2-track-kpis"><div class="pbe2-kpi"><span>W-L-P</span><strong>${s.wins}-${s.losses}-${s.pushes}</strong></div><div class="pbe2-kpi ${s.profit > 0 ? 'good' : s.profit < 0 ? 'bad' : ''}"><span>Flat 1u profit</span><strong>${s.settledRows.length ? `${s.profit > 0 ? '+' : ''}${s.profit.toFixed(2)}u` : '—'}</strong></div><div class="pbe2-kpi"><span>CLV beat</span><strong>${s.clvBeat === null ? '—' : `${s.clvBeat.toFixed(1)}%`}</strong></div><div class="pbe2-kpi ${s.maxDrawdown < 0 ? 'bad' : ''}"><span>Max drawdown</span><strong>${s.curve.length ? `${s.maxDrawdown.toFixed(2)}u` : '—'}</strong></div></div></div></section>`;
  }

  function rollingRoi(curve, windowSize = 10) {
    return curve.map((point, index) => {
      const start = Math.max(0, index - windowSize + 1);
      const rows = curve.slice(start, index + 1).map(x => x.row);
      const profit = rows.reduce((sum, row) => sum + (flatProfit(row) ?? 0), 0);
      return { row: point.row, value: rows.length ? profit / rows.length * 100 : 0 };
    });
  }
  function chartPoints(values) {
    if (values.length < 2) return null;
    const nums = values.map(x => x.value);
    const min = Math.min(0, ...nums), max = Math.max(0, ...nums), span = Math.max(1e-6, max - min);
    const points = values.map((item, index) => ({ x: index / (values.length - 1) * 100, y: 92 - ((item.value - min) / span) * 78, value: item.value }));
    return { points, min, max, zeroY: 92 - ((0 - min) / span) * 78 };
  }
  function performanceChart(rows) {
    const s = summary(rows);
    let values = [];
    if (state.chartMode === 'equity') values = s.curve.map(x => ({ row: x.row, value: x.equity }));
    if (state.chartMode === 'drawdown') values = s.curve.map(x => ({ row: x.row, value: x.drawdown }));
    if (state.chartMode === 'rolling') values = rollingRoi(s.curve);
    const chart = chartPoints(values);
    const unit = state.chartMode === 'rolling' ? '%' : 'u';
    const title = state.chartMode === 'equity' ? 'Cumulative profit' : state.chartMode === 'drawdown' ? 'Drawdown curve' : 'Rolling 10-pick ROI';
    const final = values.length ? values[values.length - 1].value : null;
    const buttons = [['equity','Equity'],['drawdown','Drawdown'],['rolling','Rolling ROI']].map(([id,label]) => `<button type="button" class="pbe2-filter ${state.chartMode === id ? 'active' : ''}" data-pbe2-chart="${id}">${label}</button>`).join('');
    if (!chart) return `<section class="pbe2-panel"><div class="pbe2-panel-head"><div><span>Risk & return</span><strong>${title}</strong></div><div class="pbe2-filters">${buttons}</div></div><div class="pbe2-equity" style="display:grid;place-items:center;color:rgba(255,255,255,.3);font-size:12px">Two settled official picks are required to draw the curve.</div></section>`;
    const d = chart.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
    const negative = state.chartMode === 'drawdown' || (final ?? 0) < 0;
    return `<section class="pbe2-panel"><div class="pbe2-panel-head"><div><span>Risk & return</span><strong>${title}</strong></div><div class="pbe2-filters">${buttons}</div></div><div class="pbe2-equity"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(title)}"><line x1="0" x2="100" y1="${chart.zeroY.toFixed(2)}" y2="${chart.zeroY.toFixed(2)}" class="zero"></line><path d="${d}" class="line ${negative ? 'negative' : ''}"></path></svg><div class="pbe2-equity-labels"><span>${date(values[0].row.kickoff_ts)}</span><span>${final === null ? '—' : `${final > 0 ? '+' : ''}${final.toFixed(2)}${unit}`}</span><span>${date(values[values.length - 1].row.kickoff_ts)}</span></div></div></section>`;
  }

  function outcomeTape(rows) {
    const decisions = rows.filter(row => ['win','loss','push'].includes(result(row))).slice(0, 30).reverse();
    return `<section class="pbe2-panel"><div class="pbe2-panel-head"><div><span>Outcome tape</span><strong>Latest official results</strong></div></div><div class="pbe2-tape">${decisions.length ? decisions.map(row => `<span class="${result(row)}" title="${esc(selection(row))} · ${esc(date(row.kickoff_ts))}">${result(row) === 'win' ? 'W' : result(row) === 'loss' ? 'L' : 'P'}</span>`).join('') : '<span>—</span>'}</div><div class="pbe2-tape-note">Visual sequence only. Profit and ROI continue to use the actual issued American price on each decision.</div></section>`;
  }

  function marketPanel(rows) {
    const markets = ['spread','moneyline','total'];
    return `<section class="pbe2-panel"><div class="pbe2-panel-head"><div><span>Where the edge lives</span><strong>Market breakdown</strong></div></div><div class="pbe2-market-list">${markets.map(market => {
      const s = summary(rows.filter(row => row.market === market));
      const roi = s.roi;
      const width = roi === null ? 0 : clamp(Math.abs(roi), 0, 40) / 40 * 100;
      const cls = roi === null ? '' : roi >= 0 ? 'good' : 'bad';
      return `<div class="pbe2-market-row"><div><strong>${esc(marketLabel(market))}</strong><small>${s.wins}-${s.losses}-${s.pushes} · ${s.settledRows.length} settled</small></div><div class="pbe2-market-bar"><span class="${cls === 'bad' ? 'bad' : ''}" style="width:${width.toFixed(1)}%"></span></div><b class="${cls}">${roi === null ? '—' : `${roi > 0 ? '+' : ''}${roi.toFixed(1)}%`}</b></div>`;
    }).join('')}</div></section>`;
  }

  function benchmark(data, rows) {
    const s = summary(rows);
    const bt = data?.champion_backtest || {};
    const cells = [
      ['CLV beat', s.clvBeat === null ? '—' : `${s.clvBeat.toFixed(1)}%`, num(bt.clv_beat_pct) === null ? 'not published' : `${num(bt.clv_beat_pct).toFixed(1)}%`],
      ['Brier', s.brier === null ? '—' : s.brier.toFixed(4), num(bt.brier) === null ? 'not published' : num(bt.brier).toFixed(4)],
      ['Profit', s.settledRows.length ? `${s.profit > 0 ? '+' : ''}${s.profit.toFixed(2)}u` : '—', num(bt.units) === null ? 'not published' : `${num(bt.units) > 0 ? '+' : ''}${num(bt.units).toFixed(2)}u`],
    ];
    return `<section class="pbe2-panel"><div class="pbe2-panel-head"><div><span>Champion v${esc(data?.champion_version ?? '—')}</span><strong>Live vs backtest reference</strong></div></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px">${cells.map(([label, live, backtest]) => `<div style="padding:12px;background:rgba(255,255,255,.025);border-radius:8px"><span style="display:block;font-size:11px;font-weight:900;letter-spacing:.8px;color:rgba(255,255,255,.27)">${esc(label.toUpperCase())}</span><strong style="display:block;font-family:var(--font-d);font-size:21px;margin-top:5px">${esc(live)}</strong><small style="display:block;margin-top:4px;font-size:11px;color:rgba(255,255,255,.25)">backtest: ${esc(backtest)}</small></div>`).join('')}</div><div class="pbe2-tape-note">Backtest figures are reference diagnostics, not a promise of live performance and not normalized to the live sample unless explicitly stated.</div></section>`;
  }

  function receiptShort(row) {
    const hash = row?.receipt?.chain_hash;
    return hash ? `${hash.slice(0, 10)}…` : '—';
  }
  function spark(row) {
    const path = Array.isArray(row?.market_path) ? row.market_path : [];
    const raw = path.map(point => num(point.line) ?? num(point.price)).filter(value => value !== null);
    if (raw.length < 2) {
      const cp = num(row?.grade?.clv_points);
      return cp === null ? '—' : `<strong style="color:${cp >= 0 ? '#55d68c' : '#f16b78'}">${cp > 0 ? '+' : ''}${cp.toFixed(2)}</strong>`;
    }
    const min = Math.min(...raw), max = Math.max(...raw), span = Math.max(1e-6, max - min);
    const pts = raw.map((value, i) => `${(i/(raw.length-1)*70).toFixed(1)},${(20-((value-min)/span)*16).toFixed(1)}`).join(' ');
    return `<svg width="74" height="24" viewBox="0 0 74 24" aria-label="Issue-to-close market path"><polyline points="${pts}" fill="none" stroke="${row?.grade?.clv_beat ? '#55d68c' : '#f16b78'}" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline></svg>`;
  }
  function detail(row) {
    const path = Array.isArray(row.market_path) ? row.market_path : [];
    const first = path[0], close = path[path.length - 1];
    const receipt = row.receipt;
    return `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:14px;background:rgba(255,255,255,.018);border-top:1px solid rgba(255,255,255,.045)"><div><span style="font-size:11px;color:rgba(255,255,255,.25)">ISSUE</span><strong style="display:block;margin-top:4px">${line(row.market_line)} · ${american(row.market_price)}</strong><small style="color:rgba(255,255,255,.28)">${esc(dateTime(row.created_at))}</small></div><div><span style="font-size:11px;color:rgba(255,255,255,.25)">CLOSE</span><strong style="display:block;margin-top:4px">${close ? `${line(close.line)} · ${american(close.price)}` : 'unavailable'}</strong><small style="color:rgba(255,255,255,.28)">${close ? esc(dateTime(close.captured_at)) : 'No factual close captured'}</small></div><div><span style="font-size:11px;color:rgba(255,255,255,.25)">CONTEXT</span><strong style="display:block;margin-top:4px">${esc(String(row?.context?.weather || 'standard').toUpperCase())}${row?.context?.divisional ? ' · DIVISION' : ''}</strong><small style="color:rgba(255,255,255,.28)">${esc(row?.context?.timing_label || 'issuance timing unavailable')}</small></div><div><span style="font-size:11px;color:rgba(255,255,255,.25)">SHA-256 RECEIPT</span><strong style="display:block;margin-top:4px;font-size:12px;word-break:break-all">${esc(receipt?.chain_hash || 'pending')}</strong><small style="color:rgba(255,255,255,.28)">${receipt ? `seq ${esc(receipt.seq)} · ${esc(receipt.receipt_version)}` : 'Internal chained receipt not available for this row'}</small></div></div>`;
  }

  function history(allRows, rows) {
    const tableRows = rows.slice(0, 250).map(row => {
      const profit = flatProfit(row), r = result(row), expanded = state.expanded === row.id;
      return `<tr data-pbe2-expand="${esc(row.id)}" style="cursor:pointer"><td>${esc(date(row.kickoff_ts))}<small>W${esc(row.week ?? '—')}</small></td><td><strong>${esc(selection(row))}</strong><small>${esc(matchup(row))}</small></td><td>${esc(marketLabel(row.market))}</td><td>v${esc(row.model_version ?? '—')}</td><td>${american(row.market_price)}</td><td>${spark(row)}</td><td class="${profit > 0 ? 'good' : profit < 0 ? 'bad' : ''}">${profit === null ? '—' : `${profit > 0 ? '+' : ''}${profit.toFixed(2)}u`}</td><td><button type="button" class="pbe2-filter" data-pbe2-copy="${esc(row?.receipt?.chain_hash || '')}" title="Internal SHA-256 chained receipt; not third-party notarization">${esc(receiptShort(row))}</button></td><td><span class="pbe2-result ${esc(r)}">${esc(r.toUpperCase())}</span></td></tr>${expanded ? `<tr><td colspan="9" style="padding:0">${detail(row)}</td></tr>` : ''}`;
    }).join('');
    return `<section class="pbe2-history"><div class="pbe2-history-head"><div><span>Immutable decision ledger</span><strong>Official pick history</strong></div><small style="font-size:11px;color:rgba(255,255,255,.25)">Click a row for issue → close + receipt detail</small></div>${filterBar(allRows, rows)}<div class="pbe2-table-wrap"><table><thead><tr><th>Date</th><th>Selection</th><th>Market</th><th>Model</th><th>Odds</th><th>CLV path</th><th>Flat 1u</th><th>Receipt</th><th>Result</th></tr></thead><tbody>${tableRows || '<tr><td colspan="9" style="text-align:center;padding:36px;color:rgba(255,255,255,.3)">No official decisions match these filters.</td></tr>'}</tbody></table></div><div class="pbe2-history-foot">SHA-256 receipts are internal tamper-evident attestations of the issuance payload. They are not represented as independent third-party verification.</div></section>`;
  }

  function trackLive(data) {
    const allRows = Array.isArray(data?.picks) ? data.picks : [];
    if (!allRows.length) return zeroTrack(data);
    const rows = filteredRows(allRows);
    return `${trackHero(rows, data)}<div class="pbe2-performance-grid">${performanceChart(rows)}${outcomeTape(rows)}</div><div class="pbe2-performance-grid">${marketPanel(rows)}${benchmark(data, rows)}</div>${history(allRows, rows)}`;
  }

  async function renderTrack() {
    const vc = document.getElementById('view-container'); if (!vc) return;
    const run = ++state.loadId;
    vc.innerHTML = '<section class="pbe2-wrap"><div class="pbe2-loading"><div class="pbe2-loading-mark"></div><strong>Loading Verified Track Record</strong><span>Official publication scope only</span></div></section>';
    try {
      const data = await json(`${API}?view=trackrecord`);
      if (run !== state.loadId || window.App?.current !== 'trackrecord') return;
      state.track = data;
      vc.innerHTML = `<section class="pbe2-wrap">${trackLive(data)}</section>`;
      wire();
    } catch (_) {
      if (run !== state.loadId || window.App?.current !== 'trackrecord') return;
      vc.innerHTML = '<section class="pbe2-wrap"><section class="pbe2-error"><span>VERIFIED RECORD</span><h2>Track Record source unavailable</h2><p>The page will not substitute backtests, bootstrap tracking decisions or marketing claims for the official live record.</p><button type="button" class="pbe2-btn" data-pbe2-retry-track>Retry</button></section></section>';
      wire();
    }
  }

  function rerenderTrackLocal() {
    if (!state.track || window.App?.current !== 'trackrecord') return;
    const vc = document.getElementById('view-container'); if (!vc) return;
    vc.innerHTML = `<section class="pbe2-wrap">${trackLive(state.track)}</section>`;
    wire();
  }

  function wire() {
    document.querySelectorAll('[data-pbe2-route]').forEach(button => button.addEventListener('click', () => {
      const route = button.dataset.pbe2Route;
      if (route) window.App?.nav(route);
    }));
    document.querySelectorAll('[data-pbe2-upgrade]').forEach(button => button.addEventListener('click', () => {
      if (window.PBEPro?.open) window.PBEPro.open('upgrade');
      else document.getElementById('pbe-pro-account')?.click();
    }));
    document.querySelectorAll('[data-pbe2-retry-picks]').forEach(button => button.addEventListener('click', renderPicks));
    document.querySelectorAll('[data-pbe2-retry-track]').forEach(button => button.addEventListener('click', renderTrack));
    document.querySelectorAll('[data-pbe2-chart]').forEach(button => button.addEventListener('click', () => { state.chartMode = button.dataset.pbe2Chart || 'equity'; rerenderTrackLocal(); }));
    document.querySelectorAll('[data-pbe2-filter]').forEach(selectEl => selectEl.addEventListener('change', () => { state.trackFilter[selectEl.dataset.pbe2Filter] = selectEl.value; state.expanded = null; rerenderTrackLocal(); }));
    document.querySelectorAll('[data-pbe2-expand]').forEach(row => row.addEventListener('click', event => {
      if (event.target.closest('[data-pbe2-copy]')) return;
      const id = row.dataset.pbe2Expand; state.expanded = state.expanded === id ? null : id; rerenderTrackLocal();
    }));
    document.querySelectorAll('[data-pbe2-copy]').forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      const hash = button.dataset.pbe2Copy; if (!hash) return;
      try { await navigator.clipboard.writeText(hash); button.textContent = 'COPIED'; setTimeout(() => { button.textContent = `${hash.slice(0, 10)}…`; }, 900); } catch (_) {}
    }));
  }

  function createNav(route, label, badge, icon, badgeClass) {
    const a = document.createElement('a'); a.className = 'nav-item'; a.id = `nav-${route}`; a.href = 'javascript:void(0)';
    a.innerHTML = `<span class="ni-icon">${icon}</span> ${label} <span class="nav-badge ${badgeClass}">${badge}</span>`;
    a.addEventListener('click', () => window.App?.nav(route)); return a;
  }
  function installNav() {
    const group = document.getElementById('intelligence-nav-group'), modelLab = document.getElementById('nav-picks');
    if (group && modelLab && !document.getElementById('nav-pbepicks')) {
      group.insertBefore(createNav('pbepicks', 'PBE Picks', 'PRO', '&#9733;', 'pbe2-nav-pro'), modelLab);
      group.insertBefore(createNav('trackrecord', 'Track Record', 'VERIFIED', '&#10003;', 'pbe2-nav-verified'), modelLab);
    }
    const primary = document.querySelector('#pbe-sports-shell .pbes-primary'), shellModel = primary?.querySelector('[data-route="picks"]');
    if (primary && shellModel && !primary.querySelector('[data-route="pbepicks"]')) {
      for (const [route, label] of [['pbepicks','PBE Picks'],['trackrecord','Track Record']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pbes-nav-btn pbe2-shell-nav'; button.dataset.route = route; button.textContent = label;
        button.addEventListener('click', () => window.PBESportsShell?.go ? window.PBESportsShell.go(route) : window.App?.nav(route));
        primary.insertBefore(button, shellModel);
      }
    }
    const mobile = document.getElementById('mbn-matchups');
    if (mobile && mobile.dataset.pbePicksNav !== '2') {
      mobile.dataset.pbePicksNav = '2'; mobile.id = 'mbn-pbepicks'; mobile.removeAttribute('onclick');
      mobile.innerHTML = '<div class="mbn-icon">&#9733;</div><span>Picks</span>';
      mobile.addEventListener('click', () => { window.App?.nav('pbepicks'); window.pbeMbnActive?.('pbepicks'); });
    }
    syncNav(window.App?.current || 'home');
  }
  function syncNav(route) {
    document.querySelectorAll('[data-route="pbepicks"],[data-route="trackrecord"]').forEach(el => el.classList.toggle('active', el.dataset.route === route));
  }
  function installViews() {
    if (!window.App?.VIEWS) return false;
    window.App.VIEWS.pbepicks = renderPicks;
    window.App.VIEWS.trackrecord = renderTrack;
    return true;
  }
  function init() {
    installViews(); installNav();
    [120, 420, 1100].forEach(delay => setTimeout(() => { installViews(); installNav(); }, delay));
  }

  window.PBEPicksV2 = { version: 2, renderPicks, renderTrackRecord: renderTrack, state, installNav, engineProgress, degradedBanner };
  init();
  document.addEventListener('DOMContentLoaded', init, { once: true });
  window.addEventListener('pbe:upgrades-ready', init);
  window.addEventListener('pbe:route-changed', event => { installNav(); syncNav(event.detail?.route || window.App?.current || ''); });
  /* pbe-card-v3 re-reads on a Pro state change and emits pbe:card-ready. */
})();
