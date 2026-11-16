"""The TypeScript bundles in web/static/dist: build output, not in git.

The demo and landing builds package files out of web/static, so they build
the bundles first (the same `node scripts/build-web.mjs` the Docker image and
CI run). With package-lock.json the bytes are the same wherever this runs,
which is what lets the landing Worker's build id match the server's
(server/src/landing_build.py).
"""

import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "web" / "static" / "dist"


def build() -> list[str]:
    """Build the bundles; returns them as paths relative to the repo."""
    if shutil.which("node") is None:
        raise SystemExit("node is not installed: the TypeScript bundles cannot be built")
    if not (REPO / "node_modules" / "esbuild").is_dir():
        raise SystemExit("run `npm ci` first: the TypeScript bundles are built with esbuild")
    # Quiet on success (esbuild lists every bundle); on failure its error is
    # the only clue, so it is shown rather than a bare exit status.
    result = subprocess.run(["node", "scripts/build-web.mjs"], cwd=REPO, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"node scripts/build-web.mjs failed:\n{result.stderr or result.stdout}")
    return sorted(str(p.relative_to(REPO)) for p in DIST.glob("*.js"))
