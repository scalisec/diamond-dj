/* Diamond DJ: the screens.
 *
 * Sections (search for the ==== banners):
 *   1. STATE AND SAVING
 *   2. HELPERS
 *   3. GAME
 *   4. LINEUP (and the order editor used on Game › Edit order)
 *   5. ROSTER
 *   6. SONGS AND THE CLIP EDITOR
 *   7. SETTINGS, DEMO, BACKUP
 *   8. NOW PLAYING
 *   9. EVENTS AND STARTUP
 *  10. KEY MOMENTS (playing them on Game, editing them on Moments)
 *  11. LOCK
 */
'use strict';

/* ==================================================================== 1. STATE AND SAVING */

const DEFAULTS = {
  fadeSeconds: 2.5,    // Fade out, and what a new sound does to the one playing
  walkupSeconds: 15,   // walk-up length when a song has no stop point
  duckLevel: 0.25,     // song volume under the announcement
  riseSeconds: 1,      // how fast the song comes up when the announcement ends
  playlistXfade: 4,    // overlap between songs in a playlist
  layerSeconds: 5,     // clips shorter than this (sound effects) play over the music
  masterVolume: 1,
  locked: false,       // Lock: hides setup screens and settings on this device
};

let team = null;        // Model team
let library = null;     // Model library
// game state on this device: lineup in use, who's up next, songs played this game, where each moment got to
let game = { lineupId: null, upNext: null, lastPlayed: null, played: [], cursors: {} };
let settings = { ...DEFAULTS };
const stored = new Set(); // paths of audio files on this device

const ui = { view: 'game', playerId: null, songId: null, lineupId: null, songQuery: '', gameTab: 'walkups', momentId: null };
const SETUP_VIEWS = ['roster', 'songs', 'moments'];

const timers = {};
function later(key, fn, ms = 300) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); }
const saveTeam = () => later('team', () => Store.set('team', team).catch(saveFailed));
const saveLibrary = () => later('library', () => Store.set('library', library).catch(saveFailed));
const saveGame = () => later('game', () => Store.set('game', game).catch(saveFailed));
const saveSettings = () => later('settings', () => Store.set('settings', settings).catch(saveFailed));
function saveFailed(e) { console.error(e); toast('Couldn’t save on this device. Check the storage space.'); }

function lineup() {
  const l = Model.findLineup(team, game.lineupId);
  if (l && game.lineupId !== l.id) game.lineupId = l.id;
  return l;
}
const player = id => team.players.find(p => p.id === id) || null;
const song = id => (id ? Model.findSong(library, id) : null);

/* ==================================================================== 2. HELPERS */

const $ = sel => document.querySelector(sel);
const main = $('#main');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function mmss(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const secs = t => (t == null ? '' : (Math.round(t * 10) / 10).toFixed(1));
function clipText(s) {
  if (!s) return '';
  const end = s.stop != null && s.stop > s.start ? s.stop : null;
  return end != null ? `${mmss(s.start)}–${mmss(end)}` : `from ${mmss(s.start)} for ${settings.walkupSeconds} s`;
}
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  later('toast', () => { t.hidden = true; }, ms);
}
const PLAY_ICON = '<svg class="play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';
const GRIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"/></svg>';
const STATUS_TEXT = { 'ready': 'Ready', 'no-intro': 'No announcement', 'no-song': 'No song', 'not-ready': 'Not ready' };

/* "Tap again to confirm" buttons: no pop-ups for volunteers. */
function armed(btn, label = 'Tap again to confirm') {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; return true; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 3500);
  return false;
}

/* The one dialog, reused for settings, pickers, the order editor and questions. */
const dlg = $('#dlg');
let dlgOnClose = null;
function openDialog(title, html, onClose = null) {
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  dlgOnClose = onClose;
  if (!dlg.open) dlg.showModal();
}
function closeDialog() { if (dlg.open) dlg.close(); }
dlg.addEventListener('close', () => { const f = dlgOnClose; dlgOnClose = null; if (f) f(); });
$('#dlgClose').addEventListener('click', closeDialog);

function askText(title, label, value, okLabel = 'Save') {
  return new Promise(resolve => {
    let answer = null;
    openDialog(title, `
      <label class="field">${esc(label)}<input type="text" id="askInput" value="${esc(value)}" autocomplete="off"></label>
      <div class="row"><button class="btn primary" id="askOk">${esc(okLabel)}</button><button class="btn" id="askCancel">Cancel</button></div>`,
      () => resolve(answer));
    const input = $('#askInput');
    input.focus(); input.select();
    const ok = () => { answer = input.value.trim(); closeDialog(); };
    $('#askOk').onclick = ok;
    input.onkeydown = e => { if (e.key === 'Enter') ok(); };
    $('#askCancel').onclick = closeDialog;
  });
}

