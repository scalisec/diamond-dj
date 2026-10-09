# Diamond DJ

Walk-up songs and game music for youth baseball and softball volunteers, built for an
Android tablet (phones and iPad work too). It runs in the browser, installs to the home
screen, and plays everything from the device, so no wifi is needed at the field.

First team: U13 Burlington Bees. Design spec and mockups live in the claude.ai project "Diamond DJ".

## Phase 1 (this version)

- **Game**: big "Up next" card with **Play walkup** (announcement, then the song) and **Skip**;
  the batting order auto-advances and wraps. Tap any batter to play them; press and hold to make
  them up next. **Edit order** changes the lineup without leaving the game.
- **Lineup**: saved lineups (new, duplicate, rename, delete, use for the game); drag or arrows to
  reorder; Bench and Add back.
- **Roster**: players (first, last, number, active), an announcement clip and a walk-up song each,
  song comes in under or after the announcement, **Test walkup**, readiness at a glance.
- **Songs**: add MP3s from the device, waveform with start and stop points, Play / Set start here /
  Set stop here / Hear the clip, exact seconds, fade and volume.
- **Settings** (gear): fade length, walk-up length, song volume under the announcement, New game,
  backup file (roster, lineups, cut points; not the music), demo team.
- Offline install (service worker), screen kept awake during play where supported.

Coming next: Key Moments and warmup playlists, phone tabs, Lock (Phase 2); Google Drive sync and
publishing (Phase 3).

## Try it

Any static web server works. On a computer:

```
python3 -m http.server 8000
```

Open http://localhost:8000 and tap **Load the demo team** (9 made-up players, test-tone songs and
chime announcements).

## Hosting

GitHub Pages: Settings > Pages > Deploy from a branch > `main` / root. Bump `VERSION` in `sw.js`
and `APP_VERSION` in `version.js` for every release so tablets pick up the change.

## Tests

```
node --test tests/model.test.js     # batting order, lineups, roster sync, walk-up plan
python3 tests/smoke.py [outdir]     # headless Chromium walk-through of the main flows (needs Playwright)
```

## Code

Plain HTML, CSS and JavaScript, no libraries.

| File | What it is |
| --- | --- |
| `js/model.js` | Data model and rules (pure, tested in Node) |
| `js/store.js` | IndexedDB: `kv` (team, library, game state) and `audio` (files by path) |
| `js/audio.js` | Web Audio engine: fades, ducking, the two-track walk-up, previews, waveforms |
| `js/app.js` | The screens, in sections marked with `====` banners |
| `app.css` | Bees navy and gold, light background for sun |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline install |
| `demo/` | Demo team and generated test audio |
