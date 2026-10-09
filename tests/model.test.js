// Run with: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/model.js');

function teamWith(n) {
  const t = M.newTeam('U13 Burlington Bees', 'U13');
  for (let i = 1; i <= n; i++) M.addPlayer(t, { first: `P${i}`, last: 'Test', number: String(i * 2) });
  return t;
}
const settings = { walkupSeconds: 15, duckLevel: 0.25, riseSeconds: 1 };

test('a new team has one lineup and new players fill it by number', () => {
  const t = M.newTeam('Bees');
  M.addPlayer(t, { first: 'B', number: '12' });
  M.addPlayer(t, { first: 'A', number: '2' });
  assert.equal(t.lineups.length, 1);
  // each new player joins the end of the order (the coach's order is kept, not re-sorted)
  assert.deepEqual(t.lineups[0].order.map(id => t.players.find(p => p.id === id).number), ['12', '2']);
  assert.deepEqual(t.lineups[0].bench, []);
});

test('a new lineup is filled with active players sorted by jersey number', () => {
  const t = M.newTeam('Bees');
  M.addPlayer(t, { first: 'C', number: '12' });
  M.addPlayer(t, { first: 'A', number: '2' });
  M.addPlayer(t, { first: 'B', number: '7', active: false });
  const l = M.addLineup(t, 'Game 2');
  const nums = l.order.map(id => t.players.find(p => p.id === id).number);
  assert.deepEqual(nums, ['2', '12']);
  assert.equal(l.bench.length, 1);
});

test('a player added later bats last in every lineup; an inactive one goes to the bench', () => {
  const t = teamWith(9);
  M.duplicateLineup(t, t.lineups[0].id, 'Tournament');
  const late = M.addPlayer(t, { first: 'Late', number: '99' });
  for (const l of t.lineups) assert.equal(l.order.at(-1), late.id);
  const away = M.addPlayer(t, { first: 'Away', number: '98', active: false });
  for (const l of t.lineups) assert.ok(l.bench.includes(away.id) && !l.order.includes(away.id));
});

test('removing a player takes them out of every lineup', () => {
  const t = teamWith(4);
  M.duplicateLineup(t, t.lineups[0].id, 'Copy');
  const gone = t.players[1].id;
  M.removePlayer(t, gone);
  for (const l of t.lineups) assert.ok(!l.order.includes(gone) && !l.bench.includes(gone));
});

test('making a player inactive benches them', () => {
  const t = teamWith(3);
  t.players[0].active = false;
  M.syncLineups(t);
  assert.ok(t.lineups[0].bench.includes(t.players[0].id));
  assert.ok(!t.lineups[0].order.includes(t.players[0].id));
});

test('reorder, move by arrows, bench and add back', () => {
  const t = teamWith(4);
  const l = t.lineups[0];
  const [a, b, c, d] = l.order;
  M.moveInOrder(l, d, 0);
  assert.deepEqual(l.order, [d, a, b, c]);
  M.moveBy(l, d, 1);
  assert.deepEqual(l.order, [a, d, b, c]);
  assert.equal(M.moveBy(l, a, -1), false, 'top player can’t move up');
  M.benchPlayer(l, b);
  assert.deepEqual(l.order, [a, d, c]);
  assert.deepEqual(l.bench, [b]);
  M.unbenchPlayer(l, b);
  assert.deepEqual(l.order, [a, d, c, b], 'added back at the end of the order');
  assert.deepEqual(l.bench, []);
});

test('auto-advance wraps from the last batter to the first', () => {
  const t = teamWith(3);
  const l = t.lineups[0];
  const [a, b, c] = l.order;
  assert.equal(M.upNextId(l, null), a);
  assert.equal(M.nextAfter(l, a), b);
  assert.equal(M.nextAfter(l, c), a);
  assert.deepEqual(M.comingUp(l, b), [c, a]);
});

test('if the up-next batter is benched, the top of the order is up next', () => {
  const t = teamWith(3);
  const l = t.lineups[0];
  const [a, b] = l.order;
  M.benchPlayer(l, b);
  assert.equal(M.upNextId(l, b), a);
  assert.equal(M.nextAfter(l, b), a);
});

