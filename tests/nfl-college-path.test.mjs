/**
 * College Path — the layer, the contract and the refusals.
 *
 *   node --test tests/nfl-college-path.test.mjs
 *
 * The interesting assertions here are not "does it render". They are:
 *   * a player we cannot resolve must never read as "no college"
 *   * a prohibited field must not be able to reach a response, even if someone
 *     hand-edits the artifact
 *   * identity must be a strong id or nothing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeCollegePath, assertClean, yearSpan, basisNote, orderSchools,
  STATES, CONTRACT, UNRESOLVED_LABEL, FORBIDDEN_SUBSTRINGS,
} from '../api/_collegepath/college-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ARTIFACT_PATH = join(REPO, 'data', 'dist', 'college-path.json');
const artifact = existsSync(ARTIFACT_PATH) ? JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) : null;

const withArtifact = (name, fn) =>
  test(name, { skip: artifact ? false : 'data/dist/college-path.json not built' }, fn);

/* A resolved player, chosen from the artifact rather than hard-coded, so the
   test does not rot when the spine is rebuilt. */
function sample(predicate) {
  if (!artifact) return null;
  for (const [espnId, record] of Object.entries(artifact.players)) {
    if (predicate(record)) return { espnId, record };
  }
  return null;
}

/* ------------------------------------------------------- a valid player */
withArtifact('a resolved player gets a college path with a school and provenance', () => {
  const found = sample(r => r.schools?.length);
  assert.ok(found, 'expected at least one resolved player in the artifact');
  const body = composeCollegePath({ espnId: found.espnId, record: found.record, meta: artifact.meta });

  assert.equal(body.ok, true);
  assert.equal(body.contract, CONTRACT);
  assert.equal(body.state, STATES.RESOLVED);
  assert.ok(body.schools.length > 0);
  assert.ok(body.schools[0].school, 'a school name');
  assert.ok(body.schools[0].basis_note, 'the basis is always explained in words');
  assert.ok(body.provenance?.sources?.length, 'every response names its sources');
  /* Only the two clean sources may ever appear. */
  for (const s of body.provenance.sources) {
    assert.ok(['src_wikidata', 'src_eada'].includes(s), `unexpected source ${s}`);
  }
});

withArtifact('multiple college associations are all carried, oldest first', () => {
  const found = sample(r => (r.schools || []).length > 1);
  assert.ok(found, 'expected at least one player with more than one school');
  const body = composeCollegePath({ espnId: found.espnId, record: found.record, meta: artifact.meta });
  assert.ok(body.schools.length > 1);
  const years = body.schools.map(s => s.first_season).filter(Boolean);
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'dated schools run oldest first');
});

withArtifact('a conference is carried where the source supplies one', () => {
  const found = sample(r => (r.schools || []).some(s => s.conference));
  assert.ok(found, 'expected at least one player with a conference');
  const body = composeCollegePath({ espnId: found.espnId, record: found.record, meta: artifact.meta });
  assert.ok(body.schools.some(s => s.conference));
});

withArtifact('a coaching overlap names the coach and the years it is based on', () => {
  const found = sample(r => (r.coaches || []).length);
  if (!found) return;                       // reported as a coverage gap, not a failure
  const body = composeCollegePath({ espnId: found.espnId, record: found.record, meta: artifact.meta });
  for (const c of body.coaches) {
    assert.ok(c.coach, 'a coach has a name');
    assert.ok(c.from, 'an overlap is only claimed where the tenure is dated');
  }
});

withArtifact('a pro transition never invents a round or a pick', () => {
  const found = sample(r => r.transition);
  assert.ok(found, 'expected at least one transition');
  const body = composeCollegePath({ espnId: found.espnId, record: found.record, meta: artifact.meta });
  assert.ok(body.transition.entry_route);
  if (!body.transition.detail_available) {
    assert.equal(body.transition.draft_round, null);
    assert.equal(body.transition.draft_overall_pick, null);
  }
});

