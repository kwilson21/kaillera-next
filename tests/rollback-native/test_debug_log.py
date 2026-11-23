"""The rollback engine's debug log keeps flowing past its 64 KB buffer.

rb_log used to append to a 64 KB buffer and drop every line once it was
full, so in a real match the C log (MISPREDICTION, DEEP-MISPREDICT-SKIP,
RESTORE-FAILED...) stopped after a few hundred rollbacks. The buffer now
drops its oldest lines to make room and counts the bytes dropped
(kn_get_debug_log_dropped); the page drains it by absolute offset
(_drainCDebugLog in web/static/netplay-rollback.js). These run the real
engine against fake_core.c and drain the way the page does."""

from __future__ import annotations

import ctypes

import pytest

LOG_SIZE = 64 * 1024


@pytest.fixture
def log(lib):
    lib.kn_get_debug_log.restype = ctypes.c_char_p
    lib.kn_get_debug_log_dropped.restype = ctypes.c_uint32
    lib.kn_set_state_backend(1)
    lib.kn_rollback_init(7, 2, 0, 2)
    yield lib
    lib.kn_rollback_shutdown()


def snapshot(lib) -> tuple[int, str]:
    """(bytes dropped before the buffer, the buffer)."""
    return lib.kn_get_debug_log_dropped(), lib.kn_get_debug_log().decode()


class Drain:
    """The page's drain: remembers the absolute offset it read up to."""

    def __init__(self, lib) -> None:
        self.lib = lib
        dropped, full = snapshot(lib)
        self.to = dropped + len(full)
        self.lines: list[str] = []
        self.missed = 0

    def __call__(self) -> None:
        dropped, full = snapshot(self.lib)
        end = dropped + len(full)
        assert end >= self.to
        start = self.to - dropped
        if start < 0:
            self.missed += -start
            start = 0
        self.lines += [line for line in full[start:].split("\n") if line]
        self.to = end


def log_frames(lib, frames: range) -> None:
    for frame in frames:
        lib.kn_set_frame(frame)


def test_the_log_keeps_the_newest_lines_past_its_size(log):
    first_dropped, _ = snapshot(log)
    log_frames(log, range(20_000))  # ~20 bytes a line: about 6x the buffer
    dropped, full = snapshot(log)
    assert dropped > first_dropped
    assert len(full) < LOG_SIZE
    assert full.endswith("kn_set_frame: 19999\n")
    # The buffer starts on a whole line, and its lines are the newest, in order.
    lines = full.split("\n")[:-1]
    first = int(lines[0].removeprefix("kn_set_frame: "))
    assert lines == [f"kn_set_frame: {f}" for f in range(first, 20_000)]
    # At least half the buffer stays after a drop.
    assert len(full) >= LOG_SIZE // 2 - 64


def test_a_drain_by_offset_reads_every_line_once(log):
    drain = Drain(log)
    for start in range(0, 30_000, 1_000):
        log_frames(log, range(start, start + 1_000))
        drain()
    assert drain.missed == 0
    assert drain.lines == [f"kn_set_frame: {f}" for f in range(30_000)]


def test_a_drain_that_falls_behind_counts_what_it_missed(log):
    drain = Drain(log)
    log_frames(log, range(10_000))
    drain()
    assert drain.missed > 0
    assert drain.lines[-1] == "kn_set_frame: 9999"
    # What it missed and what it read add up to everything logged.
    assert drain.missed + sum(len(line) + 1 for line in drain.lines) == sum(
        len(f"kn_set_frame: {f}\n") for f in range(10_000)
    )


def test_a_new_init_continues_the_log(log):
    # kn_rollback_init (a new match on the same page) does not restart the
    # log, so the page's offset stays valid across it.
    drain = Drain(log)
    for _ in range(3):
        log_frames(log, range(1_000))
        log.kn_rollback_init(7, 2, 0, 2)
        drain()
    log_frames(log, range(3))
    drain()
    assert drain.missed == 0
    assert drain.lines[-3:] == ["kn_set_frame: 0", "kn_set_frame: 1", "kn_set_frame: 2"]
    assert sum(line == "kn_set_frame: 999" for line in drain.lines) == 3
    assert sum(line.startswith("kn_rollback_init: max=") for line in drain.lines) == 3