test('an empty order has nobody up next', () => {
  const t = M.newTeam('Bees');
  assert.equal(M.upNextId(t.lineups[0], null), null);
  assert.deepEqual(M.comingUp(t.lineups[0], null), []);
});

test('duplicate lineups are independent; the last lineup can’t be deleted', () => {
  const t = teamWith(3);
  const copy = M.duplicateLineup(t, t.lineups[0].id, 'Tournament');
  M.benchPlayer(copy, copy.order[0]);
  assert.equal(t.lineups[0].order.length, 3);
  assert.equal(copy.order.length, 2);
  assert.equal(M.removeLineup(t, copy.id), true);
  assert.equal(M.removeLineup(t, t.lineups[0].id), false);
});

test('song names are split into title and artist from the file name', () => {
  const s = M.songFromFile('Walkups/Thunderstruck - AC-DC.mp3');
  assert.equal(s.title, 'Thunderstruck');
  assert.equal(s.artist, 'AC-DC');
  assert.equal(M.songFromFile('Songs/Believer.mp3').artist, '');
});

test('player status reflects song and announcement', () => {
  const lib = M.newLibrary();
  const s = M.songFromFile('Songs/A.mp3'); lib.songs.push(s);
  const p = M.newPlayer({ first: 'A' });
  assert.equal(M.playerStatus(p, lib), 'not-ready');
  p.songId = s.id;
  assert.equal(M.playerStatus(p, lib), 'no-intro');
  p.intro = { path: 'Announcements/a.mp3' };
  assert.equal(M.playerStatus(p, lib), 'ready');
  p.songId = 'missing';
  assert.equal(M.playerStatus(p, lib), 'no-song');
});

test('walk-up plan: song under the announcement, ducked', () => {
  const lib = M.newLibrary();
  const s = M.songFromFile('Songs/A.mp3'); s.start = 42; s.stop = 57; s.length = 292; lib.songs.push(s);
  const p = M.newPlayer({ first: 'Ava', songId: s.id, intro: { path: 'Announcements/ava.mp3' } });
  const plan = M.walkupPlan(p, lib, settings);
  assert.equal(plan.mode, 'under');
  assert.equal(plan.duckLevel, 0.25);
  assert.deepEqual([plan.song.start, plan.song.stop], [42, 57]);
});

test('walk-up plan: after, song only, intro only, nothing', () => {
  const lib = M.newLibrary();
  const s = M.songFromFile('Songs/A.mp3'); s.start = 10; s.length = 20; lib.songs.push(s);
  const p = M.newPlayer({ songId: s.id, intro: { path: 'x.mp3' }, entry: 'after' });
  assert.equal(M.walkupPlan(p, lib, settings).mode, 'after');
  assert.equal(M.walkupPlan(p, lib, settings).duckLevel, 1);
  assert.equal(M.walkupPlan(p, lib, settings).song.stop, 20, 'no stop point: 15 s, cut at the song’s end');
  assert.equal(M.walkupPlan({ ...p, intro: null }, lib, settings).mode, 'song');
  assert.equal(M.walkupPlan({ ...p, songId: null }, lib, settings).mode, 'intro');
  assert.equal(M.walkupPlan({ ...p, songId: null, intro: null }, lib, settings), null);
});

test('fade is never longer than the clip', () => {
  const lib = M.newLibrary();
  const s = M.songFromFile('Songs/A.mp3'); s.start = 5; s.stop = 6; s.fadeOut = 3; lib.songs.push(s);
  const plan = M.walkupPlan(M.newPlayer({ songId: s.id }), lib, settings);
  assert.equal(plan.song.fadeOut, 1);
});

test('team files are checked and repaired on open', () => {
  assert.throws(() => M.checkTeam({ hello: 1 }), /team file/);
  const t = teamWith(2);
  const json = JSON.parse(JSON.stringify(t));
  json.lineups[0].order.push('ghost');
  const back = M.checkTeam(json);
  assert.ok(!back.lineups[0].order.includes('ghost'));
  assert.equal(back.players.length, 2);
});

