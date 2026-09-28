"""Session logs keep the newest entries (match 1cd13296: the host's log stopped
at exactly 4096 lines, about 90s into a 170s match)."""

import json

from src.api.signaling import _LOG_BLOB_MAX_LIST_LEN, _sanitize_log_blob, _session_log_entries


def _entries(n: int) -> list[dict]:
    return [{"seq": i, "t": 1000.5 + i, "f": i // 3, "msg": f"TICK f={i} line"} for i in range(n)]


def test_keeps_more_than_the_blob_list_cap():
    n = _LOG_BLOB_MAX_LIST_LEN * 3
    out = _session_log_entries(_entries(n), 12 * 1024 * 1024)
    assert len(out) == n
    assert out[0]["seq"] == 0 and out[-1]["seq"] == n - 1


def test_trims_the_oldest_to_fit_the_byte_cap():
    entries = _entries(5000)
    cap = len(json.dumps(entries)) // 2
    out = _session_log_entries(entries, cap)
    assert len(json.dumps(out)) <= cap
    assert out[-1]["seq"] == 4999  # newest kept
    assert 2400 < len(out) < 2600  # about half, oldest dropped
    assert out == entries[-len(out) :]


def test_caps_the_entry_count_to_the_client_ring():
    out = _session_log_entries(_entries(60_010), 64 * 1024 * 1024)
    assert len(out) == 60_000
    assert out[0]["seq"] == 10


def test_entries_are_still_sanitized():
    raw = [{"seq": 1, "msg": "ok\x00\x1b[31m bad\tkeep\nkeep"}, "not-a-dict", {"msg": "x" * 20000}]
    out = _session_log_entries(raw, 1024 * 1024)
    assert out[0]["msg"] == "ok[31m bad\tkeep\nkeep"
    assert out[1] == "not-a-dict"
    assert len(out[2]["msg"]) == 8192
    assert _session_log_entries("nope", 1024) == []


def test_ascii_fast_path_matches_the_full_scan():
    for s in ["plain ascii line f=12 [0,0]", "tab\tand\nnewline", "ctl\x07bell", "üñî​zw", ""]:
        slow = "".join(ch for ch in s if ch in "\n\t" or not __import__("unicodedata").category(ch).startswith("C"))
        assert _sanitize_log_blob(s) == slow[:8192]

