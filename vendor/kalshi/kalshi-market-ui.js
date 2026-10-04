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
// A missing side (one-sided book at the $0 / $1 boundary) reads "—"; it is never filled from last trade.
function headline(o) {
  if (o.mid_bp !== null && o.mid_bp !== undefined) return { value: centsLabel(o.mid_bp, { fixed: true }), label: 'Mid-market', bp: o.mid_bp }
  return { value: `${side(o.best_yes_bid_bp)} / ${side(o.best_yes_ask_bp)}`, label: 'YES bid / ask', bp: null }
}
const side = (bp) => centsLabel(bp) ?? '—'

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
      <div><dt>Bid</dt><dd>${esc(side(o.best_yes_bid_bp))}</dd></div>
      <div><dt>Ask</dt><dd>${esc(side(o.best_yes_ask_bp))}</dd></div>
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
  // renderable (a real side exists) is the card gate; an older API without it falls back to displayable
  if (k.state === 'open' && !k.outcomes.every(o => o.renderable ?? o.displayable)) return null
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
    ${k.state === 'open' && body !== null && !k.outcomes.every(o => o.mid_bp !== null && o.mid_bp !== undefined) ? `<p class="kx__note kx__note--nomid" data-kx-nomid>Mid-market unavailable at this observation · ${k.outcomes.some(o => o.one_sided || ((o.best_yes_bid_bp == null) !== (o.best_yes_ask_bp == null))) ? 'one-sided book' : 'spread wider than 10¢'}</p>` : ''}
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

/* ───────────────────────── VENUES (multi-venue desk; venue-neutral) ─────────────────────────
 * Data: one desk event from createKalshiClient(...).loadDesk(id) (GET /v1/market-desk?sport=&event=). The canonical PBE
 * event is the parent: a product renders kalshiCard (when Kalshi has a market) and venueLines (when another venue has
 * one) INDEPENDENTLY — neither venue depends on the other. With no Kalshi card pass { standalone: true } for the
 * Market Pulse heading. Kalshi itself is never repeated here. Per venue:
 *  - EXACT_MATCH / COMPARABLE_EXCEPT_EXCEPTIONS quotes: Mid-market (or bid / ask), freshness, and — COMPARABLE only —
 *    the disclosure; an aligned comparison (desk `comparison`) is shown as a gap in points, never pooled;
 *  - related[] (RULE_MISMATCH / UNVERIFIED): the "RELATED MARKET · …" label, the venue's own price and the exact
 *    reason — never a gap, never compared;
 *  - stale / unpriced quotes are omitted; nothing qualifying -> '' (no empty slot, no placeholder).
 * No consensus or average is ever computed. Prices are cents of a $1 contract on each venue's own book. */
