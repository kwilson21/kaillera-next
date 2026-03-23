#!/usr/bin/env python3
"""Post-process wasm-opt --denan output to use canonical NaN instead of 0.0.

The --denan pass creates helper functions that replace NaN with 0. We patch
those helpers to use canonical NaN instead, preserving isnan() semantics.

Patterns in WASM binary (else branch of the denan if/else):
  f32:  05 43 00000000 0B              → 05 43 0000C07F 0B
  f64:  05 44 0000000000000000 0B      → 05 44 000000000000F87F 0B
  v128: 05 FD0C 00*16 0B              → 05 FD0C (0000C07F)*4 0B
"""
import sys

def patch_denan(data):
    result = bytearray(data)

    # f32: else + f32.const 0.0 + end
    f32_pat = bytes([0x05, 0x43, 0x00, 0x00, 0x00, 0x00, 0x0B])
    f32_rep = bytes([0x05, 0x43, 0x00, 0x00, 0xC0, 0x7F, 0x0B])

    # f64: else + f64.const 0.0 + end
    f64_pat = bytes([0x05, 0x44] + [0x00]*8 + [0x0B])
    f64_rep = bytes([0x05, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x7F, 0x0B])

    # v128: else + v128.const(all zeros) + end
    # v128.const opcode = 0xFD 0x0C (LEB128), followed by 16 bytes
    v128_pat = bytes([0x05, 0xFD, 0x0C] + [0x00]*16 + [0x0B])
    # Replace with 4x canonical f32 NaN (0x7FC00000 LE = 00 00 C0 7F)
    canon_f32_le = bytes([0x00, 0x00, 0xC0, 0x7F])
    v128_rep = bytes([0x05, 0xFD, 0x0C]) + canon_f32_le * 4 + bytes([0x0B])

    counts = {'f32': 0, 'f64': 0, 'v128': 0}

    # Skip v128 — canonical NaN in SIMD lanes causes black screen.
    # v128 denan zeros are safe since SIMD is only used for rendering (not game state).
    for name, pat, rep in [('f32', f32_pat, f32_rep),
                            ('f64', f64_pat, f64_rep)]:
        i = 0
        while i <= len(result) - len(pat):
            if result[i:i+len(pat)] == bytearray(pat):
                result[i:i+len(rep)] = bytearray(rep)
                counts[name] += 1
                i += len(rep)
            else:
                i += 1

    print(f"    Patched {counts['f32']} f32, {counts['f64']} f64, {counts['v128']} v128 denan sites")
    return bytes(result)

if __name__ == "__main__":
    in_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else in_path

    with open(in_path, "rb") as f:
        data = f.read()

    patched = patch_denan(data)

    with open(out_path, "wb") as f:
        f.write(patched)
