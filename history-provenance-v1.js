/* PropBetEdge NFL — historical provenance guard.
 *
 * A public surface may only state history that carries provenance satisfying
 * the rights policy (see history/docs/SOURCES_AND_RIGHTS.md). The datasets in
 * archive/ that this guard covers carry no source, no retrieval date and no
 * rights classification, and archive/teams.js documents itself as written from
 * model knowledge ("known through my knowledge cutoff", "pre-season
 * knowledge"). Independent spot checks against Wikidata (CC0) found both
 * correct rows and false ones — a Hall of Fame induction that never happened —
 * which is exactly the state that cannot be published as fact.
 *
 * So those surfaces say what they are instead of restating claims we cannot
 * stand behind. They are suppressed, never replaced with guessed data, and the
 * route, nav entry and layout stay exactly where they are.
 *
 * The two provenanced datasets (archive/stats-2025.js, archive/standings-2025.js
 * — provider NFL.com, verifiedAt 2026-08-29, semantics VERIFIED_FINAL) are NOT
 * suppressed.
 *
 * Fail closed: a renderer that cannot see this guard suppresses itself.
 */
(() => {
  'use strict';

  /* key -> suppressed. An unknown key is suppressed. */
  const STATE = {
    superbowls: true,
    hof: true,
    records: true,
    seasons: true,
    franchise_history: true,   // founding year, franchise championship counts
    player_archive: true,      // HOF / MVP / record / SB-MVP rows in the player drawer
    /* provenanced, published */
    standings2025: false,
    stats2025: false,
  };

  const REASON = 'PropBetEdge is re-sourcing NFL history from records that carry provenance and redistribution rights. The retained dataset behind this page has no source, no retrieval date and no rights classification, and it contains at least one claim we proved false, so it is not published here.';
  const NEXT = 'Franchise, venue and championship history is being rebuilt from openly licensed records first; each fact will arrive with its source and the date it was retrieved.';

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function isSuppressed(key) {
    return STATE[key] !== false;
  }

  /** Markup for a suppressed surface, in the route's own classes. */
  function noticeHtml({ root, hero, kicker, copy, badge, empty, title, kickerText }) {
    return `<section class="${esc(root)}">
      <header class="${esc(hero)}">
        <div>
          <div class="${esc(kicker)}">${esc(kickerText || 'HISTORY · PROVENANCE REVIEW')}</div>
          <h1 class="pbe-history-suppressed-title">${esc(title)}</h1>
          <div class="${esc(copy)}">${esc(REASON)}</div>
          <div class="${esc(copy)}">${esc(NEXT)}</div>
          ${badge ? `<div><span class="${esc(badge)}">UNPUBLISHED PENDING PROVENANCE</span></div>` : ''}
        </div>
      </header>
      <div class="${esc(empty)}">This page stays empty on purpose. Showing an unverified record would be worse than showing none.</div>
    </section>`;
  }

  /** Render the notice into `vc` when `key` is suppressed. Returns true if it did. */
  function render(vc, config) {
    if (!vc || !isSuppressed(config?.key)) return false;
    vc.innerHTML = noticeHtml(config);
    return true;
  }

  window.PBEHistoryProvenance = { version: '1.0.0', isSuppressed, render, noticeHtml, REASON, NEXT };
})();
