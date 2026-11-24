"""The CI shards execute the full Quint command set, without weakening it."""

import collections
import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check-specs.sh"


def plan(*args):
    result = subprocess.run(
        ["bash", str(SCRIPT), "--list", *map(str, args)], capture_output=True, text=True, check=True
    )
    return [tuple(shlex.split(line)) for line in result.stdout.splitlines()]


def test_shards_partition_every_command_once():
    full = collections.Counter(plan())
    for count in [1, 2, 4, 8, 17]:
        shards = [plan("--shard", n, count) for n in range(1, count + 1)]
        assert collections.Counter(command for shard in shards for command in shard) == full
        assert all(shards)


def test_invalid_shards_fail_closed():
    for args in [
        [],
        [0, 8],
        [9, 8],
        [1, 0],
        ["no", 8],
        ["01", 8],
        [1, 257],
        [99999999999999999999999999999, 8],
        [1, 99999999999999999999999999999],
        [1, 8, "extra"],
    ]:
        result = subprocess.run(["bash", str(SCRIPT), "--shard", *map(str, args)], capture_output=True, check=False)
        assert result.returncode == 2


def test_last_supported_shard_fails_only_when_it_is_empty():
    full = plan()
    # Commands of each kind are dealt independently across the 256 lanes.
    counts = collections.Counter(command[0] for command in full)
    result = subprocess.run(["bash", str(SCRIPT), "--list", "--shard", "256", "256"], capture_output=True, text=True)
    if max(counts.values()) < 256:
        assert result.returncode == 2
        assert "selected no checks" in result.stderr
    else:
        assert result.returncode == 0
        assert result.stdout.strip()


def test_execution_matches_plan_and_propagates_failure():
    with tempfile.TemporaryDirectory() as temp:
        runner = Path(temp) / "node"
        runner.write_text(
            "#!/usr/bin/env python3\nimport json, os, sys\n"
            'with open(os.environ["COMMAND_LOG"], "a") as out:\n'
            '    out.write(json.dumps(sys.argv[1:]) + "\\n")\n'
            'sys.exit(int(os.environ.get("FAIL", "0")))\n'
        )
        runner.chmod(0o755)
        log = Path(temp) / "commands.jsonl"
        env = dict(os.environ, PATH=f"{temp}:{os.environ['PATH']}", COMMAND_LOG=str(log))
        import json

        subprocess.run(["bash", str(SCRIPT), "--shard", "3", "8"], env=env, capture_output=True, check=True)
        actual = [json.loads(line) for line in log.read_text().splitlines()]
        assert actual == [
            ["node_modules/@informalsystems/quint/dist/src/cli.js", *command] for command in plan("--shard", 3, 8)
        ]
        log.unlink()
        result = subprocess.run(
            ["bash", str(SCRIPT), "--shard", "3", "8"], env=dict(env, FAIL="17"), capture_output=True, check=False
        )
        assert result.returncode == 17
        assert len(log.read_text().splitlines()) == 1


def test_workflow_preserves_stable_fail_closed_gate():
    workflow = (ROOT / ".github/workflows/lint.yml").read_text()
    shards = workflow.split("  spec-shard:\n", 1)[1].split("\n  spec:\n", 1)[0]
    numbers = re.search(r"shard: \[([^]]+)\]", shards).group(1)
    values = [int(n) for n in numbers.split(",")]
    assert values == list(range(1, len(values) + 1))
    assert "fail-fast: false" in shards
    assert "bash scripts/check-specs-pair.sh ${{ strategy.job-index }} ${{ strategy.job-total }}" in shards
    gate = workflow.split("\n  spec:\n", 1)[1].split("\n  spec-verify:", 1)[0]
    assert "needs: spec-shard" in gate
    assert "if: always()" in gate
    assert "RESULT: ${{ needs.spec-shard.result }}" in gate
    assert 'test "$RESULT" = success' in gate


def test_native_and_reference_backends_have_identical_checks():
    reference = plan()
    result = subprocess.run(
        ["bash", str(SCRIPT), "--list"],
        env=dict(os.environ, QUINT_BACKEND="rust"),
        capture_output=True,
        text=True,
        check=True,
    )
    native = [tuple(shlex.split(line)) for line in result.stdout.splitlines()]
    normalized = [tuple("--backend=typescript" if arg == "--backend=rust" else arg for arg in cmd) for cmd in native]
    assert normalized == reference
    assert all("--backend=rust" in cmd for cmd in native if cmd[0] in {"run", "test"})
    rejected = subprocess.run(
        ["bash", str(SCRIPT), "--list"], env=dict(os.environ, QUINT_BACKEND="unknown"), capture_output=True, check=False
    )
    assert rejected.returncode == 2


def test_native_installer_fails_before_using_an_unverified_download():
    installer = ROOT / "scripts/install-quint-evaluator.sh"
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        for name, text in {
            "node": "#!/bin/sh\necho v0.7.1\n",
            "uname": '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
            "curl": '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\nprintf tampered > "$2"\n',
            "tar": '#!/bin/sh\ntouch "$QUINT_HOME/extracted"\n',
        }.items():
            tool = directory / name
            tool.write_text(text)
            tool.chmod(0o755)
        result = subprocess.run(
            ["bash", str(installer)],
            env=dict(os.environ, PATH=f"{temp}:{os.environ['PATH']}", QUINT_HOME=temp),
            capture_output=True,
            check=False,
        )
        assert result.returncode != 0
        assert not (directory / "extracted").exists()


def test_serpentine_dealing_reverses_each_round_without_changing_command_order():
    full = plan()
    for count in [2, 4, 8]:
        expected = [[] for _ in range(count)]
        counters = collections.Counter()
        for command in full:
            index = counters[command[0]]
            counters[command[0]] += 1
            position = index % (2 * count)
            if position >= count:
                position = 2 * count - 1 - position
            expected[position].append(command)
        assert [plan("--shard", n, count) for n in range(1, count + 1)] == expected
