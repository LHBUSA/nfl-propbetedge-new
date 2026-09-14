/* PropBetEdge NFL — every Vercel API route and who may call it.
 *
 * Access unlock, not a site-wide paywall: visitors read the site and its
 * public data; the proprietary PBE layer (the passing model and live picks) is
 * premium and is enforced server-side here.
 *
 * tests/nfl-paywall-entitlement.test.mjs reads the api/ directory and fails
 * when a route is missing from this table, proves every PREMIUM route (and
 * premium variant) answers 401 / 403 / 503 without a current NFL entitlement
 * or the verified owner, and proves PUBLIC routes are not refused.
 *
 * PREMIUM   wrapped with withNflEntitlement (api/_nfl-access.js)
 * MIXED     wrapped, with an explicit public predicate for non-premium variants
 * PUBLIC    no subscription needed, with the reason
 */

export const PREMIUM_ROUTES = Object.freeze([
  'pro-model.js',               // PBE passing model for one event
]);

export const MIXED_ROUTES = Object.freeze({
  'gw.js': 'gateway reads are public except PREMIUM_GATEWAY_ROUTES (/api/picks/pass, the passing model)',
  'pbe-picks.js': 'view=current|validation-history|decision are premium; state, preview, trackrecord, receipt are public',
  'pbe-prop-picks.js': 'view=current is premium; state and trackrecord are public',
});

export const PUBLIC_ROUTES = Object.freeze({
  'auth-email.js': 'passwordless sign-in request',
  'auth-verify.js': 'magic-link landing; establishes identity only',
  'auth-session.js': 'reports identity and the access verdict; returns no product data',
  'auth-logout.js': 'sign-out',
  'auth-diag.js': 'auth backend diagnostics; no product data, no secrets',
  'checkout.js': 'subscription checkout',
  'checkout-complete.js': 'Stripe return; sends the access email',
  'stripe-webhook.js': 'Stripe-signed entitlement writes',
  'news-feed.js': 'public NFL news',
  'nfl-media.js': 'team logos and player headshot lookups',
  'nfl-live.js': 'ESPN scoreboard relay; also required by frozen server-side consumers (nfl-current, nfl-prop-picks-grader)',
  'game-intel.js': 'Games: sportsbook odds board + core market per game',
  'home-market.js': 'Dashboard core sportsbook market',
  'weather-watch.js': 'weather rail',
  'pbe-validation.js': 'aggregate validation telemetry (no selections)',
  'qb-dna.js': 'Player DNA research', 'wr-dna.js': 'Player DNA research', 'rb-dna.js': 'Player DNA research', 'te-dna.js': 'Player DNA research',
  'qb-dna/compare.js': 'Player DNA research', 'qb-dna/game-context.js': 'Player DNA research', 'qb-dna/prop-history.js': 'Player DNA research', 'qb-dna/prop-lab.js': 'Player DNA research',
  'rb-dna/compare.js': 'Player DNA research', 'rb-dna/prop-lab.js': 'Player DNA research',
  'wr-dna/compare.js': 'Player DNA research', 'wr-dna/prop-lab.js': 'Player DNA research',
  'te-dna/compare.js': 'Player DNA research', 'te-dna/prop-lab.js': 'Player DNA research',
});
