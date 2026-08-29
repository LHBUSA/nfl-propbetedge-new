/* PropBetEdge NFL Pro
 * Auth: Supabase passwordless email
 * Billing: Stripe Checkout Session via /api/checkout
 * Entitlement: public.nfl_has_pro_access()
 * PBE model requests are rewritten through /api/pro-model and require NFL Pro.
 */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YkSuX7oXCxyTTMPtPqYIyw_qtbfA5c6';
  const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05';
  const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
  /* Must match WEEKLY_PRICE_ID in api/checkout.js. Until the real id is filled
   * in there, weekly checkout falls back to STRIPE_PAYMENT_LINK. */
  const WEEKLY_PRICE_ID = 'price_REPLACE_ME_WEEKLY_999';
  const MODEL_UPSTREAM_PREFIX = 'https://nfl-api.propbetedge.ai/api/picks/pass';

  const state = {
    client: null,
    session: null,
    user: null,
    pro: false,
    loading: true,
    subscription: null,
    checkoutSyncing: false
  };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function createClient() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  async function getToken() {
    try {
      if (!state.client) return '';
      const { data } = await state.client.auth.getSession();
      return data?.session?.access_token || '';
    } catch (_) {
      return '';
    }
  }

  /* Install before UI code executes so every PBE model request is entitlement-gated. */
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function pbeEntitledFetch(input, init = {}) {
    try {
      const inputUrl = typeof input === 'string' ? input : input?.url;
      if (inputUrl && inputUrl.startsWith(MODEL_UPSTREAM_PREFIX)) {
        const parsed = new URL(inputUrl);
        const eventId = parsed.searchParams.get('event_id') || '';
        const token = await getToken();
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
        headers.set('accept','application/json');
        if (token) headers.set('authorization',`Bearer ${token}`);
        else headers.delete('authorization');
        return nativeFetch(`/api/pro-model?event_id=${encodeURIComponent(eventId)}`, {
          ...init,
          method: 'GET',
          headers,
          cache: 'no-store'
        });
      }
    } catch (_) {}
    return nativeFetch(input,init);
  };

  function modalHtml() {
    return `<div class="pbe-pro-backdrop" id="pbe-pro-backdrop" role="dialog" aria-modal="true" aria-label="NFL Pro">
      <div class="pbe-pro-modal">
        <button class="pbe-pro-close" type="button" aria-label="Close NFL Pro" onclick="PBEPro.close()">×</button>
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
      <div class="pbe-pro-plan-label">NFL PRO · WEEKLY</div>
      <div class="pbe-pro-price"><strong>$9.99</strong><span>/ week</span></div>
      <div class="pbe-pro-renew">Renews automatically each week until canceled. No trial. Cancel anytime.</div>
    </div>
    <div class="pbe-pro-auth-state">
      <input class="pbe-pro-email" id="pbe-pro-email" type="email" autocomplete="email" placeholder="you@example.com" aria-label="Email address">
      <button class="pbe-pro-cta" id="pbe-pro-signin" type="button">Sign in to continue</button>
      <div class="pbe-pro-auth-copy">We use passwordless email sign-in. After you're signed in, checkout with the same email so your NFL Pro subscription can unlock automatically.</div>
      <div class="pbe-pro-message" id="pbe-pro-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ Secure checkout powered by Stripe</div>`;
  }

  function freeUserHtml() {
    const email = state.user?.email || 'Signed-in account';
    return `<div class="pbe-pro-price-card">
      <div class="pbe-pro-plan-label">NFL PRO · WEEKLY</div>
      <div class="pbe-pro-price"><strong>$9.99</strong><span>/ week</span></div>
      <div class="pbe-pro-renew">Renews automatically each week until canceled. No trial. Cancel anytime.</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>Signed in · Free access</span></div>
    <button class="pbe-pro-cta" id="pbe-pro-upgrade" type="button">Upgrade to NFL Pro</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">I already subscribed · Refresh access</button>
    <div class="pbe-pro-auth-copy">At Stripe checkout, use <strong>${esc(email)}</strong>. The NFL subscription webhook matches that email to this signed-in account.</div>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ Secure checkout powered by Stripe</div>`;
  }

  function proUserHtml() {
    const email = state.user?.email || 'NFL Pro account';
    const periodEnd = state.subscription?.current_period_end ? new Date(state.subscription.current_period_end) : null;
    const renewCopy = periodEnd && !Number.isNaN(periodEnd.getTime())
      ? `${state.subscription?.cancel_at_period_end ? 'Access through' : 'Current period through'} ${periodEnd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`
      : 'NFL Pro entitlement verified by Supabase.';
    return `<div class="pbe-pro-price-card" style="border-color:rgba(85,214,140,.20);background:linear-gradient(145deg,rgba(85,214,140,.07),rgba(255,255,255,.018))">
      <div class="pbe-pro-plan-label" style="color:#55d68c">NFL PRO · ACTIVE</div>
      <div class="pbe-pro-price"><strong style="font-size:42px;color:#55d68c">UNLOCKED</strong></div>
      <div class="pbe-pro-renew">${esc(renewCopy)}</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>Verified NFL Pro subscriber</span></div>
    <button class="pbe-pro-cta" type="button" onclick="PBEPro.close();App.nav('propboard')">Open Pro Prop Board</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ Access verified against your active subscription</div>`;
  }

  function renderModal() {
    const host = document.getElementById('pbe-pro-checkout');
    if (!host) return;
    if (state.loading) {
      host.innerHTML = `<div class="pbe-pro-market-empty">Checking your account and NFL Pro access…</div>`;
      return;
    }
    host.innerHTML = state.pro ? proUserHtml() : (state.user ? freeUserHtml() : signedOutHtml());
    wireModalActions();
  }

  function message(text,type='') {
    const el = document.getElementById('pbe-pro-message');
    if (!el) return;
    el.className = `pbe-pro-message ${type}`.trim();
    el.textContent = text || '';
  }

  async function signIn() {
    if (!state.client) return message('Account service is unavailable. Please try again shortly.','error');
    const input = document.getElementById('pbe-pro-email');
    const button = document.getElementById('pbe-pro-signin');
    const email = (input?.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return message('Enter a valid email address.','error');
    if (button) button.disabled = true;
    message('Sending your secure sign-in link…');
    try {
      const options = { shouldCreateUser: true };
      if (location.hostname === 'nfl.propbetedge.ai') {
        options.emailRedirectTo = 'https://nfl.propbetedge.ai/?auth=complete';
      }
      const { error } = await state.client.auth.signInWithOtp({ email, options });
      if (error) throw error;
      message('Check your email. Open the PropBetEdge sign-in link to continue.','success');
    } catch (error) {
      message(error?.message || 'Unable to send the sign-in link.','error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function checkout(priceId) {
    if (!state.user) {
      open('signin');
      return;
    }

    /* wireModalActions() hands this straight to addEventListener, so the first
     * argument is a MouseEvent unless a caller passed a price explicitly. */
    const price = typeof priceId === 'string' && priceId ? priceId : WEEKLY_PRICE_ID;

    try {
      const token = await getToken();
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        cache: 'no-store',
        body: JSON.stringify({ priceId: price })
      });

      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.url) {
        window.location.href = payload.url;
        return;
      }

      /* Weekly still has a working Payment Link, so a misconfigured endpoint
       * must not block the checkout that currently converts. Remove this
       * fallback once WEEKLY_PRICE_ID is the real Stripe id. */
      if (price === WEEKLY_PRICE_ID) {
        window.location.href = STRIPE_PAYMENT_LINK;
        return;
      }

      message(payload.error ? `Checkout unavailable: ${payload.error}` : 'Checkout is unavailable right now. Please try again.');
    } catch (_) {
      if (price === WEEKLY_PRICE_ID) {
        window.location.href = STRIPE_PAYMENT_LINK;
        return;
      }
      message('Checkout could not be started. Please try again.');
    }
  }

  async function signOut() {
    try { await state.client?.auth.signOut(); } catch (_) {}
    await refreshAccess();
    renderModal();
  }

  async function loadSubscription() {
    if (!state.user || !state.client) return null;
    try {
      const { data } = await state.client
        .from('nfl_subscriptions')
        .select('status,current_period_end,cancel_at_period_end,updated_at')
        .order('updated_at',{ascending:false})
        .limit(1)
        .maybeSingle();
      return data || null;
    } catch (_) {
      return null;
    }
  }

  async function refreshAccess() {
    state.loading = true;
    try {
      if (!state.client) {
        state.session = null;
        state.user = null;
        state.pro = false;
        state.subscription = null;
        return false;
      }
      const { data: sessionData } = await state.client.auth.getSession();
      state.session = sessionData?.session || null;
      state.user = state.session?.user || null;
      if (!state.user) {
        state.pro = false;
        state.subscription = null;
      } else {
        const [{ data: hasPro, error }, subscription] = await Promise.all([
          state.client.rpc('nfl_has_pro_access'),
          loadSubscription()
        ]);
        state.pro = !error && hasPro === true;
        state.subscription = subscription;
      }
    } catch (_) {
      state.pro = false;
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
    const nav = document.querySelector('.pbe-v2-network-links.right');
    if (!nav) return false;
    let button = document.getElementById('pbe-pro-account');
    if (!button) {
      button = document.createElement('button');
      button.id = 'pbe-pro-account';
      button.type = 'button';
      button.onclick = () => open('account');
      nav.appendChild(button);
    }
    button.className = `pbe-pro-account ${state.pro ? 'pro' : ''} ${state.user ? 'signed-in' : ''}`.trim();
    button.innerHTML = accountButtonHtml();
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
    strip.className = `pbe-pro-dashboard-strip ${state.pro ? 'pro' : ''}`;
    if (state.pro) {
      strip.innerHTML = `<div><div class="pbe-pro-dashboard-title"><span>NFL PRO ACTIVE</span> · Proprietary PBE model intelligence is unlocked.</div><div class="pbe-pro-dashboard-copy">Fair lines, probability and model-gap output are available anywhere the production model supports the current market.</div></div><button class="pbe-pro-mini-cta" onclick="App.nav('propboard')">Open Pro Board</button>`;
    } else {
      strip.innerHTML = `<div><div class="pbe-pro-dashboard-title"><span>NFL PRO</span> · Unlock the proprietary layer above the sportsbook market.</div><div class="pbe-pro-dashboard-copy">Free access keeps current book numbers useful. Pro adds PBE fair line, model probability, model gap and premium tools as they launch.</div></div><button class="pbe-pro-mini-cta" onclick="PBEPro.open('upgrade')">Unlock for $9.99/week</button>`;
    }
  }

  function propBoardBanner() {
    const board = document.querySelector('.pbe2-propboard');
    const anchor = board?.querySelector('.pbe2-kpis') || board?.querySelector('.pbe2-event');
    if (!board || !anchor) return;
    let banner = board.querySelector('.pbe-pro-board-banner');
    if (!banner) {
      banner = document.createElement('section');
      anchor.insertAdjacentElement('beforebegin',banner);
    }
    banner.className = `pbe-pro-board-banner ${state.pro ? 'pro' : ''}`;
    if (state.pro) {
      banner.innerHTML = `<div><strong>NFL Pro is active.</strong><span>PBE fair line, probability and model gap are unlocked for supported props. Market and model provenance remain separate.</span></div><span class="pbe-pro-active-badge">◆ PRO UNLOCKED</span>`;
    } else {
      banner.innerHTML = `<div><strong>Current sportsbook pricing is free. PBE model intelligence is NFL Pro.</strong><span>Sign in and upgrade to unlock fair line, model probability and model gap without hiding the underlying market.</span></div><button class="pbe-pro-mini-cta" onclick="PBEPro.open('upgrade')">Unlock NFL Pro</button>`;
    }
    const modelPill = board.querySelector('.pbe2-pill.model');
    if (modelPill && !state.pro) modelPill.textContent = 'NFL PRO · MODEL LOCKED';
    const footer = board.querySelector('.pbe2-board-foot span:last-child');
    if (footer && !state.pro) footer.textContent = 'NFL PRO MODEL LOCKED · MARKET DATA REMAINS AVAILABLE';
  }

  function marketPulsePaywall() {
    const card = document.getElementById('pbe-v2-market-card');
    const content = card?.querySelector('.pbe-v2-market-content');
    if (!card || !content || state.pro) return;
    let tease = content.querySelector('.pbe-pro-market-tease');
    if (!tease) {
      tease = document.createElement('button');
      tease.type = 'button';
      tease.className = 'pbe-pro-mini-cta pbe-pro-market-tease';
      tease.style.cssText = 'width:100%;margin-top:12px;height:36px';
      tease.onclick = () => open('upgrade');
      content.appendChild(tease);
    }
    tease.textContent = 'Unlock PBE Fair Line + Model Gap · NFL Pro';
  }

  function applyState() {
    document.body?.classList.toggle('pbe-has-pro',state.pro);
    document.body?.classList.toggle('pbe-signed-in',Boolean(state.user));
    ensureAccountButton();
    dashboardStrip();
    propBoardBanner();
    marketPulsePaywall();
    renderModal();
    window.dispatchEvent(new CustomEvent('pbe:pro-state',{ detail:{ pro:state.pro, signedIn:Boolean(state.user) } }));
  }

  function decorateContinuously() {
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        ensureAccountButton();
        dashboardStrip();
        propBoardBanner();
        marketPulsePaywall();
      });
    });
    observer.observe(document.documentElement,{subtree:true,childList:true});
  }

  function wireModalActions() {
    document.getElementById('pbe-pro-signin')?.addEventListener('click',signIn);
    document.getElementById('pbe-pro-email')?.addEventListener('keydown',event => {
      if (event.key === 'Enter') signIn();
    });
    document.getElementById('pbe-pro-upgrade')?.addEventListener('click',checkout);
    document.getElementById('pbe-pro-refresh')?.addEventListener('click',async event => {
      event.currentTarget.disabled = true;
      message('Checking Stripe-backed NFL Pro access…');
      await refreshAccess();
      renderModal();
      if (!state.pro) message('NFL Pro is not active on this signed-in email yet. If you just subscribed, give the webhook a few seconds and refresh again.');
    });
    document.getElementById('pbe-pro-signout')?.addEventListener('click',signOut);
  }

  function open() {
    let backdrop = document.getElementById('pbe-pro-backdrop');
    if (!backdrop) {
      document.body.insertAdjacentHTML('beforeend',modalHtml());
      backdrop = document.getElementById('pbe-pro-backdrop');
      backdrop?.addEventListener('click',event => { if (event.target === backdrop) close(); });
    }
    renderModal();
    backdrop?.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('pbe-pro-email')?.focus(),30);
  }

  function close() {
    document.getElementById('pbe-pro-backdrop')?.classList.remove('open');
    document.body.style.overflow = '';
  }

  async function syncCheckoutSuccess() {
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') !== 'success') return;
    state.checkoutSyncing = true;
    for (let i = 0; i < 5; i++) {
      await refreshAccess();
      if (state.pro) break;
      await new Promise(resolve => setTimeout(resolve,1600));
    }
    state.checkoutSyncing = false;
    open('checkout-success');
    if (state.pro) message('NFL Pro is active. Your premium model intelligence is unlocked.','success');
    else if (!state.user) message('Purchase received. Sign in with the same email you used at Stripe to unlock NFL Pro.');
    else message('Stripe checkout completed. Subscription access may still be syncing; use Refresh Access in a few seconds.');
    try {
      const url = new URL(location.href);
      url.searchParams.delete('checkout');
      history.replaceState({},'',url.pathname + (url.search ? url.search : '') + url.hash);
    } catch (_) {}
  }

  async function init() {
    state.client = createClient();
    if (!document.getElementById('pbe-pro-backdrop')) document.body.insertAdjacentHTML('beforeend',modalHtml());
    document.getElementById('pbe-pro-backdrop')?.addEventListener('click',event => {
      if (event.target.id === 'pbe-pro-backdrop') close();
    });
    document.addEventListener('keydown',event => { if (event.key === 'Escape') close(); });
    decorateContinuously();
    await refreshAccess();
    state.client?.auth.onAuthStateChange(() => setTimeout(refreshAccess,0));
    await syncCheckoutSuccess();
  }

  window.PBEPro = {
    state,
    prices: { weekly: WEEKLY_PRICE_ID, seasonPass: SEASON_PASS_PRICE_ID },
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
