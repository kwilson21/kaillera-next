#!/usr/bin/env python3
"""Bisect `kn_sync_read_cpu` with rb_log probes BEFORE each memcpy.

Goal: pinpoint which sub-call inside kn_sync_read_cpu OOBs after a
worker-coproc apply. The function lives on a single line in main.c so
we replace the whole line. Idempotent — checks for marker before patching.

Remove this file (and its build.sh hook) once root cause is found.
"""

import sys
import pathlib

ORIGINAL_PREFIX = (
    "EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_read_cpu(uint8_t *buf, uint32_t max_size)"
)
MARKER = "/* SYNC-CPU-PROBES-INJECTED */"


# The replacement function body. Uses rb_log declared with a forward
# decl since kn_rollback.c provides it as static. Since kn_rollback.c
# and main.c link together, we need a public extern that delegates.
# We can just emit our own pp_log via printf to stderr (Emscripten
# routes to console.error). But rb_log writes to a buffer JS reads,
# which is what we want. So we need to expose rb_log.
#
# Actually rb_log is `static` in kn_rollback.c. That means it can't
# be called from main.c. We need a non-static wrapper.
#
# Alternative: use kn_rb_set_diag_phase via the existing probe API.
# That's `extern volatile uint32_t kn_diag_rb_phase` which is set by
# KN_RB_PROBE in kn_rollback.c. Let me write directly to it from
# main.c — it's accessible as `extern volatile`.
INSTRUMENTED = """EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_read_cpu(uint8_t *buf, uint32_t max_size) {
""" + MARKER + """
    extern volatile uint32_t kn_diag_rb_phase;
    extern volatile int32_t  kn_diag_rb_save_slot;
    extern volatile uint32_t kn_diag_rb_serialize_count;
    struct device *dev = &g_dev;
    uint8_t *p = buf;
    int i;
    char queue[1024];
    if (!buf || max_size < 8192) return 0;
    /* Stash r4300->pc raw value at entry — distinguishes "pc was already
     * bad when read_cpu was called" from "pc was set bad by something
     * inside read_cpu". */
    kn_diag_rb_serialize_count = (uint32_t)(uintptr_t)dev->r4300.pc;
    kn_diag_rb_phase = 200; memcpy(p, r4300_regs(&dev->r4300), 32*8); p += 32*8;
    kn_diag_rb_phase = 201; memcpy(p, r4300_cp0_regs(&dev->r4300.cp0), CP0_REGS_COUNT*4); p += CP0_REGS_COUNT*4;
    kn_diag_rb_phase = 202; { unsigned int ni = *r4300_cp0_next_interrupt(&dev->r4300.cp0); uint32_t cnt = dev->r4300.cp0.regs[CP0_COUNT_REG]; memcpy(p,&ni,4); p+=4; memcpy(p,&cnt,4); p+=4; }
    kn_diag_rb_phase = 203; memcpy(p, r4300_cp1_regs(&dev->r4300.cp1), 32*sizeof(cp1_reg)); p += 32*sizeof(cp1_reg);
    kn_diag_rb_phase = 204; { uint32_t f0=*r4300_cp1_fcr0(&dev->r4300.cp1), f31=*r4300_cp1_fcr31(&dev->r4300.cp1); memcpy(p,&f0,4); p+=4; memcpy(p,&f31,4); p+=4; }
    /* Phase 205 split into sub-phases. r4300->pc is a precomp_instr*
     * pointer; if savestates_load_set_pc / cached_interpreter_jump_to
     * left it pointing into a freed/uninitialized block, *r4300_pc()
     * (which derefs r4300->pc->addr) traps. Stash the raw pc pointer
     * value into kn_diag_rb_save_slot so the JS catch handler can
     * confirm the address looks bogus. */
    {
      kn_diag_rb_phase = 2050;
      unsigned int lb = *r4300_llbit(&dev->r4300);
      kn_diag_rb_phase = 2051;
      int64_t hi = *r4300_mult_hi(&dev->r4300);
      kn_diag_rb_phase = 2052;
      int64_t lo = *r4300_mult_lo(&dev->r4300);
      kn_diag_rb_phase = 2053;
      uint32_t *_kn_pc_ptr = r4300_pc(&dev->r4300);
      kn_diag_rb_save_slot = (int32_t)(uintptr_t)_kn_pc_ptr;
      kn_diag_rb_phase = 2054;
      uint32_t pc = *_kn_pc_ptr;
      kn_diag_rb_phase = 2055;
      memcpy(p,&lb,4); p+=4;
      kn_diag_rb_phase = 2056;
      memcpy(p,&hi,8); p+=8;
      kn_diag_rb_phase = 2057;
      memcpy(p,&lo,8); p+=8;
      kn_diag_rb_phase = 2058;
      memcpy(p,&pc,4); p+=4;
    }
    kn_diag_rb_phase = 206; { unsigned int vf=dev->vi.field, vd=dev->vi.delay; memcpy(p,&vf,4); p+=4; memcpy(p,&vd,4); p+=4; }
    kn_diag_rb_phase = 207; for (i=0; i<32; i++) { kn_diag_rb_save_slot = i; memcpy(p, &dev->r4300.cp0.tlb.entries[i], sizeof(dev->r4300.cp0.tlb.entries[i])); p += sizeof(dev->r4300.cp0.tlb.entries[i]); }
    kn_diag_rb_phase = 208; save_eventqueue_infos(&dev->r4300.cp0, queue);
    kn_diag_rb_phase = 209; memcpy(p, queue, sizeof(queue)); p += sizeof(queue);
    kn_diag_rb_phase = 210; memcpy(p, dev->sp.mem, SP_MEM_SIZE); p += SP_MEM_SIZE;
    kn_diag_rb_phase = 211; memcpy(p, dev->pif.ram, PIF_RAM_SIZE); p += PIF_RAM_SIZE;
    kn_diag_rb_phase = 212; { uint8_t sf_rm = (uint8_t)softfloat_roundingMode; uint8_t sf_ef = (uint8_t)softfloat_exceptionFlags; *p++ = sf_rm; *p++ = sf_ef; }
    kn_diag_rb_phase = 213; memcpy(p, dev->ai.regs, sizeof(dev->ai.regs)); p += sizeof(dev->ai.regs);
    kn_diag_rb_phase = 214; memcpy(p, dev->ai.fifo, sizeof(dev->ai.fifo)); p += sizeof(dev->ai.fifo);
    kn_diag_rb_phase = 215; { uint32_t ai_sfc = dev->ai.samples_format_changed; uint32_t ai_lr = dev->ai.last_read; uint32_t ai_dc = dev->ai.delayed_carry; memcpy(p,&ai_sfc,4); p+=4; memcpy(p,&ai_lr,4); p+=4; memcpy(p,&ai_dc,4); p+=4; }
    kn_diag_rb_phase = 216; memcpy(p, dev->mi.regs, sizeof(dev->mi.regs)); p += sizeof(dev->mi.regs);
    kn_diag_rb_phase = 217; memcpy(p, dev->si.regs, sizeof(dev->si.regs)); p += sizeof(dev->si.regs);
    kn_diag_rb_phase = 218; { uint8_t si_dir = dev->si.dma_dir; uint32_t si_dur = dev->si.dma_duration; *p++ = si_dir; memcpy(p,&si_dur,4); p+=4; }
    kn_diag_rb_phase = 219; memcpy(p, dev->pi.regs, sizeof(dev->pi.regs)); p += sizeof(dev->pi.regs);
    kn_diag_rb_phase = 220; memcpy(p, dev->sp.regs, sizeof(dev->sp.regs)); p += sizeof(dev->sp.regs);
    kn_diag_rb_phase = 221; memcpy(p, dev->sp.regs2, sizeof(dev->sp.regs2)); p += sizeof(dev->sp.regs2);
    kn_diag_rb_phase = 222; { uint32_t sp_lock = dev->sp.rsp_task_locked; memcpy(p,&sp_lock,4); p+=4; }
    kn_diag_rb_phase = 223; memcpy(p, dev->dp.dpc_regs, sizeof(dev->dp.dpc_regs)); p += sizeof(dev->dp.dpc_regs);
    kn_diag_rb_phase = 224; memcpy(p, dev->dp.dps_regs, sizeof(dev->dp.dps_regs)); p += sizeof(dev->dp.dps_regs);
    kn_diag_rb_phase = 225; { uint8_t dp_unf = dev->dp.do_on_unfreeze; *p++ = dp_unf; }
    kn_diag_rb_phase = 226;
    /* Diagnostic: verify r4300->pc is a sane host pointer before returning.
     * If it's an N64-virtual-address-shaped value (high bit set, looks like
     * 0x80...), kn_sync_write_cpu's savestates_load_set_pc (called via
     * rb_restore_slot_state on rollback) failed to update r4300->pc and
     * left it as the saved .addr field. Stash the suspect value so JS
     * can diagnose. The trap-recovery path will treat this as fatal. */
    return (uint32_t)(p - buf);
}"""


