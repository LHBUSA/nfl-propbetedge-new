/**
 * Kalshi PERPETUALS partner offer — shared, framework-free (contract kalshi-partner/2).
 * CANONICAL SOURCE: propbetedge-workers/workers/propsports-markets/client/kalshi-partner.js
 * Products vendor this file unchanged. It is the ONLY place offer copy is written.
 *
 *   loadPartnerConfig(url)         GET <product>/go/kalshi-perps/config once per page (5 min session cache); failure -> disabled
 *   partnerHref(cfg, ctx, base)    first-party /go/kalshi-perps?placement=…&product=…&sport=… or null
 *   offerCopy(cfg, variant)        { kicker, title, sub, body, note, cta, share, disclosure } or null when disabled
 *   partnerOffer(cfg, ctx, opts)   one offer block (variant 'card' | 'module' | 'footer'), or '' when disabled
 *
 * Rules (owner, 2026-10-07):
 *  - this is Kalshi's PERPETUALS referral offer: the $50 requirement is ALWAYS "in perps / perpetual futures" and the
 *    10% discount is ALWAYS "off fees"; nothing says or implies that a sports / event prediction-market trade qualifies;
 *  - never placed beside a sports YES/NO price; never replaces "Open on Kalshi" (the canonical market link);
 *  - economics come only from the server's VERIFIED offer (kalshi-partner/2 `offer`); unverified -> generic copy
 *    "See current Kalshi partner offer", never stale numbers;
 *  - the link never carries a destination: /go/kalshi-perps answers 302 to the one configured referral URL;
 *  - rel="sponsored noopener noreferrer"; disclosure sits inside every block; disabled config renders nothing.
 */
export const PARTNER_CONTRACT = 'kalshi-partner/2'
export const PARTNER_PATH = '/go/kalshi-perps'
export const PARTNER_REL = 'sponsored noopener noreferrer'
export const PARTNER_DISCLOSURE = 'PropBetEdge may receive compensation from qualifying Kalshi referrals. Offer eligibility and terms are determined by Kalshi.'
export const PARTNER_INDEPENDENCE = 'Partner compensation does not affect PropBetEdge model probabilities, market comparisons, rankings, editorial conclusions, or research.'
export const PARTNER_GENERIC_CTA = 'See current Kalshi partner offer'
export const PARTNER_DISABLED = Object.freeze({ contract: PARTNER_CONTRACT, enabled: false })

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const MONEY = /^\$\d{1,3}(,\d{3})*$/
const PCT = /^\d{1,2}%$/
const TERM = /^\d{1,2} (month|months|year|years)$/
const KEY_RE = /^[a-z0-9_]{1,40}$/
const BASE_RE = /^(https:\/\/[a-z0-9.-]+)?$/

function cleanOffer(o) {
  if (!o || o.program !== 'perpetuals') return null
  const t = { qualifying_volume: o.qualifying_volume, user_discount: o.user_discount, user_discount_term: o.user_discount_term, pbe_revenue_share: o.pbe_revenue_share, pbe_revenue_term: o.pbe_revenue_term, last_verified_at: o.last_verified_at }
  return MONEY.test(t.qualifying_volume) && PCT.test(t.user_discount) && TERM.test(t.user_discount_term) && PCT.test(t.pbe_revenue_share) && TERM.test(t.pbe_revenue_term) ? t : null
}

// Only a config that names exactly the first-party route is honoured; anything else is "disabled".
export function normalizeConfig(body) {
  if (!body || body.contract !== PARTNER_CONTRACT || body.enabled !== true || body.path !== PARTNER_PATH || body.program !== 'perpetuals') return PARTNER_DISABLED
  return { contract: PARTNER_CONTRACT, enabled: true, path: PARTNER_PATH, program: 'perpetuals', offer: cleanOffer(body.offer ? { ...body.offer, program: 'perpetuals' } : null) }
}

// ctx = { placement, product, sport } (aggregate attribution only). base = '' (same-origin rewrite) or an https origin.
export function partnerHref(cfg, ctx = {}, base = '') {
  if (!cfg || cfg.enabled !== true || cfg.path !== PARTNER_PATH || !BASE_RE.test(base)) return null
  const q = new URLSearchParams()
  for (const k of ['placement', 'product', 'sport']) if (ctx[k] && KEY_RE.test(String(ctx[k]))) q.set(k, String(ctx[k]))
  const qs = q.toString()
  return `${base}${PARTNER_PATH}${qs ? `?${qs}` : ''}`
}

