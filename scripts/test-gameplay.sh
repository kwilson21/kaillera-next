#!/usr/bin/env bash
# scripts/test-gameplay.sh — run the rollback gameplay tests (PR #9's test
# plan) against two builds and print the results side by side:
#
#   merged  — the current checkout
#   pr9     — origin/kn-peek-pending-rollback-core, untouched
#
# Needs a ROM you own; it is only read from disk by the local browser and
# never copied anywhere.
#
# Usage (from anywhere inside the repo):
#   scripts/test-gameplay.sh [path/to/rom.z64]
#
# Default ROM path: .playwright-mcp/smash_remix.z64 in the repo root.
# Results land in test-results/gameplay/ (gitignored). Paste summary.txt back.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

ROM="${1:-$REPO/.playwright-mcp/smash_remix.z64}"
PORT=27888
OUT="$REPO/test-results/gameplay"
PR9_REF="origin/kn-peek-pending-rollback-core"
PR9_TREE="$REPO/.worktrees/pr9"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$ROM" ] || die "ROM not found at $ROM — pass the path as the first argument"
command -v uv >/dev/null || die "uv not found (brew install uv)"
command -v node >/dev/null || die "node not found"
if curl -s -o /dev/null "http://localhost:$PORT/health" || curl -sk -o /dev/null "https://localhost:$PORT/health"; then
    die "something is already listening on :$PORT — stop your dev server first"
fi

# HTTPS if the dev certs exist (same rule the server uses).
if [ -f "$REPO/certs/cert.pem" ] && [ -f "$REPO/certs/key.pem" ]; then
    BASE_URL="https://localhost:$PORT"
else
    BASE_URL="http://localhost:$PORT"
fi

echo "==> Installing Playwright (node) if needed"
[ -d node_modules/playwright ] || npm install --no-save playwright >/dev/null
npx playwright install chromium >/dev/null

echo "==> Preparing PR #9 worktree at $PR9_TREE"
git fetch -q origin kn-peek-pending-rollback-core
if [ -d "$PR9_TREE" ]; then
    git -C "$PR9_TREE" checkout -q --detach "$PR9_REF"
else
    git worktree add -q --detach "$PR9_TREE" "$PR9_REF"
fi
[ -d "$REPO/certs" ] && [ ! -e "$PR9_TREE/certs" ] && ln -s "$REPO/certs" "$PR9_TREE/certs"

rm -rf "$OUT" && mkdir -p "$OUT"
SERVER_PID=""
stop_server() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
}
trap stop_server EXIT

start_server() { # $1 = tree, $2 = label
    echo "==> [$2] starting server from $1"
    (cd "$1/server" && ADMIN_KEY=local-test DISABLE_RATE_LIMIT=1 exec uv run kaillera-server) \
        > "$OUT/$2-server.log" 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 60); do
        curl -sk -o /dev/null "$BASE_URL/health" && return 0
        sleep 1
    done
    die "[$2] server did not come up — see $OUT/$2-server.log"
}

run_test() { # $1 = label, $2 = test name, $3 = script, [$4 = URL override]
    local log="$OUT/$1-$2.log" status
    echo "    - $2"
    if [ -n "${4:-}" ]; then
        URL="$4" KN_ROM="$ROM" KN_BASE_URL="$BASE_URL" node "$3" > "$log" 2>&1
    else
        KN_ROM="$ROM" KN_BASE_URL="$BASE_URL" node "$3" > "$log" 2>&1
    fi
    status=$?
    printf '%-8s %-28s %s\n' "$1" "$2" "$([ $status -eq 0 ] && echo PASS || echo "FAIL (exit $status)")" >> "$OUT/summary.txt"
}

for variant in merged pr9; do
    tree="$REPO"; [ "$variant" = pr9 ] && tree="$PR9_TREE"
    start_server "$tree" "$variant"
    # Tests always come from this checkout (identical to PR #9's apart from
    # reading KN_ROM / KN_BASE_URL), so both builds get the same harness.
    run_test "$variant" worker-coproc tests/rb-worker-coproc-test.mjs
    run_test "$variant" shadow-determinism tests/rb-shadow-determinism.mjs
    run_test "$variant" freeze-mode1 tests/rb-demo-freeze-detector.mjs
    run_test "$variant" freeze-mode2 tests/rb-demo-freeze-detector.mjs "$BASE_URL/demo.html?rollbackMode=2"
    stop_server
done

{
    echo
    echo "==> Key numbers"
    for f in "$OUT"/*-worker-coproc.log "$OUT"/*-shadow-determinism.log "$OUT"/*-freeze-*.log; do
        echo "--- $(basename "$f" .log)"
        grep -iE 'fail|timeout|watchdog|freeze|fps|match|mismatch|errors?:|fatal' "$f" | tail -15
    done
} >> "$OUT/summary.txt"

echo
cat "$OUT/summary.txt"
echo
echo "Full logs: $OUT"
