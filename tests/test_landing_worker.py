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
  ASSETS: { fetch: async (req) => new Response('asset:' + new URL(req.url).pathname, { status: 200 }) },
};
let originUp = process.argv[2] === 'up';
globalThis.fetch = async (req, init) => {
  const url = typeof req === 'string' || req instanceof URL ? String(req) : req.url;
  if (!originUp) throw new Error('napping');
  return new Response('origin:' + new URL(url).pathname + new URL(url).search, { status: 200 });
};
const cases = [
  ['/', 'GET', ''],
  ['/index.html', 'GET', ''],
  ['/join?room=ABC', 'GET', ''],
  ['/join?room=ABC', 'GET', 'Discordbot/2.0'],
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


def test_pages_and_their_files_come_from_assets():
    r = _run(origin_up=True)
    assert r[("/", "GET", "")]["body"] == "asset:/index.html"
    assert r[("/index.html", "GET", "")]["body"] == "asset:/index.html"
    assert r[("/join?room=ABC", "GET", "")]["body"] == "asset:/join.html"
    for page in [("/", "GET", ""), ("/join?room=ABC", "GET", "")]:
        assert "script-src 'self'" in r[page]["csp"]
        assert r[page]["cache"] == "no-store"
    assert r[("/static/landing.js", "GET", "")]["body"] == "asset:/static/landing.js"
    assert r[("/static/landing.js", "GET", "")]["cache"] == "no-cache"
    assert r[("/static/fonts/ibm-plex-sans-var-latin.woff2", "GET", "")]["body"].startswith("asset:")


def test_everything_else_goes_to_the_game_server():
    r = _run(origin_up=True)
    assert r[("/static/play.js", "GET", "")]["body"] == "origin:/static/play.js"
    assert r[("/play.html?room=ABC", "GET", "")]["body"] == "origin:/play.html?room=ABC"
    assert r[("/list", "GET", "")]["body"] == "origin:/list"
    assert r[("/socket.io/?EIO=4", "GET", "")]["body"] == "origin:/socket.io/?EIO=4"
    assert r[("/join?room=ABC", "POST", "")]["body"] == "origin:/join?room=ABC"


def test_crawlers_get_the_room_preview_or_the_static_page():
    up = _run(origin_up=True)
    assert up[("/join?room=ABC", "GET", "Discordbot/2.0")]["body"] == "origin:/join?room=ABC"
    assert "script-src 'self'" in up[("/join?room=ABC", "GET", "Discordbot/2.0")]["csp"]
    down = _run(origin_up=False)
    assert down[("/join?room=ABC", "GET", "Discordbot/2.0")]["body"] == "asset:/join.html"


def test_build_lists_exactly_the_files_the_pages_load():
    res = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")], capture_output=True, text=True, timeout=60
    )
    assert res.returncode == 0, res.stderr + res.stdout
    dist = REPO / "dist-landing"
    assert (dist / "index.html").is_file() and (dist / "join.html").is_file()
    assert (dist / "static" / "join.js").is_file()
    assert not (dist / "static" / "play.js").exists()
