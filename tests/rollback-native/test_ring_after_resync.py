"""The rollback engine's ring across a resync that moves the frame counter
back (specs/ring_after_resync.qnt, everyRerunFrameIsTheHosts).

A resync loads the host's state for its frame and moves the counter there
(kn_set_frame). kn_pre_tick saves a frame into the ring only when it was
not the last one saved, so when the page had run exactly one frame past the
resync's frame, its own copy of that frame stayed in the ring until
kn_set_frame forgot the last save. These run the real engine
(build/kn_rollback/kn_rollback.c) against fake_core.c, whose whole state
says whose timeline it is on and which frame it starts.

Each case is one of the model's scenario tests."""

from __future__ import annotations

import ctypes
import struct

import pytest

OWN, HOST = 1, 2
MAX_FRAMES, DELAY_FRAMES = 7, 2


@pytest.fixture
def rb(lib):
    lib.kn_rollback_init(MAX_FRAMES, DELAY_FRAMES, 0, 2)
    # The other player's input for every frame is here, so nothing is
    # predicted and nothing is rolled back.
    for frame in range(32):
        lib.kn_feed_input(1, frame, 0, 0, 0, 0, 0)
    lib.kn_test_set_live(OWN, 0)
    yield lib
    lib.kn_rollback_shutdown()


def tick(lib) -> None:
    """One frame: kn_pre_tick, the core runs it, kn_post_tick."""
    frame = lib.kn_get_frame()
    assert lib.kn_test_live_frame() == frame
    lib.kn_pre_tick(0, 0, 0, 0, 0, -1)
    lib.kn_test_set_live(lib.kn_test_live_origin(), frame + 1)
    assert lib.kn_post_tick() == frame + 1
    assert lib.kn_get_rollback_count() == 0


def resync(lib, at: int) -> None:
    """The host's state for frame `at` is loaded and the counter moved there."""
    lib.kn_test_set_live(HOST, at)
    lib.kn_set_frame(at)
    assert lib.kn_get_frame() == at


def ring_copy(lib, frame: int) -> tuple[int, int]:
    """(whose timeline, which frame) of the ring's copy of `frame`."""
    ptr = lib.kn_get_state_for_frame(frame)
    assert ptr, f"no ring copy of frame {frame}"
    return struct.unpack("<ii", ctypes.string_at(ptr, 8))


def run_frames(lib, count: int) -> None:
    for _ in range(count):
        tick(lib)


def test_a_resync_one_frame_back_saves_the_hosts_state_for_that_frame(rb):
    # oneFrameBackTest: the page runs frames 0 to 4 (it saved 4 last), the
    # resync for frame 4 lands, and the page runs frame 4 again.
    run_frames(rb, 5)
    assert ring_copy(rb, 4) == (OWN, 4)
    resync(rb, 4)
    tick(rb)
    assert ring_copy(rb, 4) == (HOST, 4)
    tick(rb)
    assert ring_copy(rb, 5) == (HOST, 5)


def test_a_resync_two_frames_back_saves_the_hosts_state(rb):
    # twoFramesBackTest: the last save (frame 5) is not the target.
    run_frames(rb, 6)
    resync(rb, 4)
    run_frames(rb, 2)
    assert ring_copy(rb, 4) == (HOST, 4)
    assert ring_copy(rb, 5) == (HOST, 5)


def test_a_resync_on_the_frame_about_to_run_saves_the_hosts_state(rb):
    # onTheFrameTest: the state lands on the frame the page runs next.
    run_frames(rb, 5)
    resync(rb, 5)
    tick(rb)
    assert ring_copy(rb, 4) == (OWN, 4)
    assert ring_copy(rb, 5) == (HOST, 5)
