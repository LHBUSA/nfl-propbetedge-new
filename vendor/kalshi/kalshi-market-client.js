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
const DESK_TTL_MS = 30_000

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
        if (!res.ok) throw new Error(`board ${res.status}`) // a failed read is never cached as 'no markets'
        const body = await res.json()
        const byEvent = new Map()
        if (body?.enabled && Array.isArray(body.events)) {
          // live entries AND completed ones (market lifecycle CLOSED/SETTLED with no live block, e.g. a field)
          for (const e of body.events) if (e?.event?.canonical_event_id && (e.kalshi || e.market?.lifecycle)) byEvent.set(String(e.event.canonical_event_id), e)
        }
        board = { at: Date.now(), byEvent, pending: null }
      } catch {
        board = { at: 0, byEvent: board.byEvent, pending: null } // failure: keep last good board, retry on the next call
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
        if (!res.ok) throw new Error(`event ${res.status}`) // a failed read is never cached as 'no market'
        const body = await res.json()
        value = body?.enabled && (body.event?.kalshi || body.event?.market_history || body.event?.market?.lifecycle) ? body.event : null
      } catch {
        // failure: keep the last good value but do NOT cache it, so the next poll retries immediately
        events.set(id, { at: 0, value: hit?.value ?? null, pending: null })
        return hit?.value ?? null
      }
      events.set(id, { at: Date.now(), value, pending: null })
      return value
    })()
    events.set(id, { at: hit?.at ?? 0, value: hit?.value ?? null, pending })
    return pending
  }

  /**
   * Multi-venue desk for ONE canonical event: GET /v1/market-desk?sport=&event= (other venues — Polymarket today —
   * as qualifying quotes or labelled related markets). The shared Worker's POLYMARKET_DISPLAY_ENABLED kill switch
   * governs whether any second venue appears. Resolves the desk event or null; a failed read is never cached.
   */
  const desks = new Map()
  async function loadDesk(eventId, { force = false } = {}) {
    const id = String(eventId)
    const hit = desks.get(id)
    if (!force && hit && Date.now() - hit.at < DESK_TTL_MS) return hit.value
    if (hit?.pending) return hit.pending
    const pending = (async () => {
      try {
        const res = await fetchImpl(`${root}/v1/market-desk?sport=${encodeURIComponent(sport)}&event=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`desk ${res.status}`)
        const body = await res.json()
        const value = (body?.events || []).find((e) => String(e.canonical_event_id) === id) || null
        desks.set(id, { at: Date.now(), value, pending: null })
        return value
      } catch {
        desks.set(id, { at: 0, value: hit?.value ?? null, pending: null })
        return hit?.value ?? null
      }
    })()
    desks.set(id, { at: hit?.at ?? 0, value: hit?.value ?? null, pending })
    return pending
  }

  /**
   * Desk board for the sport (GET /v1/market-desk?sport=): Map canonical id -> desk event, for compact venue cues on
   * list surfaces. 30 s cache, one in-flight request; a failed read keeps the last good map (never cached as empty).
   */
  let deskBoard = { at: 0, byEvent: new Map(), pending: null }
  async function loadDeskBoard({ force = false } = {}) {
    if (!force && Date.now() - deskBoard.at < DESK_TTL_MS) return deskBoard.byEvent
    if (deskBoard.pending) return deskBoard.pending
    deskBoard.pending = (async () => {
      try {
        const res = await fetchImpl(`${root}/v1/market-desk?sport=${encodeURIComponent(sport)}`, { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`desk board ${res.status}`)
        const body = await res.json()
        const byEvent = new Map((body?.events || []).map((e) => [String(e.canonical_event_id), e]))
        deskBoard = { at: Date.now(), byEvent, pending: null }
      } catch {
        deskBoard = { at: 0, byEvent: deskBoard.byEvent, pending: null }
      }
      return deskBoard.byEvent
    })()
    return deskBoard.pending
  }
  const deskFor = (eventId) => deskBoard.byEvent.get(String(eventId)) || null

  /** state: 'live' | 'pregame' | anything else (idle). */
  function pollMsFor(state) {
    return state === 'live' ? POLL_MS.live : state === 'pregame' ? POLL_MS.pregame : POLL_MS.idle
  }

  return { loadBoard, forEvent, loadEvent, loadDesk, loadDeskBoard, deskFor, pollMsFor, sport }
}

/** Network Market Tape (all sports): GET /v1/market-tape. Failures resolve null (never cached as empty). */
export function createTapeClient({ base = 'https://propsports-markets.sales-fd3.workers.dev', fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const root = String(base).replace(/\/+$/, '')
  return {
    async load({ sport = null, limit = 24 } = {}) {
      try {
        const q = new URLSearchParams({ limit: String(limit) }); if (sport) q.set('sport', sport)
        const res = await fetchImpl(`${root}/v1/market-tape?${q}`, { headers: { accept: 'application/json' } })
        if (!res.ok) return null
        return await res.json()
      } catch { return null }
    },
  }
}
