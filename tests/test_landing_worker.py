"""The landing Worker (deploy/static/worker.js) routes requests the way
deploy/static/README.md says: pages and their files from assets, crawlers
on /join to the game server with a fallback, everything else proxied.

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
  // Pages carry the static preview block's host placeholder.
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
  const u = new URL(url);
  return new Response('origin:' + u.pathname + u.search + ' og=https://game.example/card', { status: 200 });
};
const cases = [
  ['/', 'GET', ''],
  ['/index.html', 'GET', ''],
  ['/join?room=ABC', 'GET', ''],
  ['/join?room=ABC', 'GET', 'Discordbot/2.0'],
  ['/join?room=abc%22%3E%3Cx&spectate=1', 'GET', 'Discordbot/2.0'],
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
        ("/play.html?room=ABC", "GET"),
        ("/list", "GET"),
        ("/socket.io/?EIO=4", "GET"),
        ("/join?room=ABC", "POST"),
    ]:
        assert _body(r, path, method) == f"origin:{path} og=https://game.example/card"


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
    # Only the validated code goes in, whatever the query holds.
    odd = _body(down, "/join?room=abc%22%3E%3Cx&spectate=1", "GET", "Discordbot/2.0")
    assert 'content="https://kn.example/join?room=ABCX&amp;spectate=1"' in odd
    assert "<x" not in odd


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
