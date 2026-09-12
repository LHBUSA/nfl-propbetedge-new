import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInjuryBoard, statusBucket } from '../workers/nfl-intel/src/injury-board.js';

test('status buckets keep restrictive designations together', () => {
  assert.equal(statusBucket('INJURED_RESERVE'), 'OUT');
  assert.equal(statusBucket('PUP'), 'OUT');
  assert.equal(statusBucket('QUESTIONABLE'), 'QUESTIONABLE');
  assert.equal(statusBucket('ACTIVE'), 'ACTIVE');
});

test('board always accounts for all 32 teams, canonicalizes clubs and surfaces stale source state', () => {
  const rows = [
    {
      report_id:'a', status:'OUT', status_label:'Out', updated_at:'2026-09-12T20:00:00.000Z', note:'Will not play.',
      player:{espn_id:'1',name:'Alpha Runner',position:'RB',headshot:null},
      injury:{type:'Hamstring',location:null,detail:null,side:null,return_date:null},
      team:{id:'16',abbreviation:'MIN',name:'MIN'}
    },
    {
      report_id:'b', status:'QUESTIONABLE', status_label:'Questionable', updated_at:'2026-09-12T19:00:00.000Z', note:null,
      player:{espn_id:'2',name:'Beta Receiver',position:'WR',headshot:null},
      injury:{type:null,location:'Ankle',detail:null,side:'Left',return_date:null},
      team:{id:'9',abbreviation:'GB',name:'GB'}
    }
  ];
  const board = buildInjuryBoard(rows, { fetched_at:'2026-09-12T20:05:00.000Z', failed_teams:['BAL'], record_failures:1 }, { now:Date.parse('2026-09-12T20:10:00.000Z') });
  assert.equal(board.teams.length, 32);
  assert.equal(board.counts.total, 2);
  assert.equal(board.counts.out, 1);
  assert.equal(board.counts.questionable, 1);
  assert.equal(board.counts.stale_teams, 1);
  assert.equal(board.source.age_seconds, 300);
  assert.equal(board.source.stale, false);
  assert.equal(board.source.partial, true);
  const min = board.teams.find(team => team.abbreviation === 'MIN');
  assert.equal(min.name, 'Minnesota Vikings');
  assert.equal(min.injuries[0].team.name, 'Minnesota Vikings');
  assert.equal(min.injuries[0].player.name, 'Alpha Runner');
  assert.equal(min.injuries[0].injury.label, 'Hamstring');
  const bal = board.teams.find(team => team.abbreviation === 'BAL');
  assert.equal(bal.source_stale, true);
  assert.equal(bal.source_status, 'STALE_PREVIOUS_SNAPSHOT');
  assert.deepEqual(bal.injuries, []);
});
