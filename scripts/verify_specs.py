"""Run the unchanged bounded-check plan on persistent, isolated Apalache workers.

The shell script remains the authoritative list. Splitting one conjunction changes
scheduling, not the initial states, transitions, bounds or expected counterexamples.
"""

import argparse
import concurrent.futures
import contextlib
import dataclasses
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUINT = ROOT / "node_modules/@informalsystems/quint/dist/src/cli.js"
APALACHE_VERSION = "0.62.4"
# Official release asset digest: github.com/apalache-mc/apalache/releases/tag/v0.62.4
APALACHE_SHA256 = "8ac8488422c30d552735bae11b92a2d014d8e02e8608702acc08f9a2d8a9abb2"
STOP = threading.Event()
SERVERS = []
CLIENTS = []
PORTS = set()
PORT_LOCK = threading.Lock()
CONJUNCTS = (
    "noWaitForAnInputThatCannotArrive",
    "neverBothWaitingOnNothing",
    "aPageAppliesWhatItSent",
    "aDueResyncIsNotLeftToItsDeadline",
)


STREAMING_CONJUNCTS = (
    "neverLeftWithNothingPending",
    "staleSignalsAreNotApplied",
    "receiversConnectOnlyToTheHost",
    "neverReplacesALiveConnection",
)
STREAMING_OPTIONS = ("HOST_REOFFERS", "SIGNALS_NAME_CONNECTION", "CHECKS_SENDER")
ROOM_FORWARD_PARTITIONS = tuple(
    "listeners.forall(p => (" + predicate + ') implies ((page.get(p) == Lobby) implies (status == "lobby")))'
    for predicate in ('p == "host"', 'p == "guest1"', 'p != "host" and p != "guest1"')
)

ROOM_PLAYERS = ("host", "guest1", "guest2")
ROOM_DIRECTIONS = (
    'listeners.forall(p => (page.get(p) == Lobby) implies (status == "lobby"))',
    'listeners.forall(p => (status == "lobby") implies (page.get(p) == Lobby))',
)
ROOM_PARTITIONED_DIRECTIONS = (*ROOM_FORWARD_PARTITIONS, ROOM_DIRECTIONS[1])
ROOM_NOT_STRANDED = tuple(
    f'match page.get("{player}") {{ | Stranded(_) => false | _ => true }}' for player in ROOM_PLAYERS
)


def name(value):
    return {"kind": "name", "name": value}


def literal(value):
    return {"kind": "bool" if isinstance(value, bool) else "str", "value": value}


def app(opcode, *args):
    return {"kind": "app", "opcode": opcode, "args": list(args)}


def lam(parameter, expr):
    return {"kind": "lambda", "params": [{"name": parameter}], "qualifier": "def", "expr": expr}


ROOM_EXPRESSIONS = {
    "PLAYERS": ("pureval", app("Set", *(literal(p) for p in ROOM_PLAYERS))),
    "pagesAgreeWithServer": (
        "val",
        app(
            "forall",
            name("listeners"),
            lam(
                "p",
                app(
                    "iff",
                    app("eq", app("get", name("page"), name("p")), name("Lobby")),
                    app("eq", name("status"), literal("lobby")),
                ),
            ),
        ),
    ),
    "nobodyIsStrandedInADroppedMatch": (
        "val",
        app(
            "forall",
            name("PLAYERS"),
            lam(
                "p",
                app(
                    "matchVariant",
                    app("get", name("page"), name("p")),
                    literal("Stranded"),
                    lam("_", literal(False)),
                    literal("_"),
                    lam("_", literal(True)),
                ),
            ),
        ),
    ),
}


def without_ids(value):
    if isinstance(value, dict):
        return {key: without_ids(item) for key, item in value.items() if key != "id"}
    if isinstance(value, list):
        return [without_ids(item) for item in value]
    return value


