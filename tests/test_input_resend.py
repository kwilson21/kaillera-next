"""What the rollback engine does when a guest's inputs stop reaching the host.

These tests once checked the lockstep path's resend protocol: after
MAX_STALL_MS (3 s) the host sent `resend:<frame>`, and after RESEND_TIMEOUT_MS
more it went on with a zero input for the missing player (`INPUT-STALL
resend-request` and `INPUT-STALL hard-timeout`). A game now runs on the C
rollback engine, which the lockstep path stands in for only when the core
lacks kn_pre_tick, and the rollback path does neither:

- every input packet carries all the inputs the peer has not acknowledged,
  up to RB_REDUNDANCY_MAX (30) frames, so a short gap is filled by the next
  packet that gets through, with no request;
- a peer whose inputs stay away is dropped as a phantom after 5 s
  (`PEER-PHANTOM`, from RB-INPUT-STALL-TIMEOUT or PEER_DEAD_MS), and the
  others run on without it. When it comes back, the host resyncs it
  (test_desync.py::test_dropped_guest_is_resynced_when_it_returns).

Run: KN_ROM=/path/ssb64-us.z64 pytest tests/test_input_resend.py -v -s
"""

import time

from netplay_steps import frame, silence_inputs, sync_log_lines, wait_past_frame


def _start(browser, server_url, rom_path, start_game, room):
    host = browser.new_page()
    guest = browser.new_page()
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
    """A few lost input packets are made good by the next one: no phantom."""
    host, guest = _start(browser, server_url, rom_path, start_game, room)
    try:
        phantoms_before = len(_phantoms(host, 1))

        # About 3 frames at this container's 7-11 fps, well inside the
        # 30-frame redundancy window.
        silence_inputs(guest, 300)
        time.sleep(0.5)
        dropped = guest.evaluate("window._knTestDropped")
        assert dropped > 0, "no input packet was dropped: the silence did not take"

        frame_before = frame(host)
        # Longer than the 5 s after which a guest that stayed silent is dropped.
        time.sleep(7)
        print(f"\n  dropped {dropped} packets; host frames {frame_before} -> {frame(host)}")

        assert frame(host) > frame_before, "host stopped advancing after the gap"
        new_phantoms = _phantoms(host, 1)[phantoms_before:]
        assert not new_phantoms, f"host dropped the guest over a short gap: {new_phantoms}"
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
