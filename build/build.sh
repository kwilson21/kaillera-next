#!/bin/bash
# build/build.sh — Build the patched mupen64plus_next core for EmulatorJS
#
# Usage:
#   docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh
#
# Stages:
#   1. Clone source repos (if not present)
#   2. Apply kaillera-next patches for deterministic timing
#      - kn-all.patch: sync read/write, event queue normalization, FPU trace
#      - RSP audio skip patch: mode 0/1/2 + hle_t state save/restore
#      - SoftFloat patch: bit-exact FPU cross-platform
#      - patch-sync-v3.py: upgrades sync to capture full peripheral state
#      - Inject kn_hle_save/kn_hle_restore into RSP HLE plugin (rollback)
#      - Inject kn_get_hidden_state_fingerprint (determinism diagnostics)
#   3. Compile core to LLVM bitcode (.bc)
#   4. Link through RetroArch → .js + .wasm
#   5. Package into 7z .data archive
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/src"
OUT_DIR="${SCRIPT_DIR}/output"
PATCHES_DIR="${SCRIPT_DIR}/patches"

mkdir -p "${SRC_DIR}" "${OUT_DIR}"

# ============================================================
# Stage 1: Clone repos
# ============================================================
if [ ! -d "${SRC_DIR}/mupen64plus-libretro-nx" ]; then
    echo "==> Cloning mupen64plus-libretro-nx (EmulatorJS fork)..."
    git clone --depth 1 https://github.com/EmulatorJS/mupen64plus-libretro-nx.git \
        "${SRC_DIR}/mupen64plus-libretro-nx"
fi

if [ ! -d "${SRC_DIR}/RetroArch" ]; then
    echo "==> Cloning RetroArch (EmulatorJS fork, branch next)..."
    git clone --depth 1 -b next https://github.com/EmulatorJS/RetroArch.git \
        "${SRC_DIR}/RetroArch"
fi

echo "==> Source repos ready"

# ============================================================
# Stage 1b: Inject --denan before --asyncify in emscripten
# ============================================================
# wasm-opt --denan MUST run before --asyncify. If it runs after,
# the denan helper functions break asyncify's stack unwinding.
# We patch emscripten's link.py to insert --denan into the pass
# pipeline right before the asyncify pass.
LINK_PY="/opt/emsdk/upstream/emscripten/tools/link.py"
if [ -f "${LINK_PY}" ]; then
    if ! grep -q "'--denan'" "${LINK_PY}"; then
        python3 -c "
with open('${LINK_PY}') as f:
    content = f.read()
content = content.replace(
    \"passes += ['--asyncify']\",
    \"passes += ['--denan']\\n    passes += ['--asyncify']\"
)
with open('${LINK_PY}', 'w') as f:
    f.write(content)
print('    Injected --denan before --asyncify in link.py')
"
    else
        echo "    --denan already injected in link.py"
    fi
fi

