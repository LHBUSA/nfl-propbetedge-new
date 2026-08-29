/* PropBetEdge NFL — logout.
 *
 * The previous version only cleared `pbe_nfl_session` with
 * `Domain=.propbetedge.ai` — never the host-only cookie that auth-verify
 * actually sets — so logout could not end a real session. It now clears every
 * variant locally and does not depend on the Worker, which holds no session
 * state (the session is a stateless signed JWT). */

import { purgeCookies } from './_nfl-auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const cookies = purgeCookies({ includeCurrent: true });
  res.setHeader('Set-Cookie', cookies);
  console.log('[auth-logout] stage=cleared cookies_emitted=%d', cookies.length);
  return res.status(200).json({ ok: true, stage: 'cleared' });
}
