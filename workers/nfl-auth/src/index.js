const SERVICE = 'propbetedge-nfl-auth';
const DEFAULT_APP_ORIGIN = 'https://nfl.propbetedge.ai';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const PBE_LOGO = 'https://propbetedge.ai/logo/pbe-full-400.png';

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
        auth_issuer: 'supabase',
        email_transport: 'resend',
        fallback: false,
        requirements,
      }, 200, requestOrigin, appOrigin);
    }

    if (url.pathname !== '/v1/auth/email') return json({ error: 'not_found' }, 404, requestOrigin, appOrigin);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, requestOrigin, appOrigin, { Allow: 'POST, OPTIONS' });
    if (requestOrigin && requestOrigin !== appOrigin) return json({ error: 'origin_not_allowed' }, 403, requestOrigin, appOrigin);

    const requirements = requiredSecrets(env);
    if (!Object.values(requirements).every(Boolean)) {
      console.error(`[${SERVICE}] missing configuration`);
      return json({ error: 'service_unavailable', provider: 'resend', fallback: false }, 503, requestOrigin, appOrigin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, requestOrigin, appOrigin);
    }

    const email = String(payload?.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      return json({ error: 'Enter a valid email address.' }, 400, requestOrigin, appOrigin);
    }

    const requestId = crypto.randomUUID();
    const supabaseUrl = String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
    const redirectTo = `${appOrigin}/?auth=complete`;

    try {
      const linkResponse = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'magiclink', email, options: { redirectTo } }),
      });

      const linkPayload = await linkResponse.json().catch(() => ({}));
      if (!linkResponse.ok) {
        console.error(`[${SERVICE}] supabase_link_failed`, requestId, linkResponse.status);
        return json({ error: 'Could not create a secure sign-in link.', request_id: requestId }, 502, requestOrigin, appOrigin);
      }

      const actionLink = linkPayload?.action_link || linkPayload?.properties?.action_link;
      if (!actionLink) {
        console.error(`[${SERVICE}] supabase_link_missing`, requestId);
        return json({ error: 'Could not create a secure sign-in link.', request_id: requestId }, 502, requestOrigin, appOrigin);
      }

      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.RESEND_FROM_EMAIL,
          to: [email],
          subject: 'Your PropBetEdge NFL sign-in link',
          html: emailHtml(actionLink),
        }),
      });

      if (!resendResponse.ok) {
        const resendPayload = await resendResponse.json().catch(() => ({}));
        console.error(`[${SERVICE}] resend_failed`, requestId, resendResponse.status, resendPayload?.message || '');
        return json({ error: 'Could not send the sign-in email.', request_id: requestId }, 502, requestOrigin, appOrigin);
      }

      console.log(`[${SERVICE}] email_sent`, requestId);
      return json({ ok: true, provider: 'resend', auth_issuer: 'supabase', request_id: requestId }, 200, requestOrigin, appOrigin);
    } catch (error) {
      console.error(`[${SERVICE}] unexpected_error`, requestId, error instanceof Error ? error.message : String(error));
      return json({ error: 'Could not send the sign-in email.', request_id: requestId }, 500, requestOrigin, appOrigin);
    }
  },
};

function requiredSecrets(env) {
  return {
    RESEND_API_KEY: Boolean(env.RESEND_API_KEY),
    RESEND_FROM_EMAIL: Boolean(env.RESEND_FROM_EMAIL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

function cors(requestOrigin, appOrigin) {
  return {
    'access-control-allow-origin': !requestOrigin || requestOrigin === appOrigin ? appOrigin : 'null',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
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

function emailHtml(actionLink) {
  const href = escapeAttr(actionLink);
  return `<!doctype html><html lang="en"><body style="margin:0;background:#0b1017;color:#f5f1eb;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b1017;padding:34px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#151a20;border:1px solid rgba(212,175,55,.30);border-radius:18px;overflow:hidden"><tr><td style="padding:28px 30px 18px;background:linear-gradient(135deg,#1d1914,#111820)"><img src="${PBE_LOGO}" width="190" alt="PropBetEdge" style="display:block;max-width:190px;height:auto"><div style="margin-top:14px;color:#e9c75a;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase">NFL Intelligence OS</div></td></tr><tr><td style="padding:8px 30px 32px"><h1 style="margin:12px 0 10px;font-size:30px;line-height:1.1;color:#f5f1eb">Your secure NFL sign-in link</h1><p style="margin:0 0 22px;color:#b8b3a8;font-size:15px;line-height:1.6">Open PropBetEdge NFL with this passwordless link. Use the same email at checkout so your Stripe purchase can unlock NFL Pro automatically.</p><a href="${href}" style="display:inline-block;padding:14px 20px;border-radius:9px;background:#d4af37;color:#17120a;text-decoration:none;font-size:14px;font-weight:900">Open PropBetEdge NFL</a><p style="margin:24px 0 0;color:#7e7a72;font-size:11px;line-height:1.55">If you did not request this email, ignore it. For security, do not forward this sign-in link.</p></td></tr></table></td></tr></table></body></html>`;
}

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
