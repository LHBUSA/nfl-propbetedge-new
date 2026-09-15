/* Football history graph — position ontology resolver.
 *
 * resolveSourceLabel never loses the source's own label: the result always
 * carries `source_label` verbatim beside the canonical interpretation. Pure.
 */
import { readFileSync } from 'node:fs';

export const ONTOLOGY = JSON.parse(readFileSync(new URL('../ontology/positions.v1.json', import.meta.url), 'utf8'));

const LABELS = new Map(ONTOLOGY.source_labels.map(l => [l.label.toUpperCase(), l]));

/* Before offensive/defensive platoons were standard a "C" was frequently a
   two-way center/linebacker. The boundary is era context supplied by the
   caller's season rules profile, not a hard-coded year here. */
export function resolveSourceLabel(label, { source_id, platoon_era = true } = {}) {
  const raw = String(label ?? '').trim();
  const entry = LABELS.get(raw.toUpperCase());
  if (!raw) return { source_label: raw, source_id, canonical: 'UNKNOWN', ambiguous: true, mapping: 'empty_label' };
  if (!entry) return { source_label: raw, source_id, canonical: 'UNKNOWN', ambiguous: true, mapping: 'unmapped_label' };
  if (entry.label === 'C' && !platoon_era) {
    return { source_label: raw, source_id, canonical: 'CENTER_TWO_WAY', ambiguous: true, mapping: 'two_way_era_center' };
  }
  return { source_label: raw, source_id, canonical: entry.canonical, ambiguous: Boolean(entry.ambiguous), mapping: 'ontology_v1' };
}

/** Is `code` the same as, or a descendant of, `ancestor`? */
export function isWithin(code, ancestor) {
  let cur = code;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = ONTOLOGY.canonical[cur]?.parent ?? null;
  }
  return false;
}

/** Integrity: every mapping target exists, every parent exists, no cycles. */
export function validateOntology(ontology = ONTOLOGY) {
  const problems = [];
  const codes = ontology.canonical;
  for (const [code, node] of Object.entries(codes)) {
    if (node.parent !== null && !codes[node.parent]) problems.push({ rule: 'unknown_parent', code });
    const seen = new Set([code]);
    let p = node.parent;
    while (p) { if (seen.has(p)) { problems.push({ rule: 'cycle', code }); break; } seen.add(p); p = codes[p]?.parent ?? null; }
  }
  const labels = new Set();
  for (const l of ontology.source_labels) {
    if (!codes[l.canonical]) problems.push({ rule: 'label_to_unknown_code', label: l.label });
    const key = l.label.toUpperCase();
    if (labels.has(key)) problems.push({ rule: 'duplicate_label', label: l.label });
    labels.add(key);
  }
  return problems;
}
