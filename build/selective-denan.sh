#!/bin/bash
# Apply --denan selectively: keep NaN checks in core, strip from GLideN64.
#
# Strategy:
# 1. Apply --denan to the full WASM (instruments everything)
# 2. Apply fix-denan.py (canonical NaN instead of zero)
# 3. Dump WAT text format
# 4. Identify GLideN64 function boundaries
# 5. Replace denan helper calls in GLideN64 functions with no-ops
# 6. Convert back to WASM and strip function names
set -euo pipefail

WASM_OPT="${1:-/opt/emsdk/upstream/bin/wasm-opt}"
INPUT_WASM="${2:-mupen64plus_next_libretro.wasm}"
OUTPUT_WASM="${3:-${INPUT_WASM}}"
FIX_DENAN="${4:-/build/fix-denan.py}"

echo "==> Step 1: Apply --denan"
${WASM_OPT} --all-features --denan -o "${INPUT_WASM}.denan" "${INPUT_WASM}"

echo "==> Step 2: Apply fix-denan.py (canonical NaN)"
python3 "${FIX_DENAN}" "${INPUT_WASM}.denan"

echo "==> Step 3: Convert to WAT"
${WASM_OPT} --all-features --emit-text -o "${INPUT_WASM}.wat" "${INPUT_WASM}.denan"

echo "==> Step 4: Selective removal of denan calls from GLideN64 functions"
python3 - "${INPUT_WASM}.wat" "${INPUT_WASM}.selective.wat" << 'PYEOF'
import sys
import re

input_wat = sys.argv[1]
output_wat = sys.argv[2]

# GLideN64 function name patterns (case-insensitive match)
GLIDEN_PATTERNS = [
    'gDP', 'gSP', 'GLideN64', 'GraphicsDrawer', 'ColorBuffer',
    'DepthBuffer', 'FrameBuffer', 'TextureCache', 'Shader',
    'PostProcessor', 'Combiner', 'GLSL', 'OGL', 'OpenGL',
    'F3D', 'F5Indi', 'F5Rogue', 'S2DEX', 'L3DEX', 'ZSort',
    'Turbo3D', 'DisplayWindow', 'FBInfo', 'TMEM', 'RDP',
    'Context', 'ObjectHandle', 'FBOTextureFormats',
    'RSP_', 'VI_UpdateScreen', 'VI_Refresh',
    'video_thread', 'GBI',
    # Common rendering-related names
    'render', 'draw', 'blit', 'pixel', 'color', 'vertex',
    'triangle', 'rect', 'fog', 'light', 'normal', 'texel',
    'clamp', 'wrap', 'mirror', 'filter', 'mipmap', 'lod',
]

def is_gliden_func(name):
    name_lower = name.lower()
    for pat in GLIDEN_PATTERNS:
        if pat.lower() in name_lower:
            return True
    return False

# Find denan helper function names by looking for the characteristic pattern
# The helpers are small functions that do: if (f32.eq x x) then x else canonical_nan
# They were added by --denan and have names like $7263, $7264, etc.

with open(input_wat, 'r') as f:
    content = f.read()

# Find denan helper names: functions that contain "f32.eq" + "f32.const" in a small body
# Actually, let's find them by looking for the pattern of new functions added by --denan
func_pattern = re.compile(r'^\s*\(func \$(\S+)', re.MULTILINE)
all_funcs = func_pattern.findall(content)
print(f"    Total functions: {len(all_funcs)}")

# Find helper function names by looking for tiny functions with the NaN check pattern
# These functions have f32.eq (self-check) and f32.const (replacement)
helper_names = set()
for match in re.finditer(r'\(func \$(\S+).*?\n(.*?)\n\s*\)', content, re.DOTALL):
    fname = match.group(1)
    body = match.group(2)
    # Denan helpers are very small and contain f32.eq + f32.const or f64.eq + f64.const
    lines = [l.strip() for l in body.split('\n') if l.strip()]
    if len(lines) < 25 and ('f32.eq' in body or 'f64.eq' in body) and ('.const' in body):
        # Check it's a self-equality test (NaN detection)
        if 'local.get $0' in body and ('local.get $0)' in body):
            helper_names.add(fname)

