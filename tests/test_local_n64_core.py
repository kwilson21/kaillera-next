"""Run the exact N64 redirector and vendored EmulatorJS loader with a controlled transport."""

import hashlib
import json
import subprocess
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient
from src.api import app as api

ROOT = Path(__file__).resolve().parents[1]
CORE = "/static/ejs/cores/mupen64plus_next-wasm.data"
REPORTS = "/static/ejs/cores/reports/"
FIRST = hashlib.sha256(b"first bundled core").hexdigest()[:16]
SECOND = hashlib.sha256(b"replacement bundled core").hexdigest()[:16]

# The classes run the real vendored code. XHR supplies responses without
# contacting a server, decoding a ROM, or depending on browser storage APIs.
JS = """
const fs = require('node:fs');
const vm = require('node:vm');
const options = JSON.parse(process.argv[1]);
const redirector = fs.readFileSync('web/static/core-redirector.js', 'utf8');
const emulator = fs.readFileSync('web/static/ejs/emulator.min.js', 'utf8');
const slice = (from, to) => {
  const a = emulator.indexOf(from), b = emulator.indexOf(to, a);
  if (a < 0 || b <= a) throw Error('EmulatorJS method anchors changed: ' + from);
  return emulator.slice(a, b);
};
const reads = [], fetches = [], errors = [], cacheReads = [], cacheWrites = [];
const run = [], storageKeys = [], deletes = [];
class Xhr {
  open(method, url) { this.url = url; reads.push([method, url]); }
  addEventListener() {}
  getResponseHeader() { return null; }
  send() {
    // Deliberately give every report the same buildStart: a stale metadata
    // cache must not cause old bytes to be reused under a new content hash.
    const report = this.url.includes('/reports/');
    if (options.networkError && !report) { this.onerror(); return; }
    this.status = report || !options.missing ? 200 : 404;
    this.response = report ? '{"buildStart":1,"options":{}}' : Uint8Array.of(42).buffer;
    this.DONE = this.readyState = 4;
    this.onload();
  }
}
const nativeFetch = async (url, opts) => {
  fetches.push([typeof url === 'string' ? url : (url.url ?? url.href), opts?.cache ?? null]);
  if (options.info === 'reject' && url === '/api/core-info') throw Error('no metadata');
  return { ok: options.info !== 'unavailable', json: async () => options.info };
};
const location = {href: 'https://local.test/play.html?mode=' + options.mode, search: '?mode=' + options.mode};
const context = vm.createContext({
  URL, URLSearchParams, Uint8Array, Blob, ArrayBuffer, Promise,
  XMLHttpRequest: Xhr,
  console: {log() {}, warn() {}, error() {}},
  window: {location, fetch: nativeFetch, SharedArrayBuffer, localStorage: {
    getItem: () => null, setItem: (...args) => storageKeys.push(args),
  }},
  // Present even though Safari may not support enumeration; streaming must
  // never delete any existing databases, including ROMs and cartridge saves.
  indexedDB: options.noDbEnumeration ? {} : {
    databases: async () => [{name:'EmulatorJS-core'}, {name:'EmulatorJS-roms'}, {name:'/data/saves'}],
    deleteDatabase(name) {
      deletes.push(name);
      const req = {};
      setImmediate(() => req.onsuccess?.());
      return req;
    },
  },
});
context.fetch = (...args) => context.window.fetch(...args);
(async () => {
  vm.runInContext(redirector, context);
  await (options.runtimeMode
    ? context.window._knPrepareN64Core?.(options.runtimeMode) ?? context.window._knCoreReady
    : context.window._knCoreReady);
  const probe = 'https://local.test/static/ejs/cores/' + options.probe;
  await context.window.fetch({url:probe}, {cache:'no-store'});
  await context.window.fetch(new URL('https://local.test/static/ejs/cores/not-' + options.probe));
  await context.window.fetch('https://cdn.emulatorjs.org/stable/data/version.json');
  const Loader = vm.runInContext('(class {' +
    slice('downloadFile(t,e,i,n){', 'toData(t,e){') +
    slice('downloadGameCore(){', 'initGameCore(t,e,i){') + '})', context);
  const loader = Object.assign(new Loader(), {
    textElem: {},
    ejs_version: '4.2.3',
    config: {dataPath:'/static/ejs/', threads:false},
    getCore: () => options.core,
    preGetSetting: name => name === 'ejs_threads' && options.thread ? 'enabled' : '',
    requiresThreads: () => false,
    requiresWebGL2: () => false,
    webgl2Enabled: !options.legacy,
    supportsWebgl2: true,
    localization: x => x,
    toData: () => null,
    startGameError: s => errors.push(s),
    checkCompression: async b => { run.push(['decompress', ...b]); return {}; },
    initGameCore: () => run.push(['start']),
    storage:{core:{
      get: async name => { cacheReads.push(name); return options.cached ?? null; },
      put: (name, value) => cacheWrites.push([name, value.version]),
    }},
  });
  loader.downloadGameCore();
  // All fixture promises settle in this turn; the legacy method returns void.
  await new Promise(resolve => setImmediate(resolve));
  const { _knCoreHash, _knCoreWorkerHash, _kn_usePatchedCore } = context.window;
  context.window._knCoreRestore();
  await context.window.fetch(probe);
  new Xhr().open('GET', probe);
  process.stdout.write(JSON.stringify({
    reads, fetches, errors, cacheReads, cacheWrites, run, storageKeys, deletes,
    worker: _knCoreWorkerHash, rollback: _kn_usePatchedCore, hash: _knCoreHash,
  }));
})().catch(e => { console.error(e); process.exitCode = 1; });
"""


