"""A small stand-in for Google's sign-in page and the Drive v3 API, for browser tests.

Only what Diamond DJ uses: sign-in redirect, files.get (metadata and alt=media), files.list by
parent, about, folder create, resumable upload, media update. Everything lives in memory.
The next sign-in uses the account set with  GET /_account?name=organizer|volunteer.
Organizer can edit the folder; volunteer can only view it.
"""
import hashlib, itertools, json, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode, quote

FOLDER = 'application/vnd.google-apps.folder'


class FakeDrive:
    def __init__(self):
        self.files = {}
        self.ids = itertools.count(1)
        self.sessions = {}
        self.account = 'organizer'
        self.clock = 0
        self.add('ROOTFOLDER01', 'Diamond DJ', FOLDER, None)

    def now(self):
        self.clock += 1
        return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + '.%03dZ' % (self.clock % 1000)

    def add(self, fid, name, mime, parent, data=b''):
        f = {'id': fid, 'name': name, 'mimeType': mime, 'parents': [parent] if parent else [], 'data': data,
             'modifiedTime': self.now()}
        self.files[fid] = f
        return f

    def meta(self, f, editor):
        m = {k: f[k] for k in ('id', 'name', 'mimeType', 'modifiedTime')}
        if f['mimeType'] != FOLDER:
            m['size'] = str(len(f['data']))
            m['md5Checksum'] = hashlib.md5(f['data']).hexdigest()
        m['capabilities'] = {'canAddChildren': editor}
        return m

    def children(self, parent):
        return [f for f in self.files.values() if parent in f['parents']]

    def path_of(self, f):
        parts = [f['name']]
        while f['parents'] and f['parents'][0] != 'ROOTFOLDER01':
            f = self.files[f['parents'][0]]
            parts.insert(0, f['name'])
        return '/'.join(parts)

    def tree(self):
        return sorted(self.path_of(f) for f in self.files.values() if f['id'] != 'ROOTFOLDER01')


def make_handler(drive):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def cors(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Upload-Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS')
            self.send_header('Access-Control-Expose-Headers', 'Location')

        def reply(self, code, body=b'', ctype='application/json', headers=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.cors()
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def who(self):
            m = re.match(r'Bearer tok-(\w+)', self.headers.get('Authorization', ''))
            return m.group(1) if m else None

        def body(self):
            n = int(self.headers.get('Content-Length') or 0)
            return self.rfile.read(n) if n else b''

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path == '/_account':
                drive.account = q['name']
                return self.reply(200, {'ok': True})
            if u.path == '/_tree':
                return self.reply(200, drive.tree())
            if u.path == '/auth':
                scope = q.get('scope', '')
                frag = urlencode({'access_token': 'tok-' + drive.account, 'token_type': 'Bearer', 'expires_in': 3600,
                                  'scope': scope, 'state': q.get('state', '')}, quote_via=quote)
                self.send_response(302)
                self.send_header('Location', q['redirect_uri'] + '#' + frag)
                self.end_headers()
                return
            acct = self.who()
            if not acct:
                return self.reply(401, {'error': {'status': 'UNAUTHENTICATED'}})
            editor = acct == 'organizer'
            if u.path == '/drive/v3/about':
                return self.reply(200, {'user': {'emailAddress': acct + '@example.com'}})
            if u.path == '/drive/v3/files':
                m = re.match(r"'([\w-]+)' in parents", q.get('q', ''))
                files = drive.children(m.group(1)) if m else []
                return self.reply(200, {'files': [drive.meta(f, editor) for f in files]})
            m = re.match(r'/drive/v3/files/([\w-]+)$', u.path)
            if m and m.group(1) in drive.files:
                f = drive.files[m.group(1)]
                if q.get('alt') == 'media':
                    return self.reply(200, f['data'], 'application/octet-stream')
                return self.reply(200, drive.meta(f, editor))
            return self.reply(404, {'error': {'status': 'NOT_FOUND'}})

        def write_allowed(self):
            acct = self.who()
            if not acct:
                self.reply(401, {'error': {'status': 'UNAUTHENTICATED'}})
                return False
            if acct != 'organizer':
                self.reply(403, {'error': {'errors': [{'reason': 'insufficientFilePermissions'}]}})
                return False
            return True

        def do_POST(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if not self.write_allowed():
                return
            meta = json.loads(self.body() or b'{}')
            if u.path == '/drive/v3/files':
                f = drive.add('F%d' % next(drive.ids), meta['name'], meta.get('mimeType', 'application/octet-stream'), meta['parents'][0])
                return self.reply(200, drive.meta(f, True))
            if u.path == '/upload/drive/v3/files' and q.get('uploadType') == 'resumable':
                sid = 'S%d' % next(drive.ids)
                drive.sessions[sid] = (meta, self.headers.get('X-Upload-Content-Type', 'application/octet-stream'))
                host = self.headers.get('Host')
                return self.reply(200, {}, headers={'Location': f'http://{host}/upload/session/{sid}'})
            return self.reply(400, {'error': {'status': 'BAD_REQUEST'}})

        def do_PUT(self):
            m = re.match(r'/upload/session/(\w+)$', urlparse(self.path).path)
            if not self.write_allowed() or not m:
                return
            meta, mime = drive.sessions.pop(m.group(1))
            f = drive.add('F%d' % next(drive.ids), meta['name'], mime, meta['parents'][0], self.body())
            return self.reply(200, drive.meta(f, True))

        def do_PATCH(self):
            m = re.match(r'/upload/drive/v3/files/([\w-]+)$', urlparse(self.path).path)
            if not self.write_allowed() or not m or m.group(1) not in drive.files:
                return
            f = drive.files[m.group(1)]
            f['data'] = self.body()
            f['modifiedTime'] = drive.now()
            return self.reply(200, drive.meta(f, True))

    return H


def start():
    drive = FakeDrive()
    srv = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(drive))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return drive, f'http://127.0.0.1:{srv.server_address[1]}'
