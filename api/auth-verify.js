import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const COOKIE_NAME = 'pbe_nfl_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function decodeBase64Url(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function encodeBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signPayload(payload, secret) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = encodeBase64Url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac('sha256', `pbe-nfl-auth-v5:${secret}`).update(data).digest();
  return `${data}.${encodeBase64Url(sig)}`;
}

function verifyMagicToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token_shape');
  const data = `${parts[0]}.${parts[1]}`;
  const actual = decodeBase64Url(parts[2]);
  const expected = createHmac('sha256', `pbe-nfl-auth-v5:${secret}`).update(data).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('token_signature');

  const payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  if (payload?.type !== 'magic') throw new Error('token_type');
  if (!payload?.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) throw new Error('token_expired');
  const email = String(payload?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new Error('token_email');
  return { ...payload, email };
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearLegacyDomainCookie() {
  return `${COOKIE_NAME}=; Domain=.propbetedge.ai; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const token = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  if (!token || token.length > 500) return res.redirect(302, `${APP_ORIGIN}/?auth=invalid`);

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    console.error('[auth-verify] SUPABASE_SERVICE_ROLE_KEY missing in Vercel');
    return res.redirect(302, `${APP_ORIGIN}/?auth=server_secret_missing`);
  }

  try {
    const magic = verifyMagicToken(token, secret);
    const now = Math.floor(Date.now() / 1000);
    const session = signPayload({
      email: magic.email,
      type: 'session',
      iat: now,
      exp: now + SESSION_MAX_AGE,
      jti: randomUUID(),
    }, secret);

    // Clear the old domain-scoped cookie first, then set one authoritative
    // host-only cookie from nfl.propbetedge.ai itself.
    res.setHeader('Set-Cookie', [
      clearLegacyDomainCookie(),
      sessionCookie(session),
    ]);
    return res.redirect(302, `${APP_ORIGIN}/?auth=complete&session=established`);
  } catch (error) {
    const reason = error?.message || 'invalid';
    console.error('[auth-verify] magic verification failed', reason);
    return res.redirect(302, `${APP_ORIGIN}/?auth=${encodeURIComponent(reason)}`);
  }
}
