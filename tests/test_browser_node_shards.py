"""CI partitions actual pytest node IDs without losing tests or parametrizations."""

import importlib.util
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts/pytest_browser_shard.py"
_spec = importlib.util.spec_from_file_location("pytest_browser_shard", _SCRIPT)
assert _spec is not None and _spec.loader is not None
sharding = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sharding)


@pytest.mark.parametrize("count", [1, 2, 4, 8, 16])
def test_every_node_occurs_exactly_once_including_new_tests_and_parameters(count):
    nodes = [f"tests/test_new.py::TestFuture::test_new[{n}]" for n in range(80)]
    nodes += [f"tests/{name}[chromium]" for name in sharding._SLOW]
    shards = sharding.partition(nodes, count)
    assert Counter(node for shard in shards for node in shard) == Counter(nodes)
    assert all(shards)
    assert shards == sharding.partition(list(reversed(nodes)), count)


def test_the_long_waits_do_not_all_stay_in_one_file_shard():
    nodes = [f"tests/{name}[chromium]" for name in sharding._SLOW if name.startswith("test_game_start_e2e")]
    shards = sharding.partition(nodes, 4)
    assert all(len(shard) == 1 for shard in shards)


@pytest.mark.parametrize("count", [0, -1, 65, 10**30])
def test_invalid_count_is_rejected(count):
    with pytest.raises(ValueError):
        sharding.partition(["test_a"], count)


def test_duplicate_nodes_are_rejected():
    with pytest.raises(ValueError, match="duplicate"):
        sharding.partition(["test_a", "test_a"], 1)


def _config(index, count):
    dropped = []
    config = SimpleNamespace(
        getoption=lambda option: index if option == "--ci-shard-index" else count,
        hook=SimpleNamespace(pytest_deselected=lambda items: dropped.extend(items)),
        pluginmanager=SimpleNamespace(get_plugin=lambda _: None),
    )
    return config, dropped


def test_hook_preserves_actual_items_fixtures_markers_and_original_order():
    original = [SimpleNamespace(nodeid=f"tests/new.py::test_a[{n}]", own_markers=[n]) for n in range(16)]
    all_kept = []
    for index in range(1, 9):
        items = original.copy()
        config, dropped = _config(index, 8)
        sharding.pytest_collection_modifyitems(config, items)
        assert len(items) + len(dropped) == len(original)
        assert all(any(item is old for old in original) for item in items)
        assert items == [old for old in original if old in items]
        assert not any(item in dropped for item in items)
        all_kept.extend(item.nodeid for item in items)
    assert Counter(all_kept) == Counter(item.nodeid for item in original)


@pytest.mark.parametrize("index,count", [(None, None), (1, None), (None, 8), (0, 8), (9, 8), (1, 65)])
def test_hook_rejects_missing_or_invalid_options(index, count):
    config, _ = _config(index, count)
    with pytest.raises(pytest.UsageError):
        sharding.pytest_collection_modifyitems(config, [SimpleNamespace(nodeid="test_a")])


def test_empty_shard_fails_instead_of_passing_without_tests():
    config, _ = _config(8, 8)
    with pytest.raises(pytest.UsageError, match="selected no tests"):
        sharding.pytest_collection_modifyitems(config, [SimpleNamespace(nodeid="test_a")])


def test_workflow_runs_the_plugin_when_it_changes_and_keeps_all_shards():
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/browser.yml").read_text()
    assert "- 'scripts/pytest_browser_shard.py'" in workflow
    assert "fail-fast: false" in workflow
    assert "shard: [1, 2, 3, 4, 5, 6, 7, 8]" in workflow
    assert "--ci-shard-count ${{ strategy.job-total }}" in workflow
    assert "--browser chromium" in workflow


def test_cached_dependencies_are_still_installed_from_the_lockfile():
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/browser.yml").read_text()
    assert "hashFiles('server/uv.lock')" in workflow
    assert "uv sync --directory server --frozen --extra dev" in workflow
    assert "npm ci --ignore-scripts" in workflow
    assert "cache: npm" in workflow
