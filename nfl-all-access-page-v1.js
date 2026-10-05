/* PropBetEdge NFL — native All Access page v1 (/all-access).
 *
 * A real NFL page, not a redirect: the reader stays on nfl.propbetedge.ai.
 * The page explains and sells PropBetEdge All Access through the NFL lens,
 * upgrades NFL Pro members, and becomes the Platinum Member network dashboard
 * for All Access members.
 *
 * Access is never decided here. The panel renders from the same server
 * verdict the NFL account sheet reads (GET /api/auth-session) with the same
 * derivation as paywall.js:
 *   pro      = valid && payload.pro === true && access === 'granted'
 *   granted without pro, unavailable, degraded, non-200 or a failed fetch
 *            -> the ACCESS CHECK state (never a sales screen, never "free")
 *   member   = membership.state (sport_pro | all_access | owner), legacy
 *              role === 'owner' -> owner
 * The only purchase actions are GET ALL ACCESS / UPGRADE TO ALL ACCESS, which
 * use the existing Stripe Payment Link from the shared contract. Sign-in uses
 * the same magic-link endpoint as the account sheet. Nothing here touches
 * cookies other than the existing logout endpoint.
 */
(() => {
  'use strict';

  const AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
  const DEGRADED_STAGES = new Set(['entitlement_lookup_failed', 'entitlement_secret_missing', 'secret_missing']);
  const MEMBER_STATES = new Set(['sport_pro', 'all_access', 'owner']);
  const panel = document.getElementById('nflaa-access');
  if (!panel) return;

  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const P = () => window.PBENflMember;
  const offer = () => window.PBEMembership?.ALL_ACCESS_OFFER || { price: '$29/month', promoCode: 'THEEDGE25', promoLine: '25% off while active with code THEEDGE25', checkoutUrl: P()?.ALL_ACCESS_CHECKOUT_URL };
  const checkoutUrl = () => offer().checkoutUrl || P()?.ALL_ACCESS_CHECKOUT_URL;
  const manageUrl = () => window.PBEMembership?.MANAGE_URL || 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';

  /* ------------------------------------------------------------ verdict -> view */
  /** Pure: the page view for one /api/auth-session answer (or a failure). */
  function viewFor(payload, { httpOk = true, failed = false, priorEmail = null } = {}) {
    if (failed || !payload || typeof payload !== 'object' || !httpOk) {
      return { kind: 'check', email: priorEmail || null };
    }
    const valid = payload.valid === true;
    const access = String(payload.access || '');
    const email = valid && payload.user?.email ? String(payload.user.email) : null;
    const pro = valid && payload.pro === true && access === 'granted';
    const degraded = payload.degraded === true || DEGRADED_STAGES.has(String(payload.stage || '')) || /degraded/i.test(String(payload.error || ''));
    if (access === 'unavailable' || (access === 'granted' && !pro) || (degraded && !pro)) return { kind: 'check', email: email || priorEmail || null };
    if (pro) {
      const m = payload.membership;
      const state = m?.entitled === true && MEMBER_STATES.has(m.state) ? m.state : (payload.role === 'owner' ? 'owner' : 'sport_pro');
      return { kind: state, email, membership: m?.entitled === true ? m : null, role: payload.role || null, subscription: payload.subscription || null };
    }
    if (email && access === 'no_entitlement') return { kind: 'lapsed', email, reason: String(payload.entitlement?.reason || '') };
    if (email) return { kind: 'signed_in', email };
    return { kind: 'anonymous', denied: access === 'no_entitlement' ? (payload.entitlement?.reason || 'not_active') : null };
  }

  /* ------------------------------------------------------------ markup */
  const head = (k, title, lede, tone = 'gold') => `<span class="nflaa-k is-${tone}">${k}</span><h2 class="nflaa-head">${title}</h2>${lede ? `<p class="nflaa-lede">${lede}</p>` : ''}`;

  function periodText(sub) {
    const raw = sub?.current_period_end;
    const d = raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) return 'Entitlement verified by PropBetEdge.';
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return sub.cancel_at_period_end ? `Access remains active through ${label}.` : `Current billing period runs through ${label}.`;
  }

  function verifiedCard(v, d, line) {
    return `<section class="nflaa-card${d?.platinum ? ' is-platinum' : v.kind === 'owner' ? ' is-owner' : ''}" aria-label="Verified account">
      <div class="nflaa-card-top"><small>Verified account</small>${P()?.badgeHtml?.(v.membership, v.kind) || `<span class="pbe-mbr-badge">${esc(d?.badge || '')}</span>`}</div>
      <strong class="nflaa-email">${esc(v.email || 'Verified member')}</strong>
      <div class="nflaa-card-meta"><span>${esc(line)}</span>${v.kind === 'owner' ? '<span>No subscription required</span>' : `<span>${esc(periodText(v.subscription))}</span>`}</div>
    </section>`;
  }

  function promo() {
    const o = offer();
    return `<p class="nflaa-promo">Launch offer: ${esc(o.promoLine || '').replace(esc(o.promoCode || ''), `<b>${esc(o.promoCode || '')}</b>`)}</p>`;
  }

  function signInForm() {
    return `<form class="nflaa-signin" id="nflaa-signin" data-nflaa-signin novalidate>
      <label for="nflaa-email">Email on your PropBetEdge membership</label>
      <div class="nflaa-signin-row"><input id="nflaa-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required><button type="submit" class="nflaa-btn">Send sign-in link</button></div>
      <p class="nflaa-msg" role="status" aria-live="polite" data-nflaa-msg></p>
    </form>`;
  }

  const others = () => (window.NFLAllAccessHero?.FAMILY?.sports || []).filter((s) => s.key !== 'nfl');
  function addsList() {
    const H = window.NFLAllAccessHero;
    const sports = others().map((s) => `<li>${esc(H.displayName(s))}</li>`).join('');
    const products = (H?.FAMILY?.products || []).map((p) => `<li class="is-product">◆ ${esc(p.name)}</li>`).join('');
    return `<div class="nflaa-adds"><span class="nflaa-k">UPGRADING ADDS</span><ul>${sports}${products}</ul></div>`;
  }

  function markup(v) {
    const D = P()?.display?.(v.membership || null, v.kind) || null;
    if (v.kind === 'check') {
      return `${v.email ? `<div class="nflaa-pill is-check"><i></i>SIGNED IN <b>${esc(v.email)}</b></div>` : ''}
        ${head('NFL · ACCESS CHECK', 'Access check<br><em>temporarily unavailable.</em>', 'We could not verify membership right now. Nothing about your access changes while the check is unavailable, and public NFL intelligence keeps working.', 'check')}
        <p class="nflaa-protect"><b>Your account is not being treated as unsubscribed.</b> Pricing and upgrade prompts stay hidden until verification answers cleanly.</p>
        <div class="nflaa-actions"><button type="button" class="nflaa-cta" data-nflaa-refresh>RETRY VERIFIED ACCESS</button>${v.email ? '<button type="button" class="nflaa-btn" data-nflaa-signout>SIGN OUT</button>' : ''}</div>
        <p class="nflaa-msg" role="status" aria-live="polite" data-nflaa-msg></p>`;
    }
    if (v.kind === 'all_access') {
      return `${head('PROPBETEDGE ALL ACCESS · PLATINUM MEMBER', 'Your network<br><em>is unlocked.</em>', 'PropBetEdge All Access · 10 sports + Predictions. Every desk below is open on this account — launch any of them from here.', 'platinum')}
        ${verifiedCard(v, D, 'PropBetEdge All Access · active')}
        <div class="nflaa-actions">
          <a class="nflaa-cta is-member" href="/#propboard">OPEN THE NFL DESK</a>
          ${v.membership?.show_manage === true ? `<a class="nflaa-btn" href="${esc(manageUrl())}" target="_blank" rel="noopener noreferrer">MANAGE MEMBERSHIP ↗</a>` : ''}
          <button type="button" class="nflaa-btn" data-nflaa-refresh>REFRESH VERIFIED ACCESS</button>
        </div>
        <p class="nflaa-msg" role="status" aria-live="polite" data-nflaa-msg></p>
        <p class="nflaa-secure is-member">◆ PLATINUM ACCESS ACTIVE · verified by PropBetEdge</p>`;
    }
    if (v.kind === 'owner') {
      return `${head('PROPBETEDGE · VERIFIED OWNER', 'Owner access<br><em>is active.</em>', 'The whole network is unlocked on this verified owner account. No subscription required.', 'owner')}
        ${verifiedCard(v, D, 'Owner access')}
        <div class="nflaa-actions">
          <a class="nflaa-cta is-member" href="/#propboard">OPEN THE NFL DESK</a>
          <button type="button" class="nflaa-btn" data-nflaa-refresh>REFRESH VERIFIED ACCESS</button>
        </div>
        <p class="nflaa-msg" role="status" aria-live="polite" data-nflaa-msg></p>
        <p class="nflaa-secure is-member">◆ VERIFIED OWNER · verified server-side from your emailed sign-in link</p>`;
    }
    if (v.kind === 'sport_pro') {
      return `${head(esc(D?.designation || 'NFL PRO MEMBER'), 'Your NFL desk<br><em>is already unlocked.</em>', 'Keep everything you have on NFL. All Access adds the rest of the PropBetEdge network to the same account.', 'member')}
        ${verifiedCard(v, D, window.PBEMembership?.planText?.(v.membership || {}) || 'NFL Pro')}
        ${addsList()}
        <p class="nflaa-price"><strong>${esc(String(offer().price || '$29/month').split('/')[0])}</strong><span>/${esc(String(offer().price || '$29/month').split('/')[1] || 'month')}</span></p>
        ${promo()}
        <div class="nflaa-actions">
          <a class="nflaa-cta" href="${esc(checkoutUrl())}" rel="noopener" data-pbe-placement="all_access_upgrade" data-nflaa-checkout>UPGRADE TO ALL ACCESS</a>
          <a class="nflaa-btn" href="/#propboard">OPEN THE NFL DESK</a>
          ${v.membership?.show_manage === true ? `<a class="nflaa-btn" href="${esc(manageUrl())}" target="_blank" rel="noopener noreferrer">MANAGE MEMBERSHIP ↗</a>` : ''}
        </div>`;
    }
    if (v.kind === 'lapsed') {
      const lapsed = ['expired', 'canceled', 'payment_failed', 'null_expiry'].includes(v.reason);
      return `<div class="nflaa-pill"><i></i>SIGNED IN <b>${esc(v.email)}</b></div>
        ${head(lapsed ? 'NFL PRO · ACCESS ENDED' : 'NFL PRO · NOT ACTIVE', lapsed ? 'NFL Pro access<br><em>is no longer active.</em>' : 'NFL Pro isn’t active<br><em>on this account.</em>', lapsed ? 'Renew NFL Pro from your NFL account, or add the whole PropBetEdge network with All Access — 10 sports plus PropBetEdge Predictions.' : 'Get NFL Pro from your NFL account, or the whole PropBetEdge network with All Access — 10 sports plus PropBetEdge Predictions.')}
        <div class="nflaa-actions">
          <a class="nflaa-cta" href="/?pbe_account=renew" data-nflaa-renew>${lapsed ? 'RENEW NFL PRO' : 'GET NFL PRO'}</a>
          <a class="nflaa-btn" href="#nflaa-net-title" data-nflaa-view-aa>VIEW ALL ACCESS</a>
          <button type="button" class="nflaa-btn" data-nflaa-signout>SIGN OUT</button>
        </div>
        <p class="nflaa-msg" role="status" aria-live="polite" data-nflaa-msg></p>
        <p class="nflaa-fine">Signed in · renewal is tied to this verified email.</p>`;
    }
    if (v.kind === 'signed_in') {
      return `<div class="nflaa-pill"><i></i>SIGNED IN <b>${esc(v.email)}</b></div>
        ${head('ACCOUNT READY', 'Your account is ready.', 'PropBetEdge All Access opens every PropBetEdge desk — 10 sports plus PropBetEdge Predictions — on this account.')}
        <p class="nflaa-price"><strong>$29</strong><span>/month</span></p>
        ${promo()}
        <div class="nflaa-actions">
          <a class="nflaa-cta" href="${esc(checkoutUrl())}" rel="noopener" data-pbe-placement="all_access_checkout" data-nflaa-checkout>GET ALL ACCESS</a>
          <a class="nflaa-btn" href="/">NFL PRO OPTIONS</a>
        </div>
        <p class="nflaa-fine">Only want NFL? NFL Pro is available on its own from your NFL account.</p>`;
    }
    /* anonymous */
    const note = v.denied ? '<p class="nflaa-note">Your previous NFL access is not active on this browser. Sign in again, or choose a membership below.</p>' : '';
    return `${head('PROPBETEDGE ALL ACCESS', '10 sports + PropBetEdge Predictions.<br><em>One membership.</em>')}
      ${note}
      <p class="nflaa-price"><strong>$29</strong><span>/month</span></p>
      ${promo()}
      <div class="nflaa-actions">
        <a class="nflaa-cta" href="${esc(checkoutUrl())}" rel="noopener" data-pbe-placement="all_access_checkout" data-nflaa-checkout>GET ALL ACCESS</a>
        <button type="button" class="nflaa-btn" data-nflaa-signin-open aria-expanded="false" aria-controls="nflaa-signin">SIGN IN</button>
      </div>
      <div class="nflaa-signin-wrap" hidden data-nflaa-signin-wrap>${signInForm()}</div>
      <p class="nflaa-fine">Charged today · No free trial · Cancel anytime · Secure checkout by Stripe</p>`;
  }

  /* ------------------------------------------------------------ network tiles */
  function paintNetwork(v) {
    const unlocked = v.kind === 'all_access' || v.kind === 'owner';
    document.documentElement.dataset.nflaaState = v.kind;
    document.querySelectorAll('.nflaa-net-tile').forEach((tile) => {
      const here = tile.dataset.netKey === 'nfl';
      const status = tile.querySelector('[data-net-status]');
      let label = here ? 'YOU ARE HERE' : 'INCLUDED';
      if (unlocked) label = here ? 'YOU ARE HERE · OPEN' : 'OPEN';
      else if (v.kind === 'sport_pro') label = here ? 'YOU ARE HERE · YOURS' : 'ADDED WITH ALL ACCESS';
      tile.classList.toggle('is-unlocked', unlocked || (here && v.kind === 'sport_pro'));
      if (status) status.textContent = label;
    });
  }

  /* ------------------------------------------------------------ shared state for the footer */
  function publish(v, loading = false) {
    const s = { loading, pro: MEMBER_STATES.has(v?.kind), user: v?.email ? { email: v.email } : null, membership: v?.membership || null, role: v?.kind === 'owner' ? 'owner' : null, access: v?.kind === 'check' ? 'unavailable' : undefined };
    window.PBEPro = Object.freeze({ state: s, open: () => focusPanel() });
    window.dispatchEvent(new CustomEvent('pbe:pro-state'));
    const btn = document.getElementById('pbes-account');
    if (btn) {
      const D = s.pro ? P()?.display?.(v.membership || null, v.kind) : null;
      const narrow = window.matchMedia?.('(max-width: 520px)')?.matches;
      btn.textContent = loading ? 'Account' : D ? (narrow ? D.headerShort : D.header) : v?.kind === 'check' ? 'Access Check' : v?.email ? 'Account' : 'Sign In';
      btn.dataset.membership = s.pro ? v.kind : v?.kind === 'check' ? 'check' : 'none';
      btn.classList.toggle('is-platinum', v?.kind === 'all_access');
    }
  }

  let current = null;
  function render(v) {
    current = v;
    panel.dataset.state = v.kind;
    panel.innerHTML = `<div class="nflaa-state">${markup(v)}</div>`;
    paintNetwork(v);
    publish(v);
  }

  function focusPanel() {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.focus({ preventScroll: true });
  }

  async function verify({ priorEmail = null } = {}) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch('/api/auth-session', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(timer);
      const body = await r.json().catch(() => null);
      return viewFor(body, { httpOk: r.ok, priorEmail });
    } catch (_) {
      return viewFor(null, { failed: true, priorEmail });
    }
  }

  function msg(text, tone = '') {
    const el = panel.querySelector('[data-nflaa-msg]');
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  let busy = false;
  async function onClick(event) {
    const t = event.target.closest('[data-nflaa-refresh],[data-nflaa-signout],[data-nflaa-signin-open]');
    if (!t || !panel.contains(t)) return;
    if (t.hasAttribute('data-nflaa-signin-open')) {
      event.preventDefault();
      const wrap = panel.querySelector('[data-nflaa-signin-wrap]');
      if (!wrap) return;
      wrap.hidden = !wrap.hidden;
      t.setAttribute('aria-expanded', String(!wrap.hidden));
      if (!wrap.hidden) panel.querySelector('#nflaa-email')?.focus();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (t.hasAttribute('data-nflaa-refresh')) {
        msg('Checking your verified access…');
        const next = await verify({ priorEmail: current?.email || null });
        render(next);
        msg(next.kind === 'check' ? 'Verification is still unavailable. Your membership has not changed; try again shortly.' : 'Access verified.', next.kind === 'check' ? 'error' : 'success');
      } else if (t.hasAttribute('data-nflaa-signout')) {
        await fetch('/api/auth-logout', { method: 'POST', headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
        location.reload();
      }
    } finally { busy = false; }
  }

  let sending = false;
  async function onSubmit(event) {
    const form = event.target.closest('[data-nflaa-signin]');
    if (!form) return;
    event.preventDefault();
    if (sending) return;
    const input = form.querySelector('#nflaa-email');
    const email = String(input?.value || '').trim();
    const out = form.querySelector('[data-nflaa-msg]');
    const say = (text, tone = '') => { if (out) { out.textContent = text; out.dataset.tone = tone; } };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Enter the email attached to your PropBetEdge access.', 'error'); input?.focus(); return; }
    sending = true;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    say('Sending your secure sign-in link…');
    try {
      const r = await fetch(`${AUTH_WORKER}/v1/auth/request`, { method: 'POST', mode: 'cors', headers: { 'content-type': 'application/json', accept: 'application/json' }, cache: 'no-store', body: JSON.stringify({ email, purpose: 'signin' }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Sign-in email failed (${r.status}).`);
      say(body?.message || 'If this email has PropBetEdge access, a secure link will arrive shortly.', 'success');
    } catch (error) {
      say(error?.message || 'Could not send your sign-in link.', 'error');
    } finally {
      sending = false;
      if (btn) btn.disabled = false;
    }
  }

  /* One delegated listener each, bound once; re-renders only replace innerHTML. */
  if (!panel.dataset.nflaaBound) {
    panel.dataset.nflaaBound = '1';
    panel.addEventListener('click', onClick);
    panel.addEventListener('submit', onSubmit);
    document.getElementById('pbes-account')?.addEventListener('click', () => {
      if (current?.kind === 'anonymous') {
        const opener = panel.querySelector('[data-nflaa-signin-open]');
        const wrap = panel.querySelector('[data-nflaa-signin-wrap]');
        if (wrap?.hidden && opener) opener.click();
      }
      focusPanel();
    });
    /* bfcache return from Stripe: re-verify so a fresh purchase shows at once. */
    window.addEventListener('pageshow', (e) => { if (e.persisted) verify({ priorEmail: current?.email || null }).then(render); });
  }

  window.NFLAllAccessPage = Object.freeze({ viewFor, markup, version: 1 });

  publish(null, true);
  const ready = () => verify().then(render);
  if (window.PBEMembership) ready();
  else {
    let started = false;
    const go = () => { if (!started) { started = true; ready(); } };
    window.addEventListener('pbe:membership-ready', go, { once: true });
    setTimeout(go, 1500);
  }
})();
