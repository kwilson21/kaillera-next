"""Smoke test: sync phase + prediction barrier code deployment.

Verifies:
1. Sync phase (sync-ping/pong) code exists
2. Prediction barrier is placed AFTER input send (encodeInput)
3. Barrier uses minRemoteFrame convergence gate
4. No hard freeze before input send path

Run: RUN_E2E=1 uv run pytest tests/test_sync_phase.py -v -s
"""

import os

import pytest
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_URL = os.environ.get("KN_TEST_URL", "https://localhost:27888")


@pytest.mark.skipif(
    not os.environ.get("RUN_E2E"),
    reason="Requires running server; set RUN_E2E=1 to enable",
)
def test_sync_phase_and_barrier_deployed(browser):
    """Verify sync phase and prediction barrier code in deployed JS."""
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()

    try:
        page.goto(
            f"{SERVER_URL}/play.html?room=SYNKTEST&host=1&name=SyncBot&mode=lockstep",
            wait_until="domcontentloaded",
            timeout=15000,
        )
        page.wait_for_function(
            "typeof window.KNState !== 'undefined'",
            timeout=10000,
        )

        result = page.evaluate(
            """() => {
                const scripts = Array.from(document.querySelectorAll('script[src]'));
                const lockstepSrc = scripts.find(s => s.src.includes('netplay-lockstep'));
                if (!lockstepSrc) return { error: 'lockstep script not found' };

                return fetch(lockstepSrc.src)
                    .then(r => r.text())
                    .then(src => {
                        // 1. Sync phase handlers exist
                        const hasSyncPing = src.includes("sync-ping:");
                        const hasSyncPong = src.includes("sync-pong:");
                        const hasSyncPhase = src.includes("_syncPhase");

                        // 2. Prediction barrier exists with convergence gate
                        const hasBarrier = src.includes("PACING-BARRIER");
                        const hasConvergenceGate = src.includes("minRemoteFrame >= _rbRollbackMax");

                        // 3. Critical ordering: barrier AFTER input send
                        // encodeInput is the input send; PACING-BARRIER must come after
                        const encodeIdx = src.lastIndexOf("encodeInput");
                        const barrierIdx = src.indexOf("PACING-BARRIER fAdv=");
                        const barrierAfterSend = barrierIdx > encodeIdx;

                        // 4. No hard freeze BEFORE input send
                        // Search for SAFETY-FREEZE (old pattern) before encodeInput
                        const oldFreezeBeforeSend = src.substring(0, encodeIdx).includes("SAFETY-FREEZE");

                        return {
                            hasSyncPing,
                            hasSyncPong,
                            hasSyncPhase,
                            hasBarrier,
                            hasConvergenceGate,
                            barrierAfterSend,
                            oldFreezeBeforeSend,
                            encodeIdx,
                            barrierIdx,
                        };
                    });
            }"""
        )
        print(f"\n[sync-test] Results: {result}")

        assert result.get("hasSyncPing"), "sync-ping handler missing"
        assert result.get("hasSyncPong"), "sync-pong handler missing"
        assert result.get("hasSyncPhase"), "_syncPhase variable missing"
        assert result.get("hasBarrier"), "PACING-BARRIER missing"
        assert result.get("hasConvergenceGate"), "convergence gate missing"
        assert result.get("barrierAfterSend"), (
            f"PACING-BARRIER (idx={result.get('barrierIdx')}) must come AFTER "
            f"encodeInput (idx={result.get('encodeIdx')})"
        )
        assert not result.get("oldFreezeBeforeSend"), (
            "Old SAFETY-FREEZE pattern still exists before input send — deadlock risk"
        )

        print("[sync-test] All checks passed")

    finally:
        page.close()
        ctx.close()
