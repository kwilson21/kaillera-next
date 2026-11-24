"""The rollback engine's per-frame save while a page plays alone
(specs/solo_save.qnt).

kn_pre_tick saves the frame about to run only while a slot other than the
page's own is active (kn_feed_input has had an input for it). A rollback goes
back to a frame only for an input that frame predicted, and only an active
slot is predicted, so the frames a page plays alone are never a rollback's
target. These run the real engine (build/kn_rollback/kn_rollback.c) against
fake_core.c on both state backends. Each case is one of the model's scenario
tests."""

from __future__ import annotations

import ctypes

import pytest

OWN = 1
MAX_FRAMES = 7
BACKENDS = {"retro": 0, "split-rdram": 1}


def arm(lib, delay: int, frame: int = 0) -> None:
    """kn_rollback_init, then the C frame set to the page's, as _rbDoInit does."""
    lib.kn_rollback_init(MAX_FRAMES, delay, 0, 2)
    lib.kn_set_frame(frame)
    lib.kn_test_set_live(OWN, frame)


@pytest.fixture(params=sorted(BACKENDS))
def backend(lib, request):
    lib.kn_set_state_backend(BACKENDS[request.param])
    lib.kn_set_delta_save_sparse(0)
    lib.kn_set_delta_restore(0)
    yield lib
    lib.kn_rollback_shutdown()


def tick(lib) -> None:
    """One frame with nothing to roll back: kn_pre_tick, the frame, kn_post_tick."""
    frame = lib.kn_get_frame()
    assert lib.kn_pre_tick(0, 0, 0, 0, 0, -1) >= 0
    lib.kn_test_set_live(OWN, frame + 1)
    assert lib.kn_post_tick() == frame + 1


def feed(lib, tag: int, buttons: int) -> None:
    lib.kn_feed_input(1, tag, buttons, 0, 0, 0, 0)


def saved(lib, frame: int) -> bool:
    """Whether the ring has a copy of `frame`. The split backend keeps no
    whole-state buffer (kn_get_state_for_frame is NULL there); the shadow
    worker's reader returns its parts."""
    if lib.kn_get_state_backend() == BACKENDS["split-rdram"]:
        parts = (ctypes.c_uint32 * 10)()
        return lib.kn_get_split_state_for_shadow(frame, parts, 10) >= 9
    return lib.kn_get_state_for_frame(frame) is not None


def rolls_back_to(lib, target: int) -> None:
    """The next kn_pre_tick restores the ring's copy of `target`."""
    assert lib.kn_peek_pending_rollback() == target
    assert lib.kn_pre_tick(0, 0, 0, 0, 0, -1) != 0
    assert lib.kn_test_live_frame() == target
    assert lib.kn_get_rollback_count() == 1
    assert lib.kn_get_failed_rollbacks() == 0
    f, idx, actual = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    assert lib.kn_get_fatal_stale(ctypes.byref(f), ctypes.byref(idx), ctypes.byref(actual)) == 0


def test_a_page_alone_saves_no_frame(backend):
    # soloThenFriendTest, its first part: alone at a delay of 0, with a slot
    # for the other player that has had no input.
    arm(backend, 0)
    for _ in range(5):
        tick(backend)
    assert not any(saved(backend, f) for f in range(5))
    assert backend.kn_get_serialize_skip_count() == 5


def test_a_friend_who_joins_a_solo_match_rolls_back_to_a_saved_frame(backend):
    # soloThenFriendTest: three frames alone; the friend joins and the host
    # arms again at frame 3 with delay 1; the friend's input for tag 2 is
    # here, tag 3's is predicted at frame 4 and turns out wrong.
    arm(backend, 0)
    for _ in range(3):
        tick(backend)
    arm(backend, 1, frame=3)
    feed(backend, 2, 1)
    tick(backend)
    tick(backend)
    assert saved(backend, 3) and saved(backend, 4)
    feed(backend, 3, 2)
    rolls_back_to(backend, 4)


