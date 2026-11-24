"""What the rollback engine does when a guest's inputs stop reaching the host.

These tests once checked the lockstep path's resend protocol: after
MAX_STALL_MS (3 s) the host sent `resend:<frame>`, and after RESEND_TIMEOUT_MS
more it went on with a zero input for the missing player (`INPUT-STALL
resend-request` and `INPUT-STALL hard-timeout`). That path is gone: every
frame runs on the C rollback engine, which does neither:

- inputs go over the reliable channel by default, which loses nothing. With
  the unreliable one (knDiag.setTransport('unreliable') on the host), every
  input packet carries all the inputs the peer has not acknowledged, up to
  RB_REDUNDANCY_MAX (30) frames, so a short gap is filled by the next packet
  that gets through, with no request;
- a peer whose inputs stay away is dropped as a phantom after 5 s
  (`PEER-PHANTOM`, from RB-INPUT-STALL-TIMEOUT or PEER_DEAD_MS), and the
  others run on without it. When it comes back, the host resyncs it
  (test_desync.py::test_dropped_guest_is_resynced_when_it_returns).

Run: KN_ROM=/path/ssb64-us.z64 pytest tests/test_input_resend.py -v -s
"""

import time

from netplay_steps import frame, hold_inputs, silence_inputs, sync_log_lines, wait_past_frame


def _start(browser, server_url, rom_path, start_game, room, transport=None):
    host = browser.new_page()
    guest = browser.new_page()
    if transport:
        # What knDiag.setTransport does: the host announces it at the start.
        host.add_init_script(f"window._knTransportOverride = '{transport}';")
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
    host.wait_for_selector("#overlay", timeout=10000)
    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    guest.wait_for_selector("#overlay", timeout=10000)
    for page in (host, guest):
        page.set_input_files("#rom-drop input[type=file]", rom_path)
    start_game(host, guest)
    # Running, not only started: the frames move on (the slow container
    # takes a few seconds over the first ones).
    wait_past_frame(host, 90)
    wait_past_frame(guest, 90)
    return host, guest


def _phantoms(page, slot):
    return sync_log_lines(page, f"PEER-PHANTOM slot={slot}")


def test_short_input_gap_is_filled_without_dropping_the_guest(browser, server_url, rom_path, start_game, room):
    """On the unreliable channel, a few lost input packets are made good by the
    next one: no phantom.

    This is the steady state: both pages run the C engine, which is what sends
    the redundant inputs (shouldSendRedundancy needs _useCRollback), and the
    guest has taken up the unreliable channel. The loss is kept under
    DC_ACK_STALE_MS (500 ms without an acknowledgement), past which the guest
    falls back to the reliable channel; that fallback, and packets lost before
    the C engine starts, are not what this tests.
    """
    host, guest = _start(browser, server_url, rom_path, start_game, room, transport="unreliable")
    try:
        for page in (host, guest):
            page.wait_for_function("window.NetplayRollback.isCRollback() === true", timeout=60000)
        guest.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('adopted=unreliable')",
            timeout=30000,
        )
        assert sync_log_lines(host, "rb-transport: host broadcast=unreliable"), "host did not pick unreliable"
        wait_past_frame(guest, frame(guest) + 10)
        phantoms_before = len(_phantoms(host, 1))
        fallbacks_before = len(sync_log_lines(guest, "DC-FALLBACK"))

        # One or two frames at a time at this container's 7-11 fps, well
        # inside the 30-frame redundancy window, until a packet is lost.
        dropped = 0
        for _ in range(5):
            silence_inputs(guest, 150, channels=("rbDc",))
            time.sleep(0.4)
            dropped = guest.evaluate("window._knTestDropped")
            if dropped:
                break
        assert dropped > 0, "no input packet was dropped: the silence did not take"

        frame_before = frame(host)
        # Longer than the 5 s after which a guest that stayed silent is dropped.
        time.sleep(7)
        print(f"\n  dropped {dropped} packets; host frames {frame_before} -> {frame(host)}")

        assert frame(host) > frame_before, "host stopped advancing after the gap"
        new_phantoms = _phantoms(host, 1)[phantoms_before:]
        fallbacks = sync_log_lines(guest, "DC-FALLBACK")[fallbacks_before:]
        assert not new_phantoms, (
            f"host dropped the guest over a short gap: {new_phantoms}; guest fallbacks: {fallbacks}"
        )
    finally:
        host.close()
        guest.close()


def test_slow_reliable_channel_does_not_drop_the_guest(browser, server_url, rom_path, start_game, room):
    """On the reliable channel, the default, inputs that arrive late but in
    order hold the host back for a moment: no phantom.

    That channel loses nothing, so the engine sends no redundant inputs on it;
    what it can do is deliver late. The guest's messages are held for 300 ms
    and then sent in order, as a slow reliable channel would.
    """
    host, guest = _start(browser, server_url, rom_path, start_game, room)
    try:
        assert sync_log_lines(host, "rb-transport: host broadcast=reliable"), "host did not pick reliable"
        phantoms_before = len(_phantoms(host, 1))

        hold_inputs(guest, 300)
        time.sleep(0.6)
        held = guest.evaluate("window._knTestHeld")
        assert held > 0, "nothing was held: the delay did not take"

        frame_before = frame(host)
        # Longer than the 5 s after which a guest that stayed silent is dropped.
        time.sleep(7)
        print(f"\n  held {held} messages; host frames {frame_before} -> {frame(host)}")

        assert frame(host) > frame_before, "host stopped advancing after the delay"
        new_phantoms = _phantoms(host, 1)[phantoms_before:]
        assert not new_phantoms, f"host dropped the guest over a 300 ms delay: {new_phantoms}"
    finally:
        host.close()
        guest.close()


def test_silent_guest_is_dropped_and_the_host_runs_on(browser, server_url, rom_path, start_game, room):
    """A guest silent past 5 s is dropped as a phantom, and the host goes on without it."""
    host, guest = _start(browser, server_url, rom_path, start_game, room)
    try:
        assert not _phantoms(host, 1), "guest was a phantom before the test silenced it"
        silent_ms = 14000
        started = time.monotonic()
        silence_inputs(guest, silent_ms)

        host.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('PEER-PHANTOM slot=1')",
            timeout=12000,
        )
        dropped_after = time.monotonic() - started
        print(f"\n  {_phantoms(host, 1)[0]}")
        print(f"  dropped {dropped_after:.1f}s into the silence")
        assert dropped_after >= 4.5, f"guest dropped after only {dropped_after:.1f}s of silence"

        # Still inside the silence: the host runs on alone.
        frame_dropped = frame(host)
        time.sleep(1.5)
        assert time.monotonic() - started < silent_ms / 1000, "the silence ended before the check"
        assert frame(host) > frame_dropped, "host did not run on after dropping the silent guest"
    finally:
        host.close()
        guest.close()
