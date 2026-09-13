/* PropBetEdge NFL — server-side access to nfl-api.propbetedge.ai.
 *
 * Every Vercel function that reads the gateway goes through here so the
 * server-only gateway token (NFL_GATEWAY_TOKEN) is attached in one place. The
 * browser never sees it. Until the gateway enforces the token
 * (workers/nfl-gateway REQUIRE_GATEWAY_TOKEN), sending it is harmless.
 */

const DEFAULT_GATEWAY = 'https://nfl-api.propbetedge.ai';
export const GATEWAY_TOKEN_HEADER = 'x-pbe-gateway-token';

export function gatewayBase() {
  return String(process.env.NFL_GATEWAY || DEFAULT_GATEWAY).trim().replace(/\/$/, '');
}

export function gatewayHeaders(extra = {}) {
  const headers = { ...extra };
  const token = String(process.env.NFL_GATEWAY_TOKEN || '').trim();
  if (token) headers[GATEWAY_TOKEN_HEADER] = token;
  return headers;
}
