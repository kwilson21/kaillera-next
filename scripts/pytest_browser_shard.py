"""Partition collected browser test nodes, including parametrizations, across CI.

Discovery remains pytest's and browser_shard.py's. Timings only order work;
unknown/new tests always receive a default weight and are never filtered out.
"""

from pathlib import Path

import pytest

# Seconds from hosted run 43784866402. Only the long waits need a weight;
# everything else defaults to one. These are scheduling hints, not a test list.
_SLOW = {
    "test_game_start_e2e.py::test_a_guest_that_loses_the_host_before_the_match_runs_joins_late": 34,
    "test_game_start_e2e.py::test_a_guest_that_never_answers_does_not_hold_the_hosts_start": 34,
    "test_game_start_e2e.py::test_in_a_room_of_three_the_other_guest_hears_who_was_left_out": 26,
    "test_game_start_e2e.py::test_a_start_reaching_a_page_with_no_rom_asks_for_one_and_joins_late": 23,
    "test_rom_transfer_e2e.py::test_a_resume_the_host_never_hears_is_asked_again": 14,
    "test_streaming_reconnect.py::test_a_guest_that_still_holds_the_old_connection_replaces_it": 11,
    "test_streaming_reconnect.py::test_a_dropped_connection_is_offered_again": 11,
    "test_remap_wizard_e2e.py::test_a_gamepad_takes_every_step_and_the_profile_is_saved_whole": 8,
    "test_e2e.py::test_auto_spectate_when_room_full": 8,
}


def _weight(nodeid: str) -> int:
    file, _, test = nodeid.partition("::")
    return _SLOW.get(f"{Path(file).name}::{test.split('[', 1)[0]}", 1)


def partition(nodeids: list[str], count: int) -> list[list[str]]:
    """Deal every collected node once, longest first, with a stable tie-break."""
    if not 1 <= count <= 64:
        raise ValueError("shard count must be between 1 and 64")
    if len(set(nodeids)) != len(nodeids):
        raise ValueError("duplicate collected node IDs")
    loads = [0] * count
    shards: list[list[str]] = [[] for _ in range(count)]
    for nodeid in sorted(nodeids, key=lambda node: (-_weight(node), node)):
        index = min(range(count), key=lambda shard: (loads[shard], shard))
        shards[index].append(nodeid)
        loads[index] += _weight(nodeid)
    return [sorted(shard) for shard in shards]


def pytest_addoption(parser):
    group = parser.getgroup("CI browser sharding")
    group.addoption("--ci-shard-index", type=int, help="one-based shard number")
    group.addoption("--ci-shard-count", type=int, help="total number of shards")


def pytest_collection_modifyitems(config, items):
    index = config.getoption("--ci-shard-index")
    count = config.getoption("--ci-shard-count")
    if index is None or count is None or not 1 <= index <= count <= 64:
        raise pytest.UsageError("set both --ci-shard-index and --ci-shard-count (1 <= index <= count <= 64)")
    try:
        shards = partition([item.nodeid for item in items], count)
    except ValueError as error:
        raise pytest.UsageError(str(error)) from error
    selected = set(shards[index - 1])
    if not selected:
        raise pytest.UsageError(f"browser shard {index}/{count} selected no tests")
    kept = [item for item in items if item.nodeid in selected]
    dropped = [item for item in items if item.nodeid not in selected]
    config.hook.pytest_deselected(items=dropped)
    reporter = config.pluginmanager.get_plugin("terminalreporter")
    if reporter:
        reporter.write_line(f"Browser shard {index}/{count}: {len(kept)} of {len(items)} collected nodes")
    items[:] = kept
