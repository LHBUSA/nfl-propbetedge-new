/* PropBetEdge NFL — access gate.
 *
 * The NFL product is a subscription product. This file decides, from the
 * server's answer only, whether the paid workspace may load at all:
 *
 *   checking        html[data-pbe-access="checking"]   nothing but a status line
 *   anonymous       subscription wall (sign in / subscribe)
 *   no_entitlement  subscription wall with the signed-in email (also expired
 *                   and canceled subscriptions)
 *   unavailable     "Unable to verify access" — never granted on an outage
 *   granted         the workspace scripts load and the product opens
 *
 * The state comes from paywall.js (window.PBEPro.state), which reads
 * /api/auth-session. Nothing in the browser can grant access: the workspace
 * code is not even requested until the server says `granted`, and every paid
 * data route re-checks the entitlement on the server (api/_nfl-access.js), so
 * forcing this file's state by hand yields an empty shell of 401/403s.
 */
(() => {
  'use strict';

  const STATES = new Set(['checking', 'anonymous', 'no_entitlement', 'unavailable', 'granted']);
  /* The workspace, in the order index.html used to load it statically. */
  const WORKSPACE_SCRIPTS = [
    './app-core-v3.js?v=20260828y1',
    './archive/utils.js?v=202604071125',
    './archive/teams.js?v=202604071125',
    './archive/superbowls.js?v=202604071125',
    './archive/hof.js?v=202604071125',
    './archive/seasons.js?v=202604071125',
    './archive/records.js?v=202604071125',
    './archive/stats-2025.js?v=20260829verified1',
    './archive/standings-2025.js?v=20260829verified1',
    './ui-v2.js?v=20260913access1',
    './prop-board-v3.js?v=20260828y1',
    './model-lab.js?v=20260828y1',
    './page-loader.js?v=20260913access1',
  ];

  const root = document.documentElement;
  let workspaceRequested = false;
  let everGranted = false;

  function accessOf(state) {
    if (!state || state.loading) return 'checking';
    const access = String(state.access || '');
    if (access === 'granted') return state.pro === true && state.user ? 'granted' : 'unavailable';
    return STATES.has(access) ? access : 'unavailable';
  }

  function loadWorkspace() {
    if (workspaceRequested) return;
    workspaceRequested = true;
    for (const src of WORKSPACE_SCRIPTS) {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;              // execute in list order
      script.dataset.pbeWorkspace = '1';
      document.body.appendChild(script);
    }
    window.dispatchEvent(new CustomEvent('pbe:workspace-loading'));
  }

  function apply() {
    const state = window.PBEPro?.state;
    const access = accessOf(state);

    if (access === 'granted') {
      root.dataset.pbeAccess = 'granted';
      /* lift the wall on the transition only: later state events (an access
         refresh from the account dialog) must not close that dialog */
      if (!everGranted) window.PBEPro?.setWall?.(false);
      everGranted = true;
      loadWorkspace();
      return;
    }
    if (access === 'checking') {
      if (!everGranted) root.dataset.pbeAccess = 'checking';
      return;
    }
    /* Access ended while the workspace was open (sign-out, expiry, a 401/403
       from a data route): tear it down completely rather than hide it. */
    if (everGranted) {
      root.dataset.pbeAccess = access;
      location.reload();
      return;
    }
    root.dataset.pbeAccess = access;
    window.PBEPro?.setWall?.(true);
  }

  window.addEventListener('pbe:pro-state', apply);
  window.PBEAccessGate = {
    get state() { return root.dataset.pbeAccess || 'checking'; },
    workspaceScripts: WORKSPACE_SCRIPTS.slice(),
    apply,
  };
  apply();
})();
