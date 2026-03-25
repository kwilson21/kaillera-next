"""Test the input resend protocol for INPUT-STALL recovery.

Validates that when a peer's input is missing past MAX_STALL_MS (3s),
a resend request is sent and the peer re-sends from _localInputs.

Expects the dev server to be running on localhost:27888.
Run: pytest tests/test_input_resend.py -v -s --no-header
"""
import time

import pytest

SERVER_URL = "http://localhost:27888"
ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


@pytest.fixture
def server_url():
    """Use the already-running dev server."""
    return SERVER_URL


def _load_rom(page):
    page.set_input_files("#rom-drop input[type=file]", ROM_PATH)


def test_input_resend_on_stall(browser, server_url):
    """Block guest input sending, verify host sends resend request and recovers."""
    host = browser.new_page()
    guest = browser.new_page()
    host_logs = []
    guest_logs = []

    def _log(logs, msg):
        try:
            logs.append(msg.text)
        except Exception:
            pass

    host.on("console", lambda msg: _log(host_logs, msg))
    guest.on("console", lambda msg: _log(guest_logs, msg))

    try:
        host.goto(f"{server_url}/play.html?room=RESND1&host=1&name=Host&mode=lockstep")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room=RESND1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host)
        _load_rom(guest)
        time.sleep(1)

        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        print("\n  Starting game...")
        host.click("#start-btn")

        print("  Waiting for lockstep to activate (WASM boot)...")
        host.wait_for_function("window._lockstepActive === true", timeout=120000)
        print("  Host lockstep active")
        guest.wait_for_function("window._lockstepActive === true", timeout=120000)
        print("  Guest lockstep active")

        # Let the game run normally for 2 seconds to establish baseline
        time.sleep(2)
        frame_before = host.evaluate("window._frameNum")
        assert frame_before > 60, f"Game not running: only at frame {frame_before}"

        # Block guest's binary DC sends (inputs) for 4 seconds.
        # String sends (including resend responses) still work.
        # After 4s, restore normal sending — the resend handler should
        # have already re-sent the missing inputs.
        guest.evaluate("""() => {
            window._inputsBlocked = 0;
            window._resendResponses = 0;
            var peers = window.NetplayLockstep._getPeers() || {};
            Object.values(peers).forEach(function(p) {
                if (!p.dc) return;
                var origSend = p.dc.send.bind(p.dc);
                p.dc._origSend = origSend;
                p.dc.send = function(data) {
                    // Block binary sends (8-byte inputs) but allow strings
                    if (data instanceof ArrayBuffer && data.byteLength === 8 && window._blockInputs) {
                        window._inputsBlocked++;
                        return;
                    }
                    return origSend(data);
                };
            });
            window._blockInputs = true;
            console.log('[test] input blocking enabled');
            setTimeout(function() {
                window._blockInputs = false;
                console.log('[test] input blocking disabled after 4s, blocked ' + window._inputsBlocked + ' inputs');
            }, 4000);
        }""")

        # Wait for the block period + resend window (4s block + 1s margin)
        time.sleep(5.5)

        # Check host logs for resend-request
        resend_requests = [l for l in host_logs if 'INPUT-STALL resend-request' in l]
        hard_timeouts = [l for l in host_logs if 'INPUT-STALL hard-timeout' in l]

        print(f"\n  Resend requests sent by host: {len(resend_requests)}")
        print(f"  Hard timeouts on host: {len(hard_timeouts)}")
        if resend_requests:
            print(f"  First resend: {resend_requests[0]}")

        # The host should have sent at least one resend request
        assert len(resend_requests) > 0, "Host never sent a resend request during stall"

        # Game should still be advancing (not permanently stuck)
        frame_after = host.evaluate("window._frameNum")
        print(f"  Frames: before={frame_before} after={frame_after}")
        assert frame_after > frame_before, "Game stopped advancing after stall"

        # If any hard timeouts occurred, verify they fabricated 0 (not _lastKnownInput)
        for ht in hard_timeouts:
            assert '=0' in ht, f"Hard timeout used non-zero fabrication: {ht}"

        print(f"\n  Input resend protocol working correctly!")

    finally:
        host.close()
        guest.close()


def test_hard_timeout_fabricates_zero(browser, server_url):
    """When resend also fails, fabrication must use 0 (deterministic)."""
    host = browser.new_page()
    guest = browser.new_page()
    host_logs = []

    def _log(logs, msg):
        try:
            logs.append(msg.text)
        except Exception:
            pass

    host.on("console", lambda msg: _log(host_logs, msg))

    try:
        host.goto(f"{server_url}/play.html?room=HTIME1&host=1&name=Host&mode=lockstep")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room=HTIME1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host)
        _load_rom(guest)
        time.sleep(1)

        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        host.wait_for_function("window._lockstepActive === true", timeout=120000)
        guest.wait_for_function("window._lockstepActive === true", timeout=120000)

        time.sleep(2)

        # Block ALL guest DC sends (binary AND string) so resend response
        # never reaches the host — forces hard timeout
        guest.evaluate("""() => {
            var peers = window.NetplayLockstep._getPeers() || {};
            Object.values(peers).forEach(function(p) {
                if (!p.dc) return;
                var origSend = p.dc.send.bind(p.dc);
                p.dc.send = function(data) {
                    // Block everything
                    return;
                };
            });
            console.log('[test] all DC sends blocked');
        }""")

        # Wait for full timeout: MAX_STALL_MS (3s) + RESEND_TIMEOUT_MS (2s) + margin
        time.sleep(6.5)

        hard_timeouts = [l for l in host_logs if 'INPUT-STALL hard-timeout' in l]
        print(f"\n  Hard timeouts: {len(hard_timeouts)}")
        for ht in hard_timeouts:
            print(f"    {ht}")

        assert len(hard_timeouts) > 0, "Expected hard timeout when resend fails"

        # Every fabricated value must be 0
        for ht in hard_timeouts:
            # Parse "fabricated=[s1=0]" — every slot must be =0
            if 'fabricated=[' in ht:
                fab_part = ht.split('fabricated=[')[1].split(']')[0]
                entries = fab_part.split(',')
                for entry in entries:
                    val = entry.split('=')[1]
                    assert val == '0', f"Non-zero fabrication detected: {entry} in {ht}"

        print(f"\n  Hard timeout correctly fabricates 0 for all slots!")

    finally:
        host.close()
        guest.close()
