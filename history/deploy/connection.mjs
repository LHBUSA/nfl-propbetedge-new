/**
 * How a Worker will connect to the history database.
 *
 * Not deployed. This is the connection contract the future Worker uses, written
 * now so the API, the checks and the Worker cannot drift apart later.
 *
 * Two things are non-negotiable and both are enforced here rather than left to
 * each endpoint:
 *
 *   1. The connection is the READER role. The API has no path that can write.
 *   2. Every request sets app.surface before it reads anything, so the rights
 *      policies decide what exists. A request that fails to set it sees the
 *      public surface, because that is the default in SQL — the failure mode is
 *      showing too little, never too much.
 *
 * Hyperdrive pools connections at the edge and the pool is shared between
 * requests, so app.surface is set with SET LOCAL inside the transaction that
 * runs the query. A plain SET would leak one request's surface into the next
 * request that reused the connection — which, with a pro or internal surface,
 * is exactly the kind of leak this whole design exists to prevent.
 */

export const SURFACES = ['public', 'pro', 'internal'];

export function normaliseSurface(requested) {
  return SURFACES.includes(requested) ? requested : 'public';
}

/**
 * Wrap a postgres client into the query function history-api.mjs expects.
 *
 * @param {{ connect(): Promise<any> }} pool  e.g. new Client(env.HYPERDRIVE.connectionString)
 * @param {string} surface                    resolved from the caller's entitlement, never from a query string alone
 */
export function createSurfaceQuery(pool, surface) {
  const chosen = normaliseSurface(surface);
  return async function query(sql, params = []) {
    const client = await pool.connect();
    try {
      await client.query('begin read only');
      // set_config(..., true) is SET LOCAL: it lasts for this transaction and
      // cannot outlive it onto the next request that borrows this connection.
      await client.query('select set_config($1, $2, true)', ['app.surface', chosen]);
      const result = await client.query(sql, params);
      await client.query('commit');
      return { rows: result.rows };
    } catch (error) {
      try { await client.query('rollback'); } catch { /* the connection is going back to the pool anyway */ }
      throw error;
    } finally {
      client.release?.();
    }
  };
}

/**
 * The surface a caller is entitled to. Entitlement comes from the existing NFL
 * session, never from the request: a query parameter may only narrow.
 */
export function surfaceFor({ entitlement = null, requested = null } = {}) {
  const entitled = entitlement === 'internal' ? 'internal' : entitlement === 'pro' ? 'pro' : 'public';
  if (!requested) return entitled;
  const rank = { public: 0, pro: 1, internal: 2 };
  return rank[normaliseSurface(requested)] < rank[entitled] ? normaliseSurface(requested) : entitled;
}
