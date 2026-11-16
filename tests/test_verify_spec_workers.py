"""The bounded verifier scheduler cannot omit checks or weaken their meaning."""

import collections
import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_specs", ROOT / "scripts/verify_specs.py")
verify = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verify
SPEC.loader.exec_module(verify)


def ast_fixture():
    return {
        "errors": [],
        "modules": [
            {
                "name": "resync_inputs",
                "declarations": [
                    {
                        "kind": "def",
                        "name": "allHold",
                        "qualifier": "val",
                        "expr": {
                            "kind": "app",
                            "opcode": "and",
                            "args": [{"kind": "name", "name": name} for name in verify.CONJUNCTS],
                        },
                    }
                ],
            },
            {
                "name": "resync_inputs_current",
                "declarations": [{"kind": "instance", "protoName": "resync_inputs", "identityOverride": True}],
            },
        ],
    }


def test_original_plan_and_all_shards_preserve_every_check():
    original = verify.shell_plan()
    expanded = verify.load_plan()  # Real Quint AST, not a regex over source.
    expected = []
    for check in original:
        if (check.spec, check.module, check.invariant, check.expect) == (
            "specs/resync_inputs.qnt",
            "resync_inputs_current",
            "allHold",
            "hold",
        ):
            expected.extend(verify.dataclasses.replace(check, invariant=name) for name in verify.CONJUNCTS)
        elif (check.spec, check.module, check.invariant, check.expect) == (
            "specs/room_lifecycle.qnt",
            "room_current",
            "pagesAgreeWithServer",
            "hold",
        ):
            expected.extend(verify.dataclasses.replace(check, invariant=n) for n in verify.ROOM_DIRECTIONS)
        elif (check.spec, check.module, check.invariant, check.expect) == (
            "specs/room_lifecycle.qnt",
            "room_current",
            "nobodyIsStrandedInADroppedMatch",
            "hold",
        ):
            expected.extend(verify.dataclasses.replace(check, invariant=n) for n in verify.ROOM_NOT_STRANDED)
        else:
            expected.append(check)
    assert expanded == expected
    assert [c for c in expanded if c.expect == "violation"] == [c for c in original if c.expect == "violation"]
    timings = json.loads((ROOT / "scripts/verify-spec-times.json").read_text())["seconds"]
    for slots in (1, 4, 16, 20):
        bins = verify.partition(expanded, slots, timings)
        assert all(bins)
        assert collections.Counter(c for batch in bins for c in batch) == collections.Counter(expanded)
    # Timings are never an allowlist: a new check is still scheduled.
    new = verify.dataclasses.replace(original[0], module="a_new_module", origin=100000)
    bins = verify.partition([*expanded, new], 16, timings)
    assert sum(batch.count(new) for batch in bins) == 1


def test_split_preserves_init_bound_and_origin_and_never_splits_negative():
    check = verify.Check("specs/resync_inputs.qnt", "resync_inputs_current", "allHold", "specialInit", 17, "hold", 42)
    expected = [verify.dataclasses.replace(check, invariant=n) for n in verify.CONJUNCTS]
    assert verify.split_conjunction([check], ast_fixture()) == expected
    negative = verify.dataclasses.replace(check, expect="violation")
    assert verify.split_conjunction([negative], ast_fixture()) == [negative]


def test_split_fails_closed_if_ast_changes():
    original = ast_fixture()
    for mutation in ("or", "extra", "fewer", "expression", "qualifier", "override", "instance", "errors"):
        ast = copy.deepcopy(original)
        declaration = ast["modules"][0]["declarations"][0]
        args = declaration["expr"]["args"]
        if mutation == "or":
            declaration["expr"]["opcode"] = "or"
        elif mutation == "extra":
            args.append({"kind": "name", "name": "anotherProperty"})
        elif mutation == "fewer":
            args.pop()
        elif mutation == "expression":
            args[0] = {"kind": "app", "opcode": "not", "args": [args[0]]}
        elif mutation == "qualifier":
            declaration["qualifier"] = "action"
        elif mutation == "override":
            ast["modules"][1]["declarations"].append(declaration)
        elif mutation == "instance":
            ast["modules"][1]["declarations"][0]["protoName"] = "a_different_spec"
        else:
            ast["errors"] = ["parse error"]
        with pytest.raises(ValueError):
            verify.validate_conjunction(ast)


def test_expected_counterexamples_fail_closed():
    hold = verify.Check("a.qnt", "a", "p", "init", 6, "hold", 0)
    negative = verify.dataclasses.replace(hold, expect="violation")
    assert verify.accepted(hold, 0, "[ok]")
    assert not verify.accepted(hold, 1, "[violation]")
    assert verify.accepted(negative, 1, "[violation] Found an issue (42ms).")
    for code in (0, -9, -15, 2, 124, 127):
        assert not verify.accepted(negative, code, "[violation]")
    assert not verify.accepted(negative, 1, "parser error")
    assert not verify.accepted(negative, 1, "parser error: invalid name '[violation]'")
    assert not verify.accepted(negative, 1, "[violation]")


