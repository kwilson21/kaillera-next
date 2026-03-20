#!/bin/bash
# build-via-orchestrator.sh — Build patched core using EmulatorJS's official build system.
# This produces CDN-compatible output (async module factory, correct pre.js, etc.)
#
# Usage: docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build-via-orchestrator.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHES_DIR="${SCRIPT_DIR}/patches"
BUILD_DIR="${SCRIPT_DIR}/src/emulatorjs-build"

cd "${BUILD_DIR}"

# Install jq (needed by the build system)
which jq >/dev/null 2>&1 || apt-get install -y jq >/dev/null

# Set up emsdk
source /opt/emsdk/emsdk_env.sh 2>/dev/null

# Run the build for just mupen64plus_next
echo "==> Starting EmulatorJS build orchestrator for mupen64plus_next..."
echo "==> This will clone RetroArch + core, compile, link, and package."

# The build.sh will clone repos into compile/
# We need to apply patches AFTER it clones but BEFORE it compiles.
# Strategy: let it clone, then stop, apply patches, then resume.
# Easier: pre-clone and apply patches, then run the build.

mkdir -p compile
cd compile

# Clone RetroArch if not present
if [ ! -d "RetroArch" ]; then
    echo "==> Cloning RetroArch..."
    git clone --depth 1 -b next "https://github.com/EmulatorJS/RetroArch.git" "RetroArch"
fi

# Clone EmulatorJS into RetroArch (build system expects it there)
cd RetroArch
if [ ! -d "EmulatorJS" ]; then
    echo "==> Cloning EmulatorJS..."
    git clone --depth 1 "https://github.com/EmulatorJS/EmulatorJS.git" "EmulatorJS"
fi

# Apply our patches to RetroArch
echo "==> Applying RetroArch deterministic timing patch..."
cd "${BUILD_DIR}/compile/RetroArch"
git checkout -- . 2>/dev/null || true
if [ -f "${PATCHES_DIR}/retroarch-deterministic-timing.patch" ]; then
    git apply "${PATCHES_DIR}/retroarch-deterministic-timing.patch"
    echo "    Applied RetroArch patch"
fi

# Create pre.js if missing (build-emulatorjs.sh references it)
mkdir -p emulatorjs
if [ ! -f "emulatorjs/pre.js" ]; then
    cat > emulatorjs/pre.js << 'PREJS'
// To work around a bug in emscripten's polyfills for setImmediate in strict mode
var setImmediate;

// To work around a deadlock in firefox
// Use platform_emscripten_has_async_atomics() to determine actual availability
if (Atomics && !Atomics.waitAsync) Atomics.waitAsync = true;
PREJS
    echo "    Created emulatorjs/pre.js"
fi

# Now go to the core temp area and clone the core
cd "${BUILD_DIR}/compile/RetroArch/emulatorjs"
mkdir -p core-temp/normal core-temp/threads core-temp/legacy core-temp/legacyThreads

if [ ! -d "mupen64plus_next" ]; then
    echo "==> Cloning mupen64plus-libretro-nx..."
    git clone --depth 1 "https://github.com/EmulatorJS/mupen64plus-libretro-nx.git" "mupen64plus_next"
fi

# Apply our patches to the core
echo "==> Applying mupen64plus deterministic timing patch..."
cd mupen64plus_next
git checkout -- . 2>/dev/null || true
if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ]; then
    git apply "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch"
    echo "    Applied mupen64plus patch"
fi

# Build the core (Stage 1: .bc bitcode)
echo "==> Stage 1: Compiling core to bitcode..."
emmake make -f Makefile platform=emscripten clean 2>/dev/null || true
emmake make -j$(nproc) -f Makefile platform=emscripten

# Copy .bc to where build-emulatorjs.sh expects it
cp mupen64plus_next_libretro_emscripten.bc "../core-temp/normal/"

# Go back to emulatorjs dir and run the linker
cd "${BUILD_DIR}/compile/RetroArch/emulatorjs"

# Now run build-emulatorjs.sh with just the normal variant
# The script iterates over .bc files in the current dir
cp core-temp/normal/mupen64plus_next_libretro_emscripten.bc .

echo "==> Stage 2: Linking through RetroArch (build-emulatorjs.sh)..."
emmake ./build-emulatorjs.sh --clean 2>&1

# Check output
OUT_DIR="${BUILD_DIR}/compile/RetroArch/EmulatorJS/data/cores"
if [ -f "${OUT_DIR}/mupen64plus_next-wasm.data" ]; then
    echo ""
    echo "=========================================="
    echo "BUILD COMPLETE"
    echo "Output: ${OUT_DIR}/mupen64plus_next-wasm.data"
    echo "Size:   $(ls -lh ${OUT_DIR}/mupen64plus_next-wasm.data | awk '{print $5}')"
    echo "=========================================="

    # Copy to our output dir
    mkdir -p "${SCRIPT_DIR}/output"
    cp "${OUT_DIR}/mupen64plus_next-wasm.data" "${SCRIPT_DIR}/output/"
else
    echo "ERROR: Output not found at ${OUT_DIR}"
    ls -la "${OUT_DIR}/" 2>/dev/null || echo "Directory does not exist"
    exit 1
fi
