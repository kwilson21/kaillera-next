"""An earlier correction arriving between replay slices (specs/replay_preemption.qnt)."""

import ctypes

import pytest


def arm(lib):
    lib.kn_rollback_init(8, 1, 0, 3)
    lib.kn_set_true_rollback(1)
    lib.kn_get_rdram_ptr.restype = ctypes.c_void_p
    lib.kn_set_rdram_preserve(ctypes.c_void_p(lib.kn_get_rdram_ptr()))
    lib.kn_test_set_live(1, 0)


@pytest.fixture(params=[0, 1], ids=["retro", "split-rdram"])
def engine(lib, request):
    lib.kn_set_state_backend(request.param)
    arm(lib)
    yield lib
    lib.kn_test_refuse_restore(0)
    lib.kn_rollback_shutdown()


def feed(lib, slot, tag, buttons):
    return lib.kn_feed_input(slot, tag, buttons, 0, 0, 0, 0)


def tick(lib, buttons=0):
    kind = lib.kn_pre_tick(buttons, 0, 0, 0, 0, -1)
    cursor = lib.kn_get_frame()
    assert lib.kn_test_live_frame() == cursor
    lib.kn_test_set_live(1, cursor + 1)
    assert lib.kn_post_tick() == cursor + 1
    return kind, cursor


def step(lib, kind, cursor):
    assert tick(lib) == (kind, cursor)


def start_replay(lib, frontier=8):
    # A correction from the first peer rewinds three frames. Another peer
    # has an earlier prediction outstanding when this first slice ends.
    for frame in range(frontier):
        if frame <= frontier - 5:
            feed(lib, 1, frame, 0)
        if frame <= 1:
            feed(lib, 2, frame, 0)
        step(lib, 0, frame)
    assert feed(lib, 1, frontier - 4, 1) == 1
    step(lib, 2, frontier - 3)


def test_earlier_correction_replays_to_the_original_frontier(engine):
    start_replay(engine)
    assert feed(engine, 2, 2, 2) == 1
    for frame in range(3, 8):
        step(engine, 2, frame)
        if frame == 3:
            assert engine.kn_test_controller_buttons(2) == 2
        if frame == 5:
            assert engine.kn_test_controller_buttons(1) == 1
    step(engine, 0, 8)
    assert engine.kn_get_failed_rollbacks() == 0


def test_failed_preemption_preserves_the_frame_being_replayed(engine):
    start_replay(engine)
    assert feed(engine, 2, 2, 2) == 1
    engine.kn_test_refuse_restore(1)
    step(engine, 2, 6)
    engine.kn_test_refuse_restore(0)
    step(engine, 2, 7)
    step(engine, 0, 8)
    assert engine.kn_get_failed_rollbacks() == 1


def test_preemption_obeys_the_window_from_the_original_frontier(engine):
    # The proposed rollback to 3 is 6 behind cursor 9, but 8 behind live 11.
    start_replay(engine, frontier=11)
    assert feed(engine, 2, 2, 2) == 0
    step(engine, 2, 9)
    step(engine, 2, 10)
    step(engine, 0, 11)
    assert engine.kn_get_failed_rollbacks() == 1


def test_late_correction_inside_replayed_prefix_is_queued(engine):
    start_replay(engine)
    step(engine, 2, 6)
    # Frame 6 has already been replayed, but follows this replay's start, 5.
    assert feed(engine, 2, 5, 2) == 1
    step(engine, 2, 7)
    step(engine, 2, 6)
    assert engine.kn_test_controller_buttons(2) == 2
    step(engine, 2, 7)
    step(engine, 0, 8)
    assert engine.kn_get_failed_rollbacks() == 0


def corrected_buttons(lib, delay, preempt):
    # The local player presses for exactly one tag. Remote tags 4 and 2
    # arrive together, or one replay frame apart.
    feed(lib, 1, 0, 0)
    for frame in range(8):
        assert tick(lib, 128 if frame == 5 else 0) == (0, frame)
    assert lib.kn_set_delay_frames(delay) == delay
    assert feed(lib, 1, 4, 1) == 1
    if preempt:
        step(lib, 2, 5)
    assert feed(lib, 1, 2, 2) == 1

    applied = []
    for frame in range(3, 8):
        kind, cursor = tick(lib, 128 if lib.kn_get_frame() == 5 else 0)
        assert cursor == frame
        if kind == 2:
            applied.append(lib.kn_test_controller_buttons(0))
        else:
            # The page writes a normal frame's input from the ring.
            assert kind == 0
            fields = [ctypes.c_int() for _ in range(5)]
            assert lib.kn_get_input(
                0, frame - delay, *(ctypes.byref(x) for x in fields)
            )
            applied.append(fields[0].value)
    return applied


@pytest.mark.parametrize("delay", [1, 2], ids=["fixed-delay", "retuned-delay"])
def test_preemption_preserves_the_frame_of_a_button_press(engine, delay):
    reference = corrected_buttons(engine, delay, preempt=False)
    assert reference == [0, 0, 0, 128, 0]
    arm(engine)
    assert corrected_buttons(engine, delay, preempt=True) == reference