if not helper_names:
    # Fallback: look for numeric function names that are very high (added at end by --denan)
    numeric_funcs = [f for f in all_funcs if f.isdigit()]
    if numeric_funcs:
        # The denan helpers are the highest-numbered functions
        max_num = max(int(f) for f in numeric_funcs)
        for f in numeric_funcs:
            if int(f) >= max_num - 10:  # Last ~10 functions
                helper_names.add(f)

print(f"    Denan helper functions: {helper_names}")

if not helper_names:
    print("    WARNING: No denan helpers found, copying as-is")
    with open(output_wat, 'w') as f:
        f.write(content)
    sys.exit(0)

# Build call pattern for denan helpers
helper_call_re = re.compile(r'\(call \$(' + '|'.join(re.escape(h) for h in helper_names) + r')\s')

# Process function by function: in GLideN64 functions, remove denan calls
# A denan call looks like: (call $7263 (some_expression))
# We want to replace it with just: (some_expression)
# In WAT, this means removing the "(call $7263" wrapper and its closing ")"

in_gliden_func = False
current_func_name = ""
lines = content.split('\n')
output_lines = []
gliden_func_count = 0
calls_removed = 0
calls_kept = 0

func_start_re = re.compile(r'^\s*\(func \$(\S+)')

i = 0
while i < len(lines):
    line = lines[i]

    # Track which function we're in
    func_match = func_start_re.match(line)
    if func_match:
        current_func_name = func_match.group(1)
        in_gliden_func = is_gliden_func(current_func_name)
        if in_gliden_func:
            gliden_func_count += 1

    # In GLideN64 functions, replace denan helper calls
    if in_gliden_func and helper_call_re.search(line):
        # Replace (call $helper_name ...) with just the argument
        # Simple approach: replace "call $helper_name" with "nop) (drop"
        # Actually, the helper takes a float and returns a float.
        # Removing the call entirely: replace "(call $7263" with "(" and leave the arg.
        # But WAT s-expression editing is complex.
        # Simpler: replace the call with a call to a no-op identity function.
        # Even simpler: just leave it. Count for stats.
        #
        # Actually the simplest correct approach: we need to remove the
        # "(call $helper" and its matching ")". The helper takes 1 arg and returns 1 value.
        # In folded WAT: (call $7263 (f32.add ...)) -> (f32.add ...)
        # In stack WAT: ... call $7263 -> ... (just remove the call)

        for helper in helper_names:
            # Handle folded form: (call $helper (expr))
            line = re.sub(r'\(call \$' + re.escape(helper) + r'\s*\n', '\n', line)
            line = re.sub(r'\(call \$' + re.escape(helper) + r'\b', '(', line)
        calls_removed += line.count('(call') == 0  # rough count
    elif helper_call_re.search(line):
        calls_kept += 1

    output_lines.append(line)
    i += 1

print(f"    GLideN64 functions processed: {gliden_func_count}")
print(f"    Denan calls in core (kept): estimated {calls_kept}")

with open(output_wat, 'w') as f:
    f.write('\n'.join(output_lines))
PYEOF

echo "==> Step 5: Convert back to WASM"
${WASM_OPT} --all-features "${INPUT_WASM}.selective.wat" -o "${INPUT_WASM}.selective"

echo "==> Step 6: Strip function names for production"
${WASM_OPT} --all-features --strip-debug --strip-producers -o "${OUTPUT_WASM}" "${INPUT_WASM}.selective"

SIZE_ORIG=$(ls -l "${INPUT_WASM}" | awk '{print $5}')
SIZE_FINAL=$(ls -l "${OUTPUT_WASM}" | awk '{print $5}')
echo "==> WASM: ${SIZE_ORIG} -> ${SIZE_FINAL} bytes"

# Cleanup
rm -f "${INPUT_WASM}.denan" "${INPUT_WASM}.wat" "${INPUT_WASM}.selective.wat" "${INPUT_WASM}.selective"
