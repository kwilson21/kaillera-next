"""The rollback engine's debug log (build/kn_rollback/kn_rollback.c, rb_log).

The play page drains the log into its session log every few seconds and
empties it (kn_clear_debug_log), so it only has to hold what is logged between
two drains. A line that does not fit whole is counted, never cut
(kn_get_debug_log_dropped), and the drain reports the count. These run the
real engine against fake_core.c; kn_rollback_slot_reset logs one line a call.
"""

from __future__ import annotations

import ctypes

import pytest

LINE = "slot_reset: slot=1\n"


@pytest.fixture
def rb(lib):
    lib.kn_get_debug_log.restype = ctypes.c_char_p
    lib.kn_rollback_init(7, 2, 0, 2)
    lib.kn_clear_debug_log()
    yield lib
    lib.kn_rollback_shutdown()


def log_of(lib) -> str:
    return lib.kn_get_debug_log().decode()


def test_a_line_is_logged_whole(rb):
    rb.kn_rollback_slot_reset(1)
    assert log_of(rb) == LINE
    assert rb.kn_get_debug_log_dropped() == 0


def test_clearing_empties_the_log_and_logging_goes_on(rb):
    rb.kn_rollback_slot_reset(1)
    rb.kn_clear_debug_log()
    assert log_of(rb) == ""
    rb.kn_rollback_slot_reset(1)
    assert log_of(rb) == LINE


def test_a_full_log_counts_what_it_drops_and_cuts_no_line(rb):
    # Fill it: more lines than 512 KB holds.
    calls = 512 * 1024 // len(LINE) + 50
    for _ in range(calls):
        rb.kn_rollback_slot_reset(1)
    text = log_of(rb)
    kept = text.count("\n")
    assert text.endswith("\n"), "the last line was cut"
    assert set(text.splitlines()) == {LINE.strip()}
    assert kept + rb.kn_get_debug_log_dropped() == calls
    assert rb.kn_get_debug_log_dropped() > 0
    # Emptied, it takes lines again; the count stays until the next init.
    dropped = rb.kn_get_debug_log_dropped()
    rb.kn_clear_debug_log()
    rb.kn_rollback_slot_reset(1)
    assert log_of(rb) == LINE
    assert rb.kn_get_debug_log_dropped() == dropped


def test_init_starts_the_count_over(rb):
    for _ in range(512 * 1024 // len(LINE) + 10):
        rb.kn_rollback_slot_reset(1)
    assert rb.kn_get_debug_log_dropped() > 0
    rb.kn_rollback_init(7, 2, 0, 2)
    assert rb.kn_get_debug_log_dropped() == 0
