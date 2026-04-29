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
KN_ENABLE_HASH_REGISTRY="${KN_ENABLE_HASH_REGISTRY:-0}"
KN_DISABLE_WASM_SIMD="${KN_DISABLE_WASM_SIMD:-0}"
KN_DISABLE_GLIDEN64_VEC4="${KN_DISABLE_GLIDEN64_VEC4:-1}"
KN_DISABLE_GLIDEN64_SIMD="${KN_DISABLE_GLIDEN64_SIMD:-1}"
if command -v nproc >/dev/null 2>&1; then
    KN_DEFAULT_BUILD_JOBS="$(nproc)"
else
    KN_DEFAULT_BUILD_JOBS="4"
fi
KN_BUILD_JOBS="${KN_BUILD_JOBS:-${KN_DEFAULT_BUILD_JOBS}}"
KN_SKIP_MAKE_CLEAN="${KN_SKIP_MAKE_CLEAN:-0}"

mkdir -p "${SRC_DIR}" "${OUT_DIR}"
echo "==> Build parallelism: ${KN_BUILD_JOBS} job(s)"

# ============================================================
# Stage 1: Clone repos
# ============================================================
# Pinned SHAs — bump in lockstep with web/static/VENDORED.md.
# Floating HEAD here was non-reproducible; pinning protects future builds.
MUPEN_REPO="https://github.com/EmulatorJS/mupen64plus-libretro-nx.git"
MUPEN_BRANCH="develop"
MUPEN_SHA="4a3925d2861f17719586dffb178c1dd5339d3a68"

RETROARCH_REPO="https://github.com/EmulatorJS/RetroArch.git"
RETROARCH_BRANCH="next"
RETROARCH_SHA="ed3265745eccec99b48f99e2a2ffc8a6a93823bb"

if [ ! -d "${SRC_DIR}/mupen64plus-libretro-nx" ]; then
    echo "==> Cloning mupen64plus-libretro-nx @ ${MUPEN_SHA} (EmulatorJS fork)..."
    git clone -b "${MUPEN_BRANCH}" "${MUPEN_REPO}" "${SRC_DIR}/mupen64plus-libretro-nx"
    git -C "${SRC_DIR}/mupen64plus-libretro-nx" checkout "${MUPEN_SHA}"
fi

