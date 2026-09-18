/**
 * The CollegeFootballData ingestion boundary, as executable policy.
 *
 * The D3 audit found that CFBD serves, through one API and one contract, three
 * materially different kinds of thing: facts we may publish, ESPN-shaped records
 * we may only model on, and third-party ratings CFBD does not own and we may not
 * hold at all. A single "can we use CFBD" flag cannot express that, so this
 * module classifies every endpoint into a lane and refuses anything unclassified.
 *
 * Two rules here are stronger than a display policy, and the difference is the
 * whole point:
 *
 *   * a REFUSED endpoint is never called
 *   * a DENIED field is deleted before canonical persistence — not hidden at
 *     read time, not left inside a JSON column, not kept "for provenance"
 *
 * Hiding a prohibited value still means holding it. SP+, FPI, the 247Sports
 * talent composite, recruiting ratings, betting lines and the pre-draft grades
 * ride inside payloads we do want, and they leave at this boundary or not at all.
 *
 * Nothing in this file performs a network request. See history/ingest/cfbd-adapter.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(HERE, '..', 'registry', 'cfbd_ingest_policy.v1.json');

export const SOURCE_ID = 'src_cfbd';

let cached = null;
export function loadCfbdPolicy({ reload = false } = {}) {
  if (cached && !reload) return cached;
  cached = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  return cached;
}

export class RefusedEndpoint extends Error {
  constructor(path, reason, lane = null) {
    super(`CFBD endpoint ${path} refused: ${reason}`);
    this.name = 'RefusedEndpoint';
    this.path = path;
    this.lane = lane;
    this.reason = reason;
  }
}

export class ProhibitedField extends Error {
  constructor(findings) {
    super(`prohibited field(s) reached canonical storage: ${findings.map(f => `${f.path} (${f.reason})`).join('; ')}`);
    this.name = 'ProhibitedField';
    this.findings = findings;
  }
}

/** Normalise a path the way the policy keys are written: leading slash, no query, no trailing slash. */
export function normalisePath(path) {
  let p = String(path || '').trim();
  p = p.replace(/^https?:\/\/[^/]+/i, '');
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Which lane an endpoint belongs to.
 *
 * Three outcomes, and they are deliberately not collapsed:
 *   * a classified endpoint returns its lane
 *   * an explicitly denied endpoint throws naming the lane that forbids it
 *   * an UNKNOWN endpoint also throws — a path nobody has classified has no
 *     rights decision, and a new CFBD endpoint must not inherit permission from
 *     the ones around it
 */
export function classifyEndpoint(path, policy = loadCfbdPolicy()) {
  const p = normalisePath(path);
  const denied = (policy.denied_endpoints || []).find(d => normalisePath(d.path) === p);
  if (denied) throw new RefusedEndpoint(p, denied.reason, denied.lane);
  const prefix = (policy.denied_endpoint_prefixes || []).find(d => p.startsWith(d.prefix));
  if (prefix) throw new RefusedEndpoint(p, prefix.reason, prefix.lane);
  const lane = policy.endpoints[p];
  if (!lane) throw new RefusedEndpoint(p, 'not classified into a lane; an unclassified endpoint has no rights decision');
  return lane;
}

export function isEndpointAllowed(path, policy = loadCfbdPolicy()) {
  try { classifyEndpoint(path, policy); return true; } catch { return false; }
}

/**
 * Every field name denied on this lane, mapped to why.
 *
 * Unconditional denials apply everywhere: `talent` is the 247Sports composite
 * wherever it appears. Conditional denials apply only on named lanes, because
 * the same word is innocuous elsewhere — `rating` inside a portal payload is a
 * 247/On3-family composite, while `rating` is not inherently anything.
 */
export function deniedFieldsFor(lane, policy = loadCfbdPolicy()) {
  const out = new Map();
  for (const d of policy.denied_fields || []) {
    out.set(d.field, { reason: d.reason, lane_owner: d.lane, conditional: false });
  }
  for (const d of policy.conditional_denied_fields || []) {
    if ((d.lanes || []).includes(lane)) {
      out.set(d.field, { reason: d.reason, lane_owner: d.lane_owner, conditional: true });
    }
  }
  return out;
}

/** Identifier fields that may be held, but only as internal reconciliation keys. */
export function internalOnlyFields(policy = loadCfbdPolicy()) {
  return new Map((policy.internal_only_fields || []).map(f => [f.field, f.lane]));
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Delete every field this lane may not hold, at any depth, and say what was
 * removed. Returns a NEW structure: the caller's payload is not mutated, so a
 * retained raw snapshot and a sanitised record can never be the same object by
 * accident.
 */
export function sanitise(value, lane, policy = loadCfbdPolicy()) {
  const denied = deniedFieldsFor(lane, policy);
  const stripped = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [key, v] of Object.entries(node)) {
      const rule = denied.get(key);
      if (rule) {
        stripped.push({ path: path ? `${path}.${key}` : key, field: key, reason: rule.reason, lane_owner: rule.lane_owner });
        continue;
      }
      out[key] = walk(v, path ? `${path}.${key}` : key);
    }
    return out;
  };

  return { value: walk(value, ''), stripped };
}