# ============================================================
# Stage 2: Apply patches
# ============================================================
if [ -d "${PATCHES_DIR}" ]; then
    echo "==> Applying kaillera-next patches..."

    # RetroArch: full reset + apply patch
    cd "${SRC_DIR}/RetroArch"
    git checkout -- . 2>/dev/null || true
    if [ -f "${PATCHES_DIR}/retroarch-deterministic-timing.patch" ]; then
        git apply "${PATCHES_DIR}/retroarch-deterministic-timing.patch" && \
            echo "    Applied RetroArch patch" || \
            echo "    RetroArch patch already applied or failed"
    fi

    # ASYNCIFY_REMOVE: strip Asyncify instrumentation from functions that must
    # run synchronously. Without this, Asyncify save/restore bookkeeping in
    # kn_pre_tick corrupts the Emscripten runner state, causing retro_run's
    # video callback to silently fail (canvas freeze).
    # Override the Makefile variable directly instead of sed-patching the flags.
    KN_ASYNCIFY_REMOVE='["retro_run","retro_serialize","retro_unserialize","runloop_iterate","core_run","emscripten_mainloop","kn_pre_tick","kn_post_tick","kn_live_gameplay_hash","kn_hash_registry_post_tick","kn_hash_on_replay_enter","kn_hash_on_replay_exit"]'
    sed -i "s|^ASYNCIFY_REMOVE ?=.*|ASYNCIFY_REMOVE ?= ${KN_ASYNCIFY_REMOVE}|" Makefile.emulatorjs
    echo "    Set ASYNCIFY_REMOVE=${KN_ASYNCIFY_REMOVE}"

    # Add C-level rollback exports to EXPORTED_FUNCTIONS
    if grep -q "_kn_sync_write_cpu" Makefile.emulatorjs && ! grep -q "_kn_rollback_init" Makefile.emulatorjs; then
        sed -i 's|_kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu|_kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu, \\\n                     _kn_rollback_init,_kn_feed_input,_kn_pre_tick,_kn_post_tick, \\\n                     _kn_get_pending_rollback,_kn_get_replay_depth,_kn_get_replay_start,_kn_get_state_for_frame,_kn_get_state_size,_kn_get_input,_kn_restore_frame, \\\n                     _kn_get_frame,_kn_get_rollback_count,_kn_get_prediction_count, \\\n                     _kn_get_correct_predictions,_kn_get_max_depth, \\\n                     _kn_rollback_self_test,_kn_get_debug_log,_kn_rollback_shutdown,_kn_set_rng_sync,_kn_set_num_players, \\\n                     _kn_full_state_hash,_kn_get_last_state,_kn_state_region_hashes,_kn_get_failed_rollbacks,_kn_get_softfloat_state,_kn_get_hidden_state_fingerprint,_kn_write_controller, \\\n                     _kn_game_state_hash,_kn_gameplay_hash,_kn_taint_rdram,_kn_get_taint_blocks,_kn_get_tainted_block_count,_kn_reset_taint,_kn_replay_self_test,_kn_get_rdram_ptr,_kn_get_rdram_size,_kn_get_mispred_breakdown,_kn_state_region_hashes_frame,_kn_get_rdram_offset_in_state,_kn_get_state_buffer_size,_kn_get_tolerance_hits,_kn_set_rdram_preserve,_kn_set_frame,_kn_set_rng_netplay_ptr,_kn_get_serialize_skip_count, \\\n                     _kn_rollback_did_restore,_kn_get_fatal_stale,_kn_get_live_mismatch,_kn_live_gameplay_hash,_kn_rdram_block_hashes,_kn_hle_save,_kn_hle_restore|' Makefile.emulatorjs
        echo "    Added C-level rollback WASM exports"
    fi

    # Add kn_hash_registry field exports (Tasks 3-5 of desync detection v1).
    # Keyed on _kn_hle_restore (terminal symbol of the rollback exports added
    # above). Each sed replaces the anchor with "anchor + new symbols", so
    # multiple sed lines are additive — order doesn't matter.
    if ! grep -q "_kn_hash_registry_post_tick" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_hash_fnv1a,_kn_hash_stocks,_kn_hash_history_stocks, \\\n                     _kn_hash_character_id,_kn_hash_history_character_id, \\\n                     _kn_hash_css_cursor,_kn_hash_history_css_cursor, \\\n                     _kn_hash_css_selected,_kn_hash_history_css_selected, \\\n                     _kn_hash_rng,_kn_hash_history_rng, \\\n                     _kn_hash_match_phase,_kn_hash_history_match_phase, \\\n                     _kn_hash_vs_battle_hdr,_kn_hash_history_vs_battle_hdr, \\\n                     _kn_hash_physics_motion,_kn_hash_history_physics_motion, \\\n                     _kn_hash_registry_post_tick|' Makefile.emulatorjs
        echo "    Added kn_hash_registry field exports"
    fi

    # Smoke-test diagnostic helpers (Task 5). Separate group per the plan
    # pattern; same anchor, additive replacement.
    if ! grep -q "_kn_smoke_buf_ptr" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_smoke_buf_ptr,_kn_smoke_dump_stocks|' Makefile.emulatorjs
        echo "    Added kn_hash_registry smoke-test helpers"
    fi

    # Rollback-event field snapshots (Task 8). Same anchor, additive.
    if ! grep -q "_kn_hash_on_replay_enter" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_hash_on_replay_enter,_kn_hash_on_replay_exit, \\\n                     _kn_get_pre_replay_hash,_kn_get_post_replay_hash, \\\n                     _kn_get_last_replay_target_frame,_kn_get_last_replay_final_frame|' Makefile.emulatorjs
        echo "    Added kn_hash_registry rollback-event snapshot exports"
    fi

    # Per-frame replay trajectory ring (Task 9). Same anchor, additive.
    if ! grep -q "_kn_get_replay_frame_hash" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_get_replay_frame_hash,_kn_get_last_replay_length|' Makefile.emulatorjs
        echo "    Added kn_hash_registry replay trajectory exports"
    fi

    # Phase-gating scene_curr export (Task 14). Same anchor, additive.
    if ! grep -q "_kn_get_scene_curr" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_get_scene_curr|' Makefile.emulatorjs
        echo "    Added kn_get_scene_curr export"
    fi

    # ft_buffer hash export (per-fighter coverage). Same anchor, additive.
    if ! grep -q "_kn_hash_ft_buffer" Makefile.emulatorjs; then
        sed -i 's|_kn_hle_restore|_kn_hle_restore, \\\n                     _kn_hash_ft_buffer,_kn_hash_history_ft_buffer|' Makefile.emulatorjs
        echo "    Added kn_hash_ft_buffer export"
    fi

    # mupen64plus: full reset + apply patches.
    # kn-all.patch handles main.c (superset of timing + wasm-determinism patches).
    # deterministic-timing.patch handles features_cpu.c and profile.c (excluded main.c).
    cd "${SRC_DIR}/mupen64plus-libretro-nx"
    git checkout -- . 2>/dev/null || true

    if [ -f "${PATCHES_DIR}/mupen64plus-kn-all.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-kn-all.patch" && \
            echo "    Applied mupen64plus kn-all patch (main.c)" || \
            echo "    WARN: kn-all patch failed"
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ]; then
        git apply --exclude='mupen64plus-core/src/main/main.c' \
            "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" 2>/dev/null && \
            echo "    Applied mupen64plus timing patch (features_cpu.c, profile.c)" || true
    fi

    # wasm-determinism patch: strict IEEE 754 compile flags (-fno-fast-math,
    # -fno-tree-vectorize, -ffp-contract=off), FPU instruction NaN canon
    # (fpu.h, mips_instructions.def, r4300_core.c), srand(0), deterministic RTC.
    # Excludes main.c (handled by kn-all above).
    if [ -f "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" ]; then
        git apply --exclude='mupen64plus-core/src/main/main.c' \
            "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" 2>/dev/null && \
            echo "    Applied mupen64plus wasm-determinism patch (strict FP, FPU canon, srand)" || \
            echo "    WARN: wasm-determinism patch failed"
    fi

    # AI DMA determinism: replace float dma_modifier with integer-only arithmetic.
    # The float multiplication in fifo_push() was the sole source of cross-platform
    # non-determinism — ARM FMA vs x86 separate mul+add produced different AI interrupt
    # timing, causing cascading game state divergence.
    if [ -f "${PATCHES_DIR}/mupen64plus-ai-determinism.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-ai-determinism.patch" && \
            echo "    Applied mupen64plus AI DMA determinism patch" || \
            echo "    WARN: AI DMA determinism patch failed"
    fi

    # RSP HLE audio determinism: mode 1=silent skip, mode 2=process+restore DRAM.
    # Applied via sed injection (patch format was fragile).
    if ! grep -q "kn_skip_rsp_audio" mupen64plus-rsp-hle/src/hle.c; then
        python3 -c "
import re
src = open('mupen64plus-rsp-hle/src/hle.c').read()
globals_block = '''
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <string.h>
#include <stdlib.h>
int kn_skip_rsp_audio = 0;
EMSCRIPTEN_KEEPALIVE void kn_set_skip_rsp_audio(int skip) { kn_skip_rsp_audio = skip; }
static uint8_t *kn_rsp_audio_snapshot = NULL;
#define KN_RSP_AUDIO_DRAM_START 0x80000u
#define KN_RSP_AUDIO_DRAM_SIZE  0x60000u
#endif

'''
body_block = '''#ifdef __EMSCRIPTEN__
    if (kn_skip_rsp_audio == 1) { rsp_break(hle, SP_STATUS_TASKDONE); return; }
    if (kn_skip_rsp_audio >= 2) {
        if (!kn_rsp_audio_snapshot) kn_rsp_audio_snapshot = (uint8_t *)malloc(KN_RSP_AUDIO_DRAM_SIZE);
        if (kn_rsp_audio_snapshot && hle->dram) {
            memcpy(kn_rsp_audio_snapshot, hle->dram + KN_RSP_AUDIO_DRAM_START, KN_RSP_AUDIO_DRAM_SIZE);
            HleProcessAlistList(hle->user_defined);
            memcpy(hle->dram + KN_RSP_AUDIO_DRAM_START, kn_rsp_audio_snapshot, KN_RSP_AUDIO_DRAM_SIZE);
            rsp_break(hle, SP_STATUS_TASKDONE);
        } else { rsp_break(hle, SP_STATUS_TASKDONE); }
        return;
    }
#endif
'''
src = src.replace('static void send_alist_to_audio_plugin', globals_block + 'static void send_alist_to_audio_plugin')
src = src.replace('    HleProcessAlistList(hle->user_defined);\n    rsp_break(hle, SP_STATUS_TASKDONE);\n}', body_block + '    HleProcessAlistList(hle->user_defined);\n    rsp_break(hle, SP_STATUS_TASKDONE);\n}')
open('mupen64plus-rsp-hle/src/hle.c','w').write(src)
"
        echo "    Injected RSP audio skip (modes 1+2)"
    fi

    # FPU trace: ring buffer instrumentation in fpu.h for cross-platform
    # determinism verification. Records input/output bit patterns for every
    # FPU arithmetic operation when tracing is enabled from JS.
    if [ -f "${PATCHES_DIR}/mupen64plus-fpu-trace.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-fpu-trace.patch" 2>/dev/null && \
            echo "    Applied mupen64plus FPU trace patch (fpu.h)" || \
            echo "    WARN: FPU trace patch failed"
    fi

    # headless tick: skip GL + video_cb in retro_run() for rollback benchmarking.
    if [ -f "${PATCHES_DIR}/mupen64plus-headless-tick.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-headless-tick.patch" && \
            echo "    Applied mupen64plus headless tick patch (libretro.c)" || \
            echo "    WARN: headless tick patch failed"
    fi

    # determinism fixes: srand(0), fixed MPK seed, fixed biopak time.
    # Applied as sed because kn-all.patch modifies main.c (context conflict).
    echo "    Applying determinism fixes (srand, mpk_seed, biopak)..."
    sed -i 's/srand((unsigned int) time(NULL));/#ifdef __EMSCRIPTEN__\n    srand(0);\n#else\n    srand((unsigned int) time(NULL));\n#endif/' \
        mupen64plus-core/src/device/r4300/r4300_core.c
    sed -i 's/uint64_t mpk_seed = !netplay_is_init() ? (uint64_t)time(NULL) : 0;/#ifdef __EMSCRIPTEN__\n    uint64_t mpk_seed = 0;\n#else\n    uint64_t mpk_seed = !netplay_is_init() ? (uint64_t)time(NULL) : 0;\n#endif/' \
        mupen64plus-core/src/main/main.c
    sed -i 's/time_t now = time(NULL) \* 1000;/#ifdef __EMSCRIPTEN__\n        time_t now = 0;\n#else\n        time_t now = time(NULL) * 1000;\n#endif/' \
        mupen64plus-core/src/device/controllers/paks/biopak.c
    echo "    Done."

    # Inject hidden state fingerprint function for determinism diagnostics
    if ! grep -q "kn_get_hidden_state_fingerprint_impl" mupen64plus-core/src/main/main.c; then
        cat >> mupen64plus-core/src/main/main.c <<'KNFP_EOF'

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include "softfloat.h"
#include "device/r4300/cp0.h"
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_hidden_state_fingerprint_impl(void) {
    uint32_t h = 2166136261u;
    h ^= (uint32_t)softfloat_roundingMode; h *= 16777619u;
    h ^= (uint32_t)softfloat_exceptionFlags; h *= 16777619u;
    h ^= (uint32_t)g_dev.sp.rsp_task_locked; h *= 16777619u;
    h ^= (uint32_t)g_dev.r4300.cp0.interrupt_unsafe_state; h *= 16777619u;
    h ^= (uint32_t)g_dev.ai.fifo[0].duration; h *= 16777619u;
    h ^= (uint32_t)g_dev.ai.fifo[0].length; h *= 16777619u;
    h ^= (uint32_t)g_dev.ai.fifo[1].duration; h *= 16777619u;
    h ^= (uint32_t)g_dev.ai.fifo[1].length; h *= 16777619u;
    h ^= *r4300_cp0_last_addr(&g_dev.r4300.cp0); h *= 16777619u;
    return h;
}
#endif
KNFP_EOF
        echo "    Injected kn_get_hidden_state_fingerprint_impl"
    fi

    # Inject kn_hle_save/restore into RSP HLE plugin for rollback
    if ! grep -q "kn_hle_save" mupen64plus-rsp-hle/src/plugin.c; then
        cat >> mupen64plus-rsp-hle/src/plugin.c <<'KNHLE_EOF'

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <string.h>
#include <stddef.h>
#define KN_HLE_RB_OFFSET offsetof(struct hle_t, alist_buffer)
#define KN_HLE_RB_SIZE   (offsetof(struct hle_t, cached_ucodes) - offsetof(struct hle_t, alist_buffer))
static uint8_t *kn_hle_rb_snapshot = NULL;
EMSCRIPTEN_KEEPALIVE void kn_hle_save(void) {
    if (!kn_hle_rb_snapshot) kn_hle_rb_snapshot = (uint8_t *)malloc(KN_HLE_RB_SIZE);
    if (kn_hle_rb_snapshot) memcpy(kn_hle_rb_snapshot, ((uint8_t *)&g_hle) + KN_HLE_RB_OFFSET, KN_HLE_RB_SIZE);
}
EMSCRIPTEN_KEEPALIVE void kn_hle_restore(void) {
    if (kn_hle_rb_snapshot) memcpy(((uint8_t *)&g_hle) + KN_HLE_RB_OFFSET, kn_hle_rb_snapshot, KN_HLE_RB_SIZE);
}
#endif
KNHLE_EOF
        echo "    Injected kn_hle_save/kn_hle_restore"
    fi

    # v3 kn_sync_read/write: complete state capture matching retro_serialize.
    # Must run AFTER kn-all.patch which creates the v1 functions.
    echo "    Upgrading kn_sync_read/write to v3 (complete state capture)..."
    python3 "${SCRIPT_DIR}/patch-sync-v3.py" "mupen64plus-core/src/main/main.c"

    # static save scratch: replace malloc/free in savestates_save_m64p with
    # a static reusable buffer. retro_serialize is called 60×/sec by the
    # rollback engine; the malloc was suspected to cause WASM heap growth.
    # Also records kn_rdram_offset_in_state for taint-aware hashing.
    if [ -f "${PATCHES_DIR}/mupen64plus-static-save-scratch.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-static-save-scratch.patch" && \
            echo "    Applied static save scratch patch" || \
            echo "    WARN: static save scratch patch failed"
    fi

    # RSP HLE taint hook: every dram_store_u* call flags the written 64 KB
    # RDRAM block(s) as non-deterministic so kn_game_state_hash can skip them.
    if [ -f "${PATCHES_DIR}/mupen64plus-rsp-taint.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-rsp-taint.patch" && \
            echo "    Applied RSP HLE taint patch" || \
            echo "    WARN: RSP HLE taint patch failed"
    fi

    # GLideN64 taint hook: ColorBufferToRDRAM and DepthBufferToRDRAM call
    # kn_taint_rdram before writing GL readback bytes into RDRAM.
    if [ -f "${PATCHES_DIR}/gliden64-rdram-taint.patch" ]; then
        git apply "${PATCHES_DIR}/gliden64-rdram-taint.patch" && \
            echo "    Applied GLideN64 taint patch" || \
            echo "    WARN: GLideN64 taint patch failed"
    fi

    # C-level rollback engine: copy kn_rollback.c/h into the source tree
    # and add to Makefile.common so it gets compiled with the core.
    echo "    Installing kn_rollback.c/h..."
    cp "${SCRIPT_DIR}/kn_rollback/kn_rollback.c" mupen64plus-core/src/main/kn_rollback.c
    cp "${SCRIPT_DIR}/kn_rollback/kn_rollback.h" mupen64plus-core/src/main/kn_rollback.h
    cp "${SCRIPT_DIR}/kn_rollback/kn_gameplay_addrs.h" mupen64plus-core/src/main/kn_gameplay_addrs.h
    cp "${SCRIPT_DIR}/kn_rollback/kn_hash_registry.c" mupen64plus-core/src/main/kn_hash_registry.c
    cp "${SCRIPT_DIR}/kn_rollback/kn_hash_registry.h" mupen64plus-core/src/main/kn_hash_registry.h
    # Add kn_rollback.c and kn_hash_registry.c to SOURCES_C in Makefile.common
    sed -i 's|$(CORE_DIR)/src/main/savestates.c \\|$(CORE_DIR)/src/main/savestates.c \\\n\t$(CORE_DIR)/src/main/kn_rollback.c \\\n\t$(CORE_DIR)/src/main/kn_hash_registry.c \\|' Makefile.common
    echo "    Done."

    # softfloat patch: replace native FPU ops with Berkeley SoftFloat 3e calls
    # for bit-exact cross-platform determinism (Chrome V8 vs Safari JSC).
    # Modifies fpu.h (arithmetic + conversions + rounding) and Makefile
    # (adds SoftFloat include paths to the emscripten build).
    if [ -f "${PATCHES_DIR}/mupen64plus-softfloat.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-softfloat.patch" && \
            echo "    Applied mupen64plus softfloat patch (SoftFloat FPU + Makefile)" || \
            echo "    WARN: softfloat patch failed"
    fi
fi

# ============================================================
# Stage 2b: Compile SoftFloat library
# ============================================================
# SoftFloat source lives outside the git-cloned repos. We compile it
# separately because Make's pattern rules don't reliably handle source
# files outside the project tree (paths like ../../softfloat/).
SOFTFLOAT_DIR="${SCRIPT_DIR}/softfloat"
if [ -d "${SOFTFLOAT_DIR}" ]; then
    echo "==> Stage 2b: Compile Berkeley SoftFloat 3e"

    SF_CFLAGS="-O3 -flto -fno-fast-math -ffp-contract=off -fno-strict-aliasing"
    SF_INCS="-I${SOFTFLOAT_DIR}/include -I${SOFTFLOAT_DIR}/8086-SSE -I${SOFTFLOAT_DIR}"

    SF_SOURCES=(
        "${SOFTFLOAT_DIR}/softfloat_state.c"
        "${SOFTFLOAT_DIR}/8086-SSE/softfloat_raiseFlags.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_commonNaNToF32UI.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_commonNaNToF64UI.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_f32UIToCommonNaN.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_f64UIToCommonNaN.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_propagateNaNF32UI.c"
        "${SOFTFLOAT_DIR}/8086-SSE/s_propagateNaNF64UI.c"
        "${SOFTFLOAT_DIR}/f32_add.c"
        "${SOFTFLOAT_DIR}/f32_sub.c"
        "${SOFTFLOAT_DIR}/f32_mul.c"
        "${SOFTFLOAT_DIR}/f32_div.c"
        "${SOFTFLOAT_DIR}/f32_sqrt.c"
        "${SOFTFLOAT_DIR}/f32_to_f64.c"
        "${SOFTFLOAT_DIR}/f64_add.c"
        "${SOFTFLOAT_DIR}/f64_sub.c"
        "${SOFTFLOAT_DIR}/f64_mul.c"
        "${SOFTFLOAT_DIR}/f64_div.c"
        "${SOFTFLOAT_DIR}/f64_sqrt.c"
        "${SOFTFLOAT_DIR}/f64_to_f32.c"
        "${SOFTFLOAT_DIR}/i32_to_f32.c"
        "${SOFTFLOAT_DIR}/i32_to_f64.c"
        "${SOFTFLOAT_DIR}/i64_to_f32.c"
        "${SOFTFLOAT_DIR}/i64_to_f64.c"
        "${SOFTFLOAT_DIR}/s_addMagsF32.c"
        "${SOFTFLOAT_DIR}/s_subMagsF32.c"
        "${SOFTFLOAT_DIR}/s_mulAddF32.c"
        "${SOFTFLOAT_DIR}/s_addMagsF64.c"
        "${SOFTFLOAT_DIR}/s_subMagsF64.c"
        "${SOFTFLOAT_DIR}/s_mulAddF64.c"
        "${SOFTFLOAT_DIR}/s_normSubnormalF32Sig.c"
        "${SOFTFLOAT_DIR}/s_normSubnormalF64Sig.c"
        "${SOFTFLOAT_DIR}/s_roundPackToF32.c"
        "${SOFTFLOAT_DIR}/s_roundPackToF64.c"
        "${SOFTFLOAT_DIR}/s_normRoundPackToF32.c"
        "${SOFTFLOAT_DIR}/s_normRoundPackToF64.c"
        "${SOFTFLOAT_DIR}/s_shiftRightJam32.c"
        "${SOFTFLOAT_DIR}/s_shiftRightJam64.c"
        "${SOFTFLOAT_DIR}/s_shiftRightJam64Extra.c"
        "${SOFTFLOAT_DIR}/s_shortShiftRightJam64.c"
        "${SOFTFLOAT_DIR}/s_shortShiftRightJam64Extra.c"
        "${SOFTFLOAT_DIR}/s_countLeadingZeros8.c"
        "${SOFTFLOAT_DIR}/s_countLeadingZeros16.c"
        "${SOFTFLOAT_DIR}/s_countLeadingZeros32.c"
        "${SOFTFLOAT_DIR}/s_countLeadingZeros64.c"
        "${SOFTFLOAT_DIR}/s_mul64To128.c"
        "${SOFTFLOAT_DIR}/s_shortShiftLeft128.c"
        "${SOFTFLOAT_DIR}/s_shortShiftRight128.c"
        "${SOFTFLOAT_DIR}/s_shortShiftRightJam128.c"
        "${SOFTFLOAT_DIR}/s_shortShiftRightJam128Extra.c"
        "${SOFTFLOAT_DIR}/s_shiftRightJam128.c"
        "${SOFTFLOAT_DIR}/s_shiftRightJam128Extra.c"
        "${SOFTFLOAT_DIR}/s_sub128.c"
        "${SOFTFLOAT_DIR}/s_add128.c"
        "${SOFTFLOAT_DIR}/s_eq128.c"
        "${SOFTFLOAT_DIR}/s_le128.c"
        "${SOFTFLOAT_DIR}/s_lt128.c"
        "${SOFTFLOAT_DIR}/s_mul128By32.c"
        "${SOFTFLOAT_DIR}/s_mul128To256M.c"
        "${SOFTFLOAT_DIR}/s_approxRecip32_1.c"
        "${SOFTFLOAT_DIR}/s_approxRecipSqrt32_1.c"
        "${SOFTFLOAT_DIR}/s_approxRecip_1Ks.c"
        "${SOFTFLOAT_DIR}/s_approxRecipSqrt_1Ks.c"
        "${SOFTFLOAT_DIR}/s_roundToUI32.c"
        "${SOFTFLOAT_DIR}/s_roundToUI64.c"
        "${SOFTFLOAT_DIR}/s_roundToI32.c"
        "${SOFTFLOAT_DIR}/s_roundToI64.c"
    )

    SF_OBJ_DIR="${SCRIPT_DIR}/softfloat/obj"
    mkdir -p "${SF_OBJ_DIR}"

    # Compile each SoftFloat .c to .o (WASM bitcode via emcc)
    for src in "${SF_SOURCES[@]}"; do
        base="$(basename "${src}" .c)"
        emcc ${SF_CFLAGS} ${SF_INCS} -c "${src}" -o "${SF_OBJ_DIR}/${base}.o" &
    done
    wait

    # Archive into a static library
    emar rcs "${SCRIPT_DIR}/softfloat/libsoftfloat.a" "${SF_OBJ_DIR}"/*.o
    echo "    Built libsoftfloat.a ($(ls -lh "${SCRIPT_DIR}/softfloat/libsoftfloat.a" | awk '{print $5}'))"
fi

# ============================================================
# Stage 3: Compile core to LLVM bitcode
# ============================================================
echo "==> Stage 3: Compile core to LLVM bitcode (.bc)"
cd "${SRC_DIR}/mupen64plus-libretro-nx"

# Clean previous build artifacts
emmake make -f Makefile platform=emscripten clean 2>/dev/null || true

# Build
emmake make -j4 -f Makefile platform=emscripten LTO=1

BC_FILE="${SRC_DIR}/mupen64plus-libretro-nx/mupen64plus_next_libretro_emscripten.bc"
if [ ! -f "${BC_FILE}" ]; then
    echo "ERROR: .bc file not produced"
    exit 1
fi

# Copy SoftFloat library alongside the .bc for RetroArch link step
SF_LIB="${SCRIPT_DIR}/softfloat/libsoftfloat.a"
if [ -f "${SF_LIB}" ]; then
    cp "${SF_LIB}" "${SRC_DIR}/RetroArch/libsoftfloat.a"
    echo "    SoftFloat library staged for linking"
fi

echo "==> .bc file: $(ls -lh ${BC_FILE} | awk '{print $5}')"

# ============================================================
# Stage 4: Link through RetroArch
# ============================================================
echo "==> Stage 4: Link through RetroArch -> .js + .wasm"
# The Makefile expects the .bc file as libretro_emscripten.a in the RetroArch root
cp "${BC_FILE}" "${SRC_DIR}/RetroArch/libretro_emscripten.a"
cd "${SRC_DIR}/RetroArch"

# Clean previous link artifacts
rm -f mupen64plus_next_libretro.js mupen64plus_next_libretro.wasm 2>/dev/null || true

# Build with same flags as EmulatorJS's build-emulatorjs.sh uses for mupen64plus_next:
# - ASYNC=1 (full asyncify)
# - HAVE_OPENGLES3=1 (WebGL2)
# - STACK_SIZE=128MB (largeStack for mupen64plus_next)
# - INITIAL_HEAP=512MB (largeHeap for mupen64plus_next)
# - HAVE_7ZIP=1, HAVE_CHD=1
# Pass SoftFloat as additional library if present
SF_ADDITIONAL=""
if [ -f "${SRC_DIR}/RetroArch/libsoftfloat.a" ]; then
    SF_ADDITIONAL="libsoftfloat.a"
fi

emmake make -f Makefile.emulatorjs \
    HAVE_OPENGLES3=1 \
    ASYNC=1 \
    HAVE_7ZIP=1 \
    HAVE_CHD=1 \
    STACK_SIZE=134217728 \
    INITIAL_HEAP=536870912 \
    TARGET=mupen64plus_next_libretro.js \
    LTO=1 \
    additional_libs="${SF_ADDITIONAL}" \
    -j4

JS_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.js"
WASM_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.wasm"

if [ ! -f "${JS_FILE}" ] || [ ! -f "${WASM_FILE}" ]; then
    echo "ERROR: .js or .wasm not produced"
    exit 1
fi
echo "==> JS glue: $(ls -lh ${JS_FILE} | awk '{print $5}')"
echo "==> WASM:    $(ls -lh ${WASM_FILE} | awk '{print $5}')"

# ============================================================
# Stage 4b: NaN canonicalization (fix-denan.py only)
# ============================================================
# The --denan pass is injected BEFORE asyncify in emscripten's link.py
# (see Stage 1b below). Here we only run fix-denan.py to change
# NaN→0 replacements to NaN→canonical NaN (preserving isnan() semantics).
echo "==> Stage 4b: Patching denan sites (NaN→0 → NaN→canonical)"
python3 "${SCRIPT_DIR}/fix-denan.py" "${WASM_FILE}"

# ============================================================
# Stage 5: Package into 7z .data archive
# ============================================================
echo "==> Stage 5: Package into 7z .data archive"
cd "${OUT_DIR}"

# Create core.json (metadata for EmulatorJS)
cat > core.json << 'COREJSON'
{"name":"mupen64plus_next","extensions":["n64","v64","z64","bin","u1","ndd","gb"],"options":{"defaultWebGL2":true},"save":"srm","license":"LICENSE","repo":"https://github.com/EmulatorJS/mupen64plus-libretro-nx"}
COREJSON

cp "${JS_FILE}" .
cp "${WASM_FILE}" .
echo '{"minimumEJSVersion":"4.2.2","version":"2.0.2"}' > build.json
echo "GPL-3.0" > license.txt

rm -f mupen64plus_next-wasm.data 2>/dev/null || true
7z a -t7z mupen64plus_next-wasm.data \
    mupen64plus_next_libretro.js \
    mupen64plus_next_libretro.wasm \
    core.json build.json license.txt

echo ""
echo "=========================================="
echo "BUILD COMPLETE"
echo "Output: ${OUT_DIR}/mupen64plus_next-wasm.data"
echo "Size:   $(ls -lh ${OUT_DIR}/mupen64plus_next-wasm.data | awk '{print $5}')"
echo "=========================================="
