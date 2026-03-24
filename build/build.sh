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
# Stage 2: Apply patches
# ============================================================
if [ -d "${PATCHES_DIR}" ]; then
    echo "==> Applying kaillera-next patches..."

    if [ -f "${PATCHES_DIR}/retroarch-deterministic-timing.patch" ]; then
        cd "${SRC_DIR}/RetroArch"
        git checkout -- . 2>/dev/null || true
        git apply "${PATCHES_DIR}/retroarch-deterministic-timing.patch" && \
            echo "    Applied RetroArch patch" || \
            echo "    RetroArch patch already applied or failed"
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ] || \
       [ -f "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git checkout -- . 2>/dev/null || true
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git apply "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" && \
            echo "    Applied mupen64plus timing patch" || \
            echo "    mupen64plus timing patch already applied or failed"
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git apply "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" && \
            echo "    Applied mupen64plus determinism patch" || \
            echo "    mupen64plus determinism patch already applied or failed"
    fi

    if [ -f "${PATCHES_DIR}/kn-sync.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git apply "${PATCHES_DIR}/kn-sync.patch" && \
            echo "    Applied kn-sync patch (C-level resync)" || \
            echo "    kn-sync patch already applied or failed"
    fi
fi

# ============================================================
# Stage 3: Compile core to LLVM bitcode
# ============================================================
echo "==> Stage 3: Compile core to LLVM bitcode (.bc)"
cd "${SRC_DIR}/mupen64plus-libretro-nx"

# Clean previous build artifacts
emmake make -f Makefile platform=emscripten clean 2>/dev/null || true

# Build
emmake make -j$(nproc) -f Makefile platform=emscripten

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

# Build with same flags as EmulatorJS's build-emulatorjs.sh uses for mupen64plus_next:
# - ASYNC=1 (full asyncify)
# - HAVE_OPENGLES3=1 (WebGL2)
# - STACK_SIZE=128MB (largeStack for mupen64plus_next)
# - INITIAL_HEAP=512MB (largeHeap for mupen64plus_next)
# - HAVE_7ZIP=1, HAVE_CHD=1
emmake make -f Makefile.emulatorjs \
    HAVE_OPENGLES3=1 \
    ASYNC=1 \
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
