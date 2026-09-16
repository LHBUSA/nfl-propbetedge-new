/* PropBetEdge NFL — NFL Pro conversion surface v1
 * Presentation only. It reads the canonical pricing/auth state, never premium
 * decision data, and turns the homepage + sidebar into a clear NFL Pro funnel.
 *
 * The verified owner always sees the public conversion surface on the homepage
 * and sidebar. That makes the live sales experience inspectable without signing
 * out or using a second browser. Paid subscribers still see the clean active
 * state instead of acquisition CTAs.
 */
(() => {
  'use strict';

  const STORAGE = 'pbe_nfl_pending_plan_v7';
  let queued = false;
  let observer = null;

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function pricing() { return window.PBEPricing || null; }
  function proState() { return window.PBEPro?.state || {}; }
  function isPro() { return Boolean(proState().pro); }
  function isOwner() { return proState().role === 'owner'; }
  function isHome() { return window.App?.current === 'home' && Boolean(document.querySelector('.pbehome7')); }

  function planLabel(plan, fallback) {
    if (!plan) return fallback;
    return plan.short || `${plan.price || ''}${plan.cadence === 'month' ? '/mo' : '/wk'}`;
  }

  function openPro(plan = 'monthly') {
    try { localStorage.setItem(STORAGE, plan); } catch (_) {}
    window.PBEPro?.open?.();
    queueMicrotask(() => window.PBECheckoutFunnel?.apply?.());
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
          <p class="pbeprosell-lede">PBE Algo is not a static picks sheet. It evaluates eligible NFL games, publishes only qualified PBE Picks, locks the model and market state before the result, and grades the call afterward. Finalized grades form the learning set for an automated challenger system — and the live champion changes only when a challenger clears the integrity and promotion gates.</p>

          <div class="pbeprosell-proofline" aria-label="PBE Algo automated learning cycle">
            <div><b>EVALUATE</b><span>Score eligible games</span></div>
            <div><b>PICK</b><span>Publish only qualified calls</span></div>
            <div><b>LOCK</b><span>Freeze the decision receipt</span></div>
            <div><b>GRADE</b><span>Finalize the real result</span></div>
            <div><b>LEARN</b><span>Train + gate challengers</span></div>
          </div>

          <div class="pbeprosell-actions">
            <button type="button" class="pbeprosell-cta primary" data-pro-plan="monthly">Unlock PBE Picks · ${esc(monthly)}</button>
            <button type="button" class="pbeprosell-cta" data-pro-plan="weekly">Fight Week · ${esc(weekly)}</button>
            <button type="button" class="pbeprosell-link" data-pro-route="trackrecord">Audit every graded call →</button>
          </div>
          <div class="pbeprosell-fine">Automated learning is governed, not reckless: only finalized observations can train challengers, and the production champion never silently replaces itself. One verified account · Stripe checkout · Cancel anytime.</div>
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
        <article><span>04</span><div><b>Model + Market Desk</b><p>Probability, market context, Best Line, simulation and supported premium research.</p></div></article>
      </div>
    </section>`;
  }

  function activeMarkup() {
    return `<section class="pbeprosell pbeprosell-active" data-nfl-pro-sales="active" aria-label="NFL Pro active">
      <div><span>NFL PRO · AUTOMATED LEARNING PICKER · ACTIVE</span><h2>Your PBE decision engine is unlocked.</h2><p>Official PBE Picks, model + market context, the verified Track Record and the governed learning system are available on this account.</p></div>
      <div class="pbeprosell-actions"><button type="button" class="pbeprosell-cta primary" data-pro-route="pbepicks">Open PBE Picks</button><button type="button" class="pbeprosell-cta" data-pro-route="picks">Open Model Lab</button><button type="button" class="pbeprosell-link" data-pro-route="trackrecord">Track Record →</button></div>
    </section>`;
  }

  function mountHome() {
    const existing = document.querySelector('[data-nfl-pro-sales]');
    if (!isHome()) { existing?.remove(); return; }
    const root = document.querySelector('.pbehome7');
    const hero = root?.querySelector('.pbe7-hero');
    if (!root || !hero) return;

    /* Owner preview deliberately mirrors the acquisition experience. */
    const acquisitionView = !isPro() || isOwner();
    const mode = acquisitionView ? 'free' : 'active';
    if (existing?.dataset?.nflProSales === mode && existing.parentElement === root) return;
    existing?.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = acquisitionView ? salesMarkup() : activeMarkup();
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
      <p>Official PBE Picks + locked grading + a governed champion/challenger learning system.</p>
      <button type="button" data-pro-plan="monthly">Unlock PBE Picks · ${esc(monthly)}</button>
      <small>${esc(weekly)} flexible access</small>
    </aside>`;
  }

  function mountSidebar() {
    const old = document.querySelector('[data-nfl-pro-mini]');
    /* Subscribers do not get acquisition chrome. The owner does, by design,
       so the live public funnel can be inspected without signing out. */
    if (isPro() && !isOwner()) { old?.remove(); return; }
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

  function paint() {
    mountHome();
    mountSidebar();
    markPicksPro();
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
    if (route) { event.preventDefault(); nav(route); }
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

  window.NFLProSalesV1 = { paint, openPro, get observer() { return observer; } };
})();
