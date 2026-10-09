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
    bx = row.bounding_box()
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

    # reload: everything persisted
    time.sleep(0.6)
    page.reload(); page.wait_for_selector('.upnext')
    check('lineup choice and players survive a reload',
          page.evaluate("Model.findLineup(team, game.lineupId).name") == 'Doubleheader' and page.evaluate("team.players.length") == 11)

    # phone
    ph = ctx.new_page(); ph.set_viewport_size({'width': 390, 'height': 844})
    ph.on('pageerror', lambda e: errors.append(str(e)))
    ph.goto(f'http://127.0.0.1:{port}/index.html'); ph.wait_for_selector('.upnext')
    check('phone: no sideways scrolling', ph.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
    ph.screenshot(path=f'{OUT}/game-phone.png', full_page=True)
    b.close()

print('\nconsole/page errors:', errors or 'none')
failed = [n for n, ok in checks if not ok]
print(f'{len(checks) - len(failed)}/{len(checks)} passed')
sys.exit(1 if failed or errors else 0)
