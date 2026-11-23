"""A replay runs a confirmed input's real value after the input ring wraps
(specs/stale_prediction_flag.qnt).

The remote input ring is reused every 256 frames. A prediction of frame X
whose real input never reaches the engine (the page drops inputs older than
a resync's settled point) leaves the prediction flag set at X % 256. The
real input of X + 256 then arrives on time and is stored in the same entry.
The replay branch of kn_pre_tick read the bare flag, took that real input
for an unconfirmed prediction and replayed the frame with a new guess
instead. These run the real engine (build/kn_rollback/kn_rollback.c) against
fake_core.c, which records what each controller was given, on both state
backends.

Each case is one of the model's scenario tests."""

from __future__ import annotations

import ctypes

import pytest

MAX_FRAMES, DELAY_FRAMES = 12, 2
LOCAL, REMOTE = 0, 1
BACKENDS = {"retro": 0, "split-rdram": 1}
RING = 256
# The input that arrives late and starts the rollback, and the one after it,
# which arrives on time and shares its ring entry with frame 10's.
LATE = 265
ON_TIME = LATE + 1
PRESSED, RELEASED, LATE_VALUE = 0x10, 0, 0x1


def start(lib, backend: str) -> None:
    lib.kn_set_state_backend(BACKENDS[backend])
    lib.kn_set_delta_save_sparse(0)
    lib.kn_set_delta_restore(0)
    lib.kn_rollback_init(MAX_FRAMES, DELAY_FRAMES, LOCAL, 2)
    lib.kn_set_true_rollback(1)
    lib.kn_test_set_live(1, 0)


def remote_input(lib, frame: int) -> int:
    """The remote buttons the forward path hands the page for `frame`."""
    out = [ctypes.c_int() for _ in range(5)]
    ok = lib.kn_get_input(REMOTE, frame, *[ctypes.byref(o) for o in out])
    return out[0].value if ok else 0


def tick(lib, ran: dict[int, tuple[str, int]]) -> int:
    """One frame: kn_pre_tick, the core runs it, kn_post_tick. Records the
    remote buttons each emulated frame ran with, the last run winning."""
    frame = lib.kn_get_frame()
    rc = lib.kn_pre_tick(0, 0, 0, 0, 0, -1)
    frame = lib.kn_get_frame()
    if rc == 2:
        ran[frame] = ("replay", lib.kn_test_controller_buttons(REMOTE))
    else:
        apply = frame - DELAY_FRAMES
        ran[frame] = ("forward", remote_input(lib, apply) if apply >= 0 else 0)
    lib.kn_test_set_live(1, frame + 1)
    lib.kn_post_tick()
    return rc


def run(lib, never_fed: int | None) -> dict[int, tuple[str, int]]:
    """Every remote input arrives on time except `never_fed` (predicted, never
    verified) and LATE (held back). ON_TIME arrives as PRESSED before it is
    predicted, three more as RELEASED, then LATE arrives and differs from its
    prediction, so the engine rolls back over the frame that applied
    ON_TIME."""
    ran: dict[int, tuple[str, int]] = {}
    lib.kn_feed_input(REMOTE, 0, 0, 0, 0, 0, 0)
    while lib.kn_get_frame() < ON_TIME:
        frame = lib.kn_get_frame()
        if frame not in (never_fed, LATE):
            lib.kn_feed_input(REMOTE, frame, RELEASED, 0, 0, 0, 0)
        tick(lib, ran)
    lib.kn_feed_input(REMOTE, ON_TIME, PRESSED, 0, 0, 0, 0)
    tick(lib, ran)
    for later in range(ON_TIME + 1, ON_TIME + 4):
        lib.kn_feed_input(REMOTE, later, RELEASED, 0, 0, 0, 0)
        tick(lib, ran)
    assert ran[ON_TIME + DELAY_FRAMES] == ("forward", PRESSED)
    assert lib.kn_get_rollback_count() == 0
    lib.kn_feed_input(REMOTE, LATE, LATE_VALUE, 0, 0, 0, 0)
    while tick(lib, ran) == 2 or lib.kn_get_frame() < ON_TIME + 6:
        pass
    assert lib.kn_get_rollback_count() == 1
    assert lib.kn_get_failed_rollbacks() == 0
    return ran


@pytest.fixture(params=sorted(BACKENDS))
def backend(request):
    return request.param


def test_a_replay_runs_the_real_input_of_an_entry_a_stale_prediction_flagged(
    lib, backend
):
    # staleFlagTest: frame 10's input is predicted and never arrives, so the
    # flag stays set at index 10; ON_TIME (266 = 10 + 256) is stored there.
    assert ON_TIME % RING == 10
    start(lib, backend)
    try:
        ran = run(lib, never_fed=10)
        assert ran[ON_TIME + DELAY_FRAMES] == ("replay", PRESSED)
    finally:
        lib.kn_rollback_shutdown()


def test_a_replay_runs_the_real_input_when_every_prediction_was_verified(lib, backend):
    # everyPredictionVerifiedTest: the control.
    start(lib, backend)
    try:
        ran = run(lib, never_fed=None)
        assert ran[ON_TIME + DELAY_FRAMES] == ("replay", PRESSED)
    finally:
        lib.kn_rollback_shutdown()
