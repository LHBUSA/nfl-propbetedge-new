/**
 * Kalshi Market Intelligence UI — shared, framework-free (contract market-intel/1).
 * CANONICAL SOURCE: propbetedge-workers/workers/propsports-markets/client/kalshi-market-ui.js
 * Products vendor this file unchanged (plus kalshi-market-ui.css) so every sport renders the
 * same component. Outcome semantics come from the API (team / home-draw-away / player / fighter).
 *
 *
 *   kalshiCard(entry, opts)   full live market module (game page, NBACast expanded)
 *   kalshiStrip(entry, opts)  one-line live strip (NBACast)
 *   kalshiLine(entry)         restrained compact line (Today / Games cards)
 *   wireKalshi(root)          impressions, clicks, reduced-motion aware change flashes
 *
 * Truth rules (owner + Kalshi requirement):
 *  - every Kalshi value links back to that market on Kalshi (new tab, rel sponsored); no link, no card;
 *  - bid, ask, last trade and Mid-market are different numbers and are labelled so;
 *  - "Mid-market" is the documented bid/ask midpoint — never a probability or a PBE prediction;
 *  - Kalshi is a prediction market: not a sportsbook, not a PBE model;
 *  - movement and sparklines use stored observations only (each point is a real read; nothing
 *    is interpolated); deltas only between two observed Mid-markets;
 *  - null stays null (absent fields are omitted, never 0); no entry -> nothing rendered;
 *  - freshness: live (<= 2.5 min), delayed (<= 6 min), stale (labelled), withdrawn after 30 min (API).
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const centsLabel = (bp, { fixed = false } = {}) => {
  if (bp === null || bp === undefined) return null
  const c = bp / 100
  return fixed || !Number.isInteger(c) ? `${c.toFixed(1)}¢` : `${c}¢`
}
const signedCents = bp => (bp > 0 ? '+' : bp < 0 ? '−' : '±') + `${Math.abs(bp / 100).toFixed(1)}¢`
const count = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : null)
const safeColor = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null)

export function ageLabel(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return ''
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s ago`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

function freshnessBadge(k) {
  const age = ageLabel(k.age_seconds)
  if (k.state === 'settled') return '<span class="kx__st">Settled</span>'
  if (k.freshness === 'live') return `<span class="kx__st kx__st--live"><span class="kx__pulse" aria-hidden="true"></span>Updated ${esc(age)}</span>`
  if (k.freshness === 'delayed') return `<span class="kx__st kx__st--delayed">Delayed · Updated ${esc(age)}</span>`
  if (k.freshness === 'stale') return `<span class="kx__st kx__st--stale">Stale · Updated ${esc(age)}</span>`
  return ''
}

function link(k, inner, cls, placement, ticker) {
  return `<a class="${cls}" href="${esc(k.market_url)}" target="_blank" rel="noopener noreferrer sponsored" data-kx-click data-kx-ticker="${esc(ticker || k.event_ticker)}" data-kx-placement="${esc(placement)}" data-kx-age="${esc(String(k.age_seconds ?? ''))}">${inner}</a>`
}

// Headline number: Mid-market when the book allows one, otherwise the honest bid / ask pair.
function headline(o) {
  if (o.mid_bp !== null && o.mid_bp !== undefined) return { value: centsLabel(o.mid_bp, { fixed: true }), label: 'Mid-market', bp: o.mid_bp }
  return { value: `${centsLabel(o.best_yes_bid_bp)} / ${centsLabel(o.best_yes_ask_bp)}`, label: 'YES bid / ask', bp: null }
}

/* ── change flashes: compare with the last value this placement rendered ── */
const lastShown = new Map() // `${placement}|${ticker}` -> bp
function direction(placement, ticker, bp) {
  if (bp === null || bp === undefined) return ''
  const key = `${placement}|${ticker}`
  const prev = lastShown.get(key)
  lastShown.set(key, bp)
  if (prev === undefined || prev === bp) return ''
  return bp > prev ? ' is-up' : ' is-down'
}

