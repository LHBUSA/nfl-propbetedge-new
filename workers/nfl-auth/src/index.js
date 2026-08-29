const SERVICE = 'propbetedge-nfl-auth';
const VERSION = 'v3.0';
const DEFAULT_APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const PBE_LOGO = 'https://propbetedge.ai/logo/pbe-full-400.png';
const COOKIE_NAME = 'pbe_nfl_session';
const COOKIE_DOMAIN = '.propbetedge.ai';
const MAGIC_TTL_SEC = 15 * 60;
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const RATE_WINDOW_SEC = 60 * 60;
const RATE_LIMIT_EMAIL = 10;
const RATE_LIMIT_IP = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const appOrigin = String(env.APP_ORIGIN || DEFAULT_APP_ORIGIN).replace(/\/$/, '');
    const requestOrigin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (requestOrigin && requestOrigin !== appOrigin) return json({ error: 'origin_not_allowed' }, 403, requestOrigin, appOrigin);
      return new Response(null, { status: 204, headers: cors(requestOrigin, appOrigin) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      const requirements = requiredSecrets(env);
      return json({
        ok: Object.values(requirements).every(Boolean),
        service: SERVICE,
        version: VERSION,
        auth_issuer: 'propbetedge',
        session_store: 'supabase_private_ledger',
        email_transport: 'resend',
        fallback: false,
        requirements,
        magic_ttl_min: MAGIC_TTL_SEC / 60,
        session_ttl_days: SESSION_TTL_SEC / 86400,
        rate_limits: { email_per_hour: RATE_LIMIT_EMAIL, ip_per_hour: RATE_LIMIT_IP },
      }, 200, requestOrigin, appOrigin);
    }

    if ((url.pathname === '/v1/auth/request' || url.pathname === '/v1/auth/email') && request.method === 'POST') {
      if (requestOrigin && requestOrigin !== appOrigin) return json({ error: 'origin_not_allowed' }, 403, requestOrigin, appOrigin);
      return handleRequest(request, env, requestOrigin, appOrigin);
    }

    if (url.pathname === '/v1/auth/verify' && request.method === 'GET') {
      return handleVerify(request, env, appOrigin);
    }

    if (url.pathname === '/v1/auth/session' && request.method === 'GET') {
      return handleSession(request, env, requestOrigin, appOrigin);
    }

    if (url.pathname === '/v1/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env, requestOrigin, appOrigin);
    }

    return json({
      error: 'not_found',
      service: SERVICE,
      version: VERSION,
      routes: ['POST /v1/auth/request','GET /v1/auth/verify','GET /v1/auth/session','POST /v1/auth/logout','GET /health']
    }, 404, requestOrigin, appOrigin);
  },
};

async function handleRequest(request, env, requestOrigin, appOrigin) {
  const requirements = requiredSecrets(env);
  if (!Object.values(requirements).every(Boolean)) {
    console.error(`[${SERVICE}] missing configuration`);
    return json({ error: 'service_unavailable', provider: 'resend', auth_issuer: 'propbetedge' }, 503, requestOrigin, appOrigin);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400, requestOrigin, appOrigin); }

  const email = String(payload?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    return json({ error: 'Enter a valid email address.' }, 400, requestOrigin, appOrigin);
  }

  const requestId = crypto.randomUUID();
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipHash = await sha256Hex(ip);
    const since = new Date(Date.now() - RATE_WINDOW_SEC * 1000).toISOString();
    const [emailAttempts, ipAttempts] = await Promise.all([
      recentMagicCount(env, 'email', email, since, RATE_LIMIT_EMAIL + 1),
      recentMagicCount(env, 'request_ip_hash', ipHash, since, RATE_LIMIT_IP + 1),
    ]);

    if (emailAttempts >= RATE_LIMIT_EMAIL) {
      return json({ error: 'Too many sign-in attempts for this email. Try again later.' }, 429, requestOrigin, appOrigin, { 'Retry-After': String(RATE_WINDOW_SEC) });
    }
    if (ipAttempts >= RATE_LIMIT_IP) {
      return json({ error: 'Too many sign-in requests from this network. Try again later.' }, 429, requestOrigin, appOrigin, { 'Retry-After': String(RATE_WINDOW_SEC) });
    }

    const rawToken = randomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_TTL_SEC * 1000).toISOString();

    const insert = await dbFetch(env, '/rest/v1/nfl_auth_magic_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ token_hash: tokenHash, email, request_ip_hash: ipHash, expires_at: expiresAt }),
    });
    if (!insert.ok) throw new Error(`magic_token_insert_${insert.status}`);

    const magicUrl = `${appOrigin}/api/auth-verify?token=${encodeURIComponent(rawToken)}`;
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [email],
        subject: 'PropBetEdge NFL — your secure access is ready',
        html: emailHtml(magicUrl),
        text: emailText(magicUrl),
        tags: [
          { name: 'product', value: 'nfl' },
          { name: 'message', value: 'secure-access' },
        ],
      }),
    });

    if (!resendResponse.ok) {
      const detail = await resendResponse.text().catch(() => '');
      console.error(`[${SERVICE}] resend_failed`, requestId, resendResponse.status, detail.slice(0, 240));
      throw new Error(`resend_${resendResponse.status}`);
    }

    console.log(`[${SERVICE}] magic_sent`, requestId, email);
    return json({
      ok: true,
      provider: 'resend',
      auth_issuer: 'propbetedge',
      message: 'Check your inbox. Your PropBetEdge NFL sign-in link is on the way.',
      request_id: requestId,
    }, 200, requestOrigin, appOrigin);
  } catch (error) {
    console.error(`[${SERVICE}] request_failed`, requestId, error instanceof Error ? error.message : String(error));
    return json({ error: 'Could not send the sign-in email.', request_id: requestId }, 502, requestOrigin, appOrigin);
  }
}

