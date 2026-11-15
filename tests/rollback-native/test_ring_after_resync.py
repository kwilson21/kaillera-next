"""The rollback engine's ring across a resync that loads the host's state
(specs/ring_after_resync.qnt).

A resync loads the host's state for its frame and moves the counter there
(kn_set_frame, which the page calls on every state it loads). kn_pre_tick
saves a frame into the ring only when it was not the last one saved, so
until kn_set_frame forgot the last save, a page that had already saved the
resync's frame kept its own copy of it in the ring. These run the real
engine (build/kn_rollback/kn_rollback.c) against fake_core.c, whose state
says whose timeline it is on and which frame it starts, on both state
backends: the whole state (retro_serialize) and split RDRAM, the default.
A ring copy is read back by restoring it.

Each case is one of the model's scenario tests."""

from __future__ import annotations

import pytest

OWN, HOST = 1, 2
MAX_FRAMES, DELAY_FRAMES = 7, 2
BACKENDS = {"retro": 0, "split-rdram": 1}


def start(lib, backend: str, sparse: bool = False) -> None:
    # Backend and delta modes are settings the engine keeps across inits.
    lib.kn_set_state_backend(BACKENDS[backend])
    lib.kn_set_delta_save_sparse(1 if sparse else 0)
    lib.kn_set_delta_restore(1 if sparse else 0)
    lib.kn_rollback_init(MAX_FRAMES, DELAY_FRAMES, 0, 2)
    assert lib.kn_get_state_backend() == BACKENDS[backend]
    # The other player's input for every frame is here, so nothing is
    # predicted and nothing is rolled back.
    for frame in range(32):
        lib.kn_feed_input(1, frame, 0, 0, 0, 0, 0)
    lib.kn_test_set_live(OWN, 0)


@pytest.fixture(params=sorted(BACKENDS))
def rb(lib, request):
    start(lib, request.param)
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
    """The host's state for frame `at` is loaded and kn_set_frame called."""
    lib.kn_test_set_live(HOST, at)
    lib.kn_set_frame(at)
    assert lib.kn_get_frame() == at


def ring_copy(lib, frame: int) -> tuple[int, int]:
    """(whose timeline, which frame) of the ring's copy of `frame`."""
    assert lib.kn_restore_frame(frame) == 1, f"no ring copy of frame {frame}"
    return lib.kn_test_live_origin(), lib.kn_test_live_frame()


def run_frames(lib, count: int) -> None:
    for _ in range(count):
        tick(lib)


def test_a_resync_one_frame_back_saves_the_hosts_state_for_that_frame(rb):
    # oneFrameBackTest: the page runs frames 0 to 4 (it saved 4 last), the
    # resync for frame 4 lands, and the page runs frame 4 again.
    run_frames(rb, 5)
    resync(rb, 4)
    run_frames(rb, 2)
    assert ring_copy(rb, 4) == (HOST, 4)
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
    assert ring_copy(rb, 5) == (HOST, 5)
    assert ring_copy(rb, 4) == (OWN, 4)


def test_a_resync_for_a_frame_saved_and_not_run_saves_the_hosts_state(rb):
    # savedFrameDidNotRunTest: kn_pre_tick saved frame 4 and the frame did
    # not run (a step that emulated nothing); the resync for frame 4 lands
    # with the counter where it was.
    run_frames(rb, 4)
    rb.kn_pre_tick(0, 0, 0, 0, 0, -1)
    resync(rb, 4)
    tick(rb)
    assert ring_copy(rb, 4) == (HOST, 4)


@pytest.mark.parametrize("frames_before", [5, 6])
def test_the_sparse_save_mode_rebuilds_the_frame_a_resync_landed_on(lib, frames_before):
    # oneFrameBackTest in the sparse save mode (knDiag.setDeltaSaveSparse,
    # with delta restore): saved again against the page's own copy of the
    # frame as the baseline, the copy left out the blocks the two states
    # share, and a restore took them from the frame before. Block 5 holds the
    # frame number on both timelines. Two counts of frames before, so that
    # the save lands between the engine's periodic whole saves either way.
    start(lib, "split-rdram", sparse=True)
    try:
        run_frames(lib, frames_before)
        target = frames_before - 1
        resync(lib, target)
        tick(lib)
        assert ring_copy(lib, target) == (HOST, target)
        assert lib.kn_test_live_frame_block() == target
    finally:
        lib.kn_rollback_shutdown()
        lib.kn_set_delta_save_sparse(0)
        lib.kn_set_delta_restore(0)
