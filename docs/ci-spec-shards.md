# Quint CI shards

`npm run spec` still runs the entire suite in `scripts/check-specs.sh` locally.
CI runs those same invocations across eight jobs:

```sh
npm run spec -- --shard 1 8
bash scripts/check-specs.sh --list
bash scripts/check-specs.sh --list --shard 1 8
```

Each of the typecheck, scenario-test and random-run streams is dealt round-robin
independently. Every invocation occurs once. Adding a check to the script needs
no parallel manifest. No model, variant, invariant, sample count, step bound,
backend or random seed is changed by sharding. Commands log their arguments and
elapsed seconds, so a slow shard can be diagnosed without guessing.

The `spec` check retains its name and passes only when every `spec-shard` job
succeeds. The matrix does not cancel the other shards after a failure. The
partition, invalid arguments, executed commands, failure propagation and stable
gate are covered by `tests/test_spec_shards.py`, discovered by `server-unit`.

This reduces time waiting for the serial simulator, not the total work. Eight
runners repeat installation and checkout; their summed runner time can rise.
The independent exhaustive Apalache checks, proofs, image and browser checks
remain unchanged and can still determine the overall completion time. This is
not a claim that the whole CI finishes in two minutes.

For a before/after comparison, use the same source base and record workflow
elapsed time, queue delay, longest job and sum of job durations separately.
Compare repeated runs before claiming median or p95 improvement. Do not reduce
samples/depths or move checks after merge to improve the displayed time.
