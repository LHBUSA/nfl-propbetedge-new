/* PropBetEdge NFL Pro
 * Identity + session: first-party PropBetEdge NFL auth Worker via same-origin bridges
 * Email delivery: Resend
 * Billing: Stripe Checkout Session with server-side locked Payment Link fallback
 * Entitlement: nfl_subscriptions through Worker session state
 *
 * Access is additive. The NFL site boots and stays usable no matter what this
 * file learns: nothing here hides the application shell or waits before the
 * workspace loads. /api/auth-session answers with `access`:
 *   anonymous | no_entitlement | granted | unavailable
 * and only `granted` (a qualifying NFL purchase or the verified owner) unlocks
 * the Pro layer, which the premium API routes enforce again server-side.
 * A slow or failing session check becomes `unavailable` after
 * SESSION_TIMEOUT_MS; the public product is unaffected.
 */
(() => {
  'use strict';

  /* The one source of NFL Pro pricing copy and purchase targets: the 2026
   * Founding Season Stripe prices and their Payment Links (the prices
   * workers/nfl-billing recognizes). paywall.js loads before every module, so
   * the funnel, the modules and the shell read window.PBEPricing instead of
   * restating a price. No free trial exists; none is offered. */
  const PRICING = Object.freeze({
    monthly: Object.freeze({ key: 'monthly', label: 'Monthly', badge: 'Popular', price: '$9.99', amount: '9.99', cadence: 'month', detail: '/ month', short: '$9.99/mo',
      priceId: 'price_1UEWAXF3CaVzg4ORGlsgboLq', url: 'https://buy.stripe.com/eVqeVd1rUcyG5tz2gb7wA0y', term: 'Founding Season rate · Renews monthly · Cancel anytime' }),
    weekly: Object.freeze({ key: 'weekly', label: 'Weekly', badge: 'Flexible', price: '$3.99', amount: '3.99', cadence: 'week', detail: '/ week', short: '$3.99/wk',
      priceId: 'price_1UEWAOF3CaVzg4ORjkWpwOz9', url: 'https://buy.stripe.com/9B628rb2udCK5tzf2X7wA0x', term: 'Founding Season rate · Renews weekly · Cancel anytime' }),
    order: Object.freeze(['monthly', 'weekly']),
    summary: '$9.99/month or $3.99/week',
    shortSummary: '$9.99/mo or $3.99/wk',
    ctaSuffix: 'from $3.99/week',
    charge: 'Charged today · No free trial · Cancel anytime',
  });
  window.PBEPricing = PRICING;
  const planFor = ref => PRICING.order.map(k => PRICING[k]).find(plan => plan.key === ref || plan.priceId === ref) || null;
  const MODEL_UPSTREAM_PREFIX = 'https://nfl-api.propbetedge.ai/api/picks/pass';
  const SESSION_TIMEOUT_MS = 8000;
  const ACCESS_STATES = new Set(['anonymous','no_entitlement','granted','unavailable']);

  const state = {
    session: null,
    user: null,
    pro: false,
    access: 'checking',
    role: null,
    entitlement: null,
    loading: true,
    subscription: null,
    /* The shared PropBetEdge membership contract (pbe-membership.js), read from
     * /api/auth-session. The server derives it; the browser never widens it. */
    membership: null,
    checkoutSyncing: false,
    notice: null,
    stage: null,
    error: null
  };

  const MEMBERSHIP_STATES = ['free', 'sport_pro', 'all_access', 'owner'];
  const FREE_MEMBERSHIP = Object.freeze({ contract: null, sport: 'nfl', state: 'free', label: 'FREE', entitled: false, access_source: null, product_key: null, plan: null, email: null, current_period_end: null, cancel_at_period_end: false, show_purchase_cta: true, show_all_access_upgrade: false, show_manage: false });
  function readMembership(raw) {
    const lib = window.PBEMembership;
    if (lib?.readMembership) return lib.readMembership(raw, 'nfl');
    /* The module did not load: keep the server's own well-formed object, else FREE. */
    const ok = raw && typeof raw === 'object' && MEMBERSHIP_STATES.includes(raw.state) && typeof raw.label === 'string';
    return ok ? raw : FREE_MEMBERSHIP;
  }
  function memberLabel(fallback) {
    const m = state.membership;
    return m?.entitled && m.label ? m.label : fallback;
  }
  function memberPlanText(fallback) {
    const m = state.membership;
    if (!m?.entitled) return fallback;
    return window.PBEMembership?.planText?.(m) || fallback;
  }

  /* Why a signed-in reader does not have Pro, in the reader's terms. */
  const DENIAL_COPY = {
    expired: 'Your NFL Pro access has expired. Choose a plan to unlock Pro again.',
    canceled: 'Your NFL Pro subscription was canceled. Choose a plan to restart Pro.',
    payment_failed: 'Your last NFL Pro payment did not go through. Choose a plan to restore Pro.',
  };
  function denialNote() {
    if (state.access !== 'no_entitlement') return '';
    const reason = state.entitlement?.reason;
    if (DENIAL_COPY[reason]) return DENIAL_COPY[reason];
    return reason && reason !== 'no_subscription' ? 'No active NFL Pro subscription is linked to this email.' : '';
  }

  const nativeFetch = window.fetch.bind(window);

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function setHtml(el,html) {
    if (!el || el.innerHTML === html) return false;
    el.innerHTML = html;
    return true;
  }

  function setText(el,text) {
    if (!el || el.textContent === text) return false;
    el.textContent = text;
    return true;
  }

  async function getToken() {
    return '';
  }

  /* Every production model request is entitlement-gated server-side. The
   * HttpOnly PropBetEdge NFL session cookie is sent automatically same-origin. */
  window.fetch = async function pbeEntitledFetch(input, init = {}) {
    try {
      const inputUrl = typeof input === 'string' ? input : input?.url;
      if (inputUrl && inputUrl.startsWith(MODEL_UPSTREAM_PREFIX)) {
        const parsed = new URL(inputUrl);
        const eventId = parsed.searchParams.get('event_id') || '';
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
        headers.set('accept','application/json');
        headers.delete('authorization');
        return nativeFetch(`/api/pro-model?event_id=${encodeURIComponent(eventId)}`, {
          ...init,
          method: 'GET',
          headers,
          cache: 'no-store',
          credentials: 'same-origin'
        });
      }
    } catch (_) {}
    return nativeFetch(input,init);
  };

  function modalHtml() {
    return `<div class="pbe-pro-backdrop" id="pbe-pro-backdrop" role="dialog" aria-modal="true" aria-label="NFL Pro">
      <div class="pbe-pro-modal">
        <button class="pbe-pro-close" type="button" aria-label="Close NFL Pro">×</button>
        <div class="pbe-pro-modal-grid">
          <section class="pbe-pro-pitch">
            <div class="pbe-pro-kicker">PROPBETEDGE NFL PRO · PBE PICKS</div>
            <h2>The model makes the call.<br><em>The record keeps it honest.</em></h2>
            <p>NFL Pro unlocks official qualified PBE Picks from the production champion, plus the model and market desk behind each call. The decision-time market state is preserved before the outcome is known, then the result is graded without deleting losses or rewriting the original decision.</p>
            <div class="pbe-pro-feature-list">
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">◎</div><div><strong>Official PBE Picks</strong><span>Qualified production-champion decisions. If the engine does not qualify a game, Pro shows no forced pick.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">▧</div><div><strong>Decision Receipt</strong><span>Issued line and odds, model probability, market comparison and model provenance stay attached to the decision.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">✓</div><div><strong>Verified Track Record</strong><span>Official picks are graded against final results and remain auditable instead of disappearing after a loss.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">＋</div><div><strong>Model + Market Desk</strong><span>Model Lab, Market Watch, Best Line, simulation and supported premium research live under one NFL Pro entitlement.</span></div></div>
            </div>
          </section>
          <section class="pbe-pro-checkout" id="pbe-pro-checkout"></section>
        </div>
      </div>
    </div>`;
  }

  function signedOutHtml() {
    return `<div class="pbe-pro-price-card">
      <div class="pbe-pro-plan-label">NFL PRO</div>
      <div class="pbe-pro-price"><strong>2</strong><span>ways to unlock</span></div>
      <div class="pbe-pro-renew">Sign in once, then choose ${esc(PRICING.summary)}.</div>
    </div>
    <div class="pbe-pro-auth-state">
      <input class="pbe-pro-email" id="pbe-pro-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email address">
      <button class="pbe-pro-cta" id="pbe-pro-signin" type="button">Sign in to continue</button>
      <div class="pbe-pro-auth-copy">We send a one-time secure PropBetEdge sign-in link through Resend. Checkout uses this same verified email so Stripe can unlock NFL Pro automatically.</div>
      <div class="pbe-pro-message" id="pbe-pro-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ Passwordless PropBetEdge session · Secure checkout powered by Stripe</div>`;
  }

  function freeUserHtml() {
    const email = state.user?.email || 'Signed-in account';
    const card = (plan, primary) => `<div class="pbe-pro-price-card" data-plan="${plan.key}">
        <div class="pbe-pro-plan-label">NFL PRO · ${esc(plan.label.toUpperCase())}</div>
        <div class="pbe-pro-price"><strong>${esc(plan.price)}</strong><span>${esc(plan.detail)}</span></div>
        <div class="pbe-pro-renew">${esc(plan.term)}</div>
        <button class="pbe-pro-cta${primary ? '' : ' secondary'}" id="pbe-pro-buy-${plan.key}" type="button">Choose ${esc(plan.label)}</button>
      </div>`;
    return `<div class="pbe-pro-plans">
      ${card(PRICING.monthly, true)}
      ${card(PRICING.weekly, false)}
    </div>
    <div class="pbe-funnel-charge">${esc(PRICING.charge)}</div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>Signed in · Free access</span></div>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">I already subscribed · Refresh access</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-auth-copy">Stripe checkout is locked to <strong>${esc(email)}</strong>. Your purchase is matched back to this verified PropBetEdge NFL session.</div>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ Verified email identity · Secure checkout powered by Stripe</div>`;
  }

  /* The access check could not answer. Pro stays locked; nothing else does. */
  function unavailableHtml() {
    return `<div class="pbe-access-unavailable" data-access-state="unavailable">
      <div class="pbe-pro-plan-label">NFL PRO · ACCESS CHECK</div>
      <div class="pbe-pro-renew"><strong>We couldn't verify NFL Pro access right now.</strong></div>
      <div class="pbe-pro-auth-copy">Every public NFL page keeps working. Pro features stay locked until the check succeeds; nothing about your subscription has changed.</div>
      <button class="pbe-pro-cta" id="pbe-pro-refresh" type="button">Retry access check</button>
      <div class="pbe-pro-message" id="pbe-pro-message"></div>
    </div>`;
  }

  function proUserHtml() {
    const email = state.user?.email || 'NFL Pro account';
    const periodEnd = state.subscription?.current_period_end ? new Date(state.subscription.current_period_end) : null;
    const renewCopy = periodEnd && !Number.isNaN(periodEnd.getTime())
      ? `${state.subscription?.cancel_at_period_end ? 'Access through' : 'Current period through'} ${periodEnd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`
      : 'Entitlement verified by PropBetEdge.';
    const label = memberLabel(state.role === 'owner' ? 'OWNER' : 'NFL PRO ACTIVE');
    const plan = memberPlanText(state.role === 'owner' ? 'Owner access' : 'NFL Pro');
    return `<div class="pbe-pro-price-card" style="border-color:rgba(85,214,140,.20);background:linear-gradient(145deg,rgba(85,214,140,.07),rgba(255,255,255,.018))" data-pbe-membership="${esc(state.membership?.state || '')}">
      <div class="pbe-pro-plan-label" style="color:#55d68c">${esc(label)}</div>
      <div class="pbe-pro-price"><strong style="font-size:42px;color:#55d68c">UNLOCKED</strong></div>
      <div class="pbe-pro-renew">${esc(renewCopy)}</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>${esc(plan)}</span></div>
    <button class="pbe-pro-cta" type="button" id="pbe-pro-open-board">Open Pro Prop Board</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">Refresh access</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ ${esc(label)} · verified by PropBetEdge</div>`;
  }

  function ensureModal() {
    let backdrop = document.getElementById('pbe-pro-backdrop');
    if (!backdrop) {
      document.body.insertAdjacentHTML('beforeend',modalHtml());
      backdrop = document.getElementById('pbe-pro-backdrop');
      backdrop?.querySelector('.pbe-pro-close')?.addEventListener('click',close);
      backdrop?.addEventListener('click',event => { if (event.target === backdrop) close(); });
    }
    return backdrop;
  }

  /* This file owns auth STATE. paywall-funnel-v2.js owns the SIGNED-OUT
   * checkout UI. Rendering signedOutHtml() here as well made the two fight over
   * #pbe-pro-checkout on every mutation, wiping whatever email had been typed.
   * signedOutHtml() is now only the fallback for when the funnel never loaded. */
  function renderModal() {
    const backdrop = ensureModal();
    const host = backdrop?.querySelector('#pbe-pro-checkout');
    if (!host) return;

    if (state.loading) {
      if (setHtml(host,`<div class="pbe-pro-market-empty">Checking your PropBetEdge NFL session and Pro access…</div>`)) wireModalActions();
      return;
    }
    if (state.access === 'unavailable') {
      /* A signed-in reader whose check failed belongs to sports-shell-auth-state.js
       * (the shell's account authority, which renders its own protected screen).
       * This file owns only the case where no identity could be read at all. */
      if (state.user) return;
      if (setHtml(host,unavailableHtml())) wireModalActions();
      return;
    }
    if (window.PBECheckoutFunnel?.apply) {
      window.PBECheckoutFunnel.apply();
      paintNotice();
      return;
    }
    if (state.pro || state.user) {
      if (setHtml(host,state.pro ? proUserHtml() : freeUserHtml())) wireModalActions();
      paintNotice();
      return;
    }
    if (setHtml(host,signedOutHtml())) wireModalActions();
    paintNotice();
  }

  function message(text,type='') {
    /* The checkout funnel (paywall-funnel-v2.js) renders its own message slot. */
    const el = document.getElementById('pbe-pro-message') || document.getElementById('pbe-funnel-message');
    if (!el) return;
    const className = `pbe-pro-message ${type}`.trim();
    if (el.className !== className) el.className = className;
    setText(el,text || '');
  }

  /* A reason the reader must keep seeing (a refused link, a checkout return)
   * lives in state and is re-painted at the top of the checkout panel every
   * time either this file or paywall-funnel-v2.js re-renders it. message() is
   * for transient feedback inside the current render. */
  function notice(text,type='') {
    state.notice = text ? { text, type } : null;
    paintNotice();
  }

  function paintNotice() {
    const host = document.getElementById('pbe-pro-checkout');
    if (!host) return;
    let el = host.querySelector(':scope > .pbe-access-notice');
    if (!state.notice) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('role','status');
      el.style.margin = '0 0 14px';
      host.prepend(el);
    }
    const className = `pbe-access-notice pbe-pro-message ${state.notice.type}`.trim();
    if (el.className !== className) el.className = className;
    setText(el,state.notice.text);
  }

  async function signIn() {
    const input = document.getElementById('pbe-pro-email');
    const button = document.getElementById('pbe-pro-signin');
    const email = (input?.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return message('Enter a valid email address.','error');
    if (button) button.disabled = true;
    message('Sending your secure PropBetEdge NFL sign-in link…');
    try {
      const response = await nativeFetch('/api/auth-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({ email })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Email sign-in is unavailable right now.');
      if (payload?.provider !== 'resend' || payload?.auth_issuer !== 'propbetedge') throw new Error('PropBetEdge NFL sign-in is not fully configured yet.');
      message(payload?.message || 'Check your inbox. Your PropBetEdge NFL sign-in link is on the way.','success');
    } catch (error) {
      message(error?.message || 'Unable to send the sign-in link.','error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* Fallback purchase path (paywall-funnel-v2.js normally replaces it): the
   * Founding Season Payment Link, locked to the verified email. */
  async function checkout(ref) {
    if (!state.user) {
      open('signin');
      message('Sign in first so Stripe can be locked to your verified email.');
      return;
    }
    const plan = planFor(ref) || PRICING.monthly;
    const button = document.getElementById(`pbe-pro-buy-${plan.key}`);
    if (button) button.disabled = true;
    message('Opening secure Stripe checkout…');
    const url = new URL(plan.url);
    url.searchParams.set('locked_prefilled_email', state.user.email);
    window.location.href = url.toString();
  }

  async function signOut() {
    try {
      await nativeFetch('/api/auth-logout', {
        method: 'POST',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin'
      });
    } catch (_) {}
    state.session = null;
    state.user = null;
    state.pro = false;
    state.access = 'anonymous';
    state.role = null;
    state.entitlement = null;
    state.subscription = null;
    state.membership = readMembership(null);
    state.error = null;
    state.loading = false;
    applyState();
    /* Confirm against the server that the cookie is actually gone rather than
     * trusting local state. */
    await refreshAccess({ preserveOnError:false });
    message(state.user ? 'Sign out did not clear the session. Please reload.' : 'Signed out.', state.user ? 'error' : 'success');
  }

  async function refreshAccess({ preserveOnError = true } = {}) {
    const hadIdentity = Boolean(state.user);
    state.loading = !hadIdentity;
    state.error = null;
    if (!hadIdentity) renderModal();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
    try {
      const response = await nativeFetch('/api/auth-session', {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Session service unavailable.');

      const valid = payload?.valid === true;
      const access = ACCESS_STATES.has(payload?.access) ? payload.access : (valid ? 'unavailable' : 'anonymous');
      state.session = valid ? { issuer: 'propbetedge', valid: true } : null;
      state.user = valid && payload?.user?.email ? { email: String(payload.user.email).toLowerCase() } : null;
      /* A verified email with no NFL entitlement is paywalled, never a signed-in
       * NFL customer: the server clears that session; the page shows the plans. */
      if (access === 'no_entitlement') { state.session = null; state.user = null; }
      /* Pro only when the server says granted AND pro, for a verified session. */
      state.pro = Boolean(valid && payload?.pro === true && access === 'granted');
      state.access = access === 'granted' && !state.pro ? 'unavailable' : access;
      state.role = state.pro && payload?.role === 'owner' ? 'owner' : state.pro ? 'subscriber' : null;
      state.entitlement = payload?.entitlement || null;
      state.subscription = state.pro ? (payload?.subscription || null) : null;
      /* Membership can never claim more than the access verdict above grants. */
      const membership = readMembership(payload?.membership);
      state.membership = state.pro || !membership.entitled ? membership : readMembership(null);
      /* /api/auth-session reports the stage it reached, so a backend failure is
       * no longer indistinguishable from a genuinely signed-out visitor. */
      state.stage = payload?.stage || null;
      if (payload?.degraded) state.error = `Access check degraded (${payload?.error || payload?.stage || 'unknown'}).`;
    } catch (error) {
      /* "degraded" is the word sports-shell-auth-state.js keys its protected
       * signed-in screen on; a preserved identity must reach it. */
      state.error = `Access check degraded (${error?.name === 'AbortError' ? 'timed out' : (error?.message || 'session service unavailable')}).`;
      state.pro = false;
      state.role = null;
      state.subscription = null;
      state.membership = readMembership(null);
      state.access = 'unavailable';
      if (!preserveOnError || !hadIdentity) {
        state.session = null;
        state.user = null;
      }
    } finally {
      clearTimeout(timer);
      state.loading = false;
      applyState();
    }
    return state.pro;
  }

  function accountButtonHtml() {
    if (state.loading) return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">Account</span>`;
    if (state.pro) return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">${esc(memberLabel('NFL Pro'))}</span>`;
    if (state.user) return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">Upgrade</span>`;
    return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">Sign In · Pro</span>`;
  }

  function ensureAccountButton() {
    const nav = document.querySelector('.pbes-right') || document.querySelector('.pbe-v2-network-links.right');
    if (!nav) return false;
    let button = document.getElementById('pbe-pro-account');
    if (!button) {
      button = document.createElement('button');
      button.id = 'pbe-pro-account';
      button.type = 'button';
      button.addEventListener('click',() => open('account'));
      nav.appendChild(button);
    }
    const nextClass = `pbe-pro-account ${state.pro ? 'pro' : ''} ${state.user ? 'signed-in' : ''}`.trim();
    if (button.className !== nextClass) button.className = nextClass;
    setHtml(button,accountButtonHtml());
    return true;
  }

  function dashboardStrip() {
    const dashboard = document.querySelector('.pbe-v2-dashboard');
    const hero = dashboard?.querySelector('.pbe-v2-hero');
    if (!dashboard || !hero) return;
    let strip = dashboard.querySelector('.pbe-pro-dashboard-strip');
    if (!strip) {
      strip = document.createElement('section');
      hero.insertAdjacentElement('afterend',strip);
    }
    const nextClass = `pbe-pro-dashboard-strip ${state.pro ? 'pro' : ''}`.trim();
    if (strip.className !== nextClass) strip.className = nextClass;
    const next = state.pro
      ? `<div><div class="pbe-pro-dashboard-title"><span>${esc(memberLabel('NFL PRO ACTIVE'))}</span> · Proprietary PBE model intelligence is unlocked.</div><div class="pbe-pro-dashboard-copy">Fair lines, probability and model-gap output are available anywhere the production model supports the current market.</div></div><button class="pbe-pro-mini-cta" data-pbe-route="propboard">Open Pro Board</button>`
      : `<div><div class="pbe-pro-dashboard-title"><span>NFL PRO</span> · Unlock the proprietary layer above the sportsbook market.</div><div class="pbe-pro-dashboard-copy">Free access keeps current book numbers useful. Pro adds PBE fair line, model probability, model gap and premium tools as they launch.</div></div><button class="pbe-pro-mini-cta" data-pbe-open-pro>Unlock NFL Pro</button>`;
    setHtml(strip,next);
    strip.querySelector('[data-pbe-route="propboard"]')?.addEventListener('click',()=>window.App?.nav?.('propboard'));
    strip.querySelector('[data-pbe-open-pro]')?.addEventListener('click',()=>open('upgrade'));
  }

  function propBoardBanner() {
    const board = document.querySelector('.pbe3-propboard,.pbe2-propboard');
    const anchor = board?.querySelector('.pbe3-kpis,.pbe2-kpis,.pbe3-event,.pbe2-event');
    if (!board || !anchor) return;
    let banner = board.querySelector('.pbe-pro-board-banner');
    if (!banner) {
      banner = document.createElement('section');
      anchor.insertAdjacentElement('beforebegin',banner);
    }
    const nextClass = `pbe-pro-board-banner ${state.pro ? 'pro' : ''}`.trim();
    if (banner.className !== nextClass) banner.className = nextClass;
    const next = state.pro
      ? `<div><strong>NFL Pro is active.</strong><span>PBE fair line, probability and model gap are unlocked for supported props. Market and model provenance remain separate.</span></div><span class="pbe-pro-active-badge">◆ PRO UNLOCKED</span>`
      : `<div><strong>Current sportsbook pricing is free. PBE model intelligence is NFL Pro.</strong><span>Sign in and upgrade to unlock fair line, model probability and model gap without hiding the underlying market.</span></div><button class="pbe-pro-mini-cta" data-pbe-open-pro>Unlock NFL Pro</button>`;
    setHtml(banner,next);
    banner.querySelector('[data-pbe-open-pro]')?.addEventListener('click',()=>open('upgrade'));
  }

  function marketPulsePaywall() {
    const card = document.getElementById('pbe-v2-market-card');
    const content = card?.querySelector('.pbe-v2-market-content');
    if (!card || !content) return;
    const existing = content.querySelector('.pbe-pro-market-tease');
    if (state.pro) {
      existing?.remove();
      return;
    }
    let tease = existing;
    if (!tease) {
      tease = document.createElement('button');
      tease.type = 'button';
      tease.className = 'pbe-pro-mini-cta pbe-pro-market-tease';
      tease.style.cssText = 'width:100%;margin-top:12px;height:36px';
      tease.addEventListener('click',() => open('upgrade'));
      content.appendChild(tease);
    }
    setText(tease,'Unlock PBE Fair Line + Model Gap · NFL Pro');
  }

  function applyState() {
    document.body?.classList.toggle('pbe-has-pro',state.pro);
    document.body?.classList.toggle('pbe-signed-in',Boolean(state.user));
    ensureAccountButton();
    dashboardStrip();
    propBoardBanner();
    marketPulsePaywall();
    renderModal();
    document.documentElement.dataset.pbeAccess = state.loading ? 'checking' : state.access;
    window.dispatchEvent(new CustomEvent('pbe:pro-state',{ detail:{ pro:state.pro, access:state.access, role:state.role, membership:state.membership, signedIn:Boolean(state.user), email:state.user?.email || null, issuer:'propbetedge' } }));
  }

  function decorateContinuously() {
    let queued = false;
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
        return !target?.closest?.('#pbe-pro-backdrop,.pbe-pro-dashboard-strip,.pbe-pro-board-banner,.pbe-pro-market-tease');
      });
      if (!relevant || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        ensureAccountButton();
        dashboardStrip();
        propBoardBanner();
        marketPulsePaywall();
      });
    });
    const root = document.getElementById('view-container') || document.documentElement;
    observer.observe(root,{subtree:true,childList:true});
  }

  function wireModalActions() {
    document.getElementById('pbe-pro-signin')?.addEventListener('click',signIn);
    document.getElementById('pbe-pro-email')?.addEventListener('keydown',event => {
      if (event.key === 'Enter') signIn();
    });
    document.getElementById('pbe-pro-buy-monthly')?.addEventListener('click',() => checkout('monthly'));
    document.getElementById('pbe-pro-buy-weekly')?.addEventListener('click',() => checkout('weekly'));
    document.getElementById('pbe-pro-refresh')?.addEventListener('click',async event => {
      const button = event.currentTarget;
      button.disabled = true;
      message('Checking NFL Pro access…');
      await refreshAccess();
      if (!state.pro) message(state.error || 'NFL Pro is not active on this signed-in email yet. If you just subscribed, give the webhook a few seconds and refresh again.');
      button.disabled = false;
    });
    document.getElementById('pbe-pro-signout')?.addEventListener('click',signOut);
    document.getElementById('pbe-pro-open-board')?.addEventListener('click',()=>{ close(); window.App?.nav?.('propboard'); });
  }

  function open() {
    const backdrop = ensureModal();
    renderModal();
    backdrop?.classList.add('open');
    /* One vertical scroll context while the purchase surface is open: the
     * page is locked (html + body) and the backdrop is the only scroller. The
     * card itself never scrolls (nfl-all-access-hero-v1.css). */
    document.body.style.overflow = 'hidden';
    document.documentElement.classList.add('pbe-pro-open');
    if (backdrop) backdrop.scrollTop = 0;
    setTimeout(() => document.getElementById('pbe-pro-email')?.focus(),30);
  }

  function close() {
    state.notice = null;
    paintNotice();
    document.getElementById('pbe-pro-backdrop')?.classList.remove('open');
    document.body.style.overflow = '';
    document.documentElement.classList.remove('pbe-pro-open');
  }

  function cleanQuery(keys) {
    try {
      const url = new URL(location.href);
      keys.forEach(key => url.searchParams.delete(key));
      history.replaceState({},'',url.pathname + (url.search ? url.search : '') + url.hash);
    } catch (_) {}
  }

  /* A successful magic-link return must NOT reopen the checkout modal. Doing so
   * is what made a working sign-in look identical to a failed one, and it is
   * half of the reported "click link -> still signed out" loop. */
  async function handleAuthReturn() {
    const params = new URLSearchParams(location.search);
    const auth = params.get('auth');
    if (!auth) return;
    cleanQuery(['auth','session']);

    if (auth === 'complete') {
      if (!state.user) await refreshAccess({ preserveOnError:false });
      if (state.user) { applyState(); return; }
      open('auth-incomplete');
      message(state.error || 'We could not confirm the new session. Request another secure sign-in link.','error');
      return;
    }

    if (auth === 'not_authorized') {
      open('upgrade');
      notice('No active NFL Pro access is linked to that email. Choose a plan to unlock NFL Pro.','error');
      return;
    }

    open('auth-failed');
    const why = auth === 'token_expired' ? 'That sign-in link has expired.'
      : auth === 'link_already_used' ? 'That sign-in link was already used. Each link works once.'
        : /unavailable|^exchange_/.test(auth) ? 'Sign-in is temporarily unavailable.'
          : 'That sign-in link is not valid.';
    notice(`${why} Request a new secure link. The rest of the site is unaffected.`,'error');
  }

  async function syncCheckoutSuccess() {
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') !== 'success') return;
    state.checkoutSyncing = true;
    for (let i = 0; i < 7; i++) {
      await refreshAccess();
      if (state.pro) break;
      await new Promise(resolve => setTimeout(resolve,1400));
    }
    state.checkoutSyncing = false;
    open('checkout-success');
    /* access_email is api/checkout-complete.js's CONFIRMED delivery result:
     * sent / already_sent only when the auth Worker actually sent the link. */
    const delivery = params.get('access_email');
    if (state.pro) notice('NFL Pro is active. Your premium model intelligence is unlocked.','success');
    else if (delivery === 'sent' || delivery === 'already_sent') notice('Payment received. Your secure NFL Pro access link was sent to the email you used at checkout.','success');
    else notice('Payment received. Your access link has not been sent yet. In a minute, enter the email you used at checkout and choose "Sign in to NFL Pro" to request your secure access link.');
    cleanQuery(['checkout','session_id','tier','access_email']);
  }

  async function init() {
    ensureModal();
    document.addEventListener('keydown',event => { if (event.key === 'Escape') close(); });
    decorateContinuously();
    await refreshAccess({ preserveOnError:false });
    await handleAuthReturn();
    await syncCheckoutSuccess();
  }

  window.PBEPro = {
    state,
    denialNote,
    pricing: PRICING,
    prices: { monthly: PRICING.monthly.priceId, weekly: PRICING.weekly.priceId },
    paymentLinks: { monthly: PRICING.monthly.url, weekly: PRICING.weekly.url },
    open,
    close,
    notice,
    paintNotice,
    checkout,
    refreshAccess,
    getToken,
    require(feature='NFL Pro') {
      if (state.pro) return true;
      open(feature);
      return false;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
