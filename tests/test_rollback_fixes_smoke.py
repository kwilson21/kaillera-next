"""End-to-end smoke test for the rollback hardening fixes shipped today.

Verifies that the deployed JS + WASM expose the new diagnostic and
runtime knobs we've been shipping. Doesn't actually run a match (EJS
can't boot in headless Playwright per project memory), but does check
that the new exports/APIs exist on the page once everything's loaded.

Run: RUN_E2E=1 pytest tests/test_rollback_fixes_smoke.py -v -s
"""

import os

import pytest
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_URL = "https://localhost:27888"


@pytest.mark.skipif(
    not os.environ.get("RUN_E2E"),
    reason="Requires running dev server; set RUN_E2E=1 to enable",
)
def test_rollback_fixes_smoke(page):
    """Load play.html and verify all new APIs from today's session exist."""
    # Use a fresh test room so we don't collide with anything
    url = f"{SERVER_URL}/play.html?room=SMOKE001&host=1&name=SmokeBot&mode=lockstep"
    page.goto(url, wait_until="domcontentloaded", timeout=15000)

    # Wait for KNShared + KNState to populate (loadable JS modules)
    page.wait_for_function(
        "typeof window.KNShared !== 'undefined' && typeof window.KNState !== 'undefined'",
        timeout=10000,
    )

    # Enable knDiag for the test
    page.evaluate("() => { localStorage.setItem('kn-debug', '1'); }")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function(
        "typeof window.KNShared !== 'undefined' && typeof window.knDiag !== 'undefined'",
        timeout=10000,
    )

    # Check 1: knDiag is wired up with the new methods
    api_check = page.evaluate(
        """() => ({
            hasReplaySelfTest: typeof window.knDiag?.replaySelfTest === 'function',
            hasReplayBisect: typeof window.knDiag?.replayBisect === 'function',
            hasNetsim: typeof window.knDiag?.netsim === 'function',
            hasSetTransport: typeof window.knDiag?.setTransport === 'function',
            knDiagKeys: Object.keys(window.knDiag || {}),
        })"""
    )
    print(f"\n[smoke] knDiag API: {api_check}")
    assert api_check["hasNetsim"], "knDiag.netsim missing — Fix 2 testing infrastructure not deployed"
    assert api_check["hasSetTransport"], "knDiag.setTransport missing — transport override not deployed"
    assert api_check["hasReplayBisect"], "knDiag.replayBisect missing"
    assert api_check["hasReplaySelfTest"], "knDiag.replaySelfTest missing"

    # Check 2: setTransport returns expected values
    set_result = page.evaluate(
        """() => {
            const r1 = window.knDiag.setTransport('unreliable');
            const r2 = window.knDiag.setTransport('reliable');
            const r3 = window.knDiag.setTransport(null);
            const r4 = window.knDiag.setTransport('garbage');
            return { r1, r2, r3, r4 };
        }"""
    )
    print(f"[smoke] setTransport behavior: {set_result}")
    assert set_result["r1"] == "unreliable"
    assert set_result["r2"] == "reliable"
    assert set_result["r3"] is None
    assert set_result["r4"] is None  # invalid input rejected

    # Check 3: netsim accepts spec, reports state, can be disabled
    netsim_result = page.evaluate(
        """() => {
            const before = window.knDiag.netsim();
            const enabled = window.knDiag.netsim({ jitterMs: 50, dropPct: 2 });
            const after = window.knDiag.netsim();
            const disabled = window.knDiag.netsim(null);
            const final = window.knDiag.netsim();
            return { before, enabled, after, disabled, final };
        }"""
    )
    print(f"[smoke] netsim lifecycle: {netsim_result}")
    assert netsim_result["before"] is None, "netsim should not be active by default"
    assert netsim_result["enabled"]["jitterMs"] == 50
    assert netsim_result["enabled"]["dropPct"] == 2
    assert netsim_result["disabled"] is None
    assert netsim_result["final"] is None

    # Check 4: New WASM exports are reachable (or gracefully missing if EJS
    # hasn't booted). The presence check is "the function reference exists
    # on Module if Module exists." We don't try to call them because they
    # require the emulator to be initialized.
    module_check = page.evaluate(
        """() => {
            const m = window.EJS_emulator?.gameManager?.Module;
            if (!m) return { hasModule: false, note: 'emulator not booted (expected in headless)' };
            return {
                hasModule: true,
                hasGetToleranceHits: typeof m._kn_get_tolerance_hits === 'function',
                hasGetMispredBreakdown: typeof m._kn_get_mispred_breakdown === 'function',
                hasStateRegionHashesFrame: typeof m._kn_state_region_hashes_frame === 'function',
                hasGetStateBufferSize: typeof m._kn_get_state_buffer_size === 'function',
                hasGetRdramOffsetInState: typeof m._kn_get_rdram_offset_in_state === 'function',
            };
        }"""
    )
    print(f"[smoke] WASM Module check: {module_check}")
    # We don't assert hasModule — emulator can't boot in headless. We assert
    # that IF it's there, all the new exports are present (proves the WASM
    # served to the page IS the latest build, not a cached old version).
    if module_check.get("hasModule"):
        assert module_check["hasGetToleranceHits"]
        assert module_check["hasGetMispredBreakdown"]
        assert module_check["hasStateRegionHashesFrame"]
        assert module_check["hasGetStateBufferSize"]
        assert module_check["hasGetRdramOffsetInState"]

    print("[smoke] ✓ all rollback hardening APIs present")
