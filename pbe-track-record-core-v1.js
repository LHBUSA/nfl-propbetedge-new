/* PropBetEdge NFL — Track Record core (pure accounting, no DOM).
 *
 * One implementation of the numbers both records show, so the Validation
 * Record and the Official Verified Track Record can never disagree about what
 * a win, a unit or an ROI is.
 *
 *   SCOPE     Validation rows are publication_scope = 'tracking'. Official rows
 *             are publication_scope = 'official'. selectScope() is the only way
 *             rows enter a record; a row of the other scope is dropped, never
 *             relabelled. Neither record ever mixes the two.
 *   RESULT    win | loss | push are settled. void (a withdrawn decision graded
 *             for CLV only) and anything ungraded are not settled and never
 *             enter W-L-P, units or ROI.
 *   UNITS     Flat 1u at the persisted issue price (the American odds frozen
 *             at issuance). A win without a persisted price has no profit —
 *             never a default -110 — and makes profit/ROI unavailable ('—').
 *             Losses are always -1u, pushes 0u.
 *   ROI       flat 1u profit / number of settled decisions (win + loss + push),
 *             each risking exactly 1u. Voids and pending decisions are excluded
 *             from numerator and denominator.
 *   WIN RATE  wins / (wins + losses). Pushes are excluded.
 *   AVG ODDS  mean of the settled decisions' decimal issue odds, converted back
 *             to American. Rows without a persisted price are excluded.
 *   CLV       beat rate over settled decisions with a persisted boolean
 *             clv_beat; average CLV is the mean persisted clv_prob (probability
 *             points) over settled decisions that carry one.
 *   BRIER     mean persisted per-decision Brier score over settled decisions.
 *
 * Loaded in the browser as window.PBETrackRecordCore; tests evaluate the same
 * file (tests/pbe-track-record-v3.test.mjs).
 */