async function storeFile(path, blob) {
  await Store.audio.put(path, blob);
  stored.add(path);
  Sound.forget(path);
}
async function dropFileIfUnused(path) {
  if (!path) return;
  const used = library.songs.some(s => s.path === path) || team.players.some(p => p.intro && p.intro.path === path);
  if (used) return;
  await Store.audio.remove(path).catch(() => {});
  stored.delete(path);
  Sound.forget(path);
}
const safeName = name => name.replace(/[\\/:*?"<>|]+/g, '_').slice(-120);

/* ==================================================================== 3. GAME */

function batterTags(l) {
  const first = Model.upNextId(l, game.upNext);
  const coming = Model.comingUp(l, game.upNext);
  const tags = new Map();
  if (first) tags.set(first, 'Up next');
  if (coming[0]) tags.set(coming[0], 'On deck');
  if (coming[1]) tags.set(coming[1], 'In the hole');
  return { first, tags };
}

function playingPlayerId() {
  const t = Sound.playing().find(t => t.kind === 'walkup' || t.kind === 'intro');
  return t && t.state === 'playing' ? t.playerId : null;
}

function renderGame() {
  const tabs = [['walkups', 'Walkups'], ['moments', 'Moments'], ['breaks', 'Breaks']]
    .map(([k, label]) => `<button data-act="game-tab" data-tab="${k}" aria-pressed="${ui.gameTab === k}">${label}</button>`).join('');
  main.innerHTML = `<div class="game-wrap" data-tab="${ui.gameTab}">
    <div class="seg phone-tabs" role="group" aria-label="Show">${tabs}</div>
    <div class="cols game-cols">
      <section class="stack" data-gtab="walkups">${walkupsHtml()}</section>
      <section class="stack">
        <div data-gtab="moments" class="stack">${padsHtml('moments')}</div>
        <div data-gtab="breaks" class="stack">${padsHtml('breaks')}</div>
      </section>
    </div></div>`;
}

function walkupsHtml() {
  const l = lineup();
  if (!team.players.length) {
    return `<div class="empty"><p><b>No players yet.</b></p><p>Add the team in Roster, or try the app with the demo team.</p>
      <div class="row" style="justify-content:center">${settings.locked ? '' : '<button class="btn primary" data-act="go" data-view="roster">Go to Roster</button><button class="btn" data-act="load-demo">Load the demo team</button>'}</div></div>`;
  }
  const { first, tags } = batterTags(l);
  const p = player(first);
  const playingId = playingPlayerId();
  const lineupOptions = team.lineups.map(x => `<option value="${esc(x.id)}" ${x.id === l.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

  const card = p ? (() => {
    const s = song(p.songId);
    const meta = s ? `${esc(Model.songLabel(s))} · ${Math.round(Model.walkupPlan(p, library, settings).song.stop - Model.walkupPlan(p, library, settings).song.start)} s clip` : '<span class="status no-song">No walk-up song</span>';
    const status = Model.playerStatus(p, library);
    return `<div class="upnext">
      <div class="who"><div class="big-num">${esc(p.number || '–')}</div>
        <div class="stack" style="gap:0">
          <span class="eyebrow">Up next · batting ${Model.battingSlot(l, p.id)}</span>
          <span class="player">${esc(Model.playerName(p))}</span>
          <span class="meta">${meta}${status === 'no-intro' ? ' · <span class="status no-intro">no announcement</span>' : ''}</span>
        </div></div>
      <div class="row"><button class="play-walkup" data-act="walkup" ${status === 'not-ready' ? 'disabled' : ''}>${PLAY_ICON}Play walkup</button>
        <button class="btn skip" data-act="skip">Skip</button></div>
      <p class="hint">Plays the announcement, then the song, and moves to the next batter.</p>
    </div>`;
  })() : `<div class="empty"><b>Nobody is in the batting order.</b><br>Add players back from the bench in Lineup.</div>`;

  const rows = l.order.map((id, i) => {
    const q = player(id);
    const s = song(q.songId);
    const status = Model.playerStatus(q, library);
    const tag = id === playingId ? 'Playing' : (tags.get(id) || '');
    return `<button class="item ${id === first ? 'sel' : ''} ${id === playingId ? 'playing' : ''} ${status === 'not-ready' ? 'not-ready' : ''}" data-act="batter" data-id="${esc(id)}">
      <span class="slot">${i + 1}</span><span class="num">${esc(q.number || '–')}</span>
      <span class="grow"><span class="name">${esc(Model.playerName(q))}</span><span class="sub">${s ? esc(Model.songLabel(s)) : `<span class="status ${status}">${STATUS_TEXT[status]}</span>`}</span></span>
      <span class="tag">${esc(tag)}</span></button>`;
  }).join('');

  return `<div class="row"><span class="section-title">Batting order</span><span class="spacer"></span>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px"><span>Lineup</span>
          <select id="gameLineup" style="height:40px;font-size:15px;width:auto">${lineupOptions}</select></label></div>
      ${card}
      <div class="row"><button class="btn" data-act="edit-order">Edit order</button><button class="btn" data-act="top">Start from batter 1</button>
        <button class="btn" data-act="new-game">New game</button></div>
      <div class="list order">${rows}</div>
      <p class="hint">Tap a player to play them · press and hold to make them up next${l.bench.length ? `<br>On the bench: ${l.bench.map(id => esc(Model.playerName(player(id)))).join(', ')}` : ''}</p>`;
}

async function playBatter(id) {
  const l = lineup();
  const p = player(id);
  if (!p) return;
  game.upNext = Model.nextAfter(l, id);
  game.lastPlayed = id;
  saveGame();
  const plan = Model.walkupPlan(p, library, settings);
  if (!plan) { toast(`${Model.playerName(p)} has no song or announcement yet.`); render(); return; }
  const label = `#${p.number} ${Model.playerName(p)}`.replace(/^# /, '');
  render();
  try {
    await Sound.walkup(plan, label, { playerId: id });
  } catch (e) {
    console.warn(e);
    toast(e && e.message === 'missing' ? `The file for ${Model.playerName(p)} isn’t on this device.` : 'That didn’t play. Try again.');
  }
}

/* ==================================================================== 4. LINEUP */

function orderEditor(l) {
  const first = Model.upNextId(l, game.upNext);
  const usedInGame = l.id === game.lineupId;
  const rows = l.order.map((id, i) => {
    const p = player(id), s = song(p.songId);
    return `<div class="edit-row ${usedInGame && id === first ? 'up' : ''}" data-id="${esc(id)}">
      <button class="handle" data-drag="${esc(id)}" aria-label="Drag to reorder ${esc(Model.playerName(p))}">${GRIP_ICON}</button>
      <span class="slot">${i + 1}</span><span class="num dark">${esc(p.number || '–')}</span>
      <span class="grow"><span class="name">${esc(Model.playerName(p))}</span><span class="sub">${s ? esc(Model.songLabel(s)) : ''}</span></span>
      <button class="btn small square" data-act="lu-up" data-id="${esc(id)}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn small square" data-act="lu-down" data-id="${esc(id)}" aria-label="Move down" ${i === l.order.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn small" data-act="lu-bench" data-id="${esc(id)}">Bench</button>
    </div>`;
  }).join('');
  const bench = l.bench.map(id => `<button class="chip" data-act="lu-unbench" data-id="${esc(id)}">#${esc(player(id).number)} ${esc(Model.playerName(player(id)))} · Add back</button>`).join('');
  return `<div class="stack order-wrap" data-lineup="${esc(l.id)}">
    <div class="list order-edit">${rows || '<p class="hint">Nobody is batting. Add players back from the bench.</p>'}</div>
    <div class="bench"><b>Bench today</b>${bench || '<span class="hint">Nobody on the bench.</span>'}</div></div>`;
}

function renderLineup() {
  const l = Model.findLineup(team, ui.lineupId || game.lineupId);
  ui.lineupId = l.id;
  const list = team.lineups.map(x => `<button class="item ${x.id === l.id ? 'sel' : ''}" data-act="lu-pick" data-id="${esc(x.id)}">
      <span class="grow"><span class="name">${esc(x.name)}</span><span class="sub">${x.order.length} batting${x.bench.length ? ` · ${x.bench.length} bench` : ''}</span></span>
      ${x.id === game.lineupId ? '<span class="pill">In use</span>' : ''}</button>`).join('');
  main.innerHTML = `<div class="cols" style="grid-template-columns:280px minmax(0,1fr)">
    <aside class="stack">
      <span class="section-title">Saved lineups</span>
      <div class="list">${list}</div>
      <div class="row"><button class="btn outline" data-act="lu-new">+ New</button><button class="btn" data-act="lu-dup">Duplicate</button></div>
      <p class="hint">Each lineup keeps its own order and bench. Duplicate one for a tournament or a doubleheader.</p>
    </aside>
    <section class="stack">
      <div class="row"><span class="lineup-title">${esc(l.name)}</span>
        ${l.id === game.lineupId ? '<span class="pill">In use on the Game screen</span>' : '<button class="btn gold" data-act="lu-use">Use for the game</button>'}
        <span class="spacer"></span>
        <button class="btn" data-act="lu-rename">Rename</button>
        <button class="btn danger" data-act="lu-delete" ${team.lineups.length < 2 ? 'disabled' : ''}>Delete</button></div>
      <p class="hint">Drag the handle to reorder, or use the arrows. Bench takes a player out for today. Changes save as you go.</p>
      ${team.players.length ? orderEditor(l) : '<div class="empty">Add players in <b>Roster</b> first.</div>'}
    </section></div>`;
}

function lineupFor(el) {
  const box = el.closest('[data-lineup]');
  return Model.findLineup(team, box ? box.dataset.lineup : ui.lineupId);
}
// redraw the rows and bench in place: the list element itself stays, so a drag in progress keeps going
function refreshOrderEditors() {
  for (const wrap of document.querySelectorAll('.order-wrap')) {
    const tmp = document.createElement('div');
    tmp.innerHTML = orderEditor(Model.findLineup(team, wrap.dataset.lineup));
    wrap.querySelector('.order-edit').innerHTML = tmp.querySelector('.order-edit').innerHTML;
    wrap.querySelector('.bench').innerHTML = tmp.querySelector('.bench').innerHTML;
  }
}

/* Drag to reorder: the list captures the pointer, and the dragged player moves to whichever
   row the finger is over. Works with mouse, finger and pen. */
let drag = null;
document.addEventListener('pointerdown', e => {
  const h = e.target.closest('[data-drag]');
  if (!h) return;
  const box = h.closest('.order-edit');
  e.preventDefault();
  drag = { id: h.dataset.drag, box, l: lineupFor(box) };
  box.setPointerCapture(e.pointerId);
  box.querySelector(`.edit-row[data-id="${CSS.escape(drag.id)}"]`).classList.add('dragging');
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const rows = [...drag.box.querySelectorAll('.edit-row')];
  const over = rows.find(r => { const b = r.getBoundingClientRect(); return e.clientY >= b.top && e.clientY <= b.bottom; });
  if (!over || over.dataset.id === drag.id) return;
  const to = drag.l.order.indexOf(over.dataset.id);
  if (Model.moveInOrder(drag.l, drag.id, to)) {
    refreshOrderEditors();
    drag.box.querySelector(`.edit-row[data-id="${CSS.escape(drag.id)}"]`).classList.add('dragging');
  }
});
function endDrag() {
  if (!drag) return;
  drag = null;
  saveTeam();
  refreshOrderEditors();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

function openOrderDialog() {
  const l = lineup();
  openDialog(`Edit order · ${l.name}`, `<p class="hint">Drag the handle or use the arrows. Changes save as you go.</p>${orderEditor(l)}`, () => render());
}

/* ==================================================================== 5. ROSTER */

function rosterList() {
  const players = [...team.players].sort(Model.byNumber);
  return players.map(p => {
    const st = Model.playerStatus(p, library);
    return `<button class="item ${p.id === ui.playerId ? 'sel' : ''}" data-act="pick-player" data-id="${esc(p.id)}">
      <span class="num">${esc(p.number || '–')}</span>
      <span class="grow"><span class="name">${esc(Model.playerName(p))}</span>${p.active ? '' : '<span class="sub">Not active</span>'}</span>
      <span class="status ${st}">${STATUS_TEXT[st]}</span></button>`;
  }).join('');
}

function renderRoster() {
  if (ui.playerId && !player(ui.playerId)) ui.playerId = null;
  if (!ui.playerId && team.players.length) ui.playerId = [...team.players].sort(Model.byNumber)[0].id;
  const p = player(ui.playerId);
  let editor = '<div class="empty"><p><b>No players yet.</b></p><p>Tap <b>+ Add player</b> to start the roster.</p></div>';
  if (p) {
    const s = song(p.songId);
    const introOk = p.intro && stored.has(p.intro.path);
    const songOk = s && stored.has(s.path);
    editor = `<section class="panel stack" style="gap:18px">
      <div class="player-head"><div class="big-num" id="phNum">${esc(p.number || '–')}</div><h2 id="phName">${esc(Model.playerName(p))}</h2>
        <span class="spacer"></span><button class="btn primary big" data-act="test-walkup" ${p.intro || s ? '' : 'disabled'}>${PLAY_ICON}Test walkup</button></div>
      <div class="grid2" style="grid-template-columns:2fr 2fr 1fr">
        <label class="field">First name<input type="text" data-pf="first" value="${esc(p.first)}" autocomplete="off"></label>
        <label class="field">Last name<input type="text" data-pf="last" value="${esc(p.last)}" autocomplete="off"></label>
        <label class="field">Number<input type="text" inputmode="numeric" data-pf="number" value="${esc(p.number)}" autocomplete="off" maxlength="3"></label>
      </div>
      <div class="slots">
        <div class="slotcard ${p.intro && !introOk ? 'missing' : ''}">
          <span class="k">1 · Announcement</span>
          ${p.intro ? `<span class="v">${esc(p.intro.name || p.intro.path.split('/').pop())}</span>${introOk ? '' : '<span class="status no-song">File not on this device</span>'}` : '<span class="v none">None yet</span><span class="hint">An audio clip like “Now batting, number 7…”</span>'}
          <div class="row">
            ${p.intro ? `<button class="btn small" data-act="listen-intro" ${introOk ? '' : 'disabled'}>Listen</button>` : ''}
            <label class="btn small file-btn">${p.intro ? 'Choose a different clip' : 'Choose a clip'}<input type="file" accept="audio/*,.mp3,.m4a,.wav" data-act="intro-file"></label>
            ${p.intro ? '<button class="btn small danger" data-act="intro-remove">Remove</button>' : ''}
          </div>
        </div>
        <div class="slotcard song ${s && !songOk ? 'missing' : ''}">
          <span class="k">2 · Walk-up song</span>
          ${s ? `<span class="v">${esc(Model.songLabel(s))}</span><span class="hint">Plays ${clipText(s)}, fades out over ${secs(s.fadeOut)} s</span>${songOk ? '' : '<span class="status no-song">File not on this device</span>'}` : '<span class="v none">None yet</span>'}
          <div class="row">
            <button class="btn small" data-act="choose-song">${s ? 'Change song' : 'Choose a song'}</button>
            ${s ? '<button class="btn small" data-act="edit-clip">Edit start and stop</button><button class="btn small danger" data-act="song-remove">Remove</button>' : ''}
          </div>
        </div>
      </div>
      <div class="band"><b>Song comes in</b>
        <div class="seg" role="group" aria-label="Song comes in">
          <button data-act="entry" data-v="under" aria-pressed="${p.entry !== 'after'}">Under the announcement</button>
          <button data-act="entry" data-v="after" aria-pressed="${p.entry === 'after'}">After it</button>
        </div>
        <span class="hint">${p.entry === 'after' ? 'The song starts when the announcement ends.' : 'The song plays quietly, then rises when the announcement ends.'}</span></div>
      <div class="row"><label class="check"><input type="checkbox" data-pf="active" ${p.active ? 'checked' : ''}>Active player</label>
        <span class="hint">Inactive players stay on the roster but sit on every bench.</span>
        <span class="spacer"></span><button class="btn danger" data-act="player-remove">Remove from team</button></div>
    </section>`;
  }
  main.innerHTML = `<div class="cols" style="grid-template-columns:340px minmax(0,1fr)">
    <aside class="stack"><span class="section-title">Roster · ${team.players.length}</span>
      <div class="list" id="rosterList">${rosterList()}</div>
      <button class="btn outline big" data-act="player-add">+ Add player</button></aside>
    ${editor}</div>`;
}

function openSongPicker(p) {
  const items = [...library.songs].sort((a, b) => a.title.localeCompare(b.title)).map(s => `
    <button class="item ${s.id === p.songId ? 'sel' : ''}" data-pick-song="${esc(s.id)}">
      <span class="grow"><span class="name">${esc(Model.songLabel(s))}</span><span class="sub">${clipText(s)}${Model.songsUsing(team, s.id).length ? ' · walk-up for ' + esc(Model.songsUsing(team, s.id).map(Model.playerName).join(', ')) : ''}</span></span></button>`).join('');
  openDialog(`Walk-up song for ${Model.playerName(p)}`, `
    <input class="search" type="search" id="pickSearch" placeholder="Search songs" autocomplete="off">
    <div class="list pick-list" id="pickList">${items || '<p class="hint">No songs on this device yet.</p>'}</div>
    <label class="btn outline file-btn">+ Add a new song file<input type="file" accept="audio/*,.mp3,.m4a,.wav" id="pickFile"></label>`, () => render());
  $('#pickSearch').oninput = e => {
    const q = e.target.value.toLowerCase();
    for (const b of document.querySelectorAll('[data-pick-song]')) b.hidden = !b.textContent.toLowerCase().includes(q);
  };
  $('#pickList').onclick = e => {
    const b = e.target.closest('[data-pick-song]');
    if (!b) return;
    p.songId = b.dataset.pickSong; saveTeam(); closeDialog();
  };
  $('#pickFile').onchange = async e => {
    const added = await addSongFiles([...e.target.files]);
    if (added[0]) { p.songId = added[0].id; saveTeam(); closeDialog(); toast('Song added. Set its start point in Songs.'); }
  };
}

/* ==================================================================== 6. SONGS AND THE CLIP EDITOR */

async function addSongFiles(files) {
  const added = [];
  let replaced = 0;
  for (const f of files) {
    if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|aac|wav|ogg)$/i.test(f.name)) continue;
    const path = `Songs/${safeName(f.name)}`;
    await storeFile(path, f);
    const length = await Sound.measure(f);
    let s = library.songs.find(x => x.path === path);
    if (s) { s.length = length; replaced++; delete peaksCache[s.id]; }
    else { s = Model.songFromFile(path, { length }); library.songs.push(s); }
    added.push(s);
  }
  saveLibrary();
  if (replaced) toast(`${replaced} song${replaced > 1 ? 's were' : ' was'} already here: the file was updated and the cut points kept.`);
  return added;
}

const peaksCache = {};
const edit = { songId: null, cursor: 0, track: null, raf: 0 };

function renderSongs() {
  if (ui.songId && !song(ui.songId)) ui.songId = null;
  if (!ui.songId && library.songs.length) ui.songId = [...library.songs].sort((a, b) => a.title.localeCompare(b.title))[0].id;
  const s = song(ui.songId);
  if (edit.songId !== ui.songId) { Sound.stopPreview(); edit.songId = ui.songId; edit.cursor = s ? s.start : 0; }
  const q = ui.songQuery.toLowerCase();
  const list = [...library.songs].sort((a, b) => a.title.localeCompare(b.title))
    .filter(x => !q || `${x.title} ${x.artist} ${Model.songsUsing(team, x.id).map(Model.playerName).join(' ')}`.toLowerCase().includes(q))
    .map(x => {
      const users = Model.songsUsing(team, x.id);
      return `<button class="item ${x.id === ui.songId ? 'sel' : ''} ${stored.has(x.path) ? '' : 'missing'}" data-act="pick-song" data-id="${esc(x.id)}">
        <span class="grow"><span class="name">${esc(Model.songLabel(x))}</span>
        <span class="sub">${stored.has(x.path) ? '' : 'File not on this device · '}${clipText(x)}${users.length ? ' · ' + esc(users.map(u => '#' + u.number + ' ' + u.first).join(', ')) : ''}</span></span></button>`;
    }).join('');

  let editor = `<div class="empty"><p><b>No songs yet.</b></p><p>Tap <b>+ Add songs from this device</b> and pick MP3 files. You can pick several at once.</p></div>`;
  if (s) {
    const users = Model.songsUsing(team, s.id);
    editor = `<section class="panel stack" style="gap:16px">
      <div class="grid2">
        <label class="field">Title<input type="text" data-sf="title" value="${esc(s.title)}" autocomplete="off"></label>
        <label class="field">Artist<input type="text" data-sf="artist" value="${esc(s.artist)}" autocomplete="off"></label>
      </div>
      <div class="wave" id="wave" aria-label="Waveform. Tap to move the play point."><canvas id="waveCanvas"></canvas><div class="loading" id="waveMsg">${stored.has(s.path) ? 'Reading the song…' : 'This song’s file isn’t on this device.'}</div></div>
      <div class="row">
        <button class="btn primary big" data-act="pv-toggle" id="pvToggle" ${stored.has(s.path) ? '' : 'disabled'}>${PLAY_ICON}<span>Play</span></button>
        <button class="btn gold big" data-act="set-start">Set start here</button>
        <button class="btn gold big" data-act="set-stop">Set stop here</button>
        <button class="btn outline big" data-act="pv-clip" ${stored.has(s.path) ? '' : 'disabled'}>Hear the clip</button>
        <span class="spacer"></span><span class="clock" id="clock">${mmss(edit.cursor)}</span>
      </div>
      <div class="grid4">
        ${stepper('Start (seconds)', 'start', secs(s.start))}
        ${stepper('Stop (seconds)', 'stop', s.stop == null ? '' : secs(s.stop), 'none')}
        ${stepper('Fade out (seconds)', 'fadeOut', secs(s.fadeOut))}
        ${stepper('Volume (%)', 'volume', Math.round((s.volume ?? 1) * 100))}
      </div>
      <p class="hint">Plays ${clipText(s)}${s.length ? ` of ${mmss(s.length)}` : ''}. ${s.stop == null ? `With no stop point a walk-up plays for ${settings.walkupSeconds} seconds.` : ''}</p>
      <div class="row"><b>Moments</b>
        ${Model.momentsWithSong(team, s.id).map(m => `<button class="chip on" data-act="sm-remove" data-id="${esc(m.id)}" aria-label="Remove from ${esc(m.name)}">${esc(m.name)} ✕</button>`).join('')}
        <button class="chip add" data-act="sm-add">+ Add to a moment</button></div>
      <div class="row" style="border-top:1px solid var(--line);padding-top:12px">
        <span class="hint">${users.length ? 'Walk-up for <b>' + esc(users.map(Model.playerName).join(', ')) + '</b>' : 'Not anyone’s walk-up yet.'}</span>
        <span class="spacer"></span>
        <label class="btn file-btn">Choose a different file<input type="file" accept="audio/*,.mp3,.m4a,.wav" data-act="song-file"></label>
        <button class="btn danger" data-act="song-delete">Delete song</button>
      </div>
    </section>`;
  }
  main.innerHTML = `<div class="cols wide-left">
    <aside class="stack">
      <input class="search" type="search" id="songSearch" placeholder="Search songs or players" value="${esc(ui.songQuery)}" autocomplete="off" aria-label="Search songs">
      <div class="list" id="songList">${list || (library.songs.length ? '<p class="hint">No songs match.</p>' : '')}</div>
      <label class="btn outline big file-btn">+ Add songs from this device<input type="file" multiple accept="audio/*,.mp3,.m4a,.wav" data-act="songs-add"></label>
      <span class="hint">${library.songs.length} song${library.songs.length === 1 ? '' : 's'} on this device</span>
    </aside>${editor}</div>`;
  if (s && stored.has(s.path)) loadWave(s);
}

function stepper(label, key, value, placeholder = '') {
  return `<label class="field">${esc(label)}<span class="stepper">
    <button type="button" data-act="step" data-k="${key}" data-d="-1" aria-label="Less">−</button>
    <input type="text" inputmode="decimal" data-sf="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}">
    <button type="button" data-act="step" data-k="${key}" data-d="1" aria-label="More">+</button></span></label>`;
}

async function loadWave(s) {
  try {
    if (!peaksCache[s.id]) peaksCache[s.id] = (await Store.get('peaks:' + s.id)) || null;
    if (!peaksCache[s.id]) {
      peaksCache[s.id] = await Sound.peaks(s.path, 600);
      if (peaksCache[s.id]) Store.set('peaks:' + s.id, peaksCache[s.id]).catch(() => {});
    }
    const pk = peaksCache[s.id];
    if (pk && !s.length) { s.length = pk.duration; saveLibrary(); }
    const msg = $('#waveMsg'); if (msg) msg.hidden = !!pk;
    drawWave();
  } catch (e) {
    console.warn(e);
    const msg = $('#waveMsg'); if (msg) msg.textContent = 'Couldn’t read this song. You can still type start and stop times.';
  }
}

function drawWave() {
  const c = $('#waveCanvas'), s = song(ui.songId);
  if (!c || !s) return;
  const pk = peaksCache[s.id];
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!pk) return;
  const dur = pk.duration || s.length || 1;
  const x = t => (t / dur) * w;
  const stop = s.stop != null && s.stop > s.start ? s.stop : Math.min(dur, s.start + settings.walkupSeconds);
  const n = pk.values.length, bw = w / n, pad = 14;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * dur;
    const v = Math.max(0.03, pk.values[i]);
    const bh = v * (h - pad * 2);
    g.fillStyle = t >= s.start && t <= stop ? '#F5B700' : '#3E5F96';
    g.fillRect(i * bw, h / 2 - bh / 2, Math.max(1, bw - 0.6), bh);
  }
  const marker = (t, text, top) => {
    g.fillStyle = '#F5B700';
    g.fillRect(x(t) - 1.5, 4, 3, h - 8);
    g.font = '700 13px Barlow, sans-serif';
    const tw = g.measureText(text).width + 14;
    const lx = Math.min(w - tw - 2, x(t) + 5);
    g.fillRect(lx, top ? 6 : h - 26, tw, 20);
    g.fillStyle = '#0B2447';
    g.fillText(text, lx + 7, top ? 21 : h - 11);
  };
  marker(s.start, `Start ${mmss(s.start)}`, true);
  marker(stop, `${s.stop == null ? 'Ends' : 'Stop'} ${mmss(stop)}`, false);
  const at = edit.track && edit.track.state !== 'done' ? edit.track.time : edit.cursor;
  g.fillStyle = '#FFFFFF';
  g.fillRect(x(at) - 1, 0, 2, h);
}

