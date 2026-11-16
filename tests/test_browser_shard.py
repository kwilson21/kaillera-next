"""scripts/browser_shard.py puts every test file in exactly one CI job, and deals the browser files to shards."""

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
    # Its test methods take only `self`; a class-level autouse fixture takes `browser`.
    assert "tests/test_virtual_gamepad.py" in names
    assert "tests/test_db.py" not in names
    assert "tests/test_browser_shard.py" not in names
    # They take no Playwright fixture but conftest's server (`server_url`):
    # they ran in no job while server-unit, without conftest, was a list.
    for needs_the_server in ("test_error_pages", "test_og", "test_og_e2e", "test_server_rest"):
        assert f"tests/{needs_the_server}.py" in names


def test_every_test_file_is_in_exactly_one_job():
    browser = [name for name, _ in browser_shard.browser_files()]
    unit = browser_shard.unit_files()
    every = sorted(f"tests/{path.name}" for path in browser_shard.TESTS.glob("test_*.py"))
    assert sorted(browser + unit) == every
    assert not set(browser) & set(unit)
    # It ran in no job, and a break on main went unseen (#274).
    assert "tests/test_late_join_simple.py" in unit
    # A helper's `room` parameter is not conftest's fixture.
    assert "tests/test_retention.py" in unit


def test_no_unit_file_needs_conftest():
    # server-unit runs with --noconftest: a file that takes one of conftest's
    # fixtures there would error. The rule sends any such file to the browser job.
    fixtures = browser_shard._conftest_fixtures()
    assert {"server_url", "room", "rom_path", "start_game"} <= fixtures
    for name in browser_shard.unit_files():
        text = (browser_shard.TESTS.parent / name).read_text()
        assert not browser_shard._needs_the_browser_job(text, fixtures | browser_shard._PLAYWRIGHT), name


def test_the_jobs_run_the_files_the_rule_finds():
    # No hand-kept list of test files: one left 33 of them in no job.
    workflows = browser_shard.TESTS.parent / ".github" / "workflows"
    lint = (workflows / "lint.yml").read_text()
    unit_step = lint[lint.index("- name: Server unit tests") :]
    unit_step = unit_step[: unit_step.index("- name:", 1)]
    assert "python scripts/browser_shard.py --unit" in unit_step
    assert "../tests/test_" not in unit_step
    assert "python scripts/browser_shard.py ${{ matrix.shard }} 4" in (workflows / "browser.yml").read_text()


@pytest.mark.parametrize("count", [1, 2, 3, 4, 6])
def test_every_browser_file_is_in_exactly_one_shard(count):
    dealt = [name for index in range(1, count + 1) for name in browser_shard.shard(index, count)]
    assert sorted(dealt) == sorted(name for name, _ in browser_shard.browser_files())


def test_the_shards_are_within_the_largest_file_of_each_other():
    files = dict(browser_shard.browser_files())
    loads = [sum(files[name] for name in browser_shard.shard(index, 4)) for index in range(1, 5)]
    assert max(loads) - min(loads) <= max(files.values())
