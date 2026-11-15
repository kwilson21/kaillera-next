"""Print the browser test files one CI shard runs (.github/workflows/browser.yml).

A browser test file is a tests/test_*.py in which a test, a test method or a
fixture (a class's autouse `setup`, say) takes one of pytest-playwright's
fixtures: browser, context or page. Files are dealt out by their number of
tests, largest first, each to the shard with the fewest so far, so a new file
needs no list kept up to date.

Usage: python scripts/browser_shard.py SHARD COUNT   (SHARD counts from 1)
       python scripts/browser_shard.py --all         (every browser test file)
"""

import re
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent.parent / "tests"
# Any function's parameters (a test, a method, a fixture; on one line or
# several), and the Playwright fixtures among them.
_ANY_DEF = re.compile(r"^\s*(?:async )?def \w+\(([^)]*)\)", re.MULTILINE)
_FIXTURE = re.compile(r"\b(browser|context|page)\b")
# Test functions and test methods.
_ANY_TEST = re.compile(r"^\s*(?:async )?def test_", re.MULTILINE)


def browser_files() -> list[tuple[str, int]]:
    """Each browser test file, relative to the repository, with its number of tests."""
    found = []
    for path in sorted(TESTS.glob("test_*.py")):
        text = path.read_text()
        if any(_FIXTURE.search(params) for params in _ANY_DEF.findall(text)):
            found.append((f"tests/{path.name}", len(_ANY_TEST.findall(text))))
    return found


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
    if len(argv) != 2 or not all(a.isdigit() for a in argv) or not 1 <= int(argv[0]) <= int(argv[1]):
        print(__doc__, file=sys.stderr)
        return 2
    print("\n".join(shard(int(argv[0]), int(argv[1]))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
