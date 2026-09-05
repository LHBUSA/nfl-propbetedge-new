/* Normalizer verification against the real demo plays. */
import { readFileSync } from 'node:fs';
import { normalizePlayForArcade } from './arcade-normalize.js';
const demo = JSON.parse(readFileSync(new URL('./demo-plays.json', import.meta.url), 'utf8'));
const TEAMS = { home:{abbreviation:'GB'}, away:{abbreviation:'WSH'} };
for (const [label, play] of Object.entries(demo)) {
  const teams = label === 'TURNOVER' ? { home:{abbreviation:'KC'}, away:{abbreviation:'PHI'} } : TEAMS;
  const a = normalizePlayForArcade(play, { drive: play.drive, homeTeam: teams.home, awayTeam: teams.away });
  console.log(`\n=== ${label} :: ${a.kind}  (type_id ${a.typeId}, basis ${a.typeBasis}, verified ${a.typeVerified}) ===`);
  console.log(`  offense ${a.offense} vs ${a.defense}   Q${a.quarter} ${a.clock}   contract=${a.contract}`);
  console.log(`  startYard ${a.startYard}  ->  endYard ${a.endYard}   gained ${a.yardsGained}  (${a.provenance.yardsGained})`);
  console.log(`  down ${a.down} & ${a.distance}   firstDownYard ${a.firstDownYard}`);
  console.log(`  scoring ${a.scoring}   possessionChange ${a.possessionChange} (${a.provenance.possessionChange})`);
  const ppl = ['passer','receiver','rusher','tackler','interceptor','kicker','fumbledBy','recoveredBy']
    .filter(k => a[k]).map(k => `${k}=${a[k]}`).join('  ');
  console.log(`  people (all TEXT_DERIVED): ${ppl || '(none reported in text)'}`);
  console.log(`  confidence: ${a.confidence.level} — ${a.confidence.reason}`);
  console.log(`  text: ${a.actualText.slice(0,104)}`);
}