function previewTick() {
  cancelAnimationFrame(edit.raf);
  const step = () => {
    const t = edit.track;
    if (t && t.state !== 'done') edit.cursor = t.time;
    const clock = $('#clock'); if (clock) clock.textContent = mmss(edit.cursor) + '.' + Math.floor((edit.cursor % 1) * 10);
    const btn = $('#pvToggle');
    if (btn) btn.querySelector('span').textContent = t && t.state === 'playing' ? 'Pause' : 'Play';
    drawWave();
    if (t && t.state !== 'done') edit.raf = requestAnimationFrame(step);
    else edit.track = null;
  };
  step();
}

async function previewFrom(at, clip = false) {
  const s = song(ui.songId);
  if (!s) return;
  Sound.fadeAll(0.3);
  const opts = clip ? { stop: s.stop != null && s.stop > s.start ? s.stop : s.start + settings.walkupSeconds, fadeOut: s.fadeOut, level: s.volume } : { level: s.volume };
  try {
    edit.track = await Sound.preview(s.path, at, opts);
    previewTick();
  } catch (e) { toast('That song couldn’t play on this device.'); }
}

function setSongField(s, key, raw) {
  const v = parseFloat(String(raw).replace(',', '.'));
  if (key === 'stop' && (raw === '' || raw == null)) { s.stop = null; return; }
  if (!isFinite(v)) return;
  const len = s.length || peaksCache[s.id]?.duration || Infinity;
  if (key === 'start') s.start = Math.max(0, Math.min(v, len - 0.5));
  if (key === 'stop') s.stop = v <= s.start ? null : Math.min(v, len);
  if (key === 'fadeOut') s.fadeOut = Math.max(0, Math.min(10, v));
  if (key === 'volume') s.volume = Math.max(0.05, Math.min(1.5, v / 100));
  if (s.stop != null && s.stop <= s.start) s.stop = null;
}

