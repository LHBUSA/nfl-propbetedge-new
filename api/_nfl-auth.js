import { createHmac, timingSafeEqual } from 'node:crypto';

const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const COOKIE_NAME = 'pbe_nfl_session';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function decodeBase64Url(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function verifyWorkerJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token_shape');
  const data = `${parts[0]}.${parts[1]}`;
  const actual = decodeBase64Url(parts[2]);
  const expected = createHmac('sha256', `pbe-nfl-auth-v5:${secret}`).update(data).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('token_signature');
  const payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  if (payload?.type !== 'session') throw new Error('token_type');
  if (!payload?.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) throw new Error('token_expired');
  const email = String(payload?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('token_email');
  return { ...payload, email };
}

async function entitlementByEmail(email, secret) {
  const base = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const q = `customer_email=ilike.${encodeURIComponent(email)}&select=status,current_period_end,cancel_at_period_end,stripe_price_id,created_at&order=created_at.desc&limit=10`;
  const response = await fetch(`${base}/rest/v1/nfl_subscriptions?${q}`, {
    headers: {
      apikey: secret,
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`entitlement_${response.status}`);
  const rows = await response.json().catch(() => []);
  const now = Date.now();
  const row = (Array.isArray(rows) ? rows : []).find(item => {
    const status = String(item?.status || '').toLowerCase();
    return ['active', 'trialing'].includes(status) && (!item?.current_period_end || Date.parse(item.current_period_end) > now);
  });
  return row ? {
    status: row.status,
    current_period_end: row.current_period_end || null,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
    stripe_price_id: row.stripe_price_id || null,
  } : null;
}

async function localSession(req) {
  const token = readCookie(req.headers.cookie || '', COOKIE_NAME);
  if (!token) return { valid: false, pro: false, user: null, subscription: null, authority: 'local-cookie' };
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('local_session_secret_missing');
  const payload = verifyWorkerJwt(token, secret);
  const subscription = await entitlementByEmail(payload.email, secret);
  return {
    valid: true,
    pro: Boolean(subscription),
    user: { email: payload.email },
    subscription,
    authority: 'local-cookie',
  };
}

async function workerSession(req) {
  const workerBase = String(process.env.NFL_AUTH_WORKER_URL || DEFAULT_AUTH_WORKER_URL).trim().replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`${workerBase}/v1/auth/session`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        origin: APP_ORIGIN,
        cookie: req.headers.cookie || '',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error || `auth_session_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return { ...body, authority: 'cloudflare-worker' };
  } finally {
    clearTimeout(timer);
  }
}

export async function getNflSession(req) {
  try {
    return await localSession(req);
  } catch (localError) {
    try {
      return await workerSession(req);
    } catch (workerError) {
      const error = new Error(`session_unavailable:${localError?.message || 'local'}:${workerError?.message || 'worker'}`);
      error.status = 503;
      throw error;
    }
  }
}

export function verifiedEmail(session) {
  const email = String(session?.user?.email || '').trim().toLowerCase();
  return session?.valid && /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
