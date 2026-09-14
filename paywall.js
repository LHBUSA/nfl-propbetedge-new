/* PropBetEdge NFL Pro
 * Identity + session: first-party PropBetEdge NFL auth Worker via same-origin bridges
 * Email delivery: Resend
 * Billing: Stripe Checkout Session with server-side locked Payment Link fallback
 * Entitlement: nfl_subscriptions, decided server-side (api/_nfl-entitlement.js)
 *
 * Identity is not access. `state.user` is who signed in; `state.access` is the
 * server's verdict: anonymous | no_entitlement | unavailable | granted
 * (a current NFL Pro subscription or the verified owner). The site is public;
 * `granted` unlocks the premium modules, whose data the server also enforces.
 * An unreadable or failed answer is `unavailable`, never granted.
 */
(() => {
  'use strict';

  const WEEKLY_PAYMENT_LINK = 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05';
  const SEASON_PASS_PAYMENT_LINK = 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06';
  const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
  const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
  const SEASON_PASS_THROUGH = 'February 14, 2027';
  const MODEL_UPSTREAM_PREFIX = 'https://nfl-api.propbetedge.ai/api/picks/pass';
  const GATEWAY_ORIGIN = 'https://nfl-api.propbetedge.ai';
  const ACCESS_STATES = new Set(['anonymous', 'no_entitlement', 'unavailable', 'granted']);

  const state = {
    session: null,
    user: null,
    pro: false,
    access: 'unavailable',
    entitlement: null,
    wall: false,
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

  /* Every paid NFL data read is entitlement-gated server-side. Product modules
   * still name the gateway (https://nfl-api.propbetedge.ai/...); those reads are
   * sent to the same-origin protected route /api/gw/... instead, where the
   * HttpOnly session cookie and the NFL entitlement are verified before the
   * gateway is called with a server-only token. The browser never reaches the
   * gateway directly and holds no credential for it. */
  let recheckTimer = 0;
  function noteAccess(response) {
    const verdict = response?.headers?.get?.('x-pbe-access');
    if (!verdict || verdict === 'granted' || ![401, 403, 503].includes(response.status)) return;
    if (!state.pro || recheckTimer) return;
    /* a paid route refused a session the page believed was entitled: ask the
       server again; the access gate tears the workspace down if it has ended */
    recheckTimer = setTimeout(() => { recheckTimer = 0; refreshAccess({ preserveOnError:false }); }, 1500);
  }

  function sameOriginInit(init, input, method = 'GET') {
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input?.headers : undefined) || {});
    headers.set('accept','application/json');
    headers.delete('authorization');
    return { ...init, method, headers, cache: 'no-store', credentials: 'same-origin' };
  }

  window.fetch = async function pbeEntitledFetch(input, init = {}) {
    let target = null;
    try {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (inputUrl && inputUrl.startsWith(MODEL_UPSTREAM_PREFIX)) {
        const parsed = new URL(inputUrl);
        const eventId = parsed.searchParams.get('event_id') || '';
        target = [`/api/pro-model?event_id=${encodeURIComponent(eventId)}`, sameOriginInit(init, input)];
      } else if (inputUrl && inputUrl.startsWith(`${GATEWAY_ORIGIN}/`)) {
        const parsed = new URL(inputUrl);
        target = [`/api/gw${parsed.pathname}${parsed.search}`, sameOriginInit(init, input)];
      }
    } catch (_) {
      target = null;
    }
    const response = target ? await nativeFetch(target[0], target[1]) : await nativeFetch(input,init);
    noteAccess(response);
    return response;
  };

  function modalHtml() {
    return `<div class="pbe-pro-backdrop" id="pbe-pro-backdrop" role="dialog" aria-modal="true" aria-label="NFL Pro">
      <div class="pbe-pro-modal">
        <button class="pbe-pro-close" type="button" aria-label="Close NFL Pro">×</button>
        <div class="pbe-pro-modal-grid">
          <section class="pbe-pro-pitch">
            <div class="pbe-pro-kicker">PROPBETEDGE NFL PRO</div>
            <h2>See the market.<br><em>Own the intelligence.</em></h2>
            <p>The market, scores, news and research stay open. NFL Pro unlocks the proprietary PBE layer on top: the model's fair lines and probabilities, live PBE Picks, Model Lab, Market Watch, Line Simulator and SGP Lab.</p>
            <div class="pbe-access-status" id="pbe-access-status" hidden></div>
            <div class="pbe-pro-feature-list">
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">◇</div><div><strong>PBE Fair Line</strong><span>See where the current passing model prices the prop independent of the sportsbook consensus.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">%</div><div><strong>Model Probability</strong><span>Unlock the model's probability at the current consensus line with explicit model provenance.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">↗</div><div><strong>Model Gap</strong><span>Compare market consensus with PBE fair value without relabeling the difference as guaranteed edge.</span></div></div>
              <div class="pbe-pro-feature"><div class="pbe-pro-feature-icon">＋</div><div><strong>Live PBE Picks and Pro tools</strong><span>Today's picks with model detail, Model Lab, Market Watch, Line Simulator and SGP Lab on one NFL Pro subscription.</span></div></div>
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
      <div class="pbe-pro-renew">Sign in once, then choose $9.99/month or $3.99/week.</div>
    </div>
    <div class="pbe-pro-auth-state">
      <input class="pbe-pro-email" id="pbe-pro-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email address">
      <button class="pbe-pro-cta" id="pbe-pro-signin" type="button">Sign in to continue</button>
      <div class="pbe-pro-auth-copy">We send a one-time secure PropBetEdge sign-in link through Resend. Checkout uses this same verified email so Stripe can unlock NFL Pro automatically.</div>
      <div class="pbe-pro-message" id="pbe-pro-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ Passwordless PropBetEdge session · Secure checkout powered by Stripe</div>`;
  }

  const DENIAL_COPY = {
    expired: 'Your NFL Pro access has expired.',
    canceled: 'Your NFL Pro subscription was canceled.',
    payment_failed: 'Your last NFL Pro payment did not go through.',
  };

  /* The account line and why Pro is not unlocked for this visitor. Lives in the
   * pitch column so the purchase funnel never overwrites it. */
  function renderAccessStatus() {
    const el = document.getElementById('pbe-access-status');
    if (!el) return;
    if (state.loading || state.access === 'granted') {
      el.hidden = true;
      setHtml(el,'');
      return;
    }
    const reason = state.entitlement?.reason;
    const note = state.access === 'unavailable'
      ? 'We could not verify NFL access right now. Access is not granted until verification succeeds.'
      : state.access === 'no_entitlement'
        ? (DENIAL_COPY[reason] || 'No current NFL Pro subscription is linked to this email.')
        : 'Sign in with the email tied to your subscription, or choose a plan.';
    /* the purchase column already names the signed-in email */
    const account = state.user?.email
      ? `<div class="pbe-access-account"><span>Not this account?</span><button type="button" class="pbe-access-signout" data-pbe-access-signout>Sign out</button></div>`
      : '';
    el.hidden = false;
    if (setHtml(el,`<p class="pbe-access-note" data-access-state="${esc(state.access)}">${esc(note)}</p>${account}`)) {
      el.querySelector('[data-pbe-access-signout]')?.addEventListener('click',signOut);
    }
  }

  function unavailableHtml() {
    const email = state.user?.email || '';
    return `<div class="pbe-funnel-root pbe-access-unavailable" data-funnel-state="access-unavailable">
      <div class="pbe-funnel-head">
        <span>NFL PRO · ACCESS CHECK</span>
        <strong>Unable to verify access</strong>
        <p>The subscription check is temporarily unavailable, so Pro features stay locked for now. The rest of the site is open, and nothing about your subscription has changed.</p>
      </div>
      ${email ? `<div class="pbe-funnel-user"><span>Signed in as</span><strong>${esc(email)}</strong></div>` : ''}
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <button class="pbe-pro-cta" id="pbe-access-retry" type="button">Retry access check</button>
        <div class="pbe-pro-message" id="pbe-pro-message">${esc(state.error || '')}</div>
      </div>
      <div class="pbe-pro-secure">◆ Fails closed · Pro is never unlocked without a verified NFL subscription</div>
    </div>`;
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
    const owner = state.entitlement?.reason === 'owner';
    const periodEnd = state.subscription?.current_period_end ? new Date(state.subscription.current_period_end) : null;
    const renewCopy = periodEnd && !Number.isNaN(periodEnd.getTime())
      ? `${state.subscription?.cancel_at_period_end ? 'Access through' : 'Current period through'} ${periodEnd.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`
      : owner ? 'Owner access · every NFL Pro feature' : 'NFL Pro entitlement verified by PropBetEdge.';
    return `<div class="pbe-pro-price-card" style="border-color:rgba(85,214,140,.20);background:linear-gradient(145deg,rgba(85,214,140,.07),rgba(255,255,255,.018))">
      <div class="pbe-pro-plan-label" style="color:#55d68c">NFL PRO · ACTIVE</div>
      <div class="pbe-pro-price"><strong style="font-size:42px;color:#55d68c">UNLOCKED</strong></div>
      <div class="pbe-pro-renew">${esc(renewCopy)}</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${esc(email)}</strong><span>${owner ? 'Verified owner' : 'Verified NFL Pro subscriber'}</span></div>
    <button class="pbe-pro-cta" type="button" id="pbe-pro-open-board">Open Pro Prop Board</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-refresh" type="button">Refresh access</button>
    <button class="pbe-pro-cta secondary" id="pbe-pro-signout" type="button">Sign out</button>
    <div class="pbe-pro-message" id="pbe-pro-message"></div>
    <div class="pbe-pro-secure">◆ ${owner ? 'Owner access verified server-side from your emailed sign-in link' : 'Access verified against your Stripe-backed NFL entitlement'}</div>`;
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
  /* A notice (sign-in link refused, payment confirming…) survives the modal
   * re-rendering on every access-state change. */
  function renderModal() {
    renderModalBody();
    paintNotice();
  }

  function renderModalBody() {
    const backdrop = ensureModal();
    const host = backdrop?.querySelector('#pbe-pro-checkout');
    if (!host) return;

    renderAccessStatus();
    if (state.loading) {
      if (setHtml(host,`<div class="pbe-pro-market-empty">Checking your PropBetEdge NFL session and Pro access…</div>`)) wireModalActions();
      return;
    }
    if (state.access === 'unavailable') {
      if (setHtml(host,unavailableHtml())) wireModalActions();
      return;
    }
    /* the Founding Season funnel owns every purchase and account screen */
    if (window.PBECheckoutFunnel?.apply) {
      window.PBECheckoutFunnel.apply();
      return;
    }
    if (state.pro || state.user) {
      if (setHtml(host,state.pro ? proUserHtml() : freeUserHtml())) wireModalActions();
      return;
    }
    if (setHtml(host,signedOutHtml())) wireModalActions();
  }

  function message(text,type='') {
    state.notice = text ? { text, type } : null;
    if (!paintNotice()) {
      const el = document.getElementById('pbe-pro-message') || document.getElementById('pbe-funnel-message');
      if (el) { el.className = 'pbe-pro-message'; setText(el,''); }
    }
  }

  function paintNotice() {
    if (!state.notice) return false;
    /* the funnel owns the signed-out / signed-in-free markup and its own message line */
    const el = document.getElementById('pbe-pro-message') || document.getElementById('pbe-funnel-message');
    if (!el) return true;
    const className = `pbe-pro-message ${state.notice.type}`.trim();
    if (el.className !== className) el.className = className;
    setText(el,state.notice.text);
    return true;
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
    state.access = 'anonymous';
    state.entitlement = null;
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
      /* The server's verdict, validated: anything unrecognized is unavailable. */
      const access = ACCESS_STATES.has(payload?.access) ? payload.access : 'unavailable';
      state.access = access === 'granted' && !(payload?.valid && payload?.pro === true) ? 'unavailable' : access;
      state.pro = state.access === 'granted';
      state.entitlement = payload?.entitlement || null;
      state.subscription = state.pro ? (payload?.subscription || null) : null;
      /* /api/auth-session reports the stage it reached, so a backend failure is
       * no longer indistinguishable from a genuinely signed-out visitor. */
      state.stage = payload?.stage || null;
      if (payload?.degraded) state.error = `Access check degraded (${payload?.error || payload?.stage || 'unknown'}).`;
    } catch (error) {
      state.error = error?.message || 'Session service unavailable.';
      /* fail closed: an unanswered access check never keeps or grants access */
      state.access = 'unavailable';
      state.pro = false;
      state.subscription = null;
      if (!preserveOnError || !hadIdentity) {
        state.session = null;
        state.user = null;
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
      : `<div><div class="pbe-pro-dashboard-title"><span>NFL PRO</span> · Unlock the proprietary layer above the sportsbook market.</div><div class="pbe-pro-dashboard-copy">The market stays open. Pro adds PBE fair lines, model probability, live PBE Picks and the Pro research tools.</div></div><button class="pbe-pro-mini-cta" data-pbe-open-pro>Unlock Pro</button>`;
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
      : `<div><strong>Sportsbook prices are open. PBE model intelligence is NFL Pro.</strong><span>Unlock fair line, model probability and model gap next to the market you are already reading.</span></div><button class="pbe-pro-mini-cta" data-pbe-open-pro>Unlock Pro</button>`;
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
    document.getElementById('pbe-access-retry')?.addEventListener('click',async event => {
      const button = event.currentTarget;
      button.disabled = true;
      message('Checking NFL access…');
      await refreshAccess({ preserveOnError:true });
      if (state.access === 'unavailable') message(state.error || 'Access still cannot be verified. Try again shortly.','error');
      button.disabled = false;
    });
    document.getElementById('pbe-pro-open-board')?.addEventListener('click',()=>{ close(); window.App?.nav?.('propboard'); });
  }

  function open() {
    const backdrop = ensureModal();
    renderModal();
    backdrop?.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('pbe-pro-email')?.focus(),30);
  }

  /* While the product is locked the purchase screen IS the page: it cannot be
   * dismissed to reveal a workspace, because no workspace was loaded. */
  function close() {
    if (state.wall) return;
    state.notice = null;
    document.getElementById('pbe-pro-backdrop')?.classList.remove('open');
    document.body.style.overflow = '';
  }

  function setWall(on) {
    const next = Boolean(on);
    const backdrop = ensureModal();
    state.wall = next;
    backdrop?.classList.toggle('is-wall',next);
    backdrop?.setAttribute('aria-label',next ? 'NFL Pro subscription required' : 'NFL Pro');
    if (next) open();
    else {
      backdrop?.classList.remove('open');
      document.body.style.overflow = '';
    }
    renderModal();
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
    const reason = auth === 'link_already_used' ? 'That sign-in link was already used. Each link works once.'
      : auth === 'token_expired' ? 'That sign-in link has expired.'
        : `Your sign-in link could not be used (${auth}).`;
    message(`${reason} Request a new secure link.`,'error');
  }

  /* Stripe return (?checkout=success). The purchase reaches the NFL ledger via
   * the billing webhook a few seconds later, so the page shows an explicit
   * confirming state and polls for up to a minute. A buyer who is not signed in
   * gets the access email at the checkout address and signs in from it. */
  async function syncCheckoutSuccess() {
    const params = new URLSearchParams(location.search);
    if (params.get('checkout') !== 'success') return;
    cleanQuery(['checkout','session_id','tier']);
    state.checkoutSyncing = true;
    open('checkout-success');
    message('Payment received. Confirming your NFL Pro access…');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await refreshAccess();
      if (state.pro || !state.user) break;
      message('Payment received. Confirming your NFL Pro access… this usually takes a few seconds.');
      await new Promise(resolve => setTimeout(resolve,3000));
    }
    state.checkoutSyncing = false;
    renderModal();
    if (state.pro) message('NFL Pro is active. Premium features are unlocked.','success');
    else if (!state.user) message('Payment received. Open the NFL Pro access link we emailed to your checkout address to sign in and unlock Pro. You can also use “Sign in to NFL Pro” with that email.','success');
    else message('Payment received, still confirming. Use “Refresh access” in a minute; you will not be charged again.');
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
    paintNotice,
    setWall,
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