/* ── sparkline from observed points only ── */
export function sparkline(points, { width = 160, height = 36 } = {}) {
  const pts = (points || []).filter(p => p.mid_bp !== null && p.mid_bp !== undefined && Number.isFinite(Date.parse(p.t)))
  if (pts.length < 2) return ''
  const t0 = Date.parse(pts[0].t)
  const t1 = Date.parse(pts[pts.length - 1].t)
  const span = Math.max(1, t1 - t0)
  const vals = pts.map(p => p.mid_bp)
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (hi - lo < 200) { const mid = (hi + lo) / 2; lo = mid - 100; hi = mid + 100 } // a sub-2¢ range is drawn on a 2¢ scale, never exaggerated
  const pad = 3
  const x = t => pad + ((Date.parse(t) - t0) / span) * (width - 2 * pad)
  const y = v => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad)
  // Step line: the price holds until the next observation (no interpolated slopes).
  let d = `M${x(pts[0].t).toFixed(1)},${y(pts[0].mid_bp).toFixed(1)}`
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t).toFixed(1)} V${y(pts[i].mid_bp).toFixed(1)}`
  const dots = pts.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.mid_bp).toFixed(1)}" r="1.6"/>`).join('')
  const dir = vals[vals.length - 1] > vals[0] ? 'up' : vals[vals.length - 1] < vals[0] ? 'down' : 'flat'
  return `<svg class="kx__spark kx__spark--${dir}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Mid-market across ${pts.length} observed snapshots"><path d="${d}"/>${dots}</svg>`
}

function deltaChip(mv) {
  if (!mv || mv.delta_mid_bp === null || mv.delta_mid_bp === undefined) return ''
  const cls = mv.delta_mid_bp > 0 ? 'up' : mv.delta_mid_bp < 0 ? 'down' : 'flat'
  const text = mv.delta_mid_bp === 0 ? 'Unchanged since first observed' : `${signedCents(mv.delta_mid_bp)} since first observed`
  return `<span class="kx__delta kx__delta--${cls}">${esc(text)}</span>`
}

