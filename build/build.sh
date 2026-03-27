#!/bin/bash
# build/build.sh — Build the patched mupen64plus_next core for EmulatorJS
#
# Usage:
#   docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh
#
# Stages:
#   1. Clone source repos (if not present)
#   2. Apply kaillera-next patches for deterministic timing
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
# Stage 1b: --denan injection
# ============================================================
# With PROXY_TO_PTHREAD (no asyncify), --denan runs as a post-link
# wasm-opt pass in Stage 4b instead of being injected into the
# emscripten link pipeline. Nothing to patch here.
echo "==> Stage 1b: --denan will run as post-link pass (no asyncify)"

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
fi

# ============================================================
# Stage 3: Compile core to LLVM bitcode
# ============================================================
echo "==> Stage 3: Compile core to LLVM bitcode (.bc)"
cd "${SRC_DIR}/mupen64plus-libretro-nx"

# Clean previous build artifacts
emmake make -f Makefile platform=emscripten clean 2>/dev/null || true

# Build with EMULATORJS_THREADS=1 so .bc is compiled with -pthread,
# required for PROXY_TO_PTHREAD linking (SharedArrayBuffer/atomics).
emmake make -j$(nproc) -f Makefile platform=emscripten EMULATORJS_THREADS=1

BC_FILE="${SRC_DIR}/mupen64plus-libretro-nx/mupen64plus_next_libretro_emscripten.bc"
if [ ! -f "${BC_FILE}" ]; then
    echo "ERROR: .bc file not produced"
    exit 1
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

# Build with PROXY_TO_PTHREAD: moves entire RetroArch main loop to a
# Web Worker. Requires crossOriginIsolated (COOP/COEP headers on server).
# PROXY_TO_PTHREAD implies HAVE_THREADS=1 and uses OffscreenCanvas for GL.
# ASYNC=0 because the worker thread can block natively (no asyncify needed).
emmake make -f Makefile.emulatorjs \
    HAVE_OPENGLES3=1 \
    PROXY_TO_PTHREAD=1 \
    HAVE_7ZIP=1 \
    HAVE_CHD=1 \
    STACK_SIZE=134217728 \
    INITIAL_HEAP=536870912 \
    TARGET=mupen64plus_next_libretro.js \
    -j$(nproc)

JS_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.js"
WASM_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.wasm"

if [ ! -f "${JS_FILE}" ] || [ ! -f "${WASM_FILE}" ]; then
    echo "ERROR: .js or .wasm not produced"
    exit 1
fi
echo "==> JS glue: $(ls -lh ${JS_FILE} | awk '{print $5}')"
echo "==> WASM:    $(ls -lh ${WASM_FILE} | awk '{print $5}')"

# ============================================================
# Stage 4b: NaN canonicalization (wasm-opt --denan + fix-denan.py)
# ============================================================
# Without asyncify, --denan runs as a standalone post-link pass.
# Then fix-denan.py patches NaN→0 replacements to NaN→canonical NaN.
echo "==> Stage 4b: Running wasm-opt --denan + fix-denan.py"
WASM_OPT="/opt/emsdk/upstream/bin/wasm-opt"
if [ -f "${WASM_OPT}" ]; then
    "${WASM_OPT}" --denan "${WASM_FILE}" -o "${WASM_FILE}"
    echo "    wasm-opt --denan applied"
else
    echo "    WARNING: wasm-opt not found, skipping --denan pass"
fi
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
