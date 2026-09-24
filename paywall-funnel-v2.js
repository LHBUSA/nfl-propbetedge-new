/* PropBetEdge NFL — Founding Season purchase funnel v8
 *
 * Presentation authority for signed-out, signed-in free, AND active Pro users.
 * Auth/session state remains owned by paywall.js; this file owns the customer-
 * facing account and purchase experience so old pricing or utility-grade paid
 * states cannot become the final rendered UI.
 *
 * 2026 Founding Season: plans, prices and Payment Links come from
 * window.PBEPricing (paywall.js), the single pricing source. No free trial.
 *
 * Runtime:
 *   Vercel serves this frontend file.
 *   Browser -> Stripe-hosted Checkout.
 *   Stripe -> Cloudflare billing Worker -> Supabase entitlement truth.
 */
(() => {
  'use strict';

  const AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
  const STORAGE = 'pbe_nfl_pending_plan_v7';
  /* Plans come from the one pricing source, window.PBEPricing (paywall.js). */
  const PRICING = window.PBEPricing;
  if (!PRICING) { console.error('[nfl-funnel] window.PBEPricing is missing; purchase funnel not installed'); return; }
  const PLANS = { monthly: PRICING.monthly, weekly: PRICING.weekly };

  let queued = false;
  let checkoutRunning = false;

  function state() { return window.PBEPro?.state || {}; }

  /* The shared PropBetEdge membership contract (pbe-membership.js, exposed as
     window.PBEMembership). paywall.js reads it from /api/auth-session; this file
     only renders it. The four states: free · sport_pro · all_access · owner. */
  const MEMBERSHIP_STATES = ['free', 'sport_pro', 'all_access', 'owner'];
  function lib() { return window.PBEMembership || null; }
  function membership(s = state()) {
    const m = s.membership;
    if (m && MEMBERSHIP_STATES.includes(m.state)) return m;
    return lib()?.deriveMembership?.({ sport: 'nfl', entitled: false }) || { sport: 'nfl', state: 'free', label: 'FREE', entitled: false, show_purchase_cta: true, show_all_access_upgrade: false, show_manage: false };
  }
  /* The rendered state: the access verdict (`pro`) is the authority; the
     contract object names which kind of member. A granted verdict without a
     readable contract falls back to the legacy owner/subscriber distinction. */
  function memberState(s = state(), m = membership(s)) {
    if (!s.pro) return 'free';
    if (m?.entitled) return m.state;
    return s.role === 'owner' ? 'owner' : 'sport_pro';
  }
  function allAccessCard(m, opts) { return lib()?.allAccessCardHtml?.(m, opts) || ''; }
  function planKey(ref) {
    if (PLANS[ref]) return ref;
    return Object.keys(PLANS).find(key => PLANS[key].priceId === ref || PLANS[key].url === ref) || null;
  }
  function selectedKey() {
    try {
      const key = localStorage.getItem(STORAGE);
      return PLANS[key] ? key : 'monthly';
    } catch (_) { return 'monthly'; }
  }
  function setSelected(key) {
    if (!PLANS[key]) return;
    try { localStorage.setItem(STORAGE, key); } catch (_) {}
    paintSelection();
  }

  function planCard(key, selected) {
    const p = PLANS[key];
    const on = selected === key;
    return `<button type="button" class="pbe-pro-price-card pbe-funnel-plan ${on ? 'selected' : ''}" data-funnel-plan="${key}" aria-pressed="${on ? 'true' : 'false'}" role="radio" aria-checked="${on ? 'true' : 'false'}">
      <div class="pbe-funnel-plan-top">
        <div>
          <div class="pbe-pro-plan-label">NFL PRO · ${p.label.toUpperCase()}</div>
          <div class="pbe-funnel-plan-badge">${p.badge}</div>
        </div>
        <div class="pbe-funnel-check">${on ? '✓' : '○'}</div>
      </div>
      <div class="pbe-pro-price"><strong>${p.price}</strong><span>${p.detail}</span></div>
      <div class="pbe-pro-renew">${p.term}</div>
      <div class="pbe-funnel-select-copy">${on ? 'Selected' : `Choose ${p.label.toLowerCase()}`}</div>
    </button>`;
  }

  function signedOutMarkup() {
    const selected = selectedKey();
    return `<div class="pbe-funnel-root" data-funnel-state="signed-out" data-membership="free">
      <div class="pbe-funnel-head">
        <span>FOUNDING SEASON · NFL PRO</span>
        <strong>Unlock the decisions, not just the dashboard.</strong>
        <p>NFL Pro unlocks official PBE Picks, the decision receipt behind each qualified call, and the premium model + market desk under one verified account.</p>
      </div>
      <div class="pbe-pro-plans pbe-funnel-plans" role="radiogroup" aria-label="NFL Pro plans">
        ${planCard('monthly', selected)}
        ${planCard('weekly', selected)}
      </div>
      <div class="pbe-funnel-email-label">
        <b>Your access email</b>
        <span>We tie this email to checkout so your Pro access unlocks automatically.</span>
      </div>
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <input class="pbe-pro-email" id="pbe-funnel-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email address">
        <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button"></button>
        <div class="pbe-funnel-charge">${escapeHtml(PRICING.charge)}</div>
        <div class="pbe-funnel-divider"><span>Already have NFL Pro?</span></div>
        <button class="pbe-pro-cta secondary" id="pbe-funnel-signin" type="button">Sign in to NFL Pro</button>
        <div class="pbe-pro-message" id="pbe-funnel-message"></div>
      </div>
      ${allAccessCard(membership())}
      <div class="pbe-pro-secure">◆ Secure checkout by Stripe · Passwordless PropBetEdge access</div>
    </div>`;
  }

  function signedInFreeMarkup(email) {
    const selected = selectedKey();
    const note = window.PBEPro?.denialNote?.() || '';
    return `<div class="pbe-funnel-root" data-funnel-state="signed-in-free" data-membership="free" data-funnel-note="${escapeHtml(state().entitlement?.reason || '')}">
      <div class="pbe-funnel-head">
        <span>FOUNDING SEASON · NFL PRO</span>
        <strong>${note ? 'Unlock NFL Pro again.' : 'Your account is ready. Unlock PBE Picks.'}</strong>
        <p>${note ? escapeHtml(note) : 'Upgrade the verified email below. No new account setup and no free-trial handoff.'}</p>
      </div>
      <div class="pbe-funnel-user"><span>Signed in as</span><strong>${escapeHtml(email)}</strong></div>
      <div class="pbe-pro-plans pbe-funnel-plans" role="radiogroup" aria-label="NFL Pro plans">
        ${planCard('monthly', selected)}
        ${planCard('weekly', selected)}
      </div>
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button"></button>
        <div class="pbe-funnel-charge">${escapeHtml(PRICING.charge)}</div>
        <button class="pbe-pro-cta secondary" id="pbe-funnel-refresh" type="button">Already paid? Refresh access</button>
        <div class="pbe-pro-message" id="pbe-funnel-message"></div>
      </div>
      ${allAccessCard(membership())}
      <div class="pbe-pro-secure">◆ Secure checkout by Stripe · Entitlement verified by PropBetEdge</div>
    </div>`;
  }

  function accessPeriodCopy(subscription) {
    const raw = subscription?.current_period_end;
    if (!raw) return 'Entitlement verified by PropBetEdge.';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return 'Entitlement verified by PropBetEdge.';
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return subscription?.cancel_at_period_end ? `Access remains active through ${label}.` : `Current billing period runs through ${label}.`;
  }

  /* Active members. One markup, three states from the shared contract:
       sport_pro   NFL PRO ACTIVE · plan · manage link · All Access upgrade card
       all_access  ALL ACCESS ACTIVE · manage link · network row · NO purchase CTA
       owner       OWNER · no manage link · no purchase CTA
     `owner` (the legacy role flag) still drives data-funnel-state so the
     polish and sales layers keep keying on active-pro / active-owner. */
  function activeProMarkup(email, subscription, owner = false, m = membership()) {
    const L = lib();
    const mState = m?.entitled ? m.state : (owner ? 'owner' : 'sport_pro');
    const label = m?.entitled && m.label ? m.label : (owner ? 'OWNER' : 'NFL PRO ACTIVE');
    const plan = (m?.entitled && L?.planText?.(m)) || (owner ? 'Owner access' : 'NFL Pro');
    const allAccess = mState === 'all_access';
    const isOwner = mState === 'owner';
    const badge = L?.membershipBadgeHtml?.(m?.entitled ? m : { state: mState, sport: 'nfl' }) || `<div class="pbe-funnel-plan-badge">${escapeHtml(label)}</div>`;
    const period = isOwner ? 'Owner access · every NFL Pro feature, no subscription required.' : accessPeriodCopy(subscription);
    const kicker = allAccess ? 'PROPBETEDGE ALL ACCESS · NFL' : isOwner ? 'NFL PRO · OWNER' : 'NFL PRO · VERIFIED ACCESS';
    const headline = allAccess ? 'Your PropBetEdge All Access desk is live.' : 'Your NFL Pro decision desk is live.';
    const lede = allAccess
      ? 'Every PropBetEdge Pro sport is unlocked on this account, NFL included: PBE Picks and the premium model + market desk are active across supported NFL surfaces.'
      : 'PBE Picks and the premium model + market desk are active across supported NFL surfaces. Market truth stays visible; model intelligence stays separately labeled.';
    const manage = m?.entitled ? (L?.manageLinkHtml?.(m) || '') : '';
    return `<div class="pbe-funnel-root pbe-funnel-active" data-funnel-state="${owner ? 'active-owner' : 'active-pro'}" data-membership="${escapeHtml(mState)}">
      <div class="pbe-funnel-head">
        <span>${kicker}</span>
        <strong>${headline}</strong>
        <p>${lede}</p>
      </div>
      <div class="pbe-funnel-user"><span>Verified account</span><strong>${escapeHtml(email || 'NFL Pro member')}</strong></div>
      <div class="pbe-pro-price-card pbe-funnel-active-card">
        <div class="pbe-funnel-plan-top">
          <div>
            <div class="pbe-pro-plan-label">${allAccess ? 'ALL ACCESS' : 'NFL PRO'} · ACCESS STATUS</div>
            ${badge}
          </div>
          <div class="pbe-funnel-check">✓</div>
        </div>
        <div class="pbe-funnel-active-title">Pro intelligence is enabled</div>
        <div class="pbe-funnel-plan-text">${escapeHtml(plan)}</div>
        <div class="pbe-pro-renew">${escapeHtml(period)}</div>
      </div>
      <div class="pbe-funnel-email-label pbe-funnel-capabilities">
        <b>Your Pro desk</b>
        <span>PBE Picks · PBE Fair Line · Model Probability · Best Line · PBE Cast · Track Record · premium research under the same verified Pro entitlement.</span>
      </div>
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <button class="pbe-pro-cta" id="pbe-funnel-open-board" type="button">Open Pro Prop Board</button>
        ${manage}
        <button class="pbe-pro-cta secondary" id="pbe-funnel-refresh" type="button">Refresh verified access</button>
        <div class="pbe-pro-message" id="pbe-funnel-message"></div>
      </div>
      ${allAccess ? (L?.networkLinksHtml?.('nfl') || '') : ''}
      ${allAccessCard(m)}
      <div class="pbe-pro-secure">◆ ${escapeHtml(label)} · ${isOwner ? 'verified server-side from your emailed sign-in link' : 'verified by PropBetEdge'}</div>
    </div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function emailValue() {
    const signedIn = String(state()?.user?.email || '').trim().toLowerCase();
    if (signedIn) return signedIn;
    return String(document.getElementById('pbe-funnel-email')?.value || '').trim().toLowerCase();
  }
  function validEmail(email) { return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254; }
  function message(text, type = '') {
    const el = document.getElementById('pbe-funnel-message');
    if (!el) return;
    el.className = `pbe-pro-message ${type}`.trim();
    el.textContent = text || '';
  }

  function paintSelection() {
    const selected = selectedKey();
    document.querySelectorAll('#pbe-pro-checkout [data-funnel-plan]').forEach(card => {
      const on = card.dataset.funnelPlan === selected;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      const check = card.querySelector('.pbe-funnel-check');
      if (check) check.textContent = on ? '✓' : '○';
      const copy = card.querySelector('.pbe-funnel-select-copy');
      if (copy) {
        const p = PLANS[card.dataset.funnelPlan];
        copy.textContent = on ? 'Selected' : `Choose ${p.label.toLowerCase()}`;
      }
    });
    const btn = document.getElementById('pbe-funnel-checkout');
    const p = PLANS[selected] || PLANS.monthly;
    if (btn) btn.textContent = `Unlock NFL Pro · ${p.price}${selected === 'monthly' ? '/mo' : '/wk'}`;
  }

  function stripeUrl(plan, email) {
    const url = new URL(plan.url);
    url.searchParams.set('locked_prefilled_email', email);
    return url.toString();
  }

  function startCheckout(ref = null) {
    if (checkoutRunning) return false;
    const email = emailValue();
    if (!validEmail(email)) {
      message('Enter the email you want tied to NFL Pro.', 'error');
      return false;
    }
    const requested = planKey(ref);
    const key = requested || selectedKey();
    const plan = PLANS[key] || PLANS.monthly;
    if (requested) setSelected(requested);
    checkoutRunning = true;
    const btn = document.getElementById('pbe-funnel-checkout');
    if (btn) btn.disabled = true;
    message('Opening secure Stripe checkout…');
    window.location.assign(stripeUrl(plan, email));
    return true;
  }

  async function signInExisting() {
    const email = emailValue();
    if (!validEmail(email)) return message('Enter the email tied to your NFL Pro access.', 'error');
    const btn = document.getElementById('pbe-funnel-signin');
    if (btn) btn.disabled = true;
    message('Sending your secure NFL Pro sign-in link…');
    try {
      const r = await fetch(`${AUTH_WORKER}/v1/auth/request`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ email, purpose: 'signin' })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Sign-in email failed (${r.status}).`);
      message(body?.message || 'If this email has NFL Pro access, a secure link will arrive shortly.', 'success');
    } catch (error) {
      message(error?.message || 'Could not send your sign-in link.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshExistingAccess() {
    const btn = document.getElementById('pbe-funnel-refresh');
    if (btn) btn.disabled = true;
    message('Checking NFL Pro access…');
    try {
      const pro = await window.PBEPro?.refreshAccess?.();
      if (pro || state()?.pro) message('NFL Pro is active.', 'success');
      else message('NFL Pro is not active on this email yet. If you just paid, wait a few seconds and try again.');
    } catch (error) {
      message(error?.message || 'Could not refresh NFL Pro access.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wire(host) {
    host.querySelectorAll('[data-funnel-plan]').forEach(card => {
      card.onclick = () => setSelected(card.dataset.funnelPlan);
    });
    const checkout = document.getElementById('pbe-funnel-checkout');
    if (checkout) checkout.onclick = () => startCheckout();
    const signin = document.getElementById('pbe-funnel-signin');
    if (signin) signin.onclick = signInExisting;
    const refresh = document.getElementById('pbe-funnel-refresh');
    if (refresh) refresh.onclick = refreshExistingAccess;
    const openBoard = document.getElementById('pbe-funnel-open-board');
    if (openBoard) openBoard.onclick = () => {
      window.PBEPro?.close?.();
      window.App?.nav?.('propboard');
    };
    const input = document.getElementById('pbe-funnel-email');
    if (input) input.onkeydown = event => { if (event.key === 'Enter') startCheckout(); };
    paintSelection();
  }

  function mountPurchaseState() {
    const s = state();
    if (s.loading) return;
    const host = document.getElementById('pbe-pro-checkout');
    if (!host) return;
    /* paywall.js owns the "couldn't verify access" screen; no plans are pushed
       at a reader whose subscription could not be checked */
    if (s.access === 'unavailable') return;

    const owner = s.pro && s.role === 'owner';
    const m = membership(s);
    const mState = memberState(s, m);
    const mode = s.pro ? (owner ? 'active-owner' : 'active-pro') : s.user ? 'signed-in-free' : 'signed-out';
    const root = host.querySelector('.pbe-funnel-root');
    const current = root?.dataset?.funnelState;
    const membershipChanged = (root?.dataset?.membership || 'free') !== mState;
    const noteChanged = mode === 'signed-in-free' && (root?.dataset?.funnelNote || '') !== String(s.entitlement?.reason || '');
    if (current !== mode || membershipChanged || noteChanged) {
      host.innerHTML = s.pro
        ? activeProMarkup(String(s.user?.email || '').toLowerCase(), s.subscription, owner, m)
        : s.user
          ? signedInFreeMarkup(String(s.user.email || '').toLowerCase())
          : signedOutMarkup();
    }
    wire(host);
    /* paywall.js owns the reader-facing notice (refused link, checkout return);
       a re-render here must never drop it. */
    window.PBEPro?.paintNotice?.();
  }

  function updateStructuredData() {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(node.textContent || '{}');
        if (data?.name !== 'PropBetEdge NFL') continue;
        data.offers = PRICING.order.map(key => ({
          '@type': 'Offer',
          name: `NFL Pro Founding Season ${PRICING[key].label}`,
          price: PRICING[key].amount,
          priceCurrency: 'USD',
          description: `Founding Season NFL Pro access billed ${PRICING[key].cadence === 'month' ? 'monthly' : 'weekly'}. No free trial. Cancel anytime.`,
          url: 'https://nfl.propbetedge.ai/'
        }));
        node.textContent = JSON.stringify(data);
        break;
      } catch (_) {}
    }
  }

  function publishPurchaseContract() {
    if (!window.PBEPro) return;
    window.PBEPro.prices = {
      monthly: PLANS.monthly.priceId,
      weekly: PLANS.weekly.priceId
    };
    window.PBEPro.paymentLinks = {
      monthly: PLANS.monthly.url,
      weekly: PLANS.weekly.url
    };
    /* The legacy auth-state file still contains its old /api/checkout helper.
     * Replace the public purchase contract after this terminal authority loads,
     * so every caller goes browser -> Stripe rather than browser -> Vercel API. */
    window.PBEPro.checkout = ref => startCheckout(ref);
  }

  function apply() {
    queued = false;
    publishPurchaseContract();
    mountPurchaseState();
  }
  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  }
  function install() {
    updateStructuredData();
    publishPurchaseContract();
    window.addEventListener('pbe:pro-state', queue);
    document.addEventListener('click', event => {
      if (event.target?.closest?.('.pbe-pro-account,[data-pbe-open-pro],[data-pro]')) setTimeout(queue, 20);
    });
    const modal = document.getElementById('pbe-pro-backdrop') || document.body;
    const observer = new MutationObserver(queue);
    observer.observe(modal, { childList: true, subtree: true });
    queue();
    window.PBECheckoutFunnel = {
      apply,
      setSelected,
      startCheckout,
      signInExisting,
      refreshExistingAccess,
      plans: PLANS,
      /* Pure builders, exposed so the membership tests can render each state
         without a browser. */
      markup: { signedOut: signedOutMarkup, signedInFree: signedInFreeMarkup, active: activeProMarkup, memberState, membership }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();