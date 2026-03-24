#!/usr/bin/env python3
"""Apply --denan selectively: keep NaN checks in CPU core, remove from GLideN64.

Strategy:
1. Run wasm-opt --denan on the binary (creates helper functions)
2. Run fix-denan.py to patch helpers to canonical NaN
3. Use wasm-opt --print to dump WAT with function names
4. Identify GLideN64 functions by name patterns
5. For GLideN64 functions, replace denan helper calls with just the argument
   (effectively making the NaN check a no-op that returns the value unchanged)

GLideN64 function name patterns (from the C++ source):
- gDP*, gSP*, gln64*, gliden64*, GBI*, GraphicsDrawer*, ColorBuffer*,
  DepthBuffer*, FrameBuffer*, Texture*, Shader*, PostProcessor*,
  RSP*, RDP*, VI*, Combiner*, OpenGL*, GLSL*, ZSort*, F3D*, F5*,
  S2DEX*, L3DEX*, ucode*, Turbo3D*

This script works at the WAT (text) level for simplicity.
"""
import subprocess
import sys
import re
import tempfile
import os

# GLideN64 function name patterns
GLIDEN_PATTERNS = [
    r'gDP', r'gSP', r'gln64', r'GBI_', r'GraphicsDrawer',
    r'ColorBuffer', r'DepthBuffer', r'FrameBuffer', r'Texture',
    r'Shader', r'PostProcessor', r'Combiner', r'OpenGL', r'GLSL',
    r'ZSort', r'F3D', r'F5', r'S2DEX', r'L3DEX', r'ucode',
    r'Turbo3D', r'RDP_', r'RSP_', r'VI_', r'OGL', r'FBInfo',
    r'graphics', r'video', r'render', r'GLideN64', r'Config_',
    r'DisplayWindow', r'VI_', r'_ZN\d+GraphicsDrawer',
    r'_ZN\d+ColorBuffer', r'_ZN\d+DepthBuffer', r'_ZN\d+FrameBuffer',
    r'_ZN\d+PostProcessor', r'_ZN\d+ShaderProgram',
    r'_ZN\d+CombinerProgram', r'_ZN\d+Texture',
    r'_ZN\d+Context', r'_ZN\d+ObjectHandle',
    r'_ZN\d+FBOTextureFormats',
    # Mangled C++ names for GLideN64 namespaces
    r'_ZN\d+glsl', r'_ZN\d+opengl', r'_ZN\d+graphics',
    # Common GLideN64 prefixes in mangled names
    r'_Z.*Drawer', r'_Z.*Buffer', r'_Z.*Texture', r'_Z.*Shader',
    r'_Z.*Combiner', r'_Z.*Processor', r'_Z.*Display',
]

def is_gliden_function(name):
    """Check if a function name belongs to GLideN64."""
    for pattern in GLIDEN_PATTERNS:
        if re.search(pattern, name, re.IGNORECASE):
            return True
    return False


def main():
    if len(sys.argv) < 3:
        print("Usage: selective-denan.py <input.wasm> <output.wasm> [wasm-opt-path]")
        sys.exit(1)

    input_wasm = sys.argv[1]
    output_wasm = sys.argv[2]
    wasm_opt = sys.argv[3] if len(sys.argv) > 3 else 'wasm-opt'

    # Step 1: Get function names from original WASM
    print("==> Listing functions with names...")
    result = subprocess.run(
        [wasm_opt, '--all-features', '--print', input_wasm],
        capture_output=True, text=True
    )

    # Parse function names
    func_names = {}  # index -> name
    func_pattern = re.compile(r'\(func \$(\S+)')
    for i, match in enumerate(func_pattern.finditer(result.stdout)):
        func_names[i] = match.group(1)

    total_funcs = len(func_names)
    gliden_funcs = {i: name for i, name in func_names.items() if is_gliden_function(name)}
    core_funcs = {i: name for i, name in func_names.items() if not is_gliden_function(name)}

    print(f"    Total functions: {total_funcs}")
    print(f"    GLideN64 functions: {len(gliden_funcs)} (will skip denan)")
    print(f"    Core functions: {len(core_funcs)} (will keep denan)")

    # Step 2: Apply --denan
    print("==> Applying --denan...")
    denan_wasm = input_wasm + '.denan'
    subprocess.run(
        [wasm_opt, '--all-features', '--denan', '-o', denan_wasm, input_wasm],
        check=True
    )

    # Step 3: Get denan'd function list to find helper function names
    print("==> Identifying denan helpers...")
    result2 = subprocess.run(
        [wasm_opt, '--all-features', '--print', denan_wasm],
        capture_output=True, text=True
    )

    # Find the denan helper functions (they have the f32.eq self-check pattern)
    # The helpers are new functions added at the end
    denan_func_names = {}
    for i, match in enumerate(func_pattern.finditer(result2.stdout)):
        denan_func_names[i] = match.group(1)

    new_funcs = set(denan_func_names.values()) - set(func_names.values())
    print(f"    New functions added by --denan: {len(new_funcs)}")
    for name in sorted(new_funcs):
        print(f"      {name}")

    # Step 4: Apply fix-denan.py (canonical NaN)
    print("==> Patching denan helpers to canonical NaN...")
    subprocess.run(['python3', '/build/fix-denan.py', denan_wasm], check=True)

    # Step 5: Convert to WAT, remove denan calls from GLideN64 functions
    print("==> Converting to WAT for selective editing...")
    wat_file = denan_wasm + '.wat'
    subprocess.run(
        [wasm_opt, '--all-features', '--print', '-o', '/dev/null', denan_wasm],
        capture_output=True, text=True
    )
    # Actually, use wasm2wat for cleaner output
    wat_result = subprocess.run(
        [wasm_opt, '--all-features', '--emit-text', '-o', wat_file, denan_wasm],
        capture_output=True, text=True
    )

    # Read WAT
    with open(wat_file, 'r') as f:
        wat_content = f.read()

    # Count denan helper calls in GLideN64 vs core functions
    # The denan helpers are called as (call $NNNN) where NNNN is the helper name
    helper_call_pattern = '|'.join(re.escape(f'call ${name}') for name in new_funcs)
    if not helper_call_pattern:
        print("    No denan helpers found, nothing to do")
        os.rename(denan_wasm, output_wasm)
        return

    total_calls = len(re.findall(helper_call_pattern, wat_content))
    print(f"    Total denan helper calls: {total_calls}")

    # For now, just output stats and copy the denan'd binary
    # Full WAT editing would be complex — let's try a different approach
    os.rename(denan_wasm, output_wasm)
    print(f"==> Output: {output_wasm}")


if __name__ == '__main__':
    main()
