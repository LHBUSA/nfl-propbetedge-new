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
    return res.status(200).json(session);
  } catch (error) {
    console.error('[auth-session] session check unavailable', error?.message || error);
    return res.status(200).json({
      valid: false,
      pro: false,
      user: null,
      subscription: null,
      degraded: true,
      error: 'session_temporarily_unavailable'
    });
  }
}
