/* PropBetEdge NFL — Injury Intelligence visual authority v2
 * Keeps NEWS semantics from newsroom-v2 while restoring player identity as
 * controlled compact portrait treatments. No page-wide MutationObserver.
 */
(() => {
  'use strict';

  let burstToken = 0;
  let timer = null;

  const text = value => String(value || '').replace(/\s+/g, ' ').trim();

  function playerName(scope) {
    const tag = scope?.querySelector?.('.pbe13-tag.accent');
    return text(tag?.textContent);
  }

  function playerIdentity(name, kind) {
    if (!name) return null;
    const el = document.createElement('div');
    el.className = `pbe13-story-player pbe13-story-player-${kind}`;
    el.dataset.pbePlayerMedia = '1';
    el.dataset.player = name;
    const label = document.createElement('span');
    label.className = 'pbe13-story-player-name';
    label.textContent = name;
    el.appendChild(label);
    return el;
  }

  function addLeadIdentity(root) {
    const lead = root.querySelector('.pbe13-lead');
    if (!lead || lead.querySelector('.pbe13-story-player')) return;
    const identity = playerIdentity(playerName(lead), 'lead');
    if (!identity) return;
    const topic = lead.querySelector('.pbe13-lead-topic');
    if (topic) topic.after(identity);
    else lead.prepend(identity);
  }

  function addCardIdentities(root) {
    root.querySelectorAll('.pbe13-card').forEach(card => {
      if (card.querySelector('.pbe13-story-player')) return;
      const identity = playerIdentity(playerName(card), 'card');
      if (!identity) return;
      const top = card.querySelector('.pbe13-card-top');
      if (top) top.after(identity);
      else card.prepend(identity);
    });
  }

  function reorder(root) {
    const note = root.querySelector('.pbe13-note');
    const featured = root.querySelector('.pbe13-featured');
    const summary = root.querySelector('#pbe13-summary');
    const controls = root.querySelector('.pbe13-controls');
    if (!note || !featured || !summary || !controls) return;
    note.after(featured);
    featured.after(summary);
    summary.after(controls);
  }

  function enhance() {
    if (window.App?.current !== 'injuries') return false;
    const root = document.querySelector('.pbe13-news');
    if (!root || !root.querySelector('.pbe13-note')) return false;
    root.classList.add('pbe13-injury-v2');
    reorder(root);
    addLeadIdentity(root);
    addCardIdentities(root);
    window.PBENFLPlayerMediaV3?.scan?.();
    return true;
  }

  function schedule(delay = 30) {
    clearTimeout(timer);
    timer = setTimeout(enhance, delay);
  }

  function burst() {
    const token = ++burstToken;
    [0, 60, 160, 360, 760, 1400, 2400].forEach(delay => setTimeout(() => {
      if (token === burstToken) enhance();
    }, delay));
  }

  window.addEventListener('pbe:route-changed', burst);
  window.addEventListener('pbe:upgrades-ready', burst);
  document.addEventListener('input', event => {
    if (event.target?.id === 'pbe13-search') schedule(45);
  }, true);
  document.addEventListener('change', event => {
    if (event.target?.id === 'pbe13-team' || event.target?.id === 'pbe13-sort') schedule(45);
  }, true);
  document.addEventListener('DOMContentLoaded', burst, { once: true });
  if (document.readyState !== 'loading') burst();

  window.PBEInjuryIntelV2 = { enhance, burst };
})();
