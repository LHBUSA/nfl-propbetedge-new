/* Canonical broadcaster registry — the ONLY place a broadcaster identity gets a
 * link.
 *
 * Rules this file enforces:
 *   - A name ESPN publishes is mapped to an identity only through ALIASES. A
 *     name we do not know stays exactly as the source wrote it, with no link.
 *   - A URL is never built from a network name, an event id or a slug. Every
 *     URL below was fetched (real Chrome, HTTP GET, redirects followed) and
 *     its final status and host recorded; verified_at is that check's time.
 *     Re-run: node scripts/verify-broadcaster-links.mjs
 *   - A URL is only emitted when its host is on that provider's allow-list
 *     (isAllowedDestination). Anything else is dropped, so a bad edit here
 *     cannot put an off-brand or aggregator link in front of a user.
 *   - kind separates a television NETWORK from a STREAMING service. It is the
 *     identity's nature, never an availability claim: CBS does not imply
 *     Paramount+, NBC does not imply Peacock, ESPN/ABC do not imply ESPN+.
 *   - No game-specific deep links: no broadcaster exposes a game URL contract
 *     we have verified, so the hierarchy starts at the NFL/watch landing page.
 *   - No logos (not approved).
 */

export const REGISTRY_VERSION = '2026-09-13.1';

const V = '2026-09-13';

export const BROADCASTERS = {
  cbs: {
    id: 'cbs', display_name: 'CBS', kind: 'network',
    hosts: ['www.cbs.com', 'www.cbssports.com'],
    watch_url: 'https://www.cbs.com/live-tv/stream/',
    watch_check: { status: 200, final_url: 'https://www.cbs.com/live-tv/stream/', title: 'CBS Live TV Stream', checked_at: `${V}T20:59:16Z` },
    official_url: 'https://www.cbssports.com/nfl/',
    official_check: { status: 200, final_url: 'https://www.cbssports.com/nfl/', title: 'NFL News, Scores, Stats, Standings and Rumors - National Football League - CBS Sports', checked_at: `${V}T20:59:25Z` },
    link_status: 'verified', verified_at: `${V}T20:59:16Z`
  },
  fox: {
    id: 'fox', display_name: 'FOX', kind: 'network',
    hosts: ['www.foxsports.com'],
    watch_url: 'https://www.foxsports.com/live',
    watch_check: { status: 200, final_url: 'https://www.foxsports.com/live', title: 'FOX Sports Live - Watch Live Sports, Shows, and Events Online | FOX Sports', checked_at: `${V}T20:59:32Z` },
    official_url: 'https://www.foxsports.com/nfl',
    official_check: { status: 200, final_url: 'https://www.foxsports.com/nfl', title: 'NFL News, Scores, Standings & Stats | FOX Sports', checked_at: `${V}T20:59:39Z` },
    link_status: 'verified', verified_at: `${V}T20:59:32Z`
  },
  nbc: {
    id: 'nbc', display_name: 'NBC', kind: 'network',
    hosts: ['www.nbcsports.com'],
    /* nbcsports.com/watch answered 200 but is a clips/highlights hub, not a
       live viewing destination, so NBC links to its NFL destination. */
    watch_url: null,
    watch_check: null,
    official_url: 'https://www.nbcsports.com/nfl',
    official_check: { status: 200, final_url: 'https://www.nbcsports.com/nfl', title: 'NFL Football: News, Videos, Stats, Highlights, Results & More - NBC Sports - NBC Sports', checked_at: `${V}T20:59:53Z` },
    link_status: 'verified', verified_at: `${V}T20:59:53Z`
  },
  espn: {
    id: 'espn', display_name: 'ESPN', kind: 'network',
    hosts: ['www.espn.com'],
    /* Answers 200 to a real browser; resets plain HTTP clients (bot wall). */
    watch_url: 'https://www.espn.com/watch/',
    watch_check: { status: 200, final_url: 'https://www.espn.com/watch/', title: 'Watch ESPN - Stream Live Sports & ESPN Originals', checked_at: `${V}T21:00:08Z` },
    official_url: 'https://www.espn.com/nfl/',
    official_check: { status: 200, final_url: 'https://www.espn.com/nfl/', title: 'NFL on ESPN - Scores, Stats and Highlights', checked_at: `${V}T21:00:16Z` },
    link_status: 'verified', verified_at: `${V}T21:00:08Z`
  },
  abc: {
    id: 'abc', display_name: 'ABC', kind: 'network',
    hosts: ['abc.com'],
    watch_url: 'https://abc.com/watch-live',
    watch_check: { status: 200, final_url: 'https://abc.com/watch-live', title: 'ABC Live Stream - ABC.com', checked_at: `${V}T21:00:23Z`, note: 'client-side route then moves to /watch-live/<station id>' },
    official_url: 'https://abc.com/',
    official_check: { status: 200, final_url: 'https://abc.com/', title: 'ABC Network - ABC.com', checked_at: `${V}T21:00:30Z` },
    link_status: 'verified', verified_at: `${V}T21:00:23Z`
  },
  nfl_network: {
    id: 'nfl_network', display_name: 'NFL Network', kind: 'network',
    hosts: ['www.nfl.com'],
    watch_url: 'https://www.nfl.com/network/watch',
    watch_check: { status: 200, final_url: 'https://www.nfl.com/network/watch', title: 'NFL Network Live Football, Shows, Events | NFL.com', checked_at: `${V}T21:00:37Z` },
    official_url: null,
    official_check: null,
    link_status: 'verified', verified_at: `${V}T21:00:37Z`
  },
  prime_video: {
    id: 'prime_video', display_name: 'Prime Video', kind: 'streaming',
    hosts: ['www.amazon.com', 'www.primevideo.com'],
    /* Amazon's own short link; 301 to its NFL tournament page. */
    watch_url: 'https://www.amazon.com/tnf',
    watch_check: { status: 200, redirects: ['301 https://www.amazon.com/tnf -> https://www.amazon.com/gp/video/tournament/amzn1.dv.icid.8dc09428-4ec1-49d5-80a9-73d52c5f7ad6'], final_url: 'https://www.amazon.com/gp/video/tournament/amzn1.dv.icid.8dc09428-4ec1-49d5-80a9-73d52c5f7ad6', title: 'Watch NFL on Prime Video', checked_at: `${V}T21:00:44Z` },
    official_url: 'https://www.primevideo.com/',
    official_check: { status: 200, final_url: 'https://www.primevideo.com/', title: 'Prime Video: Watch movies, TV shows, sports, and live TV', checked_at: `${V}T21:00:51Z` },
    link_status: 'verified', verified_at: `${V}T21:00:44Z`
  },
  peacock: {
    id: 'peacock', display_name: 'Peacock', kind: 'streaming',
    hosts: ['www.peacocktv.com'],
    watch_url: 'https://www.peacocktv.com/sports/nfl',
    watch_check: { status: 200, final_url: 'https://www.peacocktv.com/sports/nfl', title: 'Sunday Night Football | Watch NFL Games | Peacock', checked_at: `${V}T21:00:59Z` },
    official_url: null,
    official_check: null,
    link_status: 'verified', verified_at: `${V}T21:00:59Z`
  },
  netflix: {
    id: 'netflix', display_name: 'Netflix', kind: 'streaming',
    hosts: ['www.netflix.com'],
    /* No verified NFL destination: /tudum/nfl returned 404 and the homepage
       carries no NFL content. Rendered as plain text until one is verified. */
    watch_url: null,
    watch_check: { status: 404, final_url: 'https://www.netflix.com/tudum/nfl', title: '404 - Netflix Tudum', checked_at: `${V}T21:01:06Z` },
    official_url: null,
    official_check: null,
    link_status: 'unverified', verified_at: null
  }
};