/* ---------------------------------------------------------------- Phase 2: moments */

function libWith(n) {
  const lib = M.newLibrary();
  for (let i = 1; i <= n; i++) { const s = M.songFromFile(`Songs/S${i}.mp3`); s.id = `s${i}`; lib.songs.push(s); }
  return lib;
}

test('a new team starts with the pre-made moments and breaks, all empty', () => {
  const t = M.newTeam('Bees');
  assert.deepEqual(t.moments.filter(m => m.section === 'moments').map(m => m.name),
    ['Home Run', 'Strikeout', 'Great Play', 'Walk', 'Rally Time', 'Double Play', 'Foul Ball', 'We Win!']);
  assert.deepEqual(t.moments.filter(m => m.section === 'breaks').map(m => m.name), ['Pitcher Warmup', 'Between Innings', 'Pregame', 'O Canada']);
  assert.ok(t.moments.every(m => m.songIds.length === 0));
  assert.equal(M.findMoment(t, t.moments[0].id).name, 'Home Run');
});

test('a Phase 1 team gets the pre-made moments once; a team that deleted them all stays empty', () => {
  const old = JSON.parse(JSON.stringify(teamWith(2)));
  old.version = 1; old.moments = [];
  assert.equal(M.checkTeam(old).moments.length, 12);
  const cleared = JSON.parse(JSON.stringify(teamWith(2)));
  cleared.moments = [];
  assert.equal(M.checkTeam(cleared).moments.length, 0);
});

test('random picks skip songs already played this game, then start over', () => {
  const lib = libWith(3);
  const m = M.newMoment({ songIds: ['s1', 's2', 's3'] });
  const state = { played: ['s1', 's2'], cursors: {} };
  assert.equal(M.pickSong(m, lib, state, () => 0).songId, 's3');
  state.played.push('s3');
  assert.equal(M.pickSong(m, lib, state, () => 0).songId, 's1', 'all played: back to the full list');
  m.skipPlayed = false;
  assert.equal(M.pickSong(m, lib, { played: ['s1'] }, () => 0).songId, 's1');
});

test('in order and playlists carry on from where they got to, and wrap', () => {
  const lib = libWith(3);
  const m = M.newMoment({ mode: 'order', songIds: ['s1', 's2', 's3'] });
  const state = { played: [], cursors: {} };
  const order = [];
  for (let i = 0; i < 4; i++) { const pick = M.pickSong(m, lib, state); order.push(pick.songId); M.notePlayed(m, lib, state, pick.songId); }
  assert.deepEqual(order, ['s1', 's2', 's3', 's1']);
  assert.deepEqual(state.played, ['s1', 's2', 's3']);
});

test('moments ignore songs that were deleted; an empty moment picks nothing', () => {
  const lib = libWith(1);
  assert.equal(M.pickSong(M.newMoment({ songIds: ['gone'] }), lib, {}), null);
  assert.equal(M.pickSong(M.newMoment({ songIds: ['gone', 's1'] }), lib, {}, () => 0.99).songId, 's1');
});

test('deleting a song removes it from players and moments', () => {
  const t = teamWith(1);
  t.players[0].songId = 's1';
  t.moments[0].songIds = ['s1', 's2'];
  assert.equal(M.momentsWithSong(t, 's1').length, 1);
  M.removeSongEverywhere(t, 's1');
  assert.equal(t.players[0].songId, null);
  assert.deepEqual(t.moments[0].songIds, ['s2']);
});

test('a moment plays its clip: start to stop, or to the end of the song', () => {
  const s = M.songFromFile('Songs/A.mp3'); s.start = 10; s.length = 200;
  assert.deepEqual([M.clipOf(s).stop, M.clipOf(s).length], [null, 190]);
  s.stop = 25;
  assert.deepEqual([M.clipOf(s).stop, M.clipOf(s).length], [25, 15]);
});
