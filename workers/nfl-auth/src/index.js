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
          subject: 'PropBetEdge NFL — your secure access is ready',
          html: emailHtml(actionLink),
          text: emailText(actionLink),
          tags: [
            { name: 'product', value: 'nfl' },
            { name: 'message', value: 'secure-access' },
          ],
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>PropBetEdge NFL secure access</title>
</head>
<body style="margin:0;padding:0;background:#080b10;color:#f7f3ea;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Your secure access to PropBetEdge NFL is ready.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#080b10;margin:0;padding:0">
    <tr>
      <td align="center" style="padding:36px 16px 48px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;background:#11161d;border:1px solid #30291d;border-radius:22px;overflow:hidden;box-shadow:0 28px 80px rgba(0,0,0,.45)">
          <tr>
            <td style="height:3px;background:#d4af37;font-size:0;line-height:0">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:30px 34px 22px;background:linear-gradient(135deg,#17120d 0%,#111820 52%,#0d1420 100%)">
              <img src="${PBE_LOGO}" width="196" alt="PropBetEdge" style="display:block;width:196px;max-width:100%;height:auto;border:0">
              <div style="margin-top:18px;font-size:10px;line-height:1.4;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:#d8b75b">NFL Intelligence OS &nbsp;•&nbsp; Secure Access</div>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 34px 12px">
              <div style="font-size:13px;line-height:1.5;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#8f98a6">Access request confirmed</div>
              <h1 style="margin:8px 0 14px;font-size:40px;line-height:1.03;letter-spacing:-1.2px;color:#fffdf8;font-weight:900">Your NFL intelligence access is ready.</h1>
              <p style="margin:0;color:#c3c8d0;font-size:16px;line-height:1.7">Open PropBetEdge NFL with the secure passwordless link below. Your identity, NFL Pro access, and Stripe entitlement are tied to this email so your account stays connected across the product.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 34px 10px">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="border-radius:10px;background:#d4af37">
                    <a href="${href}" style="display:inline-block;padding:16px 24px;color:#161008;text-decoration:none;font-size:14px;line-height:1;font-weight:900;letter-spacing:.45px;text-transform:uppercase">Enter NFL Intelligence OS</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 34px 10px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#0b1016;border:1px solid #272d35;border-radius:14px">
                <tr>
                  <td style="padding:18px 20px">
                    <div style="font-size:10px;line-height:1.4;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#d8b75b">One account. One entitlement.</div>
                    <p style="margin:7px 0 0;color:#aeb5bf;font-size:13px;line-height:1.65">Use this same email when you purchase NFL Pro. PropBetEdge automatically matches the Stripe purchase to your account so premium access can activate without a separate license key.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 34px 30px">
              <div style="font-size:10px;line-height:1.4;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:#737b86">Security</div>
              <p style="margin:6px 0 0;color:#8d949e;font-size:12px;line-height:1.65">This secure access link was generated for your email. If you did not request it, you can ignore this message. Do not forward the link to anyone else.</p>
              <p style="margin:16px 0 0;color:#616873;font-size:11px;line-height:1.6">Button not working? Open this secure link:<br><a href="${href}" style="color:#bfa34c;text-decoration:underline;word-break:break-all">${href}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 34px;background:#0a0e13;border-top:1px solid #20262d">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="color:#6f7680;font-size:10px;line-height:1.6;letter-spacing:.3px">PROPBetEdge NFL &nbsp;•&nbsp; Football Intelligence OS</td>
                  <td align="right" style="color:#8c7633;font-size:10px;line-height:1.6;font-weight:700">propbetedge.ai</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function emailText(actionLink) {
  return `PROPBETEDGE NFL — SECURE ACCESS\n\nYour NFL intelligence access is ready.\n\nOpen PropBetEdge NFL with this secure passwordless link:\n${actionLink}\n\nUse this same email when you purchase NFL Pro. PropBetEdge matches the Stripe purchase to your account so premium access can activate without a separate license key.\n\nIf you did not request this email, ignore it. Do not forward this secure access link.\n\nPropBetEdge NFL · Football Intelligence OS`;
}

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}