/**
 * Lift the crosswalk identifiers out of a record on any other lane.
 *
 * They are not deleted — they are the join keys the whole college→NFL graph
 * depends on — but they do not belong on a draft row or a roster row, because
 * those rows may reach the Pro surface and a crosswalk identifier may not reach
 * any surface. So they move to the identifier_crosswalk lane, which is internal
 * only, hard, and has no endpoint of its own.
 */
export function extractCrosswalk(value, lane, policy = loadCfbdPolicy()) {
  const fields = internalOnlyFields(policy);
  if (lane === 'identifier_crosswalk') return { value, identifiers: [] };
  const identifiers = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [key, v] of Object.entries(node)) {
      if (fields.has(key)) {
        if (v !== null && v !== undefined) {
          identifiers.push({ field: key, value: v, path: path ? `${path}.${key}` : key, lane: fields.get(key) });
        }
        continue;
      }
      out[key] = walk(v, path ? `${path}.${key}` : key);
    }
    return out;
  };

  return { value: walk(value, ''), identifiers };
}

/**
 * Assert that nothing prohibited survived. This is the last gate before a row
 * is written, and it is separate from sanitise() on purpose: sanitise is the
 * intent, this is the proof. A future adapter that forgets to call sanitise
 * still cannot write, and a denylist entry added later fails the existing
 * pipeline loudly rather than quietly leaving old values in place.
 */
export function assertClean(value, lane, policy = loadCfbdPolicy()) {
  const denied = deniedFieldsFor(lane, policy);
  const internal = internalOnlyFields(policy);
  const findings = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (!isPlainObject(node)) return;
    for (const [key, v] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      const rule = denied.get(key);
      if (rule) findings.push({ path: here, field: key, reason: rule.reason });
      else if (internal.has(key) && lane !== 'identifier_crosswalk') {
        findings.push({ path: here, field: key, reason: `crosswalk identifier on lane ${lane}; it belongs to identifier_crosswalk and never to a surfaced row` });
      } else walk(v, here);
    }
  };

  walk(value, '');
  if (findings.length) throw new ProhibitedField(findings);
  return true;
}

/** Every lane this policy file knows how to reach, for coverage tests. */
export function classifiedLanes(policy = loadCfbdPolicy()) {
  return [...new Set(Object.values(policy.endpoints))].sort();
}

export function refusedLanes(policy = loadCfbdPolicy()) {
  return [...new Set((policy.denied_endpoints || []).map(d => d.lane)
    .concat((policy.denied_endpoint_prefixes || []).map(d => d.lane))
    .concat((policy.denied_fields || []).map(d => d.lane)))].filter(Boolean).sort();
}
