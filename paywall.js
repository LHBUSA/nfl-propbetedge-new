/* PropBetEdge NFL Pro
 * Identity + session: first-party PropBetEdge NFL auth Worker via same-origin bridges
 * Email delivery: Resend
 * Billing: Stripe Checkout Session with server-side locked Payment Link fallback
 * Entitlement: nfl_subscriptions through Worker session state
 */
(() => {
  'use strict';

  const WEEKLY_PAYMENT_LINK = 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05';
  const SEASON_PASS_PAYMENT_LINK = 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06';
  const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
  const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
  const SEASON_PASS_THROUGH = 'February 14, 2027';
  const MODEL_UPSTREAM_PREFIX = 'https://nfl-api.propbetedge.ai/api/picks/pass';

  const state = {
    session: null,
    user: null,
    pro: false,
    loading: true,
    subscription: null,
    checkoutSyncing: false,
    stage: null,
    error: null
  };

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
            <div class="pbe-pro-kicker">PROPBETEDGE NFL PRO</div>
            <h2>See the market.<br><em>Own the intelligence.</em></h2>
            <p>Sportsbook pricing stays useful for everyone. NFL Pro unlocks the proprietary PBE layer built on top of the market: fair lines, model probability, model gap and the premium tools we add next.</p>
            <div class="pbe-pro-feature-list">
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">◇</div><div><strong>PBE Fair Line</strong><span>See where the current passing model prices the prop independent of the sportsbook consensus.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">%</div><div><strong>Model Probability</strong><span>Unlock the model's probability at the current consensus line with explicit model provenance.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">↗</div><div><strong>Model Gap</strong><span>Compare market consensus with PBE fair value without relabeling the difference as guaranteed edge.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">＋</div><div><strong>Premium modules as they clear validation</strong><span>Usage, matchup, simulation, SGP and live intelligence move behind the same NFL Pro entitlement as they become production-ready.</span></div></div>
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
      <div class="pbe-pro-renew">Sign in once, then choose $9.99/week or the $99 Season Pass.</div>
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
    return `<div class="pbe-pro-plans">
      <div class="pbe-pro-price-card" data-plan="season">
        <div class="pbe-pro-plan-label">NFL PRO · SEASON PASS</div>
        <div class="pbe-pro-price"><strong>$99</strong><span>one time</span></div>
        <div class="pbe-pro-renew">Access through ${SEASON_PASS_THROUGH}. No recurring billing.</div>
        <button class="pbe-pro-cta" id="pbe-pro-buy-season" type="button">Get Season Pass</button>
      </div>
      <div class="pbe-pro-price-card" data-plan="weekly">
        <div class="pbe-pro-plan-label">NFL PRO · WEEKLY</div>
        <div class="pbe-pro-price"><strong>$9.99</strong><span>/ week</span></div>
        <div class="pbe-pro-renew">Renews automatically each week until canceled. No trial. Cancel anytime.</div>
        <button class="pbe-pro-cta secondary" id="pbe-pro-buy-weekly" type="button">Start Weekly</button>
      </div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>Signed in · Free access</span></div>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">I already subscribed · Refresh access</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-auth-copy">Stripe checkout is locked to <strong>${esc(email)}</strong>. Your purchase is matched back to this verified PropBetEdge NFL session.</div>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ Verified email identity · Secure checkout powered by Stripe</div>`;
  }

  function proUserHtml() {
    const email = state.user?.email || 'NFL Pro account';
    const periodEnd = state.subscription?.current_period_end ? new Date(state.subscription.current_period_end) : null;
    const renewCopy = periodEnd && !Number.isNaN(periodEnd.getTime())
      ? `${state.subscription?.cancel_at_period_end ? 'Access through' : 'Current period through'} ${periodEnd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`
      : 'NFL Pro entitlement verified by PropBetEdge.';
    return `<div class="pbe-pro-price-card" style="border-color:rgba(85,214,140,.20);background:linear-gradient(145deg,rgba(85,214,140,.07),rgba(255,255,255,.018))">
      <div class="pbe-pro-plan-label" style="color:#55d68c">NFL PRO · ACTIVE</div>
      <div class="pbe-pro-price"><strong style="font-size:42px;color:#55d68c">UNLOCKED</strong></div>
      <div class="pbe-pro-renew">${esc(renewCopy)}</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>Verified NFL Pro subscriber</span></div>
    <button class="pbe-pro-cta" type="button" id="pbe-pro-open-board">Open Pro Prop Board</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">Refresh access</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ Access verified against your Stripe-backed NFL entitlement</div>`;
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
    if (state.pro || state.user) {
      if (setHtml(host,state.pro ? proUserHtml() : freeUserHtml())) wireModalActions();
      return;
    }
    if (window.PBECheckoutFunnel?.apply) {
      window.PBECheckoutFunnel.apply();
      return;
    }
    if (setHtml(host,signedOutHtml())) wireModalActions();
  }

  function message(text,type='') {
    const el = document.getElementById('pbe-pro-message');
    if (!el) return;
    const className = `pbe-pro-message ${type}`.trim();
    if (el.className !== className) el.className = className;
    setText(el,text || '');
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

  async function checkout(priceId) {
    if (!state.user) {
      open('signin');
      message('Sign in first so Stripe can be locked to your verified email.');
      return;
    }

    const price = typeof priceId === 'string' && priceId ? priceId : WEEKLY_PRICE_ID;
    if (![WEEKLY_PRICE_ID,SEASON_PASS_PRICE_ID].includes(price)) {
      message('That NFL Pro plan is unavailable. Please refresh and try again.','error');
      return;
    }

    const button = price === WEEKLY_PRICE_ID
      ? document.getElementById('pbe-pro-buy-weekly')
      : document.getElementById('pbe-pro-buy-season');
    if (button) button.disabled = true;
    message('Opening secure Stripe checkout…');

    try {
      const response = await nativeFetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({ priceId: price })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.url) throw new Error(payload?.error || 'Checkout is unavailable right now.');
      window.location.href = payload.url;
    } catch (error) {
      message(error?.message || 'Checkout could not be started. Please try again.','error');
      if (button) button.disabled = false;
    }
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
    state.subscription = null;
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

    try {
      const response = await nativeFetch('/api/auth-session', {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Session service unavailable.');

      state.session = payload?.valid ? { issuer: 'propbetedge', valid: true } : null;
      state.user = payload?.valid && payload?.user?.email ? { email: String(payload.user.email).toLowerCase() } : null;
      state.pro = Boolean(payload?.valid && payload?.pro === true);
      state.subscription = state.pro ? (payload?.subscription || null) : null;
      /* /api/auth-session reports the stage it reached, so a backend failure is
       * no longer indistinguishable from a genuinely signed-out visitor. */
      state.stage = payload?.stage || null;
      if (payload?.degraded) state.error = `Access check degraded (${payload?.error || payload?.stage || 'unknown'}).`;
    } catch (error) {
      state.error = error?.message || 'Session service unavailable.';
      if (!preserveOnError || !hadIdentity) {
        state.session = null;
        state.user = null;
        state.pro = false;
        state.subscription = null;
      }
    } finally {
      state.loading = false;
      applyState();
    }
    return state.pro;
  }

  function accountButtonHtml() {
    if (state.loading) return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">Account</span>`;
    if (state.pro) return `<span class="pbe-pro-account-dot"></span><span class="pbe-pro-account-label">NFL Pro</span>`;
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
      ? `<div><div class="pbe-pro-dashboard-title"><span>NFL PRO ACTIVE</span> · Proprietary PBE model intelligence is unlocked.</div><div class="pbe-pro-dashboard-copy">Fair lines, probability and model-gap output are available anywhere the production model supports the current market.</div></div><button class="pbe-pro-mini-cta" data-pbe-route="propboard">Open Pro Board</button>`
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
    window.dispatchEvent(new CustomEvent('pbe:pro-state',{ detail:{ pro:state.pro, signedIn:Boolean(state.user), email:state.user?.email || null, issuer:'propbetedge' } }));
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
    document.getElementById('pbe-pro-buy-weekly')?.addEventListener('click',() => checkout(WEEKLY_PRICE_ID));
    document.getElementById('pbe-pro-buy-season')?.addEventListener('click',() => checkout(SEASON_PASS_PRICE_ID));
    document.getElementById('pbe-pro-refresh')?.addEventListener('click',async event => {
      const button = event.currentTarget;
      button.disabled = true;
      message('Checking Stripe-backed NFL Pro access…');
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
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('pbe-pro-email')?.focus(),30);
  }

  function close() {
    document.getElementById('pbe-pro-backdrop')?.classList.remove('open');
    document.body.style.overflow = '';
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

    open('auth-failed');
    message(`Your sign-in link could not be used (${auth}). Request a new secure link.`,'error');
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
    if (state.pro) message('NFL Pro is active. Your premium model intelligence is unlocked.','success');
    else if (!state.user) message('Purchase received. Sign in with the same email you used at Stripe to unlock NFL Pro.');
    else message('Stripe checkout completed. Access is still syncing; use Refresh Access in a few seconds.');
    cleanQuery(['checkout','session_id','tier']);
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
    prices: { weekly: WEEKLY_PRICE_ID, seasonPass: SEASON_PASS_PRICE_ID },
    paymentLinks: { weekly: WEEKLY_PAYMENT_LINK, seasonPass: SEASON_PASS_PAYMENT_LINK },
    open,
    close,
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