function sinceNote(mv) {
  const p = (mv?.points || []).find(x => x.mid_bp !== null)
  if (!p) return ''
  const when = new Date(p.t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `<span class="kx__since">Tracking since ${esc(when)} ET</span>`
}

function panel(k, o, { placement, movement, color }) {
  const h = headline(o)
  const dir = direction(placement, o.market_ticker, h.bp)
  const mv = movement?.[o.role] || null
  const spark = mv ? sparkline(mv.points) : ''
  const activity = [
    count(o.volume) && `${count(o.volume)} traded`,
    count(o.open_interest) && `OI ${count(o.open_interest)}`,
    o.spread_bp !== null && o.spread_bp !== undefined && `Spread ${centsLabel(o.spread_bp)}`,
  ].filter(Boolean)
  const c = safeColor(color)
  return `<div class="kx__panel"${c ? ` style="--kx-team:${c}"` : ''}>
    <div class="kx__who"><b>${esc(o.abbr || o.kalshi_name || '')}</b><small>${esc(o.contract || '')} · YES</small></div>
    ${link(k, `<span class="kx__px mono${dir}">${esc(h.value)}</span><span class="kx__pxl">${esc(h.label)}</span>`, 'kx__price', placement, o.market_ticker)}
    <div class="kx__move">${deltaChip(mv)}${spark || sinceNote(mv)}</div>
    <dl class="kx__book mono">
      <div><dt>Bid</dt><dd>${esc(centsLabel(o.best_yes_bid_bp))}</dd></div>
      <div><dt>Ask</dt><dd>${esc(centsLabel(o.best_yes_ask_bp))}</dd></div>
      ${o.last_price_bp !== null && o.last_price_bp !== undefined ? `<div><dt>Last</dt><dd>${esc(centsLabel(o.last_price_bp))}</dd></div>` : ''}
    </dl>
    ${activity.length ? `<p class="kx__act mono">${esc(activity.join(' · '))}</p>` : ''}
  </div>`
}

// Field markets (> 3 outcomes, e.g. F1 race winner): a ranked list, top FIELD_TOP rows; the API
// already filters to displayable contracts and orders them by Mid-market.
const FIELD_TOP = 8
function fieldList(k, outcomes, { placement, movement }) {
  const rows = outcomes.slice(0, FIELD_TOP).map((o, i) => {
    const h = headline(o)
    const dir = direction(placement, o.market_ticker, h.bp)
    const mv = movement?.[o.role] || null
    return `<li class="kx__frow">
      <span class="kx__frank mono">${i + 1}</span>
      <span class="kx__fname"><b>${esc(o.abbr || o.kalshi_name || '')}</b><small class="mono">Bid ${esc(centsLabel(o.best_yes_bid_bp))} · Ask ${esc(centsLabel(o.best_yes_ask_bp))}${o.last_price_bp != null ? ` · Last ${esc(centsLabel(o.last_price_bp))}` : ''}</small></span>
      ${link(k, `<span class="kx__px mono${dir}">${esc(h.value)}</span>`, 'kx__fprice', placement, o.market_ticker)}
      ${mv && mv.delta_mid_bp != null && mv.delta_mid_bp !== 0 ? `<span class="kx__sd kx__sd--${mv.delta_mid_bp > 0 ? 'up' : 'down'}">${mv.delta_mid_bp > 0 ? '↑' : '↓'}${esc(Math.abs(mv.delta_mid_bp / 100).toFixed(1))}¢</span>` : '<span></span>'}
    </li>`
  }).join('')
  const more = outcomes.length > FIELD_TOP ? `<p class="kx__note">${outcomes.length - FIELD_TOP} more traded contracts on Kalshi.</p>` : ''
  return `<ol class="kx__field">${rows}</ol>${more}`
}

function settledPanel(o) {
  const res = o.result === 'yes' ? 'YES' : o.result === 'no' ? 'NO' : null
  if (!res) return ''
  return `<div class="kx__panel kx__panel--settled"><div class="kx__who"><b>${esc(o.abbr || '')}</b><small>${esc(o.contract || '')}</small></div><span class="kx__px mono">Settled ${res}</span></div>`
}

function attrs(entry, k, placement) {
  return `data-kx-impression data-kx-sport="${esc(entry.event?.sport || '')}" data-kx-event="${esc(entry.event?.canonical_event_id || '')}" data-kx-ticker="${esc(k.event_ticker)}" data-kx-placement="${esc(placement)}" data-kx-age="${esc(String(k.age_seconds ?? ''))}"`
}

function usable(entry) {
  const k = entry?.kalshi
  if (!k || !k.market_url || !Array.isArray(k.outcomes) || k.outcomes.length < 2) return null
  if (k.state === 'open' && !k.outcomes.every(o => o.displayable)) return null
  if (k.state !== 'open' && k.state !== 'settled') return null
  return k
}

/**
 * Full module.
 * @param {object|null} entry  board entry or event-detail entry (detail carries `movement`)
 * @param {{placement:string, colors?:Record<string,string>, compact?:boolean}} opts  colors keyed by role (away/home)
 */
export function kalshiCard(entry, { placement, colors = {}, compact = false } = {}) {
  const k = usable(entry)
  if (!k) return ''
  const movement = entry.movement?.kalshi || null
  let body
  const isField = k.outcomes.length > 3
  if (k.state === 'open' && isField) {
    body = null
  } else if (k.state === 'open') {
    body = k.outcomes.map(o => panel(k, o, { placement, movement, color: colors[o.role] })).join('')
  } else {
    body = k.outcomes.map(settledPanel).join('')
    if (!body) return ''
  }
  return `<section class="ic kx${compact ? ' kx--compact' : ''}" ${attrs(entry, k, placement)} aria-label="Market Pulse: live Kalshi prediction market">
    <header class="kx__hd">
      <div class="kx__brand"><span class="kx__name">Market Pulse</span><span class="kx__sub">${k.freshness === 'live' ? 'Live prediction market' : k.state === 'settled' ? 'Prediction market · settled' : k.freshness === 'stale' ? 'Prediction market · quote not current' : 'Prediction market'} · Kalshi</span></div>
      ${freshnessBadge(k)}
    </header>
    ${body === null ? fieldList(k, k.outcomes, { placement, movement }) : `<div class="kx__grid" style="--kx-cols:${k.outcomes.length}">${body}</div>`}
    ${k.state === 'open' && !compact ? '<p class="kx__note">Live prediction-market pricing — no sportsbook line required. Traded contract prices on Kalshi, not sportsbook odds and not a PropBetEdge model. Each YES contract pays $1 if that outcome happens. Mid-market is the midpoint of the best YES bid and ask, shown only when the spread is 10¢ or less. Movement uses our stored observations only.</p>' : ''}
    <footer class="kx__ft"><span>Kalshi · Prediction market data</span>${link(k, 'View market on Kalshi ↗', 'kx__cta', placement, null)}</footer>
  </section>`
}

/** One-line NBACast strip. Click toggles the expanded card; prices link to Kalshi. */
export function kalshiStrip(entry, { placement = 'nbacast-strip', colors = {} } = {}) {
  const k = usable(entry)
  if (!k || k.state !== 'open') return ''
  const lead = k.outcomes.length > 3 ? k.outcomes.slice(0, 3) : k.outcomes
  if (!lead.every(o => o.mid_bp !== null && o.mid_bp !== undefined)) return ''
  const movement = entry.movement?.kalshi || null
  const shown = k.outcomes.length > 3 ? k.outcomes.slice(0, 3) : k.outcomes
  const items = shown.map(o => {
    const d = movement?.[o.role]?.delta_mid_bp
    const arrow = d === null || d === undefined || d === 0 ? '' : `<span class="kx__sd kx__sd--${d > 0 ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'}${esc(Math.abs(d / 100).toFixed(1))}¢</span>`
    const dir = direction(placement, o.market_ticker, o.mid_bp)
    const c = safeColor(colors[o.role])
    return `<span class="kx__si"${c ? ` style="--kx-team:${c}"` : ''}><b>${esc(o.abbr || '')}</b> <span class="mono kx__sp${dir}">${esc(centsLabel(o.mid_bp, { fixed: true }))}</span>${arrow}</span>`
  }).join('<span class="kx__sep" aria-hidden="true">|</span>')
  return `<details class="kx-strip" ${attrs(entry, k, placement)}>
    <summary><span class="kx__name">Market Pulse</span><span class="kx__sitems">${items}</span>${freshnessBadge(k)}<span class="kx__chev" aria-hidden="true"></span><span class="kx__stag">Live prediction-market expectations — no sportsbook line required · Kalshi</span></summary>
    ${kalshiCard(entry, { placement: `${placement}-expanded`, colors, compact: true })}
  </details>`
}

/** Restrained compact line for game cards: prices + freshness only. */
export function kalshiLine(entry) {
  const k = usable(entry)
  if (!k || k.state !== 'open' || k.freshness === 'stale') return ''
  const lead = k.outcomes.length > 3 ? k.outcomes.slice(0, 2) : k.outcomes
  if (!lead.every(o => o.mid_bp !== null && o.mid_bp !== undefined)) return ''
  const px = lead.map(o => `${esc(o.abbr || '')} ${esc(centsLabel(o.mid_bp, { fixed: true }))}`).join(' · ')
  return `<span class="kx-line mono" title="Kalshi Mid-market · prediction market, not sportsbook odds · updated ${esc(ageLabel(k.age_seconds))}" ${attrs(entry, k, 'game-card')}><span class="kx-line__b">KALSHI</span>${px}${k.freshness === 'live' ? '<span class="kx__pulse" aria-hidden="true"></span>' : ''}</span>`
}

/* ── analytics: kalshi_market_impression / kalshi_market_click (no PII) ── */
const seen = new Set()
let wired = false

function gaEvent(name, el) {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return
  const card = el.closest('[data-kx-impression]') || el
  window.gtag('event', name, {
    sport: card.dataset.kxSport || '',
    event_id: card.dataset.kxEvent || '',
    market_ticker: el.dataset.kxTicker || card.dataset.kxTicker || '',
    placement: el.dataset.kxPlacement || card.dataset.kxPlacement || '',
    snapshot_age_s: Number(el.dataset.kxAge || card.dataset.kxAge || 0) || 0,
  })
}

/** Call after inserting HTML that may contain Kalshi UI. Idempotent. */
export function wireKalshi(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return
  if (!wired && typeof document !== 'undefined') {
    wired = true
    document.addEventListener('click', e => {
      const a = e.target.closest?.('[data-kx-click]')
      if (a) gaEvent('kalshi_market_click', a)
    }, true)
  }
  const cards = root.querySelectorAll?.('[data-kx-impression]') || []
  const fire = el => {
    const key = `${el.dataset.kxTicker}|${el.dataset.kxPlacement}`
    if (seen.has(key)) return
    seen.add(key)
    gaEvent('kalshi_market_impression', el)
  }
  if (typeof IntersectionObserver === 'undefined') { cards.forEach(fire); return }
  const io = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) { fire(en.target); io.unobserve(en.target) }
  }, { threshold: 0.5 })
  cards.forEach(c => io.observe(c))
}

