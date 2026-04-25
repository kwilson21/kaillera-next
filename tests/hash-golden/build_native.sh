#!/bin/bash
# Compile a native .so containing kn_hash_registry + a small test shim
# that lets pytest set the RDRAM contents from a fixture file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(dirname "$0")/build"
mkdir -p "$OUT"

cat > "$OUT/test_shim.c" <<'EOF'
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

static uint8_t* g_rdram = NULL;
static size_t   g_rdram_size = 0;

void* kn_get_rdram_ptr(void) { return g_rdram; }
uint32_t kn_get_rdram_size(void) { return (uint32_t)g_rdram_size; }

/* Test entry point: copy fixture RDRAM into a heap buffer the registry
 * will read via the kn_get_rdram_ptr accessor.
 *
 * Note: this shim leaks one buffer per call by design (pytest process
 * exits between runs anyway). Production code allocates RDRAM once. */
void kn_test_set_rdram(const char* data, size_t len) {
    if (g_rdram) { free(g_rdram); g_rdram = NULL; }
    g_rdram = (uint8_t*)malloc(len);
    memcpy(g_rdram, data, len);
    g_rdram_size = len;
}
EOF

gcc -shared -fPIC \
    -I"$ROOT/build/kn_rollback" \
    -O0 -g \
    "$ROOT/build/kn_rollback/kn_hash_registry.c" \
    "$OUT/test_shim.c" \
    -o "$OUT/libkn_hash_registry_test.so"

echo "Built $OUT/libkn_hash_registry_test.so"
