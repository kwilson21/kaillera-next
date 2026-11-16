"""Print the test files a CI job runs: one browser shard, or the server unit tests.

Every tests/test_*.py runs in exactly one of two jobs, decided by rule so a
new file needs no list kept up to date (a hand-kept list once left 33 files
in no job at all):

- The browser job (.github/workflows/browser.yml) runs the files that need
  what tests/conftest.py and pytest-playwright give: a test or a fixture (a
  class's autouse `setup`, say) takes `browser`, `context` or `page`, or one
  of conftest's fixtures the file does not define itself (`server_url`,
  `room`, `rom_path`, `start_game`). It starts the server and loads conftest.
  Files are dealt out by their number of tests, largest first, each to the
  shard with the fewest so far.
- The server unit job (`server-unit` in .github/workflows/lint.yml) runs every
  other file, without conftest or Playwright, after building the web bundles.

Usage: python scripts/browser_shard.py SHARD COUNT   (SHARD counts from 1)
       python scripts/browser_shard.py --all         (every browser test file)
       python scripts/browser_shard.py --unit        (every server unit test file)
"""

import re
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent.parent / "tests"
# pytest-playwright's fixtures.
_PLAYWRIGHT = {"browser", "context", "page"}
# A function with its decorators and its parameters (on one line or several).
_DEF = re.compile(r"((?:^[ \t]*@[^\n]*\n)*)^[ \t]*(?:async )?def (\w+)\(([^)]*)\)", re.MULTILINE)
# Test functions and test methods.
_ANY_TEST = re.compile(r"^\s*(?:async )?def test_", re.MULTILINE)
# A fixture in conftest.py, and whether it is autouse (every test gets it,
# so it says nothing about where a file runs).
_FIXTURE = re.compile(r"@pytest\.fixture(\([^)]*\))?\s*\ndef (\w+)\(")


def _conftest_fixtures() -> set[str]:
    """The fixtures tests/conftest.py gives a test that asks for them."""
    found = set()
    for args, name in _FIXTURE.findall((TESTS / "conftest.py").read_text()):
        if "autouse=True" in args or name == "browser_context_args":
            continue
        found.add(name)
    return found


def _needs_the_browser_job(text: str, fixtures: set[str]) -> bool:
    """Whether a test or a fixture in this file takes one of `fixtures` it does not define itself."""
    defs = _DEF.findall(text)
    own = {name for decorators, name, _ in defs if "pytest.fixture" in decorators}
    wanted = fixtures - own
    return any(
        (name.startswith("test_") or "pytest.fixture" in decorators) and wanted & set(re.findall(r"\b(\w+)\b", params))
        for decorators, name, params in defs
    )


def browser_files() -> list[tuple[str, int]]:
    """Each browser test file, relative to the repository, with its number of tests."""
    fixtures = _PLAYWRIGHT | _conftest_fixtures()
    found = []
    for path in sorted(TESTS.glob("test_*.py")):
        text = path.read_text()
        if _needs_the_browser_job(text, fixtures):
            found.append((f"tests/{path.name}", len(_ANY_TEST.findall(text))))
    return found


def unit_files() -> list[str]:
    """Every other test file, relative to the repository: the server unit job's."""
    browser = {name for name, _ in browser_files()}
    return [f"tests/{path.name}" for path in sorted(TESTS.glob("test_*.py")) if f"tests/{path.name}" not in browser]


def shard(index: int, count: int) -> list[str]:
    """The files shard `index` (from 1) of `count` runs."""
    loads = [0] * count
    picked: list[list[str]] = [[] for _ in range(count)]
    for name, tests in sorted(browser_files(), key=lambda f: (-f[1], f[0])):
        lightest = loads.index(min(loads))
        loads[lightest] += tests
        picked[lightest].append(name)
    return sorted(picked[index - 1])


def main(argv: list[str]) -> int:
    if argv == ["--all"]:
        print("\n".join(name for name, _ in browser_files()))
        return 0
    if argv == ["--unit"]:
        print("\n".join(unit_files()))
        return 0
    if len(argv) != 2 or not all(a.isdigit() for a in argv) or not 1 <= int(argv[0]) <= int(argv[1]):
        print(__doc__, file=sys.stderr)
        return 2
    print("\n".join(shard(int(argv[0]), int(argv[1]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
