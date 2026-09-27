"""Build the static front page + invite page into dist-landing/ for the
landing Worker (hosting option A, deploy/static/README.md).

    dist-landing/index.html, join.html      web/index.html, web/join.html
    dist-landing/static/...                 only the files those pages load
    dist-landing/static/landing-build.json  {"id": <landing build id>}

The Worker entry is deploy/static/worker.js; the build fails if it doesn't
list a file the pages load (it would be proxied to a napping server) or the
landing-build.json file itself. The build id is computed by
server/src/landing_build.py, the same module the running server uses for
GET /api/landing-build, so the two can never disagree about what "the
landing build" contains or how it's hashed.

Usage: python scripts/build_landing.py
Then:  npx wrangler deploy -c wrangler.landing.jsonc   (owner, with the route on)
"""

import json
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
DIST = REPO / "dist-landing"

sys.path.insert(0, str(REPO / "server"))
from src.landing_build import (  # noqa: E402
    EXTRA,
    OPTIONAL_EXTERNAL,
    PAGES,
    landing_build_id,
    referenced,
)

FALLBACK_METADATA = {"static/version.json", "static/changelog.json"}


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    files: set[str] = set(EXTRA) | FALLBACK_METADATA
    for page in PAGES:
        html = (WEB / page).read_text()
        files |= referenced(html)
        (DIST / page).parent.mkdir(parents=True, exist_ok=True)
        (DIST / page).write_text(html)
    files -= {rel for rel in OPTIONAL_EXTERNAL if not (WEB / rel).is_file()}
    files |= {
        str(p.relative_to(WEB)) for p in (WEB / "static" / "fonts").glob("*.woff2")
    }
    for rel in sorted(files):
        src = WEB / rel
        if not src.is_file():
            raise SystemExit(f"missing: web/{rel}")
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    # The landing build id: computed from web/ (the source, not the copies
    # just made), so it matches what GET /api/landing-build reports from the
    # same source tree. Not itself part of `files`/`landing_files()` — it
    # describes them, so including it would be circular.
    build_id = landing_build_id(WEB)
    build_json_rel = "static/landing-build.json"
    build_json = DIST / build_json_rel
    build_json.parent.mkdir(parents=True, exist_ok=True)
    build_json.write_text(json.dumps({"id": build_id}))

    worker = (REPO / "deploy" / "static" / "worker.js").read_text()
    listed = set(re.findall(r"'(/static/[^']+)'", worker))
    served = files | {build_json_rel}
    missing = {"/" + f for f in served if not f.startswith("static/fonts/")} - listed
    if missing:
        raise SystemExit(f"deploy/static/worker.js doesn't serve: {sorted(missing)}")
    print(
        f"dist-landing/: {len(PAGES)} pages, {len(served)} static files, build id {build_id}"
    )


if __name__ == "__main__":
    main()
