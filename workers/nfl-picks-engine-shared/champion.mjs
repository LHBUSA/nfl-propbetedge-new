/* Champion publishability.
 *
 * A promoted row is NOT automatically a publishable one. The seeded champion
 * v1 is `promoted = true` with `weights.meta.trained = false` — hand-set priors
 * that have never been fitted to a single real outcome. Publishing official,
 * customer-facing picks from it would present untrained guesswork as a model
 * decision.
 *
 * The gate is driven entirely by PRODUCTION STATE — the champion row's own
 * `weights.meta.trained` flag. There is deliberately:
 *   - no env flag
 *   - no query parameter
 *   - no admin route
 *   - no code constant
 * that can turn publication on. The only way to publish is for the database to
 * contain a promoted champion whose weights declare themselves trained, which
 * only the tuner can produce, and only after its own hard gate opens.
 */

export const UNTRAINED_STATE = 'ENGINE GATED — MODEL VALIDATION IN PROGRESS';
export const DEGRADED_STATE = 'ENGINE DEGRADED — source unavailable';

/* The two publication classes. A prediction declares which it is at issuance
 * and can never be reclassified. */
export const SCOPE_TRACKING = 'tracking';
export const SCOPE_OFFICIAL = 'official';

/* Strictly true. A missing flag, a string 'false', a 1, or an absent meta
 * block all mean "not trained" — never publishable by accident. */
export function isTrainedChampion(champion) {
  return champion?.weights?.meta?.trained === true;
}

/* The single authority the orchestrator consults before emitting anything. */
export function championPublishable(champion) {
  if (!champion) {
    return { publishable: false, state: DEGRADED_STATE, reason: 'no_promoted_champion' };
  }
  if (champion.promoted === false) {
    return { publishable: false, state: UNTRAINED_STATE, reason: `not_promoted:v${champion.version ?? '?'}` };
  }
  if (!isTrainedChampion(champion)) {
    return {
      publishable: false,
      state: UNTRAINED_STATE,
      reason: `untrained_champion:v${champion.version ?? '?'}`,
    };
  }
  return { publishable: true, state: null, reason: null };
}

/* Resolves what a champion is allowed to ISSUE right now.
 *
 * The bootstrap path: a promoted-but-untrained champion still evaluates real
 * slates and persists real pregame decisions — but as `tracking`, which is
 * never customer-facing. This is how the loop earns its first 100 finalized
 * grades without presenting untrained output as an advertised result.
 *
 * There is no env flag, query parameter or code constant that can raise the
 * scope; it is a pure function of the champion row's own state.
 */
export function issuanceScope(champion) {
  if (!champion || champion.promoted === false) {
    return {
      canIssue: false,
      scope: null,
      mode: 'DEGRADED',
      state: DEGRADED_STATE,
      reason: champion ? `not_promoted:v${champion.version ?? '?'}` : 'no_promoted_champion',
    };
  }
  if (!isTrainedChampion(champion)) {
    return {
      canIssue: true,
      scope: SCOPE_TRACKING,
      mode: 'TRACKING_BOOTSTRAP',
      state: UNTRAINED_STATE,
      reason: `untrained_champion:v${champion.version ?? '?'}`,
    };
  }
  return {
    canIssue: true,
    scope: SCOPE_OFFICIAL,
    mode: 'OFFICIAL',
    state: null,
    reason: null,
  };
}

/* Customer-facing surfaces filter on the issuance classification itself, never
 * on the champion's current trained flag. If the model is later retrained, a
 * bootstrap row must STILL be excluded — the classification is authoritative,
 * not the model's present state. */
export function isCustomerFacing(pick) {
  return pick?.publication_scope === SCOPE_OFFICIAL;
}