@dataclasses.dataclass(frozen=True)
class Check:
    spec: str
    module: str
    invariant: str
    init: str
    steps: int
    expect: str
    origin: int

    @property
    def key(self):
        return "|".join(map(str, (self.module, self.invariant, self.init, self.steps, self.expect)))


def shell_plan(root=ROOT):
    result = subprocess.run(
        ["bash", str(root / "scripts/verify-specs.sh"), "--plan"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    checks = []
    for origin, line in enumerate(result.stdout.splitlines()):
        fields = line.split("\t")
        if len(fields) != 6 or fields[5] not in {"hold", "violation"}:
            raise ValueError(f"invalid verification-plan row: {line!r}")
        spec, module, invariant, init, steps, expect = fields
        if not steps.isdecimal() or int(steps) < 0:
            raise ValueError(f"invalid step bound: {steps!r}")
        checks.append(Check(spec, module, invariant, init, int(steps), expect, origin))
    if not checks:
        raise ValueError("verification plan is empty")
    return checks


def validate_conjunction(ast):
    """Fail closed unless allHold is exactly the inherited AND of these names."""
    if ast.get("errors"):
        raise ValueError("Quint parser reported errors")
    modules = {m["name"]: m for m in ast["modules"]}
    declarations = modules["resync_inputs"]["declarations"]
    matches = [d for d in declarations if d.get("name") == "allHold"]
    if len(matches) != 1:
        raise ValueError("expected exactly one resync_inputs.allHold definition")
    definition = matches[0]
    expr = definition.get("expr", {})
    if (
        definition.get("kind") != "def"
        or definition.get("qualifier") != "val"
        or expr.get("kind") != "app"
        or expr.get("opcode") != "and"
        or [a.get("name") if a.get("kind") == "name" else None for a in expr.get("args", [])] != list(CONJUNCTS)
    ):
        raise ValueError("resync_inputs.allHold changed: revalidate its conjunction split")
    current = modules["resync_inputs_current"]["declarations"]
    if (
        len(current) != 1
        or current[0].get("kind") != "instance"
        or current[0].get("protoName") != "resync_inputs"
        or current[0].get("identityOverride") is not True
    ):
        raise ValueError("resync_inputs_current no longer inherits the same unmodified invariants")


def split_conjunction(checks, ast):
    validate_conjunction(ast)
    result = []
    for check in checks:
        if (check.spec, check.module, check.invariant, check.expect) == (
            "specs/resync_inputs.qnt",
            "resync_inputs_current",
            "allHold",
            "hold",
        ):
            result.extend(dataclasses.replace(check, invariant=name) for name in CONJUNCTS)
        else:
            result.append(check)
    return result


def split_streaming_conjunction(checks, ast):
    """The original positive allHold is exactly these four inherited conjuncts."""
    if ast.get("errors"):
        raise ValueError("Quint parser reported streaming-model errors")
    modules = {m["name"]: m for m in ast["modules"]}
    definitions = [d for d in modules["streaming_connection"]["declarations"] if d.get("name") == "allHold"]
    if (
        len(definitions) != 1
        or definitions[0].get("kind") != "def"
        or definitions[0].get("qualifier") != "val"
        or without_ids(definitions[0].get("expr")) != app("and", *(name(n) for n in STREAMING_CONJUNCTS))
    ):
        raise ValueError("streaming_connection.allHold changed: revalidate its conjunction split")
    expected_instance = {
        "kind": "instance",
        "protoName": "streaming_connection",
        "identityOverride": True,
        "overrides": [[{"name": option}, literal(True)] for option in STREAMING_OPTIONS],
    }
    if without_ids(modules["streaming_connection_current"]["declarations"]) != [expected_instance]:
        raise ValueError("streaming_connection_current no longer inherits the same configured invariants")
    result = []
    for check in checks:
        if (check.spec, check.module, check.invariant, check.expect) == (
            "specs/streaming_connection.qnt",
            "streaming_connection_current",
            "allHold",
            "hold",
        ):
            result.extend(dataclasses.replace(check, invariant=n) for n in STREAMING_CONJUNCTS)
        else:
            result.append(check)
    return result


def split_room_predicates(checks, ast):
    if ast.get("errors"):
        raise ValueError("Quint parser reported room-model errors")
    modules = {m["name"]: m for m in ast["modules"]}
    for property_name, (qualifier, expr) in ROOM_EXPRESSIONS.items():
        definitions = [d for d in modules["room"]["declarations"] if d.get("name") == property_name]
        if (
            len(definitions) != 1
            or definitions[0].get("kind") != "def"
            or definitions[0].get("qualifier") != qualifier
            or without_ids(definitions[0].get("expr")) != expr
        ):
            raise ValueError(f"room.{property_name} changed: revalidate the logical split")
    current = modules["room_current"]["declarations"]
    if (
        len(current) != 1
        or current[0].get("kind") != "instance"
        or current[0].get("protoName") != "room"
        or current[0].get("identityOverride") is not True
    ):
        raise ValueError("room_current no longer inherits the same unmodified predicates")
    result = []
    replacements = {
        "pagesAgreeWithServer": ROOM_PARTITIONED_DIRECTIONS,
        "nobodyIsStrandedInADroppedMatch": ROOM_NOT_STRANDED,
    }
    for check in checks:
        if (
            check.spec == "specs/room_lifecycle.qnt"
            and check.module == "room_current"
            and check.expect == "hold"
            and check.invariant in replacements
        ):
            result.extend(dataclasses.replace(check, invariant=expr) for expr in replacements[check.invariant])
        else:
            result.append(check)
    return result


def load_plan():
    checks = shell_plan()
    with tempfile.TemporaryDirectory(prefix="quint-plan-") as directory:
        for filename, split in (
            ("resync_inputs", split_conjunction),
            ("streaming_connection", split_streaming_conjunction),
            ("room_lifecycle", split_room_predicates),
        ):
            path = Path(directory) / f"{filename}.json"
            subprocess.run(
                ["node", str(QUINT), "parse", f"specs/{filename}.qnt", "--out", str(path)],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            checks = split(checks, json.loads(path.read_text()))
    return checks


def partition(checks, slots, durations):
    """Advisory timings balance work; new commands are always included."""
    if slots < 1:
        raise ValueError("worker count must be positive")
    bins = [[] for _ in range(slots)]
    loads = [0.0] * slots

    def estimate(check):
        if check.key in durations:
            return float(durations[check.key])
        if check.module == "streaming_connection_current" and check.invariant in STREAMING_CONJUNCTS:
            return 70.0 if check.steps <= 5 else 90.0
        if check.module == "room_current" and check.invariant in ROOM_FORWARD_PARTITIONS:
            return 90.0
        if check.module == "resync_inputs_current" and check.invariant in CONJUNCTS:
            return 75.0
        if check.module == "room_current" and check.invariant in ROOM_DIRECTIONS:
            return 90.0 if check.invariant == ROOM_DIRECTIONS[0] else 60.0
        if check.module == "room_current" and check.invariant in ROOM_NOT_STRANDED:
            return 60.0
        return float(durations.get(check.key, 5.0 if check.expect == "violation" else 30.0))

    # A genuine existing counterexample warms each JVM and exercises its
    # failure path before positive proofs. No extra or omitted checks.
    negatives = sorted((c for c in checks if c.expect == "violation"), key=lambda c: (estimate(c), c.origin))
    seeded = negatives[:slots] if len(negatives) >= slots else []
    for index, check in enumerate(seeded):
        bins[index].append(check)
        loads[index] += estimate(check)
    remaining = [c for c in checks if c not in seeded]
    for check in sorted(remaining, key=lambda c: (-estimate(c), c.origin, c.key)):
        index = min(range(slots), key=lambda i: (loads[i], i))
        bins[index].append(check)
        loads[index] += estimate(check)
    for batch in bins:
        batch.sort(key=lambda c: (c.expect != "violation", -estimate(c), c.origin))
    return bins


def accepted(check, returncode, output):
    if check.expect == "hold":
        return returncode == 0
    # A signal, timeout, parser error or missing binary is never a counterexample.
    # Quint's verified counterexample exit code is 1, with this explicit marker.
    plain = re.sub(r"\x1b\[[0-9;]*m", "", output)
    return returncode == 1 and re.search(r"(?m)^\[violation\] Found an issue \(\d+ms\)\.\s*$", plain) is not None


def archive_verified(path):
    with path.open("rb") as archive:
        return hashlib.file_digest(archive, "sha256").hexdigest() == APALACHE_SHA256


def fetch_apalache(directory):
    # Cache only the archive, not executable bytes. Verify it again before each
    # extraction so an altered/restored cache cannot become executable code.
    cache = Path(os.environ.get("QUINT_HOME", Path.home() / ".quint")) / f"apalache-dist-{APALACHE_VERSION}"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / "apalache.tgz"
    if not archive.exists() or not archive_verified(archive):
        url = f"https://github.com/apalache-mc/apalache/releases/download/v{APALACHE_VERSION}/apalache.tgz"
        with tempfile.NamedTemporaryFile(dir=cache, suffix=".download", delete=False) as download:
            temporary = Path(download.name)
            try:
                with urllib.request.urlopen(url, timeout=180) as response:
                    while chunk := response.read(1024 * 1024):
                        download.write(chunk)
                download.flush()
                if not archive_verified(temporary):
                    raise ValueError("Apalache archive checksum does not match the pinned official release")
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
    directory.mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as bundle:
        bundle.extractall(directory, filter="data")
    executable = directory / "apalache/bin/apalache-mc"
    if not executable.is_file():
        raise ValueError("verified Apalache archive has no expected executable")
    return executable


def free_port():
    # Do not give two concurrent workers the same recently released port.
    with PORT_LOCK:
        while True:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            if port not in PORTS:
                PORTS.add(port)
                return port


def stop_server(server):
    if server.poll() is None:
        try:
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            server.wait()
        except ProcessLookupError:
            server.wait()


def interrupted(signum, _frame):
    STOP.set()
    for server in [*SERVERS, *CLIENTS]:
        if server.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(server.pid, signal.SIGTERM)
    raise KeyboardInterrupt(f"verification interrupted by signal {signum}")


def blocked_fallback_home(directory):
    # Quint normally downloads/starts another checker when connecting fails.
    # Its version-specific executable lookup must find this fail-closed stub
    # instead: only the checksum-verified server we own may do verification.
    executable = directory / f"apalache-dist-{APALACHE_VERSION}/apalache/bin/apalache-mc"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\necho 'Unowned Apalache fallback is disabled' >&2\nexit 70\n")
    executable.chmod(0o755)
    return directory


def worker(index, checks, executable, directory, timeout, worker_cpus=1):
    if STOP.is_set():
        raise RuntimeError("verification cancelled")
    folder = directory / f"worker-{index}"
    folder.mkdir()
    client_home = blocked_fallback_home(folder / "client-home")
    port = free_port()
    with (folder / "server.log").open("w") as server_log:
        server = subprocess.Popen(
            [str(executable), "server", f"--port={port}"],
            cwd=folder,
            stdout=server_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=dict(
                os.environ,
                JVM_ARGS=(os.environ.get("JVM_ARGS", "") + f" -Xmx4g -XX:ActiveProcessorCount={worker_cpus}"),
            ),
        )
        SERVERS.append(server)
        try:
            deadline = time.monotonic() + 60
            while True:
                if STOP.is_set():
                    raise RuntimeError("verification cancelled")
                if server.poll() is not None:
                    raise RuntimeError(
                        f"worker {index}: Apalache exited during startup\n"
                        + (folder / "server.log").read_text()[-4000:]
                    )
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1):
                        break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"worker {index}: Apalache startup timed out") from error
                    time.sleep(0.2)
            failures = 0
            for number, check in enumerate(checks):
                if STOP.is_set():
                    raise RuntimeError("verification cancelled")
                if server.poll() is not None:
                    raise RuntimeError(f"worker {index}: Apalache exited before {check.key}")
                command = [
                    "node",
                    str(QUINT),
                    "verify",
                    str(ROOT / check.spec),
                    f"--main={check.module}",
                    f"--invariant={check.invariant}",
                    f"--init={check.init}",
                    f"--max-steps={check.steps}",
                    "--backend=apalache",
                    f"--apalache-version={APALACHE_VERSION}",
                    f"--server-endpoint=localhost:{port}",
                ]
                started = time.monotonic()
                log_path = folder / f"check-{number}.log"
                timed_out = False
                try:
                    with log_path.open("w") as log:
                        client = subprocess.Popen(
                            command,
                            cwd=folder,
                            stdout=log,
                            stderr=subprocess.STDOUT,
                            start_new_session=True,
                            env=dict(os.environ, QUINT_HOME=str(client_home)),
                        )
                        CLIENTS.append(client)
                        try:
                            if STOP.is_set():
                                raise RuntimeError("verification cancelled")
                            returncode = client.wait(timeout=timeout)
                        finally:
                            # Quint can spawn a fallback checker if its endpoint
                            # disappears. Reap its whole group as well as ours.
                            stop_server(client)
                            CLIENTS.remove(client)
                    output = log_path.read_text()
                    ok = server.poll() is None and accepted(check, returncode, output)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    stop_server(server)
                    ok = False
                    output = "verification timed out\n" + log_path.read_text()
                print(
                    json.dumps(
                        {
                            "check": check.key,
                            "origin": check.origin,
                            "passed": ok,
                            "seconds": round(time.monotonic() - started, 3),
                        }
                    ),
                    flush=True,
                )
                if not ok:
                    failures += 1
                    print(output[-12000:], file=sys.stderr, flush=True)
                if timed_out:
                    break
            return failures
        finally:
            stop_server(server)
            SERVERS.remove(server)


def main(argv=None):
    if sys.version_info < (3, 12):
        raise RuntimeError("bounded-check workers require Python 3.12 or newer")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", type=int, default=1)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--worker-cpus", type=int, choices=range(1, 5), default=1)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.shard <= args.shards <= 64 or args.timeout <= 0:
        parser.error("require 1 <= shard <= shards <= 64 and a positive timeout")
    plan = load_plan()
    timing_data = json.loads((ROOT / "scripts/verify-spec-times.json").read_text())
    durations = {**timing_data.get("estimated_seconds", {}), **timing_data["seconds"]}
    bins = partition(plan, args.shards * args.workers, durations)
    selected = bins[(args.shard - 1) * args.workers : args.shard * args.workers]
    if not all(selected):
        parser.error("each selected worker must have checks; reduce the shard/worker count")
    if args.plan:
        print(json.dumps([[dataclasses.asdict(c) for c in batch] for batch in selected], indent=2))
        return 0
    print(
        json.dumps(
            {
                "runner_cpus": os.cpu_count(),
                "workers": args.workers,
                "cpus_per_worker": args.worker_cpus,
                "heap_gib_per_worker": 4,
            }
        ),
        flush=True,
    )
    STOP.clear()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with (
        tempfile.TemporaryDirectory(prefix="apalache-workers-") as temp,
        concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool,
    ):
        executable = fetch_apalache(Path(temp) / "distribution")
        futures = [
            pool.submit(worker, n, batch, executable, Path(temp), args.timeout, args.worker_cpus)
            for n, batch in enumerate(selected)
        ]
        failures = 0
        for future in futures:
            try:
                failures += future.result()
            except Exception as error:
                failures += 1
                print(f"verification worker failed: {error}", file=sys.stderr)
    return int(failures != 0)


if __name__ == "__main__":
    raise SystemExit(main())