def _info(digest):
    return {
        "available": True,
        "url": f"{CORE}?h={digest}",
        "hash": digest,
        "workerHash": "worker",
        "size": 42,
    }


def _run(**switches):
    options = {
        "mode": "streaming",
        "core": "parallel_n64",
        "thread": True,
        "legacy": False,
        "info": _info(FIRST),
    }
    options |= switches
    options["probe"] = (
        options["core"]
        + ("-thread" if options["thread"] else "")
        + ("-legacy" if options["legacy"] else "")
        + "-wasm.data"
    )
    process = subprocess.run(
        ["node", "-e", JS, json.dumps(options)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    return json.loads(process.stdout)


def test_streaming_maps_all_n64_filenames_without_affecting_other_resources():
    for core in ("mupen64plus_next", "parallel_n64"):
        for thread in (False, True):
            for legacy in (False, True):
                out = _run(core=core, thread=thread, legacy=legacy)
                assert out["reads"][:2] == [
                    ["GET", f"{REPORTS}{core}.json?h={FIRST}"],
                    ["GET", f"{CORE}?h={FIRST}"],
                ]
                assert out["fetches"][:2] == [
                    ["/api/core-info", "no-store"],
                    [f"{CORE}?h={FIRST}", "no-store"],
                ]
                assert "/not-" in out["fetches"][2][0]
                assert out["fetches"][3] == ["/static/ejs/version.json", None]
                assert out["fetches"][-1][0] == out["reads"][-1][1]
                assert out["run"] == [["decompress", 42], ["start"]]
                assert out["cacheWrites"][0][1] == FIRST
                assert not out["storageKeys"] and not out["deletes"]
                assert "rollback" not in out and "worker" not in out


def test_cached_old_core_cannot_be_associated_with_the_replacement_hash():
    out = _run(
        info=_info(SECOND), cached={"version": FIRST, "data": [7]}, noDbEnumeration=True
    )
    assert out["reads"][1] == ["GET", f"{CORE}?h={SECOND}"]
    assert out["cacheWrites"][0][1] == SECOND
    assert out["run"][0] == ["decompress", 42]
    reused = _run(info=_info(SECOND), cached={"version": SECOND, "data": [7]})
    assert len(reused["reads"]) == 2  # Report and post-restore probe only.
    assert not reused["cacheWrites"]
    assert reused["run"][0] == ["decompress", 7]


def test_metadata_failure_uses_only_revalidated_local_bytes_and_not_idb():
    for info in (
        "unavailable",
        "reject",
        {"available": False, "url": CORE, "hash": ""},
    ):
        out = _run(info=info, cached={"version": 1, "data": [7]})
        assert out["reads"][:2] == [
            ["GET", f"{REPORTS}parallel_n64.json?revalidate=1"],
            ["GET", f"{CORE}?revalidate=1"],
        ]
        assert not out["cacheReads"] and not out["cacheWrites"]
        assert out["run"][0] == ["decompress", 42]


def test_missing_local_core_never_retries_or_starts_or_caches():
    for network_error in (False, True):
        out = _run(info="unavailable", missing=True, networkError=network_error)
        assert not any("cdn.emulatorjs.org" in url for _, url in out["reads"])
        assert out["reads"][:2] == [
            ["GET", f"{REPORTS}parallel_n64.json?revalidate=1"],
            ["GET", f"{CORE}?revalidate=1"],
        ]
        assert len(out["reads"]) == 3
        assert out["errors"] == [
            "Error downloading core (parallel_n64-thread-wasm.data)"
        ]
        assert not out["run"] and not out["cacheReads"] and not out["cacheWrites"]


def test_lobby_mode_not_url_determines_streaming_boot_cache():
    out = _run(mode="rollback", runtimeMode="streaming", info="unavailable")
    assert out["reads"][:2] == [
        ["GET", f"{REPORTS}parallel_n64.json?revalidate=1"],
        ["GET", f"{CORE}?revalidate=1"],
    ]
    assert not out["deletes"] and "rollback" not in out and "worker" not in out
    assert (
        "window._knPrepareN64Core?.(mode) ?? window._knCoreReady"
        in (ROOT / "web/static/play.js").read_text()
    )


def test_rollback_hash_and_worker_metadata_and_save_preservation():
    out = _run(mode="rollback", thread=False)
    assert out["reads"][:2] == [
        ["GET", f"{REPORTS}parallel_n64.json"],
        ["GET", f"{CORE}?h={FIRST}"],
    ]
    assert (
        out["rollback"] is True and out["hash"] == FIRST and out["worker"] == "worker"
    )
    assert "/data/saves" not in out["deletes"]


def test_core_metadata_hashes_bundle_content_and_fallback_is_revalidated(
    tmp_path, monkeypatch
):
    asset = tmp_path / "core"
    monkeypatch.setattr(api, "_core_path", str(asset))
    monkeypatch.setattr(api, "_WORKER_CORE_PATHS", [str(asset)])
    middleware = api.SecurityHeadersMiddleware(None, allow_cache=True)
    for content, digest in (
        (b"first bundled core", FIRST),
        (b"replacement bundled core", SECOND),
    ):
        asset.write_bytes(content)
        info = api._compute_core_info()
        assert info["hash"] == digest
        assert info["url"] == f"{CORE}?h={digest}"
        for path in (CORE, f"{REPORTS}parallel_n64.json"):
            assert "immutable" in middleware._cache_control(
                path, f"h={digest}".encode()
            )
            assert middleware._cache_control(path, b"revalidate=1") == "no-cache"
            assert middleware._cache_control(path) == "no-cache"
    asset.unlink()
    assert api._compute_core_info()["available"] is False


def test_streaming_paths_send_the_expected_http_cache_policy():
    fake_static = FastAPI()
    installed = True

    @fake_static.get("/{path:path}")
    async def installed_asset(path):
        status = 200 if installed and path.startswith("static/ejs/") else 404
        return Response(status_code=status)

    client = TestClient(api.SecurityHeadersMiddleware(fake_static, allow_cache=True))
    for path in (CORE, f"{REPORTS}parallel_n64.json"):
        assert client.get(path).headers["cache-control"] == "no-cache"
        assert client.get(f"{path}?revalidate=1").headers["cache-control"] == "no-cache"
        assert "immutable" in client.get(f"{path}?h={FIRST}").headers["cache-control"]
        assert (
            "immutable" not in client.get(f"{path}?h=unknown").headers["cache-control"]
        )
    worker = "/static/ejs/cores/mupen64plus_next_libretro.wasm"
    assert "immutable" in client.get(f"{worker}?h={FIRST}").headers["cache-control"]

    middleware = api.SecurityHeadersMiddleware(None, allow_cache=True)
    assert (
        middleware._cache_control(CORE, f"h={FIRST}".encode(), status=404) == "no-store"
    )


def test_denied_wake_lock_during_core_boot(page, server_url, rom_path, room, start_game):
    page.add_init_script("""
        window.wakeRequests = 0;
        window.unhandledWakeDenials = 0;
        const denied = new DOMException("Permission was denied", "NotAllowedError");
        Object.defineProperty(navigator, "wakeLock", {value: {
            request() {
                window.wakeRequests++;
                return Promise.reject(denied);
            }
        }});
        window.addEventListener("unhandledrejection", e => {
            if (e.reason === denied) window.unhandledWakeDenials++;
        });
    """)
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
    page.set_input_files("#rom-drop input[type=file]", rom_path)
    start_game(page)
    assert page.evaluate("window.wakeRequests") > 0
    assert page.evaluate("window.unhandledWakeDenials") == 0
