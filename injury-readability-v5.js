/* PropBetEdge NFL — Injury availability readability v5
 * Presentation-only authority. Adds a semantic desktop column header to the
 * existing source-disciplined availability board without changing injury facts.
 * No mutation observers: route/upgrades events plus a bounded render burst only.
 */
(() => {
  'use strict';

  let burstToken = 0;
  const HEADERS = ['PLAYER','TEAM','INJURY','STATUS','REPORTED TIMELINE'];

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    try { window.PBEInjuryIntelV2?.enhance?.(); } catch {}

    const root = document.querySelector('.pbe13-news.pbe13-injury-editorial');
    const board = root?.querySelector('.pbe13-availability-board');
    const list = board?.querySelector('.pbe13-availability-list');
    if (!root || !board || !list) return false;

    let columns = board.querySelector('.pbe13-availability-columns');
    if (!columns) {
      columns = document.createElement('div');
      columns.className = 'pbe13-availability-columns';
      columns.setAttribute('aria-hidden', 'true');
      columns.innerHTML = HEADERS.map(label => `<span>${label}</span>`).join('');
      board.insertBefore(columns, list);
    }

    board.dataset.pbeReadabilityV5 = '1';
    board.setAttribute('aria-label', "Who's out and how long — reported NFL player availability");
    root.dataset.pbeInjuryReadability = '5';
    return true;
  }

  function burst() {
    const token = ++burstToken;
    [0,70,180,420,900,1600,2800,4600].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('DOMContentLoaded', burst, { once: true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryReadabilityV5 = { enhance, burst };
})();