def test_invalid_and_empty_shards_fail_before_starting_workers():
    script = str(ROOT / "scripts/verify_specs.py")
    for args in (
        ["--shard", "0"],
        ["--shard", "2"],
        ["--shards", "65"],
        ["--workers", "5"],
        ["--worker-cpus", "0"],
        ["--worker-cpus", "5"],
        ["--timeout", "0"],
        ["--shard", "64", "--shards", "64", "--workers", "4"],
    ):
        result = subprocess.run([sys.executable, script, "--plan", *args], capture_output=True, text=True)
        assert result.returncode != 0


def test_server_cleanup_kills_process_group_and_reaps(monkeypatch):
    calls = []
    monkeypatch.setattr(verify.os, "killpg", lambda pid, sig: calls.append((pid, sig)))

    class Server:
        pid = 123456

        def poll(self):
            return None

        def wait(self, timeout=None):
            calls.append(("wait", timeout))
            if timeout:
                raise subprocess.TimeoutExpired("server", timeout)

    verify.stop_server(Server())
    assert calls == [(123456, verify.signal.SIGTERM), ("wait", 10), (123456, verify.signal.SIGKILL), ("wait", None)]


def test_cached_distribution_is_verified_before_execution(tmp_path, monkeypatch):
    import hashlib
    import io
    import tarfile

    binary = b"#!/bin/sh\nexit 0\n"
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tar:
        member = tarfile.TarInfo("apalache/bin/apalache-mc")
        member.size = len(binary)
        member.mode = 0o755
        tar.addfile(member, io.BytesIO(binary))
    archive_bytes = data.getvalue()
    monkeypatch.setenv("QUINT_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(verify, "APALACHE_SHA256", hashlib.sha256(archive_bytes).hexdigest())
    requested = []

    def download(url, timeout):
        requested.append(url)
        return io.BytesIO(archive_bytes)

    monkeypatch.setattr(verify.urllib.request, "urlopen", download)
    binary_path = verify.fetch_apalache(tmp_path / "first")
    assert binary_path.read_bytes() == binary
    assert len(requested) == 1
    verify.fetch_apalache(tmp_path / "second")
    assert len(requested) == 1
    archive = tmp_path / "cache" / f"apalache-dist-{verify.APALACHE_VERSION}" / "apalache.tgz"
    archive.write_bytes(b"altered cache")
    verify.fetch_apalache(tmp_path / "third")
    assert len(requested) == 2
    assert verify.archive_verified(archive)
    archive.write_bytes(b"altered cache again")
    monkeypatch.setattr(verify.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(b"wrong download"))
    with pytest.raises(ValueError, match="checksum"):
        verify.fetch_apalache(tmp_path / "must-not-extract")
    assert not (tmp_path / "must-not-extract").exists()


def test_distribution_rejects_archive_path_escape(tmp_path, monkeypatch):
    import hashlib
    import io
    import tarfile

    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tar:
        member = tarfile.TarInfo("../escaped")
        member.size = 1
        tar.addfile(member, io.BytesIO(b"x"))
    archive_bytes = data.getvalue()
    monkeypatch.setenv("QUINT_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(verify, "APALACHE_SHA256", hashlib.sha256(archive_bytes).hexdigest())
    monkeypatch.setattr(verify.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(archive_bytes))
    with pytest.raises(tarfile.TarError):
        verify.fetch_apalache(tmp_path / "distribution")
    assert not (tmp_path / "escaped").exists()


def room_ast_fixture():
    return {
        "errors": [],
        "modules": [
            {
                "name": "room",
                "declarations": [
                    {"kind": "def", "name": name, "qualifier": qualifier, "expr": copy.deepcopy(expr)}
                    for name, (qualifier, expr) in verify.ROOM_EXPRESSIONS.items()
                ],
            },
            {
                "name": "room_current",
                "declarations": [{"kind": "instance", "protoName": "room", "identityOverride": True}],
            },
        ],
    }


def test_room_split_is_guarded_and_preserves_every_bound_and_negative():
    original = [
        verify.Check("specs/room_lifecycle.qnt", "room_current", property_name, "otherInit", 17, "hold", n)
        for n, property_name in enumerate(("pagesAgreeWithServer", "nobodyIsStrandedInADroppedMatch"))
    ]
    negatives = [verify.dataclasses.replace(c, expect="violation") for c in original]
    expected = [verify.dataclasses.replace(original[0], invariant=p) for p in verify.ROOM_DIRECTIONS]
    expected += [verify.dataclasses.replace(original[1], invariant=p) for p in verify.ROOM_NOT_STRANDED]
    assert verify.split_room_predicates([*original, *negatives], room_ast_fixture()) == [*expected, *negatives]
    for mutation in ("players", "iff", "listeners", "pattern", "instance", "override"):
        ast = room_ast_fixture()
        declarations = ast["modules"][0]["declarations"]
        if mutation == "players":
            declarations[0]["expr"]["args"].append(verify.literal("anotherPlayer"))
        elif mutation == "iff":
            declarations[1]["expr"]["args"][1]["expr"]["opcode"] = "implies"
        elif mutation == "listeners":
            declarations[1]["expr"]["args"][0]["name"] = "online"
        elif mutation == "pattern":
            declarations[2]["expr"]["args"][1]["expr"]["args"][1]["value"] = "Lobby"
        elif mutation == "instance":
            ast["modules"][1]["declarations"][0]["protoName"] = "otherRoom"
        else:
            ast["modules"][1]["declarations"].append(declarations[1])
        with pytest.raises(ValueError):
            verify.split_room_predicates(original, ast)


def test_room_logical_identities_on_every_boolean_assignment():
    import itertools

    for status, *pages in itertools.product((False, True), repeat=4):
        for listeners in itertools.product((False, True), repeat=3):
            original = all(page == status for page, listens in zip(pages, listeners, strict=True) if listens)
            forward = all(not page or status for page, listens in zip(pages, listeners, strict=True) if listens)
            reverse = all(not status or page for page, listens in zip(pages, listeners, strict=True) if listens)
            assert original == (forward and reverse)
    for stranded in itertools.product((False, True), repeat=3):
        whole = all(not is_stranded for is_stranded in stranded)
        assert whole == (not stranded[0] and not stranded[1] and not stranded[2])


def test_interrupt_stops_server_and_client_groups(monkeypatch):
    calls = []

    class Process:
        def __init__(self, pid):
            self.pid = pid

        def poll(self):
            return None

    monkeypatch.setattr(verify, "SERVERS", [Process(111)])
    monkeypatch.setattr(verify, "CLIENTS", [Process(222)])
    monkeypatch.setattr(verify.os, "killpg", lambda pid, sig: calls.append((pid, sig)))
    try:
        with pytest.raises(KeyboardInterrupt):
            verify.interrupted(verify.signal.SIGTERM, None)
        assert verify.STOP.is_set()
        assert calls == [(111, verify.signal.SIGTERM), (222, verify.signal.SIGTERM)]
    finally:
        verify.STOP.clear()


def test_cancelled_worker_does_not_start_a_process(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("cancelled worker started a process")

    monkeypatch.setattr(verify.subprocess, "Popen", forbidden)
    verify.STOP.set()
    try:
        with pytest.raises(RuntimeError, match="cancelled"):
            verify.worker(0, [], Path("unused"), tmp_path, 1)
    finally:
        verify.STOP.clear()


def test_quint_uses_blocked_fallback_without_downloading(tmp_path):
    import os

    home = verify.blocked_fallback_home(tmp_path / "quint-home")
    stub = home / f"apalache-dist-{verify.APALACHE_VERSION}/apalache/bin/apalache-mc"
    assert subprocess.run([str(stub)], capture_output=True).returncode == 70
    # Exercise the installed CLI's real QUINT_HOME lookup and connect fallback,
    # not merely our path construction. No server or download is allowed here.
    port = verify.free_port()
    result = subprocess.run(
        [
            "node",
            str(verify.QUINT),
            "verify",
            str(ROOT / "specs/rom_at_start.qnt"),
            "--main=rom_at_start_current",
            "--invariant=allHold",
            "--max-steps=0",
            f"--server-endpoint=localhost:{port}",
            f"--apalache-version={verify.APALACHE_VERSION}",
        ],
        env=dict(os.environ, QUINT_HOME=str(home)),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 1
    negative = verify.Check("a.qnt", "a", "p", "init", 6, "violation", 0)
    assert not verify.accepted(negative, result.returncode, result.stdout + result.stderr)
    assert "Unowned Apalache fallback is disabled" in result.stdout + result.stderr
    assert "Downloading Apalache" not in result.stdout + result.stderr


@pytest.mark.parametrize("cpus", [1, 2, 4])
def test_worker_cpu_budget_reaches_jvm(monkeypatch, tmp_path, cpus):
    captured = {}

    def launch(*args, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop before starting a real JVM")

    monkeypatch.setattr(verify.subprocess, "Popen", launch)
    verify.STOP.clear()
    with pytest.raises(RuntimeError, match="stop before"):
        verify.worker(0, [], Path("unused"), tmp_path, 1, cpus)
    assert f"-XX:ActiveProcessorCount={cpus}" in captured["env"]["JDK_JAVA_OPTIONS"]
    assert "-Xmx2g" in captured["env"]["JDK_JAVA_OPTIONS"]