/** Test hook. */
export function __resetKalshiFlashes() { lastShown.clear() }

/* ───────────────────────── Market history (closed / settled) ─────────────────────────
 * Venue-neutral history from the API's market_history (event endpoint) and market.close (board).
 * Only stored values: "First observed" is never called an open; the before-start price is our last
 * pre-start observation; the final trade and settlement are the venue's. Nothing is drawn that we did
 * not observe. Works for two-way, three-way (soccer) and field (F1, golf) markets. */
const pick = (p) => (p ? (p.mid_bp ?? p.last_bp ?? null) : null)
const tms = (iso) => Date.parse(iso || '')
const HIST_TOP = 8

export function historyChart(h, { width = 320, height = 96 } = {}) {
  const lines = (h.shape === 'field' ? h.outcomes.slice(0, 3) : h.outcomes)
    .map((o, i) => ({ i, pts: (o.chart || []).map((p) => ({ t: tms(p.t), v: p.mid_bp ?? p.last_bp })).filter((p) => Number.isFinite(p.t) && p.v != null) }))
    .filter((l) => l.pts.length >= 2)
  if (!lines.length) return ''
  const marks = [['event_start', 'Event start'], ['market_close', 'Market closed'], ['settlement', 'Settled']]
    .map(([k, label]) => ({ k, label, t: tms(h.markers?.[k]) })).filter((m) => Number.isFinite(m.t))
  const all = lines.flatMap((l) => l.pts.map((p) => p.t)).concat(marks.map((m) => m.t))
  const t0 = Math.min(...all)
  const t1 = Math.max(...all)
  if (!(t1 > t0)) return ''
  const pad = 4
  const x = (t) => (pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad)).toFixed(1)
  const y = (v) => (pad + (1 - v / 10000) * (height - 2 * pad)).toFixed(1)
  const paths = lines.map((l) => `<polyline class="kx-h__l kx-h__l${l.i + 1}" points="${l.pts.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')}" fill="none"/>`).join('')
  const ms = marks.filter((m) => m.t >= t0 && m.t <= t1).map((m) => `<line class="kx-h__m kx-h__m--${m.k}" x1="${x(m.t)}" x2="${x(m.t)}" y1="0" y2="${height}"><title>${esc(m.label)}</title></line>`).join('')
  const mid = `<line class="kx-h__g" x1="0" x2="${width}" y1="${y(5000)}" y2="${y(5000)}"/>`
  const legend = marks.length ? `<p class="kx-h__legend">${marks.map((m) => `<span class="kx-h__lg kx-h__lg--${m.k}">${esc(m.label)}</span>`).join('')}</p>` : ''
  return `<figure class="kx-h__chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Observed market prices over time">${mid}${paths}${ms}</svg><figcaption>Observed prices only (Mid-market, else last trade); gaps are periods we did not observe.</figcaption>${legend}</figure>`
}

