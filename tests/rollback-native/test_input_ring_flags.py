"""The input ring's prediction flags across a ring lap (specs/input_ring_flags.qnt).

A prediction whose real input never reaches kn_feed_input leaves its flag
set. One lap of the input ring later (KN_INPUT_RING_SIZE, 256 frames) the
real input for the frame at the same index arrives before the forward pass
reaches it, and the frame runs on it. A replay that covers the frame, for
another player's input, must run it on that real input too: it was fed once
and is not fed again, so a prediction put over it would never be checked.
These run the real engine (build/kn_rollback/kn_rollback.c) against
fake_core.c on both state backends. Each case is one of the model's
scenario tests."""

from __future__ import annotations

import ctypes

import pytest

OWN = 1
LOCAL, STALE, OTHER = 0, 1, 2
MAX_FRAMES, DELAY = 7, 2
RING = 256
BACKENDS = {"retro": 0, "split-rdram": 1}


@pytest.fixture(params=sorted(BACKENDS))
def rb(lib, request):
    lib.kn_set_state_backend(BACKENDS[request.param])
    lib.kn_set_delta_save_sparse(0)
    lib.kn_set_delta_restore(0)
    lib.kn_rollback_init(MAX_FRAMES, DELAY, LOCAL, 3)
    # The page's mode (localCaps.trueRollback): a replay predicts again the
    # inputs still unconfirmed.
    lib.kn_set_true_rollback(1)
    lib.kn_test_set_live(OWN, 0)
    yield lib
    lib.kn_rollback_shutdown()


def step(lib) -> int:
    """One kn_pre_tick, the frame it leaves the core on, kn_post_tick. A
    rollback restores the ring's copy and the core goes on from there."""
    lib.kn_pre_tick(0, 0, 0, 0, 0, -1)
    frame = lib.kn_get_frame()
    lib.kn_test_set_live(lib.kn_test_live_origin(), frame + 1)
    return lib.kn_post_tick()


def run_to(lib, frame: int, fed: dict[int, set[int]]) -> None:
    """Live frames up to `frame`, with each player's input for a frame fed
    just before the frame applies it, unless it is listed as held."""
    while lib.kn_get_frame() < frame:
        tag = lib.kn_get_frame() - DELAY
        for slot in (STALE, OTHER):
            if tag >= 0 and tag not in fed[slot]:
                lib.kn_feed_input(slot, tag, 0, 0, 0, 0, 0)
                fed[slot].add(tag)
        step(lib)
    assert lib.kn_get_rollback_count() == 0


def input_of(lib, slot: int, tag: int) -> int:
    buttons = ctypes.c_int()
    out = [ctypes.c_int() for _ in range(4)]
    assert lib.kn_get_input(slot, tag, ctypes.byref(buttons), *(ctypes.byref(o) for o in out)) == 1
    return buttons.value


def test_a_replay_keeps_a_real_input_stored_over_a_stale_flag(rb):
    # staleFlagTest: tag 10 of the STALE player is predicted and its real
    # input never comes. A lap later, tag 266 (the same index) arrives
    # before the forward pass reaches it, and its frame runs on it. Then the
    # OTHER player's input for tag 266 turns out to differ from its
    # prediction, and the replay covers 266's frame.
    old, tag = 10, 10 + RING
    fed = {STALE: {old}, OTHER: set()}
    run_to(rb, tag + DELAY - 4, fed)
    # Real inputs for STALE up to tag + 3 are here early; its newest differs
    # from tag's, so a prediction of tag would not be its real input.
    for t in range(tag - 3, tag):
        if t not in fed[STALE]:
            rb.kn_feed_input(STALE, t, 0, 0, 0, 0, 0)
            fed[STALE].add(t)
    rb.kn_feed_input(STALE, tag, 5, 0, 0, 0, 0)
    for t in range(tag + 1, tag + 4):
        rb.kn_feed_input(STALE, t, 7, 0, 0, 0, 0)
    fed[STALE].update({tag, tag + 1, tag + 2, tag + 3})
    # OTHER's tag is held, so the frame applying it predicts it.
    fed[OTHER].add(tag)
    run_to(rb, tag + DELAY + 3, fed)
    assert input_of(rb, STALE, tag) == 5
    # OTHER's real input for tag differs from its prediction: a rollback
    # to the frame that applied it.
    rb.kn_feed_input(OTHER, tag, 9, 0, 0, 0, 0)
    assert rb.kn_peek_pending_rollback() == tag + DELAY
    while True:
        step(rb)
        if rb.kn_get_replay_depth() == 0 and rb.kn_peek_pending_rollback() == -1:
            break
    assert rb.kn_get_rollback_count() == 1
    assert rb.kn_get_failed_rollbacks() == 0
    # The replay ran STALE's real input for tag, not a prediction from its
    # newest one.
    assert input_of(rb, STALE, tag) == 5
    assert input_of(rb, OTHER, tag) == 9


def test_a_prediction_made_in_a_replay_is_still_checked(rb):
    # rePredictedThenFedTest: a replay predicts again a tag whose real input
    # has not come; its arrival is checked against that prediction and rolls
    # back.
    fed = {STALE: set(), OTHER: set()}
    run_to(rb, 20, fed)
    tag = 25
    fed[STALE].update({tag})
    fed[OTHER].update({tag - 2})
    run_to(rb, tag + DELAY + 2, fed)
    rb.kn_feed_input(OTHER, tag - 2, 3, 0, 0, 0, 0)
    assert rb.kn_peek_pending_rollback() == tag - 2 + DELAY
    while True:
        step(rb)
        if rb.kn_get_replay_depth() == 0 and rb.kn_peek_pending_rollback() == -1:
            break
    rb.kn_feed_input(STALE, tag, 4, 0, 0, 0, 0)
    assert rb.kn_peek_pending_rollback() == tag + DELAY


def test_a_late_input_that_differs_still_rolls_back(rb):
    # lateRealInputTest: clearing the flag on every real input hides no
    # misprediction. The tag is predicted, its real input comes after its
    # frame ran and differs: a rollback to that frame, run on the real input.
    fed = {STALE: set(), OTHER: set()}
    run_to(rb, 30, fed)
    tag = 32
    fed[STALE].add(tag)
    run_to(rb, tag + DELAY + 2, fed)
    rb.kn_feed_input(STALE, tag, 6, 0, 0, 0, 0)
    assert rb.kn_peek_pending_rollback() == tag + DELAY
    while True:
        step(rb)
        if rb.kn_get_replay_depth() == 0 and rb.kn_peek_pending_rollback() == -1:
            break
    assert rb.kn_get_rollback_count() == 1
    assert input_of(rb, STALE, tag) == 6
    # The same input again changes nothing.
    rb.kn_feed_input(STALE, tag, 6, 0, 0, 0, 0)
    assert rb.kn_peek_pending_rollback() == -1


def test_a_lap_old_flag_is_counted_when_a_real_input_replaces_it(rb):
    # The prediction for tag 10 is never checked: when the real input for
    # tag 266 clears its flag, it is counted with the predictions the forward
    # pass overwrites, so the prediction books still balance.
    old, tag = 10, 10 + RING
    fed = {STALE: {old}, OTHER: set()}
    run_to(rb, tag + DELAY - 4, fed)
    before = rb.kn_get_clobbered_predictions()
    rb.kn_feed_input(STALE, tag, 5, 0, 0, 0, 0)
    assert rb.kn_get_clobbered_predictions() == before + 1