/* Source spellings -> identity. Exact, case-sensitive after trimming; ESPN
   abbreviates NFL Network as "NFL Net". */
const ALIASES = {
  'CBS': 'cbs',
  'FOX': 'fox',
  'NBC': 'nbc',
  'ESPN': 'espn',
  'ABC': 'abc',
  'NFL Net': 'nfl_network',
  'NFL Network': 'nfl_network',
  'NFLN': 'nfl_network',
  'Prime Video': 'prime_video',
  'Amazon Prime Video': 'prime_video',
  'Peacock': 'peacock',
  'Netflix': 'netflix'
};

export function providerForName(name) {
  const id = ALIASES[String(name ?? '').trim()];
  return id ? BROADCASTERS[id] : null;
}

/* The published label for a source name: our display name for a known
   identity, the source's own spelling otherwise. */
export function displayName(name) {
  return providerForName(name)?.display_name || String(name ?? '').trim();
}

export function isAllowedDestination(providerId, url) {
  const p = BROADCASTERS[providerId];
  if (!p || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return p.hosts.includes(u.hostname);
}

/* Link hierarchy: 1 verified game-specific URL (none verified yet),
   2 verified official watch / NFL landing page, 3 verified official sports
   destination, 4 no link. */
export function destinationFor(name, type) {
  const p = providerForName(name);
  if (!p || p.link_status !== 'verified') return null;
  const pick = p.watch_url && p.watch_check?.status === 200
    ? { url: p.watch_url, url_type: 'official_watch', checked_at: p.watch_check.checked_at }
    : p.official_url && p.official_check?.status === 200
      ? { url: p.official_url, url_type: 'official_sports', checked_at: p.official_check.checked_at }
      : null;
  if (!pick || !isAllowedDestination(p.id, pick.url)) return null;
  return {
    provider: p.display_name,
    provider_id: p.id,
    type,
    url: pick.url,
    url_type: pick.url_type,
    verified: true,
    verified_at: pick.checked_at
  };
}

/* What a browser needs to re-check a link it is handed: identity -> hosts. */
export function allowedHostsById() {
  return Object.fromEntries(Object.values(BROADCASTERS).map(p => [p.id, [...p.hosts]]));
}
