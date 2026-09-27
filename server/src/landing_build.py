"""The "landing build id": a stable content hash over exactly the files the
landing Worker serves from its static assets (deploy/static/README.md).

Both `scripts/build_landing.py` (which copies those files into
dist-landing/) and the running server (`GET /api/landing-build`, see
server/src/api/app.py) compute the id through this module, so they can never
disagree about which files define "the landing build" or how to hash them.
The Worker compares its own build's id (baked into dist-landing/ at build
time) against this endpoint's answer to notice when a Render release shipped
a newer front page / invite page than the one the Worker has cached — see
worker.js's `refreshFreshness`.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

# The two pages the landing Worker serves from assets, and extra files it
# needs that aren't referenced by a `src=`/`href=` in either page's HTML.
PAGES = ["index.html", "join.html"]
EXTRA = [
    "static/og/home.png",  # the generic link-preview image (og:image)
]
# NOT in EXTRA, and NOT served from the Worker's assets: static/version.json
# and static/changelog.json. CI's version-bump workflow (scripts/bump-version.sh)
# rewrites both on nearly every merge to main, which would move the landing
# build id (and so flip the Worker to 'stale') on nearly every merge too —
# and 'stale' never reverts on its own while Render naps, so visitors would
# eat a ~1-minute proxy wait after almost every release. Only version.js
# reads them (footer version + changelog modal), both fetches wrapped in
# try/catch and non-blocking, so proxying them straight to the origin is
# harmless — see deploy/static/worker.js and its ASSET_FILES.

_STATIC_REF = re.compile(r'(?:src|href)="(/static/[^"?#]+)"')


def referenced(html: str) -> set[str]:
    """Local /static/ files an HTML page references (scripts, styles, fonts, icons)."""
    return {m.lstrip("/") for m in _STATIC_REF.findall(html)}


def landing_files(web_dir: Path) -> set[str]:
    """The exact set of files (paths relative to `web_dir`) the landing
    Worker serves from assets: the pages themselves, the files they load,
    EXTRA, and every self-hosted font."""
    files: set[str] = set(EXTRA) | set(PAGES)
    for page in PAGES:
        files |= referenced((web_dir / page).read_text())
    files |= {str(p.relative_to(web_dir)) for p in (web_dir / "static" / "fonts").glob("*.woff2")}
    return files


def landing_build_id(web_dir: Path) -> str:
    """A stable id over the raw bytes of `landing_files(web_dir)`.

    Files are hashed in a deterministic order (sorted relative paths), and
    each file's path is folded into the hash alongside its bytes so renaming
    a file (even to another with identical contents) changes the id too.
    First 16 hex chars of sha256 — plenty unique for a staleness check, and
    short enough to compare and log comfortably.
    """
    h = hashlib.sha256()
    for rel in sorted(landing_files(web_dir)):
        h.update(rel.encode())
        h.update(b"\0")
        h.update((web_dir / rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:16]