if [ ! -d "${SRC_DIR}/RetroArch" ]; then
    echo "==> Cloning RetroArch @ ${RETROARCH_SHA} (EmulatorJS fork, branch ${RETROARCH_BRANCH})..."
    git clone -b "${RETROARCH_BRANCH}" "${RETROARCH_REPO}" "${SRC_DIR}/RetroArch"
    git -C "${SRC_DIR}/RetroArch" checkout "${RETROARCH_SHA}"
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
    KN_ASYNCIFY_REMOVE='["retro_run","retro_serialize","retro_unserialize","runloop_iterate","core_run","emscripten_mainloop","kn_pre_tick","kn_post_tick","kn_live_gameplay_hash","kn_sync_read_cpu","kn_rdram_block_hashes","kn_eventqueue_hash","kn_pack_hidden_state_impl","kn_post_state_load_cleanup","kn_hle_save_to","kn_hle_restore_from","kn_set_skip_audio_output","kn_get_skip_audio_output","kn_hash_registry_post_tick","kn_hash_on_replay_enter","kn_hash_on_replay_exit"]'
    sed -i "s|^ASYNCIFY_REMOVE ?=.*|ASYNCIFY_REMOVE ?= ${KN_ASYNCIFY_REMOVE}|" Makefile.emulatorjs
    echo "    Set ASYNCIFY_REMOVE=${KN_ASYNCIFY_REMOVE}"

    # Add C-level rollback exports to EXPORTED_FUNCTIONS
    if grep -q "_kn_sync_write_cpu" Makefile.emulatorjs && ! grep -q "_kn_rollback_init" Makefile.emulatorjs; then
        sed -i 's|_kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu|_kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu, \\\n                     _kn_rollback_init,_kn_feed_input,_kn_pre_tick,_kn_post_tick, \\\n                     _kn_get_pending_rollback,_kn_get_replay_depth,_kn_get_replay_start,_kn_get_state_for_frame,_kn_get_state_size,_kn_get_input,_kn_restore_frame, \\\n                     _kn_get_frame,_kn_get_rollback_count,_kn_get_prediction_count, \\\n                     _kn_get_correct_predictions,_kn_get_max_depth, \\\n                     _kn_rollback_self_test,_kn_get_debug_log,_kn_rollback_shutdown,_kn_set_rng_sync,_kn_set_num_players, \\\n                     _kn_full_state_hash,_kn_get_last_state,_kn_state_region_hashes,_kn_get_failed_rollbacks,_kn_get_softfloat_state,_kn_get_hidden_state_fingerprint,_kn_write_controller,_kn_set_controller_present_mask, \\\n                     _kn_game_state_hash,_kn_gameplay_hash,_kn_taint_rdram,_kn_get_taint_blocks,_kn_get_tainted_block_count,_kn_reset_taint,_kn_replay_self_test,_kn_get_rdram_ptr,_kn_get_rdram_size,_kn_get_mispred_breakdown,_kn_state_region_hashes_frame,_kn_get_rdram_offset_in_state,_kn_get_state_buffer_size,_kn_get_tolerance_hits,_kn_set_rdram_preserve,_kn_set_frame,_kn_set_rng_netplay_ptr,_kn_get_serialize_skip_count, \\\n                     _kn_rollback_did_restore,_kn_get_fatal_stale,_kn_get_live_mismatch,_kn_live_gameplay_hash,_kn_rdram_block_hashes,_kn_hle_save,_kn_hle_restore, \\\n                     _kn_pack_hidden_state_impl,_kn_restore_hidden_state_boot,_kn_hle_save_to,_kn_hle_restore_from,_kn_hle_state_size,_kn_set_audio_fifo_state,_kn_get_audio_fifo_state,_kn_set_skip_audio_output,_kn_get_skip_audio_output|' Makefile.emulatorjs
        echo "    Added C-level rollback WASM exports"
    fi
    if grep -q "_kn_pack_hidden_state_impl,_kn_restore_hidden_state_boot" Makefile.emulatorjs && ! grep -q "_kn_restore_hidden_state_impl" Makefile.emulatorjs; then
        sed -i 's|_kn_pack_hidden_state_impl,_kn_restore_hidden_state_boot|_kn_pack_hidden_state_impl,_kn_restore_hidden_state_impl,_kn_restore_hidden_state_boot|' Makefile.emulatorjs
        echo "    Added full hidden-state restore WASM export"
    fi
    if grep -q "_kn_write_controller" Makefile.emulatorjs && ! grep -q "_kn_set_controller_present_mask" Makefile.emulatorjs; then
        sed -i 's|_kn_write_controller,|_kn_write_controller,_kn_set_controller_present_mask,|' Makefile.emulatorjs
        echo "    Added controller-present mask WASM export"
    fi
    if grep -q "_kn_get_audio_fifo_state" Makefile.emulatorjs && ! grep -q "_kn_post_state_load_cleanup" Makefile.emulatorjs; then
        sed -i 's|_kn_get_audio_fifo_state,|_kn_get_audio_fifo_state,_kn_post_state_load_cleanup,|' Makefile.emulatorjs
        echo "    Added post-state-load cleanup WASM export"
    fi
    # 2026-04-29 audio-diag exports. Anchored on _kn_get_skip_audio_output,
    # the trailing terminal audio export. Removed once the silent-iPhone-audio
    # bug is root-caused.
    if grep -q "_kn_get_skip_audio_output" Makefile.emulatorjs && ! grep -q "_kn_dump_audio_state" Makefile.emulatorjs; then
        sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output,_kn_dump_audio_state,_kn_diag_reset_audio_counters,_kn_diag_check_invariant|' Makefile.emulatorjs
        echo "    Added audio diagnostic WASM exports (kn_dump_audio_state, kn_diag_reset_audio_counters, kn_diag_check_invariant)"
    fi

    if [ "${KN_ENABLE_HASH_REGISTRY}" = "1" ]; then
        # Add kn_hash_registry field exports (Tasks 3-5 of desync detection v1).
        # Keyed on _kn_get_skip_audio_output (terminal audio helper export added
        # above). Each sed replaces the anchor with "anchor + new symbols", so
        # multiple sed lines are additive — order doesn't matter. Do not anchor
        # on _kn_hle_restore: it is a prefix of _kn_hle_restore_from.
        if ! grep -q "_kn_hash_registry_post_tick" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_hash_fnv1a,_kn_hash_stocks,_kn_hash_history_stocks, \\\n                     _kn_hash_character_id,_kn_hash_history_character_id, \\\n                     _kn_hash_css_cursor,_kn_hash_history_css_cursor, \\\n                     _kn_hash_css_selected,_kn_hash_history_css_selected, \\\n                     _kn_hash_rng,_kn_hash_history_rng, \\\n                     _kn_hash_match_phase,_kn_hash_history_match_phase, \\\n                     _kn_hash_vs_battle_hdr,_kn_hash_history_vs_battle_hdr, \\\n                     _kn_hash_physics_motion,_kn_hash_history_physics_motion, \\\n                     _kn_hash_registry_post_tick|' Makefile.emulatorjs
            echo "    Added kn_hash_registry field exports"
        fi

        # Smoke-test diagnostic helpers (Task 5). Separate group per the plan
        # pattern; same anchor, additive replacement.
        if ! grep -q "_kn_smoke_buf_ptr" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_smoke_buf_ptr,_kn_smoke_dump_stocks|' Makefile.emulatorjs
            echo "    Added kn_hash_registry smoke-test helpers"
        fi

        # Rollback-event field snapshots (Task 8). Same anchor, additive.
        if ! grep -q "_kn_hash_on_replay_enter" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_hash_on_replay_enter,_kn_hash_on_replay_exit, \\\n                     _kn_get_pre_replay_hash,_kn_get_post_replay_hash, \\\n                     _kn_get_last_replay_target_frame,_kn_get_last_replay_final_frame|' Makefile.emulatorjs
            echo "    Added kn_hash_registry rollback-event snapshot exports"
        fi

        # Per-frame replay trajectory ring (Task 9). Same anchor, additive.
        if ! grep -q "_kn_get_replay_frame_hash" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_get_replay_frame_hash,_kn_get_last_replay_length|' Makefile.emulatorjs
            echo "    Added kn_hash_registry replay trajectory exports"
        fi

        # Phase-gating scene_curr export (Task 14). Same anchor, additive.
        if ! grep -q "_kn_get_scene_curr" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_get_scene_curr|' Makefile.emulatorjs
            echo "    Added kn_get_scene_curr export"
        fi

        # ft_buffer hash export (per-fighter coverage). Same anchor, additive.
        if ! grep -q "_kn_hash_ft_buffer" Makefile.emulatorjs; then
            sed -i 's|_kn_get_skip_audio_output|_kn_get_skip_audio_output, \\\n                     _kn_hash_ft_buffer,_kn_hash_history_ft_buffer|' Makefile.emulatorjs
            echo "    Added kn_hash_ft_buffer export"
        fi
    else
        echo "    kn_hash_registry exports disabled (set KN_ENABLE_HASH_REGISTRY=1 for diagnostic builds)"
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

    # Deep audio determinism fix: keep RSP HLE running, but bypass the
    # libretro audio output path (sinc resampler + audio_batch_cb) during
    # netplay. That output path was confirmed cross-engine noisy.
    if [ -f "${PATCHES_DIR}/audio-backend-skip-output.patch" ]; then
        git apply "${PATCHES_DIR}/audio-backend-skip-output.patch" && \
            echo "    Applied audio backend skip-output patch" || \
            echo "    WARN: audio backend skip-output patch failed"
    fi

    # 2026-04-29 audio-diag: counters in ai_controller.c and audio_backend
    # plus kn_dump_audio_state in main.c. Idempotent; runs after both
    # kn-all and audio-backend-skip-output patches so anchors line up.
    # Removed when the silent-iPhone-audio root cause is fixed.
    if [ -f "${SCRIPT_DIR}/inject-audio-diag.py" ]; then
        python3 "${SCRIPT_DIR}/inject-audio-diag.py" "${SRC_DIR}/mupen64plus-libretro-nx" && \
            echo "    Injected audio diagnostic counters + dump" || \
            echo "    WARN: audio-diag injection failed"
    fi

    # 2026-04-29 root-cause fix: signed-rel clamp + cp0_update_count + queue
    # metadata reset in kn_normalize_event_queue, plus VI handler reorder
    # so VI_INT reschedule happens BEFORE new_vi() (which yields to JS via
    # retro_return → co_switch). Codex-reviewed. MUST run after the diag
    # injection because both patch the same single-line normalize body.
    if [ -f "${SCRIPT_DIR}/inject-normalize-fix.py" ]; then
        python3 "${SCRIPT_DIR}/inject-normalize-fix.py" "${SRC_DIR}/mupen64plus-libretro-nx" \
            || { echo "FATAL: inject-normalize-fix.py failed"; exit 1; }
        echo "    Injected normalize signed-clamp + VI handler reorder"
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

    # WebKit/JSC graphics safety: GLideN64's optional VEC4 vertex batching is
    # explicitly documented upstream as a bug-risk optimization. Disable it by
    # default before trying heavier mitigations like full scalar WASM.
    if [ "${KN_DISABLE_GLIDEN64_VEC4}" = "1" ] && grep -q -- '-D__VEC4_OPT' Makefile; then
        sed -i 's| -D__VEC4_OPT||g; s|-D__VEC4_OPT ||g; s|-D__VEC4_OPT||g' Makefile && \
            echo "    Disabled GLideN64 __VEC4_OPT (keeping WASM SIMD)" || \
            echo "    WARN: GLideN64 __VEC4_OPT disable sed failed"
    else
        echo "    Keeping GLideN64 __VEC4_OPT (set KN_DISABLE_GLIDEN64_VEC4=1 to disable)"
    fi

    # WebKit/JSC graphics safety, narrower than KN_DISABLE_WASM_SIMD: keep the
    # emulator core/RSP/audio on wasm SIMD, but compile GLideN64's renderer
    # objects with scalar WASM codegen. This targets the observed CSS corruption
    # without falling back to the full-core scalar build that later froze.
    if [ "${KN_DISABLE_GLIDEN64_SIMD}" = "1" ] && \
        grep -q '^CFLAGS      += $(CPUOPTS)' Makefile && \
        ! grep -q 'GLideN64-only scalar WASM' Makefile; then
        sed -i '/^CFLAGS      += $(CPUOPTS)/a\
\
# kaillera-next: GLideN64-only scalar WASM for WebKit/JSC graphics stability.\
GLideN64/%.o ./GLideN64/%.o custom/GLideN64/%.o ./custom/GLideN64/%.o: CFLAGS := $(filter-out -msimd128,$(CFLAGS)) -mno-simd128\
GLideN64/%.o ./GLideN64/%.o custom/GLideN64/%.o ./custom/GLideN64/%.o: CXXFLAGS := $(filter-out -msimd128,$(CXXFLAGS)) -mno-simd128\
' Makefile && \
            echo "    Disabled WASM SIMD for GLideN64 objects only" || \
            echo "    WARN: GLideN64-only SIMD disable sed failed"
    else
        echo "    Keeping GLideN64 WASM SIMD (set KN_DISABLE_GLIDEN64_SIMD=1 to disable)"
    fi

    # Diagnostic escape hatch: scalar WASM fixed one WebKit CSS rendering probe,
    # but it later reproduced a WebKit abort/freeze during recorded navigation.
    # Keep SIMD as the default path and only disable it for targeted graphics
    # investigation builds.
    if [ "${KN_DISABLE_WASM_SIMD}" = "1" ] && grep -q 'CPUFLAGS += -msimd128' Makefile; then
        sed -i 's|CPUFLAGS += -msimd128 -fno-tree-vectorize|CPUFLAGS += -mno-simd128 -fno-tree-vectorize|' Makefile && \
            echo "    Disabled SIMD (-mno-simd128)" || \
            echo "    WARN: SIMD disable sed failed"
    else
        echo "    Keeping default WASM SIMD (set KN_DISABLE_WASM_SIMD=1 for scalar graphics diagnostics)"
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
    if grep -q "kn_apply_controller_present" libretro/libretro.c && \
        ! grep -q "kn_controller_present_mask" libretro/libretro.c; then
        python3 -c "
