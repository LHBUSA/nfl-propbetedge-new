/**
 * Kalshi Market Intelligence data client — shared, framework-free (contract market-intel/1).
 * CANONICAL SOURCE: propbetedge-workers/workers/propsports-markets/client/kalshi-market-client.js
 * Products vendor this file unchanged. The browser never calls Kalshi; it polls our
 * propsports-markets API, whose ingest is independent, so polling here adds no Kalshi traffic.
 * One in-flight request per resource is shared by every caller; failures resolve to nothing.
 */
export const POLL_MS = { live: 20_000, pregame: 45_000, idle: 120_000 }
const BOARD_TTL_MS = 15_000
const EVENT_TTL_MS = 15_000

export function createKalshiClient({ base = 'https://propsports-markets.sales-fd3.workers.dev', sport, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  if (!sport) throw new Error('sport required')
  const root = String(base).replace(/\/+$/, '')
  let board = { at: 0, byEvent: new Map(), pending: null }
  const events = new Map()

  async function loadBoard({ force = false } = {}) {
    if (!force && Date.now() - board.at < BOARD_TTL_MS) return board.byEvent
    if (board.pending) return board.pending
    board.pending = (async () => {
      try {
        const res = await fetchImpl(`${root}/v1/market-intelligence/sport/${encodeURIComponent(sport)}`, { headers: { accept: 'application/json' } })
        const body = res.ok ? await res.json() : null
        const byEvent = new Map()
        if (body?.enabled && Array.isArray(body.events)) {
          // live entries AND completed ones (market lifecycle CLOSED/SETTLED with no live block, e.g. a field)
          for (const e of body.events) if (e?.event?.canonical_event_id && (e.kalshi || e.market?.lifecycle)) byEvent.set(String(e.event.canonical_event_id), e)
        }
        board = { at: Date.now(), byEvent, pending: null }
      } catch {
        board = { at: Date.now(), byEvent: board.byEvent, pending: null }
      }
      return board.byEvent
    })()
    return board.pending
  }

  function forEvent(eventId) {
    return board.byEvent.get(String(eventId)) || null
  }

  async function loadEvent(eventId, { force = false } = {}) {
    const id = String(eventId)
    const hit = events.get(id)
    if (!force && hit && Date.now() - hit.at < EVENT_TTL_MS) return hit.value
    if (hit?.pending) return hit.pending
    const pending = (async () => {
      let value = null
      try {
        const res = await fetchImpl(`${root}/v1/market-intelligence/event/${encodeURIComponent(sport)}/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        const body = res.ok ? await res.json() : null
        value = body?.enabled && (body.event?.kalshi || body.event?.market_history || body.event?.market?.lifecycle) ? body.event : null
      } catch {
        value = hit?.value ?? null
      }
      events.set(id, { at: Date.now(), value, pending: null })
      return value
    })()
    events.set(id, { at: hit?.at ?? 0, value: hit?.value ?? null, pending })
    return pending
  }

  /** state: 'live' | 'pregame' | anything else (idle). */
  function pollMsFor(state) {
    return state === 'live' ? POLL_MS.live : state === 'pregame' ? POLL_MS.pregame : POLL_MS.idle
  }

  return { loadBoard, forEvent, loadEvent, pollMsFor, sport }
}
