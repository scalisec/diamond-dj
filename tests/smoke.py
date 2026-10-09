"""Browser smoke test: python3 tests/smoke.py [outdir]
Serves the app on localhost, loads the demo team and walks through the main flows in headless Chromium."""
import sys, threading, functools, http.server, socketserver, os, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
Handler = functools.partial(Quiet, directory=ROOT)
srv = socketserver.TCPServer(('127.0.0.1', 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

errors, checks = [], []
def check(name, ok):
    checks.append((name, ok)); print(('PASS ' if ok else 'FAIL ') + name)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(f'http://127.0.0.1:{port}/index.html')
    page.wait_for_selector('.empty')
    check('empty team shows the Roster prompt', 'No players yet' in page.inner_text('#main'))

    page.click('[data-act="load-demo"]')
    page.wait_for_selector('.upnext', timeout=15000)
    check('demo loads with Olivia up next', 'Olivia Brooks' in page.inner_text('.upnext'))
    page.screenshot(path=f'{OUT}/game-tablet.png')

    page.click('[data-act="walkup"]')
    page.wait_for_function("document.querySelector('#dockInfo').innerText.includes('Olivia')", timeout=8000)
    check('walk-up plays (now playing shows Olivia)', True)
    check('card auto-advanced to Mia', 'Mia Chen' in page.inner_text('.upnext'))
    time.sleep(1.2)
    kinds = page.evaluate("Sound.tracks.map(t => t.kind + ':' + t.state + ':' + t.level.toFixed(2))")
    check('announcement and ducked song play together: ' + ', '.join(kinds),
          any(k.startswith('intro:playing') for k in kinds) and any(k.startswith('walkup:playing:0.25') for k in kinds))
    time.sleep(3.2)
    lvl = page.evaluate("(Sound.tracks.find(t => t.kind === 'walkup') || {}).level")
    check(f'song rises after the announcement (level {lvl})', lvl == 1)
    page.screenshot(path=f'{OUT}/game-playing.png')

    page.click('[data-act="skip"]')
    check('Skip moves to Zoe', 'Zoe Laurent' in page.inner_text('.upnext'))
    page.click('[data-act="batter"][data-id="demo_p1"]')
    time.sleep(0.5)
    check('tapping a batter plays them and Mia is up next', 'Mia Chen' in page.inner_text('.upnext'))
    page.click('#fadeAll'); time.sleep(3)
    check('Fade out empties the player', page.evaluate("Sound.tracks.length") == 0)

    # long press makes a batter up next
    row = page.locator('[data-act="batter"][data-id="demo_p6"]')
    row.scroll_into_view_if_needed(); bx = row.bounding_box()
    page.mouse.move(bx['x'] + 40, bx['y'] + 20); page.mouse.down(); time.sleep(0.9); page.mouse.up()
    time.sleep(0.3)
    check('long press sets Lily up next without playing', 'Lily Okafor' in page.inner_text('.upnext') and page.evaluate("Sound.tracks.length") == 0)

    # Edit order dialog: move and bench
    page.click('[data-act="edit-order"]')
    page.click('#dlg [data-act="lu-down"][data-id="demo_p1"]')
    order = page.evaluate("Model.findLineup(team, game.lineupId).order.slice(0,2)")
    check('arrow moves Olivia down to 2nd', order == ['demo_p2', 'demo_p1'])
    page.click('#dlg [data-act="lu-bench"][data-id="demo_p9"]')
    check('bench from the game dialog', 'demo_p9' in page.evaluate("Model.findLineup(team, game.lineupId).bench"))
    page.click('#dlg [data-act="lu-unbench"][data-id="demo_p9"]')
    check('add back from the bench', page.evaluate("Model.findLineup(team, game.lineupId).order.at(-1)") == 'demo_p9')
    # drag Chloe (last) to the top
    h = page.locator('#dlg [data-drag="demo_p9"]').bounding_box()
    top = page.locator('#dlg .edit-row').first.bounding_box()
    page.mouse.move(h['x'] + 10, h['y'] + 10); page.mouse.down()
    for y in range(int(h['y']), int(top['y']) + 5, -12): page.mouse.move(h['x'] + 10, y)
    page.mouse.up()
    check('drag moves Chloe to the top', page.evaluate("Model.findLineup(team, game.lineupId).order[0]") == 'demo_p9')
    page.screenshot(path=f'{OUT}/edit-order.png')
    page.click('#dlgClose')

    # Lineup screen: duplicate and switch
    page.click('.tabs [data-view="lineup"]')
    page.click('[data-act="lu-dup"]'); page.fill('#askInput', 'Doubleheader'); page.click('#askOk')
    page.wait_for_selector('.lineup-title:has-text("Doubleheader")')
    check('duplicate lineup', 'Doubleheader' in page.inner_text('#main'))
    page.click('[data-act="lu-use"]')
    check('use the duplicate for the game', page.evaluate("Model.findLineup(team, game.lineupId).name") == 'Doubleheader')
    page.screenshot(path=f'{OUT}/lineup.png')

    # Roster: add a player, type a name
    page.click('.tabs [data-view="roster"]')
    page.click('[data-act="player-add"]')
    page.fill('[data-pf="first"]', 'Nora'); page.fill('[data-pf="last"]', 'Patel'); page.fill('[data-pf="number"]', '6')
    check('new player shows in the roster list', 'Nora Patel' in page.inner_text('#rosterList'))
    check('new player bats last in every lineup', all(page.evaluate("team.lineups.map(l => l.order.at(-1) === ui.playerId)")))
    page.click('[data-act="pick-player"][data-id="demo_p4"]')
    page.screenshot(path=f'{OUT}/roster.png')

    # Songs: waveform, set start
    page.click('[data-act="edit-clip"]')
    page.wait_for_function("document.querySelector('#waveMsg') && document.querySelector('#waveMsg').hidden", timeout=10000)
    check('waveform drawn', True)
    page.fill('[data-sf="start"]', '18.5'); page.press('[data-sf="start"]', 'Tab')
    check('typing a start point saves it', page.evaluate("Model.findSong(library, ui.songId).start") == 18.5)
    page.click('[data-act="step"][data-k="stop"][data-d="1"]')
    check('stepper nudges stop by 0.5 s', page.evaluate("Model.findSong(library, ui.songId).stop") == 35.5)
    page.click('[data-act="pv-clip"]'); time.sleep(0.8)
    check('Hear the clip plays from the start point', page.evaluate("Sound.tracks.some(t => t.kind === 'preview' && t.time >= 18.5)"))
    page.screenshot(path=f'{OUT}/songs.png')

    # ---------------------------------------------------------------- Phase 2: key moments
    page.click('#stopAll')
    page.click('.tabs [data-view="game"]')
    page.wait_for_selector('.pad')
    check('game shows 8 key moments and 4 breaks', page.locator('.pad').count() == 12)
    page.click('.pad[data-id="demo_m1"]'); time.sleep(0.8)
    check('Home Run plays', page.evaluate("Sound.tracks.some(t => t.momentId === 'demo_m1' && t.state === 'playing')"))
    check('the Home Run pad shows it is playing', 'on' in page.get_attribute('.pad[data-id="demo_m1"]', 'class'))
    page.click('.pad[data-id="demo_m7"]'); time.sleep(0.6)
    check('Foul Ball (2 s clip) plays over the music, Home Run keeps going',
          page.evaluate("Sound.tracks.some(t => t.momentId === 'demo_m7') && Sound.tracks.some(t => t.momentId === 'demo_m1' && t.state === 'playing')"))
    page.click('.pad[data-id="demo_m1"]'); time.sleep(0.3)
    check('second tap fades Home Run', page.evaluate("Sound.tracks.filter(t => t.momentId === 'demo_m1').every(t => t.state === 'fading' || t.state === 'done')"))
    page.click('.pad[data-id="demo_m1"]'); time.sleep(0.6)
    played = page.evaluate("game.played")
    check(f'random skips the song already played ({played})', len(set(played) & {'demo_s1', 'demo_s2'}) == 2)
    page.click('.pad[data-id="demo_m9"]'); time.sleep(0.8)
    first = page.evaluate("Sound.tracks.find(t => t.kind === 'playlist' && t.state === 'playing').label")
    check('Pitcher Warmup playlist starts (and fades Home Run)', first.startswith('Pitcher Warmup') and
          page.evaluate("Sound.tracks.filter(t => t.momentId === 'demo_m1').every(t => t.state !== 'playing')"))
    page.click('.pad[data-id="demo_m9"]'); time.sleep(0.8)
    second = page.evaluate("Sound.tracks.find(t => t.kind === 'playlist' && t.state === 'playing').label")
    check(f'second tap skips to the next song ({first} -> {second})', first != second)
    page.screenshot(path=f'{OUT}/game-moments.png')
    page.click('.pad[data-id="demo_m4"]')
    check('an empty moment explains itself', 'no songs yet' in page.inner_text('#toast').lower())
    page.click('#fadeAll'); time.sleep(3)
    check('Fade out stops the playlist', page.evaluate("Sound.tracks.length") == 0)
    page.click('[data-act="new-game"]'); page.click('[data-act="new-game"]')
    check('New game clears the played songs', page.evaluate("game.played.length") == 0)

    # Moments screen
    page.click('.tabs [data-view="moments"]')
    page.click('[data-act="pick-moment"][data-id="demo_m4"]')
    page.click('[data-act="m-add-songs"]')
    page.click('#togList [data-tog="demo_s2"]'); page.click('#togList [data-tog="demo_s4"]')
    page.click('#dlgClose')
    check('songs added to Walk', page.evaluate("Model.findMoment(team, 'demo_m4').songIds") == ['demo_s2', 'demo_s4'])
    page.click('[data-act="m-mode"][data-v="order"]')
    page.click('[data-act="m-song-down"][data-id="demo_s2"]')
    check('reorder songs in an in-order moment', page.evaluate("Model.findMoment(team, 'demo_m4').songIds") == ['demo_s4', 'demo_s2'])
    page.fill('[data-mf="name"]', 'Ball Four')
    page.click('[data-act="m-color"][data-v="gold"]')
    check('rename and recolour', page.evaluate("[Model.findMoment(team, 'demo_m4').name, Model.findMoment(team, 'demo_m4').color].join()") == 'Ball Four,gold')
    page.click('[data-act="m-move"][data-d="-1"]')
    check('move a moment earlier', page.evaluate("team.moments.findIndex(m => m.id === 'demo_m4')") == 2)
    page.screenshot(path=f'{OUT}/moments.png')
    page.click('[data-act="m-new"]'); page.fill('#askInput', 'Pitching Change'); page.click('#askOk')
    page.wait_for_selector('[data-mf="name"][value="Pitching Change"]')
    check('create a moment', page.evaluate("team.moments.some(m => m.name === 'Pitching Change')"))
    page.click('[data-act="m-delete"]'); page.click('[data-act="m-delete"]')
    check('delete a moment (tap twice)', not page.evaluate("team.moments.some(m => m.name === 'Pitching Change')"))

    # Songs editor: moments chips
    page.click('.tabs [data-view="songs"]')
    page.click('[data-act="pick-song"][data-id="demo_s3"]')
    page.click('[data-act="sm-add"]'); page.click('#togList [data-tog="demo_m8"]'); page.click('#dlgClose')
    check('add a song to a moment from Songs', 'demo_s3' in page.evaluate("Model.findMoment(team, 'demo_m8').songIds"))
    page.click('[data-act="sm-remove"][data-id="demo_m8"]')
    check('remove it again with the chip', 'demo_s3' not in page.evaluate("Model.findMoment(team, 'demo_m8').songIds"))

    # Lock
    page.click('#lockBtn')
    check('Lock goes to Game and hides setup and settings',
          page.evaluate("ui.view") == 'game' and not page.is_visible('.setup-group') and not page.is_visible('#settingsBtn') and page.is_visible('[data-view="lineup"]'))
    page.click('.tabs [data-view="lineup"]')
    check('Lineup still works when locked', page.evaluate("ui.view") == 'lineup')
    page.click('#lockBtn'); time.sleep(0.3)
    check('a quick tap does not unlock', page.evaluate("settings.locked") is True)
    lb = page.locator('#lockBtn').bounding_box()
    page.mouse.move(lb['x'] + 10, lb['y'] + 10); page.mouse.down(); time.sleep(1.7); page.mouse.up()
    check('press and hold unlocks', page.evaluate("settings.locked") is False and page.is_visible('.setup-group'))
    page.click('#lockBtn')  # leave it locked to check it survives a reload

    # reload: everything persisted
    time.sleep(0.6)
    page.reload(); page.wait_for_selector('.upnext')
    check('lineup choice and players survive a reload',
          page.evaluate("Model.findLineup(team, game.lineupId).name") == 'Doubleheader' and page.evaluate("team.players.length") == 11)
    check('lock and moment edits survive a reload',
          page.evaluate("settings.locked") is True and page.evaluate("Model.findMoment(team, 'demo_m4').name") == 'Ball Four')
    page.screenshot(path=f'{OUT}/game-locked.png')

    # phone
    ph = ctx.new_page(); ph.set_viewport_size({'width': 390, 'height': 844})
    ph.on('pageerror', lambda e: errors.append(str(e)))
    ph.goto(f'http://127.0.0.1:{port}/index.html'); ph.wait_for_selector('.upnext')
    check('phone: no sideways scrolling', ph.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
    ph.screenshot(path=f'{OUT}/game-phone.png', full_page=True)
    check('phone: only the Walkups tab shows at first', ph.is_visible('.upnext') and not ph.is_visible('.pad'))
    ph.evaluate("setLocked(false)"); time.sleep(0.6)
    ph.reload(); ph.wait_for_selector('.upnext')
    # P1: next three batters, Show all, one-row dock
    check('phone game: next 3 batters under the card', ph.locator('.order .item').count() == 3)
    ph.click('[data-act="show-batters"]')
    check('phone game: Show all lists every batter', ph.locator('.order .item').count() == ph.evaluate("lineup().order.length"))
    ph.click('[data-act="show-batters"]')
    dock_h = ph.evaluate("Math.round(document.querySelector('.dock').getBoundingClientRect().height)")
    check(f'phone: now-playing bar is one row ({dock_h}px)', dock_h <= 72)
    # P2: lineup dropdown, menu, rows without arrows
    ph.click('.tabs [data-view="lineup"]')
    check('phone lineup: dropdown and menu instead of the side list', ph.is_visible('#luSelect') and ph.is_visible('[data-act="lu-menu"]') and not ph.is_visible('[data-act="lu-pick"]'))
    check('phone lineup: no arrow buttons, Bench stays', not ph.is_visible('[data-act="lu-up"]') and ph.locator('[data-act="lu-bench"]').first.is_visible())
    ph.select_option('#luSelect', label='Tournament')
    check('phone lineup: dropdown switches lineup', ph.evaluate("Model.findLineup(team, ui.lineupId).name") == 'Tournament')
    ph.click('[data-act="lu-menu"]')
    check('phone lineup: menu opens full screen', ph.evaluate("Math.round(document.querySelector('#dlg').getBoundingClientRect().width)") == 390)
    ph.click('#dlg [data-menu="2"]'); ph.fill('#askInput', 'Tourney'); ph.click('#askOk'); time.sleep(0.3)
    check('phone lineup: Rename from the menu', ph.evaluate("Model.findLineup(team, ui.lineupId).name") == 'Tourney')
    ph.screenshot(path=f'{OUT}/p2-lineup.png')
    # P4/P5: roster list, then the player full screen, then back
    ph.click('.tabs [data-view="roster"]')
    check('phone roster: list only', ph.is_visible('#rosterList') and not ph.is_visible('[data-pf="first"]'))
    ph.screenshot(path=f'{OUT}/p4-roster.png')
    ph.click('[data-act="pick-player"][data-id="demo_p4"]')
    check('phone roster: player opens full screen with Back', ph.is_visible('[data-pf="first"]') and ph.is_visible('.back-btn') and not ph.is_visible('#rosterList'))
    check('phone roster: Test walkup pinned at the bottom', ph.is_visible('.phone-sticky [data-act="test-walkup"]'))
    ph.screenshot(path=f'{OUT}/p5-player.png')
    ph.click('.back-btn')
    check('phone roster: Back returns to the list', ph.is_visible('#rosterList'))
    # P6: songs list, clip editor
    ph.click('.tabs [data-view="songs"]')
    ph.click('[data-act="pick-song"][data-id="demo_s1"]')
    ph.wait_for_function("document.querySelector('#waveMsg') && document.querySelector('#waveMsg').hidden", timeout=10000)
    grid = ph.evaluate("getComputedStyle(document.querySelector('.clip-btns')).gridTemplateColumns.split(' ').length")
    check(f'phone clip editor: buttons in a 2 x 2 grid ({grid} columns), time on the waveform', grid == 2 and ph.is_visible('#waveClock') and not ph.is_visible('#clock'))
    check('phone clip editor: file actions in the menu', ph.is_visible('[data-act="song-menu"]') and not ph.is_visible('[data-act="song-delete"]'))
    ph.screenshot(path=f'{OUT}/p6-song.png')
    ph.click('.back-btn')
    # moments: same pattern
    ph.click('.tabs [data-view="moments"]')
    check('phone moments: list only', ph.is_visible('[data-act="pick-moment"]') and not ph.is_visible('[data-mf="name"]'))
    ph.click('[data-act="pick-moment"][data-id="demo_m1"]')
    check('phone moments: one moment full screen', ph.is_visible('[data-mf="name"]') and not ph.is_visible('[data-act="pick-moment"]'))
    # P7: settings sheet
    ph.click('#settingsBtn'); time.sleep(0.3)
    check('phone settings: full-screen sheet', ph.evaluate("Math.round(document.querySelector('#dlg').getBoundingClientRect().height)") == 844)
    ph.screenshot(path=f'{OUT}/p7-settings.png')
    ph.click('#dlgClose')
    check('phone: no sideways scrolling anywhere', ph.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
    ph.click('.tabs [data-view="game"]')
    ph.click('[data-act="edit-order"]'); time.sleep(0.3)
    ph.screenshot(path=f'{OUT}/p3-editorder.png')
    ph.click('#dlgClose')
    ph.click('.phone-tabs [data-tab="moments"]')
    check('phone: Moments tab shows the pads', ph.is_visible('.pad[data-id="demo_m1"]') and not ph.is_visible('.upnext'))
    ph.screenshot(path=f'{OUT}/moments-phone.png')
    b.close()

print('\nconsole/page errors:', errors or 'none')
failed = [n for n, ok in checks if not ok]
print(f'{len(checks) - len(failed)}/{len(checks)} passed')
sys.exit(1 if failed or errors else 0)
