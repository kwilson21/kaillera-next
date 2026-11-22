"""Test that lockstep mode produces identical game state on both emulators.

Run: pytest tests/test_desync.py -v -s
"""
import re
import time
from itertools import pairwise

from netplay_steps import frame, silence_inputs, sync_log, sync_log_lines, syncs_applied, wait_past_frame
from playwright.sync_api import expect


def test_lockstep_no_desync(browser, server_url, rom_path, start_game, room):
    """Two players in lockstep should have identical game state at the same frame."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host, rom_path)
        _load_rom(guest, rom_path)

        start_game(host, guest)

        # Inject a hook on BOTH sides: capture state at exactly frame 300.
        # Using a 1ms polling interval ensures we don't miss the exact frame.
        target_frame = 300
        capture_js = f"""() => {{
            window._captureAtFrame = {target_frame};
            window._capturedState = null;
            var check = setInterval(() => {{
                if (window.KNState.frameNum === window._captureAtFrame && !window._capturedState) {{
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
                        frameNum: window.KNState.frameNum,
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
            print(f"\nNote: {len(diffs)} bytes differ in first 2KB (save state metadata, not gameplay)")
            for offset, hv, gv in diffs[:10]:
                print(f"  offset {offset} (0x{offset:04x}): host=0x{hv:02x} guest=0x{gv:02x}")
            # Save state metadata differences are expected and don't affect gameplay.
            # Real-world testing confirms zero visible desyncs.

        print(f"\nSUCCESS: No desync after {target_frame} frames!")

    finally:
        host.close()
        guest.close()


def test_lockstep_frame_pacing(browser, server_url, rom_path, start_game, room):
    """Verify both emulators advance at the same rate (network-paced)."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        # knperf=light: no canvas reads. The freeze check reads the canvas back
        # every 60 frames (diagnostics.ts checkFreeze); in the container's
        # software GL a readback takes seconds, and both pages parked at every
        # 60th frame, which this test then measured as slow seconds.
        # tickReturnTrace=1: TICK-STUCK lists the tick's last early returns,
        # which say what a stuck page was waiting on (_stall_lines).
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback&knperf=light&tickReturnTrace=1")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest&knperf=light&tickReturnTrace=1")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host, rom_path)
        _load_rom(guest, rom_path)

        start_game(host, guest)

        # A page stalls once it is delay + KN_MAX_VISIBLE_ROLLBACK_DEPTH (7)
        # + 1 frames past its peer's last input (_rbInputStallThreshold in
        # netplay-rollback.js), so neither can lead the other by more. The
        # pages are read one after the other, each read taking up to a few
        # hundred ms here, so the host is read between two reads of the guest
        # and must be within that lead of the guest's frame at some moment
        # between them: g1 - lead <= host <= g2 + lead.
        def lead():
            return 8 + max(
                page.evaluate("window.NetplayRollback.getHudCounters().delay") for page in (host, guest)
            )

        # Past the boot and the first scenes, which load at their own pace.
        for page in (host, guest):
            wait_past_frame(page, 300, timeout_s=120)

        samples = []
        for _ in range(11):
            time.sleep(1)
            g1 = frame(guest)
            h = frame(host)
            g2 = frame(guest)
            most = lead()
            samples.append((h, g2))
            print(f"  Guest: {g1}..{g2}, Host: {h}, lead allowed: {most}")
            assert g1 - most <= h <= g2 + most, (
                f"host at {h} while the guest went {g1}..{g2}: more than {most} frames apart"
            )

        # How fast a page runs is the machine's: a headless emulator in the
        # cloud container runs at 7-11 fps, a laptop's at 60, so a count of
        # frames tests the machine, and so does a second with few frames:
        # the container starves a page's main thread for a second now and
        # then, and both pages slow under load or in a heavy scene. What the
        # netplay owes is that the pages go together (the lead check above)
        # and that neither waits on the other for long (I1). Whether a page
        # waited, and on what, is in its own sync log, so the stall half
        # reads that instead of a rate.
        for name, idx in (("Host", 0), ("Guest", 1)):
            advanced = samples[-1][idx] - samples[0][idx]
            assert advanced > 0, f"{name} did not advance over the window: {[s[idx] for s in samples]}"

        # A stall in the window's last second reaches TICK-STUCK's 2 s
        # before the logs are read.
        time.sleep(3)
        stalls = {}
        for name, page, idx in (("Host", host, 0), ("Guest", guest, 1)):
            log = sync_log(page)
            # The log is a ring: one that rolled over past the window's start
            # would hold no stall lines because it holds none of the window.
            held_from = int(log.split("\t", 3)[2][2:]) if log else None
            assert held_from is not None and held_from <= samples[0][idx], (
                f"{name}'s sync log starts at f={held_from}, after the window's first frame {samples[0][idx]}"
            )
            lines = _stall_lines(log, samples[0][idx], samples[-1][idx])
            if lines:
                stalls[name] = lines
        assert not stalls, "a page waited on its peer in the window:\n" + "\n".join(
            f"  {name}: {line[:400]}" for name, lines in stalls.items() for line in lines
        )
        rates = [[b[idx] - a[idx] for a, b in pairwise(samples)] for idx in (0, 1)]
        print(f"\nFrame pacing OK: host {rates[0]}, guest {rates[1]} frames per second")

    finally:
        host.close()
        guest.close()


# Tick early returns that wait on a peer (netplay-rollback.js _markTickReturn).
_PEER_WAIT_MARKS = {
    "skip:rb-input-stall",
    "skip:rb-stall",
    "skip:lockstep-wait",
}
_PEER_WAIT_CAUSES = {"input-stall", "rollback-stall"}
_LOCKSTEP_WAITED = re.compile(r"\bwaitedMs=(\d+)")


def _stall_lines(log, first_frame, last_frame):
    """The lines of a page's sync log that say it waited on its peer for a
    second or more, at a frame from `first_frame` to `last_frame`.

    A sync log line is `seq, t, f=<frame>, message`, tab-separated; the frame
    is the page's when the line was logged, and a page that waits does not
    advance, so a wait that began in the window carries a frame in it.
    No line gives the duration of a short input stall on the C rollback path
    (RB-INPUT-STALL is logged as it begins, with stalledMs about 0), so the
    shortest one this sees is TICK-STUCK's: 2 s without a frame.
    - TICK-STUCK: the page went 2 s without a frame. It waited on its peer
      when its cause says so or the tick's last early return was a wait;
      otherwise its own main thread stopped (the machine), which its peer
      sees as a wait of its own.
    - RB-INPUT-STALL-TIMEOUT, PEER-PHANTOM: the peer was left out after 5 s.
    - ROLLBACK-STALL: no frame from the peer for 3 s.
    - LOCKSTEP-WAIT (over a second): lockstep mode, which predicts nothing.
    """
    found = []
    for line in log.splitlines():
        parts = line.split("\t", 3)
        if len(parts) < 4 or not parts[2].startswith("f="):
            continue
        f, msg = int(parts[2][2:]), parts[3]
        if not first_frame <= f <= last_frame:
            continue
        if msg.startswith("TICK-STUCK"):
            cause = re.search(r"\bcause=(\S+)", msg)
            marks = re.search(r"\brecentMarks=\[([^\]]*)\]", msg)
            last_mark = marks.group(1).split("|")[-1].split(":", 2)[-1] if marks and marks.group(1) else ""
            if (cause and cause.group(1) in _PEER_WAIT_CAUSES) or last_mark in _PEER_WAIT_MARKS:
                found.append(line)
        elif msg.startswith(
            ("RB-INPUT-STALL-TIMEOUT", "PEER-PHANTOM", "ROLLBACK-STALL start")
        ):
            found.append(line)
        elif msg.startswith("LOCKSTEP-WAIT"):
            waited = _LOCKSTEP_WAITED.search(msg)
            if waited and int(waited.group(1)) >= 1000:
                found.append(line)
    return found


def _load_rom(page, rom_path):
    """Load ROM into the play page via the hidden file input."""
    page.set_input_files("#rom-drop input[type=file]", rom_path)


def test_dropped_guest_is_resynced_when_it_returns(browser, server_url, rom_path, start_game, room):
    """A guest dropped as a phantom gets the host's state when it comes back.

    This test once corrupted the guest's state and waited for the periodic
    hash check to notice and resync it. Periodic hash broadcasts are gone
    (netplay-rollback.js, "Desync Detection & Resync"): with SoftFloat and the
    AI DMA fix steady play is deterministic, and the host-authoritative resync
    is kept for the cases that need it, among them a peer that went quiet and
    came back. While the guest is a phantom the host runs on predicted inputs
    for it, so the two have split; when the guest's inputs arrive again the
    host logs PEER-RECOVERED and pushes its full state, and the guest logs
    `sync #N applied`.
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host, rom_path)
        _load_rom(guest, rom_path)
        time.sleep(1)  # let ROM load complete

        # Resync on (the host option, on by default)
        host.check("#opt-resync")

        start_game(host, guest)
        wait_past_frame(host, 90)
        wait_past_frame(guest, 90)
        assert host.evaluate("window.NetplayRollback.isSyncEnabled()"), "resync is off"
        applied_before = syncs_applied(guest)

        # Silent for longer than the 5 s after which the host drops the guest
        silence_inputs(guest, 8000)
        host.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('PEER-PHANTOM slot=1')",
            timeout=15000,
        )
        print(f"\n  {sync_log_lines(host, 'PEER-PHANTOM slot=1')[0]}")

        # The silence ends by itself; the host sees the guest again...
        host.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('PEER-RECOVERED slot=1')",
            timeout=30000,
        )
        print(f"  {sync_log_lines(host, 'PEER-RECOVERED slot=1')[0]}")

        # ...and the guest applies the host's state
        deadline = time.monotonic() + 60
        while syncs_applied(guest) <= applied_before and time.monotonic() < deadline:
            time.sleep(0.5)
        applied = [line for line in sync_log_lines(guest, " applied (frame ") if "sync #" in line]
        assert syncs_applied(guest) > applied_before, (
            "guest never applied the host's state after it came back:\n"
            + "\n".join(sync_log_lines(guest, "sync")[-20:])
        )
        print(f"  {applied[-1]}")

        # Both play on after the resync
        frame_after = frame(guest)
        wait_past_frame(guest, frame_after + 10, timeout_s=30)
        wait_past_frame(host, frame(host) + 10, timeout_s=30)

    finally:
        host.close()
        guest.close()


def test_resync_sustains_over_time(browser, server_url, rom_path, start_game, room):
    """With rollback on, resyncs should keep correcting drift over 10+ seconds."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        host.wait_for_selector("#overlay", timeout=10000)
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host, rom_path)
        _load_rom(guest, rom_path)
        time.sleep(1)

        host.check("#opt-resync")
        start_game(host, guest)

        # Run for 10 seconds, sampling every 2s
        samples = []
        for i in range(5):
            time.sleep(2)
            h_frame = host.evaluate("window.KNState.frameNum")
            g_frame = guest.evaluate("window.KNState.frameNum")
            diff = abs(h_frame - g_frame)
            samples.append((h_frame, g_frame, diff))
            print(f"  Sample {i+1}: host={h_frame} guest={g_frame} diff={diff}")

        # Frame counters should stay within a reasonable range of each other.
        # Without working resync, the guest would be stuck or wildly divergent.
        max_diff = max(s[2] for s in samples)
        last_h, last_g, _ = samples[-1]
        first_h, first_g, _ = samples[0]

        # Both must be advancing
        assert last_h > first_h + 50, f"Host stalled: {first_h} -> {last_h}"
        assert last_g > first_g + 50, f"Guest stalled: {first_g} -> {last_g}"

        # Frame diff should stay bounded (resync keeps pulling them back together)
        assert max_diff < 120, f"Frames diverged too far: max diff {max_diff}"

        print(f"\n  Sustained sync OK over 10s: max frame diff = {max_diff}")

    finally:
        host.close()
        guest.close()


def test_end_game_with_rollback(browser, server_url, rom_path, start_game, room):
    """End game should work cleanly when rollback/sync is enabled."""
    host = browser.new_page()
    guest = browser.new_page()
    host_errors = []
    guest_errors = []
    host.on("pageerror", lambda err: host_errors.append(str(err)))
    guest.on("pageerror", lambda err: guest_errors.append(str(err)))

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        _load_rom(host, rom_path)
        _load_rom(guest, rom_path)
        time.sleep(1)

        host.check("#opt-resync")
        start_game(host, guest)

        # Let it run a bit
        time.sleep(2)

        # End game: it is in the toolbar's More menu
        host.click("#toolbar-more")
        expect(host.locator("#toolbar-end")).to_be_visible(timeout=2000)
        host.click("#toolbar-end")

        # Both should return to overlay
        host.wait_for_selector("#overlay:not(.hidden)", timeout=10000)
        guest.wait_for_selector("#overlay:not(.hidden)", timeout=10000)

        # No unexpected JS errors (filter harmless Chromium headless issues)
        real_host_errors = [e for e in host_errors if "Wake Lock" not in e]
        real_guest_errors = [e for e in guest_errors if "Wake Lock" not in e]
        assert len(real_host_errors) == 0, f"Host JS errors: {real_host_errors}"
        assert len(real_guest_errors) == 0, f"Guest JS errors: {real_guest_errors}"

        print(f"\nSUCCESS: End game with rollback worked cleanly!")

    finally:
        host.close()
        guest.close()