function settleText(o) {
  if (o.settlement?.result === 'yes') return '<span class="kx-h__res kx-h__res--yes">Settled YES</span>'
  if (o.settlement?.result === 'no') return '<span class="kx-h__res kx-h__res--no">Settled NO</span>'
  if (o.settlement) return '<span class="kx-h__res">Settled</span>'
  if (o.close) return '<span class="kx-h__res kx-h__res--wait">Awaiting settlement</span>'
  return ''
}

function histRow(o, i, field) {
  const first = pick(o.first_observed)
  const pre = pick(o.at_start)
  const fin = o.close?.final_trade_bp ?? null
  const cells = [
    first != null ? `<span><small>${esc(o.first_observed.before_first_trade ? 'Before first trade' : 'First observed')}</small><b class="mono">${esc(centsLabel(first, { fixed: true }))}</b></span>` : '',
    pre != null ? `<span><small>Before start</small><b class="mono">${esc(centsLabel(pre, { fixed: true }))}</b></span>` : '',
    fin != null ? `<span><small>Final trade</small><b class="mono">${esc(centsLabel(fin))}</b></span>` : '',
  ].join('')
  return `<li class="kx-h__row${o.settlement?.result === 'yes' ? ' is-winner' : ''}">${field ? `<span class="kx__frank mono">${i + 1}</span>` : ''}<span class="kx-h__who"><b>${esc(o.abbr || o.kalshi_name || '')}</b>${o.contract ? `<small>${esc(o.contract)}</small>` : ''}</span><span class="kx-h__px">${cells}</span>${settleText(o)}</li>`
}