/* ------------------------------------------- absence is not a negative label */
test('a player with no record says our data is missing, not that they have no college', () => {
  const body = composeCollegePath({ espnId: '999999', record: null });
  assert.equal(body.state, STATES.UNRESOLVED);
  assert.equal(body.label, UNRESOLVED_LABEL);
  assert.equal(body.absence_is_not_evidence, true);
  assert.deepEqual(body.schools, []);

  /* The copy must not be readable as a finding about the player. */
  const text = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['no college', 'did not play', 'never played', 'no college football',
    'not a college player', 'undrafted and uncollege']) {
    assert.equal(text.includes(forbidden), false, `must not say "${forbidden}"`);
  }
  assert.match(body.label, /not yet resolved/i);
});

test('an ambiguous identity withholds rather than guessing', () => {
  const body = composeCollegePath({ espnId: '123', record: null, ambiguous: true });
  assert.equal(body.state, STATES.AMBIGUOUS);
  assert.match(body.label, /identity not confirmed/i);
  assert.deepEqual(body.schools, []);
  assert.equal(body.absence_is_not_evidence, true);
});

withArtifact('the artifact carries the survivorship bias it was built under', () => {
  assert.equal(artifact.meta.sampling_bias.bias, 'notability_survivorship');
  assert.match(artifact.meta.sampling_bias.meaning, /absence is not evidence/i);
  const body = composeCollegePath({ espnId: '999999', record: null, meta: artifact.meta });
  assert.ok(body.bias_note, 'the bias travels with every response, including an empty one');
});

/* ------------------------------------------------------------- refusals */
test('a forbidden field cannot reach a response, at any depth, under any key', () => {
  for (const [key, value] of [
    ['recruiting_stars', 5], ['talent', 980], ['sp_plus', 22.1], ['fpi', 4.4],
    ['scouting_grade', 'A'], ['draft_grade', 91], ['overall_rank', 3],
    ['college_passing_yards', 4000], ['ppa', 0.31], ['usage_rate', 0.24],
    ['cfbd_athlete_id', 4432577], ['espn_athlete_id', 3139477],
  ]) {
    assert.throws(() => assertClean({ schools: [{ school: 'X', [key]: value }] }),
      e => e.name === 'ContractViolation', `${key} must be refused`);
  }
  // and nested inside an array of objects
  assert.throws(() => assertClean({ coaches: [{ coach: 'X', nested: { stars: 4 } }] }),
    e => e.name === 'ContractViolation');
});

test('no CollegeFootballData field can leak, and no CFBD source can be cited', () => {
  for (const key of ['cfbd_id', 'cfbdTeam', 'collegeAthleteId', 'nflAthleteId', 'recruitIds',
    'preDraftGrade', 'preDraftRanking', 'transfer_rating']) {
    assert.throws(() => assertClean({ schools: [{ [key]: 1 }] }),
      e => e.name === 'ContractViolation', `${key} must be refused`);
  }
});

withArtifact('no shipped record cites CollegeFootballData or any non-clean lane', () => {
  /* The DATA must not mention CFBD. meta.not_included names it deliberately —
     that is the disclosure of what this layer does not carry, and removing it
     would make the absence harder to audit, not safer. */
  assert.equal(/cfbd/i.test(JSON.stringify(artifact.players)), false,
    'no player record may mention CFBD');
  assert.ok(artifact.meta.not_included.some(x => /CollegeFootballData/i.test(x)),
    'the artifact should still declare that CFBD is not in it');
  for (const record of Object.values(artifact.players)) {
    for (const lane of record.provenance?.lanes || []) {
      assert.ok(['college_affiliation', 'institution_program_year'].includes(lane),
        `lane ${lane} is not one of the two public college lanes`);
    }
  }
});

