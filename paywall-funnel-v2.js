/* PropBetEdge NFL — purchase funnel v4
 * New customer: email -> Stripe Payment Link -> payment -> webhook -> access email.
 * Existing subscriber/owner: explicit Sign In -> Cloudflare auth Worker -> Resend.
 * Vercel is not in the critical payment or email-send path.
 */
(() => {
  'use strict';

  const AUTH_WORKER = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
  const STORAGE = 'pbe_nfl_pending_plan_v4';
  const PLANS = {
    season: {
      label: 'Season Pass',
      price: '$99',
      detail: 'one time',
      term: 'Access through February 14, 2027 · no recurring billing',
      url: 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06'
    },
    weekly: {
      label: 'Weekly',
      price: '$9.99',
      detail: '/ week',
      term: 'Renews weekly · no trial · cancel anytime',
      url: 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05'
    }
  };

  let queued = false;
  let checkoutRunning = false;

  function state() { return window.PBEPro?.state || {}; }
  function selectedKey() {
    try { return localStorage.getItem(STORAGE) || 'season'; } catch (_) { return 'season'; }
  }
  function setSelected(key) {
    if (!PLANS[key]) return;
    try { localStorage.setItem(STORAGE, key); } catch (_) {}
    paintSelection();
  }

  function signedOutMarkup() {
    const selected = selectedKey();
    return `<div class="pbe-funnel-head">
      <span>NFL PRO CHECKOUT</span>
      <strong>Choose access. Enter email. Pay securely.</strong>
      <p>No account setup before payment. Stripe handles the card checkout, then PropBetEdge emails your secure NFL Pro access automatically after payment.</p>
    </div>
    <div class="pbe-pro-plans pbe-funnel-plans">
      ${planCard('season', selected)}
      ${planCard('weekly', selected)}
    </div>
    <div class="pbe-funnel-step"><span>2</span><div><b>Email for NFL Pro access</b><small>This email is locked into Stripe checkout so the purchase and your NFL Pro access stay tied together.</small></div></div>
    <div class="pbe-pro-auth-state pbe-funnel-auth">
      <input class="pbe-pro-email" id="pbe-funnel-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email address">
      <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button"></button>
      <div class="pbe-funnel-divider"><span>Already purchased or internal access?</span></div>
      <button class="pbe-pro-cta secondary" id="pbe-funnel-signin" type="button">Already have access? Sign in</button>
      <div class="pbe-pro-message" id="pbe-funnel-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ Stripe-hosted card checkout · Access email after payment · Passwordless sign-in</div>`;
  }

  function planCard(key, selected) {
    const p = PLANS[key];
    return `<button type="button" class="pbe-pro-price-card pbe-funnel-plan ${selected === key ? 'selected' : ''}" data-funnel-plan="${key}" aria-pressed="${selected === key ? 'true' : 'false'}">
      <div class="pbe-funnel-check">${selected === key ? '✓' : '○'}</div>
      <div class="pbe-pro-plan-label">NFL PRO · ${key === 'season' ? 'SEASON PASS' : 'WEEKLY'}</div>
      <div class="pbe-pro-price"><strong>${p.price}</strong><span>${p.detail}</span></div>
      <div class="pbe-pro-renew">${p.term}</div>
      <div class="pbe-funnel-select-copy">${selected === key ? 'Selected' : 'Choose plan'}</div>
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
      const check = card.querySelector('.pbe-funnel-check'); if (check) check.textContent = on ? '✓' : '○';
      const copy = card.querySelector('.pbe-funnel-select-copy'); if (copy) copy.textContent = on ? 'Selected' : 'Choose plan';
    });
    const btn = document.getElementById('pbe-funnel-checkout');
    const p = PLANS[selected] || PLANS.season;
    if (btn) btn.textContent = `Continue to Stripe · ${p.price}${selected === 'weekly' ? ' / week' : ''}`;
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
    const plan = PLANS[key] || PLANS.season;
    checkoutRunning = true;
    const btn = document.getElementById('pbe-funnel-checkout');
    if (btn) btn.disabled = true;
    message('Opening secure Stripe checkout…');
    window.location.assign(stripeUrl(plan, email));
  }

  async function signInExisting() {
    const email = emailValue();
    if (!validEmail(email)) return message('Enter the email already tied to your NFL Pro access.', 'error');
    const btn = document.getElementById('pbe-funnel-signin');
    if (btn) btn.disabled = true;
    message('Sending your secure PropBetEdge NFL sign-in link…');
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
    host.querySelectorAll('[data-funnel-plan]').forEach(card => { card.onclick = () => setSelected(card.dataset.funnelPlan); });
    const checkout = document.getElementById('pbe-funnel-checkout'); if (checkout) checkout.onclick = startCheckout;
    const signin = document.getElementById('pbe-funnel-signin'); if (signin) signin.onclick = signInExisting;
    const input = document.getElementById('pbe-funnel-email'); if (input) input.onkeydown = e => { if (e.key === 'Enter') startCheckout(); };
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
      el.textContent = 'Payment received. Your NFL Pro entitlement is being activated and your secure access email is sent automatically. If needed, enter the same email above and choose “Already have access? Sign in”.';
    }, 100);
  }

  function apply() { queued = false; mountSignedOut(); checkoutReturnMessage(); }
  function queue() { if (queued) return; queued = true; requestAnimationFrame(apply); }
  function install() {
    window.addEventListener('pbe:pro-state', queue);
    document.addEventListener('click', e => { if (e.target?.closest?.('.pbe-pro-account,[data-pbe-open-pro],[data-pro]')) setTimeout(queue, 20); });
    const modal = document.getElementById('pbe-pro-backdrop') || document.body;
    const observer = new MutationObserver(queue); observer.observe(modal, { childList: true, subtree: true });
    queue();
    window.PBECheckoutFunnel = { apply, setSelected, startCheckout, signInExisting, plans: PLANS };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})();