#!/usr/bin/env python3
"""Inject kn_sync_write OOB-throw localization probes into main.c.

Replaces the kn_sync_write body with an instrumented version that updates
two volatile globals (kn_diag_ksw_section, kn_diag_ksw_offset) at every
major section boundary. JS reads these in the catch handler to pinpoint
which memcpy/struct-call inside kn_sync_write threw the WASM RuntimeError.

Idempotent — runs after mupen64plus-kn-all.patch and audio-diag injection.
Remove this script (and its build.sh hook) once the OOB root cause is found.
"""

import sys
import pathlib

ORIGINAL = """EMSCRIPTEN_KEEPALIVE int kn_sync_write(const uint8_t *buf, uint32_t size) {
    struct device *dev = &g_dev; const uint8_t *p = buf; const uint32_t *header; int i, version; char queue[1024]; uint32_t pc_val, delay_slot = 0, skip_jump = 0;
    if (!buf || size < 16) return -1;
    header = (const uint32_t *)p;
    if (header[0] == 0x4B4E5334 && header[1] == 4) version = 4;
    else if (header[0] == 0x4B4E5333 && header[1] == 3) version = 3;
    else if (header[0] == 0x4B4E5331 && header[1] == 1) version = 1;
    else return -1;
    p += 16;
    memcpy(dev->rdram.dram, p, RDRAM_MAX_SIZE); p += RDRAM_MAX_SIZE;
    if (version >= 3) { for (i = 0; i < RDRAM_MAX_MODULES_COUNT; i++) { memcpy(dev->rdram.regs[i], p, RDRAM_REGS_COUNT*4); p += RDRAM_REGS_COUNT*4; } }
    memcpy(r4300_regs(&dev->r4300), p, 32*8); p += 32*8;
    memcpy(r4300_cp0_regs(&dev->r4300.cp0), p, CP0_REGS_COUNT*4); p += CP0_REGS_COUNT*4;
    { unsigned int ni; uint32_t cnt; memcpy(&ni,p,4); p+=4; memcpy(&cnt,p,4); p+=4; *r4300_cp0_next_interrupt(&dev->r4300.cp0)=ni; dev->r4300.cp0.regs[CP0_COUNT_REG]=cnt; }
    memcpy(r4300_cp1_regs(&dev->r4300.cp1), p, 32*sizeof(cp1_reg)); p += 32*sizeof(cp1_reg);
    { uint32_t f0,f31; memcpy(&f0,p,4); p+=4; memcpy(&f31,p,4); p+=4; *r4300_cp1_fcr0(&dev->r4300.cp1)=f0; *r4300_cp1_fcr31(&dev->r4300.cp1)=f31; }
    { unsigned int lb; int64_t hi,lo; memcpy(&lb,p,4); p+=4; memcpy(&hi,p,8); p+=8; memcpy(&lo,p,8); p+=8; memcpy(&pc_val,p,4); p+=4; if (version >= 4) { memcpy(&delay_slot,p,4); p+=4; memcpy(&skip_jump,p,4); p+=4; } *r4300_llbit(&dev->r4300)=lb; *r4300_mult_hi(&dev->r4300)=hi; *r4300_mult_lo(&dev->r4300)=lo; }
    if (version >= 3) {
        memcpy(dev->mi.regs, p, MI_REGS_COUNT*4); p += MI_REGS_COUNT*4;
        memcpy(dev->pi.regs, p, PI_REGS_COUNT*4); p += PI_REGS_COUNT*4;
        memcpy(dev->sp.regs, p, SP_REGS_COUNT*4); p += SP_REGS_COUNT*4;
        memcpy(dev->sp.regs2, p, SP_REGS2_COUNT*4); p += SP_REGS2_COUNT*4;
        memcpy(dev->si.regs, p, SI_REGS_COUNT*4); p += SI_REGS_COUNT*4;
        { dev->si.dma_dir = *p++; }
        memcpy(dev->vi.regs, p, VI_REGS_COUNT*4); p += VI_REGS_COUNT*4;
        { unsigned int vf,vd; uint32_t cps; memcpy(&vf,p,4); p+=4; memcpy(&vd,p,4); p+=4; memcpy(&cps,p,4); p+=4; dev->vi.field=vf; dev->vi.delay=vd; dev->vi.count_per_scanline=cps; }
        memcpy(dev->ri.regs, p, RI_REGS_COUNT*4); p += RI_REGS_COUNT*4;
        memcpy(dev->ai.regs, p, AI_REGS_COUNT*4); p += AI_REGS_COUNT*4;
        memcpy(&dev->ai.fifo[0], p, sizeof(dev->ai.fifo[0])); p += sizeof(dev->ai.fifo[0]);
        memcpy(&dev->ai.fifo[1], p, sizeof(dev->ai.fifo[1])); p += sizeof(dev->ai.fifo[1]);
        { uint32_t lr,dc; memcpy(&lr,p,4); p+=4; memcpy(&dc,p,4); p+=4; dev->ai.last_read=lr; dev->ai.delayed_carry=dc; }
        dev->ai.samples_format_changed = 1;
        memcpy(dev->dp.dpc_regs, p, DPC_REGS_COUNT*4); p += DPC_REGS_COUNT*4;
        memcpy(dev->dp.dps_regs, p, DPS_REGS_COUNT*4); p += DPS_REGS_COUNT*4;
        { dev->dp.do_on_unfreeze = *p++; }
        { uint32_t lw; memcpy(&lw,p,4); p+=4; dev->cart.cart_rom.last_write=lw; }
    } else {
        unsigned int vf,vd; memcpy(&vf,p,4); p+=4; memcpy(&vd,p,4); p+=4; dev->vi.field=vf; dev->vi.delay=vd;
    }
    memset(dev->r4300.cp0.tlb.LUT_r, 0, 0x400000); memset(dev->r4300.cp0.tlb.LUT_w, 0, 0x400000);
    for (i=0; i<32; i++) { memcpy(&dev->r4300.cp0.tlb.entries[i], p, sizeof(dev->r4300.cp0.tlb.entries[i])); p += sizeof(dev->r4300.cp0.tlb.entries[i]); tlb_map(&dev->r4300.cp0.tlb, i); }
    memcpy(queue, p, sizeof(queue)); p += sizeof(queue); load_eventqueue_infos(&dev->r4300.cp0, queue);
    memcpy(dev->sp.mem, p, SP_MEM_SIZE); p += SP_MEM_SIZE;
    memcpy(dev->pif.ram, p, PIF_RAM_SIZE); p += PIF_RAM_SIZE;
    if (version >= 3) {
        for (i = 0; i < PIF_CHANNELS_COUNT; i++) { int8_t off = (int8_t)*p++; if (off >= 0) setup_pif_channel(&dev->pif.channels[i], dev->pif.ram + off); else disable_pif_channel(&dev->pif.channels[i]); }
        { int32_t uf; memcpy(&uf,p,4); p+=4; dev->cart.use_flashram=uf; }
        memcpy(dev->cart.flashram.page_buf, p, 128); p += 128;
        memcpy(dev->cart.flashram.silicon_id, p, 8); p += 8;
        { uint32_t fs; memcpy(&fs,p,4); p+=4; dev->cart.flashram.status=fs; }
        { uint16_t ep; memcpy(&ep,p,2); p+=2; dev->cart.flashram.erase_page=ep; }
        { dev->cart.flashram.mode = *p++; }
    }
    if (p + 2 <= buf + size) { softfloat_roundingMode = *p++; softfloat_exceptionFlags = *p++; }
    setup_channels_format(&dev->pif);
    { uint32_t *cp0 = r4300_cp0_regs(&dev->r4300.cp0); set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]); update_x86_rounding_mode(&dev->r4300.cp1); savestates_load_set_pc(&dev->r4300, pc_val); dev->r4300.delay_slot = delay_slot; dev->r4300.skip_jump = skip_jump; }
    /* Match savestates_load_m64p cleanup. Importing host RDRAM/CPU state
     * without invalidating cached interpreter blocks can execute stale local
     * code after startup sync; stale interrupt-unsafe bookkeeping can also
     * strand Smash Remix in its yellow thread-error screen. */
    dev->sp.rsp_task_locked = 0;
    dev->r4300.cp0.interrupt_unsafe_state = 0;
    *r4300_cp0_last_addr(&dev->r4300.cp0) = *r4300_pc(&dev->r4300);
    { extern void invalidate_cached_code_hacktarux(struct r4300_core* r4300, uint32_t address, size_t size); invalidate_cached_code_hacktarux(&dev->r4300, 0, 0); }
    return 0;
}"""