const titleTerm = (t) => t.replace(/\b(month|months|year|years)\b/, (w) => w[0].toUpperCase() + w.slice(1)) // "3 months" -> "3 Months"
const upTo = (t) => (t === '1 year' ? 'one year' : t)

// Copy per variant. Every sentence that names the volume names PERPS; every discount names FEES.
export function offerCopy(cfg, variant = 'module') {
  if (!cfg || cfg.enabled !== true) return null
  const o = cfg.offer
  const base = { disclosure: PARTNER_DISCLOSURE }
  if (!o) return { ...base, verified: false, kicker: 'KALSHI PARTNER', title: null, sub: null, body: null, note: null, share: null, cta: PARTNER_GENERIC_CTA }
  const vol = o.qualifying_volume, disc = o.user_discount, term = o.user_discount_term
  const share = `PropBetEdge may earn ${o.pbe_revenue_share} of referred users' perpetuals trading fees for up to ${upTo(o.pbe_revenue_term)}, subject to Kalshi terms.`
  if (variant === 'card') return { ...base, verified: true, kicker: 'KALSHI PARTNER OFFER', title: `Trade ${vol} in Perpetual Futures`, sub: `Get ${disc} Off Fees for ${titleTerm(term)}`, body: null, note: 'New customers only.', share: null, cta: 'CLAIM OFFER' }
  if (variant === 'footer') return { ...base, verified: true, kicker: 'NEW TO KALSHI?', title: null, sub: null, body: `Kalshi is currently offering referred users: trade ${vol} in perpetual futures → receive ${disc} off fees for ${term}.`, note: null, share: null, cta: 'VIEW OFFER' }
  if (variant === 'short') return { ...base, verified: true, kicker: 'KALSHI PERPS OFFER', title: null, sub: null, body: null, note: null, share: null, cta: `Trade ${vol} · Get ${disc} Off Fees for ${titleTerm(term)}` }
  return { ...base, verified: true, kicker: 'KALSHI PERPETUALS', title: `Trade ${vol} in Perps`, sub: `${disc} Off Fees · First ${titleTerm(term)}`, body: null, note: 'New Kalshi customers only. Perpetual futures trading only.', share, cta: 'NEW CUSTOMER OFFER' }
}

// opts: { variant: 'card'|'module'|'footer'|'short', base, cls ('kxo' default; the product styles it) }
export function partnerOffer(cfg, ctx = {}, opts = {}) {
  const href = partnerHref(cfg, ctx, opts.base || '')
  const c = href && offerCopy(cfg, opts.variant || 'module')
  if (!c) return ''
  const k = /^[a-z][a-z0-9_-]{0,30}$/i.test(opts.cls || '') ? opts.cls : 'kxo'
  const v = esc(opts.variant || 'module')
  const line = (cls, text) => (text ? `<span class="${k}__${cls}">${esc(text)}</span>` : '')
  return `<aside class="${k} ${k}--${v}${c.verified ? '' : ` ${k}--generic`}" aria-label="Kalshi partner offer" data-kxo-placement="${esc(ctx.placement || '')}">`
    + line('kicker', c.kicker) + line('title', c.title) + line('sub', c.sub) + line('body', c.body) + line('note', c.note)
    + `<a class="${k}__cta" href="${esc(href)}" target="_blank" rel="${PARTNER_REL}">${esc(c.cta)} <span aria-hidden="true">→</span></a>`
    + line('share', c.share) + line('disc', c.disclosure)
    + '</aside>'
}

const CACHE_KEY = 'pbe:kalshi-partner:2'
const CACHE_MS = 5 * 60 * 1000
let pending = null
export function loadPartnerConfig(url, { fetchImpl = typeof fetch === 'function' ? fetch : null, storage = safeStorage(), now = Date.now } = {}) {
  if (pending) return pending
  try {
    const hit = storage && JSON.parse(storage.getItem(CACHE_KEY) || 'null')
    if (hit && now() - hit.at < CACHE_MS) return (pending = Promise.resolve(normalizeConfig(hit.body)))
  } catch { /* storage unavailable */ }
  if (!fetchImpl || !url) return (pending = Promise.resolve(PARTNER_DISABLED))
  pending = Promise.resolve()
    .then(() => fetchImpl(url, { credentials: 'omit' }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((body) => {
      // cache only a real answer; a failed read is retried on the next page
      if (body) try { storage && storage.setItem(CACHE_KEY, JSON.stringify({ at: now(), body })) } catch { /* ignore */ }
      return normalizeConfig(body)
    })
    .catch(() => PARTNER_DISABLED)
  return pending
}
export function _resetPartnerConfig() { pending = null }

function safeStorage() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null } catch { return null }
}