const VENUE_NAME = { polymarket: 'Polymarket', kalshi: 'Kalshi' }
const vName = (v) => VENUE_NAME[v] || String(v || '')
function vPrice(q) {
  if (q?.mid_bp != null) return { text: centsLabel(q.mid_bp, { fixed: true }), label: 'Mid-market', bp: q.mid_bp }
  if (q?.bid_bp != null && q?.ask_bp != null) return { text: `${centsLabel(q.bid_bp)} / ${centsLabel(q.ask_bp)}`, label: 'Bid / ask', bp: null }
  return null
}
// Relationship to OUR canonical contract (and to Kalshi when Kalshi lists it): one consistent vocabulary.
const REL = {
  EXACT_MATCH: { tag: 'Exact market', sub: 'Same contract rules as Kalshi' },
  COMPARABLE_EXCEPT_EXCEPTIONS: { tag: 'Comparable market', sub: 'Comparable to Kalshi except edge cases' },
  related: { tag: null, sub: 'Related market — not compared' },
  listed: { tag: 'Prediction market', sub: 'Only venue with a market here' },
}
const secondsSince = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : null }
// "Live" is earned by the observation's AGE, not by the lane cadence: a quote read 10 min ago on a 15-min pregame cadence
// is current for its lane but is NOT live — it gets the neutral "Updated 10 min ago" (same 2.5-min rule as the Kalshi card).
export const VENUE_LIVE_MAX_S = 150
const venueLive = (fresh, observedAt) => fresh === 'live' && (secondsSince(observedAt) ?? Infinity) <= VENUE_LIVE_MAX_S
function venueBadge(fresh, observedAt) {
  const age = ageLabel(secondsSince(observedAt))
  if ((fresh === 'live' || fresh === 'delayed') && !venueLive(fresh, observedAt) && secondsSince(observedAt) <= 1800) return `<span class="kx__st" data-kx-age-of="${esc(observedAt || '')}">Updated ${esc(age)}</span>`
  if (fresh === 'live') return `<span class="kx__st kx__st--live" data-kx-age-of="${esc(observedAt || '')}"><span class="kx__pulse" aria-hidden="true"></span>Updated ${esc(age)}</span>`
  if (fresh === 'delayed') return `<span class="kx__st kx__st--delayed" data-kx-age-of="${esc(observedAt || '')}">Delayed · Updated ${esc(age)}</span>`
  return ''
}
function venuePanel(row, { placement, venue, url }) {
  const { c, v } = row
  const px = vPrice(v)
  const mv = v.movement || null
  const dir = px?.bp != null ? direction(`${placement}|${venue}`, v.outcome_id || c.label, px.bp) : ''
  const spark = mv?.points?.length >= 3 ? sparkline(mv.points) : '' // a line needs >= 3 real observations; less says less
  const gap = row.gap != null ? `<span class="kx-v__gap">Gap ${esc(String(row.gap))} pts vs Kalshi</span>` : ''
  return `<div class="kx__panel">
    <div class="kx__who"><b>${esc(c.label || '')}</b><small>${esc(c.label || '')} wins · YES</small></div>
    <a class="kx__price" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-kx-click data-kx-placement="${esc(placement)}"><span class="kx__px mono${dir}">${esc(px.text)}</span><span class="kx__pxl">${esc(px.label)}</span></a>
    <div class="kx__move">${deltaChip(mv)}${spark}${gap}</div>
    <dl class="kx__book mono">
      <div><dt>Bid</dt><dd>${esc(centsLabel(v.bid_bp) ?? '—')}</dd></div>
      <div><dt>Ask</dt><dd>${esc(centsLabel(v.ask_bp) ?? '—')}</dd></div>
    </dl>
  </div>`
}
//  - listed[] (VENUE_ONLY): the only venue with a market on our contract — its own price, labelled, never compared.
/**
 * Venue cards (Polymarket, …) for one desk event — first-class siblings of kalshiCard, built on the SAME card structure
 * (Market Pulse brand, two-sided panels, Mid-market, movement since first observed + sparkline of OUR stored
 * observations, bid / ask, freshness badge, venue CTA) plus a relationship tag and, for related markets, a contained
 * rules note (one scannable line + the precise detail). { standalone: true } when no Kalshi card is on the page: the
 * card then carries the Market Pulse brand itself. Stale / unpriced quotes are omitted; nothing -> ''.
 */
