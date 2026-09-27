"""The landing Worker (deploy/static/worker.js) routes requests the way
deploy/static/README.md says: pages and their files from assets, crawlers
on /join to the game server with a fallback, everything else proxied, and
its own copies proxied instead when its freshness check finds them stale.

Runs the Worker module in node with a fake ASSETS binding and fetch."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
WORKER = REPO / "deploy" / "static" / "worker.js"

HARNESS = r"""
const mod = await import(process.argv[1]);
const worker = mod.default;
const env = {
  ORIGIN: 'https://game.example',
  // Pages carry the static preview block's host placeholder. The freshness
  // check's own-build-id fetch gets plain text here (not JSON), so it comes
  // back inconclusive and the verdict stays 'unknown' — same as before this
  // Worker had a freshness check at all.
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      const og = p === '/join.html' ? ' <meta property="og:url" content="https://__KN_HOST__/join" />' : '';
      return new Response('asset:' + p + (p.endsWith('.html') ? ' og=https://__KN_HOST__/og' + og : ''), { status: 200 });
    },
  },
};
let originUp = process.argv[2] === 'up';
globalThis.fetch = async (req, init) => {
  const url = typeof req === 'string' || req instanceof URL ? String(req) : req.url;
  if (!originUp) throw new Error('napping');
  // The game server builds absolute URLs from the host it was asked on.
  // Only HTML responses get the public-host rewrite; everything else
  // (scripts, the board JSON, the socket handshake) must reach the visitor
  // exactly as the origin sent it.
  const u = new URL(url);
  const isHtml = u.pathname.endsWith('.html') || u.pathname === '/' || u.pathname === '/join';
  return new Response('origin:' + u.pathname + u.search + ' og=https://game.example/card', {
    status: 200,
    headers: { 'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream' },
  });
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const cases = [
  ['/', 'GET', ''],
  ['/index.html', 'GET', ''],
  ['/join?room=ABC', 'GET', ''],
  ['/join?room=ABC', 'GET', 'Discordbot/2.0'],
  ['/join?room=abc%22%3E%3Cx&spectate=1', 'GET', 'Discordbot/2.0'],
  ['/join?room=Case30X&spectate=1', 'GET', 'Discordbot/2.0'],
  ['/join?room=ABC', 'POST', ''],
  ['/static/landing.js', 'GET', ''],
  ['/static/fonts/ibm-plex-sans-var-latin.woff2', 'GET', ''],
  ['/static/play.js', 'GET', ''],
  ['/static/version.json', 'GET', ''],
  ['/static/changelog.json', 'GET', ''],
  ['/play.html?room=ABC', 'GET', ''],
  ['/list', 'GET', ''],
  ['/socket.io/?EIO=4', 'GET', ''],
];
const out = [];
for (const [path, method, ua] of cases) {
  let res;
  try {
    res = await worker.fetch(
      new Request('https://kn.example' + path, { method, headers: ua ? { 'User-Agent': ua } : {} }),
      env,
      ctx,
    );
  } catch (e) {
    out.push({ path, method, ua, body: 'error:' + e.message });
    continue;
  }
  out.push({
    path, method, ua,
    body: await res.text(),
    csp: res.headers.get('Content-Security-Policy'),
    cache: res.headers.get('Cache-Control'),
  });
}
await Promise.all(waits);
console.log(JSON.stringify(out));
"""


def _run(origin_up: bool):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", HARNESS, WORKER.as_uri(), "up" if origin_up else "down"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    return {(c["path"], c["method"], c["ua"]): c for c in json.loads(res.stdout)}


def _body(r, path, method="GET", ua=""):
    return r[(path, method, ua)]["body"]


def test_pages_and_their_files_come_from_assets():
    r = _run(origin_up=True)
    assert _body(r, "/").startswith("asset:/index.html")
    assert _body(r, "/index.html").startswith("asset:/index.html")
    assert _body(r, "/join?room=ABC").startswith("asset:/join.html")
    for page in ["/", "/join?room=ABC"]:
        assert "script-src 'self'" in r[(page, "GET", "")]["csp"]
        assert r[(page, "GET", "")]["cache"] == "no-store"
        # The static preview tags get the public host.
        assert " og=https://kn.example/og" in _body(r, page)
    assert _body(r, "/static/landing.js") == "asset:/static/landing.js"
    assert r[("/static/landing.js", "GET", "")]["cache"] == "no-cache"
    assert _body(r, "/static/fonts/ibm-plex-sans-var-latin.woff2").startswith("asset:")


def test_version_and_changelog_prefer_origin_and_fall_back_to_assets():
    """Release metadata is current when Render is up and instant when down."""
    r = _run(origin_up=True)
    assert _body(r, "/static/version.json") == "origin:/static/version.json og=https://game.example/card"
    assert _body(r, "/static/changelog.json") == "origin:/static/changelog.json og=https://game.example/card"
    down = _run(origin_up=False)
    assert _body(down, "/static/version.json") == "asset:/static/version.json"
    assert _body(down, "/static/changelog.json") == "asset:/static/changelog.json"


def test_everything_else_goes_to_the_game_server_untouched():
    r = _run(origin_up=True)
    for path, method in [
        ("/static/play.js", "GET"),
        ("/list", "GET"),
        ("/socket.io/?EIO=4", "GET"),
    ]:
        assert _body(r, path, method) == f"origin:{path} og=https://game.example/card"
    # /play.html (any method) is HTML, so its body gets the same host
    # rewrite as the crawler preview: a shared link must not advertise the
    # origin's own (Render) hostname. A POST to /join isn't
    # routed as the static page (only GET/HEAD are), so it's proxied here
    # too, and it's HTML as well.
    assert _body(r, "/play.html?room=ABC") == "origin:/play.html?room=ABC og=https://kn.example/card"
    assert _body(r, "/join?room=ABC", "POST") == "origin:/join?room=ABC og=https://kn.example/card"


def test_crawlers_get_the_room_preview_on_the_public_host_or_the_static_page():
    up = _run(origin_up=True)
    crawler = ("/join?room=ABC", "GET", "Discordbot/2.0")
    # The origin's hostname in the preview is rewritten to the public one.
    assert _body(up, *crawler) == "origin:/join?room=ABC og=https://kn.example/card"
    assert "script-src 'self'" in up[crawler]["csp"]
    down = _run(origin_up=False)
    # The static fallback keeps the invite in its canonical link.
    fallback = _body(down, *crawler)
    assert fallback.startswith("asset:/join.html og=https://kn.example/og")
    assert 'content="https://kn.example/join?room=ABC"' in fallback
    # Room IDs are case-sensitive: kept exactly as they are.
    mixed = _body(down, "/join?room=Case30X&spectate=1", "GET", "Discordbot/2.0")
    assert 'content="https://kn.example/join?room=Case30X&amp;spectate=1"' in mixed
    # A room ID that doesn't fit the server's pattern is left out, never echoed.
    odd = _body(down, "/join?room=abc%22%3E%3Cx&spectate=1", "GET", "Discordbot/2.0")
    assert 'content="https://kn.example/join"' in odd
    assert "<x" not in odd and "abc" not in odd


def test_build_lists_exactly_the_files_the_pages_load():
    res = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")], capture_output=True, text=True, timeout=60
    )
    assert res.returncode == 0, res.stderr + res.stdout
    dist = REPO / "dist-landing"
    assert (dist / "index.html").is_file() and (dist / "join.html").is_file()
    assert (dist / "static" / "join.js").is_file()
    assert (dist / "static" / "og" / "home.png").is_file()  # the static pages' og:image
    assert (dist / "static" / "version.json").is_file()
    assert (dist / "static" / "changelog.json").is_file()
    assert not (dist / "static" / "play.js").exists()
    build_json = dist / "static" / "landing-build.json"
    assert build_json.is_file()
    body = json.loads(build_json.read_text())
    assert isinstance(body.get("id"), str) and len(body["id"]) == 16


def _wrangler():
    """A local wrangler: $WRANGLER, else the repo's node_modules (npm install)."""
    import os

    for cand in (os.environ.get("WRANGLER"), str(REPO / "node_modules" / ".bin" / "wrangler")):
        if cand and Path(cand).is_file():
            return cand
    return None


def test_real_runtime_serves_the_pages_without_redirects():
    """Cloudflare's asset layer redirects /index.html and /join.html by default,
    which the fake ASSETS above can't show; run the real local runtime."""
    import socket
    import time
    import urllib.error
    import urllib.request

    wrangler = _wrangler()
    if not wrangler:
        pytest.skip("wrangler not installed (npm install, or set WRANGLER)")
    build = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")], capture_output=True, timeout=60
    )
    assert build.returncode == 0
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(
        # ORIGIN points nowhere: pages must come from assets alone.
        [wrangler, "dev", "-c", "wrangler.landing.jsonc", "--port", str(port), "--var", "ORIGIN:http://127.0.0.1:9"],
        cwd=REPO,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)

    def get(path):
        try:
            with opener.open(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
                return r.status, r.headers.get("content-type", ""), r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type", ""), ""

    try:
        deadline = time.time() + 60
        while True:
            try:
                get("/static/landing.css")
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        for path, marker in [
            ("/", 'id="board"'),
            ("/index.html", 'id="board"'),
            ("/join?room=ROOM1&spectate=1", 'id="inv-main"'),
        ]:
            status, ctype, body = get(path)
            assert status == 200, (path, status)
            assert ctype.startswith("text/html") and marker in body, path
        status, _, body = get("/join?room=Case30X")
        assert status == 200 and "join?room=Case30X" in body
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_real_runtime_decodes_and_reencodes_gzip_html_correctly():
    """Greptile flagged the host rewrite as possibly corrupting a
    gzip-compressed HTML response, since rewriteOriginHost() reads it with
    res.text() and re-serves it with the original (gzip) Content-Encoding
    header still attached. Checked under `wrangler dev`: the real Workers
    runtime decodes an encoded body on read and re-encodes on write because
    the header is carried over, so the rewrite is correct — this is not
    reproducible against the fake ASSETS/fetch harnesses above, which never
    touch real gzip framing, so it needs the real local runtime."""
    import gzip
    import socket
    import time
    import urllib.request

    wrangler = _wrangler()
    if not wrangler:
        pytest.skip("wrangler not installed (npm install, or set WRANGLER)")
    build = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")], capture_output=True, timeout=60
    )
    assert build.returncode == 0

    import http.server
    import threading

    class GzipOrigin(http.server.BaseHTTPRequestHandler):
        head_content_length = None

        def _body(self):
            # The rewrite only matches an "https://" prefix (what Render
            # actually serves over); the value doesn't need to match the
            # scheme this local test origin runs on.
            html = f'<html><a href="https://{self.headers.get("host", "")}/x">x</a></html>'.encode()
            return gzip.compress(html)

        def do_GET(self):
            body = self._body()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            body = self._body()
            type(self).head_content_length = len(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()

        def log_message(self, *a):  # quiet
            pass

    def free_port():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    origin_port = free_port()
    origin = http.server.HTTPServer(("127.0.0.1", origin_port), GzipOrigin)
    origin_thread = threading.Thread(target=origin.serve_forever, daemon=True)
    origin_thread.start()

    wrangler_port = free_port()
    proc = subprocess.Popen(
        [
            wrangler,
            "dev",
            "-c",
            "wrangler.landing.jsonc",
            "--port",
            str(wrangler_port),
            "--var",
            f"ORIGIN:http://127.0.0.1:{origin_port}",
        ],
        cwd=REPO,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 60
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{wrangler_port}/static/landing.css", timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)

        # /play.html isn't a landing page or asset, so this goes through the
        # plain (untimed) proxy() -> rewriteOriginHost() path.
        req = urllib.request.Request(f"http://127.0.0.1:{wrangler_port}/play.html", headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=10) as r:
            assert r.status == 200
            raw = r.read()
            encoding = r.headers.get("Content-Encoding", "")
            body = gzip.decompress(raw) if encoding == "gzip" else raw
            text = body.decode("utf-8")

        # wrangler dev serves this Worker under the routed hostname from
        # wrangler.landing.jsonc regardless of the local port it's listening
        # on, so that's the public host the rewrite substitutes in — not
        # 127.0.0.1:<wrangler_port>. Either way, the origin's own host must
        # be gone and a rewritten https:// link must remain.
        assert '/x">' in text and "https://" in text
        assert f"127.0.0.1:{origin_port}" not in text

        head_req = urllib.request.Request(
            f"http://127.0.0.1:{wrangler_port}/play.html", method="HEAD", headers={"Accept-Encoding": "gzip"}
        )
        with urllib.request.urlopen(head_req, timeout=10) as r:
            assert r.status == 200
            assert r.headers["Content-Length"] == str(GzipOrigin.head_content_length)
            assert r.read() == b""
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        origin.shutdown()
        origin_thread.join(timeout=5)


def test_real_runtime_forwards_the_visitor_ip_not_the_spoofed_header():
    """Same as test_proxied_requests_carry_the_visitor_ip_only_with_the_secret,
    but through the real workerd runtime (wrangler dev) instead of a mocked
    fetch, against a real local HTTP origin that records what it received."""
    import http.server
    import socket
    import threading
    import time
    import urllib.request

    wrangler = _wrangler()
    if not wrangler:
        pytest.skip("wrangler not installed (npm install, or set WRANGLER)")
    build = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")], capture_output=True, timeout=60
    )
    assert build.returncode == 0

    seen = []

    class Recorder(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            # Real workerd also runs the freshness check in the background
            # (a GET to /api/landing-build) against this same origin, which
            # can land before or after the /list request below — record the
            # path so the test can pick out the request it cares about
            # instead of assuming it's whichever the origin sees first.
            seen.append({"path": self.path, **{k.lower(): v for k, v in self.headers.items()}})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, *a):  # quiet
            pass

    def free_port():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    origin_port = free_port()
    origin = http.server.HTTPServer(("127.0.0.1", origin_port), Recorder)
    origin_thread = threading.Thread(target=origin.serve_forever, daemon=True)
    origin_thread.start()

    wrangler_port = free_port()
    secret = "test-secret-not-real"
    # --var works for local `wrangler dev`; no .dev.vars file is needed or
    # written, so there's nothing to gitignore or clean up.
    proc = subprocess.Popen(
        [
            wrangler,
            "dev",
            "-c",
            "wrangler.landing.jsonc",
            "--port",
            str(wrangler_port),
            "--var",
            f"ORIGIN:http://127.0.0.1:{origin_port}",
            "--var",
            f"PROXY_SECRET:{secret}",
        ],
        cwd=REPO,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 60
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{wrangler_port}/static/landing.css", timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)

        req = urllib.request.Request(
            f"http://127.0.0.1:{wrangler_port}/list",
            headers={
                "CF-Connecting-IP": "9.9.9.9",
                # A visitor trying to smuggle their own value through, in
                # both the hyphenated and underscore spellings.
                "X-KN-Client-IP": "6.6.6.6",
                "x_kn_client_ip": "7.7.7.7",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            assert r.status == 200

        deadline = time.time() + 10
        list_seen = None
        while list_seen is None and time.time() < deadline:
            list_seen = next((s for s in seen if s["path"].startswith("/list")), None)
            if list_seen is None:
                time.sleep(0.1)
        assert list_seen, "origin never received the proxied /list request"
        headers = list_seen

        # wrangler dev's local workerd runs with no real Cloudflare edge in
        # front of it, so nothing rewrites the CF-Connecting-IP the test
        # sends — forwardedHeaders() sees exactly the value given here. (On
        # the real edge, Cloudflare itself sets CF-Connecting-IP and a
        # spoofed client value there is impossible in the first place.)
        assert headers.get("x-kn-client-ip") == "9.9.9.9"
        assert headers.get("x-kn-proxy-auth") == secret
        # The visitor's spoofed copies never reach the origin.
        assert "6.6.6.6" not in headers.values()
        assert "7.7.7.7" not in headers.values()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        origin.shutdown()
        origin_thread.join(timeout=5)


FORWARD_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const seen = [];
globalThis.fetch = async (req, init) => {
  // proxy() calls fetch(request); previewPage() calls fetch(url, init) —
  // the harness must read headers from either shape.
  const h = req instanceof Request ? req.headers : new Headers((init && init.headers) || {});
  const upgrade = h.get('Upgrade');
  seen.push({
    ip: h.get('X-KN-Client-IP'),
    auth: h.get('X-KN-Proxy-Auth'),
    upgrade,
    strayIp: h.get('x_kn_client_ip'),
    strayAuth: h.get('x_kn_proxy_auth'),
  });
  if (req instanceof Request && req.url.includes('/join')) {
    return new Response('<html><meta property="og:url" content="https://game.example/join" /></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }
  return new Response('ok');
};
const assets = { fetch: async () => new Response('asset') };
const req = (headers) => new Request('https://kn.example/list', { headers });
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
// With the secret: the visitor's IP is forwarded; spoofed copies are replaced.
await worker.fetch(req({ 'CF-Connecting-IP': '5.6.7.8', 'X-KN-Client-IP': '1.1.1.1', 'X-KN-Proxy-Auth': 'x' }),
  { ORIGIN: 'https://game.example', ASSETS: assets, PROXY_SECRET: 's3cret' }, ctx);
// Without it: nothing is forwarded, and spoofed copies are dropped.
await worker.fetch(req({ 'CF-Connecting-IP': '5.6.7.8', 'X-KN-Client-IP': '1.1.1.1', 'X-KN-Proxy-Auth': 'x' }),
  { ORIGIN: 'https://game.example', ASSETS: assets }, ctx);
// Underscore-spelled visitor headers must be stripped too (engineio folds
// '-' and '_' together server-side, so a visitor could try either).
await worker.fetch(req({
  'CF-Connecting-IP': '5.6.7.8',
  'x_kn_client_ip': '1.1.1.1',
  'x_kn_proxy_auth': 'x',
}), { ORIGIN: 'https://game.example', ASSETS: assets, PROXY_SECRET: 's3cret' }, ctx);
// The crawler preview path (previewPage -> fetch(url, init)) forwards too.
await worker.fetch(
  new Request('https://kn.example/join?room=ABC', {
    headers: { 'CF-Connecting-IP': '5.6.7.8', 'User-Agent': 'Discordbot/2.0' },
  }),
  { ORIGIN: 'https://game.example', ASSETS: assets, PROXY_SECRET: 's3cret' },
  ctx,
);
// A Socket.IO WebSocket upgrade request is proxied with the same headers,
// and the Upgrade header survives.
await worker.fetch(
  new Request('https://kn.example/socket.io/?EIO=4&transport=websocket', {
    headers: {
      'CF-Connecting-IP': '5.6.7.8',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
    },
  }),
  { ORIGIN: 'https://game.example', ASSETS: assets, PROXY_SECRET: 's3cret' },
  ctx,
);
await Promise.all(waits);
console.log(JSON.stringify(seen));
"""


def test_proxied_requests_carry_the_visitor_ip_only_with_the_secret():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", FORWARD_HARNESS, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    with_secret, without, underscored, preview, upgrade = json.loads(res.stdout)
    base = {"strayIp": None, "strayAuth": None}
    assert with_secret == {**base, "ip": "5.6.7.8", "auth": "s3cret", "upgrade": None}
    assert without == {**base, "ip": None, "auth": None, "upgrade": None}
    # Underscore-named spoofed headers are stripped just like hyphenated ones
    # — not merely shadowed by the Worker's own correctly-cased header.
    assert underscored == {**base, "ip": "5.6.7.8", "auth": "s3cret", "upgrade": None}
    # previewPage's fetch(url, init) call also carries the forwarded headers.
    assert preview == {**base, "ip": "5.6.7.8", "auth": "s3cret", "upgrade": None}
    # The WebSocket upgrade path is proxied with the forwarded IP/auth and
    # keeps its Upgrade header.
    assert upgrade == {**base, "ip": "5.6.7.8", "auth": "s3cret", "upgrade": "websocket"}


# ── Freshness detection for the Worker's copies of / and /join ───────

FRESHNESS_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const scenario = process.argv[2]; // 'fresh' | 'stale' | 'slow-stale' | 'timeout' | 'error'
const ownId = 'aaaa1111aaaa1111';
const originId = scenario === 'stale' || scenario === 'slow-stale' ? 'bbbb2222bbbb2222' : ownId;

const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};

let landingBuildFetches = 0;
globalThis.fetch = async (req, init) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    landingBuildFetches++;
    if (scenario === 'slow-stale') await new Promise((resolve) => setTimeout(resolve, 1000));
    if (scenario === 'timeout') {
      return new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    if (scenario === 'error') throw new Error('origin unreachable');
    if (scenario === 'empty-id') {
      return new Response(JSON.stringify({ id: '' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (scenario === 'non2xx') {
      return new Response('boom', { status: 500 });
    }
    if (scenario === 'badjson') {
      return new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: originId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('origin-page', { status: 200, headers: { 'Content-Type': 'text/html' } });
};

const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

async function get(path) {
  const res = await worker.fetch(new Request('https://kn.example' + path), env, ctx);
  return res.text();
}

const firstStarted = Date.now();
const first = await get('/');
const firstMs = Date.now() - firstStarted;
// The check runs in the background: it must not have been awaited yet, so
// the first response is unaffected by whatever it eventually decides.
const firstIsAsset = first.startsWith('asset:');
await Promise.all(waits.splice(0));
const secondPage = await get('/');
const secondAsset = await get('/static/landing.js');
console.log(JSON.stringify({ firstIsAsset, firstMs, secondPage, secondAsset, landingBuildFetches }));
"""


def _run_freshness(scenario: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", FRESHNESS_HARNESS, WORKER.as_uri(), scenario],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_freshness_check_never_blocks_the_first_response():
    # The first response must not await the deliberately one-second check.
    # It may wait for the separate ~300 ms unknown-verdict grace period.
    out = _run_freshness("slow-stale")
    assert out["firstIsAsset"] is True
    assert out["firstMs"] < 700
    assert out["landingBuildFetches"] == 1


def test_freshness_fresh_keeps_serving_assets():
    out = _run_freshness("fresh")
    assert out["secondPage"].startswith("asset:")
    assert out["secondAsset"].startswith("asset:")


def test_freshness_stale_proxies_pages_and_landing_assets():
    out = _run_freshness("stale")
    assert out["secondPage"] == "origin-page"
    assert out["secondAsset"] == "origin-page"


@pytest.mark.parametrize("scenario", ["timeout", "error"])
def test_freshness_origin_timeout_or_error_keeps_serving_assets(scenario):
    # A napping or unreachable origin must never be read as "stale" — that
    # would flip every visitor over to a server that isn't answering.
    out = _run_freshness(scenario)
    assert out["secondPage"].startswith("asset:")
    assert out["secondAsset"].startswith("asset:")


@pytest.mark.parametrize("scenario", ["empty-id", "non2xx", "badjson"])
def test_freshness_inconclusive_results_never_read_as_stale(scenario):
    """An invalid body or unsuccessful response is inconclusive and must
    never change the freshness verdict to stale."""
    out = _run_freshness(scenario)
    assert out["secondPage"].startswith("asset:")
    assert out["secondAsset"].startswith("asset:")


# ── Freshness: single in-flight check, checkedAt-at-start backoff ────────────

CONCURRENCY_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const ownId = 'aaaa1111aaaa1111';
let landingBuildFetches = 0;
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
globalThis.fetch = async (req) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    landingBuildFetches++;
    // Never resolves on its own — the request path is what matters here,
    // not the eventual verdict. Aborted (inconclusively) by the caller's
    // own timeout once every in-flight request has been dispatched.
    return new Promise((_resolve, reject) => {});
  }
  return new Response('origin-page', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

// A burst of concurrent requests (some pages, some assets) dispatched
// without waiting on each other first — as a real burst of visitor traffic
// would arrive on a fresh isolate.
const paths = ['/', '/static/landing.js', '/index.html', '/join', '/static/landing.js', '/'];
await Promise.all(paths.map((p) => worker.fetch(new Request('https://kn.example' + p), env, ctx).then((r) => r.text())));
console.log(JSON.stringify({ landingBuildFetches }));
"""


def test_single_in_flight_check_under_concurrent_requests():
    """Concurrent requests on a fresh isolate share one in-flight freshness
    check instead of starting one check per request."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", CONCURRENCY_HARNESS, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["landingBuildFetches"] == 1


BACKOFF_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const ownId = 'aaaa1111aaaa1111';
let landingBuildFetches = 0;
let now = 1_700_000_000_000;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return now; }
};
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
globalThis.fetch = async (req) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    landingBuildFetches++;
    // Always inconclusive (non-2xx): a consistently-erroring origin.
    return new Response('boom', { status: 500 });
  }
  return new Response('origin-page', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

async function get(path) {
  const res = await worker.fetch(new Request('https://kn.example' + path), env, ctx);
  await res.text();
  await Promise.all(waits.splice(0));
}

// Many requests in the same instant: only the first should check at all.
for (let i = 0; i < 5; i++) await get('/');
const afterBurst = landingBuildFetches;

// Time passes, but well under the 60s retry interval: still no new check.
now += 5_000;
for (let i = 0; i < 5; i++) await get('/');
const afterShortWait = landingBuildFetches;

// Past the interval: exactly one more check (not one per request since).
now += 60_000;
for (let i = 0; i < 5; i++) await get('/');
const afterLongWait = landingBuildFetches;

console.log(JSON.stringify({ afterBurst, afterShortWait, afterLongWait }));
"""


def test_inconclusive_checks_back_off_instead_of_retrying_every_request():
    """After an inconclusive result, freshness checks wait out the normal
    interval instead of retrying on every request."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", BACKOFF_HARNESS, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["afterBurst"] == 1
    assert out["afterShortWait"] == 1  # still within the ~60s interval
    assert out["afterLongWait"] == 2  # one more check, not five


def test_inconclusive_check_keeps_a_previously_conclusive_verdict():
    """A later inconclusive check leaves an existing conclusive freshness
    verdict unchanged."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    script = r"""
const worker = (await import(process.argv[1])).default;
const ownId = 'aaaa1111aaaa1111';
let now = 1_700_000_000_000;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return now; }
};
let scenario = 'stale'; // round 1: conclusive stale
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
globalThis.fetch = async (req) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    if (scenario === 'stale') {
      return new Response(JSON.stringify({ id: 'bbbb2222bbbb2222' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('boom', { status: 500 }); // inconclusive from here on
  }
  return new Response('origin-page', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
async function get(path) {
  const res = await worker.fetch(new Request('https://kn.example' + path), env, ctx);
  const body = await res.text();
  await Promise.all(waits.splice(0));
  return body;
}
await get('/'); // triggers round 1's check in the background
const roundOne = await get('/'); // conclusively 'stale' by now
scenario = 'inconclusive';
now += 60_000; // past the interval: round 2's check runs, and is inconclusive
const roundTwo = await get('/');
console.log(JSON.stringify({ roundOne, roundTwo }));
"""
    res = subprocess.run(
        [node, "--input-type=module", "-e", script, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["roundOne"] == "origin-page"
    # Still proxied: the inconclusive round-2 check must not have reset the
    # verdict away from 'stale'.
    assert out["roundTwo"] == "origin-page"


# ── Freshness: page requests wait briefly on 'unknown', assets never do ──────

UNKNOWN_WAIT_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const ownId = 'aaaa1111aaaa1111';
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
globalThis.fetch = async (req, init) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    // Never resolves on its own; only settles (inconclusively) when the
    // Worker's own FRESHNESS_CHECK_TIMEOUT_MS aborts it, which is well past
    // the ~300ms page-wait cap this test is timing.
    return new Promise((_resolve, reject) => {
      const signal = init && init.signal;
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  return new Response('origin-page', { status: 200, headers: { 'Content-Type': 'text/html' } });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const ctx = { waitUntil: () => {} }; // not awaited: timing must come from the request path itself

async function timed(path) {
  const t0 = Date.now();
  const res = await worker.fetch(new Request('https://kn.example' + path), env, ctx);
  await res.text();
  return Date.now() - t0;
}

const assetMs = await timed('/static/landing.js');
const pageMs = await timed('/join');
console.log(JSON.stringify({ assetMs, pageMs }));
"""


def test_page_requests_wait_briefly_on_unknown_while_assets_never_do():
    """With an unknown verdict, pages briefly await the first freshness
    check while asset requests return immediately."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", UNKNOWN_WAIT_HARNESS, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["assetMs"] < 250
    assert out["assetMs"] < out["pageMs"]
    assert 250 <= out["pageMs"] < 1000  # ~300ms cap, generous either side for CI jitter


# ── Stale-mode proxy timeout + fallback to the Worker's own copy ─────────────

STALE_FALLBACK_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const failure = process.argv[2];
const ownId = 'aaaa1111aaaa1111';
let landingOriginFetches = 0;
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
globalThis.fetch = async (req, init) => {
  const url = req instanceof Request ? req.url : String(req);
  if (url.includes('/api/landing-build')) {
    // Conclusively stale, resolved fast, so the verdict is 'stale' by the
    // time the requests below run.
    return new Response(JSON.stringify({ id: 'bbbb2222bbbb2222' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (!url.endsWith('/list')) {
    landingOriginFetches++;
    if (failure === '503') return new Response('unavailable', { status: 503 });
  }
  // Every other origin fetch hangs until the caller's own AbortController
  // fires — simulating a napping/unreachable origin once the verdict is
  // already 'stale'.
  return new Promise((_resolve, reject) => {
    const signal = init && init.signal;
    if (signal) {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }
    // No signal at all (proxy(), used for non-landing paths): never settles.
  });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

async function get(path) {
  const res = await worker.fetch(new Request('https://kn.example' + path), env, ctx);
  return res.text();
}

await get('/'); // establishes the 'stale' verdict in the background
await Promise.all(waits.splice(0));

const page = await get('/'); // stale mode, origin times out -> falls back
const asset = await get('/static/landing.js'); // same

let race;
try {
  race = await Promise.race([
    get('/list').then((body) => 'resolved:' + body), // non-landing path: no timeout, no fallback — must hang
    new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 500)),
  ]);
} catch (e) {
  race = 'errored:' + e.message;
}

console.log(JSON.stringify({ page, asset, race, landingOriginFetches }));
"""


@pytest.mark.parametrize("failure", ["timeout", "503"])
def test_stale_mode_falls_back_to_the_worker_copy_on_origin_failure(failure):
    """Stale landing requests fall back to Worker assets after an origin
    failure, while non-landing proxy requests retain their normal behavior."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", STALE_FALLBACK_HARNESS, WORKER.as_uri(), failure],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["page"].startswith("asset:")
    assert out["asset"].startswith("asset:")
    assert out["race"] == "still-hanging"
    assert out["landingOriginFetches"] == (1 if failure == "timeout" else 3)


EDGE_CASE_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const mode = process.argv[2];
const ownId = 'aaaa1111aaaa1111';
let now = Date.now();
if (mode === 'own-id-retry') Date.now = () => now;
let ownReads = 0;
let originBuildReads = 0;
let landingFetches = 0;
let joinFetches = 0;
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/static/landing-build.json') {
      ownReads++;
      if (mode === 'own-id-retry' && ownReads === 1) return new Response('bad', { status: 500 });
      return new Response(JSON.stringify({ id: ownId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('asset:' + p, { status: 200 });
  },
};
function hang(init) {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}
globalThis.fetch = async (req, init) => {
  const url = new URL(req instanceof Request ? req.url : String(req));
  if (url.pathname === '/api/landing-build') {
    originBuildReads++;
    return new Response(JSON.stringify({ id: mode === 'own-id-retry' ? ownId : 'bbbb2222bbbb2222' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.pathname === '/join') {
    joinFetches++;
    return hang(init);
  }
  if (url.pathname === '/list') {
    return new Response('list', { status: mode === 'cooldown-524' ? 524 : 200 });
  }
  if (url.pathname === '/static/version.json') return hang(init);
  landingFetches++;
  if (landingFetches === 1 && mode.startsWith('cooldown-')) return hang(init);
  if (mode === 'metadata-page') {
    return new Promise((resolve) => setTimeout(() => resolve(new Response('origin:' + url.pathname, {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    })), 1500));
  }
  return new Response('origin:' + url.pathname, { status: 200, headers: { 'Content-Type': 'text/plain' } });
};
const env = { ORIGIN: 'https://game.example', ASSETS: assets };
let waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
async function get(path, headers) {
  const res = await worker.fetch(new Request('https://kn.example' + path, { headers }), env, ctx);
  return { body: await res.text(), status: res.status };
}
async function settle() { await Promise.all(waits.splice(0)); }

let out;
if (mode === 'build-marker') {
  await get('/'); await settle();
  out = await get('/static/landing-build.json');
} else if (mode === 'own-id-retry') {
  await get('/static/landing.js'); await settle();
  now += 61_000;
  await get('/static/landing.js'); await settle();
  out = { ownReads, originBuildReads };
} else if (mode === 'crawler') {
  await get('/'); await settle();
  const result = await get('/join?room=ABC', { 'User-Agent': 'Discordbot/2.0' });
  out = { ...result, joinFetches };
} else if (mode.startsWith('cooldown-')) {
  await get('/'); await settle();
  await get('/'); // first stale proxy times out and arms the cooldown
  await get('/list');
  const result = await get('/static/landing.js');
  out = { ...result, landingFetches };
} else if (mode === 'metadata-timeout') {
  const started = Date.now();
  const result = await get('/static/version.json');
  out = { ...result, elapsed: Date.now() - started };
} else if (mode === 'metadata-page') {
  await get('/'); await settle();
  await get('/static/version.json'); // times out on the metadata budget
  const landingFetchesBeforePage = landingFetches;
  const started = Date.now();
  const result = await get('/');
  out = { ...result, elapsed: Date.now() - started, pageFetches: landingFetches - landingFetchesBeforePage };
}
console.log(JSON.stringify(out));
"""


def _run_edge_case(mode: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", EDGE_CASE_HARNESS, WORKER.as_uri(), mode],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_stale_mode_always_serves_the_worker_build_marker():
    out = _run_edge_case("build-marker")
    assert json.loads(out["body"])["id"] == "aaaa1111aaaa1111"


def test_failed_own_build_id_read_is_retried():
    out = _run_edge_case("own-id-retry")
    assert out == {"ownReads": 2, "originBuildReads": 1}


def test_stale_crawler_preview_timeout_does_not_fetch_join_twice():
    out = _run_edge_case("crawler")
    assert out["body"].startswith("asset:")
    assert out["joinFetches"] == 1


@pytest.mark.parametrize(
    ("status", "expected_body", "expected_fetches"),
    [("200", "origin:/static/landing.js", 2), ("524", "asset:/static/landing.js", 1)],
)
def test_only_non_5xx_proxy_responses_clear_landing_cooldown(status, expected_body, expected_fetches):
    out = _run_edge_case(f"cooldown-{status}")
    assert out["body"] == expected_body
    assert out["landingFetches"] == expected_fetches


def test_metadata_falls_back_to_assets_with_the_short_timeout():
    out = _run_edge_case("metadata-timeout")
    assert out["body"] == "asset:/static/version.json"
    assert out["elapsed"] < 1500


def test_metadata_timeout_does_not_suppress_a_viable_stale_page_fetch():
    out = _run_edge_case("metadata-page")
    assert out["body"] == "origin:/"
    assert 1000 < out["elapsed"] < 2500
    assert out["pageFetches"] == 1


# ── Public-host rewrite in proxied HTML ──────────────────────────────────

REWRITE_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const env = { ORIGIN: 'https://game.example', ASSETS: { fetch: async () => new Response('asset') } };
const ctx = { waitUntil: () => {} };

globalThis.fetch = async (req) => {
  const url = req.url;
  if (url.includes('/socket.io/')) {
    // Node's fetch (undici) refuses to construct a real Response with
    // status 101 (workerd allows it for a WebSocket upgrade); a bare object
    // exposing what rewriteOriginHost reads is enough for this harness.
    return { status: 101, headers: new Headers() };
  }
  if (url.includes('/api/stats')) {
    return new Response(JSON.stringify({ url: 'https://game.example/x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(
    '<html><a href="https://game.example/play.html">play</a>' +
      '<meta property="og:url" content="https://game.example/play.html?room=ABC" /></html>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '9999' } },
  );
};

const html = await worker.fetch(new Request('https://kn.example/play.html?room=ABC'), env, ctx);
const json = await worker.fetch(new Request('https://kn.example/api/stats'), env, ctx);
const upgrade = await worker.fetch(
  new Request('https://kn.example/socket.io/?EIO=4&transport=websocket', { headers: { Upgrade: 'websocket' } }),
  env,
  ctx,
);
console.log(JSON.stringify({
  htmlBody: await html.text(),
  htmlContentLength: html.headers.get('Content-Length'),
  jsonBody: await json.text(),
  upgradeStatus: upgrade.status,
}));
"""


def _run_rewrite():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    res = subprocess.run(
        [node, "--input-type=module", "-e", REWRITE_HARNESS, WORKER.as_uri()],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_proxied_html_gets_the_public_host_json_and_upgrades_are_untouched():
    out = _run_rewrite()
    assert "https://kn.example/play.html" in out["htmlBody"]
    assert "game.example" not in out["htmlBody"]
    # Content-Length changed (or wasn't set to begin with) — dropped rather
    # than left stale.
    assert out["htmlContentLength"] is None
    # A JSON response is left byte-for-byte alone, origin host included.
    assert out["jsonBody"] == '{"url":"https://game.example/x"}'
    # A WebSocket upgrade (status 101) is passed through untouched.
    assert out["upgradeStatus"] == 101