def main() -> int:
    if len(sys.argv) != 2:
        print("    inject-sync-cpu-probes.py: usage: <SRC_DIR>/mupen64plus-libretro-nx", file=sys.stderr)
        return 1
    file_ = pathlib.Path(sys.argv[1]) / "mupen64plus-core" / "src" / "main" / "main.c"
    if not file_.exists():
        print(f"    inject-sync-cpu-probes.py: file not found {file_}", file=sys.stderr)
        return 1
    src = file_.read_text()
    if MARKER in src:
        print("    inject-sync-cpu-probes.py: already injected, skipping")
        return 0
    if ORIGINAL_PREFIX not in src:
        print("    inject-sync-cpu-probes.py: anchor not found", file=sys.stderr)
        return 1
    # Find the existing kn_sync_read_cpu line and replace it whole.
    start = src.find(ORIGINAL_PREFIX)
    # The function ends with "return (uint32_t)(p - buf); }"
    end_marker = "return (uint32_t)(p - buf); }"
    end = src.find(end_marker, start)
    if end < 0:
        print("    inject-sync-cpu-probes.py: end-marker not found", file=sys.stderr)
        return 1
    end += len(end_marker)
    new_src = src[:start] + INSTRUMENTED + src[end:]
    file_.write_text(new_src)
    print("    inject-sync-cpu-probes.py: kn_sync_read_cpu probes injected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
