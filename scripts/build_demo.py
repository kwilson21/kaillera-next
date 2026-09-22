"""Build the static rollback demo into dist/ for Cloudflare (wrangler deploy).

The demo runs entirely in the browser: the emulator, the rollback engine and
the synthetic second player. So the deploy is just files:

    dist/index.html      web/demo.html, minus the lobby link (no server yet)
    dist/static/...      git-tracked files under web/static/ (never ROMs:
                         .gitignore keeps those out of git, so out of here)
    dist/api/core-info   the JSON the Python server would compute on the fly
    dist/_headers        the security headers the Python server would send

Usage: python scripts/build_demo.py
"""

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
DIST = REPO / "dist"
CORE = "static/ejs/cores/mupen64plus_next-wasm.data"

# Not needed by the demo. og/ holds game box art used only for link previews.
SKIP_PREFIXES = ("web/static/og/", "web/static/admin")
ROM_SUFFIXES = (".z64", ".n64", ".v64", ".rom", ".zip", ".7z")

# Same policy the Python server sends for EmulatorJS pages (server/src/api/app.py
# SecurityHeadersMiddleware._CSP_PLAY). COOP/COEP make the page cross-origin
# isolated, which the rollback shadow worker needs for SharedArrayBuffer.
CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' blob:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "connect-src 'self' blob:; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "worker-src 'self' blob:; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "object-src 'none'"
)
HEADERS = f"""/*
  Content-Security-Policy: {CSP}
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Frame-Options: SAMEORIGIN
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/api/core-info
  Content-Type: application/json
  Cache-Control: no-store
"""


def tracked_static_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "web/static"], cwd=REPO, check=True, capture_output=True, text=True
    ).stdout.split()
    return [f for f in out if not f.startswith(SKIP_PREFIXES)]


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)

    files = tracked_static_files()
    roms = [f for f in files if f.lower().endswith(ROM_SUFFIXES)]
    if roms:
        raise SystemExit(f"refusing to build: ROM-like files are tracked in git: {roms}")
    for rel in files:
        dest = DIST / rel.removeprefix("web/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dest)

    # The page: demo.html without the "Open the lobby" card (the lobby needs
    # the Python server, which isn't deployed yet). demo.js null-checks it.
    html = (WEB / "demo.html").read_text()
    html, n = re.subn(r'\s*<a id="play-cta".*?</a>', "", html, flags=re.S)
    if n != 1:
        raise SystemExit("could not find the lobby link in web/demo.html")
    (DIST / "index.html").write_text(html)

    # core-redirector.js asks /api/core-info for a content-hashed core URL so
    # browsers never run a stale core. Compute it once at build time instead.
    core_hash = hashlib.sha256((WEB / CORE).read_bytes()).hexdigest()[:16]
    (DIST / "api").mkdir()
    (DIST / "api" / "core-info").write_text(
        json.dumps(
            {"url": f"/{CORE}?h={core_hash}", "hash": core_hash, "size": (WEB / CORE).stat().st_size, "available": True}
        )
    )

    (DIST / "_headers").write_text(HEADERS)

    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"dist/ ready: {len(files) + 3} files, {size / 1e6:.1f} MB, core hash {core_hash}")


if __name__ == "__main__":
    main()
