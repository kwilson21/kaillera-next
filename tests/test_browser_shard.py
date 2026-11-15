"""scripts/browser_shard.py deals every browser test file to exactly one CI shard."""

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "browser_shard.py"
_spec = importlib.util.spec_from_file_location("browser_shard", _SCRIPT)
assert _spec is not None and _spec.loader is not None
browser_shard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser_shard)


def test_the_browser_files_are_the_ones_that_take_a_playwright_fixture():
    names = [name for name, _ in browser_shard.browser_files()]
    # Files this repository has had for a long time, on both sides of the line.
    assert "tests/test_e2e.py" in names
    assert "tests/test_room_overlay.py" in names
    assert "tests/test_db.py" not in names
    assert "tests/test_browser_shard.py" not in names


@pytest.mark.parametrize("count", [1, 2, 3, 4, 6])
def test_every_browser_file_is_in_exactly_one_shard(count):
    dealt = [name for index in range(1, count + 1) for name in browser_shard.shard(index, count)]
    assert sorted(dealt) == sorted(name for name, _ in browser_shard.browser_files())


def test_the_shards_are_within_the_largest_file_of_each_other():
    files = dict(browser_shard.browser_files())
    loads = [sum(files[name] for name in browser_shard.shard(index, 4)) for index in range(1, 5)]
    assert max(loads) - min(loads) <= max(files.values())
