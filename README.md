# Diamond DJ

Walk-up songs and game music for youth baseball and softball volunteers, built for an
Android tablet (phones and iPad work too). It runs in the browser, installs to the home
screen, and plays everything from the device, so no wifi is needed at the field.

First team: U13 Burlington Bees. Design spec and mockups live in the claude.ai project "Diamond DJ".

## What it does (version 0.2, Phases 1 and 2)

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
- **Key moments and breaks** on the Game screen: tap to play, tap again to fade. Each plays a random
  song (skipping ones already played this game), the next song in order, or a playlist that keeps
  going with overlapping songs (a second tap skips). Clips under 5 s, like a foul-ball horn, play
  over the music. New teams start with Home Run, Strikeout, Great Play, Walk, Rally Time, Double
  Play, Foul Ball, We Win!, Pitcher Warmup, Between Innings, Pregame and O Canada, all empty.
- **Moments** screen: create, rename, recolour, reorder and delete moments; pick songs from the
  library and their order. Songs can also be added to moments from the Songs screen.
- **Lock**: hides Roster, Songs, Moments and Settings; Game and Lineup stay open. Press and hold
  1.5 s to unlock.
- **New game** (tap twice): back to batter 1, and every song can play again.
- Phones: the Game screen splits into Walkups, Moments and Breaks tabs.
- Offline install (service worker), screen kept awake during play where supported.

Coming next: Google Drive sync and publishing for several teams (Phase 3).

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