INSTRUMENTED = """/* kn_sync_write OOB-throw localization probes (diagnostic).
 * Updated at each major section boundary so JS reads the last reached
 * point after a WASM RuntimeError. Remove once root cause is found. */
volatile uint32_t kn_diag_ksw_section = 0;
volatile uint32_t kn_diag_ksw_offset = 0;
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_ksw_section(void) { return kn_diag_ksw_section; }
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_ksw_offset(void) { return kn_diag_ksw_offset; }
#define KSW_PROBE(n) (kn_diag_ksw_section = (uint32_t)(n), kn_diag_ksw_offset = (uint32_t)(p - buf))
EMSCRIPTEN_KEEPALIVE int kn_sync_write(const uint8_t *buf, uint32_t size) {
    struct device *dev = &g_dev; const uint8_t *p = buf; const uint32_t *header; int i, version; char queue[1024]; uint32_t pc_val, delay_slot = 0, skip_jump = 0;
    KSW_PROBE(0);
    if (!buf || size < 16) return -1;
    header = (const uint32_t *)p;
    if (header[0] == 0x4B4E5334 && header[1] == 4) version = 4;
    else if (header[0] == 0x4B4E5333 && header[1] == 3) version = 3;
    else if (header[0] == 0x4B4E5331 && header[1] == 1) version = 1;
    else return -1;
    p += 16; KSW_PROBE(1);
    memcpy(dev->rdram.dram, p, RDRAM_MAX_SIZE); p += RDRAM_MAX_SIZE; KSW_PROBE(2);
    if (version >= 3) { for (i = 0; i < RDRAM_MAX_MODULES_COUNT; i++) { memcpy(dev->rdram.regs[i], p, RDRAM_REGS_COUNT*4); p += RDRAM_REGS_COUNT*4; } } KSW_PROBE(3);
    memcpy(r4300_regs(&dev->r4300), p, 32*8); p += 32*8; KSW_PROBE(4);
    memcpy(r4300_cp0_regs(&dev->r4300.cp0), p, CP0_REGS_COUNT*4); p += CP0_REGS_COUNT*4; KSW_PROBE(5);
    { unsigned int ni; uint32_t cnt; memcpy(&ni,p,4); p+=4; memcpy(&cnt,p,4); p+=4; *r4300_cp0_next_interrupt(&dev->r4300.cp0)=ni; dev->r4300.cp0.regs[CP0_COUNT_REG]=cnt; } KSW_PROBE(6);
    memcpy(r4300_cp1_regs(&dev->r4300.cp1), p, 32*sizeof(cp1_reg)); p += 32*sizeof(cp1_reg); KSW_PROBE(7);
    { uint32_t f0,f31; memcpy(&f0,p,4); p+=4; memcpy(&f31,p,4); p+=4; *r4300_cp1_fcr0(&dev->r4300.cp1)=f0; *r4300_cp1_fcr31(&dev->r4300.cp1)=f31; } KSW_PROBE(8);
    { unsigned int lb; int64_t hi,lo; memcpy(&lb,p,4); p+=4; memcpy(&hi,p,8); p+=8; memcpy(&lo,p,8); p+=8; memcpy(&pc_val,p,4); p+=4; if (version >= 4) { memcpy(&delay_slot,p,4); p+=4; memcpy(&skip_jump,p,4); p+=4; } *r4300_llbit(&dev->r4300)=lb; *r4300_mult_hi(&dev->r4300)=hi; *r4300_mult_lo(&dev->r4300)=lo; } KSW_PROBE(9);
    if (version >= 3) {
        memcpy(dev->mi.regs, p, MI_REGS_COUNT*4); p += MI_REGS_COUNT*4; KSW_PROBE(10);
        memcpy(dev->pi.regs, p, PI_REGS_COUNT*4); p += PI_REGS_COUNT*4; KSW_PROBE(11);
        memcpy(dev->sp.regs, p, SP_REGS_COUNT*4); p += SP_REGS_COUNT*4; KSW_PROBE(12);
        memcpy(dev->sp.regs2, p, SP_REGS2_COUNT*4); p += SP_REGS2_COUNT*4; KSW_PROBE(13);
        memcpy(dev->si.regs, p, SI_REGS_COUNT*4); p += SI_REGS_COUNT*4; KSW_PROBE(14);
        { dev->si.dma_dir = *p++; } KSW_PROBE(15);
        memcpy(dev->vi.regs, p, VI_REGS_COUNT*4); p += VI_REGS_COUNT*4; KSW_PROBE(16);
        { unsigned int vf,vd; uint32_t cps; memcpy(&vf,p,4); p+=4; memcpy(&vd,p,4); p+=4; memcpy(&cps,p,4); p+=4; dev->vi.field=vf; dev->vi.delay=vd; dev->vi.count_per_scanline=cps; } KSW_PROBE(17);
        memcpy(dev->ri.regs, p, RI_REGS_COUNT*4); p += RI_REGS_COUNT*4; KSW_PROBE(18);
        memcpy(dev->ai.regs, p, AI_REGS_COUNT*4); p += AI_REGS_COUNT*4; KSW_PROBE(19);
        memcpy(&dev->ai.fifo[0], p, sizeof(dev->ai.fifo[0])); p += sizeof(dev->ai.fifo[0]); KSW_PROBE(20);
        memcpy(&dev->ai.fifo[1], p, sizeof(dev->ai.fifo[1])); p += sizeof(dev->ai.fifo[1]); KSW_PROBE(21);
        { uint32_t lr,dc; memcpy(&lr,p,4); p+=4; memcpy(&dc,p,4); p+=4; dev->ai.last_read=lr; dev->ai.delayed_carry=dc; } KSW_PROBE(22);
        dev->ai.samples_format_changed = 1;
        memcpy(dev->dp.dpc_regs, p, DPC_REGS_COUNT*4); p += DPC_REGS_COUNT*4; KSW_PROBE(23);
        memcpy(dev->dp.dps_regs, p, DPS_REGS_COUNT*4); p += DPS_REGS_COUNT*4; KSW_PROBE(24);
        { dev->dp.do_on_unfreeze = *p++; } KSW_PROBE(25);
        { uint32_t lw; memcpy(&lw,p,4); p+=4; dev->cart.cart_rom.last_write=lw; } KSW_PROBE(26);
    } else {
        unsigned int vf,vd; memcpy(&vf,p,4); p+=4; memcpy(&vd,p,4); p+=4; dev->vi.field=vf; dev->vi.delay=vd; KSW_PROBE(27);
    }
    memset(dev->r4300.cp0.tlb.LUT_r, 0, 0x400000); memset(dev->r4300.cp0.tlb.LUT_w, 0, 0x400000); KSW_PROBE(30);
    for (i=0; i<32; i++) { memcpy(&dev->r4300.cp0.tlb.entries[i], p, sizeof(dev->r4300.cp0.tlb.entries[i])); p += sizeof(dev->r4300.cp0.tlb.entries[i]); KSW_PROBE(40+i); tlb_map(&dev->r4300.cp0.tlb, i); KSW_PROBE(80+i); }
    memcpy(queue, p, sizeof(queue)); p += sizeof(queue); KSW_PROBE(120); load_eventqueue_infos(&dev->r4300.cp0, queue); KSW_PROBE(121);
    memcpy(dev->sp.mem, p, SP_MEM_SIZE); p += SP_MEM_SIZE; KSW_PROBE(122);
    memcpy(dev->pif.ram, p, PIF_RAM_SIZE); p += PIF_RAM_SIZE; KSW_PROBE(123);
    if (version >= 3) {
        for (i = 0; i < PIF_CHANNELS_COUNT; i++) { int8_t off = (int8_t)*p++; if (off >= 0) setup_pif_channel(&dev->pif.channels[i], dev->pif.ram + off); else disable_pif_channel(&dev->pif.channels[i]); KSW_PROBE(130+i); }
        { int32_t uf; memcpy(&uf,p,4); p+=4; dev->cart.use_flashram=uf; } KSW_PROBE(140);
        memcpy(dev->cart.flashram.page_buf, p, 128); p += 128; KSW_PROBE(141);
        memcpy(dev->cart.flashram.silicon_id, p, 8); p += 8; KSW_PROBE(142);
        { uint32_t fs; memcpy(&fs,p,4); p+=4; dev->cart.flashram.status=fs; } KSW_PROBE(143);
        { uint16_t ep; memcpy(&ep,p,2); p+=2; dev->cart.flashram.erase_page=ep; } KSW_PROBE(144);
        { dev->cart.flashram.mode = *p++; } KSW_PROBE(145);
    }
    if (p + 2 <= buf + size) { softfloat_roundingMode = *p++; softfloat_exceptionFlags = *p++; } KSW_PROBE(150);
    setup_channels_format(&dev->pif); KSW_PROBE(151);
    { uint32_t *cp0 = r4300_cp0_regs(&dev->r4300.cp0); set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]); update_x86_rounding_mode(&dev->r4300.cp1); savestates_load_set_pc(&dev->r4300, pc_val); dev->r4300.delay_slot = delay_slot; dev->r4300.skip_jump = skip_jump; } KSW_PROBE(152);
    /* Match savestates_load_m64p cleanup. Importing host RDRAM/CPU state
     * without invalidating cached interpreter blocks can execute stale local
     * code after startup sync; stale interrupt-unsafe bookkeeping can also
     * strand Smash Remix in its yellow thread-error screen. */
    dev->sp.rsp_task_locked = 0;
    dev->r4300.cp0.interrupt_unsafe_state = 0;
    *r4300_cp0_last_addr(&dev->r4300.cp0) = *r4300_pc(&dev->r4300);
    KSW_PROBE(153);
    { extern void invalidate_cached_code_hacktarux(struct r4300_core* r4300, uint32_t address, size_t size); invalidate_cached_code_hacktarux(&dev->r4300, 0, 0); }
    KSW_PROBE(154);
    return 0;
}
#undef KSW_PROBE"""


def main():
    if len(sys.argv) != 2:
        print("usage: inject-ksw-probes.py <mupen64plus-libretro-nx-dir>", file=sys.stderr)
        sys.exit(1)
    main_c = pathlib.Path(sys.argv[1]) / "mupen64plus-core" / "src" / "main" / "main.c"
    text = main_c.read_text()
    if "kn_diag_ksw_section" in text:
        print("    inject-ksw-probes.py: already injected, skipping")
        return
    if ORIGINAL not in text:
        print("    inject-ksw-probes.py: kn_sync_write body did not match expected baseline", file=sys.stderr)
        sys.exit(1)
    main_c.write_text(text.replace(ORIGINAL, INSTRUMENTED, 1))
    print("    inject-ksw-probes.py: injected kn_sync_write probes")


if __name__ == "__main__":
    main()