def test_saves_stop_while_the_other_player_is_gone(backend):
    # leaveAndReturnTest: a match of two; the other player leaves after two
    # frames and comes back a frame later (no re-arm above 0). Their next
    # input is predicted and wrong; the rollback finds its frame.
    arm(backend, 1)
    feed(backend, 0, 1)
    tick(backend)
    tick(backend)
    backend.kn_rollback_slot_reset(1)
    tick(backend)
    assert [saved(backend, f) for f in range(3)] == [True, True, False]
    feed(backend, 2, 1)
    tick(backend)
    tick(backend)
    assert saved(backend, 3) and saved(backend, 4)
    feed(backend, 3, 2)
    rolls_back_to(backend, 4)


def test_removal_cut_keeps_the_solo_slot_inactive_until_readmission(backend):
    arm(backend, 1)
    feed(backend, 0, 1)
    tick(backend)
    tick(backend)
    backend.kn_rollback_slot_reset(1)
    for tag, buttons in enumerate((1, 0, 0)):
        backend.kn_store_cut_input(1, tag, buttons, 0, 0, 0, 0)
    tick(backend)
    assert not saved(backend, 2)
    tick(backend)
    assert not saved(backend, 3)
    assert backend.kn_get_prediction_count() == 0
    feed(backend, 3, 1)
    tick(backend)
    tick(backend)
    assert saved(backend, 4) and saved(backend, 5)
    feed(backend, 4, 2)
    rolls_back_to(backend, 5)


def test_pending_replay_keeps_the_removed_players_final_inputs(backend):
    arm(backend, 1)
    backend.kn_set_num_players(4)
    for slot in (1, 2, 3):
        backend.kn_feed_input(slot, 0, 8, 0, 0, 0, 0)
    for _ in range(7):
        tick(backend)
    backend.kn_feed_input(2, 1, 4, 0, 0, 0, 0)
    assert backend.kn_peek_pending_rollback() == 2

    # A 4-to-3 roster cut arrives before P3's correction starts replaying.
    backend.kn_rollback_slot_reset(1)
    for tag, buttons in enumerate((8, 16, 32, 0, 0)):
        backend.kn_store_cut_input(1, tag, buttons, 0, 0, 0, 0)
    for frame, buttons in enumerate((16, 32, 0, 0, 0), start=2):
        assert backend.kn_pre_tick(0, 0, 0, 0, 0, -1) == 2
        assert backend.kn_get_frame() == frame
        assert backend.kn_test_controller_buttons(1) == buttons
        backend.kn_test_set_live(OWN, frame + 1)
        assert backend.kn_post_tick() == frame + 1
    tick(backend)
    assert saved(backend, 7)
    assert backend.kn_get_failed_rollbacks() == 0


def test_an_input_for_a_frame_run_alone_rolls_nothing_back(backend):
    # inputForAnUnpredictedFrameTest: the late join primes the other slot
    # with inputs for frames the page ran while it was inactive. Nothing was
    # predicted for them.
    arm(backend, 0)
    tick(backend)
    tick(backend)
    arm(backend, 1, frame=2)
    tick(backend)
    tick(backend)
    feed(backend, 1, 2)
    assert backend.kn_peek_pending_rollback() == -1
    tick(backend)
    assert backend.kn_get_rollback_count() == 0


def test_the_sparse_save_mode_restores_the_first_frame_after_a_stretch(lib):
    # firstSaveAfterAStretchTest in the sparse save mode (with delta
    # restore): a save, a frame alone, the other player back, saves again.
    # The skipped save forgot the baseline, so the next save is whole.
    lib.kn_set_state_backend(BACKENDS["split-rdram"])
    lib.kn_set_delta_save_sparse(1)
    lib.kn_set_delta_restore(1)
    try:
        arm(lib, 1)
        feed(lib, 0, 0)
        tick(lib)
        lib.kn_rollback_slot_reset(1)
        tick(lib)
        feed(lib, 1, 0)
        for _ in range(3):
            tick(lib)
        assert not saved(lib, 1)
        for frame in (2, 3, 4):
            assert lib.kn_restore_frame(frame) == 1
            assert (lib.kn_test_live_origin(), lib.kn_test_live_frame()) == (OWN, frame)
            assert lib.kn_test_live_frame_block() == frame
    finally:
        lib.kn_rollback_shutdown()
        lib.kn_set_delta_save_sparse(0)
        lib.kn_set_delta_restore(0)
