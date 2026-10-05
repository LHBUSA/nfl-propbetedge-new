/* PropBetEdge NFL — session state for the browser.
 * getNflSession() never throws, so a backend failure can no longer be
 * disguised as "not logged in". Every response carries an explicit `stage`. */

import { getNflSession, nflMembership } from './_nfl-auth.js';

/* The failure answer carries the shared membership contract too: FREE, with
   no email (an outage tells the browser nothing about the identity). */
const FREE_MEMBERSHIP = Object.freeze(nflMembership({ entitled: false }));

/* A verified email without a current NFL entitlement is NOT an NFL customer:
 * pro stays false, and every premium route refuses this verdict on its own
 * (getNflSession is the authority there, unchanged). Owner decision
 * 2026-10-05 ("keep lapsed sessions"): the reader nevertheless stays visibly
 * signed in -- the verified session cookie is kept and the answer carries the
 * verified email -- so the account sheet can say "NFL Pro access is no longer
 * active" and offer renewal instead of throwing a lapsed member back to the
 * anonymous sales view. The denial reasons stay so the copy is truthful
 * (expired / canceled / payment failed vs never subscribed). Invalid, expired
 * or forged cookies never reach this path (getNflSession returns them signed
 * out), and the degraded/outage path is unchanged. */
export function paywalledAnswer(session) {
  const email = session?.valid === true ? String(session.user?.email || '').trim() : '';
  return {
    valid: Boolean(email), pro: false, access: 'no_entitlement', paywalled: true, role: null,
    entitlement: session.entitlement ? { reason: session.entitlement.reason || null } : null,
    user: email ? { email } : null, subscription: null, authority: session.authority, stage: session.stage,
    cookies: session.cookies, degraded: false, session_cleared: false,
    /* the contract's non-entitled state, exactly as getNflSession built it */
    membership: email && session.membership ? session.membership : FREE_MEMBERSHIP,
  };
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const session = await getNflSession(req);

    /* Stage + cookie counts only. No token bytes, no secrets. This is what
     * makes the auth loop observable in production. */
    console.log(
      '[auth-session] stage=%s access=%s valid=%s pro=%s cookies_current=%d cookies_legacy=%d%s',
      session.stage,
      session.access,
      session.valid,
      session.pro,
      session.cookies?.current ?? 0,
      session.cookies?.legacy ?? 0,
      session.reason ? ` reason=${session.reason}` : (session.error ? ` error=${session.error}` : '')
    );

    if (session.access === 'no_entitlement') {
      /* Lapsed / not entitled: keep the verified session (no purge), pro false. */
      return res.status(200).json(paywalledAnswer(session));
    }

    return res.status(200).json(session);
  } catch (error) {
    console.error('[auth-session] stage=handler_exception reason=%s', String(error?.message || error));
    return res.status(500).json({
      valid: false,
      pro: false,
      access: 'unavailable',
      role: null,
      entitlement: null,
      user: null,
      subscription: null,
      stage: 'handler_exception',
      degraded: true,
      error: 'session_check_failed',
      membership: FREE_MEMBERSHIP,
    });
  }
}
