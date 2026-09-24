#!/usr/bin/env python3
"""Post-process wasm-opt --denan output to use canonical NaN instead of 0.0.

The --denan pass creates helper functions that replace NaN with 0. We patch
those helpers to use canonical NaN instead, preserving isnan() semantics.

Patterns in WASM binary (else branch of the denan if/else):
  f32:  05 43 00000000 0B              → 05 43 0000C07F 0B
  f64:  05 44 0000000000000000 0B      → 05 44 000000000000F87F 0B
  v128: 05 FD0C 00*16 0B              → 05 2000 01*16 0B (return input)

v128 values are not float-only: the compiler also uses them for inlined
integer copies (struct assignments, fixed-size memcpy) and integer SIMD.
Any lane holding a negative int32 or a 0xffffffff word reads as an f32 NaN,
so the stock helper zeroed that data and canonical NaN would clobber it
(the "black screen" noted below). The v128 helper is patched to return its
input unchanged. Floats that can reach game state go through SoftFloat, and
GLideN64 is compiled without SIMD, so no v128 float NaN needs canonicalizing.
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

    counts = {'f32': 0, 'f64': 0, 'v128': 0}

    # v128 — the single denan helper is `(func (param v128) (result v128)
    # (if (result v128) <all four f32 lanes == themselves> (then local.get 0)
    # (else v128.const 0)))`. Replace its else branch with `local.get 0` plus
    # 16 nops (same byte length), so the helper is the identity. Match it by
    # its lane-check prefix so no other `else v128.const 0` is touched, and
    # fail the build if it is not found exactly once.
    lane_check = bytes([0x20, 0x00, 0xFD, 0x1F, 0x00, 0x20, 0x00, 0xFD, 0x1F, 0x00, 0x5B])
    v128_identity = bytes([0x05, 0x20, 0x00] + [0x01] * 16 + [0x0B])
    hits = []
    i = result.find(lane_check)
    while i >= 0:
        j = result.find(v128_pat, i, i + 96)
        if j >= 0:
            hits.append(j)
        i = result.find(lane_check, i + 1)
    if len(hits) != 1:
        raise SystemExit(f"fix-denan.py: expected 1 v128 denan helper, found {len(hits)}")
    result[hits[0]:hits[0] + len(v128_identity)] = v128_identity
    counts['v128'] = 1

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