/** "How the market closed" module for a CLOSED or SETTLED event (entry from the event endpoint). */
export function marketHistoryCard(entry, { placement = 'market-history' } = {}) {
  const h = entry?.market_history
  if (!h || (h.lifecycle !== 'CLOSED' && h.lifecycle !== 'SETTLED') || !h.outcomes?.length || !h.market_url) return ''
  const venue = h.venue_label || 'Kalshi'
  const k = { market_url: h.market_url, event_ticker: h.event_ticker, age_seconds: null }
  const field = h.shape === 'field'
  const shown = field ? h.outcomes.slice(0, HIST_TOP) : h.outcomes
  const rows = shown.map((o, i) => histRow(o, i, field)).join('')
  const winner = h.outcomes.find((o) => o.settlement?.result === 'yes')
  const verdict = h.lifecycle === 'SETTLED' && winner
    ? `<p class="kx-h__verdict">${esc(venue)} settlement: <b>${esc(winner.abbr || winner.kalshi_name || '')}</b> — YES</p>`
    : h.lifecycle === 'CLOSED' ? '<p class="kx-h__verdict">Market closed · awaiting settlement</p>' : ''
  const extra = field ? (h.outcomes.length - shown.length) + (h.more_outcomes || 0) : 0
  const more = extra > 0 ? `<p class="kx__note">${extra} more contracts on ${esc(venue)}.</p>` : ''
  const partial = h.history !== 'full' ? '<p class="kx__note">We started recording this market after trading began, so “First observed” is our first record, not the opening price.</p>' : ''
  return `<section class="ic kx kx-h" data-kx-history data-kx-ticker="${esc(h.event_ticker || '')}" data-kx-placement="${esc(placement)}" aria-label="Market history: how the market closed">
    <header class="kx__hd"><div class="kx__brand"><span class="kx__name">How the market closed</span><span class="kx__sub">Market history · ${esc(venue)}</span></div><span class="kx__st">${esc(h.status_label || '')}</span></header>
    <ol class="kx-h__rows${field ? ' kx-h__rows--field' : ''}">${rows}</ol>
    ${verdict}${more}
    ${historyChart(h)}
    ${partial}
    <p class="kx__note">Prediction-market prices, not sportsbook odds and not a PropBetEdge model. Settlement is the market venue's, not our result.</p>
    <footer class="kx__ft"><span>${esc(venue)} · Prediction market data</span>${link(k, `View market on ${esc(venue)} ↗`, 'kx__cta', placement, null)}</footer>
  </section>`
}

