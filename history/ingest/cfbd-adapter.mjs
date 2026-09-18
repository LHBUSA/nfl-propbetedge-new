/**
 * The CollegeFootballData adapter — built, proven, and DISABLED.
 *
 * No API key exists. No CFBD data has been ingested. Nothing here has ever made
 * a network request, and it cannot until an owner sets CFBD_ENABLED=true and
 * supplies CFBD_API_KEY. The point of writing it now is that the rights
 * decisions from the D3 audit become executable while they are fresh, and the
 * tests that prove a prohibited value cannot be persisted exist BEFORE there is
 * any data to persist. A denylist written after the first ingest is a cleanup.
 *
 * The pipeline, in order, and every step can refuse:
 *
 *   1. enabled?            CFBD_ENABLED=true and a key present, or nothing happens
 *   2. classify            the path maps to exactly one lane, or it is refused
 *   3. ingest allowed?     the lane's policy permits persistence at all
 *   4. fetch               authenticated, one endpoint, recorded verbatim
 *   5. allowlist           where a lane has one, only named fields survive
 *   6. denylist            prohibited fields deleted at any depth
 *   7. crosswalk           identifiers lifted out to the internal-only lane
 *   8. assert              proof that nothing prohibited survived
 *   9. snapshot            content hash, retrieval time, retention metadata
 *
 * Steps 5-8 run on the way to canonical storage, not on the way out of it. A
 * value that is merely hidden at read time is still a value we hold.
 */
import { createHash } from 'node:crypto';
import {
  SOURCE_ID, loadCfbdPolicy, classifyEndpoint, normalisePath,
  sanitise, extractCrosswalk, assertClean,
} from '../lib/cfbd-policy.mjs';
import { assertLaneIngestAllowed, RightsRefusal } from '../lib/rights.mjs';

export { SOURCE_ID, RefusedEndpoint, ProhibitedField } from '../lib/cfbd-policy.mjs';

export const PARSER_NAME = 'pbe-cfbd-adapter';
export const PARSER_VERSION = '0.1.0';

export class AdapterDisabled extends Error {
  constructor(reason) {
    super(`CFBD adapter is disabled: ${reason}`);
    this.name = 'AdapterDisabled';
    this.reason = reason;
  }
}

/**
 * Is the adapter allowed to run at all?
 *
 * Fail-closed on every axis: a missing flag, a flag set to anything other than
 * the exact string 'true', a missing key, or an empty key. 'TRUE', '1' and
 * 'yes' are all refused deliberately — an ambiguous enablement is the kind of
 * thing that gets set by accident in a shell, and this switch turns on paid
 * requests against a source whose upstream rights are undocumented.
 */
export function enablement(env = {}) {
  const policy = loadCfbdPolicy();
  const flag = env[policy.enable_flag];
  const key = env[policy.secret_name];
  if (flag !== 'true') {
    return { enabled: false, reason: `${policy.enable_flag} is not exactly "true" (saw ${flag === undefined ? 'unset' : JSON.stringify(flag)})` };
  }
  if (typeof key !== 'string' || key.trim() === '') {
    return { enabled: false, reason: `${policy.secret_name} is not set` };
  }
  return { enabled: true, reason: null, key: key.trim() };
}

export function isEnabled(env = {}) {
  return enablement(env).enabled;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Apply a lane's field allowlist, if it has one. Top level of each record. */
export function applyAllowlist(records, lane, policy = loadCfbdPolicy()) {
  const allow = (policy.field_allowlist || {})[lane];
  if (!Array.isArray(allow)) return { records, dropped: [] };
  const keep = new Set(allow);
  const dropped = new Set();
  const out = records.map(r => {
    if (!isPlainObject(r)) return r;
    const kept = {};
    for (const [k, v] of Object.entries(r)) {
      if (keep.has(k)) kept[k] = v;
      else dropped.add(k);
    }
    return kept;
  });
  return { records: out, dropped: [...dropped].sort() };
}

/**
 * Deterministic normalisation. The same payload must produce byte-identical
 * output on every run, or the content hash stops meaning anything and a
 * re-ingest looks like a change. Keys are sorted; undefined becomes null;
 * nothing is reordered by chance.
 */
export function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      out[key] = v === undefined ? null : normalise(v);
    }
    return out;
  }
  return value === undefined ? null : value;
}