/* ==================================================================== 7. SETTINGS, DEMO, BACKUP */

function openSettings() {
  const row = (label, key, min, max, step, fmt) => `<div class="setting"><span>${label}</span>
    <input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}" aria-label="${esc(label)}"><output data-out="${key}">${fmt(settings[key])}</output></div>`;
  openDialog('Settings', `
    <h3>Team</h3>
    <label class="field">Team name<input type="text" id="setTeamName" value="${esc(team.name)}" autocomplete="off"></label>
    <h3>Game</h3>
    <div class="row"><button class="btn" id="setNewGame">New game (start from batter 1)</button></div>
    <h3>Playback</h3>
    ${row('Fade-out length', 'fadeSeconds', 0.5, 8, 0.5, v => v + ' s')}
    ${row('Walk-up length when a song has no stop point', 'walkupSeconds', 5, 30, 1, v => v + ' s')}
    ${row('Song volume under the announcement', 'duckLevel', 0, 0.6, 0.05, v => Math.round(v * 100) + '%')}
    ${row('Song comes up after the announcement over', 'riseSeconds', 0.2, 3, 0.1, v => (+v).toFixed(1) + ' s')}
    ${row('Playlist songs overlap by', 'playlistXfade', 0, 10, 0.5, v => v + ' s')}
    <h3>Back up</h3>
    <p class="hint">Saves the roster, lineups, song names and cut points in a small file. The music isn’t in it: keep your MP3s and announcement clips too.</p>
    <div class="row"><button class="btn" id="setSave">Save a backup file</button>
      <label class="btn file-btn">Open a backup file<input type="file" accept=".json,application/json" id="setOpen"></label></div>
    <h3>Try it out</h3>
    <p class="hint">A made-up team of nine with test tones for songs and chimes for announcements. Replaces the players and lineups on this device.</p>
    <div class="row"><button class="btn" id="setDemo">Load the demo team</button></div>
    <h3>This device</h3>
    <p class="hint" id="setStorage">Checking storage…</p>
    <p class="hint">Diamond DJ ${esc(window.APP_VERSION || '')}</p>`, () => render());

  $('#setTeamName').oninput = e => { team.name = e.target.value; team.short = e.target.value; saveTeam(); $('#teamName').textContent = team.name || 'Diamond DJ'; };
  $('#setNewGame').onclick = e => { if (!armed(e.currentTarget, 'Tap again: start from batter 1')) return; newGame(); };
  for (const r of document.querySelectorAll('[data-set]')) {
    r.oninput = () => {
      const k = r.dataset.set;
      settings[k] = parseFloat(r.value);
      document.querySelector(`[data-out="${k}"]`).textContent =
        k === 'duckLevel' ? Math.round(settings[k] * 100) + '%' : k === 'riseSeconds' ? settings[k].toFixed(1) + ' s' : settings[k] + ' s';
      Sound.settings.fadeSeconds = settings.fadeSeconds;
      saveSettings();
    };
  }
  $('#setSave').onclick = saveBackup;
  $('#setOpen').onchange = e => openBackup(e.target.files[0]);
  $('#setDemo').onclick = e => { if (team.players.length && !armed(e.currentTarget, 'Tap again: replace this team')) return; loadDemo(); };
  Store.usage().then(u => {
    const el = $('#setStorage'); if (!el) return;
    el.textContent = `${stored.size} audio file${stored.size === 1 ? '' : 's'} on this device` +
      (u && u.usage ? ` · about ${(u.usage / 1e6).toFixed(0)} MB used of ${(u.quota / 1e9).toFixed(1)} GB available to the app` : '');
  });
}

