# Bounded-check workers

The local `bash scripts/verify-specs.sh` still runs the original checks serially.
Its `--plan` mode prints the same helper calls without running them. The optimized
runner reads that plan, not a separately maintained test allowlist:

```sh
python scripts/verify_specs.py --shard 1 --shards 18 --workers 2 --worker-cpus 2 --solo-shards 5 --solo-worker-cpus 4 --plan
python scripts/verify_specs.py --shard 1 --shards 18 --workers 2 --worker-cpus 2 --solo-shards 5 --solo-worker-cpus 4
```

Use Python 3.12 or newer (the runner uses `hashlib.file_digest` and the safe
`tarfile` extraction filter); CI should select that version explicitly.

Run all eighteen shards for the full suite. The first five shards each run one
of the five heaviest positive commands, selected deterministically from the
full current plan and advisory weights. Each has a solo JVM with four active
processors. These bins are frozen: no other commands run ahead of or alongside
their proof. The remaining thirteen shards each have two independent JVMs with
two active processors apiece. All expected counterexamples remain in these
paired lanes. Every job computes the same complete layout; no manual property
allowlist or model-specific exclusion is used. `--solo-shards` defaults to zero,
which preserves the previous homogeneous partitioning.

Each JVM uses an explicit 4 GiB heap through the official launcher's `JVM_ARGS`.
Previously the runner supplied `-Xmx2g` through `JDK_JAVA_OPTIONS`, but Apalache's
launcher appended its own `-Xmx4096m` default afterward. The actual prior heap
was already 4 GiB. This correction preserves that measured resource budget and
makes the configuration and telemetry accurate. Real `PrintFlagsFinal` checks
confirmed `MaxHeapSize=4294967296` and the requested `ActiveProcessorCount`.

These are standard four-core Ubuntu runners, not paid larger runners. Each JVM
stays up for its assigned checks; Quint's supported `--server-endpoint` connects
successive checks to it. Processes are reaped on completion, failure, timeout
and cancellation. Checks never share a server concurrently. `--worker-cpus`
and `--solo-worker-cpus` accept 1–4; they control JVM budgeting, not proof bounds.
The runner logs detected CPUs and the actual selected worker/CPU/heap budgets.

Every original property, model variant, initial condition and bound is retained.
Expected counterexamples are still required. They pass only on Quint's exit 1
**and** its explicit `[violation]` marker. A timeout, signal, failed server or
parser error never counts as a counterexample. Existing negative checks run
before positive checks in paired workers, exercising the checker and warming
the JVM. Solo workers run their single positive proof directly. Failures are not hidden; the runner exits nonzero if any check/worker fails.

Selected positive proofs are split using exact logical identities:

- `resync_inputs_current.allHold` is exactly the AND of four named properties.
- `streaming_connection_current.allHold` is exactly the AND of four named
  properties. Both original initial conditions (`init` and `initLate`) retain
  their respective bounds (6 and 5).
- `room_current.pagesAgreeWithServer` universally quantifies an equivalence.
  Its fast status-to-page implication is unchanged. The slow page-to-status
  implication is checked for listeners equal to `host`, equal to `guest1`, and
  neither. Each guard stays inside the original universal quantifier. These
  predicates cover **any** listener domain, including future/unknown names; no
  assumption that listeners belong to `PLAYERS` is introduced. The conjunction
  of all three guarded implications is exactly the original implication.
- `room_current.nobodyIsStrandedInADroppedMatch` quantifies the literal constant
  set `PLAYERS = Set("host", "guest1", "guest2")`. Checking the unchanged predicate
  for all three literals proves the same universal statement. This does not
  restrict the model's states, transitions, players or runs.

The current plan has 113 original logical checks expanded into 127 commands,
including all 70 unchanged expected-counterexample checks.

Every component retains the original initial condition and bound. The runner
parses the real Quint AST and refuses these rewrites if the property, literal set
or module inheritance changes. No state, transition or bound is changed. The
old variants' expected failures are untouched.

`scripts/verify-spec-times.json` contains full per-command timings from hosted
run 43796621559 (fourteen jobs with two workers and two JVM CPUs apiece, with
the actual 4 GiB launcher-default heap). Measured durations take precedence over
fallback heuristics. A greedy balancer assigns every non-solo command to the
remaining lanes. Unknown checks receive a default estimate and always run;
stale or missing timing entries cannot remove a check. Update timings only
from measurements, not to make a desired result appear achieved.

Logical decomposition trades more total work for a shorter longest query. The
local room experiment reduced its longest query by 28% but roughly doubled
combined solver time. Eighteen standard-runner jobs provide five isolated and twenty-six paired
workers. This adds parallel capacity and reduces contention around the heaviest
queries, not free compute or a two-minute promise.
Queueing and total runner time must be measured alongside wall time.

The official Apalache 0.62.4 archive is checksum-pinned to its published release
asset digest. Only the archive is reused from `QUINT_HOME` (default `~/.quint`);
its digest is checked before every fresh extraction. No restored executable
cache is trusted. The CLI also requests the pinned checker version explicitly.
Each client receives an isolated `QUINT_HOME` with a fail-closed fallback stub:
if its owned server disappears, Quint cannot download or launch an unverified
replacement. Cancellation signals the process groups of live owned servers and clients.
The fallback stub prevents a client from starting a replacement checker.

This preserves bounded-check coverage, not a promise of a two-minute workflow.
A single hard SMT query, runner variability or account-wide queueing can still
determine the wall time. Measure the entire workflow, including queue/setup,
against the same workload. Do not reduce depth, delete counterexample checks or
move checks after merge to meet a timing target.