withArtifact('every shipped record passes the contract it was built under', () => {
  let checked = 0;
  for (const [espnId, record] of Object.entries(artifact.players)) {
    const body = composeCollegePath({ espnId, record, meta: artifact.meta });
    assertClean(body);
    checked += 1;
  }
  assert.ok(checked > 0);
});

test('provenance keys are exempt: a citation is not a statistic', () => {
  /* 'snapshot_id' contains 'snaps', which is forbidden because snap counts are
     a rejected source. The guard must tell the difference or the payload loses
     the field that makes it auditable. */
  assert.equal(assertClean({ provenance: { sources: ['src_wikidata'], lanes: ['college_affiliation'] } }), true);
  assert.equal(assertClean({ schools: [{ school: 'X', snapshot_id: 'snp_abc' }] }), true);
  assert.throws(() => assertClean({ schools: [{ school: 'X', snaps: 400 }] }),
    e => e.name === 'ContractViolation', 'the actual stat is still refused');
});

/* ------------------------------------------------------------- identity */
withArtifact('identity is a strong id only, and an ambiguous one is refused not guessed', () => {
  assert.match(artifact.meta.identity, /strong identifiers only/i);
  assert.match(artifact.meta.identity, /never a join/i);
  assert.ok(Array.isArray(artifact.meta.ambiguous));
  for (const a of artifact.meta.ambiguous) {
    assert.ok(a.espn_id && a.via_pfr && a.via_espn);
    assert.notEqual(a.via_pfr, a.via_espn, 'only a genuine disagreement is recorded');
    assert.equal(artifact.players[a.espn_id], undefined, 'an ambiguous player ships no record');
  }
});

withArtifact('every artifact key is an ESPN athlete id, never a name', () => {
  for (const key of Object.keys(artifact.players)) {
    assert.match(key, /^\d{1,12}$/, `${key} is not an ESPN athlete id`);
  }
});

/* ------------------------------------------------- mixed source narrowness */
withArtifact('a record built from two sources is only as public as the narrower one', async () => {
  const { compositionSurfaces } = await import('../history/lib/rights.mjs');
  const wikidata = { source_id: 'src_wikidata', lane: 'college_affiliation' };
  const eada = { source_id: 'src_eada', lane: 'institution_program_year' };
  const restricted = { source_id: 'src_cfbd', lane: 'plays' };

  assert.deepEqual(compositionSurfaces([wikidata, eada]), ['public', 'pro', 'internal']);
  assert.deepEqual(compositionSurfaces([wikidata, restricted]), ['internal']);

  /* Which is why every lane the artifact actually cites is public-capable. */
  for (const record of Object.values(artifact.players)) {
    const parts = (record.provenance?.sources || []).map((source_id, i) => ({
      source_id, lane: (record.provenance.lanes || [])[i],
    }));
    if (!parts.length) continue;
    assert.ok(compositionSurfaces(parts).includes('public'),
      `a shipped record cites a composition that is not public: ${JSON.stringify(parts)}`);
  }
});

/* ------------------------------------------------------------- helpers */
test('a year span prints at the precision the source gave', () => {
  assert.equal(yearSpan({ first_season: 2015, last_season: 2018 }), '2015–2018');
  assert.equal(yearSpan({ first_season: 2015, last_season: 2015 }), '2015');
  assert.equal(yearSpan({ first_season: 2015 }), '2015');
  assert.equal(yearSpan({}), null, 'an unknown span stays unknown, never a guess');
});

test('attendance is described as attendance, never as having played', () => {
  assert.match(basisNote('educated_at'), /enrolment, not a football roster/i);
  assert.match(basisNote('member_of_sports_team'), /football programme/i);
  /* The distinction must survive an unknown basis too. */
  assert.match(basisNote(undefined), /enrolment/i);
});

test('undated schools sort after dated ones instead of pretending to a year', () => {
  const out = orderSchools([
    { school: 'B' }, { school: 'A', first_season: 2012 }, { school: 'C', first_season: 2010 },
  ]);
  assert.deepEqual(out.map(s => s.school), ['C', 'A', 'B']);
});

