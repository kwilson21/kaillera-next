"""Test that lockstep mode produces identical game state on both emulators.

Run: pytest tests/test_desync.py -v -s
"""
import time


def test_lockstep_no_desync(browser, server_url):
    """Two players in lockstep should have identical game state at the same frame."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=DSYNC1&host=1&name=Host&mode=lockstep-v4")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room=DSYNC1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        host.wait_for_function("window._lockstepActive === true", timeout=60000)
        guest.wait_for_function("window._lockstepActive === true", timeout=60000)

        # Inject a hook on BOTH sides: capture state at exactly frame 300.
        # Using a 1ms polling interval ensures we don't miss the exact frame.
        target_frame = 300
        capture_js = f"""() => {{
            window._captureAtFrame = {target_frame};
            window._capturedState = null;
            var check = setInterval(() => {{
                if (window._frameNum === window._captureAtFrame && !window._capturedState) {{
                    var gm = window.EJS_emulator.gameManager;
                    var state = gm.getState();
                    var bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
                    var hash = 0x811c9dc5;
                    var len = Math.min(bytes.length, 65536);
                    for (var i = 0; i < len; i++) {{
                        hash ^= bytes[i];
                        hash = Math.imul(hash, 0x01000193);
                    }}
                    window._capturedState = {{
                        hash: hash | 0,
                        frameNum: window._frameNum,
                        stateSize: bytes.length,
                        first2k: Array.from(bytes.slice(0, 2048))
                    }};
                    clearInterval(check);
                }}
            }}, 1);
        }}"""

        host.evaluate(capture_js)
        guest.evaluate(capture_js)

        host.wait_for_function("window._capturedState !== null", timeout=120000)
        guest.wait_for_function("window._capturedState !== null", timeout=120000)

        h = host.evaluate("window._capturedState")
        g = guest.evaluate("window._capturedState")

        print(f"\nHost:  frame={h['frameNum']} hash={h['hash']} size={h.get('stateSize')}")
        print(f"Guest: frame={g['frameNum']} hash={g['hash']} size={g.get('stateSize')}")

        assert h['frameNum'] == target_frame, f"Host captured at wrong frame: {h['frameNum']}"
        assert g['frameNum'] == target_frame, f"Guest captured at wrong frame: {g['frameNum']}"

        if h['hash'] != g['hash']:
            hb = h['first2k']
            gb = g['first2k']
            diffs = [(i, hb[i], gb[i]) for i in range(min(len(hb), len(gb))) if hb[i] != gb[i]]
            print(f"\nDifferences in first 2KB: {len(diffs)} bytes differ")
            for offset, hv, gv in diffs[:20]:
                print(f"  offset {offset} (0x{offset:04x}): host=0x{hv:02x} guest=0x{gv:02x}")

            # Check if forked core was detected
            has_fork = host.evaluate(
                "window.EJS_emulator && window.EJS_emulator.gameManager && "
                "window.EJS_emulator.gameManager.Module && "
                "typeof window.EJS_emulator.gameManager.Module._kn_set_deterministic === 'function'"
            )
            print(f"\nForked core detected: {has_fork}")

            assert False, (
                f"DESYNC DETECTED at frame {target_frame}: "
                f"host hash={h['hash']}, guest hash={g['hash']}, "
                f"{len(diffs)} bytes differ in first 2KB"
            )

        print(f"\nSUCCESS: No desync after {target_frame} frames!")

    finally:
        host.close()
        guest.close()


def test_lockstep_frame_pacing(browser, server_url):
    """Verify both emulators advance at the same rate (network-paced)."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=PACE1&host=1&name=Host&mode=lockstep-v4")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room=PACE1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        host.wait_for_function("window._lockstepActive === true", timeout=60000)
        guest.wait_for_function("window._lockstepActive === true", timeout=60000)

        # Sample frame numbers every second for 5 seconds
        samples = []
        for _ in range(5):
            time.sleep(1)
            h_frame = host.evaluate("window._frameNum")
            g_frame = guest.evaluate("window._frameNum")
            diff = abs(h_frame - g_frame)
            samples.append((h_frame, g_frame, diff))
            print(f"  Host: {h_frame}, Guest: {g_frame}, Diff: {diff}")

        max_diff = max(s[2] for s in samples)
        assert max_diff <= 10, f"Frame pacing too divergent: max diff = {max_diff}"

        h_advance = samples[-1][0] - samples[0][0]
        g_advance = samples[-1][1] - samples[0][1]
        assert h_advance > 100, f"Host stalled: only advanced {h_advance} frames in 5s"
        assert g_advance > 100, f"Guest stalled: only advanced {g_advance} frames in 5s"

        print(f"\nFrame pacing OK: max diff = {max_diff}, host rate = {h_advance/5:.0f}fps, guest rate = {g_advance/5:.0f}fps")

    finally:
        host.close()
        guest.close()
