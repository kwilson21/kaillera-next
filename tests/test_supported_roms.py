"""Supported-ROM lists shown to users must match server/config/known_roms.json.

The lobby and play page hard-code the list so visitors see it before any
JS runs; these tests catch drift when a ROM is added, removed or changes
region. (The unsupported-ROM toast in play.js builds its list from
/api/rom-hashes, so it can't drift.)

Run: pytest tests/test_supported_roms.py -v
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWN_ROMS = json.loads((ROOT / "server" / "config" / "known_roms.json").read_text())
EXPECTED_GAMES = {rom["game"] for rom in KNOWN_ROMS}
REGIONS = {rom["game"]: rom.get("region") for rom in KNOWN_ROMS}

_REGION_SUFFIX = re.compile(r"^(?P<game>.*?)(?:\s+\((?P<region>[^)]+)\))?$")


def _parse_entries(entries):
    """Split "Game (REGION)" labels into {game: region-or-None}."""
    parsed = {}
    for entry in entries:
        m = _REGION_SUFFIX.match(" ".join(entry.split()))
        parsed[m["game"]] = m["region"]
    return parsed


def _assert_matches_config(parsed, where):
    assert set(parsed) == EXPECTED_GAMES, (
        f"{where} lists {sorted(parsed)}, expected {sorted(EXPECTED_GAMES)}"
    )
    for game, region in parsed.items():
        assert region == REGIONS[game], (
            f"{where} shows {game!r} with region {region!r}, config says {REGIONS[game]!r}"
        )


def test_lobby_lists_exactly_the_known_roms():
    html = (ROOT / "web" / "index.html").read_text()
    section = html.split('class="supported-roms"', 1)[1].split("</section>", 1)[0]
    items = [
        re.sub(r"<[^>]+>", "", li)
        for li in re.findall(r"<li>(.*?)</li>", section, re.S)
    ]
    _assert_matches_config(_parse_entries(items), "index.html")


def test_play_page_hint_lists_exactly_the_known_roms():
    html = (ROOT / "web" / "play.html").read_text()
    hint = " ".join(
        html.split('class="rom-hint rom-supported">', 1)[1].split("</p>", 1)[0].split()
    )
    assert hint.startswith("Supported: ")
    _assert_matches_config(
        _parse_entries(hint.removeprefix("Supported: ").split(", ")), "play.html"
    )
