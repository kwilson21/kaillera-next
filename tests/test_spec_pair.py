"""Concurrent native jobs preserve the partition and fail closed."""

import collections
import os
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/check-specs-pair.sh"


def fixture_script(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    wrapper = scripts / WRAPPER.name
    wrapper.write_text(WRAPPER.read_text())
    (scripts / "check-specs.sh").write_text("""#!/usr/bin/env bash
if [ "$1" = --list ]; then exit "${PREFLIGHT_FAIL:-0}"; fi
exec python3 - "$2" "$3" <<'CHILD'
import os, pathlib, signal, sys, time
n, total = sys.argv[1:]
root = pathlib.Path(os.environ["MARKERS"])
def stop(*args):
    (root / (n + ".stopped")).touch()
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
(root / (n + ".started")).write_text(total)
time.sleep(float(os.environ.get("DELAY_" + n, "0")))
(root / (n + ".done")).touch()
print("logical", n, total)
sys.exit(1 if n in os.environ.get("FAIL", "").split() else 0)
CHILD
""")
    return wrapper, dict(os.environ, MARKERS=str(tmp_path))


def test_pair_maps_actual_job_count_once(tmp_path):
    wrapper, env = fixture_script(tmp_path)
    for count in [1, 4, 7]:
        actual = []
        for index in range(count):
            result = subprocess.run(
                ["bash", str(wrapper), str(index), str(count)], env=env, capture_output=True, text=True, check=True
            )
            actual.extend(tuple(map(int, line.split()[1:])) for line in result.stdout.splitlines())
        assert collections.Counter(actual) == collections.Counter((n, count * 2) for n in range(1, count * 2 + 1))


def test_pair_rejects_invalid_inputs(tmp_path):
    wrapper, env = fixture_script(tmp_path)
    for args in [[], [0], [-1, 4], [4, 4], [0, 0], [0, 129], ["00", 4], ["a", 4], [0, "04"], [10**30, 4], [0, 4, 8]]:
        result = subprocess.run(["bash", str(wrapper), *map(str, args)], env=env, capture_output=True)
        assert result.returncode == 2
    assert not list(tmp_path.glob("*.started"))
    result = subprocess.run(["bash", str(wrapper), "0", "4"], env=dict(env, PREFLIGHT_FAIL="2"), capture_output=True)
    assert result.returncode == 2
    assert not list(tmp_path.glob("*.started"))


def test_pair_waits_both_and_propagates_either_failure(tmp_path):
    wrapper, env = fixture_script(tmp_path)
    for failed in ["", "2", "6", "2 6"]:
        for marker in tmp_path.glob("*.done"):
            marker.unlink()
        result = subprocess.run(
            ["bash", str(wrapper), "1", "4"],
            env=dict(env, FAIL=failed, DELAY_6="0.1"),
            capture_output=True,
            text=True,
        )
        assert result.returncode == (1 if failed else 0)
        assert (tmp_path / "2.done").exists() and (tmp_path / "6.done").exists()
        assert set(result.stdout.splitlines()) == {"logical 2 8", "logical 6 8"}


def test_pair_term_stops_direct_children(tmp_path):
    wrapper, env = fixture_script(tmp_path)
    process = subprocess.Popen(
        ["bash", str(wrapper), "1", "4"],
        env=dict(env, DELAY_2="20", DELAY_6="20"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 5
        while not all((tmp_path / f"{n}.started").exists() for n in [2, 6]):
            assert time.monotonic() < deadline
            time.sleep(0.01)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        assert process.returncode == 143
        assert all((tmp_path / f"{n}.stopped").exists() for n in [2, 6])
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
