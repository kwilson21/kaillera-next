#!/bin/bash
# Compile the rollback engine (build/kn_rollback) natively, against the
# stand-in core in fake_core.c, as a shared library for pytest.
#
# The source is prepared the way build/build.sh prepares it for the core:
# a copy, with build/inject-rb-probes.py run over it (which also declares
# rb_log ahead of its first use, without which the file does not compile).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/build/kn_rollback"
OUT="$HERE/build"
mkdir -p "$OUT/src"

cp "$SRC/kn_rollback.c" "$SRC/kn_rollback.h" "$SRC/kn_gameplay_addrs.h" \
    "$SRC/kn_hash_registry.c" "$SRC/kn_hash_registry.h" "$OUT/src/"
python3 "$ROOT/build/inject-rb-probes.py" "$OUT/src" >/dev/null

gcc -shared -fPIC -O0 -g -Wl,--no-undefined \
    -I"$OUT/src" -DKN_ENABLE_HASH_REGISTRY \
    "$OUT/src/kn_rollback.c" "$OUT/src/kn_hash_registry.c" "$HERE/fake_core.c" \
    -o "$OUT/libkn_rollback_test.so"

echo "Built $OUT/libkn_rollback_test.so"