/** Compact line for a completed event's result card (board entry). Empty when nothing was recorded. */
export function marketCloseLine(entry) {
  const c = entry?.market?.close
  if (!c || !c.outcomes?.length) return ''
  const won = c.outcomes.find((o) => o.result === 'yes')
  const ranked = c.outcomes.slice().sort((a, b) => (b.before_start_bp ?? b.last_tradable_bp ?? -1) - (a.before_start_bp ?? a.last_tradable_bp ?? -1))
  const o = won || ranked[0]
  if (!o) return ''
  const a = o.first_bp
  const b = o.before_start_bp
  const path = a != null && b != null ? `${centsLabel(a)} → ${centsLabel(b)}` : a != null ? `first ${centsLabel(a)}` : b != null ? `${centsLabel(b)} before start` : ''
  if (!path && !won) return ''
  const tail = c.lifecycle === 'SETTLED' ? (won ? ' · settled YES' : '') : ' · awaiting settlement'
  return `<span class="kx-line kx-line--closed mono" title="Market history: first observed → last price observed before the start · prediction market, not sportsbook odds"><span class="kx-line__b">MARKET</span>${esc(o.abbr || '')}${path ? ` ${esc(path)}` : ''}${esc(tail)}</span>`
}

/** One entry point: the live card while the market trades, the history once it has closed or settled. */
export function marketModule(entry, opts = {}) {
  const lc = entry?.market?.lifecycle
  if ((lc === 'CLOSED' || lc === 'SETTLED') && entry?.market_history) return marketHistoryCard(entry, opts)
  return kalshiCard(entry, opts)
}

/* ───────────────────────── ALGO vs MARKET (track records + event pages) ─────────────────────────
 * Data: GET /v1/algo-vs-market/:sport (algos[].scoreboard / ledger) and /v1/algo-vs-market/event/:sport/:id.
 * Both opinions frozen at the algorithm lock; agreements never score; only disagreements are contests.
 * Renders nothing until an algorithm has its first qualifying comparison (no empty scoreboards). */
const OUTCOME_LABEL = { ALGO_WIN: 'PropBetEdge', MARKET_WIN: 'Market', NEITHER: 'Neither', VOID: 'Void', AGREED_CORRECT: 'Agreed · correct', AGREED_WRONG: 'Agreed · wrong', NOT_SCORED: 'Not scored' }
const pct = (v) => (v == null ? null : `${v.toFixed(1)}%`)
const when = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '' }

// Display name of an outcome role: the frozen market price label, else the page's resolver, else the stored label.
const ROLE_WORDS = new Set(['home', 'away', 'draw', 'a', 'b'])
function avmName(r, role, label, nameOf) {
  if (!role) return null
  const priced = r.market?.prices?.[role]?.label
  if (label && !ROLE_WORDS.has(String(label).toLowerCase())) return label
  return priced || nameOf?.(r, role) || label || role
}

function avmRow(r, nameOf) {
  const algo = avmName(r, r.algo_selection, r.algo_selection_label, nameOf)
  const mkt = r.market?.selection ? `${avmName(r, r.market.selection, r.market.selection_label, nameOf)} · ${centsLabel(r.market.selection_price_bp, { fixed: true })}` : ''
  const res = r.result ? (OUTCOME_LABEL[r.result.h2h_outcome] || r.result.h2h_outcome) : r.status === 'LOCKED' ? 'Locked · pending' : 'Pending'
  return `<tr class="avm__r avm__r--${esc((r.result?.h2h_outcome || r.status || '').toLowerCase())}"><td class="mono">${esc(when(r.algo_lock_at))}</td><td>${esc(r.event_label || r.canonical_event_id)}</td><td>${esc(algo || (r.status === 'LOCKED' ? 'Locked' : '—'))}</td><td class="mono">${esc(mkt || '—')}</td><td>${esc(r.status === 'AGREEMENT' ? 'Agree' : r.status === 'DISAGREEMENT' ? 'Head to head' : r.status === 'LOCKED' ? '—' : r.status.replace(/_/g, ' ').toLowerCase())}</td><td><b>${esc(res)}</b></td></tr>`
}

