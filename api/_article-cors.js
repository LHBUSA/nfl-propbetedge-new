/* Cross-origin read for the propbetedge.ai news Article Market module.
 *
 * The news article (https://propbetedge.ai/news/...) hydrates its NFL PBE
 * context from view=game on /api/pbe-picks and /api/pbe-touchdown-targets with
 * credentials: 'include'. propbetedge.ai and nfl.propbetedge.ai are the same
 * site, so the host-only SameSite=Lax NFL session cookie rides along; the tier
 * is still decided here, server-side, by the same getNflSession() authority.
 *
 * Only view=game, only the exact news origins, never a wildcard (a wildcard
 * cannot carry credentials anyway). Responses stay private, no-store; Vary
 * keeps any intermediary from reusing one reader's answer for another.
 */
export const ARTICLE_ORIGINS = Object.freeze(['https://propbetedge.ai', 'https://www.propbetedge.ai']);

export function articleCors(req, res) {
  res.setHeader('vary', 'Origin, Cookie');
  const origin = req.headers?.origin;
  if (!ARTICLE_ORIGINS.includes(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  return true;
}
