#!/usr/bin/env python3
"""Replace kn_sync_read/write v1 with v3 (complete state capture) in main.c."""
import sys

MAIN_C = sys.argv[1] if len(sys.argv) > 1 else "src/mupen64plus-libretro-nx/mupen64plus-core/src/main/main.c"

with open(MAIN_C, 'r') as f:
    lines = f.readlines()

KN_SYNC_READ_V3 = '''EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_read(uint8_t *buf, uint32_t max_size) {
    struct device *dev = &g_dev; uint8_t *p = buf; uint32_t *header; int i; char queue[1024];
    if (!buf || max_size < RDRAM_MAX_SIZE + 32768) return 0;
    header = (uint32_t *)p; header[0] = 0x4B4E5333; header[1] = 3; header[2] = 0; header[3] = 0; p += 16;
    memcpy(p, dev->rdram.dram, RDRAM_MAX_SIZE); p += RDRAM_MAX_SIZE;
    for (i = 0; i < RDRAM_MAX_MODULES_COUNT; i++) { memcpy(p, dev->rdram.regs[i], RDRAM_REGS_COUNT*4); p += RDRAM_REGS_COUNT*4; }
    memcpy(p, r4300_regs(&dev->r4300), 32*8); p += 32*8;
    memcpy(p, r4300_cp0_regs(&dev->r4300.cp0), CP0_REGS_COUNT*4); p += CP0_REGS_COUNT*4;
    { unsigned int ni = *r4300_cp0_next_interrupt(&dev->r4300.cp0); uint32_t cnt = dev->r4300.cp0.regs[CP0_COUNT_REG]; memcpy(p,&ni,4); p+=4; memcpy(p,&cnt,4); p+=4; }
    memcpy(p, r4300_cp1_regs(&dev->r4300.cp1), 32*sizeof(cp1_reg)); p += 32*sizeof(cp1_reg);
    { uint32_t f0=*r4300_cp1_fcr0(&dev->r4300.cp1), f31=*r4300_cp1_fcr31(&dev->r4300.cp1); memcpy(p,&f0,4); p+=4; memcpy(p,&f31,4); p+=4; }
    { unsigned int lb=*r4300_llbit(&dev->r4300); int64_t hi=*r4300_mult_hi(&dev->r4300), lo=*r4300_mult_lo(&dev->r4300); uint32_t pc=*r4300_pc(&dev->r4300); memcpy(p,&lb,4); p+=4; memcpy(p,&hi,8); p+=8; memcpy(p,&lo,8); p+=8; memcpy(p,&pc,4); p+=4; }
    memcpy(p, dev->mi.regs, MI_REGS_COUNT*4); p += MI_REGS_COUNT*4;
    memcpy(p, dev->pi.regs, PI_REGS_COUNT*4); p += PI_REGS_COUNT*4;
    memcpy(p, dev->sp.regs, SP_REGS_COUNT*4); p += SP_REGS_COUNT*4;
    memcpy(p, dev->sp.regs2, SP_REGS2_COUNT*4); p += SP_REGS2_COUNT*4;
    memcpy(p, dev->si.regs, SI_REGS_COUNT*4); p += SI_REGS_COUNT*4;
    { uint8_t sd = dev->si.dma_dir; *p++ = sd; }
    memcpy(p, dev->vi.regs, VI_REGS_COUNT*4); p += VI_REGS_COUNT*4;
    { unsigned int vf=dev->vi.field, vd=dev->vi.delay; uint32_t cps=dev->vi.count_per_scanline; memcpy(p,&vf,4); p+=4; memcpy(p,&vd,4); p+=4; memcpy(p,&cps,4); p+=4; }
    memcpy(p, dev->ri.regs, RI_REGS_COUNT*4); p += RI_REGS_COUNT*4;
    memcpy(p, dev->ai.regs, AI_REGS_COUNT*4); p += AI_REGS_COUNT*4;
    memcpy(p, &dev->ai.fifo[0], sizeof(dev->ai.fifo[0])); p += sizeof(dev->ai.fifo[0]);
    memcpy(p, &dev->ai.fifo[1], sizeof(dev->ai.fifo[1])); p += sizeof(dev->ai.fifo[1]);
    { uint32_t lr=dev->ai.last_read, dc=dev->ai.delayed_carry; memcpy(p,&lr,4); p+=4; memcpy(p,&dc,4); p+=4; }
    memcpy(p, dev->dp.dpc_regs, DPC_REGS_COUNT*4); p += DPC_REGS_COUNT*4;
    memcpy(p, dev->dp.dps_regs, DPS_REGS_COUNT*4); p += DPS_REGS_COUNT*4;
    { uint8_t dof = dev->dp.do_on_unfreeze; *p++ = dof; }
    { uint32_t lw = dev->cart.cart_rom.last_write; memcpy(p,&lw,4); p+=4; }
    for (i=0; i<32; i++) { memcpy(p, &dev->r4300.cp0.tlb.entries[i], sizeof(dev->r4300.cp0.tlb.entries[i])); p += sizeof(dev->r4300.cp0.tlb.entries[i]); }
    save_eventqueue_infos(&dev->r4300.cp0, queue); memcpy(p, queue, sizeof(queue)); p += sizeof(queue);
    memcpy(p, dev->sp.mem, SP_MEM_SIZE); p += SP_MEM_SIZE;
    memcpy(p, dev->pif.ram, PIF_RAM_SIZE); p += PIF_RAM_SIZE;
    for (i = 0; i < PIF_CHANNELS_COUNT; i++) { int8_t off = dev->pif.channels[i].tx ? (int8_t)(dev->pif.channels[i].tx - dev->pif.ram) : -1; *p++ = (uint8_t)off; }
    { int32_t uf = dev->cart.use_flashram; memcpy(p,&uf,4); p+=4; }
    memcpy(p, dev->cart.flashram.page_buf, 128); p += 128;
    memcpy(p, dev->cart.flashram.silicon_id, 8); p += 8;
    { uint32_t fs = dev->cart.flashram.status; memcpy(p,&fs,4); p+=4; }
    { uint16_t ep = dev->cart.flashram.erase_page; memcpy(p,&ep,2); p+=2; }
    { uint8_t fm = dev->cart.flashram.mode; *p++ = fm; }
    { uint8_t sf_rm = (uint8_t)softfloat_roundingMode; uint8_t sf_ef = (uint8_t)softfloat_exceptionFlags; *p++ = sf_rm; *p++ = sf_ef; }
    header[2] = (uint32_t)(p - buf); return (uint32_t)(p - buf);
}
'''

