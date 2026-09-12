/* PropBetEdge NFL — Injury availability readability v5
 * Presentation authority for the editorial availability rows, plus the bounded
 * bootstrap for the league-wide Injury Command Center. The command center owns
 * its own transport and DOM and remains additive to the editorial surface.
 * No mutation observers: route/upgrades events plus bounded render bursts only.
 */
(() => {
  'use strict';

  let burstToken = 0;
  const HEADERS = ['PLAYER','TEAM','INJURY','STATUS','REPORTED TIMELINE'];

  function ensureCommandCenterAssets() {
    if (!document.querySelector('link[data-pbe-injury-command-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './injury-command-center-v1.css';
      link.dataset.pbeInjuryCommandCss = '1';
      document.head.appendChild(link);
    }
    if (!window.PBEInjuryCommandCenterV1 && !document.querySelector('script[data-pbe-injury-command-js]')) {
      const script = document.createElement('script');
      script.src = './injury-command-center-v1.js';
      script.async = false;
      script.dataset.pbeInjuryCommandJs = '1';
      document.head.appendChild(script);
    }
  }

  /* The board is a five-column grid, so every row must contribute five cells.
     This used to bail when a row carried no team span, which left that row with
     four children and shifted its injury, status and timeline one column left --
     visible as soon as team codes started being withheld for lack of
     corroboration. The cell is now always created, and stays EMPTY when the
     article's own text does not support a franchise. An empty cell is the
     truthful answer; the previous 'NFL' fallback was a value nobody reported. */
  function splitTeamColumn(row) {
    if (!row || row.querySelector(':scope > .pbe13-availability-team')) return false;
    const player = row.querySelector(':scope > .pbe13-availability-player');
    if (!player) return false;
    const source = player.querySelector(':scope > span');

    const team = document.createElement('div');
    team.className = 'pbe13-availability-team';
    const label = source?.textContent?.trim() || '';
    if (label) {
      const code = document.createElement('span');
      code.className = 'team-code';
      code.textContent = label;
      team.appendChild(code);
    } else {
      team.classList.add('is-unreported');
    }
    source?.remove();
    player.after(team);
    return true;
  }

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    ensureCommandCenterAssets();
    try { window.PBEInjuryIntelV2?.enhance?.(); } catch {}
    try { window.PBEInjuryCommandCenterV1?.enhance?.(); } catch {}

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

    [...list.querySelectorAll(':scope > .pbe13-availability-row')].forEach(splitTeamColumn);

    board.dataset.pbeReadabilityV5 = '1';
    board.setAttribute('aria-label', "Who's out and how long — reported NFL player availability");
    root.dataset.pbeInjuryReadability = '5';
    return true;
  }

  function burst() {
    ensureCommandCenterAssets();
    const token = ++burstToken;
    [0,70,180,420,900,1600,2800,4600].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('DOMContentLoaded', burst, { once: true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryReadabilityV5 = { enhance, burst, splitTeamColumn, ensureCommandCenterAssets };
})();