async function handleVerify(request, env, appOrigin) {
  const url = new URL(request.url);
  const rawToken = String(url.searchParams.get('token') || '');
  if (rawToken.length < 20 || rawToken.length > 500) return verifyErrorPage('This sign-in link is invalid.', appOrigin);

  try {
    const tokenHash = await sha256Hex(rawToken);
    const sessionToken = randomToken(32);
    const sessionHash = await sha256Hex(sessionToken);
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
    const consume = await dbFetch(env, '/rest/v1/rpc/nfl_auth_consume_magic_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        p_token_hash: tokenHash,
        p_session_hash: sessionHash,
        p_session_expires_at: sessionExpiresAt,
      }),
    });
    if (!consume.ok) throw new Error(`consume_${consume.status}`);
    const email = await consume.json().catch(() => null);
    if (!email) return verifyErrorPage('This sign-in link has expired or has already been used. Request a new one.', appOrigin);

    console.log(`[${SERVICE}] session_issued`, String(email));
    return new Response(null, {
      status: 302,
      headers: {
        location: `${appOrigin}/?auth=complete`,
        'set-cookie': buildSessionCookie(sessionToken),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    console.error(`[${SERVICE}] verify_failed`, error instanceof Error ? error.message : String(error));
    return verifyErrorPage('Sign-in failed. Please request a new secure link.', appOrigin);
  }
}

async function handleSession(request, env, requestOrigin, appOrigin) {
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return json({ valid: false, pro: false, user: null, subscription: null }, 200, requestOrigin, appOrigin);

  try {
    const sessionHash = await sha256Hex(raw);
    const response = await dbFetch(env, '/rest/v1/rpc/nfl_auth_session_state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_session_hash: sessionHash }),
    });
    if (!response.ok) throw new Error(`session_state_${response.status}`);
    const rows = await response.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.email) {
      return json({ valid: false, pro: false, user: null, subscription: null }, 200, requestOrigin, appOrigin, { 'set-cookie': buildClearCookie() });
    }

    const subscription = row.pro ? {
      status: row.status || 'active',
      current_period_end: row.current_period_end || null,
      cancel_at_period_end: Boolean(row.cancel_at_period_end),
      stripe_price_id: row.stripe_price_id || null,
    } : null;

    return json({
      valid: true,
      pro: Boolean(row.pro),
      user: { email: String(row.email).toLowerCase() },
      subscription,
    }, 200, requestOrigin, appOrigin);
  } catch (error) {
    console.error(`[${SERVICE}] session_failed`, error instanceof Error ? error.message : String(error));
    return json({ error: 'session_unavailable' }, 503, requestOrigin, appOrigin);
  }
}