path = 'libretro/libretro.c'
src = open(path).read()
needle = 'int pad_present[4] = {1, 1, 1, 1};\\n'
insert = needle + '''static int kn_controller_present_mask = 0x0f;

static void kn_apply_controller_present(int slot)
{
    int present;
    if (slot < 0 || slot >= 4)
        return;
    present = (kn_controller_present_mask >> slot) & 1;
    pad_present[slot] = present;
    if (controller[slot].control)
        controller[slot].control->Present = present;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE void kn_set_controller_present_mask(int mask)
{
    int i;
    kn_controller_present_mask = mask & 0x0f;
    for (i = 0; i < 4; i++)
        kn_apply_controller_present(i);
}
#endif

'''
if needle not in src:
    raise SystemExit('pad_present anchor not found')
src = src.replace(needle, insert, 1)
open(path, 'w').write(src)
"
        echo "    Injected controller-present mask helpers"
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

    # Inject per-frame hidden-state pack/restore for rollback. These fields
    # are outside, or not reliably restored by, retro_serialize and must track
    # the same ring slot as the RDRAM savestate.
    if ! grep -q "kn_pack_hidden_state_impl" mupen64plus-core/src/main/main.c; then
        cat >> mupen64plus-core/src/main/main.c <<'KNHS_EOF'

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE void kn_pack_hidden_state_impl(uint32_t *out) {
    if (!out) return;
    out[0] = (uint32_t)g_dev.ai.fifo[0].duration;
    out[1] = (uint32_t)g_dev.ai.fifo[0].length;
    out[2] = (uint32_t)g_dev.ai.fifo[1].duration;
    out[3] = (uint32_t)g_dev.ai.fifo[1].length;
    out[4] = (uint32_t)g_dev.sp.rsp_task_locked;
    out[5] = (uint32_t)g_dev.r4300.cp0.interrupt_unsafe_state;
    out[6] = (uint32_t)g_dev.si.dma_duration;
    out[7] = *r4300_cp0_last_addr(&g_dev.r4300.cp0);
    out[8] = 0; /* Reserved for legacy kn_instr_count builds. */
    out[9] = (uint32_t)g_dev.vi.field;
    out[10] = (uint32_t)g_dev.vi.delay;
    out[11] = (uint32_t)g_dev.ai.last_read;
    out[12] = (uint32_t)g_dev.ai.delayed_carry;
    out[13] = (uint32_t)g_dev.ai.samples_format_changed;
    out[14] = (uint32_t)g_dev.si.dma_dir;
    out[15] = (uint32_t)g_dev.dp.do_on_unfreeze;
    out[16] = *r4300_cp0_next_interrupt(&g_dev.r4300.cp0);
    out[17] = (uint32_t)*r4300_cp0_cycle_count(&g_dev.r4300.cp0);
}

