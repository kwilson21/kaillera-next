"""Smoke test: GGPO-style sync phase code is deployed and wired up.

Verifies the sync phase variables and handlers exist in the deployed JS.
Full E2E validation requires two real emulators (tested via prod session logs).

Run: RUN_E2E=1 uv run pytest tests/test_sync_phase.py -v -s
"""

import os
import time

import pytest
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_URL = os.environ.get("KN_TEST_URL", "https://localhost:27888")


@pytest.mark.skipif(
    not os.environ.get("RUN_E2E"),
    reason="Requires running server; set RUN_E2E=1 to enable",
)
def test_sync_phase_code_deployed(browser):
    """Verify sync phase code exists in the deployed lockstep JS."""
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()

    room = f"SYNK{int(time.time()) % 10000:04d}"

    try:
        page.goto(
            f"{SERVER_URL}/play.html?room={room}&host=1&name=SyncBot&mode=lockstep",
            wait_until="domcontentloaded",
            timeout=15000,
        )
        page.wait_for_function(
            "typeof window.KNState !== 'undefined'",
            timeout=10000,
        )

        # Check that the lockstep JS contains sync-phase code
        has_sync = page.evaluate(
            """() => {
                // Fetch the lockstep JS source and verify sync-ping/pong handlers
                const scripts = Array.from(document.querySelectorAll('script[src]'));
                const lockstepSrc = scripts.find(s => s.src.includes('netplay-lockstep'));
                if (!lockstepSrc) return { error: 'lockstep script not found' };

                // Check via fetch since we can read the source
                return fetch(lockstepSrc.src)
                    .then(r => r.text())
                    .then(src => ({
                        hasSyncPing: src.includes('sync-ping:'),
                        hasSyncPong: src.includes('sync-pong:'),
                        hasSyncPhase: src.includes('_syncPhase'),
                        hasSyncRounds: src.includes('_SYNC_ROUNDS'),
                        hasConvergenceGate: src.includes('minRemoteFrame >= _rbRollbackMax'),
                        sourceLength: src.length,
                    }));
            }"""
        )
        print(f"\n[sync-test] Code check: {has_sync}")

        assert has_sync.get("hasSyncPing"), "sync-ping handler missing from deployed JS"
        assert has_sync.get("hasSyncPong"), "sync-pong handler missing from deployed JS"
        assert has_sync.get("hasSyncPhase"), "_syncPhase variable missing from deployed JS"
        assert has_sync.get("hasSyncRounds"), "_SYNC_ROUNDS constant missing from deployed JS"
        assert has_sync.get("hasConvergenceGate"), (
            "convergence gate (minRemoteFrame >= _rbRollbackMax) missing from deployed JS"
        )

        print("[sync-test] All sync phase code verified in deployed JS")

    finally:
        page.close()
        ctx.close()