export function venueLines(deskEvent, { placement = 'venues', standalone = false } = {}) {
  const groups = new Map() // `${venue}|${kind}` -> card
  for (const c of deskEvent?.contracts || []) {
    const quotes = (c.venues || []).filter((v) => v.venue !== 'kalshi' && v.freshness && v.freshness !== 'stale').map((v) => ({ v, kind: v.match }))
    const rel = (c.related || []).filter((r) => r.freshness && r.freshness !== 'stale').map((r) => ({ v: r, kind: 'related' }))
    const lst = (c.listed || []).filter((r) => r.venue !== 'kalshi' && r.freshness && r.freshness !== 'stale').map((r) => ({ v: r, kind: 'listed' }))
    for (const { v, kind } of [...quotes, ...rel, ...lst]) {
      if (!vPrice(v) || !v.market_url) continue
      const k = `${v.venue}|${kind}`
      const g = groups.get(k) || { venue: v.venue, kind, url: v.market_url, label: v.label || null, summary: v.summary || null, reason: v.reason || null, disclosure: v.disclosure || null, fresh: v.freshness, observedAt: v.observed_at || null, rows: [] }
      if (v.freshness === 'delayed') g.fresh = 'delayed' // the card is only as fresh as its least fresh quote
      if (v.observed_at && (!g.observedAt || v.observed_at < g.observedAt)) g.observedAt = v.observed_at
      const gap = kind !== 'related' && kind !== 'listed' && c.comparison?.match_class === v.match && c.comparison.venue_gap_pts != null ? Math.round(c.comparison.venue_gap_pts) : null
      g.rows.push({ c, v, gap })
      groups.set(k, g)
    }
  }
  if (!groups.size) return ''
  const cards = [...groups.values()].map((g) => {
    const rel = REL[g.kind] || REL.related
    const tag = g.kind === 'related' ? (g.label || 'RELATED MARKET · RULES DIFFER') : rel.tag
    const live = venueLive(g.fresh, g.observedAt)
    const sub = `${live ? 'Live prediction market' : 'Prediction market'}${standalone ? ` · ${vName(g.venue)}` : ''}`
    const note = g.kind === 'related'
      ? `<div class="kx-v__rules" role="note"><b>${esc(g.summary || 'Settlement rules differ between venues')}</b><small>${esc(g.reason || '')}${g.reason ? '. ' : ''}Shown at its own price; not compared.</small></div>`
      : g.kind === 'COMPARABLE_EXCEPT_EXCEPTIONS' && g.disclosure
        ? `<div class="kx-v__rules kx-v__rules--cmp" role="note"><b>Comparable except edge cases</b><small>${esc(g.disclosure)}</small></div>`
        : g.kind === 'listed' ? `<p class="kx-v__solo">Only venue with a market on this ${g.rows.length === 2 ? 'contest' : 'event'} right now · not compared</p>` : ''
    return `<section class="ic kx kx--venue kx--${esc(g.venue)}" data-kx-venue="${esc(g.venue)}" data-match="${esc(g.kind)}" aria-label="${esc(vName(g.venue))} prediction market">
    <header class="kx__hd">
      <div class="kx__brand"><span class="kx__name">${esc(standalone ? 'Market Pulse' : vName(g.venue))}</span><span class="kx__sub">${esc(sub)}</span></div>
      ${venueBadge(g.fresh, g.observedAt)}
    </header>
    <p class="kx-v__rel kx-v__rel--${esc(g.kind === 'related' ? 'related' : g.kind === 'listed' ? 'listed' : g.kind === 'EXACT_MATCH' ? 'exact' : 'comparable')}"><span>${esc(tag)}</span></p>
    <div class="kx__grid" style="--kx-cols:${g.rows.length}">${g.rows.map((r) => venuePanel(r, { placement, venue: g.venue, url: g.url })).join('')}</div>
    ${note}
    <footer class="kx__ft"><span>${esc(vName(g.venue))} · Prediction market data · not sportsbook odds or a PropBetEdge model</span><a class="kx__cta" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" data-kx-click data-kx-placement="${esc(placement)}">View market on ${esc(vName(g.venue))} ↗</a></footer>
  </section>`
  }).join('')
  return `<div class="kx-v${standalone ? ' kx-v--solo' : ''}" data-kx-venues>${cards}</div>`
}

/** Re-render every "Updated Xs ago" inside `root` from its observed time (call on a timer; no DOM rebuild). */
export function tickVenueAges(root) {
  for (const el of root?.querySelectorAll?.('[data-kx-age-of]') || []) {
    const age = ageLabel(secondsSince(el.dataset.kxAgeOf))
    const t = el.lastChild
    if (t && t.nodeType === 3) { const next = el.classList.contains('kx__st--delayed') ? `Delayed · Updated ${age}` : `Updated ${age}`; if (t.textContent !== next) t.textContent = next }
  }
}

