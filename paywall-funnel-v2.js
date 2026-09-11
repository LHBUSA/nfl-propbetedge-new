/* PropBetEdge NFL — Founding Season purchase funnel v5
 * New customer: choose plan -> email -> Stripe Payment Link -> webhook -> access email.
 * Existing subscriber: email -> Cloudflare auth Worker -> Resend.
 *
 * Pricing is intentionally acquisition-first for the 2026 Founding Season:
 *   $9.99/month (default / best value)
 *   $3.99/week  (flexible)
 * No free trial. Existing legacy subscriptions are not migrated here.
 *
 * Vercel serves this file. It is not in the payment, entitlement, or email runtime.
 */
(() => {
  'use strict';

  const AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
  const STORAGE = 'pbe_nfl_pending_plan_v5';
  const PLANS = {
    monthly: {
      label: 'Monthly',
      badge: 'Best value',
      price: '$9.99',
      detail: '/ month',
      term: 'Founding Season rate · Renews monthly · Cancel anytime',
      url: 'https://buy.stripe.com/eVqeVd1rUcyG5tz2gb7wA0y'
    },
    weekly: {
      label: 'Weekly',
      badge: 'Flexible',
      price: '$3.99',
      detail: '/ week',
      term: 'Founding Season rate · Renews weekly · Cancel anytime',
      url: 'https://buy.stripe.com/9B628rb2udCK5tzf2X7wA0x'
    }
  };

  let queued = false;
  let checkoutRunning = false;

  function state() { return window.PBEPro?.state || {}; }
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

  function signedOutMarkup() {
    const selected = selectedKey();
    return `<div class="pbe-funnel-head">
      <span>FOUNDING SEASON · NFL PRO</span>
      <strong>Unlock the intelligence layer.</strong>
      <p>Premium NFL model intelligence at introductory 2026 pricing. Pick your access, use one email, and you are in.</p>
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
      <div class="pbe-funnel-charge">Charged today · No free trial · Cancel anytime</div>
      <div class="pbe-funnel-divider"><span>Already have NFL Pro?</span></div>
      <button class="pbe-pro-cta secondary" id="pbe-funnel-signin" type="button">Sign in to NFL Pro</button>
      <div class="pbe-pro-message" id="pbe-funnel-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ Secure checkout by Stripe · Passwordless PropBetEdge access</div>`;
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

  function emailValue() {
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
    document.querySelectorAll('[data-funnel-plan]').forEach(card => {
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
    if (btn) btn.textContent = `Continue to Stripe · ${p.price}${selected === 'monthly' ? '/mo' : '/wk'}`;
  }

  function stripeUrl(plan, email) {
    const url = new URL(plan.url);
    url.searchParams.set('locked_prefilled_email', email);
    return url.toString();
  }

  function startCheckout() {
    if (checkoutRunning) return;
    const email = emailValue();
    if (!validEmail(email)) return message('Enter the email you want tied to NFL Pro.', 'error');
    const key = selectedKey();
    const plan = PLANS[key] || PLANS.monthly;
    checkoutRunning = true;
    const btn = document.getElementById('pbe-funnel-checkout');
    if (btn) btn.disabled = true;
    message('Opening secure Stripe checkout…');
    window.location.assign(stripeUrl(plan, email));
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
      message(`Check ${email}. Your secure sign-in link is on the way.`, 'success');
    } catch (error) {
      message(error?.message || 'Could not send your sign-in link.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function mountSignedOut() {
    const s = state();
    if (s.loading || s.user) return;
    const host = document.getElementById('pbe-pro-checkout');
    if (!host) return;
    if (!host.querySelector('.pbe-funnel-head')) host.innerHTML = signedOutMarkup();
    host.querySelectorAll('[data-funnel-plan]').forEach(card => {
      card.onclick = () => setSelected(card.dataset.funnelPlan);
    });
    const checkout = document.getElementById('pbe-funnel-checkout');
    if (checkout) checkout.onclick = startCheckout;
    const signin = document.getElementById('pbe-funnel-signin');
    if (signin) signin.onclick = signInExisting;
    const input = document.getElementById('pbe-funnel-email');
    if (input) input.onkeydown = e => { if (e.key === 'Enter') startCheckout(); };
    paintSelection();
  }

  function checkoutReturnMessage() {
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') !== 'success') return;
    const s = state();
    if (s.user) return;
    setTimeout(() => {
      const el = document.getElementById('pbe-funnel-message');
      if (!el) return;
      el.className = 'pbe-pro-message success';
      el.textContent = 'Payment received. Your NFL Pro access is activating now. If needed, sign in with the same email you used at checkout.';
    }, 100);
  }

  function apply() { queued = false; mountSignedOut(); checkoutReturnMessage(); }
  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  }
  function install() {
    window.addEventListener('pbe:pro-state', queue);
    document.addEventListener('click', e => {
      if (e.target?.closest?.('.pbe-pro-account,[data-pbe-open-pro],[data-pro]')) setTimeout(queue, 20);
    });
    const modal = document.getElementById('pbe-pro-backdrop') || document.body;
    const observer = new MutationObserver(queue);
    observer.observe(modal, { childList: true, subtree: true });
    queue();
    window.PBECheckoutFunnel = { apply, setSelected, startCheckout, signInExisting, plans: PLANS };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();