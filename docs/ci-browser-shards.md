# Browser CI shards

Browser CI still discovers its files through `scripts/browser_shard.py --all`.
Pytest collects those files, including parametrized cases, and the explicit
`scripts.pytest_browser_shard` plugin partitions the resulting node IDs. Eight
jobs each start their own server/database and browser. No tests, markers,
fixtures, assertions or production timers are changed.

File-only sharding kept four long startup/deadline tests on the same runner.
Their measured calls alone took about 115 seconds in run 43784866402. The new
partition separates them without shortening the deadlines they test.

Nine measured long cases have scheduling weights in the plugin. They are not
an allowlist: every unknown or newly collected node gets weight one. Stale
weights can imbalance a run but cannot omit a test. Assignment is deterministic
for a given collected set, independent of collection order. Missing options,
invalid shard numbers, duplicate node IDs and empty shards fail closed.

Each job prints its selected/collected counts. Check the union of all selected
node IDs against an unsharded `--collect-only` run when changing this code;
`tests/test_browser_node_shards.py` also checks complete/disjoint assignment and
item identity preservation. Timing weights estimate execution, not GitHub queue
latency, and full exact-head CI must pass before reporting a speedup.

CI installs only Chromium's headless shell, the browser pytest already uses by
default. If this workflow later adds headed or explicit browser-channel tests,
its browser installation must be expanded too.