function newGame() {
  const l = lineup();
  game.upNext = l.order[0] || null;
  game.lastPlayed = null;
  game.played = [];
  game.cursors = {};
  saveGame();
  toast('New game: back to batter 1, and every song can play again.');
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function saveBackup() {
  const name = (team.short || team.name || 'team').replace(/[^\w-]+/g, '-');
  download(`${name}.diamond.json`, JSON.stringify({ format: 'diamond-backup', version: 1, saved: new Date().toISOString(), team, library }, null, 1));
}

async function openBackup(file) {
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const t = Model.checkTeam(obj.team || obj);
    const lib = obj.library ? Model.checkLibrary(obj.library) : library;
    team = t; library = lib;
    game.lineupId = team.lineups[0].id; game.upNext = null;
    saveTeam(); saveLibrary(); saveGame();
    closeDialog();
    toast(`Opened ${team.name}. Songs whose files aren’t on this device are marked.`);
  } catch (e) {
    toast(e.message || 'That file couldn’t be opened.');
  }
}

async function loadDemo() {
  toast('Loading the demo team…', 10000);
  try {
    const res = await fetch('demo/demo.json');
    if (!res.ok) throw new Error('offline');
    const demo = await res.json();
    for (const f of demo.files) {
      if (stored.has(f.path)) continue;
      const r = await fetch('demo/' + f.file);
      if (!r.ok) throw new Error('offline');
      await storeFile(f.path, await r.blob());
    }
    team = Model.checkTeam(demo.team);
    library.songs = library.songs.filter(s => !demo.library.songs.some(d => d.id === s.id)).concat(Model.checkLibrary(demo.library).songs);
    game = { lineupId: team.lineups[0].id, upNext: null, lastPlayed: null, played: [], cursors: {} };
    ui.playerId = null; ui.songId = null; ui.lineupId = null;
    saveTeam(); saveLibrary(); saveGame();
    closeDialog();
    toast('Demo team loaded. Tap Play walkup to try it.');
  } catch (e) {
    console.warn(e);
    toast('The demo needs an internet connection the first time.');
  }
  render();
}

/* ==================================================================== 8. NOW PLAYING */

const KIND = { walkup: 'Walkup', intro: 'Announcement', preview: 'Preview', sound: 'Playing', playlist: 'Playlist' };
let lastPlayingSig = '';
function renderDock() {
  const all = Sound.tracks.filter(t => t.state !== 'done');
  const t = all.find(t => t.kind === 'walkup' && t.state === 'playing') || all.find(t => t.kind === 'intro')
    || all.find(t => t.state === 'playing' && t.kind !== 'preview') || all[0];
  const info = $('#dockInfo');
  if (!t) {
    if (!info.querySelector('.dock-idle')) info.innerHTML = '<span class="dock-idle">Nothing playing</span>';
  } else {
    const from = t.kind === 'preview' || t.kind === 'intro' ? 0 : t.start;
    const total = Math.max(0.1, (t.kind === 'preview' ? t.duration : t.end) - from);
    const el = Math.max(0, t.time - from);
    info.innerHTML = `<div class="np-line"><span class="np-kind">${KIND[t.kind] || 'Playing'}${t.state === 'fading' ? ' · fading' : ''}</span>
      <span class="np-name">${esc(t.label)}</span><span class="np-time">${mmss(el)} / ${mmss(total)}</span></div>
      <div class="bar"><i style="width:${Math.min(100, (el / total) * 100).toFixed(1)}%"></i></div>`;
  }
  // re-draw the game list when who's playing changes
  const sig = String(playingPlayerId()) + [...playingMomentIds()].join(',');
  if (sig !== lastPlayingSig) { lastPlayingSig = sig; if (ui.view === 'game' && !dlg.open) renderGame(); }
}

/* ==================================================================== 10. KEY MOMENTS */

const MODE_TEXT = { random: 'random', order: 'in order', playlist: 'playlist' };
let activePlaylist = null; // { momentId, ctl }

function momentSongs(m) { return m.songIds.map(song).filter(Boolean); }
function playingMomentIds() {
  return new Set(Sound.playing().filter(t => t.momentId && (t.state === 'playing' || t.state === 'loading')).map(t => t.momentId));
}

function padsHtml(section) {
  const list = team.moments.filter(m => m.section === section);
  const title = section === 'moments' ? 'Key moments' : 'Warmups &amp; breaks';
  const playing = playingMomentIds();
  const pads = list.map(m => {
    const n = momentSongs(m).length;
    const on = playing.has(m.id);
    const meta = !n ? 'No songs yet'
      : on ? (m.mode === 'playlist' ? 'Playing · tap for next song' : 'Playing · tap to fade')
      : `${n} song${n > 1 ? 's' : ''} · ${MODE_TEXT[m.mode]}`;
    return `<button class="pad ${section === 'breaks' ? 'pad-break' : 'c-' + m.color} ${on ? 'on' : ''} ${n ? '' : 'empty-pad'}" data-act="moment" data-id="${esc(m.id)}">
      <span class="pad-name">${esc(m.name)}</span><span class="pad-meta">${meta}</span></button>`;
  }).join('');
  return `<div class="row"><span class="section-title">${title}</span><span class="spacer"></span>
      ${section === 'moments' ? '<span class="hint">Tap to play · tap again to fade</span>' : ''}</div>
    ${list.length ? `<div class="pads">${pads}</div>` : `<p class="hint">None yet.${settings.locked ? '' : ' Add some in <b>Moments</b>.'}</p>`}`;
}

async function playMoment(m) {
  const playing = playingMomentIds();
  if (playing.has(m.id)) {
    // second tap: a playlist moves to its next song, anything else fades out
    if (m.mode === 'playlist' && activePlaylist && activePlaylist.momentId === m.id && activePlaylist.ctl.live) return activePlaylist.ctl.skip();
    for (const t of Sound.tracks) if (t.momentId === m.id) t.fade(settings.fadeSeconds);
    return;
  }
  if (!momentSongs(m).length) return toast(settings.locked ? `${m.name} has no songs yet.` : `${m.name} has no songs yet. Add them in Moments.`);
  const itemFor = pick => {
    const s = song(pick.songId);
    Model.notePlayed(m, library, game, s.id);
    saveGame();
    const c = Model.clipOf(s);
    return { path: c.path, start: c.start, stop: c.stop, fadeOut: c.fadeOut, level: c.volume, label: `${m.name} · ${s.title}`, momentId: m.id, clipLength: c.length };
  };
  try {
    if (m.mode === 'playlist') {
      const ctl = await Sound.playlist(() => { const pick = Model.pickSong(m, library, game); return pick ? itemFor(pick) : null; },
        { xfade: settings.playlistXfade, meta: { momentId: m.id } });
      activePlaylist = { momentId: m.id, ctl };
    } else {
      const item = itemFor(Model.pickSong(m, library, game));
      const layer = item.clipLength != null && item.clipLength < settings.layerSeconds;
      await Sound.playOne({ ...item, kind: 'sound' }, { layer });
    }
  } catch (e) {
    console.warn(e);
    toast('That song’s file isn’t on this device.');
  }
}

