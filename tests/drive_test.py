"""Google Drive end to end, against tests/fake_drive.py: python3 tests/drive_test.py [outdir]

The organizer publishes the demo team from one device; a volunteer downloads it on another,
changes a lineup, and gets the organizer's next update without losing that lineup."""
import sys, os, threading, functools, http.server, socketserver, time, json, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_drive

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=ROOT))
APP = f'http://127.0.0.1:{srv.server_address[1]}/'
threading.Thread(target=srv.serve_forever, daemon=True).start()
drive, DRV = fake_drive.start()

def account(name): urllib.request.urlopen(f'{DRV}/_account?name={name}').read()
def tree(): return json.loads(urllib.request.urlopen(f'{DRV}/_tree').read())

errors, checks = [], []
def check(name, ok):
    checks.append((name, ok)); print(('PASS ' if ok else 'FAIL ') + name)

SETUP = f"""(async () => {{
  Object.assign(settings, {{ driveApi: '{DRV}/drive/v3/', driveUpload: '{DRV}/upload/drive/v3/', driveAuth: '{DRV}/auth',
    driveClient: 'test-client', driveFolder: 'ROOTFOLDER01' }});
  await saveNow();
}})()"""

def device(b, name):
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, bypass_csp=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    page.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errors.append(f'{name}: {m.text}'))
    page.goto(APP)
    page.wait_for_selector('#main .empty, .upnext')
    page.evaluate(SETUP)
    return page

def drive_box(page):
    page.click('#settingsBtn')
    page.wait_for_selector('#driveBox button')

