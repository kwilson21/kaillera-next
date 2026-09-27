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
  // Only HTML responses get the host rewrite (finding 2); everything else
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
    # origin's own (Render) hostname (finding 2). A POST to /join isn't
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


# ── Freshness (finding 1: the Worker's copies of / and /join go stale) ───────

FRESHNESS_HARNESS = r"""
const worker = (await import(process.argv[1])).default;
const scenario = process.argv[2]; // 'fresh' | 'stale' | 'timeout' | 'error'
const ownId = 'aaaa1111aaaa1111';
const originId = scenario === 'stale' ? 'bbbb2222bbbb2222' : ownId;

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

const first = await get('/');
// The check runs in the background: it must not have been awaited yet, so
// the first response is unaffected by whatever it eventually decides.
const firstIsAsset = first.startsWith('asset:');
await Promise.all(waits.splice(0));
const secondPage = await get('/');
const secondAsset = await get('/static/landing.js');
console.log(JSON.stringify({ firstIsAsset, secondPage, secondAsset, landingBuildFetches }));
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
    # Before the background check has had a chance to run at all, the very
    # first request must still be served from assets, not held up.
    out = _run_freshness("fresh")
    assert out["firstIsAsset"] is True
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


# ── Host rewrite in proxied HTML (finding 2) ──────────────────────────────────

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
