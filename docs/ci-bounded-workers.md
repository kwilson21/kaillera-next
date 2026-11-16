# Bounded-check workers

The local `bash scripts/verify-specs.sh` still runs the original checks serially.
Its `--plan` mode prints the same helper calls without running them. The optimized
runner reads that plan, not a separately maintained test allowlist:

```sh
python scripts/verify_specs.py --shard 1 --shards 14 --workers 2 --worker-cpus 2 --plan
python scripts/verify_specs.py --shard 1 --shards 14 --workers 2 --worker-cpus 2
```

Use Python 3.12 or newer (the runner uses `hashlib.file_digest` and the safe
`tarfile` extraction filter); CI should select that version explicitly.

Run all fourteen shards for the full suite. Each shard has two independent Apalache
JVMs, one per worker, capped at 2 GiB heap and two active processors apiece. On a
standard four-core Ubuntu runner this uses the existing machine's cores, not a
paid larger runner. Each JVM stays up for its worker's checks; Quint's supported
`--server-endpoint` connects successive checks to it. Owned server and client processes are reaped on
normal completion, failure, timeout and cancellation. Checks do not share an
Apalache server concurrently. `--worker-cpus` accepts 1–4 and defaults to 1;
this controls JVM processor budgeting, not proof bounds. The runner logs detected
CPU count and requested worker/CPU/heap budgets before starting verification.

Every original property, model variant, initial condition and bound is retained.
Expected counterexamples are still required. They pass only on Quint's exit 1
**and** its explicit `[violation]` marker. A timeout, signal, failed server or
parser error never counts as a counterexample. Existing negative checks run
before positive checks in each worker, exercising the checker and warming the
JVM. Failures are not hidden; the runner exits nonzero if any check/worker fails.

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

`scripts/verify-spec-times.json` contains advisory timings from hosted run
43793210537 (eight jobs with two workers and two JVM CPUs apiece). Measured
full command durations take precedence over heuristics. `estimated_seconds`
explicitly labels unmeasured new components: room partitions at 90 seconds,
streaming components at 90 seconds for bound 6 and 70 seconds for bound 5.
These are scheduling estimates, not achieved runtimes. A greedy load balancer uses these
only to assign work. New checks receive a default estimate and always run; stale
or missing timing entries cannot remove a check. Update timings after measuring
new hosted runs, not to make the list match a desired result.

Logical decomposition trades more total work for a shorter longest query. The
local room experiment reduced its longest query by 28% but roughly doubled
combined solver time. Fourteen standard-runner jobs with two workers apiece
provide additional parallel capacity, not free compute or a two-minute promise.
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
