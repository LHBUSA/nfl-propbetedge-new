/* PropBetEdge NFL — NFL Pro conversion surface v1
 * Presentation only. It reads the canonical pricing/auth state, never premium
 * decision data, and turns the homepage + sidebar into a clear NFL Pro funnel.
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
          <div class="pbeprosell-kicker"><span>NFL PRO · PBE PICKS</span><i>FOUNDING SEASON</i></div>
          <h2 id="pbeprosell-title">Public proof is free.<br><em>The decisions are Pro.</em></h2>
          <p class="pbeprosell-lede">NFL Pro unlocks official PBE Picks from the production champion and the model desk behind each qualified call. The decision is issued against a specific market state, preserved before the outcome is known, then graded without deleting losses or rewriting the original line.</p>

          <div class="pbeprosell-proofline" aria-label="PBE Picks accountability">
            <div><b>QUALIFY</b><span>No forced pick</span></div>
            <div><b>ISSUE</b><span>Decision-time market</span></div>
            <div><b>LOCK</b><span>Receipt preserved</span></div>
            <div><b>GRADE</b><span>Final result</span></div>
            <div><b>LEARN</b><span>Challenger loop</span></div>
          </div>

          <div class="pbeprosell-actions">
            <button type="button" class="pbeprosell-cta primary" data-pro-plan="monthly">Unlock NFL Pro · ${esc(monthly)}</button>
            <button type="button" class="pbeprosell-cta" data-pro-plan="weekly">Fight Week · ${esc(weekly)}</button>
            <button type="button" class="pbeprosell-link" data-pro-route="trackrecord">Audit the Track Record →</button>
          </div>
          <div class="pbeprosell-fine">One verified account · Stripe checkout · Cancel anytime · Official picks only when the production engine qualifies a decision.</div>
        </div>

        <div class="pbeprosell-preview" aria-label="Locked NFL Pro decision preview">
          <div class="pbeprosell-preview-head"><span>PBE PICKS · DECISION RECEIPT</span><b>LOCKED PREVIEW</b></div>
          <div class="pbeprosell-matchup"><small>WHAT PRO UNLOCKS</small><strong>Every qualified call has a receipt.</strong><p>No fake blur and no leaked pick values — just the exact fields waiting behind the entitlement.</p></div>
          <div class="pbeprosell-lockbox">
            ${lockedRow('Official PBE Pick', 'The qualified production-champion decision')}
            ${lockedRow('Issued line + odds', 'The market state attached when the decision was made')}
            ${lockedRow('Model probability', 'The champion model probability at issuance')}
            ${lockedRow('PBE Edge / comparison', 'Model vs market context when the production record supplies it')}
            ${lockedRow('Why this pick', 'Decision factors, model version and provenance')}
          </div>
          <button type="button" class="pbeprosell-preview-cta" data-pro-route="pbepicks">See the PBE Picks desk →</button>
        </div>
      </div>

      <div class="pbeprosell-products" aria-label="NFL Pro product stack">
        <article><span>01</span><div><b>PBE Picks</b><p>Official qualified champion decisions — not filler picks.</p></div></article>
        <article><span>02</span><div><b>Model Lab</b><p>Fair value, model probability, provenance and audit context.</p></div></article>
        <article><span>03</span><div><b>Market Watch</b><p>Follow the market around the model instead of viewing either in isolation.</p></div></article>
        <article><span>04</span><div><b>Simulation + SGP</b><p>Premium scenario and correlation workflows under the same Pro access.</p></div></article>
      </div>
    </section>`;
  }

  function activeMarkup() {
    return `<section class="pbeprosell pbeprosell-active" data-nfl-pro-sales="active" aria-label="NFL Pro active">
      <div><span>NFL PRO · ACTIVE</span><h2>Your decision desk is unlocked.</h2><p>PBE Picks, the premium model desk and supported NFL Pro research are available on this verified account.</p></div>
      <div class="pbeprosell-actions"><button type="button" class="pbeprosell-cta primary" data-pro-route="pbepicks">Open PBE Picks</button><button type="button" class="pbeprosell-cta" data-pro-route="picks">Open Model Lab</button><button type="button" class="pbeprosell-link" data-pro-route="trackrecord">Track Record →</button></div>
    </section>`;
  }

  function mountHome() {
    const existing = document.querySelector('[data-nfl-pro-sales]');
    if (!isHome()) { existing?.remove(); return; }
    const root = document.querySelector('.pbehome7');
    const hero = root?.querySelector('.pbe7-hero');
    if (!root || !hero) return;
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
      <div class="pbeprosell-mini-top"><span>NFL PRO</span><b>PBE PICKS</b></div>
      <strong>See the decision. Keep the receipt.</strong>
      <p>Official PBE Picks + premium model and market intelligence.</p>
      <button type="button" data-pro-plan="monthly">Go Pro · ${esc(monthly)}</button>
      <small>${esc(weekly)} flexible access</small>
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
