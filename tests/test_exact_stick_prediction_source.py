"""Stick predictions must match exactly in the rollback engine.

A tolerated stick mismatch skips the rollback and leaves the predicted value
in the predicting peer's game state (SSB64 stores raw stick bytes), so peers
drift with nothing to correct it. Held-stick jitter is filtered at the source
instead (KNShared.createStickDeadband, tested in stick-deadband.test.mjs).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_C = ROOT / "build/kn_rollback/kn_rollback.c"
ROLLBACK_JS = ROOT / "web/static/netplay-rollback.js"


def _feed_input_body() -> str:
    src = ROLLBACK_C.read_text()
    start = src.index("int kn_feed_input(int slot, int frame,")
    return src[start : src.index("\n}\n", start)]


def test_prediction_match_compares_every_field_exactly():
    body = re.sub(r"\s+", " ", _feed_input_body())
    assert (
        "int exact_match = (pred->buttons == buttons) && pred->lx == lx && pred->ly == ly "
        "&& pred->cx == cx && pred->cy == cy;" in body
    )
    assert "if (exact_match) {" in body


def test_no_stick_tolerance_remains():
    src = ROLLBACK_C.read_text()
    for name in ("KN_STICK_ZONE", "KN_STICK_TOLERANCE", "KN_AXIS_ZONE_MATCH", "stick_within_zone"):
        assert name not in src, name


def test_local_input_capture_goes_through_the_deadband():
    src = ROLLBACK_JS.read_text()
    assert "const _deadbandStick = KNShared.createStickDeadband();" in src
    # Both per-frame capture sites (C rollback tick and fallback tick).
    assert src.count("_deadbandStick(") == 2
