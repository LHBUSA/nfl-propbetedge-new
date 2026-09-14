/* PropBetEdge NFL — access state for the page (access unlock, not a paywall).
 *
 * The site and its public data open for every visitor immediately. This file
 * loads the workspace at once and publishes the server's access verdict on
 * html[data-pbe-access] so premium modules can show a preview with an inline
 * "Unlock Pro" action:
 *
 *   checking        the session check has not answered yet
 *   anonymous       not signed in
 *   no_entitlement  signed in, no current NFL Pro (also expired / canceled)
 *   unavailable     the entitlement authority could not answer (never granted)
 *   granted         a current NFL Pro subscription or the verified owner
 *
 * The verdict comes from paywall.js (window.PBEPro.state), which reads
 * /api/auth-session. Nothing in the browser can grant access: premium data is
 * refused server-side (api/_nfl-access.js) unless the HttpOnly session proves
 * a current entitlement or the owner.
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
    './page-loader.js?v=20260914unlock1',
  ];

  const root = document.documentElement;
  let workspaceRequested = false;

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
    root.dataset.pbeAccess = accessOf(window.PBEPro?.state);
  }

  window.addEventListener('pbe:pro-state', apply);
  window.PBEAccessGate = {
    get state() { return root.dataset.pbeAccess || 'checking'; },
    workspaceScripts: WORKSPACE_SCRIPTS.slice(),
    apply,
  };
  apply();
  loadWorkspace();
})();
