/* PropBetEdge NFL — every Vercel API route and who may call it.
 *
 * tests/nfl-paywall-entitlement.test.mjs reads the api/ directory and fails
 * when a route is missing from this table, and proves every ENTITLED route
 * answers 401 / 403 / 503 without a current NFL entitlement. Adding a route
 * means deciding its access here first.
 *
 * ENTITLED  wrapped with withNflEntitlement (api/_nfl-access.js)
 * PUBLIC    reachable without a subscription, with the reason it must be
 */

export const ENTITLED_ROUTES = Object.freeze([
  'gw.js',                      // same-origin protected gateway reads (odds, best line, changes, injuries, season, picks/pass, replay …)
  'pro-model.js',               // the passing model for one event
  'game-intel.js',              // Games: odds board + core market per game
  'home-market.js',             // Dashboard core market
  'weather-watch.js',           // PBE Breaking weather rail
  'pbe-picks.js',               // PBE Picks / Track Record / receipts (view=preview is the one public variant)
  'pbe-prop-picks.js',          // player prop picks, including the track record with model fields
  'pbe-validation.js',          // validation telemetry
  'qb-dna.js', 'wr-dna.js', 'rb-dna.js', 'te-dna.js',
  'qb-dna/compare.js', 'qb-dna/game-context.js', 'qb-dna/prop-history.js', 'qb-dna/prop-lab.js',
  'rb-dna/compare.js', 'rb-dna/prop-lab.js',
  'wr-dna/compare.js', 'wr-dna/prop-lab.js',
  'te-dna/compare.js', 'te-dna/prop-lab.js',
]);

export const PUBLIC_ROUTES = Object.freeze({
  'auth-email.js': 'passwordless sign-in request',
  'auth-verify.js': 'magic-link landing; establishes identity only',
  'auth-session.js': 'reports identity and the access verdict; returns no product data',
  'auth-logout.js': 'sign-out',
  'auth-diag.js': 'auth backend diagnostics; no product data, no secrets',
  'checkout.js': 'subscription checkout',
  'checkout-complete.js': 'Stripe return; sends the access email',
  'stripe-webhook.js': 'Stripe-signed entitlement writes',
  'news-feed.js': 'public NFL news (explicitly public)',
  'nfl-media.js': 'team logos and player headshot lookups',
  /* nfl-live is an ESPN scoreboard/box-score relay, and it is consumed server-
     to-server by the frozen nfl-current Worker (?range, ?standings, ?event) and
     by nfl-prop-picks-grader (?event). Gating it would stop the season authority
     and the grader. It carries no PropBetEdge model or market data. Closing it
     requires those Workers to present a server token first. */
  'nfl-live.js': 'ESPN relay required by frozen server-side consumers (nfl-current, nfl-prop-picks-grader)',
});

export const PUBLIC_VARIANTS = Object.freeze({
  'pbe-picks.js': 'view=preview: locked teaser cards, assertNoSelection() guarantees no selection data',
});