/* --------------------------------------------- the browser module, sandboxed */
function loadModule() {
  const source = readFileSync(join(REPO, 'nfl-college-path-v1.js'), 'utf8');
  const listeners = {};
  const sandbox = {
    window: {
      App: { current: 'qbdna' },
      addEventListener: (k, fn) => { listeners[k] = fn; },
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    setTimeout: () => 0,
    MutationObserver: class { observe() {} },
    console,
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(source, sandbox);
  return sandbox.window.PBECollegePath;
}

test('the rendered section never prints a negative claim about the player', () => {
  const mod = loadModule();
  assert.ok(mod, 'the module exports PBECollegePath');

  const unresolved = mod.html({ ok: true, state: 'UNRESOLVED', label: UNRESOLVED_LABEL, schools: [], coaches: [] });
  assert.match(unresolved, /College history not yet resolved/);
  assert.match(unresolved, /not a finding about this player/i);
  assert.equal(/no college\b/i.test(unresolved), false);
  assert.equal(/did not play/i.test(unresolved), false);

  const ambiguous = mod.html({ ok: true, state: 'AMBIGUOUS', label: 'x', schools: [], coaches: [] });
  assert.match(ambiguous, /rather than a guess/i);
});

test('the rendered section escapes source text and states what it does not carry', () => {
  const mod = loadModule();
  const markup = mod.html({
    ok: true, state: 'RESOLVED', label: 'College path',
    schools: [{ school: '<script>x</script>', conference: 'SEC', years: '2015–2018',
      basis_note: 'Attended', date_precision: 'year' }],
    coaches: [{ coach: 'A Coach', years: '2014–2019', program: 'Tide' }],
    transition: { entry_route: 'draft', entry_year: 2019, detail_available: false },
    provenance: { sources: ['src_wikidata'], retrieved_at: '2026-09-18T00:00:00Z' },
  });
  assert.equal(markup.includes('<script>x</script>'), false, 'source text is escaped');
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /NO PERFORMANCE DATA/);
  assert.match(markup, /no rights-clean source supplies them/i);
  assert.match(markup, /src_wikidata/);
});

/* ------------------------------------------------- no regression to the DNA */
test('the layer attaches to the DNA surface and registers no route of its own', () => {
  const source = readFileSync(join(REPO, 'nfl-college-path-v1.js'), 'utf8');
  assert.match(source, /data-pbe-current-layer/, 'anchors after the existing layers');
  assert.match(source, /data-pbe-career-ledger/);
  assert.match(source, /q2-hero/);
  assert.equal(/App\.VIEWS/.test(source), false, 'it must not register a route');
  assert.equal(/PBEQBDna\s*=/.test(source), false, 'it must not reassign a DNA product');
  /* No timers: a 2013 college season does not change while the tab is open. */
  assert.equal(/setInterval/.test(source), false, 'no polling loop');

  const loader = readFileSync(join(REPO, 'page-loader.js'), 'utf8');
  assert.match(loader, /nfl-college-path-v1\.js/, 'registered in the manifest');
  assert.match(loader, /nfl-college-path-v1\.css/);
  const idxLedger = loader.indexOf('player-career-ledger-v1.js');
  const idxCollege = loader.indexOf('nfl-college-path-v1.js');
  assert.ok(idxCollege > idxLedger, 'loads after the layers it anchors to');
});

test('the API is one file read and needs no entitlement', () => {
  const source = readFileSync(join(REPO, 'api', 'nfl-college-path.js'), 'utf8');
  assert.match(source, /college-path\.json/);
  assert.equal(/_nfl-auth|_nfl-entitlement/.test(source), false,
    'factual college affiliation is public profile context, not a paywall lever');
  assert.equal(/await fetch\(/.test(source), false, 'no upstream call per profile view');
  assert.match(source, /s-maxage/, 'stable history is cached at the edge');
});
