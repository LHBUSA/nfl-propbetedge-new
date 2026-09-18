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
 * IT HAPPENED AGAIN, WITH TEAMS. Measured against /api/news-feed on
 * 2026-09-18: 27 of 50 articles carried the identical summary "Atlanta's
 * cornerstone corner and pro-bowl guard cleared for practice Thursday..." and
 * all 27 were tagged teams:["ATL"] with the identical pair
 * players:["A.J. Terrell","Chris Lindstrom"] — including "Josh Allen accounts
 * for five TDs in Bills' 41-31 win over Lions" and a Sean McVay quote about
 * Myles Garrett. NONE of the 27 mentions Atlanta or the Falcons in its title.
 *
 * Rule 2 already stripped the bogus PLAYER tags. The team tag survived, because
 * teams were passed through uncorroborated — so a matchup page asking "what is
 * the news for ATL?" was handed 27 stories about other teams. Teams now go
 * through the same corroboration as players.
 *
 * THREE RULES, deliberately precise so they do not suppress good editorial:
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
 *   3. A TEAM tag is only kept when that team's own name, nickname or
 *      abbreviation appears in text that survived rule 1. The city alone is not
 *      enough on its own for a team whose city is a common word in football
 *      copy, and boilerplate never counts, because rule 1 removed it first.
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

  /* The tokens that identify a team in running copy.
   *
   * The nickname and the abbreviation are distinctive. The CITY is not, on its
   * own, for every team: "Carolina" is two states, "Washington" is a city and a
   * state, "New York" and "Los Angeles" each host two clubs, and a story set in
   * Atlanta is not a story about the Falcons. So the city qualifies a team only
   * when it is unambiguous AND is not a word that appears in football copy for
   * other reasons — which is why it is the weakest token and never used alone
   * for the shared-city and common-word cases listed below.
   */
  const AMBIGUOUS_CITIES = new Set([
    'new york', 'los angeles', 'carolina', 'washington', 'new england', 'tampa bay', 'kansas city',
  ]);

  function teamTokens(team) {
    if (!team) return [];
    const nickname = norm(String(team.name || '').split(' ').pop());
    const abbr = norm(team.abbr);
    const full = norm(team.name);
    const city = norm(team.city);
    const tokens = [];
    if (full.length > 3) tokens.push(full);
    if (nickname.length > 3) tokens.push(nickname);
    /* Two-letter codes are ordinary English words — NO, NE — and "no" appears
       in almost every sentence. Only a three-letter-or-longer abbreviation is
       distinctive enough to stand as evidence on its own. NO and NE still
       corroborate through "Saints" and "Patriots". */
    if (abbr.length >= 3) tokens.push(abbr);
    if (city.length > 3 && !AMBIGUOUS_CITIES.has(city)) tokens.push(city);
    return tokens;
  }

  /* Is this team tag supported by the article's own visible text?
   *
   * `haystack` must already have had a fallback summary removed (rule 1), so a
   * team named only in boilerplate cannot corroborate itself. The abbreviation
   * is matched on a word boundary: "ATL" must not be found inside "Atlantic",
   * and "NO" must not match the word "no".
   */
  function teamCorroborated(abbr, haystack, directory) {
    const key = String(abbr || '').toUpperCase();
    const team = directory?.[key];
    if (!team) return false;
    const padded = ` ${haystack} `;
    for (const token of teamTokens(team)) {
      if (token === norm(team.abbr)) {
        if (padded.includes(` ${token} `)) return true;
      } else if (haystack.includes(token)) return true;
    }
    return false;
  }

  /* Annotate a payload in place. Every consumer reads item._trust rather than
     the raw fields, so the rules live in exactly one place. */
  function prepare(items, options) {
    const list = Array.isArray(items) ? items : [];
    const dupes = duplicateSummaries(list);
    /* The team directory is injected so this module stays testable in node and
       does not depend on load order in the browser. */
    const directory = options?.teams || (typeof window !== 'undefined' ? window.NFL_TEAMS : null) || {};

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
      const rawTeams = (Array.isArray(item.teams) ? item.teams : []);
      const teams = rawTeams.filter(t => teamCorroborated(t, haystack, directory));

      item._trust = {
        summary,
        summarySuppressed: summaryIsFallback,
        players,
        // The scope line previously rendered a bare name and read as a byline.
        // It is only offered when at least one entity survives corroboration.
        scope: players.length ? players.slice(0, 2).join(', ') : null,
        /* Corroborated tags only. A consumer asking "what is the news for ATL?"
           must be able to trust the answer, so the raw tag is kept beside it
           rather than thrown away — the suppression is auditable, not silent. */
        teams,
        teamsRaw: rawTeams,
        teamsSuppressed: rawTeams.filter(t => !teams.includes(t)),
      };
    }
    return list;
  }

  /* Convenience for renderers that only need one field. */
  const trust = item => item?._trust || null;
  const safeSummary = item => (item?._trust ? item._trust.summary : summaryOf(item)) || '';
  const safeScope = item => (item?._trust ? item._trust.scope : (item?.market_impact?.scope || '')) || '';

  /* The one place a consumer should ask "is this story about this team?".
     Matchups used to answer it with a city substring of its own; there must not
     be a second, weaker team matcher anywhere in the product. */
  function storiesForTeam(items, abbr, { limit = 5 } = {}) {
    const key = String(abbr || '').toUpperCase();
    if (!key) return [];
    return (Array.isArray(items) ? items : [])
      .filter(item => (item?._trust?.teams || []).map(t => String(t).toUpperCase()).includes(key))
      .sort((a, b) => new Date(b?.published_at || 0) - new Date(a?.published_at || 0))
      .slice(0, limit);
  }

  window.PBENewsTrust = {
    prepare, trust, safeSummary, safeScope, duplicateSummaries, corroborated,
    teamCorroborated, teamTokens, storiesForTeam, AMBIGUOUS_CITIES,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.PBENewsTrust;
  }
})();