export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(normalise(value))).digest('hex');
}

/**
 * Run a fetched payload through the whole boundary without any network.
 *
 * Exposed separately so the refusal rules can be tested against fixtures — the
 * tests that matter here are the ones that prove a prohibited field cannot
 * reach storage, and those must not need a key to run.
 */
export function processPayload({ path, records, retrievedAt, retrievedFrom, policy = loadCfbdPolicy() }) {
  const lane = classifyEndpoint(path, policy);
  assertLaneIngestAllowed(SOURCE_ID, lane);

  const list = Array.isArray(records) ? records : [records];
  const { records: allowed, dropped } = applyAllowlist(list, lane, policy);
  const { value: sanitised, stripped } = sanitise(allowed, lane, policy);
  const { value: clean, identifiers } = extractCrosswalk(sanitised, lane, policy);

  // The proof, not the intent. If this throws, nothing is written.
  assertClean(clean, lane, policy);

  const normalised = normalise(clean);
  const now = retrievedAt || new Date().toISOString();

  return {
    lane,
    records: normalised,
    // Crosswalk identifiers travel as their own lane, which is internal only.
    crosswalk: identifiers.length
      ? { lane: 'identifier_crosswalk', identifiers: normalise(identifiers) }
      : null,
    stripped,
    dropped_by_allowlist: dropped,
    snapshot: {
      source_id: SOURCE_ID,
      lane,
      dataset: `cfbd${normalisePath(path).replace(/\//g, '_')}`,
      retrieved_from: retrievedFrom || `${policy.base_url}${normalisePath(path)}`,
      // Immutable: set once at retrieval and never recomputed on a later pass.
      retrieved_at: now,
      content_sha256: contentHash(normalised),
      row_count: normalised.length,
      parser_name: PARSER_NAME,
      parser_version: PARSER_VERSION,
      retention: {
        basis: policy.retention.raw_snapshot,
        raw_surface: policy.retention.raw_snapshot_surface,
        // What was refused is recorded as a count and a reason. The values
        // themselves are not kept anywhere, including here.
        prohibited_values_retained: false,
        stripped_field_count: stripped.length,
        stripped_fields: [...new Set(stripped.map(s => s.field))].sort(),
        // A field can leave by either gate, and which one it was is worth
        // recording: the allowlist means we never decided to keep it, the
        // denylist means we decided we may not.
        dropped_by_allowlist: dropped,
        refused_fields: [...new Set([...stripped.map(s => s.field), ...dropped])].sort(),
      },
    },
  };
}

/**
 * The adapter itself.
 *
 * `fetchImpl` is injected so a test can prove the disabled path never calls it.
 * When disabled, `fetch()` throws before touching the network, before reading
 * the key, and before classifying anything.
 */
export function createCfbdAdapter({ env = {}, fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const policy = loadCfbdPolicy();
  const state = enablement(env);

  async function fetchLane(path, params = {}) {
    if (!state.enabled) throw new AdapterDisabled(state.reason);
    const lane = classifyEndpoint(path, policy);
    assertLaneIngestAllowed(SOURCE_ID, lane);

    const url = new URL(policy.base_url + normalisePath(path));
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const retrievedAt = now();
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${state.key}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`CFBD ${normalisePath(path)} returned ${response.status}`);
    }
    const records = await response.json();
    return processPayload({ path, records, retrievedAt, retrievedFrom: url.toString(), policy });
  }

  return {
    get enabled() { return state.enabled; },
    get disabledReason() { return state.reason; },
    policy,
    classify: p => classifyEndpoint(p, policy),
    processPayload: args => processPayload({ ...args, policy }),
    fetch: fetchLane,
  };
}

export { RightsRefusal };