KN_SYNC_WRITE_V3 = '''EMSCRIPTEN_KEEPALIVE int kn_sync_write(const uint8_t *buf, uint32_t size) {
    struct device *dev = &g_dev; const uint8_t *p = buf; const uint32_t *header; int i, version; char queue[1024]; uint32_t pc_val;
    if (!buf || size < 16) return -1;
    header = (const uint32_t *)p;
    if (header[0] == 0x4B4E5333 && header[1] == 3) version = 3;
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
    { unsigned int lb; int64_t hi,lo; memcpy(&lb,p,4); p+=4; memcpy(&hi,p,8); p+=8; memcpy(&lo,p,8); p+=8; memcpy(&pc_val,p,4); p+=4; *r4300_llbit(&dev->r4300)=lb; *r4300_mult_hi(&dev->r4300)=hi; *r4300_mult_lo(&dev->r4300)=lo; }
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
    { uint32_t *cp0 = r4300_cp0_regs(&dev->r4300.cp0); set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]); update_x86_rounding_mode(&dev->r4300.cp1); savestates_load_set_pc(&dev->r4300, pc_val); }
    return 0;
}
'''

new_lines = []
for line in lines:
    if line.strip().startswith('EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_read(uint8_t *buf, uint32_t max_size) {'):
        new_lines.append(KN_SYNC_READ_V3)
        continue
    if line.strip().startswith('EMSCRIPTEN_KEEPALIVE int kn_sync_write(const uint8_t *buf, uint32_t size) {'):
        new_lines.append(KN_SYNC_WRITE_V3)
        continue
    new_lines.append(line)

with open(MAIN_C, 'w') as f:
    f.writelines(new_lines)

print(f"Replaced kn_sync_read/write with v3 in {MAIN_C}")
