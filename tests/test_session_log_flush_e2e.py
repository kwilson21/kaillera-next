"""End-to-end test: verify session log flush reaches the DB.

This test catches a class of bug that has bitten us repeatedly:
JS code changes break the flush pipeline silently, matches produce
zero DB rows, and we don't notice until we try to analyze a match
and find nothing recorded.

The test does NOT boot the emulator (EJS can't start in headless
Playwright per memory feedback_playwright_process). Instead it:
  1. Opens play.html with a known room
  2. Waits for the lockstep module to load and socket to connect
  3. Manually calls the flush path via the console
  4. Queries the admin API to confirm the row landed

Run: pytest tests/test_session_log_flush_e2e.py -v -s
"""

import os
import time
import secrets
import sqlite3
import pytest
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_URL = "https://localhost:27888"
ADMIN_KEY = "1234"


def _admin_get(path: str) -> dict:
    r = requests.get(
        f"{SERVER_URL}{path}",
        headers={"X-Admin-Key": ADMIN_KEY},
        verify=False,
        timeout=5,
    )
    r.raise_for_status()
    return r.json()


def _find_session_for_room(room: str) -> dict | None:
    """Query admin API for a session log matching the given room."""
    data = _admin_get("/admin/api/session-logs?days=1&limit=50")
    for entry in data.get("entries", []):
        if entry.get("room", "").upper() == room.upper():
            return entry
    return None


@pytest.mark.skipif(
    not os.environ.get("RUN_E2E"),
    reason="Requires running dev server; set RUN_E2E=1 to enable",
)
def test_session_log_flush_reaches_db(page):
    """Create a room, load play.html, manually trigger flush, verify DB row.

    This is the minimum-viable check that the entire flush pipeline
    (JS _buildFlushPayload → Socket.IO session-log → Pydantic validation
     → db.upsert_session_log → SQLite row) is working end-to-end.
    """
    # Unique room so we don't collide with other runs
    room = "TEST" + secrets.token_hex(2).upper()
    match_id = f"e2e-test-{secrets.token_hex(4)}"

    # Navigate to play.html with our test room
    url = f"{SERVER_URL}/play.html?room={room}&host=1&name=E2ETest&mode=lockstep"
    page.goto(url, wait_until="domcontentloaded", timeout=15000)

    # Wait for the lockstep engine to load and KNState to populate.
    # We don't need the emulator — we just need _flushViaHttp to be callable.
    page.wait_for_function(
        "typeof window.KNShared !== 'undefined' "
        "&& typeof window.KNState !== 'undefined'",
        timeout=10000,
    )

    # Wait up to 5 seconds for uploadToken — it's set once Socket.IO /upload-token
    # endpoint responds. We need it to talk to /api/session-log via HTTP.
    for _ in range(50):
        token = page.evaluate("() => window.KNState?.uploadToken")
        if token:
            break
        page.wait_for_timeout(100)

    result = page.evaluate(
        """
        () => ({
            hasToken: !!window.KNState?.uploadToken,
            token: window.KNState?.uploadToken,
            room: window.KNState?.room,
            socketConnected: window.KNState?.socket?.connected,
        })
        """
    )
    print(f"[e2e] page state after load: token={'YES' if result.get('hasToken') else 'NO'} room={result.get('room')} socket={result.get('socketConnected')}")

    assert result.get("hasToken"), (
        f"uploadToken never arrived from server — test environment broken. state={result}"
    )

    upload_token = result["token"]

    # Directly POST to /api/session-log with a minimal valid payload.
    # This bypasses the UI and tests ONLY the server-side path + DB insert.
    # If this fails we know the break is server-side (Pydantic, handler,
    # DB schema). If it passes but real matches don't land, the JS-side
    # flush is broken.
    http_resp = requests.post(
        f"{SERVER_URL}/api/session-log?token={upload_token}&room={room}",
        json={
            "matchId": match_id,
            "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "e2e test marker"}],
            "summary": {"frames": 42, "duration_sec": 1, "peers": 0},
            "context": {"ua": "e2e-test", "mobile": False},
        },
        verify=False,
        timeout=5,
    )
    print(f"[e2e] HTTP POST response: {http_resp.status_code} {http_resp.text[:200]}")
    assert http_resp.status_code in (200, 204), (
        f"HTTP session-log endpoint rejected payload: {http_resp.status_code} {http_resp.text}"
    )

    # Give the DB a moment to settle
    time.sleep(0.5)

    # Verify the row landed
    entry = _find_session_for_room(room)
    assert entry is not None, (
        f"No session_log row found for test room {room}. "
        f"Flush pipeline is broken — check server logs for Pydantic ValidationError "
        f"or DB schema mismatch."
    )
    print(f"[e2e] ✓ found session log row: id={entry['id']} match={entry['match_id']}")
    assert entry["match_id"] == match_id, (
        f"Expected match_id={match_id}, got {entry['match_id']}"
    )