async function handleLogout(request, env, requestOrigin, appOrigin) {
  const raw = readCookie(request, COOKIE_NAME);
  try {
    if (raw) {
      const sessionHash = await sha256Hex(raw);
      await dbFetch(env, `/rest/v1/nfl_auth_sessions?session_hash=eq.${encodeURIComponent(sessionHash)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
    }
  } catch (error) {
    console.error(`[${SERVICE}] logout_revoke_failed`, error instanceof Error ? error.message : String(error));
  }
  return json({ ok: true }, 200, requestOrigin, appOrigin, { 'set-cookie': buildClearCookie() });
}

function requiredSecrets(env) {
  return {
    RESEND_API_KEY: Boolean(env.RESEND_API_KEY),
    RESEND_FROM_EMAIL: Boolean(env.RESEND_FROM_EMAIL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

function supabaseUrl(env) {
  return String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

function dbHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    ...extra,
  };
}

function dbFetch(env, path, init = {}) {
  return fetch(`${supabaseUrl(env)}${path}`, {
    ...init,
    headers: dbHeaders(env, init.headers || {}),
    cache: 'no-store',
  });
}

async function recentMagicCount(env, column, value, since, limit) {
  const path = `/rest/v1/nfl_auth_magic_tokens?select=token_hash&${column}=eq.${encodeURIComponent(value)}&created_at=gte.${encodeURIComponent(since)}&limit=${limit}`;
  const response = await dbFetch(env, path);
  if (!response.ok) throw new Error(`rate_limit_${column}_${response.status}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function buildSessionCookie(token) {
  return [
    `${COOKIE_NAME}=${token}`,
    `Domain=${COOKIE_DOMAIN}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function buildClearCookie() {
  return [
    `${COOKIE_NAME}=`,
    `Domain=${COOKIE_DOMAIN}`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function cors(requestOrigin, appOrigin) {
  return {
    'access-control-allow-origin': !requestOrigin || requestOrigin === appOrigin ? appOrigin : 'null',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body, status, requestOrigin, appOrigin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors(requestOrigin, appOrigin),
      ...extra,
    },
  });
}

function verifyErrorPage(message, appOrigin) {
  const safe = escapeHtml(message);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PropBetEdge NFL sign-in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#0b0e12;color:#f7f3ea;font-family:Arial,sans-serif}.card{width:min(440px,100%);padding:32px;border:1px solid rgba(212,175,55,.22);border-radius:18px;background:#15130f;box-shadow:0 24px 70px rgba(0,0,0,.4)}h1{margin:0 0 12px;font-size:26px}p{color:#bbb4a7;line-height:1.6}.btn{display:inline-block;margin-top:14px;padding:13px 18px;border-radius:9px;background:#d4af37;color:#161008;text-decoration:none;font-weight:800}</style></head><body><div class="card"><h1>Secure sign-in problem</h1><p>${safe}</p><a class="btn" href="${escapeAttr(appOrigin)}">Back to PropBetEdge NFL</a></div></body></html>`, {
    status: 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function emailHtml(actionLink) {
  const href = escapeAttr(actionLink);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>PropBetEdge NFL secure access</title></head><body style="margin:0;padding:0;background:#080b10;color:#f7f3ea;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Your secure PropBetEdge NFL access link is ready.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#080b10"><tr><td align="center" style="padding:36px 16px 48px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#11161d;border:1px solid #30291d;border-radius:22px;overflow:hidden"><tr><td style="height:3px;background:#d4af37;font-size:0">&nbsp;</td></tr><tr><td style="padding:30px 34px 22px;background:linear-gradient(135deg,#17120d,#111820 52%,#0d1420)"><img src="${PBE_LOGO}" width="196" alt="PropBetEdge" style="display:block;width:196px;max-width:100%;height:auto;border:0"><div style="margin-top:18px;font-size:10px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:#d8b75b">NFL Intelligence OS · Secure Access</div></td></tr><tr><td style="padding:30px 34px 12px"><div style="font-size:13px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#8f98a6">Access request confirmed</div><h1 style="margin:8px 0 14px;font-size:40px;line-height:1.03;letter-spacing:-1.2px;color:#fffdf8;font-weight:900">Your NFL intelligence access is ready.</h1><p style="margin:0;color:#c3c8d0;font-size:16px;line-height:1.7">Use this one-time secure link to sign in to PropBetEdge NFL. Your NFL identity is tied to this email so Stripe purchases made with the same email can unlock NFL Pro automatically.</p></td></tr><tr><td style="padding:18px 34px 10px"><a href="${href}" style="display:inline-block;padding:16px 24px;border-radius:10px;background:#d4af37;color:#161008;text-decoration:none;font-size:14px;font-weight:900;letter-spacing:.45px;text-transform:uppercase">Enter NFL Intelligence OS</a></td></tr><tr><td style="padding:22px 34px 10px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0b1016;border:1px solid #272d35;border-radius:14px"><tr><td style="padding:18px 20px"><div style="font-size:10px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#d8b75b">One account. One entitlement.</div><p style="margin:7px 0 0;color:#aeb5bf;font-size:13px;line-height:1.65">Use this same email at Stripe checkout. PropBetEdge matches the purchase back to this NFL session — no license key and no separate account setup.</p></td></tr></table></td></tr><tr><td style="padding:18px 34px 30px"><div style="font-size:10px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#737b86">Security</div><p style="margin:6px 0 0;color:#8d949e;font-size:12px;line-height:1.65">This link expires in 15 minutes and can only be used once. If you did not request it, ignore this message. Do not forward it.</p><p style="margin:16px 0 0;color:#616873;font-size:11px;line-height:1.6">Button not working?<br><a href="${href}" style="color:#bfa34c;text-decoration:underline;word-break:break-all">${href}</a></p></td></tr></table></td></tr></table></body></html>`;
}

function emailText(actionLink) {
  return `PROPBETEDGE NFL — SECURE ACCESS\n\nYour NFL intelligence access is ready.\n\nOpen this one-time secure link:\n${actionLink}\n\nThe link expires in 15 minutes and can only be used once.\n\nUse this same email at Stripe checkout. PropBetEdge matches the purchase back to your NFL session so NFL Pro can unlock automatically.\n\nIf you did not request this email, ignore it.\n\nPropBetEdge NFL · Football Intelligence OS`;
}

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/'/g, '&#39;');
}