function momentList(section) {
  return team.moments.filter(m => m.section === section).map(m => {
    const n = momentSongs(m).length;
    return `<button class="item ${m.id === ui.momentId ? 'sel' : ''}" data-act="pick-moment" data-id="${esc(m.id)}">
      <span class="swatch ${section === 'breaks' ? 'c-light' : 'c-' + m.color}"></span>
      <span class="grow"><span class="name">${esc(m.name)}</span></span>
      <span class="sub">${n} · ${MODE_TEXT[m.mode]}</span></button>`;
  }).join('') || '<p class="hint">None yet.</p>';
}

function renderMoments() {
  if (ui.momentId && !Model.findMoment(team, ui.momentId)) ui.momentId = null;
  if (!ui.momentId && team.moments.length) ui.momentId = team.moments[0].id;
  const m = Model.findMoment(team, ui.momentId);
  let editor = '<div class="empty"><p><b>No moments yet.</b></p><p>Tap <b>+ New moment</b> to make a button for the Game screen.</p></div>';
  if (m) {
    const songs = momentSongs(m);
    const ordered = m.mode !== 'random';
    const rows = songs.map((s, i) => `<div class="edit-row">
        <span class="slot">${ordered ? i + 1 : ''}</span>
        <span class="grow"><span class="name">${esc(Model.songLabel(s))}</span><span class="sub">${stored.has(s.path) ? '' : 'File not on this device · '}${s.stop != null ? clipText(s) : 'from ' + mmss(s.start) + ' to the end'}</span></span>
        <button class="btn small" data-act="m-listen" data-id="${esc(s.id)}">Listen</button>
        ${ordered ? `<button class="btn small square" data-act="m-song-up" data-id="${esc(s.id)}" aria-label="Move earlier" ${i ? '' : 'disabled'}>↑</button>
        <button class="btn small square" data-act="m-song-down" data-id="${esc(s.id)}" aria-label="Move later" ${i < songs.length - 1 ? '' : 'disabled'}>↓</button>` : ''}
        <button class="btn small square danger" data-act="m-song-remove" data-id="${esc(s.id)}" aria-label="Remove from ${esc(m.name)}">✕</button></div>`).join('');
    const sameSection = team.moments.filter(x => x.section === m.section);
    const pos = sameSection.indexOf(m);
    const swatches = Model.COLORS.map(c => `<button class="swatch-btn c-${c}" data-act="m-color" data-v="${c}" aria-pressed="${m.color === c}" aria-label="${c}"></button>`).join('');
    editor = `<section class="panel stack" style="gap:16px">
      <div class="grid2" style="grid-template-columns:2fr 1fr">
        <label class="field">Button name<input type="text" data-mf="name" value="${esc(m.name)}" autocomplete="off"></label>
        ${m.section === 'moments' ? `<div class="field">Button colour<div class="row">${swatches}</div></div>` : '<div></div>'}
      </div>
      <div class="row"><b>Shows under</b>
        <div class="seg" role="group" aria-label="Shows under">
          <button data-act="m-section" data-v="moments" aria-pressed="${m.section === 'moments'}">Key moments</button>
          <button data-act="m-section" data-v="breaks" aria-pressed="${m.section === 'breaks'}">Warmups &amp; breaks</button></div></div>
      <div class="row"><b>When tapped, play</b>
        <div class="seg" role="group" aria-label="When tapped, play">
          <button data-act="m-mode" data-v="random" aria-pressed="${m.mode === 'random'}">A random song</button>
          <button data-act="m-mode" data-v="order" aria-pressed="${m.mode === 'order'}">The next song in order</button>
          <button data-act="m-mode" data-v="playlist" aria-pressed="${m.mode === 'playlist'}">A playlist (keeps going)</button></div></div>
      ${m.mode === 'random' ? `<label class="check"><input type="checkbox" data-mf="skipPlayed" ${m.skipPlayed ? 'checked' : ''}>Skip songs already played this game</label>` : ''}
      <p class="hint">${m.mode === 'playlist' ? `Plays the songs one after another, overlapping by ${settings.playlistXfade} s. A second tap skips to the next song; Fade out stops it.`
        : m.mode === 'order' ? 'Each tap plays the next song in the list. A second tap while it plays fades it out.'
        : 'Each tap plays a different song. A second tap while it plays fades it out.'} Songs play from their start point to their stop point, or to the end. Clips under ${settings.layerSeconds} s play over the music.</p>
      <div class="stack">
        <div class="row"><b>Songs in ${esc(m.name)} · ${songs.length}</b><span class="spacer"></span>
          <button class="btn outline" data-act="m-add-songs">+ Add songs from the library</button></div>
        <div class="list">${rows || '<p class="hint">No songs yet.</p>'}</div>
      </div>
      <div class="row" style="border-top:1px solid var(--line);padding-top:12px">
        <button class="btn" data-act="m-move" data-d="-1" ${pos > 0 ? '' : 'disabled'}>Move earlier</button>
        <button class="btn" data-act="m-move" data-d="1" ${pos < sameSection.length - 1 ? '' : 'disabled'}>Move later</button>
        <span class="spacer"></span><button class="btn danger" data-act="m-delete">Delete this moment</button></div>
    </section>`;
  }
  main.innerHTML = `<div class="cols wide-left">
    <aside class="stack">
      <span class="section-title">Key moments</span><div class="list">${momentList('moments')}</div>
      <span class="section-title" style="margin-top:8px">Warmups &amp; breaks</span><div class="list">${momentList('breaks')}</div>
      <button class="btn outline big" data-act="m-new">+ New moment or playlist</button>
    </aside>${editor}</div>`;
}

/* A list of every song with on/off toggles, for putting songs in a moment (or a song in moments). */
function openToggleList(title, items, isOn, toggle) {
  const html = () => items().map(it => `<button class="item" data-tog="${esc(it.id)}" aria-pressed="${isOn(it.id)}">
      <span class="tick" aria-hidden="true">${isOn(it.id) ? '✓' : ''}</span>
      <span class="grow"><span class="name">${esc(it.name)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</span></button>`).join('')
    || '<p class="hint">Nothing here yet.</p>';
  openDialog(title, `<input class="search" type="search" id="togSearch" placeholder="Search" autocomplete="off">
    <div class="list pick-list" id="togList">${html()}</div>`, () => render());
  const filter = () => {
    const q = $('#togSearch').value.toLowerCase();
    for (const b of document.querySelectorAll('[data-tog]')) b.hidden = !b.textContent.toLowerCase().includes(q);
  };
  $('#togSearch').oninput = filter;
  $('#togList').onclick = e => {
    const b = e.target.closest('[data-tog]');
    if (!b) return;
    toggle(b.dataset.tog);
    saveTeam();
    $('#togList').innerHTML = html();
    filter();
  };
}

function openMomentSongPicker(m) {
  openToggleList(`Songs in ${m.name}`,
    () => [...library.songs].sort((a, b) => a.title.localeCompare(b.title)).map(s => ({ id: s.id, name: Model.songLabel(s), sub: s.stop != null ? clipText(s) : '' })),
    id => m.songIds.includes(id),
    id => { m.songIds = m.songIds.includes(id) ? m.songIds.filter(x => x !== id) : [...m.songIds, id]; });
}

function openSongMomentPicker(s) {
  openToggleList(`Moments with ${s.title}`,
    () => team.moments.map(m => ({ id: m.id, name: m.name, sub: m.section === 'breaks' ? 'Warmups & breaks' : 'Key moments' })),
    id => Model.findMoment(team, id).songIds.includes(s.id),
    id => { const m = Model.findMoment(team, id); m.songIds = m.songIds.includes(s.id) ? m.songIds.filter(x => x !== s.id) : [...m.songIds, s.id]; });
}

/* ==================================================================== 11. LOCK */

function applyLock() {
  document.body.classList.toggle('locked', !!settings.locked);
  const btn = $('#lockBtn');
  btn.setAttribute('aria-pressed', String(!!settings.locked));
  btn.querySelector('span').textContent = settings.locked ? 'Hold to unlock' : 'Lock';
  btn.setAttribute('aria-label', settings.locked ? 'Locked. Press and hold to unlock.' : 'Lock the setup screens');
}

function setLocked(on) {
  settings.locked = on;
  saveSettings();
  if (on) { closeDialog(); if (SETUP_VIEWS.includes(ui.view)) ui.view = 'game'; }
  applyLock();
  render();
  toast(on ? 'Locked. Game and Lineup stay open. Press and hold the lock for a second and a half to unlock.' : 'Unlocked.');
}

