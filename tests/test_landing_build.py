"""server/src/landing_build.py: one function computes the "landing build id"
for both scripts/build_landing.py and GET /api/landing-build
(server/src/api/app.py), so the Worker's staleness check can trust that a
mismatch means a real difference.

Run: server/.venv/bin/python -m pytest tests/test_landing_build.py -v
"""

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "server"))

from src import landing_build  # noqa: E402


def test_id_is_stable_and_16_hex_chars():
    web_dir = REPO / "web"
    a = landing_build.landing_build_id(web_dir)
    b = landing_build.landing_build_id(web_dir)
    assert a == b
    assert len(a) == 16
    int(a, 16)  # hex


def test_build_landing_writes_the_same_id_the_module_computes():
    """scripts/build_landing.py must use this module, not a copy of its own
    logic — otherwise the build and the server could compute different ids
    for the same web/ directory and the Worker's check would be meaningless."""
    import json

    dist = REPO / "dist-landing"
    res = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "build_landing.py")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert res.returncode == 0, res.stderr + res.stdout
    written = json.loads((dist / "static" / "landing-build.json").read_text())
    assert written == {"id": landing_build.landing_build_id(REPO / "web")}


def _copy_landing_source(dst: Path) -> None:
    """A temp copy of exactly what landing_build.landing_files() needs, so a
    test can edit one file without touching the repo's real web/ directory."""
    web = REPO / "web"
    for page in landing_build.PAGES:
        (dst / page).write_bytes((web / page).read_bytes())
    for rel in landing_build.landing_files(web):
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        (dst / rel).write_bytes((web / rel).read_bytes())


def test_changing_one_landing_file_changes_the_id(tmp_path):
    _copy_landing_source(tmp_path)
    before = landing_build.landing_build_id(tmp_path)

    index = tmp_path / "index.html"
    index.write_text(index.read_text() + "\n<!-- edited -->\n")
    after_edit = landing_build.landing_build_id(tmp_path)
    assert after_edit != before

    # A referenced /static/ file changing also moves the id, not just the
    # two HTML pages themselves.
    referenced = sorted(rel for rel in landing_build.referenced(index.read_text()) if (tmp_path / rel).exists())
    assert referenced, "index.html should reference at least one /static/ file"
    changed_file = tmp_path / referenced[0]
    changed_file.write_bytes(changed_file.read_bytes() + b"\n/* edited */\n")
    after_asset_edit = landing_build.landing_build_id(tmp_path)
    assert after_asset_edit != after_edit


def test_release_metadata_is_not_part_of_landing_build_id(tmp_path):
    """Frequently rewritten footer metadata must not make landing stale."""
    _copy_landing_source(tmp_path)
    before = landing_build.landing_build_id(tmp_path)
    for rel in ("static/version.json", "static/changelog.json"):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"changed": true}')
    assert landing_build.landing_build_id(tmp_path) == before


def test_screenshot_slots_have_accessible_lazy_image_contract():
    script = (REPO / "web" / "static" / "landing.js").read_text()
    # Every listed shot is a real WebP within the screenshot budget.
    for src in re.findall(r"src: '(/static/shots/[^']+)'", script):
        shot = REPO / "web" / src.lstrip("/")
        assert shot.suffix == ".webp" and shot.is_file(), src
        assert shot.stat().st_size <= (120 if "photo" in shot.stem else 60) * 1024, src
    assert "img.width = shot.w" in script and "img.height = shot.h" in script
    assert "img.alt = shot.alt" in script and "img.loading = 'lazy'" in script
    assert "media.querySelector('.shots img, .lite:not([hidden])')" in script
    html = (REPO / "web" / "index.html").read_text()
    assert '<div class="media" id="how-media" hidden>' in html


def test_og_renderer_enforces_chat_preview_size_limit():
    source = (REPO / "scripts" / "generate_og_cards.py").read_text()
    assert "MAX_BYTES = 300 * 1024" in source
    assert "if len(data) > MAX_BYTES:" in source
