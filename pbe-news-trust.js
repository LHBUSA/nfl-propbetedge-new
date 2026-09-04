/* PropBetEdge NFL — news trust guard.
 *
 * WHY THIS EXISTS
 * The upstream news service (propbet-news-api) currently serves a fallback dek
 * and a fallback player tag on aggregated wire stories. Measured against
 * /api/news-feed?limit=12 on 2026-09-04: eight of twelve articles carried the
 * identical summary "Kansas City's quarterback cleared nine months after ACL
 * surgery..." and all eight were tagged players:["Patrick Mahomes"], including
 * a 49ers defensive-line story and a Raiders practice-squad story.
 *
 * Rendered verbatim, that made the product state things about real players
 * that are not true. api/news-feed.js is a faithful pass-through, so the
 * corruption is upstream and the permanent fix belongs to that service. This
 * module is the frontend's defensive half of the contract: it will not present
 * an uncorroborated claim as fact.
 *
 * TWO RULES, both deliberately precise so they do not suppress good editorial:
 *
 *   1. A summary that appears on more than one article in the same payload is
 *      a service-level fallback, not that article's dek. Suppress it.
 *      (A real dek is unique. This produces no false positives.)
 *
 *   2. An entity is only shown when the article's own visible text corroborates
 *      it -- its surname appears in the title, or in a summary that survived
 *      rule 1. PBE's own editorial passes this ("Harrison, Verse, Hunter" are
 *      all in the headline); the injected Mahomes tag does not.
 *
 * When something is suppressed the UI shows source and timestamp instead. It
 * never substitutes invented copy, and it never silently keeps the bad value.
 */
(() => {
  'use strict';

  const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  function titleOf(x) { return x?.title || x?.headline || x?.name || ''; }
  function summaryOf(x) { return x?.summary || x?.description || x?.dek || x?.excerpt || ''; }

  /* Which summaries in this payload are repeated? Those are the fallbacks. */
  function duplicateSummaries(items) {
    const counts = new Map();
    for (const item of items) {
      const s = norm(summaryOf(item));
      if (s.length < 24) continue;               // too short to judge
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    const dupes = new Set();
    for (const [s, n] of counts) if (n > 1) dupes.add(s);
    return dupes;
  }

  /* A name is corroborated when any of its distinctive parts appears in the
     text the reader can actually see. */
  function corroborated(name, haystack) {
    const parts = String(name || '').split(/\s+/).filter(p => p.replace(/[^a-z]/gi, '').length > 3);
    if (!parts.length) return false;
    return parts.some(p => haystack.includes(norm(p)));
  }

  /* Annotate a payload in place. Every consumer reads item._trust rather than
     the raw fields, so the rules live in exactly one place. */
  function prepare(items) {
    const list = Array.isArray(items) ? items : [];
    const dupes = duplicateSummaries(list);

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const title = titleOf(item);
      const rawSummary = summaryOf(item);
      const normSummary = norm(rawSummary);

      const summaryIsFallback = dupes.has(normSummary);
      const summary = summaryIsFallback ? null : (rawSummary || null);

      const haystack = norm(title) + ' ' + (summary ? normSummary : '');
      const players = (Array.isArray(item.players) ? item.players : [])
        .filter(p => corroborated(p, haystack));
      const teams = (Array.isArray(item.teams) ? item.teams : []);

      item._trust = {
        summary,
        summarySuppressed: summaryIsFallback,
        players,
        // The scope line previously rendered a bare name and read as a byline.
        // It is only offered when at least one entity survives corroboration.
        scope: players.length ? players.slice(0, 2).join(', ') : null,
        teams
      };
    }
    return list;
  }

  /* Convenience for renderers that only need one field. */
  const trust = item => item?._trust || null;
  const safeSummary = item => (item?._trust ? item._trust.summary : summaryOf(item)) || '';
  const safeScope = item => (item?._trust ? item._trust.scope : (item?.market_impact?.scope || '')) || '';

  window.PBENewsTrust = { prepare, trust, safeSummary, safeScope, duplicateSummaries, corroborated };
})();