def signin_and_wait(page, selector, timeout=20000):
    page.wait_for_selector(selector, timeout=timeout)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])

    # ------------------------------------------------------------ organizer publishes
    org = device(b, 'organizer')
    org.click('[data-act="load-demo"]'); org.wait_for_selector('.upnext')
    drive_box(org)
    check('Drive section offers the first download', 'Download from Google Drive' in org.inner_text('#driveBox'))
    account('organizer')
    org.click('#drvCheck')
    signin_and_wait(org, '#driveBox:has-text("no teams in the Drive folder")')
    check('after sign-in the app comes back and checks: no teams yet', True)
    org.click('#drvCancel')
    check('organizer sees Publish', org.is_visible('#drvPublish'))
    check('signed-in account shown', 'organizer@example.com' in org.inner_text('#driveBox'))
    org.click('#drvPublish')  # needs write permission: signs in again
    signin_and_wait(org, '#pubGo')
    text = org.inner_text('#driveBox')
    check('publish plan lists songs and announcements: ' + text.split('\n')[1][:120], '6 songs' in text and '8 announcements' in text)
    org.click('#pubGo')
    signin_and_wait(org, '#driveBox:has-text("Published")')
    t = tree()
    check('Drive has the library, songs, team file and clips',
          'library.diamond.json' in t and 'Shared Songs/Test Song 1 - Diamond DJ.mp3' in t and
          'U13 Bees/U13-Bees.diamond.json' in t and 'U13 Bees/Announcements/demo-1.mp3' in t and len([x for x in t if x.startswith('Shared Songs/')]) == 6)
    org.click('#dlgClose')

    # ------------------------------------------------------------ volunteer downloads
    vol = device(b, 'volunteer')
    drive_box(vol)
    account('volunteer')
    vol.click('#drvCheck')
    signin_and_wait(vol, '#drvGo')
    plan = vol.inner_text('#driveBox')
    check('volunteer sees the team, pre-ticked, with 14 files to download', 'U13 Burlington Bees (demo)' in plan and '14 songs' in plan)
    check('volunteer does not see Publish', not vol.is_visible('#drvPublish'))
    vol.screenshot(path=f'{OUT}/drive-plan.png')
    vol.click('#drvGo')
    signin_and_wait(vol, '#driveBox:has-text("Up to date")')
    check('team is in use on the volunteer device', vol.evaluate("team.id") == 'demo_team' and vol.evaluate("team.players.length") == 10)
    check('the empty starter team made way', vol.evaluate("Object.keys(teams).length") == 1)
    check('all 14 files stored', vol.evaluate("['Songs/Test Song 1 - Diamond DJ.mp3','Announcements/demo-8.mp3'].every(p => stored.has(p)) && stored.size") == 14)
    vol.click('#dlgClose')
    vol.click('[data-act="walkup"]'); time.sleep(1)
    check('downloaded walk-up plays', vol.evaluate("Sound.tracks.some(t => t.kind === 'intro' && t.state === 'playing')"))
    vol.click('#stopAll')
    # volunteer changes the lineup on game day
    vol.evaluate("Model.benchPlayer(lineup(), 'demo_p3'); lineup().updated = Date.now(); saveTeam()")
    time.sleep(0.5)

    # ------------------------------------------------------------ organizer changes the roster and publishes again
    org.evaluate("team.players.find(p => p.id === 'demo_p1').first = 'Liv'; team.moments[0].name = 'Homer'; saveTeam()")
    drive_box(org)
    account('organizer')
    org.click('#drvPublish')
    signin_and_wait(org, '#pubGo')
    check('second publish sends no music again', 'Drive doesn' not in org.inner_text('#driveBox'))
    org.click('#pubGo')
    signin_and_wait(org, '#driveBox:has-text("Published")')
    check('nothing duplicated in Drive', len(tree()) == len(t))

    # ------------------------------------------------------------ volunteer updates
    vol.click('#settingsBtn'); vol.wait_for_selector('#drvCheck')
    account('volunteer')
    vol.click('#drvCheck')
    signin_and_wait(vol, '#drvGo')
    check('update needs no downloads', 'already on this device' in vol.inner_text('#driveBox'))
    vol.click('#drvGo')
    signin_and_wait(vol, '#driveBox:has-text("Up to date")')
    check('roster and moments updated from Drive', vol.evaluate("player('demo_p1').first") == 'Liv' and vol.evaluate("team.moments[0].name") == 'Homer')
    check('the volunteer’s benched player stays benched', 'demo_p3' in vol.evaluate("lineup().bench"))

    # ------------------------------------------------------------ local roster edits are flagged before they're replaced
    vol.click('#dlgClose')
    vol.evaluate("player('demo_p2').first = 'Local'; saveTeam()")
    org.evaluate("team.players.find(p => p.id === 'demo_p4').first = 'Avery'; saveTeam()")
    org.click('#drvPublish'); signin_and_wait(org, '#pubGo'); org.click('#pubGo'); signin_and_wait(org, '#driveBox:has-text("Published")')
    vol.click('#settingsBtn'); vol.wait_for_selector('#drvCheck'); vol.click('#drvCheck'); signin_and_wait(vol, '#drvGo')
    check('volunteer is warned about changes on this device', vol.is_visible('[data-keep="demo_team"]'))
    vol.screenshot(path=f'{OUT}/drive-warn.png')
    vol.click('[data-keep="demo_team"]')
    vol.click('#drvGo'); signin_and_wait(vol, '#driveBox:has-text("Up to date")')
    check('keeping this device’s roster keeps the local name', vol.evaluate("player('demo_p2').first") == 'Local' and vol.evaluate("player('demo_p4').first") == 'Ava')

    # ------------------------------------------------------------ teams
    vol.click('#dlgClose')
    vol.click('#teamName'); vol.wait_for_selector('#teamNew')
    vol.click('#teamNew'); vol.fill('#askInput', 'U11 Bees'); vol.click('#askOk')
    time.sleep(0.4)
    check('new team made and in use', vol.evaluate("team.name") == 'U11 Bees' and vol.evaluate("Object.keys(teams).length") == 2)
    check('header and screen switch to the new team', vol.inner_text('#teamName').lower() == 'u11 bees' and 'No players yet' in vol.inner_text('#main'))
    vol.click('#teamName'); vol.wait_for_selector('[data-team="demo_team"]')
    vol.screenshot(path=f'{OUT}/teams.png')
    vol.click('[data-team="demo_team"]'); time.sleep(0.4)
    check('switch back keeps that team’s game state', vol.evaluate("team.id") == 'demo_team' and 'demo_p3' in vol.evaluate("lineup().bench"))
    vol.reload(); vol.wait_for_selector('.upnext')
    check('teams and the team in use survive a reload', vol.evaluate("Object.keys(teams).length") == 2 and vol.evaluate("team.id") == 'demo_team')
    b.close()

print('\nconsole/page errors:', errors or 'none')
failed = [n for n, ok in checks if not ok]
print(f'{len(checks) - len(failed)}/{len(checks)} passed')
sys.exit(1 if failed or errors else 0)