/** Venues of a desk event with a current, priced market (other than Kalshi), e.g. ['polymarket']. */
export function deskVenues(deskEvent) {
  const out = new Set()
  for (const c of deskEvent?.contracts || []) for (const v of [...(c.venues || []), ...(c.related || []), ...(c.listed || [])]) {
    if (v.venue !== 'kalshi' && v.freshness && v.freshness !== 'stale' && (v.mid_bp != null || (v.bid_bp != null && v.ask_bp != null))) out.add(v.venue)
  }
  return [...out]
}
/**
 * Compact discovery cue for list / card surfaces ("MARKET · POLYMARKET  Allen 61.5¢ · Duncan 38.5¢"): every venue other
 * than Kalshi with a current market on this canonical event (Kalshi keeps its own kalshiLine). '' when none.
 */
export function venueChip(deskEvent) {
  const vs = deskVenues(deskEvent)
  if (!vs.length) return ''
  const v0 = vs[0]
  const px = (deskEvent.contracts || []).map((c) => {
    const q = [...(c.venues || []), ...(c.related || []), ...(c.listed || [])].find((x) => x.venue === v0 && x.mid_bp != null && x.freshness && x.freshness !== 'stale')
    return q ? `${esc(String(c.label || '').split(' ').slice(-1)[0])} <b class="mono">${esc(centsLabel(q.mid_bp, { fixed: true }))}</b>` : null
  }).filter(Boolean).slice(0, 2)
  return `<span class="kx-vchip" data-kx-vchip="${esc(vs.join(','))}" title="Prediction market on ${esc(vs.map(vName).join(', '))} · not sportsbook odds"><i>MARKET</i> · ${esc(vs.map(vName).join(' · ').toUpperCase())}${px.length === 2 ? ` <span class="kx-vchip__px">${px.join(' · ')}</span>` : ''}</span>`
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

/* ───────────────────────── MARKET TAPE rail (network) ─────────────────────────
 * Consumes ONLY GET /v1/market-tape (no local movement math). Fixed-size cards inside a reserved-height
 * scroller so refreshes update in place. Filters: ALL / LIVE / MOVERS / PBE vs MARKET / SETTLED — a filter
 * with no items is not rendered (no empty-state UI). Clicks go to the PBE research page (destination);
 * the event page owns the market link. Movement is labelled "since first observed" (never "since open"). */
const TAPE_FILTERS = [['all', 'All'], ['live', 'Live'], ['movers', 'Movers'], ['pbe', 'PBE vs Market'], ['settled', 'Settled']]
const SPORT_LABEL = { nba: 'NBA', wnba: 'WNBA', nfl: 'NFL', nhl: 'NHL', mlb: 'MLB', soccer: 'SOCCER', tennis: 'TENNIS', ufc: 'UFC', f1: 'F1', golf: 'GOLF', boxing: 'BOXING' }
const cents = (bp) => (bp == null ? null : `${(bp / 100).toFixed(1)}¢`)
const signed = (bp) => (bp > 0 ? '▲' : '▼') + Math.abs(bp / 100).toFixed(1)

export function tapeState(it) {
  if (it.lifecycle === 'SETTLED') return ['SETTLED', 'settled']
  if (it.lifecycle === 'CLOSED') return ['CLOSED', 'closed']
  if (it.freshness === 'stale' || it.freshness === 'delayed') return ['STALE', 'stale']
  if (it.lifecycle === 'ACTIVE') return ['LIVE', 'live']
  if (it.lifecycle === 'UPCOMING') return ['UPCOMING', 'upcoming']
  return [it.lifecycle || '', 'other']
}

export function tapeItems(payload, filter = 'all') {
  const c = payload?.classes || {}
  const uniq = (arr) => { const seen = new Set(); return arr.filter((x) => { const k = `${x.sport}|${x.canonical_event_id}`; if (seen.has(k)) return false; seen.add(k); return true }) }
  if (filter === 'live') return c.live || []
  if (filter === 'movers') return c.movers || []
  if (filter === 'pbe') return c.pbe_disagreements || []
  if (filter === 'settled') return uniq([...(c.just_settled || []), ...(c.just_closed || [])])
  return uniq([...(c.live || []), ...(c.movers || []).slice(0, 8), ...(c.closing_soon || []), ...(c.just_settled || []), ...(c.pbe_disagreements || [])])
}

function tapeOutcomes(it) {
  const outs = (it.outcomes || []).slice(0, it.shape === 'field' ? 2 : 3)
  if (it.lifecycle === 'SETTLED') {
    const won = (it.outcomes || []).find((o) => o.result === 'yes')
    const pre = (it.outcomes || []).filter((o) => o.pre_bp != null).sort((a, b) => b.pre_bp - a.pre_bp)[0]
    return `${pre ? `<span class="tape__l">${esc(pre.label || '')} ${esc(cents(pre.pre_bp))} pre-start favorite</span>` : ''}${won ? `<span class="tape__l tape__l--res">${esc(won.label || '')} ${it.shape === 'two_way' || it.shape === 'three_way' ? 'won' : 'YES'}</span>` : ''}`
  }
  return outs.map((o) => {
    const px = o.price_bp != null ? cents(o.price_bp) : null
    const mv = o.delta_first_bp ? `<em class="tape__mv tape__mv--${o.delta_first_bp > 0 ? 'up' : 'down'}" title="Since first observed">${esc(signed(o.delta_first_bp))}</em>` : ''
    return px ? `<span class="tape__l"><b>${esc(o.label || '')}</b> <span class="mono">${esc(px)}</span>${mv}</span>` : ''
  }).join('')
}

// Multi-venue lines (Market Tape v2 items only; a v1 item has no venues/related -> ''). Polymarket is labelled
// by venue; COMPARABLE quotes carry the disclosure; RELATED markets show their own price with the
// "RELATED MARKET · RULES DIFFER" label and reason, never a gap. Stale is labelled; no number without freshness.
const venueName = (v) => (v === 'polymarket' ? 'Polymarket' : v === 'kalshi' ? 'Kalshi' : String(v || ''))
const pxList = (outs) => (outs || []).filter((o) => o.mid_bp != null && o.freshness).slice(0, 2)
  .map((o) => `${esc(o.label || o.role || '')} <span class="mono">${esc(cents(o.mid_bp))}</span>${o.freshness === 'stale' ? ' <em class="tape__stale">stale</em>' : ''}`).join(' · ')
export function tapeVenueLines(it) {
  const pm = (it?.venues || []).filter((v) => v.venue !== 'kalshi')
  const rel = (it?.related || [])
  if (!pm.length && !rel.length) return ''
  const lines = pm.map((v) => {
    const gap = it.comparison && it.comparison.match_class === v.match ? ` · gap ${esc(Math.round(it.comparison.max_gap_pts))} pts` : ''
    const dx = v.disclosure ? `<span class="tape__dx">${esc(v.disclosure)}</span>` : ''
    return `<span class="tape__vl" data-venue="${esc(v.venue)}" data-match="${esc(v.match)}"><b>${esc(venueName(v.venue))}</b> ${pxList(v.outcomes)}${gap}${dx}</span>`
  })
  for (const r of rel) {
    const px = pxList(r.outcomes)
    lines.push(`<span class="tape__vl tape__vl--rel" data-venue="${esc(r.venue)}" data-match="${esc(r.match)}" title="${esc(r.reason || '')}"><i class="tape__rl">${esc(r.label || 'RELATED MARKET')}</i> <b>${esc(venueName(r.venue))}</b> ${px}</span>`)
  }
  return lines.join('')
}

function tapeCard(it) {
  const [label, cls] = tapeState(it)
  const pbe = it.pbe
  const pbeLine = pbe && pbe.algo_probability != null && pbe.market?.selection_price_bp != null
    ? `<span class="tape__l tape__l--pbe">PBE ${esc((pbe.algo_probability * 100).toFixed(1))}% · Market ${esc(cents(pbe.market.selection_price_bp))} · ${esc(((pbe.algo_probability * 100) - pbe.market.selection_price_bp / 100).toFixed(1))} pts</span>` : ''
  const href = it.destination?.url || null
  const inner = `<span class="tape__hd"><span class="tape__sp">${esc(SPORT_LABEL[it.sport] || String(it.sport || '').toUpperCase())}</span><span class="tape__st tape__st--${cls}">${esc(label)}</span></span>
    <span class="tape__ti">${esc(it.title || '')}</span>
    <span class="tape__bd">${pbeLine || tapeOutcomes(it)}${tapeVenueLines(it)}</span>`
  return href ? `<a class="tape__c" href="${esc(href)}" data-tape-event="${esc(`${it.sport}|${it.canonical_event_id}`)}">${inner}</a>` : `<span class="tape__c">${inner}</span>`
}

/** The rail: filter chips (only non-empty ones) + one horizontally scrolling row of fixed-size cards. */
export function marketTapeRail(payload, { filter = 'all', title = 'Market Tape' } = {}) {
  if (!payload?.classes) return ''
  const counts = Object.fromEntries(TAPE_FILTERS.map(([k]) => [k, tapeItems(payload, k).length]))
  if (!counts.all) return ''
  const f = counts[filter] ? filter : 'all'
  const chips = TAPE_FILTERS.filter(([k]) => counts[k]).map(([k, l]) => `<button type="button" class="tape__f${k === f ? ' is-on' : ''}" data-tape-filter="${k}" aria-pressed="${k === f}">${esc(l)}</button>`).join('')
  const cards = tapeItems(payload, f).slice(0, 24).map(tapeCard).join('')
  return `<section class="tape" data-tape aria-label="Market tape: prediction-market prices across PropBetEdge">
    <div class="tape__top"><span class="tape__name">${esc(title)}</span><span class="tape__fs" role="group" aria-label="Filter">${chips}</span></div>
    <div class="tape__row" data-tape-row>${cards}</div>
    <p class="tape__ft">Prediction-market prices (${tapeItems(payload, f).some((x) => tapeVenueLines(x)) ? 'Kalshi, Polymarket' : 'Kalshi'}) · movement since first observed · not sportsbook odds or a PropBetEdge model</p>
  </section>`
}

/** Wire filter chips and in-place refresh. load(): Promise<payload>; refreshMs default 30 s. Returns stop(). */
export function mountMarketTape(host, load, { refreshMs = 30000, title } = {}) {
  if (!host) return () => {}
  let filter = 'all', last = null, t = 0, dead = false
  const paint = () => {
    const html = marketTapeRail(last, { filter, title })
    const row = host.querySelector('[data-tape-row]')
    if (row && html) {
      // in place: swap chips + cards only, keep the scroller element (and its scroll position)
      const tmp = document.createElement('div'); tmp.innerHTML = html
      const left = row.scrollLeft
      host.querySelector('.tape__fs').innerHTML = tmp.querySelector('.tape__fs').innerHTML
      row.innerHTML = tmp.querySelector('[data-tape-row]').innerHTML
      row.scrollLeft = left
    } else host.innerHTML = html
  }
  host.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-tape-filter]')
    if (!b) return
    filter = b.dataset.tapeFilter
    const row = host.querySelector('[data-tape-row]'); if (row) row.scrollLeft = 0
    paint()
  })
  const tick = async () => {
    if (dead) return
    if (typeof document === 'undefined' || !document.hidden) { try { const p = await load(); if (p) { last = p; paint() } } catch {} }
    t = setTimeout(tick, refreshMs)
  }
  tick()
  return () => { dead = true; clearTimeout(t) }
}