/** Track-record module for ONE algorithm (an entry of payload.algos). Empty string until it has a contest. */
export function algoVsMarketCard(algo, { nameOf = null, recent = 10, ledgerHref = null } = {}) {
  if (!algo || !algo.scoreboard || !algo.ledger?.length) return ''
  const s = algo.scoreboard
  if (!(s.agreements + s.disagreements + s.pending)) return ''
  const rows = algo.ledger.slice(0, recent).map((r) => avmRow(r, nameOf)).join('')
  const decided = s.decided || 0
  return `<section class="ic kx avm" data-avm="${esc(algo.algo_id)}" aria-label="Algo versus market">
    <header class="kx__hd"><div class="kx__brand"><span class="kx__name">Algo vs Market</span><span class="kx__sub">When the algo and the market disagree, who wins?</span></div></header>
    <div class="avm__score"><span class="avm__side"><small>PropBetEdge</small><b class="mono">${esc(String(s.algo_wins))}</b></span><span class="avm__dash">—</span><span class="avm__side"><small>Market</small><b class="mono">${esc(String(s.market_wins))}</b></span></div>
    <p class="avm__line">${esc(String(decided))} decided disagreement${decided === 1 ? '' : 's'}${s.algo_win_rate != null ? ` · algo win rate ${esc(pct(s.algo_win_rate))}` : ''}</p>
    <dl class="avm__stats"><div><dt>Agreed</dt><dd class="mono">${esc(String(s.agreements))}</dd></div><div><dt>Neither / void</dt><dd class="mono">${esc(String(s.neither + s.void))}</dd></div><div><dt>Pending</dt><dd class="mono">${esc(String(s.pending))}</dd></div></dl>
    <div class="avm__tw"><table class="avm__t"><thead><tr><th>Lock</th><th>Event</th><th>PBE</th><th>Market at lock</th><th>Type</th><th>Winner</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${ledgerHref ? `<p class="kx__note"><a href="${esc(ledgerHref)}">Full head-to-head ledger</a></p>` : ''}
    <p class="kx__note">Both opinions are frozen at the algorithm's lock: the market side is the latest market price we recorded at or before that moment (never later). The market's pick is the outcome with the highest Mid-market. Agreements are recorded but never scored; a third outcome winning counts for neither. Market: Kalshi prediction market. Every comparison is permanent.</p>
  </section>`
}

/** Event-page layer: PBE pick vs market at PBE lock (+ result). Empty when no qualifying comparison. */
export function algoVsMarketEvent(payload, { nameOf = null } = {}) {
  const r = (payload?.comparisons || []).find((x) => ['AGREEMENT', 'DISAGREEMENT', 'LOCKED'].includes(x.status))
  if (!r) return ''
  const algo = avmName(r, r.algo_selection, r.algo_selection_label, nameOf)
  const mkt = r.market?.selection ? avmName(r, r.market.selection, r.market.selection_label, nameOf) : null
  const head = r.status === 'LOCKED' ? 'Locked — revealed after the result' : r.status === 'AGREEMENT' ? 'Agreement' : 'Head to head'
  const res = r.result ? `<p class="avm__verdict"><b>${esc(OUTCOME_LABEL[r.result.h2h_outcome] || r.result.h2h_outcome)}</b>${r.result.h2h_outcome === 'ALGO_WIN' || r.result.h2h_outcome === 'MARKET_WIN' ? ' wins' : ''}</p>` : ''
  return `<section class="ic kx avm avm--event" aria-label="PropBetEdge pick versus market at lock">
    <header class="kx__hd"><div class="kx__brand"><span class="kx__name">Algo vs Market</span><span class="kx__sub">${esc(head)} · frozen ${esc(when(r.algo_lock_at))}</span></div></header>
    <div class="avm__vs"><span><small>${esc(r.algo_label || 'PropBetEdge')}</small><b>${esc(algo || '—')}</b>${r.algo_probability != null ? `<em class="mono">${esc((r.algo_probability * 100).toFixed(1))}%</em>` : ''}</span><span class="avm__dash">vs</span><span><small>Market at PBE lock</small><b>${esc(mkt || '—')}</b>${r.market?.selection_price_bp != null ? `<em class="mono">${esc(centsLabel(r.market.selection_price_bp, { fixed: true }))}</em>` : ''}</span></div>
    ${res}
    <p class="kx__note">Market price recorded ${r.market?.snapshot_age_s != null ? `${esc(String(Math.round(r.market.snapshot_age_s / 60)))} min` : ''} before the algorithm locked (Kalshi prediction market). Later market moves never change this contest.</p>
  </section>`
}
