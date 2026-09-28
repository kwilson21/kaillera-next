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


# ── context (with inputAudit) must fit one Cloudflare D1 row ──────────────────

_D1_ROW_MAX = 2_000_000  # bytes; D1 rejects larger rows


def _audit(n_bytes: int) -> dict:
    """About n_bytes of JSON shaped like a real audit: many small entries,
    within _sanitize_log_blob's limits (8 KB strings, 4096-item lists)."""
    items = [{"f": i, "b": "x" * 480} for i in range(max(1, n_bytes // 500))]
    return {f"slot{k}": items[k : k + 4000] for k in range(0, len(items), 4000)}


def test_context_keeps_a_small_input_audit():
    from src.api.signaling import _session_log_context

    out = json.loads(_session_log_context({"ua": "test"}, _audit(1000)))
    assert out["ua"] == "test"
    assert out["inputAudit"] == _audit(1000)


def test_context_drops_an_audit_that_would_overflow_a_d1_row():
    """~2.05 MB passed the old 2 MiB cap but is over D1's 2,000,000-byte row limit."""
    from src.api.signaling import _session_log_context

    out = json.loads(_session_log_context({"ua": "test"}, _audit(2_050_000)))
    assert out == {"ua": "test"}


def test_context_cap_leaves_room_for_the_rest_of_the_row():
    from src.api.signaling import _SESSION_LOG_CONTEXT_MAX, _session_log_context

    out = _session_log_context({"ua": "test"}, _audit(_SESSION_LOG_CONTEXT_MAX - 200))
    assert len(out.encode()) <= _SESSION_LOG_CONTEXT_MAX
    # summary (<= 4096) and the other session_logs columns share the row.
    assert _SESSION_LOG_CONTEXT_MAX + 4096 + 64 * 1024 < _D1_ROW_MAX


def test_context_too_big_without_the_audit_becomes_empty():
    from src.api.signaling import _session_log_context

    big = {f"k{i}": "y" * 8000 for i in range(200)}  # ~1.6 MB within sanitizer limits
    assert _session_log_context(big, None) == "{}"


def test_context_ignores_non_dict_input():
    from src.api.signaling import _session_log_context

    assert _session_log_context("not a dict", ["nope"]) == "{}"
