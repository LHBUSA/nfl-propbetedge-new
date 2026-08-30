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

export const UNTRAINED_STATE = 'ENGINE GATED — champion not trained';

/* Strictly true. A missing flag, a string 'false', a 1, or an absent meta
 * block all mean "not trained" — never publishable by accident. */
export function isTrainedChampion(champion) {
  return champion?.weights?.meta?.trained === true;
}

/* The single authority the orchestrator consults before emitting anything. */
export function championPublishable(champion) {
  if (!champion) {
    return { publishable: false, state: 'ENGINE DEGRADED — source unavailable', reason: 'no_promoted_champion' };
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
