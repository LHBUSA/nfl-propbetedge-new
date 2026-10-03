// Builds data/dist/player-id-crosswalk.json: the canonical NFL player id (gsis, the id the DNA endpoints already
// accept as ?player_id=) <-> the collection lane's athlete id. Used only at public serializer boundaries to add the
// neutral `player_id` alias next to deprecated espn_* fields and to accept ?player_id= where routes key by the lane id.
// Sources: career ledger + QB/RB/TE/WR DNA datasets (each row carries both ids). Conflicting pairs are dropped, never guessed.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.join(process.cwd(), 'data', 'dist');
const rows = [];
const ledger = JSON.parse(fs.readFileSync(path.join(dist, 'career-ledger.json'), 'utf8'));
for (const p of Object.values(ledger.players || {})) rows.push([p.gsis_id, p.espn_id]);
for (const pos of ['qb', 'rb', 'te', 'wr']) {
  const d = JSON.parse(fs.readFileSync(path.join(dist, `${pos}-dna-dataset.json`), 'utf8'));
  for (const p of d.players || []) rows.push([p.gsis_id, p.espn_id]);
}
const g2e = new Map(), e2g = new Map(), bad = new Set();
for (const [g, e] of rows) {
  if (!g || !e) continue;
  const gs = String(g), es = String(e);
  if ((g2e.has(gs) && g2e.get(gs) !== es) || (e2g.has(es) && e2g.get(es) !== gs)) { bad.add(gs); bad.add(es); continue; }
  g2e.set(gs, es); e2g.set(es, gs);
}
const lane = {};
for (const [e, g] of e2g) if (!bad.has(e) && !bad.has(g)) lane[e] = g;
const out = { contract: 'nfl-player-id-crosswalk/1', built_at: new Date().toISOString(), count: Object.keys(lane).length, conflicts_dropped: bad.size, lane_to_player_id: lane };
fs.writeFileSync(path.join(dist, 'player-id-crosswalk.json'), JSON.stringify(out));
console.log(`player-id-crosswalk: ${out.count} pairs, ${bad.size} conflicting ids dropped`);