EMSCRIPTEN_KEEPALIVE void kn_restore_hidden_state_impl(const uint32_t *in) {
    if (!in) return;
    g_dev.ai.fifo[0].duration = (unsigned int)in[0];
    g_dev.ai.fifo[0].length = (unsigned int)in[1];
    g_dev.ai.fifo[1].duration = (unsigned int)in[2];
    g_dev.ai.fifo[1].length = (unsigned int)in[3];
    g_dev.sp.rsp_task_locked = (int)in[4];
    g_dev.r4300.cp0.interrupt_unsafe_state = (int)in[5];
    g_dev.si.dma_duration = (unsigned int)in[6];
    *r4300_cp0_last_addr(&g_dev.r4300.cp0) = in[7];
    g_dev.vi.field = (unsigned int)in[9];
    g_dev.vi.delay = (unsigned int)in[10];
    g_dev.ai.last_read = (uint32_t)in[11];
    g_dev.ai.delayed_carry = (uint32_t)in[12];
    g_dev.ai.samples_format_changed = (unsigned int)in[13];
    g_dev.si.dma_dir = (unsigned char)in[14];
    g_dev.dp.do_on_unfreeze = (unsigned char)in[15];
    *r4300_cp0_next_interrupt(&g_dev.r4300.cp0) = in[16];
    *r4300_cp0_cycle_count(&g_dev.r4300.cp0) = (int)in[17];
}

