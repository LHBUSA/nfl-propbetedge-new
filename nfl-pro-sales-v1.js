/* PropBetEdge NFL — NFL Pro conversion surface v1
 * Presentation only. It reads the canonical pricing/auth state, never premium
 * decision data, and turns the homepage + sidebar into a clear NFL Pro funnel.
 *
 * Every verified Pro account receives the same signed-in product experience.
 * Owner access is intentionally not given a separate public-sales preview.
 */
(() => {
  'use strict';

  const STORAGE = 'pbe_nfl_pending_plan_v7';
  const BILLING_PORTAL = 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';
  let queued = false;
  let observer = null;

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function pricing() { return window.PBEPricing || null; }
  function proState() { return window.PBEPro?.state || {}; }
  function isPro() { return Boolean(proState().pro); }

  /* Shared membership contract (pbe-membership.js via window.PBEMembership).
     free      NFL plans + the All Access card beneath them
     sport_pro the member surface (You have NFL PropBetEdge Pro)
     all_access / owner  no sales surface at all: nothing to sell */
  const MEMBERSHIP_STATES = ['free', 'sport_pro', 'all_access', 'owner'];
  function membership(s = proState()) {
    const m = s.membership;
    if (m && MEMBERSHIP_STATES.includes(m.state)) return m;
    return window.PBEMembership?.deriveMembership?.({ sport: 'nfl', entitled: false }) || { sport: 'nfl', state: 'free', label: 'FREE', entitled: false };
  }
  function memberState(s = proState(), m = membership(s)) {
    if (!s.pro) return 'free';
    if (m?.entitled) return m.state;
    return s.role === 'owner' ? 'owner' : 'sport_pro';
  }
  function allAccessCard(m = membership()) { return window.PBEMembership?.allAccessCardHtml?.(m, { compact: true }) || ''; }
  function isHome() { return window.App?.current === 'home' && Boolean(document.querySelector('.pbehome7')); }

  function planLabel(plan, fallback) {
    if (!plan) return fallback;
    return plan.short || `${plan.price || ''}${plan.cadence === 'month' ? '/mo' : '/wk'}`;
  }

  function openPro(plan = 'monthly') {
    try { localStorage.setItem(STORAGE, plan); } catch (_) {}
    window.PBEPro?.open?.();
    queueMicrotask(() => window.PBECheckoutFunnel?.apply?.());
    setTimeout(enhanceProModal, 60);
  }

  function nav(route) { window.App?.nav?.(route); }

  function lockedRow(label, detail) {
    return `<div class="pbeprosell-lockrow"><span><b>${esc(label)}</b><small>${esc(detail)}</small></span><span class="pbeprosell-lockchip">PRO</span></div>`;
  }

  function salesMarkup() {
    const p = pricing();
    const monthly = planLabel(p?.monthly, 'Monthly');
    const weekly = planLabel(p?.weekly, 'Weekly');
    return `<section class="pbeprosell" data-nfl-pro-sales="free" aria-labelledby="pbeprosell-title">
      <div class="pbeprosell-grid">
        <div class="pbeprosell-copy">
          <div class="pbeprosell-kicker"><span>NFL PRO · AUTOMATED LEARNING PICKER</span><i>FOUNDING SEASON</i></div>
          <h2 id="pbeprosell-title">A picker built to learn<br><em>from every finalized grade.</em></h2>
          <p class="pbeprosell-lede">PBE Algo is not a static picks sheet. It evaluates eligible NFL games, publishes only qualified PBE Picks, locks the model and market state before the result, and grades the call afterward. Finalized grades form the learning set for an automated challenger system — and the live champion changes only when a challenger clears the integrity and promotion gates. NFL Pro also keeps evolving: active members get the latest NFL Pro features, tools and in-product add-ons as they ship.</p>

          <div class="pbeprosell-proofline" aria-label="PBE Algo automated learning cycle">
            <div><b>EVALUATE</b><span>Score eligible games</span></div>
            <div><b>PICK</b><span>Publish only qualified calls</span></div>
            <div><b>LOCK</b><span>Freeze the decision receipt</span></div>
            <div><b>GRADE</b><span>Finalize the real result</span></div>
            <div><b>LEARN</b><span>Train + gate challengers</span></div>
          </div>

          <div class="pbeprosell-actions">
            <button type="button" class="pbeprosell-cta primary" data-pro-plan="monthly">Unlock PBE Picks · ${esc(monthly)}</button>
            <button type="button" class="pbeprosell-cta" data-pro-plan="weekly">Weekly · ${esc(weekly)}</button>
            <button type="button" class="pbeprosell-link" data-pro-route="trackrecord">Audit every graded call →</button>
          </div>
          <div class="pbeprosell-fine">Automated learning is governed, not reckless: only finalized observations can train challengers, and the production champion never silently replaces itself. New NFL Pro releases and in-product add-ons are included while your subscription is active. One verified account · Stripe checkout · Cancel anytime.</div>
          ${allAccessCard()}
        </div>

        <div class="pbeprosell-preview" aria-label="Locked NFL Pro decision preview">
          <div class="pbeprosell-preview-head"><span>PBE ALGO · DECISION RECEIPT</span><b>PRO OUTPUT</b></div>
          <div class="pbeprosell-matchup"><small>THE PRODUCT</small><strong>The model makes the call. The system remembers it.</strong><p>Every qualified PBE Pick carries the exact model + market state used at issuance, then stays attached to the final grade.</p></div>
          <div class="pbeprosell-lockbox">
            ${lockedRow('Official PBE Pick', 'The qualified production-champion decision')}
            ${lockedRow('Model probability', 'The champion probability at issuance')}
            ${lockedRow('Issued line + odds', 'The market state captured with the decision')}
            ${lockedRow('PBE Edge / comparison', 'Model vs market context when available')}
            ${lockedRow('Model version + provenance', 'Which champion made the call and why')}
          </div>
          <button type="button" class="pbeprosell-preview-cta" data-pro-route="pbepicks">Open the PBE Picks desk →</button>
        </div>
      </div>

      <div class="pbeprosell-products" aria-label="NFL Pro product stack">
        <article><span>01</span><div><b>Automated Learning Picker</b><p>Finalized grades feed a governed challenger pipeline built to improve the engine over time.</p></div></article>
        <article><span>02</span><div><b>PBE Picks</b><p>Official qualified champion decisions — not filler picks and not hand-edited calls.</p></div></article>
        <article><span>03</span><div><b>Verified Track Record</b><p>The receipt, the result and the misses stay visible instead of being rewritten later.</p></div></article>
        <article><span>04</span><div><b>New Pro Releases Included</b><p>Get the newest NFL Pro features, tools and in-product add-ons under the same active subscription as they ship.</p></div></article>
      </div>
    </section>`;
  }

  function activeMarkup() {
    return `<section class="pbeprosell pbeprosell-active pbeprosell-member" data-nfl-pro-sales="active" aria-label="NFL PropBetEdge Pro active">
      <div class="pbeprosell-member-main">
        <div class="pbeprosell-member-kicker"><span class="pbeprosell-member-status">✓ NFL PRO ACTIVE</span><span>NFL PROPBETEDGE PRO</span></div>
        <h2>You have NFL<br><em>PropBetEdge Pro.</em></h2>
        <p>National-scale NFL analytics, PBE Algo, official PBE Picks, live market intelligence, player and team research, simulation, Game Center, a verified Track Record, and the newest NFL Pro features and in-product add-ons as they ship — all under one Pro account.</p>
        <div class="pbeprosell-member-actions">
          <button type="button" class="pbeprosell-cta primary" data-pro-route="pbepicks">Open PBE Picks</button>
          <button type="button" class="pbeprosell-cta" data-pro-route="picks">Open Model Lab</button>
          <a class="pbeprosell-manage" href="${BILLING_PORTAL}" target="_blank" rel="noopener noreferrer">Manage subscription ↗</a>
        </div>
      </div>
      <div class="pbeprosell-member-side">
        <div class="pbeprosell-member-badge"><span>NFL PRO</span><strong>UNLOCKED</strong><small>Verified access</small></div>
        <div class="pbeprosell-member-grid">
          <div><b>PBE Algo</b><span>Automated learning picker</span></div>
          <div><b>PBE Picks</b><span>Official qualified calls</span></div>
          <div><b>Track Record</b><span>Permanent graded history</span></div>
          <div><b>New Releases</b><span>Latest Pro features + add-ons included</span></div>
        </div>
        <button type="button" class="pbeprosell-member-track" data-pro-route="trackrecord">View your Track Record access →</button>
      </div>
    </section>`;
  }

  function mountHome() {
    const existing = document.querySelector('[data-nfl-pro-sales]');
    if (!isHome()) { existing?.remove(); return; }
    const root = document.querySelector('.pbehome7');
    const hero = root?.querySelector('.pbe7-hero');
    if (!root || !hero) return;

    /* All Access and owner accounts have nothing to buy here: no surface. */
    const ms = memberState();
    if (ms === 'all_access' || ms === 'owner') { existing?.remove(); return; }
    const mode = isPro() ? 'active' : 'free';
    if (existing?.dataset?.nflProSales === mode && existing.parentElement === root) return;
    existing?.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = isPro() ? activeMarkup() : salesMarkup();
    const node = wrap.firstElementChild;
    if (node) hero.insertAdjacentElement('afterend', node);
  }

  function sidebarMarkup() {
    const p = pricing();
    const monthly = planLabel(p?.monthly, 'Monthly');
    const weekly = planLabel(p?.weekly, 'Weekly');
    return `<aside class="pbeprosell-mini" data-nfl-pro-mini="1" aria-label="NFL Pro">
      <div class="pbeprosell-mini-top"><span>NFL PRO</span><b>LEARNING PICKER</b></div>
      <strong>A picker built to learn.</strong>
      <p>Official PBE Picks + locked grading + a governed learning system + new NFL Pro features and add-ons as they ship.</p>
      <button type="button" data-pro-plan="monthly">Unlock PBE Picks · ${esc(monthly)}</button>
      <small>${esc(weekly)} flexible access · new Pro releases included</small>
    </aside>`;
  }

  function mountSidebar() {
    const old = document.querySelector('[data-nfl-pro-mini]');
    if (isPro()) { old?.remove(); return; }
    if (old) return;
    const search = document.querySelector('.sidebar-search');
    if (!search) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = sidebarMarkup();
    if (wrap.firstElementChild) search.insertAdjacentElement('afterend', wrap.firstElementChild);
  }

  function markPicksPro() {
    const link = document.getElementById('nav-pbepicks');
    const badge = link?.querySelector('.nav-badge');
    if (!badge) return;
    badge.textContent = 'PRO';
    badge.style.color = 'var(--pbe-pro)';
  }

  function enhanceProModal() {
    const root = document.querySelector('.pbe-funnel-root');
    if (!root) return;
    const state = root.dataset.funnelState || '';
    let note = root.querySelector('[data-pro-release-value]');
    if (!note) {
      note = document.createElement('div');
      note.className = 'pbe-pro-today';
      note.setAttribute('data-pro-release-value', '1');
      const plans = root.querySelector('.pbe-funnel-plans');
      const status = root.querySelector('.pbe-member-status-card,.pbe-funnel-user');
      const anchor = plans || status || root.querySelector('.pbe-funnel-head');
      if (anchor) anchor.insertAdjacentElement('beforebegin', note);
      else root.prepend(note);
    }
    if (state === 'active-pro' || state === 'active-owner') {
      note.innerHTML = '<b>YOUR PRO KEEPS EVOLVING</b><span>New NFL Pro feature releases, product upgrades and in-product add-ons are included while your Pro access is active.</span>';
    } else {
      note.innerHTML = '<b>MORE THAN TODAY’S FEATURES</b><span>Your active NFL Pro subscription includes new NFL Pro feature releases, product upgrades and in-product add-ons as they ship — not just the tools available on the day you subscribe.</span>';
    }
  }

  function paint() {
    mountHome();
    mountSidebar();
    markPicksPro();
    enhanceProModal();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; paint(); });
  }

  document.addEventListener('click', event => {
    const plan = event.target.closest?.('[data-pro-plan]')?.dataset?.proPlan;
    if (plan) { event.preventDefault(); openPro(plan); return; }
    const route = event.target.closest?.('[data-pro-route]')?.dataset?.proRoute;
    if (route) { event.preventDefault(); nav(route); return; }
    if (event.target.closest?.('.pbe-pro-account,[data-pbe-open-pro],[data-pro]')) setTimeout(enhanceProModal, 60);
  });

  window.addEventListener('pbe:pro-state', schedule);
  window.addEventListener('hashchange', schedule);

  function boot() {
    paint();
    const host = document.getElementById('view-container') || document.body;
    observer = new MutationObserver(schedule);
    observer.observe(host, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.NFLProSalesV1 = { paint, openPro, enhanceProModal, markup: { sales: salesMarkup, active: activeMarkup, memberState, membership }, get observer() { return observer; } };
})();
