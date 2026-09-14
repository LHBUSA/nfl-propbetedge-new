/* NFL post-deploy access boundary smoke (Access V2).
 *
 *   PBE_URL=https://nfl.propbetedge.ai node scripts/nfl-access-boundary-smoke.mjs
 *
 * Against the live deployment, as the only readers production can be asked
 * about without a real login: anonymous and a forged owner session.
 *   - the public app shell and auth-session answer; no site-wide gate
 *   - every browser-reachable premium read refuses with 401 and no premium body
 *   - the model host refuses a caller without the server credential
 *   - the public Track Record contract: publication gate counts, validation and
 *     official totals separate, official record official-only, no decision
 *     content in public payloads
 * 403 (signed in, no purchase), 503 (entitlement unavailable) and the entitled
 * Pro path run in the controlled suites; see scripts/nfl-access-contract.mjs.
 * Writes access-boundary.log. Exit 1 on any failure.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { runLiveContract } from './nfl-access-contract.mjs';

const ORIGIN = String(process.env.PBE_URL || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
const LOG = 'access-boundary.log';
writeFileSync(LOG, '');
const log = s => { console.log(s); try { appendFileSync(LOG, `${s}\n`); } catch (_) {} };

log(`TARGET ${ORIGIN}`);
const failures = await runLiveContract({ origin: ORIGIN, log });
log(`RESULT ${failures.length ? 'FAIL' : 'PASS'}${failures.length ? ` (${failures.length})` : ''}`);
process.exit(failures.length ? 1 : 0);
