# Quint CI shards

`npm run spec` still runs the entire suite in `scripts/check-specs.sh` locally.
CI runs those same invocations across four jobs:

```sh
npm run spec -- --shard 1 4
bash scripts/check-specs.sh --list
bash scripts/check-specs.sh --list --shard 1 4
```

Each of the typecheck, scenario-test and random-run streams is dealt
independently, reversing lane order each round (1, 2, 3, 4, 4, 3, 2, 1). This
spreads adjacent expensive checks without a hand-maintained timing manifest.
Every invocation occurs once. Adding a check to the script needs
no parallel manifest. No model, variant, invariant, sample count, step bound or
random seed is changed by sharding. Commands log their arguments and
elapsed seconds, so a slow shard can be diagnosed without guessing.

The `spec` check retains its name and passes only when every `spec-shard` job
succeeds. The matrix does not cancel the other shards after a failure. The
partition, invalid arguments, executed commands, failure propagation and stable
gate are covered by `tests/test_spec_shards.py`, discovered by `server-unit`.

This reduces time waiting for the serial simulator, not the total work. Four
runners repeat installation and checkout; their summed runner time can rise.
The independent exhaustive Apalache checks, proofs and image checks remain
unchanged. Browser assertions are retained; its node-level scheduling is
explained in `ci-browser-shards.md`. These jobs can still determine the overall
completion time. This is not a claim that the whole CI finishes in two minutes.

For a before/after comparison, use the same source base and record workflow
elapsed time, queue delay, longest job and sum of job durations separately.
Compare repeated runs before claiming median or p95 improvement. Do not reduce
samples/depths or move checks after merge to improve the displayed time.

## Native simulator

Local `npm run spec` retains the built-in TypeScript reference evaluator and
downloads no executable. CI explicitly sets `QUINT_BACKEND=rust` after installing
the verified native evaluator. Both run the identical commands, sample counts
and depth limits. CI installs evaluator v0.7.1, matched to locked Quint
0.33.1, from the official Quint release and checks the published archive SHA-256
before extraction. A CLI upgrade that needs another evaluator fails closed until
the version and checksum are updated together.

This changes the implementation that evaluates the models, not the models or
checking bounds. The random generators can choose different traces; the same
seed is not a promise of trace-for-trace identity across backends. Rust uses signed 64-bit integers rather than the TypeScript
interpreter's arbitrary-precision integers. These finite-state models use small
bounded choices and counters at the existing bounded depths. A model that needs
larger integers must use the reference evaluator; never silently narrow its
values to make it pass. The scenario tests, including older broken variants,
remain in every CI run.

The runner invokes the installed, locked Quint CLI with Node directly rather
than starting npm for every command. The executable, arguments and failure
propagation are unchanged; if dependencies are missing, the check fails rather
than downloading a replacement.