EMSCRIPTEN_KEEPALIVE void kn_restore_hidden_state_boot(const uint32_t *in) {
    if (!in) return;
    g_dev.sp.rsp_task_locked = (int)in[4];
    g_dev.r4300.cp0.interrupt_unsafe_state = (int)in[5];
    *r4300_cp0_last_addr(&g_dev.r4300.cp0) = in[7];
}

EMSCRIPTEN_KEEPALIVE void kn_set_audio_fifo_state(
    uint32_t f0_duration, uint32_t f0_length,
    uint32_t f1_duration, uint32_t f1_length) {
    g_dev.ai.fifo[0].duration = (unsigned int)f0_duration;
    g_dev.ai.fifo[0].length = (unsigned int)f0_length;
    g_dev.ai.fifo[1].duration = (unsigned int)f1_duration;
    g_dev.ai.fifo[1].length = (unsigned int)f1_length;
}

EMSCRIPTEN_KEEPALIVE void kn_get_audio_fifo_state(uint32_t *out) {
    if (!out) return;
    out[0] = (uint32_t)g_dev.ai.fifo[0].duration;
    out[1] = (uint32_t)g_dev.ai.fifo[0].length;
    out[2] = (uint32_t)g_dev.ai.fifo[1].duration;
    out[3] = (uint32_t)g_dev.ai.fifo[1].length;
}