(function (root) {
  'use strict';

  const SETTLED = ['win', 'loss', 'push'];
  const MARKETS = ['spread', 'moneyline', 'total'];
  const ROI_DENOMINATOR = 'settled decisions (win + loss + push), 1u each; void and pending excluded';

  const num = value => {
    if (value === null || value === undefined || value === '') return null;
    const x = Number(value);
    return Number.isFinite(x) ? x : null;
  };
  const text = value => (value === null || value === undefined ? '' : String(value));

  function validPrice(price) {
    const p = num(price);
    return p !== null && (p >= 100 || p <= -100) ? p : null;
  }

  /* Flat 1u result at the persisted American issue price. */
  function flatUnits(result, price) {
    if (result === 'loss') return -1;
    if (result === 'push') return 0;
    if (result !== 'win') return null;
    const p = validPrice(price);
    if (p === null) return null;
    return p > 0 ? p / 100 : 100 / Math.abs(p);
  }

  function decimalOdds(price) {
    const p = validPrice(price);
    return p === null ? null : p > 0 ? 1 + p / 100 : 1 + 100 / Math.abs(p);
  }
  function americanFromDecimal(decimal) {
    const d = num(decimal);
    if (d === null || d <= 1) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  }

  function resultOf(grade, status) {
    const r = text(grade?.result).toLowerCase();
    if (r) return r;
    if (text(status).toLowerCase() === 'killed') return 'void';
    return 'pending';
  }

  function base(fields) {
    const result = fields.result;
    return Object.freeze({
      ...fields,
      settled: SETTLED.includes(result),
      flat: flatUnits(result, fields.price),
    });
  }

  /* A row of /api/pbe-picks?view=trackrecord (Official). The endpoint selects
   * publication_scope = official; a row that says otherwise keeps its own scope
   * and is dropped by selectScope. */
  function fromOfficial(row, responseScope) {
    const grade = row?.grade || null;
    const away = row?.matchup?.away_team || null;
    const home = row?.matchup?.home_team || null;
    const ou = text(row?.selection_over_under).toUpperCase();
    const selection = row?.market === 'total'
      ? (ou ? `${ou[0]}${ou.slice(1).toLowerCase()} ${text(row?.market_line)}` : text(row?.side))
      : row?.selection_team
        ? `${row.selection_team}${row.market === 'spread' && num(row.market_line) !== null ? ` ${num(row.market_line) > 0 ? '+' : ''}${num(row.market_line)}` : ''}`
        : text(row?.side);
    return base({
      id: text(row?.id),
      scope: row?.publication_scope || responseScope || null,
      label: 'OFFICIAL PBE PICK',
      season: num(row?.season),
      week: num(row?.week),
      gameId: text(row?.game_id),
      away, home,
      kickoff: row?.kickoff_ts || null,
      issuedAt: row?.created_at || null,
      market: text(row?.market).toLowerCase(),
      selection: selection || '—',
      line: num(row?.market_line),
      price: validPrice(row?.market_price),
      modelProb: num(row?.model_prob),
      edge: num(row?.edge_pct),
      confidence: text(row?.confidence_bucket).toUpperCase() || null,
      modelVersion: num(row?.model_version),
      status: text(row?.status),
      lifecycle: null,
      result: resultOf(grade, row?.status),
      stakeDelta: num(grade?.units_delta),
      stakeUnits: num(row?.stake_units),
      clvBeat: typeof grade?.clv_beat === 'boolean' ? grade.clv_beat : null,
      clvProb: num(grade?.clv_prob),
      clvPoints: num(grade?.clv_points),
      brier: num(grade?.brier),
      gradedAt: grade?.graded_at || null,
      receipt: row?.receipt ? { seq: row.receipt.seq ?? null, hash: row.receipt.chain_hash || null, verified: null } : null,
    });
  }

  /* A card of /api/pbe-picks?view=validation-history (NFL Pro). */
  function fromValidation(card) {
    const grade = card?.grade || null;
    return base({
      id: text(card?.id),
      scope: card?.publication_scope || null,
      label: 'VALIDATION SIGNAL',
      season: num(card?.season),
      week: num(card?.week),
      gameId: text(card?.game_id),
      away: card?.matchup?.away || null,
      home: card?.matchup?.home || null,
      kickoff: card?.kickoff_ts || null,
      issuedAt: card?.issue?.at || card?.receipt?.issued_at || null,
      market: text(card?.market).toLowerCase(),
      selection: text(card?.selection?.display) || '—',
      line: num(card?.issue?.line),
      price: validPrice(card?.issue?.price),
      modelProb: num(card?.model?.prob),
      edge: num(card?.edge_pct),
      confidence: text(card?.confidence_bucket).toUpperCase() || null,
      modelVersion: num(card?.model?.version),
      status: text(card?.status),
      lifecycle: text(card?.lifecycle) || null,
      result: resultOf(grade, card?.status),
      stakeDelta: num(grade?.units_delta),
      stakeUnits: num(card?.stake_units),
      clvBeat: typeof grade?.clv_beat === 'boolean' ? grade.clv_beat : null,
      clvProb: num(grade?.clv_prob),
      clvPoints: num(grade?.clv_points),
      brier: num(grade?.brier),
      gradedAt: grade?.graded_at || null,
      receipt: card?.receipt ? {
        seq: card.receipt.seq ?? null,
        hash: card.receipt.chain_hash || null,
        verified: card.receipt.verified ? Object.values(card.receipt.verified).every(Boolean) : null,
      } : null,
    });
  }

  /* The only door into a record. */
  function selectScope(rows, scope) {
    return (Array.isArray(rows) ? rows : []).filter(row => row && row.scope === scope);
  }

  const byTime = (a, b) => (Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0))
    || (Date.parse(a.issuedAt || 0) - Date.parse(b.issuedAt || 0))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function mean(values) {
    const xs = values.filter(v => v !== null && v !== undefined && Number.isFinite(v));
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  }

  function summarize(rows) {
    const all = Array.isArray(rows) ? rows : [];
    const settled = all.filter(r => r.settled).slice().sort(byTime);
    const wins = settled.filter(r => r.result === 'win').length;
    const losses = settled.filter(r => r.result === 'loss').length;
    const pushes = settled.filter(r => r.result === 'push').length;
    const priced = settled.every(r => r.flat !== null);
    const profit = settled.length && priced ? settled.reduce((s, r) => s + r.flat, 0) : null;
    let running = 0, peak = 0, maxDrawdown = 0;
    const curve = priced ? settled.map(row => {
      running += row.flat; peak = Math.max(peak, running);
      maxDrawdown = Math.min(maxDrawdown, running - peak);
      return { row, equity: running, drawdown: running - peak };
    }) : [];
    const decimals = settled.map(r => decimalOdds(r.price)).filter(v => v !== null);
    const clvRows = settled.filter(r => typeof r.clvBeat === 'boolean');
    const clvProbs = settled.map(r => r.clvProb).filter(v => v !== null);
    const briers = settled.map(r => r.brier).filter(v => v !== null);
    return {
      decisions: all.length,
      settled: settled.length,
      pending: all.filter(r => r.result === 'pending').length,
      voided: all.filter(r => r.result === 'void').length,
      wins, losses, pushes,
      winRate: wins + losses ? wins / (wins + losses) * 100 : null,
      profit,
      roi: profit === null || !settled.length ? null : profit / settled.length * 100,
      roiDenominator: ROI_DENOMINATOR,
      stakeUnits: settled.length && settled.every(r => r.stakeDelta !== null) ? settled.reduce((s, r) => s + r.stakeDelta, 0) : null,
      avgOdds: decimals.length ? americanFromDecimal(mean(decimals)) : null,
      avgOddsSample: decimals.length,
      clvBeatRate: clvRows.length ? clvRows.filter(r => r.clvBeat).length / clvRows.length * 100 : null,
      clvSample: clvRows.length,
      avgClvProb: clvProbs.length ? mean(clvProbs) : null,
      brier: briers.length ? mean(briers) : null,
      brierSample: briers.length,
      maxDrawdown: curve.length ? maxDrawdown : null,
      weeks: [...new Set(settled.filter(r => r.season !== null && r.week !== null).map(r => `${r.season}-${r.week}`))].length,
      curve,
    };
  }

  function rolling(curve, windowSize = 10) {
    return (Array.isArray(curve) ? curve : []).map((point, index) => {
      const slice = curve.slice(Math.max(0, index - windowSize + 1), index + 1);
      const profit = slice.reduce((s, p) => s + p.row.flat, 0);
      return { row: point.row, value: profit / slice.length * 100, units: profit, size: slice.length };
    });
  }

  function groupBy(rows, keyOf, order) {
    const groups = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = keyOf(row);
      if (key === null || key === undefined || key === '') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const keys = order ? order.filter(k => groups.has(k)) : [...groups.keys()].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
    return keys.map(key => ({ key, rows: groups.get(key), summary: summarize(groups.get(key)) }));
  }
  const byMarket = rows => groupBy(rows, r => r.market, MARKETS);
  const byWeek = rows => groupBy(rows, r => (r.season !== null && r.week !== null ? `${r.season}-${String(r.week).padStart(2, '0')}` : null));
  const byConfidence = rows => groupBy(rows, r => r.confidence, ['A', 'B', 'C']);

  /* A filter or breakdown is offered only for a field most rows really carry. */
  function coverage(rows, field) {
    const all = Array.isArray(rows) ? rows : [];
    return all.length ? all.filter(r => r[field] !== null && r[field] !== undefined && r[field] !== '').length / all.length : 0;
  }

  /* Model probability vs realised outcome, settled win/loss only. */
  function calibration(rows, edges = [0, 0.4, 0.5, 0.55, 0.6, 0.7, 1.0001]) {
    const decided = (Array.isArray(rows) ? rows : []).filter(r => (r.result === 'win' || r.result === 'loss') && r.modelProb !== null);
    const bins = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const inBin = decided.filter(r => r.modelProb >= lo && r.modelProb < hi);
      if (!inBin.length) continue;
      bins.push({
        from: lo, to: Math.min(hi, 1), n: inBin.length,
        predicted: mean(inBin.map(r => r.modelProb)) * 100,
        realised: inBin.filter(r => r.result === 'win').length / inBin.length * 100,
      });
    }
    const outcomes = decided.map(r => (r.modelProb - (r.result === 'win' ? 1 : 0)) ** 2);
    return { n: decided.length, bins, brier: outcomes.length ? mean(outcomes) : null };
  }

  const FILTER_KEYS = ['season', 'week', 'market', 'model', 'confidence', 'result'];
  function availableFilters(rows) {
    const all = Array.isArray(rows) ? rows : [];
    const uniq = values => [...new Set(values.filter(v => v !== null && v !== undefined && v !== ''))];
    return {
      season: uniq(all.map(r => r.season)).sort((a, b) => b - a),
      week: uniq(all.map(r => r.week)).sort((a, b) => a - b),
      market: MARKETS.filter(m => all.some(r => r.market === m)),
      model: uniq(all.map(r => r.modelVersion)).sort((a, b) => a - b),
      confidence: coverage(all, 'confidence') >= 0.9 ? ['A', 'B', 'C'].filter(c => all.some(r => r.confidence === c)) : [],
      result: SETTLED.filter(x => all.some(r => r.result === x)).concat(all.some(r => r.result === 'pending') ? ['pending'] : []),
    };
  }
  function applyFilters(rows, filters) {
    const f = filters || {};
    const want = (key, value) => f[key] === undefined || f[key] === null || f[key] === '' || f[key] === 'all' || String(f[key]) === String(value);
    return (Array.isArray(rows) ? rows : []).filter(r => want('season', r.season) && want('week', r.week) && want('market', r.market)
      && want('model', r.modelVersion) && want('confidence', r.confidence) && want('result', r.result));
  }

  const api = Object.freeze({
    SETTLED, MARKETS, ROI_DENOMINATOR, FILTER_KEYS,
    flatUnits, decimalOdds, americanFromDecimal, fromOfficial, fromValidation, selectScope,
    summarize, rolling, byMarket, byWeek, byConfidence, calibration, coverage, availableFilters, applyFilters,
  });
  root.PBETrackRecordCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
