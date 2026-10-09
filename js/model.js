/* Diamond DJ: the data model and the rules that don't touch the screen or the speakers.
 * Pure functions only, so they run in the browser and in Node tests (tests/model.test.js).
 *
 * team    { format:'diamond-team', version, id, name, short, players[], lineups[], moments[] }
 * player  { id, first, last, number, active, intro:{path}|null, songId|null, entry:'under'|'after' }
 * lineup  { id, name, order:[playerId], bench:[playerId], updated }
 * library { format:'diamond-library', version, songs[] }
 * song    { id, path, title, artist, length, start, stop, fadeOut, volume, categories[] }
 */
'use strict';

(function (root) {
  const FORMAT_TEAM = 'diamond-team';
  const FORMAT_LIBRARY = 'diamond-library';

  let idCounter = 0;
  function uid(prefix) {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `${prefix}_${rand}${(idCounter++).toString(36)}`;
  }

  /* ------------------------------------------------------------ teams and players */

  function newTeam(name, short) {
    const team = { format: FORMAT_TEAM, version: 2, id: uid('t'), name, short: short || name, players: [], lineups: [], moments: defaultMoments() };
    team.lineups.push(newLineup('Default'));
    return team;
  }

  /* ------------------------------------------------------------ key moments and breaks */

  const COLORS = ['navy', 'blue', 'gold', 'light'];

  function newMoment(fields = {}) {
    return {
      id: fields.id || uid('m'),
      name: String(fields.name || 'New moment'),
      color: COLORS.includes(fields.color) ? fields.color : 'blue',
      section: fields.section === 'breaks' ? 'breaks' : 'moments',
      mode: ['random', 'order', 'playlist'].includes(fields.mode) ? fields.mode : 'random',
      skipPlayed: fields.skipPlayed !== false,
      songIds: Array.isArray(fields.songIds) ? fields.songIds.map(String) : [],
    };
  }

  // the moments from the mockups: made empty, the organizer adds songs
  function defaultMoments() {
    return [
      ['Home Run', 'navy'], ['Strikeout', 'blue'], ['Great Play', 'blue'], ['Walk', 'light'],
      ['Rally Time', 'gold', 'order'], ['Double Play', 'blue'], ['Foul Ball', 'light'], ['We Win!', 'navy'],
    ].map(([name, color, mode]) => newMoment({ name, color, mode }))
      .concat([
        ['Pitcher Warmup', 'playlist'], ['Between Innings', 'playlist'], ['Pregame', 'playlist'], ['O Canada', 'order'],
      ].map(([name, mode]) => newMoment({ name, mode, section: 'breaks', color: 'light', skipPlayed: mode !== 'order' })));
  }

  function findMoment(team, id) { return team.moments.find(m => m.id === id) || null; }

  function removeSongEverywhere(team, songId) {
    for (const p of team.players) if (p.songId === songId) p.songId = null;
    for (const m of team.moments) m.songIds = m.songIds.filter(id => id !== songId);
  }

  function momentsWithSong(team, songId) { return team.moments.filter(m => m.songIds.includes(songId)); }

  /* Which song a tap on a moment plays.
     state: { played: [songId], cursors: { momentId: index } } (kept on the device, cleared by New game)
     rand: a function returning 0..1 (Math.random; tests pass their own)
     Returns { songId, index } or null when the moment has no songs. */
  function pickSong(moment, library, state, rand = Math.random) {
    const ids = moment.songIds.filter(id => findSong(library, id));
    if (!ids.length) return null;
    if (moment.mode === 'random') {
      const played = new Set(state.played || []);
      let pool = moment.skipPlayed ? ids.filter(id => !played.has(id)) : ids;
      if (!pool.length) pool = ids; // everything played: start over
      const songId = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
      return { songId, index: ids.indexOf(songId) };
    }
    // in order, and playlists: carry on from where this moment got to
    const at = (state.cursors && state.cursors[moment.id]) || 0;
    const index = at % ids.length;
    return { songId: ids[index], index };
  }

  /* Record that a moment played a song: marks it played and moves the moment's place on. */
  function notePlayed(moment, library, state, songId) {
    state.played = state.played || [];
    if (!state.played.includes(songId)) state.played.push(songId);
    const ids = moment.songIds.filter(id => findSong(library, id));
    state.cursors = state.cursors || {};
    state.cursors[moment.id] = (ids.indexOf(songId) + 1) % Math.max(1, ids.length);
    return state;
  }

  /* The playback window for a song in a moment: its start point to its stop point,
     or to the end of the song when it has no stop point. */
  function clipOf(song) {
    const start = Math.max(0, song.start || 0);
    const stop = song.stop != null && song.stop > start ? song.stop : null;
    const end = stop ?? (song.length || null);
    return { path: song.path, start, stop, fadeOut: song.fadeOut ?? 2, volume: song.volume ?? 1, length: end != null ? end - start : null };
  }

  function newPlayer(fields = {}) {
    return {
      id: uid('p'),
      first: (fields.first || '').trim(),
      last: (fields.last || '').trim(),
      number: String(fields.number ?? '').trim(),
      active: fields.active !== false,
      intro: fields.intro || null,
      songId: fields.songId || null,
      entry: fields.entry === 'after' ? 'after' : 'under',
    };
  }

  function playerName(p) {
    return [p.first, p.last].filter(Boolean).join(' ') || 'New player';
  }

  // jersey numbers sort as numbers ("2" before "12"); blanks last
  function byNumber(a, b) {
    const na = parseInt(a.number, 10), nb = parseInt(b.number, 10);
    const ia = isNaN(na), ib = isNaN(nb);
    if (ia !== ib) return ia ? 1 : -1;
    if (!ia && na !== nb) return na - nb;
    return playerName(a).localeCompare(playerName(b));
  }

  /* Ready = has a walk-up song that exists and an announcement. */
  function playerStatus(player, library) {
    const song = player.songId ? findSong(library, player.songId) : null;
    const hasSong = !!song, hasIntro = !!(player.intro && player.intro.path);
    if (hasSong && hasIntro) return 'ready';
    if (hasSong) return 'no-intro';
    if (hasIntro) return 'no-song';
    return 'not-ready';
  }

  function addPlayer(team, fields) {
    const p = newPlayer(fields);
    team.players.push(p);
    syncLineups(team);
    return p;
  }

  function removePlayer(team, playerId) {
    team.players = team.players.filter(p => p.id !== playerId);
    syncLineups(team);
  }

  /* ------------------------------------------------------------ lineups */

  function newLineup(name, order = [], bench = []) {
    return { id: uid('l'), name: name || 'Lineup', order: [...order], bench: [...bench], updated: Date.now() };
  }

  /* Keeps every lineup consistent with the roster:
     - removed players disappear;
     - inactive players move to the bench;
     - players a lineup has never seen join the end of its order (inactive ones, its bench);
       an empty lineup is filled by jersey number. */
  function syncLineups(team) {
    const byId = new Map(team.players.map(p => [p.id, p]));
    const active = team.players.filter(p => p.active).sort(byNumber).map(p => p.id);
    for (const l of team.lineups) {
      const before = JSON.stringify([l.order, l.bench]);
      const seen = new Set();
      l.order = l.order.filter(id => byId.has(id) && !seen.has(id) && seen.add(id));
      l.bench = l.bench.filter(id => byId.has(id) && !seen.has(id) && seen.add(id));
      const inactive = l.order.filter(id => !byId.get(id).active);
      l.order = l.order.filter(id => byId.get(id).active);
      l.bench.push(...inactive);
      const missing = team.players.filter(p => !seen.has(p.id)).sort(byNumber).map(p => p.id);
      // youth teams bat everyone: new active players join the end of the order, ready to bat
      l.order.push(...missing.filter(id => active.includes(id)));
      l.bench.push(...missing.filter(id => !active.includes(id)));
      if (JSON.stringify([l.order, l.bench]) !== before) l.updated = Date.now();
    }
    if (team.lineups.length === 0) {
      team.lineups.push(newLineup('Default', active, team.players.filter(p => !p.active).map(p => p.id)));
    }
    return team;
  }

  function findLineup(team, id) {
    return team.lineups.find(l => l.id === id) || team.lineups[0] || null;
  }

  function duplicateLineup(team, id, name) {
    const src = findLineup(team, id);
    const copy = newLineup(name || `${src.name} copy`, src.order, src.bench);
    team.lineups.splice(team.lineups.indexOf(src) + 1, 0, copy);
    return copy;
  }

  function addLineup(team, name) {
    const l = newLineup(name || `Lineup ${team.lineups.length + 1}`);
    team.lineups.push(l);
    syncLineups(team); // fills the order with active players by number
    return l;
  }

  function removeLineup(team, id) {
    if (team.lineups.length <= 1) return false; // always keep one
    team.lineups = team.lineups.filter(l => l.id !== id);
    return true;
  }

  function touch(l) { l.updated = Date.now(); return l; }

  function moveInOrder(lineup, playerId, toIndex) {
    const from = lineup.order.indexOf(playerId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(lineup.order.length - 1, toIndex));
    if (from === to) return false;
    lineup.order.splice(from, 1);
    lineup.order.splice(to, 0, playerId);
    touch(lineup);
    return true;
  }

  function moveBy(lineup, playerId, delta) {
    const i = lineup.order.indexOf(playerId);
    return i >= 0 && moveInOrder(lineup, playerId, i + delta);
  }

  function benchPlayer(lineup, playerId) {
    const i = lineup.order.indexOf(playerId);
    if (i < 0) return false;
    lineup.order.splice(i, 1);
    if (!lineup.bench.includes(playerId)) lineup.bench.push(playerId);
    touch(lineup);
    return true;
  }

  function unbenchPlayer(lineup, playerId) {
    const i = lineup.bench.indexOf(playerId);
    if (i < 0) return false;
    lineup.bench.splice(i, 1);
    lineup.order.push(playerId);
    touch(lineup);
    return true;
  }

  /* ------------------------------------------------------------ batting order (auto-advance) */

  /* Who is up next. `upNext` is a player id kept on the device. If that player is no longer
     batting (benched or removed), the batter who was after them takes over: we can't know
     that any more, so fall back to the top of the order. */
  function upNextId(lineup, upNext) {
    if (!lineup || lineup.order.length === 0) return null;
    return lineup.order.includes(upNext) ? upNext : lineup.order[0];
  }

  function nextAfter(lineup, playerId) {
    if (!lineup || lineup.order.length === 0) return null;
    const i = lineup.order.indexOf(playerId);
    if (i < 0) return lineup.order[0];
    return lineup.order[(i + 1) % lineup.order.length];
  }

  /* The batters after `upNext`, in order, wrapping round, not repeating `upNext`. */
  function comingUp(lineup, upNext) {
    const first = upNextId(lineup, upNext);
    if (!first) return [];
    const i = lineup.order.indexOf(first);
    return [...lineup.order.slice(i + 1), ...lineup.order.slice(0, i)];
  }

  function battingSlot(lineup, playerId) {
    const i = lineup ? lineup.order.indexOf(playerId) : -1;
    return i < 0 ? null : i + 1;
  }

  /* ------------------------------------------------------------ library */

  function newLibrary() { return { format: FORMAT_LIBRARY, version: 1, songs: [] }; }

  function findSong(library, id) { return library.songs.find(s => s.id === id) || null; }

  function songFromFile(path, fields = {}) {
    const base = path.split('/').pop().replace(/\.[^.]+$/, '');
    // "Title - Artist" is the common way people name walk-up files
    const parts = base.split(/\s+-\s+/);
    return {
      id: uid('s'),
      path,
      title: fields.title || parts[0].trim() || base,
      artist: fields.artist ?? (parts.length > 1 ? parts.slice(1).join(' - ').trim() : ''),
      length: fields.length || 0,
      start: 0,
      stop: null,
      fadeOut: 2,
      volume: 1,
      categories: [],
    };
  }

  function songLabel(song) {
    return song ? [song.title, song.artist].filter(Boolean).join(' · ') : '';
  }

  function songsUsing(team, songId) {
    return team.players.filter(p => p.songId === songId);
  }

  /* ------------------------------------------------------------ the walk-up plan */

  /* Everything the audio engine needs to play one walk-up, worked out ahead of time.
     settings: { walkupSeconds, duckLevel, riseSeconds } */
  function walkupPlan(player, library, settings) {
    const song = player.songId ? findSong(library, player.songId) : null;
    const intro = player.intro && player.intro.path ? player.intro : null;
    if (!song && !intro) return null;
    let songPart = null;
    if (song) {
      const start = Math.max(0, song.start || 0);
      let stop = song.stop != null && song.stop > start ? song.stop : start + settings.walkupSeconds;
      if (song.length && stop > song.length) stop = song.length;
      songPart = {
        songId: song.id,
        path: song.path,
        start,
        stop,
        fadeOut: Math.max(0, Math.min(song.fadeOut ?? 2, stop - start)),
        volume: song.volume ?? 1,
      };
    }
    const under = !!(intro && songPart && player.entry !== 'after');
    return {
      playerId: player.id,
      intro: intro ? { path: intro.path } : null,
      song: songPart,
      mode: !intro ? 'song' : !songPart ? 'intro' : under ? 'under' : 'after',
      duckLevel: under ? settings.duckLevel : 1,
      riseSeconds: settings.riseSeconds,
    };
  }

  /* ------------------------------------------------------------ files: backup and checks */

  function checkTeam(obj) {
    if (!obj || obj.format !== FORMAT_TEAM || !Array.isArray(obj.players) || !Array.isArray(obj.lineups)) {
      throw new Error('This isn’t a Diamond DJ team file.');
    }
    obj.moments = Array.isArray(obj.moments) ? obj.moments.map(newMoment) : [];
    // teams from version 1 (Phase 1) had no moments yet: give them the pre-made ones once
    if (!(obj.version >= 2)) { if (!obj.moments.length) obj.moments = defaultMoments(); obj.version = 2; }
    obj.players = obj.players.map(p => ({ ...newPlayer(p), id: String(p.id || uid('p')) }));
    obj.lineups = obj.lineups.map(l => ({
      id: String(l.id || uid('l')), name: String(l.name || 'Lineup'),
      order: Array.isArray(l.order) ? l.order.map(String) : [],
      bench: Array.isArray(l.bench) ? l.bench.map(String) : [],
      updated: Number(l.updated) || Date.now(),
    }));
    syncLineups(obj);
    return obj;
  }

  function checkLibrary(obj) {
    if (!obj || obj.format !== FORMAT_LIBRARY || !Array.isArray(obj.songs)) {
      throw new Error('This isn’t a Diamond DJ song library.');
    }
    obj.songs = obj.songs.filter(s => s && s.id && s.path).map(s => ({ ...songFromFile(s.path), ...s }));
    return obj;
  }

  /* ------------------------------------------------------------ Google Drive: what syncs and how it merges */

  /* The part of a team the organizer publishes and an update replaces: name, roster, moments.
     Lineups are separate: they belong to whoever is running the game. */
  function setupOf(team) {
    return { name: team.name, short: team.short, players: team.players, moments: team.moments };
  }
  // a short fingerprint, to tell whether a device changed the setup since it last synced
  function fingerprint(obj) {
    const s = JSON.stringify(obj);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  const setupPrint = team => fingerprint(setupOf(team));
  function libraryPrint(library, songIds) {
    const ids = [...songIds].sort();
    return fingerprint(ids.map(id => findSong(library, id)).filter(Boolean));
  }

  /* Every song a team uses: walk-ups and moments. */
  function teamSongIds(team) {
    const ids = new Set();
    for (const p of team.players) if (p.songId) ids.add(p.songId);
    for (const m of team.moments) for (const id of m.songIds) ids.add(id);
    return ids;
  }

  /* An update from Drive meets this device's copy of the team.
     - keepSetup false: roster, moments and name come from Drive; true: this device's stay.
     - lineups: Drive's lineups are added; a lineup this device changed since `lastSync` is kept as
       it is; otherwise Drive's version replaces it only if Drive's is newer; this device's own
       lineups stay.
     The result's lineups are made consistent with its roster. */
  function mergeTeam(local, remote, { lastSync = 0, keepSetup = false } = {}) {
    if (!local) return checkTeam(JSON.parse(JSON.stringify(remote)));
    const base = keepSetup ? local : remote;
    const out = JSON.parse(JSON.stringify({ ...base, id: local.id || remote.id }));
    const lineups = local.lineups.map(l => ({ ...l, order: [...l.order], bench: [...l.bench] }));
    for (const r of remote.lineups || []) {
      const i = lineups.findIndex(l => l.id === r.id);
      if (i < 0) lineups.push({ ...r, order: [...r.order], bench: [...r.bench] });
      // kept if this device changed it since the last sync; otherwise Drive's wins only if it's newer
      else if (!(lineups[i].updated > lastSync) && r.updated > lineups[i].updated) lineups[i] = { ...r, order: [...r.order], bench: [...r.bench] };
    }
    out.lineups = lineups;
    return checkTeam(out);
  }

  /* Songs from Drive's library replace this device's copy of the same song (unless keepLocal);
     songs only this device has stay. */
  function mergeLibrary(local, remote, { keepLocal = false } = {}) {
    const out = newLibrary();
    const byId = new Map();
    for (const s of remote.songs || []) byId.set(s.id, s);
    for (const s of local.songs || []) if (!byId.has(s.id) || keepLocal) byId.set(s.id, s);
    out.songs = [...byId.values()].map(s => ({ ...s }));
    return checkLibrary(out);
  }

  /* Publishing one team: Drive's library keeps every other team's songs, and gets this team's. */
  function libraryForPublish(remote, local, songIds) {
    const out = newLibrary();
    const byId = new Map((remote && remote.songs || []).map(s => [s.id, s]));
    for (const id of songIds) { const s = findSong(local, id); if (s) byId.set(id, s); }
    out.songs = [...byId.values()];
    return out;
  }

  /* Where a file on this device lives in the Drive folder, and back. */
  function drivePathFor(localPath, teamFolderName) {
    if (localPath.startsWith('Songs/')) return 'Shared Songs/' + localPath.slice(6);
    if (localPath.startsWith('Announcements/')) return `${teamFolderName}/${localPath}`;
    return null;
  }

  const api = {
    uid, newTeam, newPlayer, playerName, byNumber, playerStatus, addPlayer, removePlayer,
    newLineup, syncLineups, findLineup, duplicateLineup, addLineup, removeLineup,
    moveInOrder, moveBy, benchPlayer, unbenchPlayer,
    upNextId, nextAfter, comingUp, battingSlot,
    newLibrary, findSong, songFromFile, songLabel, songsUsing,
    walkupPlan, checkTeam, checkLibrary,
    COLORS, newMoment, defaultMoments, findMoment, removeSongEverywhere, momentsWithSong, pickSong, notePlayed, clipOf,
    setupOf, fingerprint, setupPrint, libraryPrint, teamSongIds, mergeTeam, mergeLibrary, libraryForPublish, drivePathFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== 'undefined' ? self : this);
