"""Supported-ROM list shown to users must match server/config/known_roms.json.

The lobby and play page hard-code the list so visitors see it before any
JS runs; this test catches drift when a ROM is added or removed.

Run: pytest tests/test_supported_roms.py -v
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWN_ROMS = json.loads((ROOT / "server" / "config" / "known_roms.json").read_text())


def test_lobby_lists_every_known_rom():
    html = (ROOT / "web" / "index.html").read_text()
    for rom in KNOWN_ROMS:
        # "Super Smash Bros." is listed with its region in a separate span
        assert rom["game"] in html, (
            f"index.html is missing supported ROM {rom['game']!r}"
        )


def test_lobby_rom_count_matches():
    html = (ROOT / "web" / "index.html").read_text()
    section = html.split('class="supported-roms"', 1)[1].split("</section>", 1)[0]
    assert section.count("<li>") == len(KNOWN_ROMS)


def test_play_page_hint_mentions_every_game():
    html = (ROOT / "web" / "play.html").read_text()
    hint = html.split('class="rom-hint rom-supported"', 1)[1].split("</p>", 1)[0]
    for rom in KNOWN_ROMS:
        name, _, version = rom["game"].rpartition(" ")
        if version[:1].isdigit():
            assert name in hint and version in hint, (
                f"play.html hint is missing {rom['game']!r}"
            )
        else:
            assert rom["game"] in hint, f"play.html hint is missing {rom['game']!r}"
