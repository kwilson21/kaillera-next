"""Check the per-peer report against modern and legacy session exports."""

import json
import runpy
import sys
from pathlib import Path
from types import ModuleType

import pytest


@pytest.fixture
def analyze(tmp_path, monkeypatch, capsys):
    # This JSONL report runs independently of the CLI's optional SQL engine.
    monkeypatch.setitem(sys.modules, "duckdb", ModuleType("duckdb"))
    script = Path(__file__).resolve().parents[1] / "tools" / "analyze_match.py"
    query = runpy.run_path(str(script))["query_tick_performance"]

    def run(*rows):
        (tmp_path / "session-1.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        query(str(tmp_path))
        return capsys.readouterr().out

    return run


def tick(frame, time_ms, dropped=None, **fields):
    msg = f"TICK-PERF f={frame} fps=60.0 tickMs median=16.0 p95=24.0"
    if dropped is not None:
        msg += f" droppedSlots={dropped} catchupFrames=0"
    return {"t": time_ms, "f": frame, "msg": msg, **fields}


def cadence(status, samples=0, **fields):
    return {"slot": 0, "msg": "CANVAS-CADENCE " + json.dumps({"status": status, "samples": samples, **fields})}


def test_wall_time_weights_windows_and_locates_the_stall(analyze):
    report = analyze(
        {"_kind": "meta", "slot": 2, "context": {"mobile": True}},
        tick(300, 5000, 10, seq=20),
        {"msg": "PACING-THROTTLE", "seq": 21},
        tick(600, 10000, 10, seq=22),
        tick(900, 25000, 610, seq=23),
    )
    assert "Slot 2 (mobile): gameFps=30.0 (2 windows)" in report
    assert "f=600–900: 20.0 game fps over 15.0s (reported tick rate 60.0Hz) droppedSlots=600" in report
    assert "f=300–600:" not in report


def test_headerless_legacy_log_counts_first_sample_and_recovers_after_a_gap(analyze):
    report = analyze(tick(300, 1000, slot=1), tick(600, 11000), tick(1200, 11500), tick(1500, 16500))
    assert "Slot 1 (unknown device): gameFps=40.0 (2 windows)" in report
    assert "f=300–600: 30.0 game fps" in report
    assert "droppedSlots=" not in report


@pytest.mark.parametrize(
    "middle",
    [
        {"msg": "sync frame reset: 450 → 499", "seq": 2},
        {"msg": "sync #12 applied (frame 490 -> 500, next in 600f)", "seq": 2},
        {"msg": "tick scheduler target=16.67ms pump=4ms", "seq": 2},
        {"msg": "SYNC-CATCH-UP from=410 to=599 of=599 frames=189", "seq": 2},
        {"msg": "PACING", "seq": 50},
        None,
    ],
)
def test_resets_and_incomplete_records_break_only_the_affected_window(analyze, middle):
    report = analyze(tick(300, 10, seq=1), middle, tick(600, 1010, seq=3), tick(900, 6010, seq=4))
    assert "gameFps=60.0 (1 window)" in report


@pytest.mark.parametrize("end", [tick(600, None), tick(600, 100), tick(600, 101, 0)])
def test_unusable_tick_pairs_leave_game_fps_unavailable(analyze, end):
    report = analyze(tick(300, 100, 100), end)
    assert "gameFps=unavailable (0 windows)" in report
    assert "median=16.0 p95=24.0" in report


def test_capture_report_uses_latest_measured_summary(analyze):
    report = analyze(
        cadence("waiting-for-frame"),
        cadence("measuring", samples=40, recentSamples=40, missedCallbacks=0, p95GapMs=27, maxGapMs=31),
        cadence(
            "measuring",
            samples=725,
            recentSamples=600,
            missedCallbacks=4,
            p95GapMs=21.5,
            maxGapMs=126,
            lastFrameAgeMs=48.5,
            worstGaps=[{"ms": 126, "fromFrame": 1050, "toFrame": 1052, "ticks": {"paths": {"stall": 3}, "maxMs": 92}}],
        ),
        cadence("measuring", samples=730),  # incomplete measurement
        cadence("capture-disabled"),
        {"msg": "CANVAS-CADENCE truncated"},
    )
    assert "samples=725 missedCallbacks=4 p95GapMs=21.5 (last 600 samples) maxGapMs=126 lastFrameAgeMs=48.5" in report
    assert 'Worst gap: 126ms f=1050–1052 tickMaxMs=92 paths={"stall": 3}' in report
    assert "samples=40" not in report


def test_capture_only_status_survives_without_tick_reports(analyze):
    report = analyze(cadence("waiting-for-frame"), cadence("unsupported"))
    assert "Capture-video cadence: unsupported" in report
    assert "gameFps" not in report
