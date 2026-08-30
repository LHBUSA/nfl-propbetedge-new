/* PropBetEdge NFL — runtime team directory bridge
 * archive/teams.js intentionally declares NFL_TEAMS as a top-level const.
 * Classic-script const bindings are global lexical bindings, not window properties.
 * Newer runtime modules use window.NFL_TEAMS, so bridge the verified directory once.
 */
(() => {
  'use strict';
  try {
    if (typeof NFL_TEAMS !== 'undefined' && NFL_TEAMS && !window.NFL_TEAMS) {
      window.NFL_TEAMS = NFL_TEAMS;
    }
    if (typeof NFL_DIVISIONS !== 'undefined' && NFL_DIVISIONS && !window.NFL_DIVISIONS) {
      window.NFL_DIVISIONS = NFL_DIVISIONS;
    }
  } catch (error) {
    console.error('[pbe-team-bridge]', error?.message || error);
  }
})();