(() => {
  const btn = $('#lockBtn');
  let hold = null;
  btn.addEventListener('click', () => {
    if (btn.dataset.justUnlocked) { delete btn.dataset.justUnlocked; return; } // the end of the hold, not a new tap
    if (!settings.locked) setLocked(true);
    else toast('Press and hold the lock for a second and a half to unlock.');
  });
  btn.addEventListener('pointerdown', () => {
    if (!settings.locked) return;
    btn.classList.add('holding');
    hold = setTimeout(() => { btn.classList.remove('holding'); btn.dataset.justUnlocked = '1'; setLocked(false); }, 1500);
  });
  const cancel = () => { clearTimeout(hold); btn.classList.remove('holding'); };
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('contextmenu', e => e.preventDefault());
})();

/* ==================================================================== 9. EVENTS AND STARTUP */

function render() {
  for (const b of document.querySelectorAll('.tabs [data-view]')) {
    if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#teamName').textContent = team.name || 'Diamond DJ';
  if (ui.view !== 'songs') { Sound.stopPreview(); edit.songId = null; }
  if (settings.locked && SETUP_VIEWS.includes(ui.view)) ui.view = 'game';
  ({ game: renderGame, lineup: renderLineup, roster: renderRoster, songs: renderSongs, moments: renderMoments })[ui.view]();
}

function go(view) {
  ui.view = view;
  main.scrollTop = 0;
  render();
}

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b) go(b.dataset.view);
});

// long press on a batter: make them up next without playing
let press = null;
main.addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-act="batter"]');
  if (!b) return;
  press = { id: b.dataset.id, fired: false, x: e.clientX, y: e.clientY };
  press.timer = setTimeout(() => {
    press.fired = true;
    game.upNext = press.id; saveGame();
    toast(`${Model.playerName(player(press.id))} is up next.`);
    renderGame();
  }, 650);
});
main.addEventListener('pointermove', e => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) clearTimeout(press.timer);
});
const endPress = () => { if (press) clearTimeout(press.timer); };
main.addEventListener('pointerup', endPress);
main.addEventListener('pointercancel', endPress);
main.addEventListener('contextmenu', e => { if (e.target.closest('[data-act="batter"]')) e.preventDefault(); });

async function onAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const act = b.dataset.act, id = b.dataset.id;
  Sound.unlock();
  const l = act.startsWith('lu-') ? lineupFor(b) : null;
  const p = player(ui.playerId), s = song(ui.songId);
  switch (act) {
    /* game */
    case 'walkup': return playBatter(Model.upNextId(lineup(), game.upNext));
    case 'skip': game.upNext = Model.nextAfter(lineup(), Model.upNextId(lineup(), game.upNext)); saveGame(); return render();
    case 'batter': if (press && press.fired && press.id === id) { press = null; return; } return playBatter(id);
    case 'top': game.upNext = lineup().order[0] || null; saveGame(); return render();
    case 'edit-order': return openOrderDialog();
    case 'new-game': if (!armed(b, 'Tap again: new game')) return; newGame(); return render();
    case 'game-tab': ui.gameTab = b.dataset.tab; return render();
    case 'moment': return playMoment(Model.findMoment(team, id));
    /* moments screen */
    case 'pick-moment': ui.momentId = id; return render();
    case 'm-new': {
      const name = await askText('New moment or playlist', 'Button name', '', 'Create');
      if (!name) return;
      const m = Model.newMoment({ name });
      team.moments.push(m); ui.momentId = m.id; saveTeam(); return render();
    }
    case 'm-color': case 'm-section': case 'm-mode': {
      const m = Model.findMoment(team, ui.momentId);
      m[{ 'm-color': 'color', 'm-section': 'section', 'm-mode': 'mode' }[act]] = b.dataset.v;
      if (act === 'm-section') { team.moments = team.moments.filter(x => x !== m).concat(m); } // goes to the end of its new section
      saveTeam(); return render();
    }
    case 'm-move': {
      const m = Model.findMoment(team, ui.momentId);
      const same = team.moments.filter(x => x.section === m.section);
      const other = same[same.indexOf(m) + Number(b.dataset.d)];
      if (!other) return;
      const i = team.moments.indexOf(m), j = team.moments.indexOf(other);
      [team.moments[i], team.moments[j]] = [team.moments[j], team.moments[i]];
      saveTeam(); return render();
    }
    case 'm-delete': {
      if (!armed(b, 'Tap again to delete this moment')) return;
      team.moments = team.moments.filter(x => x.id !== ui.momentId);
      ui.momentId = null; saveTeam(); return render();
    }
    case 'm-add-songs': return openMomentSongPicker(Model.findMoment(team, ui.momentId));
    case 'm-song-remove': case 'm-song-up': case 'm-song-down': {
      const m = Model.findMoment(team, ui.momentId);
      const i = m.songIds.indexOf(id);
      if (act === 'm-song-remove') m.songIds.splice(i, 1);
      else {
        const j = i + (act === 'm-song-up' ? -1 : 1);
        if (j < 0 || j >= m.songIds.length) return;
        [m.songIds[i], m.songIds[j]] = [m.songIds[j], m.songIds[i]];
      }
      saveTeam(); return render();
    }
    case 'm-listen': {
      const x = song(id), c = Model.clipOf(x);
      return Sound.playOne({ path: c.path, start: c.start, stop: c.stop, fadeOut: c.fadeOut, level: c.volume, label: `Listen · ${x.title}`, kind: 'sound' })
        .catch(() => toast('That song’s file isn’t on this device.'));
    }
    case 'sm-add': return openSongMomentPicker(s);
    case 'sm-remove': { const m = Model.findMoment(team, id); m.songIds = m.songIds.filter(x => x !== s.id); saveTeam(); return render(); }
    case 'go': return go(b.dataset.view);
    case 'load-demo': return loadDemo();
    /* lineups */
    case 'lu-up': Model.moveBy(l, id, -1); saveTeam(); return refreshOrderEditors();
    case 'lu-down': Model.moveBy(l, id, 1); saveTeam(); return refreshOrderEditors();
    case 'lu-bench': Model.benchPlayer(l, id); saveTeam(); return refreshOrderEditors();
    case 'lu-unbench': Model.unbenchPlayer(l, id); saveTeam(); return refreshOrderEditors();
    case 'lu-pick': ui.lineupId = id; return render();
    case 'lu-use': game.lineupId = ui.lineupId; game.upNext = null; saveGame(); toast('The Game screen now uses this lineup, from batter 1.'); return render();
    case 'lu-new': {
      const name = await askText('New lineup', 'Name', `Game ${team.lineups.length + 1}`, 'Create');
      if (!name) return;
      ui.lineupId = Model.addLineup(team, name).id; saveTeam(); return render();
    }
    case 'lu-dup': {
      const src = Model.findLineup(team, ui.lineupId);
      const name = await askText('Duplicate lineup', 'Name for the copy', `${src.name} copy`, 'Duplicate');
      if (!name) return;
      ui.lineupId = Model.duplicateLineup(team, src.id, name).id; saveTeam(); return render();
    }
    case 'lu-rename': {
      const cur = Model.findLineup(team, ui.lineupId);
      const name = await askText('Rename lineup', 'Name', cur.name);
      if (name) { cur.name = name; saveTeam(); }
      return render();
    }
    case 'lu-delete': {
      if (!armed(b, 'Tap again to delete')) return;
      const wasInUse = ui.lineupId === game.lineupId;
      Model.removeLineup(team, ui.lineupId);
      if (wasInUse) { game.lineupId = team.lineups[0].id; game.upNext = null; saveGame(); }
      ui.lineupId = null; saveTeam(); return render();
    }
    /* roster */
    case 'pick-player': ui.playerId = id; return render();
    case 'player-add': {
      const np = Model.addPlayer(team, { first: '', last: '', number: '' });
      ui.playerId = np.id; saveTeam(); render();
      return document.querySelector('[data-pf="first"]').focus();
    }
    case 'player-remove': {
      if (!armed(b, `Tap again to remove ${p.first || 'this player'}`)) return;
      const intro = p.intro && p.intro.path;
      Model.removePlayer(team, p.id); ui.playerId = null; saveTeam();
      await dropFileIfUnused(intro);
      return render();
    }
    case 'entry': p.entry = b.dataset.v; saveTeam(); return render();
    case 'listen-intro': return Sound.playOne({ path: p.intro.path, label: Model.playerName(p), kind: 'intro' }).catch(() => toast('That clip couldn’t play.'));
    case 'intro-remove': { const old = p.intro.path; p.intro = null; saveTeam(); await dropFileIfUnused(old); return render(); }
    case 'choose-song': return openSongPicker(p);
    case 'song-remove': p.songId = null; saveTeam(); return render();
    case 'edit-clip': ui.songId = p.songId; return go('songs');
    case 'test-walkup': {
      const plan = Model.walkupPlan(p, library, settings);
      if (plan) Sound.walkup(plan, `Test · ${Model.playerName(p)}`, { playerId: p.id }).catch(() => toast('A file for this player isn’t on this device.'));
      return;
    }
    /* songs */
    case 'pick-song': ui.songId = id; return render();
    case 'pv-toggle':
      if (edit.track && edit.track.state === 'playing') { edit.cursor = edit.track.time; Sound.stopPreview(); edit.track = null; return previewTick(); }
      return previewFrom(edit.cursor >= (s.length || Infinity) - 0.5 ? 0 : edit.cursor);
    case 'pv-clip': return previewFrom(s.start, true);
    case 'set-start': setSongField(s, 'start', edit.cursor); saveLibrary(); return refreshSongEditor();
    case 'set-stop':
      if (edit.cursor <= s.start + 0.5) return toast('The stop point has to be after the start point.');
      setSongField(s, 'stop', edit.cursor); saveLibrary(); return refreshSongEditor();
    case 'step': {
      const k = b.dataset.k, d = +b.dataset.d;
      const cur = k === 'volume' ? Math.round(s.volume * 100) : k === 'stop' ? (s.stop ?? Math.min(s.length || 1e9, s.start + settings.walkupSeconds)) : s[k];
      setSongField(s, k, cur + d * (k === 'volume' ? 10 : 0.5));
      saveLibrary(); return refreshSongEditor();
    }
    case 'song-delete': {
      const users = Model.songsUsing(team, s.id);
      if (!armed(b, users.length ? `Tap again: also removes it from ${users.length} player${users.length > 1 ? 's' : ''}` : 'Tap again to delete')) return;
      Model.removeSongEverywhere(team, s.id);
      library.songs = library.songs.filter(x => x.id !== s.id);
      delete peaksCache[s.id]; Store.remove('peaks:' + s.id).catch(() => {});
      saveLibrary(); saveTeam();
      await dropFileIfUnused(s.path);
      ui.songId = null; return render();
    }
  }
}
main.addEventListener('click', onAction);
$('#dlgBody').addEventListener('click', onAction);

