/* PropBetEdge NFL — session state for the browser.
 * getNflSession() never throws, so a backend failure can no longer be
 * disguised as "not logged in". Every response carries an explicit `stage`. */

import { getNflSession } from './_nfl-auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const session = await getNflSession(req);

    /* Stage + cookie counts only. No token bytes, no secrets. This is what
     * makes the auth loop observable in production. */
    console.log(
      '[auth-session] stage=%s valid=%s pro=%s cookies_current=%d cookies_legacy=%d%s',
      session.stage,
      session.valid,
      session.pro,
      session.cookies?.current ?? 0,
      session.cookies?.legacy ?? 0,
      session.reason ? ` reason=${session.reason}` : (session.error ? ` error=${session.error}` : '')
    );

    return res.status(200).json(session);
  } catch (error) {
    console.error('[auth-session] stage=handler_exception reason=%s', String(error?.message || error));
    return res.status(500).json({
      valid: false,
      pro: false,
      user: null,
      subscription: null,
      stage: 'handler_exception',
      degraded: true,
      error: 'session_check_failed',
    });
  }
}
