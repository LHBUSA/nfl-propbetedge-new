/* PropBetEdge NFL — account + purchase surface v9 (one shell, four states)
 *
 * Presentation authority for the account modal: signed-out (get access OR
 * existing-member sign-in), signed-in without access, and active members
 * (NFL Pro · All Access · owner). Auth/session state remains owned by
 * paywall.js and the degraded "access check" screen by
 * sports-shell-auth-state.js; this file renders, it never decides access.
 *
 * The shell is two columns on desktop: the cinematic stadium visual on the
 * left (.pbe-pro-pitch, painted per state by paintVisual) and the account
 * action on the right (#pbe-pro-checkout). Under 901px it is one full-screen
 * sheet (nfl-account-v3.css).
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

  /* The account visual: a real NFL venue from /stadiums. Lambeau Field is the
     CC0 photograph in the set (no attribution condition, no licensing risk);
     the composition keeps the goalpost, lights and bowl in frame and the end
     zone under the gradient that carries the copy. */
  const STADIUM = Object.freeze({
    tall: '/stadiums/lambeau-bgsm.webp',
    wide: '/stadiums/lambeau-bg.webp',
    credit: 'Lambeau Field · photograph by Mtyson84 · CC0',
  });
  const PBE_LOGO = 'https://propbetedge.ai/logo/pbe-full-400.png';

  /* What PropBetEdge NFL is, in the reader's terms. Real capabilities only. */
  const FEATURES = Object.freeze([
    ['PBE Algo', 'Automated learning picker'],
    ['Official PBE Picks', 'Only qualified production calls'],
    ['Player DNA', 'Player-level usage and performance intelligence'],
    ['Model + Market', 'Probability, fair line, best line and market context'],
    ['PBEcast', 'Live game intelligence'],
    ['Track Record', 'Permanent graded history'],
    ['Game Center', 'Your Sunday intelligence hub'],
    ['Simulation + Research', 'Premium decision support'],
  ]);
  /* What an active member can open right now, each wired to its real route. */
  const UNLOCKED = Object.freeze([
    ['PBE Algo', 'Model Lab', 'picks'],
    ['Official PBE Picks', 'Qualified calls', 'pbepicks'],
    ['Player DNA', 'QB · WR · RB · TE', 'qbdna'],
    ['PBEcast', 'Live game intelligence', 'pbecast'],
    ['Game Center', 'Games + schedule', 'games'],
    ['Model + Market', 'Market Watch', 'marketwatch'],
    ['Simulation', 'Line Simulator', 'simulator'],
    ['Track Record', 'Graded history', 'trackrecord'],
    ['Research', 'Matchup Research', 'matchups'],
  ]);
  const REMINDER = 'PBE Picks · PBE Algo · Player DNA · PBEcast · Model + Market · Track Record';

  let queued = false;
  let checkoutRunning = false;
  let linkRunning = false;
  let focusPending = false;
  /* Signed-out readers see one of two views: 'join' (get access) or 'signin'
     (existing member). paywall.js announces why the surface opened. */
  let view = 'join';

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
  /* ALL ACCESS is the PRIMARY offer (nfl-all-access-hero-v1.js). The hero is
     rendered ABOVE the NFL plans for free readers and as the upgrade for NFL
     Pro members; never for All Access members or the owner. The shared
     contract card is only the fallback if the NFL hero module never loaded. */
  function allAccessCard(m, opts) { return window.NFLAllAccessHero?.heroHtml?.(m, opts) || lib()?.allAccessCardHtml?.(m, opts) || ''; }
  function allAccessDivider() { return window.NFLAllAccessHero?.dividerHtml?.() || '<div class="nfl-aa-divider" role="separator" aria-label="Only want NFL?"><span>ONLY WANT NFL?</span></div>'; }
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

  /* ------------------------------------------------------------ shared parts */

  function head(eyebrow, title, lede) {
    return `<div class="pbe-funnel-head">
        <span>${eyebrow}</span>
        <strong>${title}</strong>
        ${lede ? `<p>${lede}</p>` : ''}
      </div>`;
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
        <div class="pbe-funnel-check" aria-hidden="true">${on ? '✓' : ''}</div>
      </div>
      <div class="pbe-pro-price"><strong>${p.price}</strong><span>${p.detail}</span></div>
      <div class="pbe-pro-renew">${p.term}</div>
    </button>`;
  }

  function plansHtml() {
    const selected = selectedKey();
    return `<div class="pbe-pro-plans pbe-funnel-plans" role="radiogroup" aria-label="NFL Pro plans">
        ${planCard('monthly', selected)}
        ${planCard('weekly', selected)}
      </div>`;
  }

  /* The product list again, for the phone sheet, where the visual column is a
     short banner and the list reads after the action. Hidden on desktop. */
  function includedSheetHtml() {
    return `<section class="pbe-acct-included" aria-label="What PropBetEdge NFL includes">
        <span class="pbe-acct-included-k">WHAT YOU GET</span>
        <ul>${FEATURES.map(([name, line]) => `<li><b>${escapeHtml(name)}</b><span>${escapeHtml(line)}</span></li>`).join('')}</ul>
      </section>`;
  }

  /* ------------------------------------------------------------ STATE 1 — get access */

  function signedOutMarkup() {
    const note = window.PBEPro?.denialNote?.() || '';
    return `<div class="pbe-funnel-root pbe-acct-panel" data-acct="v3" data-funnel-state="signed-out" data-funnel-view="join" data-membership="free">
      ${head('GET ACCESS · PROPBETEDGE PRO', 'Choose your access.', note ? escapeHtml(note) : 'One membership for 10 sports + PropBetEdge Predictions, or NFL on its own.')}
      ${allAccessCard(membership())}
      ${allAccessDivider()}
      ${plansHtml()}
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <label class="pbe-acct-label" for="pbe-funnel-email">Email for your NFL Pro access</label>
        <div class="pbe-funnel-checkout-row">
          <input class="pbe-pro-email" id="pbe-funnel-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com">
          <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button"></button>
        </div>
        <div class="pbe-funnel-charge">${escapeHtml(PRICING.charge)}</div>
        <p class="pbe-acct-fine">Checkout is tied to this email, so NFL Pro unlocks automatically. New NFL Pro releases are included while access is active.</p>
        <div class="pbe-pro-message" id="pbe-funnel-message" role="status" aria-live="polite"></div>
      </div>
      <div class="pbe-acct-switch"><span>Already a member?</span><button class="pbe-funnel-signin-link" id="pbe-funnel-show-signin" type="button">Sign in</button></div>
      <div class="pbe-pro-secure">◆ Secure checkout by Stripe · Passwordless PropBetEdge access</div>
      ${includedSheetHtml()}
    </div>`;
  }

  /* ------------------------------------------------------------ STATE 2 — member sign-in */

  function signInMarkup() {
    return `<div class="pbe-funnel-root pbe-acct-panel pbe-acct-signin" data-acct="v3" data-funnel-state="signed-out" data-funnel-view="signin" data-membership="free">
      ${head('VERIFIED MEMBER ACCESS', 'Welcome back.', 'Sign in with the email attached to your PropBetEdge access.')}
      <form class="pbe-acct-form" id="pbe-funnel-signin-form" novalidate>
        <label class="pbe-acct-label" for="pbe-funnel-email">Email address</label>
        <input class="pbe-pro-email" id="pbe-funnel-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" required>
        <button class="pbe-pro-cta" id="pbe-funnel-send-link" type="submit">Send secure sign-in link</button>
        <div class="pbe-pro-message" id="pbe-funnel-message" role="status" aria-live="polite"></div>
      </form>
      <ul class="pbe-acct-trust" aria-label="How sign-in works">
        <li><b>Passwordless secure access.</b> No password required.</li>
        <li>We email a single-use link to the address on your membership.</li>
      </ul>
      <div class="pbe-acct-switch"><span>Need access?</span><button class="pbe-funnel-signin-link" id="pbe-funnel-show-join" type="button">View membership options</button></div>
      <p class="pbe-acct-reminder"><span>YOUR ACCESS</span>${escapeHtml(REMINDER)}</p>
    </div>`;
  }

  /* ------------------------------------------------------------ STATE 3 — signed in, no access */

  /* A verified reader whose NFL access has ended (server access ===
     'no_entitlement' with a lapse reason). "Renew" is only truthful when there
     was NFL access before; a verified email that never held NFL Pro reads
     "isn't active" and gets the ordinary NFL Pro action. */
  const LAPSE_REASONS = new Set(['expired', 'canceled', 'payment_failed', 'null_expiry']);
  function lapsedKind(s = state()) {
    if (s.pro || !s.user || s.access !== 'no_entitlement') return null;
    return LAPSE_REASONS.has(String(s.entitlement?.reason || '')) ? 'lapsed' : 'inactive';
  }

  function lapsedMarkup(email, kind) {
    const note = window.PBEPro?.denialNote?.() || '';
    const lapsed = kind === 'lapsed';
    const local = window.PBENflMember?.LOCAL_ALL_ACCESS_PATH || '/all-access';
    return `<div class="pbe-funnel-root pbe-acct-panel" data-acct="v3" data-funnel-state="signed-in-free" data-funnel-view="${kind}" data-membership="free" data-funnel-note="${escapeHtml(state().entitlement?.reason || '')}">
      <div class="pbe-acct-identity"><i aria-hidden="true"></i><span>SIGNED IN</span><strong>${escapeHtml(email)}</strong></div>
      ${head(lapsed ? 'NFL PRO · ACCESS ENDED' : 'NFL PRO · NOT ACTIVE', lapsed ? 'NFL Pro access<br>is no longer active.' : 'NFL Pro isn’t active<br>on this account.', note ? escapeHtml(note) : (lapsed ? 'Renew NFL Pro to reopen PBE Picks, PBE Algo and the permanent Track Record on this account.' : 'Choose NFL Pro below, or All Access for the whole PropBetEdge network.'))}
      ${plansHtml()}
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button" data-funnel-renew="${lapsed ? '1' : '0'}"></button>
        <div class="pbe-funnel-charge">${escapeHtml(PRICING.charge)}</div>
        <div class="pbe-pro-message" id="pbe-funnel-message" role="status" aria-live="polite"></div>
      </div>
      <div class="pbe-acct-lapsed-actions">
        <a class="pbe-pro-cta secondary" href="${local}" data-nfl-all-access-cta="view">View All Access</a>
        <button class="pbe-pro-cta secondary" id="pbe-funnel-signout" type="button">Sign out</button>
      </div>
      <div class="pbe-acct-switch"><span>Already renewed?</span><button class="pbe-funnel-signin-link" id="pbe-funnel-refresh" type="button">Refresh access</button></div>
      <div class="pbe-pro-secure">◆ Signed in · ${lapsed ? 'renewal' : 'checkout'} is tied to this verified email</div>
    </div>`;
  }

  function signedInFreeMarkup(email) {
    const kind = lapsedKind();
    if (kind) return lapsedMarkup(email, kind);
    const note = window.PBEPro?.denialNote?.() || '';
    return `<div class="pbe-funnel-root pbe-acct-panel" data-acct="v3" data-funnel-state="signed-in-free" data-funnel-view="ready" data-membership="free" data-funnel-note="${escapeHtml(state().entitlement?.reason || '')}">
      <div class="pbe-acct-identity"><i aria-hidden="true"></i><span>SIGNED IN</span><strong>${escapeHtml(email)}</strong><button class="pbe-funnel-signin-link" id="pbe-funnel-signout" type="button">Sign out</button></div>
      ${head('ACCOUNT READY', note ? 'Choose your access again.' : 'Your account is ready.<br>Choose your access.', note ? escapeHtml(note) : 'One membership for 10 sports + PropBetEdge Predictions, or NFL on its own.')}
      ${allAccessCard(membership())}
      ${allAccessDivider()}
      ${plansHtml()}
      <div class="pbe-pro-auth-state pbe-funnel-auth">
        <button class="pbe-pro-cta" id="pbe-funnel-checkout" type="button"></button>
        <div class="pbe-funnel-charge">${escapeHtml(PRICING.charge)}</div>
        <div class="pbe-pro-message" id="pbe-funnel-message" role="status" aria-live="polite"></div>
      </div>
      <div class="pbe-acct-switch"><span>Already paid?</span><button class="pbe-funnel-signin-link" id="pbe-funnel-refresh" type="button">Refresh access</button></div>
      <div class="pbe-pro-secure">◆ Secure checkout by Stripe · Entitlement verified by PropBetEdge</div>
      ${includedSheetHtml()}
    </div>`;
  }

  /* ------------------------------------------------------------ STATE 4 — active members */

  function accessPeriodCopy(subscription) {
    const raw = subscription?.current_period_end;
    if (!raw) return 'Entitlement verified by PropBetEdge.';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return 'Entitlement verified by PropBetEdge.';
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return subscription?.cancel_at_period_end ? `Access remains active through ${label}.` : `Current billing period runs through ${label}.`;
  }

  /* Active members. One markup, three states from the shared contract:
       sport_pro   NFL PRO ACTIVE · plan · manage link · UPGRADE TO ALL ACCESS hero
                   (only when the contract says show_all_access_upgrade; no NFL purchase)
       all_access  ALL ACCESS ACTIVE · manage link · network row · NO purchase CTA
       owner       OWNER · no manage link · no purchase CTA
     `owner` (the legacy role flag) still drives data-funnel-state so the
     polish and sales layers keep keying on active-pro / active-owner. */
  function activeProMarkup(email, subscription, owner = false, m = membership()) {
    const L = lib();
    const mState = m?.entitled ? m.state : (owner ? 'owner' : 'sport_pro');
    /* Display vocabulary only (nfl-member-presentation-v1.js): all_access is
       presented as PLATINUM MEMBER, owner as VERIFIED OWNER, sport_pro as NFL
       PRO MEMBER. The contract state and data-membership stay untouched. */
    const P = window.PBENflMember?.display?.(m?.entitled ? m : null, mState) || null;
    const label = P?.status || (m?.entitled && m.label ? m.label : (owner ? 'OWNER' : 'NFL PRO ACTIVE'));
    const allAccess = mState === 'all_access';
    const isOwner = mState === 'owner';
    const plan = (allAccess && P?.product) || (m?.entitled && L?.planText?.(m)) || (owner ? 'Owner access' : 'NFL Pro');
    const badge = (P && window.PBENflMember.badgeHtml(m?.entitled ? m : null, mState)) || L?.membershipBadgeHtml?.(m?.entitled ? m : { state: mState, sport: 'nfl' }) || `<div class="pbe-funnel-plan-badge">${escapeHtml(label)}</div>`;
    const period = isOwner ? 'Every NFL Pro feature · no subscription required' : accessPeriodCopy(subscription);
    const kicker = P?.eyebrow || (allAccess ? 'PROPBETEDGE ALL ACCESS · NFL' : isOwner ? 'NFL PRO · VERIFIED OWNER' : 'NFL PRO · ACTIVE');
    const headline = isOwner ? 'Owner access is active.' : allAccess ? 'Your full NFL desk<br><em>is unlocked.</em>' : 'You’re in.';
    const lede = allAccess
      ? 'Your PropBetEdge All Access membership unlocks the full network — 10 sports plus PropBetEdge Predictions.'
      : isOwner
        ? 'Every NFL Pro surface is unlocked on this verified owner account.'
        : 'Your NFL Pro decision desk is live. PBE Picks and the model + market desk are active across supported NFL surfaces.';
    const manage = m?.entitled ? (L?.manageLinkHtml?.(m, 'Manage membership') || '') : '';
    const upgrade = mState === 'sport_pro' && m?.show_all_access_upgrade === true ? allAccessCard(m) : '';
    const tiles = UNLOCKED.map(([name, line, route]) => `<li><button type="button" class="pbe-acct-tile" data-acct-route="${route}"><i aria-hidden="true"></i><b>${escapeHtml(name)}</b><span>${escapeHtml(line)}</span></button></li>`).join('');
    return `<div class="pbe-funnel-root pbe-funnel-active pbe-acct-panel" data-acct="v3" data-funnel-view="member" data-funnel-state="${owner ? 'active-owner' : 'active-pro'}" data-membership="${escapeHtml(mState)}">
      ${head(kicker, headline, lede)}
      <section class="pbe-acct-card pbe-funnel-active-card" aria-label="Verified account">
        <div class="pbe-acct-card-top"><small>Verified account</small>${badge}</div>
        <strong class="pbe-acct-email">${escapeHtml(email || 'NFL Pro member')}</strong>
        <div class="pbe-acct-card-meta"><span class="pbe-funnel-plan-text">${escapeHtml(plan)}</span><span>${escapeHtml(period)}</span></div>
      </section>
      <div class="pbe-acct-unlocked">
        <span class="pbe-acct-unlocked-k">UNLOCKED ON THIS ACCOUNT</span>
        <ul>${tiles}</ul>
      </div>
      <div class="pbe-pro-auth-state pbe-funnel-auth pbe-acct-actions">
        <button class="pbe-pro-cta" id="pbe-funnel-open-board" type="button">Open Pro Prop Board</button>
        ${manage}
        <button class="pbe-pro-cta secondary" id="pbe-funnel-refresh" type="button">Refresh verified access</button>
        <div class="pbe-pro-message" id="pbe-funnel-message" role="status" aria-live="polite"></div>
      </div>
      ${allAccess ? `<div class="pbe-acct-network"><span>YOUR NETWORK</span><a class="pbe-acct-network-link" href="${window.PBENflMember?.LOCAL_ALL_ACCESS_PATH || '/all-access'}" data-nfl-network-link>10 sports + Predictions · open your network <b aria-hidden="true">→</b></a></div>` : ''}
      ${upgrade}
      <div class="pbe-pro-secure">◆ ${escapeHtml(label)} · ${isOwner ? 'verified server-side from your emailed sign-in link' : 'verified by PropBetEdge'} · new NFL Pro releases included while active</div>
    </div>`;
  }

  /* ------------------------------------------------------------ the visual column */

  function chipsHtml(kind) {
    return `<div class="pbe-acct-chips" aria-hidden="true">
        <span><i></i>DECISION · PRE-KICKOFF</span>
        <span><i></i>GRADE · FINAL</span>
        <span><i></i>RECORD · PERMANENT</span>
        ${kind === 'member' ? '<span class="is-unlocked"><i></i>UNLOCKED</span>' : ''}
      </div>`;
  }

  function storyHtml(kind, s = state(), m = membership(s)) {
    if (kind === 'member') {
      const mState = memberState(s, m);
      const P = window.PBENflMember?.display?.(m?.entitled ? m : null, mState) || null;
      const label = P?.designation || (m?.entitled && m.label ? m.label : (mState === 'owner' ? 'OWNER' : 'NFL PRO ACTIVE'));
      const platinum = mState === 'all_access';
      return `<span class="pbe-acct-eyebrow">${escapeHtml(mState === 'owner' ? 'NFL · VERIFIED OWNER' : `${label} · VERIFIED`)}</span>
        <h2 class="pbe-acct-title">${mState === 'owner' ? 'The full desk,<br><em>unlocked.</em>' : platinum ? 'The whole network,<br><em>unlocked.</em>' : 'Every surface<br><em>is live.</em>'}</h2>
        <p class="pbe-acct-copy">${platinum ? 'PropBetEdge All Access · 10 sports + Predictions. PBE Algo, official PBE Picks and the permanent Track Record are open here, and every other PropBetEdge desk is open on the same account.' : 'PBE Algo evaluates eligible games, records each decision before kickoff and grades it at the final. Every part of that loop is open on this account.'}</p>`;
    }
    if (kind === 'signin') {
      return `<span class="pbe-acct-eyebrow">PROPBETEDGE NFL · MEMBER ACCESS</span>
        <h2 class="pbe-acct-title">The pick is only<br><em>the beginning.</em></h2>
        <p class="pbe-acct-copy">Your PBE Picks, PBE Algo decisions and the permanent Track Record are one secure link away.</p>`;
    }
    if (kind === 'check') {
      return `<span class="pbe-acct-eyebrow">PROPBETEDGE NFL · ACCESS CHECK</span>
        <h2 class="pbe-acct-title">Your access<br><em>is protected.</em></h2>
        <p class="pbe-acct-copy">While verification is unavailable, nothing about your membership changes, and public NFL intelligence keeps working.</p>`;
    }
    return `<span class="pbe-acct-eyebrow">PROPBETEDGE NFL · INTELLIGENCE BUILT TO BE GRADED</span>
        <h2 class="pbe-acct-title">The pick is only<br><em>the beginning.</em></h2>
        <p class="pbe-acct-copy">PBE Algo evaluates eligible games, records the decision before kickoff, and turns every final result into evidence for the permanent record.</p>
        <ul class="pbe-acct-features">${FEATURES.map(([name, line]) => `<li><b>${escapeHtml(name)}</b><span>${escapeHtml(line)}</span></li>`).join('')}</ul>`;
  }

  function visualKind(s = state()) {
    if (s.loading) return 'check';
    if (s.pro) return 'member';
    if (window.PBEShellAuthState?.isDegraded?.(s) || s.access === 'unavailable') return 'check';
    if (s.user) return 'join';
    return view === 'signin' ? 'signin' : 'join';
  }

  /* Paints the left column for the current state. Idempotent: the art layer
     is built once; the story is replaced only when its state changes. */
  function paintVisual() {
    const modal = document.querySelector('#pbe-pro-backdrop .pbe-pro-modal');
    const pitch = modal?.querySelector('.pbe-pro-pitch');
    if (!modal || !pitch) return;
    const s = state();
    const kind = visualKind(s);
    const m = membership(s);
    const key = `${kind}:${memberState(s, m)}`;
    if (!modal.classList.contains('pbe-acct')) modal.classList.add('pbe-acct');
    if (modal.dataset.acctKind !== kind) modal.dataset.acctKind = kind;
    if (pitch.dataset.acctKey === key) return;
    pitch.dataset.acctKey = key;
    pitch.classList.add('pbe-acct-visual');
    if (!pitch.querySelector(':scope > .pbe-acct-art')) {
      pitch.innerHTML = `<div class="pbe-acct-art" role="img" aria-label="NFL stadium under the lights" title="${escapeHtml(STADIUM.credit)}" style="--pbe-acct-tall:url('${STADIUM.tall}');--pbe-acct-wide:url('${STADIUM.wide}')">
          <span class="pbe-acct-grid" aria-hidden="true"></span>
          <img class="pbe-acct-logo" src="${PBE_LOGO}" alt="PropBetEdge" width="118" height="66" decoding="async" onerror="this.remove()">
          <div data-acct-chips></div>
        </div>
        <div class="pbe-acct-story" data-acct-story></div>`;
    }
    const chips = pitch.querySelector('[data-acct-chips]');
    if (chips) chips.innerHTML = chipsHtml(kind);
    const story = pitch.querySelector('[data-acct-story]');
    if (story) story.innerHTML = storyHtml(kind, s, m);
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

  /* Writes only on change: the modal is observed, and rewriting an identical
     text node is still a mutation that would re-queue this surface forever. */
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  function paintSelection() {
    const selected = selectedKey();
    document.querySelectorAll('#pbe-pro-checkout [data-funnel-plan]').forEach(card => {
      const on = card.dataset.funnelPlan === selected;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      const check = card.querySelector('.pbe-funnel-check');
      if (check) setText(check, on ? '✓' : '');
    });
    const btn = document.getElementById('pbe-funnel-checkout');
    const p = PLANS[selected] || PLANS.monthly;
    if (btn) setText(btn, `${btn.dataset.funnelRenew === '1' ? 'Renew NFL Pro' : 'Unlock NFL Pro'} · ${p.price}${selected === 'monthly' ? '/mo' : '/wk'}`);
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
      document.getElementById('pbe-funnel-email')?.focus();
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

  /* Existing member: the auth Worker answers every request with the same
     generic 200 and emails a link only when the address holds access. One
     request per submit; the button stays disabled while it is in flight. */
  async function signInExisting() {
    if (linkRunning) return;
    const email = emailValue();
    if (!validEmail(email)) {
      message('Enter the email attached to your PropBetEdge access.', 'error');
      document.getElementById('pbe-funnel-email')?.focus();
      return;
    }
    linkRunning = true;
    const btn = document.getElementById('pbe-funnel-send-link');
    if (btn) btn.disabled = true;
    message('Sending your secure sign-in link…');
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
      linkRunning = false;
      const live = document.getElementById('pbe-funnel-send-link');
      if (live) live.disabled = false;
    }
  }

  async function refreshExistingAccess() {
    const btn = document.getElementById('pbe-funnel-refresh');
    if (btn) btn.disabled = true;
    message('Checking NFL Pro access…');
    try {
      const pro = await window.PBEPro?.refreshAccess?.();
      if (pro || state()?.pro) message('Access verified.', 'success');
      else message('NFL Pro is not active on this email yet. If you just paid, wait a few seconds and try again.');
    } catch (error) {
      message(error?.message || 'Could not refresh NFL Pro access.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function setView(next) {
    const v = next === 'signin' ? 'signin' : 'join';
    if (v === view) return;
    view = v;
    focusPending = true;
    mountPurchaseState();
  }

  function navTo(route) {
    window.PBEPro?.close?.();
    window.App?.nav?.(route);
  }

  /* Handlers are assigned as properties (onclick / onsubmit), never added, so
     re-wiring the same nodes after every repaint can never stack listeners. */
  function wire(host) {
    host.querySelectorAll('[data-funnel-plan]').forEach(card => {
      card.onclick = () => setSelected(card.dataset.funnelPlan);
    });
    const checkout = document.getElementById('pbe-funnel-checkout');
    if (checkout) checkout.onclick = () => startCheckout();
    const form = document.getElementById('pbe-funnel-signin-form');
    if (form) form.onsubmit = event => { event.preventDefault(); signInExisting(); };
    const showSignin = document.getElementById('pbe-funnel-show-signin');
    if (showSignin) showSignin.onclick = () => setView('signin');
    const showJoin = document.getElementById('pbe-funnel-show-join');
    if (showJoin) showJoin.onclick = () => setView('join');
    const refresh = document.getElementById('pbe-funnel-refresh');
    if (refresh) refresh.onclick = refreshExistingAccess;
    const signout = document.getElementById('pbe-funnel-signout');
    if (signout) signout.onclick = () => { signout.disabled = true; window.PBEPro?.signOut?.(); };
    const openBoard = document.getElementById('pbe-funnel-open-board');
    if (openBoard) openBoard.onclick = () => navTo('propboard');
    host.querySelectorAll('[data-acct-route]').forEach(tile => {
      tile.onclick = () => navTo(tile.dataset.acctRoute);
    });
    const input = document.getElementById('pbe-funnel-email');
    if (input && checkout) input.onkeydown = event => { if (event.key === 'Enter') startCheckout(); };
    paintSelection();
  }

  function mountPurchaseState() {
    const s = state();
    paintVisual();
    if (s.loading) return;
    const host = document.getElementById('pbe-pro-checkout');
    if (!host) return;
    /* paywall.js / sports-shell-auth-state.js own the "couldn't verify access"
       screens; no plans are pushed at a reader whose subscription could not
       be checked */
    if (s.access === 'unavailable') return;

    const owner = s.pro && s.role === 'owner';
    const m = membership(s);
    const mState = memberState(s, m);
    const mode = s.pro ? (owner ? 'active-owner' : 'active-pro') : s.user ? 'signed-in-free' : 'signed-out';
    const root = host.querySelector('.pbe-funnel-root');
    const current = root?.dataset?.funnelState;
    const membershipChanged = (root?.dataset?.membership || 'free') !== mState;
    const noteChanged = mode === 'signed-in-free' && ((root?.dataset?.funnelNote || '') !== String(s.entitlement?.reason || '') || (root?.dataset?.funnelView === 'lapsed' || root?.dataset?.funnelView === 'inactive') !== Boolean(lapsedKind(s)));
    const viewChanged = mode === 'signed-out' && (root?.dataset?.funnelView || '') !== view;
    if (current !== mode || membershipChanged || noteChanged || viewChanged) {
      host.innerHTML = s.pro
        ? activeProMarkup(String(s.user?.email || '').toLowerCase(), s.subscription, owner, m)
        : s.user
          ? signedInFreeMarkup(String(s.user.email || '').toLowerCase())
          : view === 'signin' ? signInMarkup() : signedOutMarkup();
    }
    wire(host);
    /* paywall.js owns the reader-facing notice (refused link, checkout return);
       a re-render here must never drop it. */
    window.PBEPro?.paintNotice?.();
    /* Desktop only: a phone keyboard must not cover the sheet on open. */
    if (focusPending && document.getElementById('pbe-pro-backdrop')?.classList.contains('open')) {
      focusPending = false;
      const input = host.querySelector('.pbe-acct-signin #pbe-funnel-email');
      if (input && window.matchMedia?.('(min-width:901px)').matches) input.focus({ preventScroll: true });
    }
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

  /* Why the surface opened (paywall.js open(reason)). The header's "Sign In",
     a failed or incomplete magic link and a checkout return whose access link
     still has to be requested land on the member sign-in view; everything
     else (Unlock NFL Pro, Upgrade, plan buttons) on get-access. */
  const SIGNIN_REASONS = new Set(['account', 'signin', 'auth-failed', 'auth-incomplete', 'checkout-success']);
  function onOpen(event) {
    const reason = String(event?.detail?.reason || '');
    view = SIGNIN_REASONS.has(reason) ? 'signin' : 'join';
    checkoutRunning = false;
    focusPending = true;
  }

  /* Back from Stripe can restore this page from the back/forward cache with
     the checkout button still disabled; release it so the page never wedges. */
  function onPageShow(event) {
    if (!event?.persisted) return;
    checkoutRunning = false;
    linkRunning = false;
    const btn = document.getElementById('pbe-funnel-checkout');
    if (btn) btn.disabled = false;
    message('');
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
    window.addEventListener('pbe:pro-open', onOpen);
    window.addEventListener('pageshow', onPageShow);
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
      setView,
      startCheckout,
      signInExisting,
      refreshExistingAccess,
      paintVisual,
      plans: PLANS,
      stadium: STADIUM,
      /* Pure builders, exposed so the membership tests can render each state
         without a browser. */
      markup: { signedOut: signedOutMarkup, signIn: signInMarkup, signedInFree: signedInFreeMarkup, active: activeProMarkup, story: storyHtml, memberState, membership }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
