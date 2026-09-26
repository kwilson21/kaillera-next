"""Build the static front page + invite page into dist-landing/ for the
landing Worker (hosting option A, deploy/static/README.md).

    dist-landing/index.html, join.html      web/index.html, web/join.html
    dist-landing/static/...                 only the files those pages load

The Worker entry is deploy/static/worker.js; the build fails if it doesn't
list a file the pages load (it would be proxied to a napping server).

Usage: python scripts/build_landing.py
Then:  npx wrangler deploy -c wrangler.landing.jsonc   (owner, with the route on)
"""

import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
DIST = REPO / "dist-landing"
PAGES = ["index.html", "join.html"]
EXTRA = ["static/version.json", "static/changelog.json"]  # fetched at runtime, not referenced in HTML


def referenced(html: str) -> set[str]:
    """Local /static/ files an HTML page references (scripts, styles, fonts, icons)."""
    return {m.lstrip("/") for m in re.findall(r'(?:src|href)="(/static/[^"?#]+)"', html)}


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    files: set[str] = set(EXTRA)
    for page in PAGES:
        html = (WEB / page).read_text()
        files |= referenced(html)
        (DIST / page).parent.mkdir(parents=True, exist_ok=True)
        (DIST / page).write_text(html)
    files |= {str(p.relative_to(WEB)) for p in (WEB / "static" / "fonts").glob("*.woff2")}
    for rel in sorted(files):
        src = WEB / rel
        if not src.is_file():
            raise SystemExit(f"missing: web/{rel}")
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    worker = (REPO / "deploy" / "static" / "worker.js").read_text()
    listed = set(re.findall(r"'(/static/[^']+)'", worker))
    missing = {"/" + f for f in files if not f.startswith("static/fonts/")} - listed
    if missing:
        raise SystemExit(f"deploy/static/worker.js doesn't serve: {sorted(missing)}")
    print(f"dist-landing/: {len(PAGES)} pages, {len(files)} static files")


if __name__ == "__main__":
    main()
