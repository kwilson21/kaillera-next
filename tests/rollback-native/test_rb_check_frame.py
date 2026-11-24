"""The frame RB-CHECK files is still in the rollback engine's ring.

Right after kn_post_tick moves the counter to N, the rollback engine
(web/static/netplay-rollback.js) files the gameplay hash of frame N - max,
the frame one rollback window back (web/src/rb-check.ts, digestFrame with the
window it passes to kn_rollback_init). kn_gameplay_hash reads it from the
ring and returns 0 for a frame the ring does not hold, which the engine
takes as "not filed". The ring holds max + 1 frames, so N - max must still be
in it at that point. Run on the split-RDRAM backend, the default, where
kn_gameplay_hash reads the ring's RDRAM copy."""

from __future__ import annotations

import ctypes

import pytest

OWN = 1
MAX_FRAMES, DELAY_FRAMES = 7, 2


@pytest.fixture
def rb(lib):
    lib.kn_gameplay_hash.restype = ctypes.c_uint32
    lib.kn_set_state_backend(1)
    lib.kn_set_delta_save_sparse(0)
    lib.kn_set_delta_restore(0)
    lib.kn_rollback_init(MAX_FRAMES, DELAY_FRAMES, 0, 2)
    for frame in range(64):
        lib.kn_feed_input(1, frame, 0, 0, 0, 0, 0)
    lib.kn_test_set_live(OWN, 0)
    yield lib
    lib.kn_rollback_shutdown()


def test_the_frame_one_window_back_is_in_the_ring_after_each_tick(rb):
    for _ in range(40):
        frame = rb.kn_get_frame()
        rb.kn_pre_tick(0, 0, 0, 0, 0, -1)
        rb.kn_test_set_live(OWN, frame + 1)
        now = rb.kn_post_tick()
        assert now == frame + 1
        if now >= MAX_FRAMES:
            assert rb.kn_gameplay_hash(now - MAX_FRAMES) != 0, f"frame {now - MAX_FRAMES} left the ring at {now}"
        # The ring holds max + 1 frames: two further back is gone.
        if now >= MAX_FRAMES + 2:
            assert rb.kn_gameplay_hash(now - MAX_FRAMES - 2) == 0
