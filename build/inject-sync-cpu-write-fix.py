#!/usr/bin/env python3
"""Diagnostic: instrument kn_sync_write_cpu's savestates_load_set_pc call
to check r4300->pc value before/after, and force-fix if it's bogus.

The post-coproc-apply trap was localized to kn_sync_read_cpu phase 2054
(`*r4300_pc(...)` deref) with r4300->pc holding 0x8065c0dc — an N64
address-shaped value past WASM memory.size. This means savestates_load_set_pc
either didn't run cached_interpreter_jump_to's pc-set line, or the pc-set
wrote a bogus value.

Wrap the call with: capture old pc, call set_pc, capture new pc, stash both
in diag globals so JS can see them. Also: if new pc is past the WASM
memory.size by a heuristic (>= 0x80000000), force r4300->pc to
&r4300->interp_PC and put pc_val in interp_PC.addr — a safe fallback that
lets the cached interpreter recompile from RDRAM on next execution.
"""

import sys
import pathlib

ANCHOR_PREFIX = "EMSCRIPTEN_KEEPALIVE int kn_sync_write_cpu(const uint8_t *buf, uint32_t size)"
ORIGINAL_TAIL = (
    "setup_channels_format(&dev->pif); "
    "{ uint32_t *cp0 = r4300_cp0_regs(&dev->r4300.cp0); "
    "set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]); "
    "update_x86_rounding_mode(&dev->r4300.cp1); "
    "savestates_load_set_pc(&dev->r4300, pc_val); "
    "} return 0; }"
)

# Replacement: wrap savestates_load_set_pc with diagnostic + safety fallback.
# All C comments are stripped out and the whole replacement is one Python
# string to avoid Python parsing C syntax inside the literal.
INSTRUMENTED_TAIL = (
    "setup_channels_format(&dev->pif); "
    "{ uint32_t *cp0 = r4300_cp0_regs(&dev->r4300.cp0); "
    "set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]); "
    "update_x86_rounding_mode(&dev->r4300.cp1); "
    "/* SYNC-CPU-WRITE-FIX: clear skip_jump+delay_slot pre-call. */ "
    "dev->r4300.skip_jump = 0; dev->r4300.delay_slot = 0; "
    "{ extern volatile uint32_t kn_diag_rb_serialize_count; "
    "kn_diag_rb_serialize_count = (uint32_t)(uintptr_t)dev->r4300.pc; } "
    "savestates_load_set_pc(&dev->r4300, pc_val); "
    "/* SYNC-CPU-WRITE-FIX: if pc still looks like an N64 address (>= 2GB), "
    "force fallback to interp_PC with the saved N64 addr in .addr. */ "
    "if ((uintptr_t)dev->r4300.pc >= 0x80000000u) { "
    "dev->r4300.interp_PC.addr = pc_val; "
    "dev->r4300.interp_PC.ops = (void(*)(void))0; "
    "dev->r4300.pc = &dev->r4300.interp_PC; "
    "} "
    "} return 0; }"
)

MARKER = "SYNC-CPU-WRITE-FIX"


def main() -> int:
    if len(sys.argv) != 2:
        print("    inject-sync-cpu-write-fix.py: usage: <SRC_DIR>/mupen64plus-libretro-nx", file=sys.stderr)
        return 1
    file_ = pathlib.Path(sys.argv[1]) / "mupen64plus-core" / "src" / "main" / "main.c"
    if not file_.exists():
        print(f"    inject-sync-cpu-write-fix.py: file not found {file_}", file=sys.stderr)
        return 1
    src = file_.read_text()
    if MARKER in src:
        print("    inject-sync-cpu-write-fix.py: already injected, skipping")
        return 0
    if ANCHOR_PREFIX not in src:
        print("    inject-sync-cpu-write-fix.py: anchor not found", file=sys.stderr)
        return 1
    if ORIGINAL_TAIL not in src:
        print("    inject-sync-cpu-write-fix.py: tail-marker not found", file=sys.stderr)
        return 1
    new_src = src.replace(ORIGINAL_TAIL, INSTRUMENTED_TAIL, 1)
    file_.write_text(new_src)
    print("    inject-sync-cpu-write-fix.py: kn_sync_write_cpu fix injected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