EMSCRIPTEN_KEEPALIVE void kn_post_state_load_cleanup(void) {
    g_dev.sp.rsp_task_locked = 0;
    g_dev.r4300.cp0.interrupt_unsafe_state = 0;
    *r4300_cp0_last_addr(&g_dev.r4300.cp0) = *r4300_pc(&g_dev.r4300);
    {
        extern void kn_normalize_event_queue(void);
        kn_normalize_event_queue();
    }
    {
        extern void invalidate_cached_code_hacktarux(struct r4300_core* r4300, uint32_t address, size_t size);
        invalidate_cached_code_hacktarux(&g_dev.r4300, 0, 0);
    }
}
#endif
KNHS_EOF
        echo "    Injected kn_pack/restore_hidden_state_impl + audio FIFO helpers"
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
EMSCRIPTEN_KEEPALIVE int kn_hle_state_size(void) { return KN_HLE_RB_SIZE; }
EMSCRIPTEN_KEEPALIVE void kn_hle_save_to(uint8_t *buf) {
    if (buf) memcpy(buf, ((uint8_t *)&g_hle) + KN_HLE_RB_OFFSET, KN_HLE_RB_SIZE);
}
EMSCRIPTEN_KEEPALIVE void kn_hle_restore_from(const uint8_t *buf) {
    if (buf) memcpy(((uint8_t *)&g_hle) + KN_HLE_RB_OFFSET, buf, KN_HLE_RB_SIZE);
}
#endif
KNHLE_EOF
        echo "    Injected kn_hle_save/kn_hle_restore + per-frame hle ring helpers"
    fi

    # v4 kn_sync_read/write: complete state capture matching retro_serialize.
    # Must run AFTER kn-all.patch which creates the v1 functions.
    echo "    Upgrading kn_sync_read/write to v4 (complete state capture)..."
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
    # Add kn_rollback.c to SOURCES_C in Makefile.common. The hash registry is
    # diagnostic-only so the default production core keeps the older WASM shape.
    sed -i 's|$(CORE_DIR)/src/main/savestates.c \\|$(CORE_DIR)/src/main/savestates.c \\\n\t$(CORE_DIR)/src/main/kn_rollback.c \\|' Makefile.common
    if [ "${KN_ENABLE_HASH_REGISTRY}" = "1" ]; then
        cp "${SCRIPT_DIR}/kn_rollback/kn_hash_registry.c" mupen64plus-core/src/main/kn_hash_registry.c
        cp "${SCRIPT_DIR}/kn_rollback/kn_hash_registry.h" mupen64plus-core/src/main/kn_hash_registry.h
        sed -i 's|$(CORE_DIR)/src/main/kn_rollback.c \\|$(CORE_DIR)/src/main/kn_rollback.c \\\n\t$(CORE_DIR)/src/main/kn_hash_registry.c \\|' Makefile.common
        echo 'CFLAGS += -DKN_ENABLE_HASH_REGISTRY' >> Makefile.common
        echo "    Enabled kn_hash_registry diagnostic storage"
    else
        echo "    Skipped kn_hash_registry object (set KN_ENABLE_HASH_REGISTRY=1 for diagnostic builds)"
    fi
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

    # Compile each SoftFloat .c to .o (WASM bitcode via emcc).
    # Keep this under the same job cap as make; unbounded background emcc jobs
    # can overwhelm Docker/Rosetta on Apple Silicon.
    sf_pids=()
    sf_failed=0
    for src in "${SF_SOURCES[@]}"; do
        base="$(basename "${src}" .c)"
        emcc ${SF_CFLAGS} ${SF_INCS} -c "${src}" -o "${SF_OBJ_DIR}/${base}.o" &
        sf_pids+=("$!")
        if [ "${#sf_pids[@]}" -ge "${KN_BUILD_JOBS}" ]; then
            if ! wait "${sf_pids[0]}"; then
                sf_failed=1
            fi
            sf_pids=("${sf_pids[@]:1}")
        fi
    done
    for pid in "${sf_pids[@]}"; do
        if ! wait "${pid}"; then
            sf_failed=1
        fi
    done
    if [ "${sf_failed}" != "0" ]; then
        echo "ERROR: SoftFloat compilation failed"
        exit 1
    fi

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
if [ "${KN_SKIP_MAKE_CLEAN}" = "1" ]; then
    echo "    Skipping make clean (KN_SKIP_MAKE_CLEAN=1)"
else
    emmake make -f Makefile platform=emscripten clean 2>/dev/null || true
fi

# Build
emmake make -j"${KN_BUILD_JOBS}" -f Makefile platform=emscripten LTO=1

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
    -j"${KN_BUILD_JOBS}"

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