function refreshSongEditor() {
  const s = song(ui.songId);
  if (!s) return;
  for (const inp of document.querySelectorAll('[data-sf]')) {
    if (inp === document.activeElement) continue;
    const k = inp.dataset.sf;
    inp.value = k === 'volume' ? Math.round(s.volume * 100) : k === 'stop' ? (s.stop == null ? '' : secs(s.stop)) : k === 'title' || k === 'artist' ? s[k] : secs(s[k]);
  }
  const hint = document.querySelector('.grid4 + .hint');
  if (hint) hint.innerHTML = `Plays ${clipText(s)}${s.length ? ` of ${mmss(s.length)}` : ''}. ${s.stop == null ? `With no stop point a walk-up plays for ${settings.walkupSeconds} seconds.` : ''}`;
  drawWave();
  const item = document.querySelector(`#songList [data-id="${CSS.escape(s.id)}"] .sub`);
  if (item) item.textContent = clipText(s);
}

// typing in fields
main.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.pf && t.type !== 'checkbox') {
    const p = player(ui.playerId);
    p[t.dataset.pf] = t.value;
    saveTeam();
    $('#phName').textContent = Model.playerName(p);
    $('#phNum').textContent = p.number || '–';
    $('#rosterList').innerHTML = rosterList();
  }
  if (t.id === 'songSearch') {
    ui.songQuery = t.value;
    const pos = t.selectionStart;
    renderSongs();
    const again = $('#songSearch'); again.focus(); again.setSelectionRange(pos, pos);
  }
  if (t.dataset.sf === 'title' || t.dataset.sf === 'artist') {
    const s = song(ui.songId); s[t.dataset.sf] = t.value; saveLibrary();
    const item = document.querySelector(`#songList [data-id="${CSS.escape(s.id)}"] .name`);
    if (item) item.textContent = Model.songLabel(s);
  }
  if (t.dataset.mf === 'name') {
    const m = Model.findMoment(team, ui.momentId); m.name = t.value; saveTeam();
    const item = document.querySelector(`[data-act="pick-moment"][data-id="${CSS.escape(m.id)}"] .name`);
    if (item) item.textContent = m.name;
  }
});

main.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'gameLineup') { game.lineupId = t.value; game.upNext = null; saveGame(); return render(); }
  if (t.dataset.mf === 'skipPlayed') { Model.findMoment(team, ui.momentId).skipPlayed = t.checked; saveTeam(); return; }
  if (t.dataset.pf === 'active') {
    const p = player(ui.playerId); p.active = t.checked; Model.syncLineups(team); saveTeam(); return render();
  }
  if (t.dataset.sf && !['title', 'artist'].includes(t.dataset.sf)) {
    const s = song(ui.songId); setSongField(s, t.dataset.sf, t.value); saveLibrary(); return refreshSongEditor();
  }
  if (t.dataset.act === 'intro-file' && t.files[0]) {
    const p = player(ui.playerId);
    const f = t.files[0];
    const old = p.intro && p.intro.path;
    const path = `Announcements/${p.id}-${safeName(f.name)}`;
    await storeFile(path, f);
    p.intro = { path, name: f.name };
    saveTeam();
    if (old && old !== path) await dropFileIfUnused(old);
    toast('Announcement added.');
    return render();
  }
  if (t.dataset.act === 'songs-add' && t.files.length) {
    toast('Adding songs…', 20000);
    const added = await addSongFiles([...t.files]);
    if (added.length) { ui.songId = added[0].id; toast(`${added.length} song${added.length > 1 ? 's' : ''} added.`); }
    else toast('Those files aren’t songs this app can play.');
    return render();
  }
  if (t.dataset.act === 'song-file' && t.files[0]) {
    const s = song(ui.songId);
    const f = t.files[0];
    const old = s.path;
    const path = `Songs/${safeName(f.name)}`;
    if (path !== old && library.songs.some(x => x.path === path)) { toast('Another song already uses that file.'); return; }
    await storeFile(path, f);
    s.path = path; s.length = await Sound.measure(f);
    delete peaksCache[s.id]; Store.remove('peaks:' + s.id).catch(() => {});
    if (s.start > s.length) s.start = 0;
    if (s.stop != null && s.stop > s.length) s.stop = null;
    saveLibrary();
    if (old !== path) await dropFileIfUnused(old);
    toast('File replaced. Check the start point.');
    return render();
  }
});

// tap or drag on the waveform moves the play point
main.addEventListener('pointerdown', e => {
  const w = e.target.closest('#wave');
  if (!w) return;
  const s = song(ui.songId), pk = s && peaksCache[s.id];
  if (!pk) return;
  const seek = ev => {
    const r = w.getBoundingClientRect();
    edit.cursor = Math.max(0, Math.min(pk.duration, ((ev.clientX - r.left) / r.width) * pk.duration));
    if (edit.track && edit.track.state === 'playing') edit.track.seek(edit.cursor);
    previewTick();
  };
  seek(e);
  w.setPointerCapture(e.pointerId);
  w.onpointermove = ev => { if (ev.buttons || ev.pointerType === 'touch') seek(ev); };
  w.onpointerup = () => { w.onpointermove = null; };
});
window.addEventListener('resize', () => later('wave', drawWave, 100));

// dock
$('#fadeAll').addEventListener('click', () => Sound.fadeAll(settings.fadeSeconds));
$('#stopAll').addEventListener('click', () => Sound.stopAll());
$('#master').addEventListener('input', e => { settings.masterVolume = +e.target.value; Sound.setMaster(settings.masterVolume); saveSettings(); });
$('#settingsBtn').addEventListener('click', openSettings);
let dockFrame = 0;
Sound.onChange(() => { if (!dockFrame) dockFrame = requestAnimationFrame(() => { dockFrame = 0; renderDock(); }); });

// keep the screen on during a game (where the browser supports it)
let wake = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

async function start() {
  Sound.setLoader(path => Store.audio.get(path));
  try {
    const [t, lib, g, st, paths] = await Promise.all([Store.get('team'), Store.get('library'), Store.get('game'), Store.get('settings'), Store.audio.paths()]);
    team = t ? Model.checkTeam(t) : Model.newTeam('U13 Burlington Bees', 'U13 Bees');
    if (t && t.version !== team.version) saveTeam(); // keep a Phase 1 team's new pre-made moments
    library = lib ? Model.checkLibrary(lib) : Model.newLibrary();
    if (g) game = { ...game, ...g };
    settings = { ...DEFAULTS, ...(st || {}) };
    paths.forEach(p => stored.add(p));
  } catch (e) {
    console.error(e);
    team = Model.newTeam('U13 Burlington Bees', 'U13 Bees');
    library = Model.newLibrary();
    toast('This browser can’t save on the device. Open the app from its web address or the home-screen icon.', 8000);
  }
  if (!Model.findLineup(team, game.lineupId)) game.lineupId = team.lineups[0].id;
  Sound.settings.fadeSeconds = settings.fadeSeconds;
  Sound.setMaster(settings.masterVolume);
  $('#master').value = settings.masterVolume;
  applyLock();
  render();
  renderDock();
  keepAwake();
  Store.persist();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline copy not installed', e));
  }
}
start();
