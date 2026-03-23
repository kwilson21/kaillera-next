#!/usr/bin/env python3
"""Post-process wasm-opt --denan output to use canonical NaN instead of 0.0.

The --denan pass creates helper functions like:
  (func (param f32) (result f32)
    (if (result f32) (f32.eq (local.get $0) (local.get $0))
      (then (local.get $0))
      (else (f32.const 0))))    ;; <-- NaN replacement value

In binary, the else branch is: 05 43 00000000 0B (else, f32.const 0.0, end)
We replace with:               05 43 0000C07F 0B (else, f32.const canonical_nan, end)

Similarly for f64: 05 44 0000000000000000 0B → 05 44 000000000000F87F 0B
"""
import sys

def patch_denan(data):
    result = bytearray(data)

    # f32: else + f32.const 0.0 + end → else + f32.const 0x7FC00000 + end
    f32_pattern = bytes([0x05, 0x43, 0x00, 0x00, 0x00, 0x00, 0x0B])
    f32_replace = bytes([0x05, 0x43, 0x00, 0x00, 0xC0, 0x7F, 0x0B])

    # f64: else + f64.const 0.0 + end → else + f64.const 0x7FF8000000000000 + end
    f64_pattern = bytes([0x05, 0x44] + [0x00]*8 + [0x0B])
    f64_replace = bytes([0x05, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x7F, 0x0B])

    f32_count = 0
    f64_count = 0

    # Replace f32 patterns
    i = 0
    while i <= len(result) - len(f32_pattern):
        if result[i:i+len(f32_pattern)] == bytearray(f32_pattern):
            result[i:i+len(f32_replace)] = bytearray(f32_replace)
            f32_count += 1
            i += len(f32_replace)
        else:
            i += 1

    # Replace f64 patterns
    i = 0
    while i <= len(result) - len(f64_pattern):
        if result[i:i+len(f64_pattern)] == bytearray(f64_pattern):
            result[i:i+len(f64_replace)] = bytearray(f64_replace)
            f64_count += 1
            i += len(f64_replace)
        else:
            i += 1

    print(f"    Patched {f32_count} f32 and {f64_count} f64 denan sites (0→canonical NaN)")
    return bytes(result)

if __name__ == "__main__":
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else in_path

    with open(in_path, "rb") as f:
        data = f.read()

    patched = patch_denan(data)

    with open(out_path, "wb") as f:
        f.write(patched)
