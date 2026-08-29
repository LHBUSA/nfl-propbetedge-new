const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const PBE_LOGO = 'https://propbetedge.ai/logo/pbe-full-400.png';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  /* Supabase remains the identity/session issuer. Resend is the only customer-facing
   * email transport. There is intentionally no Supabase-delivery fallback. */
  const enabled = Boolean(
    process.env.RESEND_API_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.RESEND_FROM_EMAIL
  );

  if (req.method === 'GET') {
    return res.status(200).json({
      enabled,
      provider: enabled ? 'resend' : 'unconfigured',
      auth_issuer: 'supabase',
      fallback: false,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!enabled) {
    return res.status(503).json({
      error: 'PropBetEdge email sign-in is temporarily unavailable.',
      provider: 'resend',
      fallback: false,
    });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const origin = safeOrigin(req.headers?.origin || req.headers?.referer) || 'https://nfl.propbetedge.ai';
  const redirectTo = `${origin}/?auth=complete`;

  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const linkResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'magiclink',
        email,
        options: { redirectTo },
      }),
    });

    const linkPayload = await linkResponse.json().catch(() => ({}));
    if (!linkResponse.ok) {
      console.warn('[auth-email] Supabase link issuance failed', linkResponse.status, linkPayload?.msg || linkPayload?.message || '');
      return res.status(502).json({ error: 'Could not create a secure sign-in link.', provider: 'resend', fallback: false });
    }

    const actionLink = linkPayload?.action_link || linkPayload?.properties?.action_link;
    if (!actionLink) {
      console.warn('[auth-email] Supabase response did not include an action link.');
      return res.status(502).json({ error: 'Could not create a secure sign-in link.', provider: 'resend', fallback: false });
    }

    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [email],
        subject: 'Your PropBetEdge NFL sign-in link',
        html: emailHtml(actionLink),
      }),
    });

    const resendPayload = await resendResponse.json().catch(() => ({}));
    if (!resendResponse.ok) {
      console.warn('[auth-email] Resend failed', resendResponse.status, resendPayload?.message || '');
      return res.status(502).json({ error: 'Could not send the sign-in email.', provider: 'resend', fallback: false });
    }

    return res.status(200).json({ ok: true, provider: 'resend' });
  } catch (error) {
    console.error('[auth-email] unexpected error', error?.message || error);
    return res.status(500).json({ error: 'Could not send the sign-in email.', provider: 'resend', fallback: false });
  }
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function emailHtml(actionLink) {
  const href = escapeAttr(actionLink);
  return `<!doctype html>
<html>
  <body style="margin:0;background:#14110d;color:#f5f1eb;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#14110d;padding:34px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#1d1914;border:1px solid rgba(212,175,55,.28);border-radius:18px;overflow:hidden">
          <tr><td style="padding:28px 30px 18px;background:linear-gradient(135deg,#1d1914,#14110d)">
            <img src="${PBE_LOGO}" width="190" alt="PropBetEdge" style="display:block;max-width:190px;height:auto">
            <div style="margin-top:14px;color:#e9c75a;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase">NFL Intelligence OS</div>
          </td></tr>
          <tr><td style="padding:8px 30px 32px">
            <h1 style="margin:12px 0 10px;font-size:30px;line-height:1.1;color:#f5f1eb">Your secure NFL sign-in link</h1>
            <p style="margin:0 0 22px;color:#b8b3a8;font-size:15px;line-height:1.6">Use this link to sign in to PropBetEdge NFL. Your NFL Pro entitlement remains tied to this account.</p>
            <a href="${href}" style="display:inline-block;padding:14px 20px;border-radius:9px;background:#d4af37;color:#17120a;text-decoration:none;font-size:14px;font-weight:900">Open PropBetEdge NFL</a>
            <p style="margin:24px 0 0;color:#7e7a72;font-size:11px;line-height:1.55">If you did not request this email, ignore it. For security, do not forward this sign-in link.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
