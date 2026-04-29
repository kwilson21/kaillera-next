#!/usr/bin/env python3
"""
Root-cause fix for kn_normalize_event_queue: signed-clamp overdue rels.

The original quantization treats `rel = e->data.count - old_count` as
unsigned. An event scheduled before old_count wraps to a huge uint32, then
quantization re-adds it 3-4 billion cycles in the future (~45s of CPU
time). For AI_INT, that means the AI controller stays BUSY/FULL with no
effective interrupt, audio capture never fires, and the guest is silent.

Fix per codex 2026-04-29:

1. Test the high bit of rel_u (overdue iff bit 31 set, modular half-range).
2. Overdue events: schedule at rel=0 (fire-now) — matches CP0 "cycle_count
   >= 0 => due now" semantic.
3. Per-type quantization only for non-overdue rels.
4. cp0_update_count() at function entry refreshes COUNT_REG so the JS per-
   frame call path no longer relies on stale metadata. No-op on
   kn_post_state_load_cleanup path (last_addr was just set to pc).
5. Explicitly zero *cycle_count and *next_interrupt after clear_queue +
   COUNT_REG = 0 to avoid stale metadata leaking into the first
   add_interrupt_event_count call.

Idempotent: skips if the new signed-clamp body is already present.

Usage: python3 build/inject-normalize-fix.py <SRC_DIR>
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "build/src/mupen64plus-libretro-nx")
MAIN_C = SRC / "mupen64plus-core/src/main/main.c"

# Anchor on the (already diag-wrapped) function body. The diag probe lives
# inside the same single-line function; we replace the QUANTIZATION block
# while preserving the probe blocks.
QUANT_OLD = (
    "saved[n].type = e->data.type; "
    "saved[n].rel = e->data.count - old_count; "
    "if (saved[n].type == AI_INT) { "
    "saved[n].rel = (saved[n].rel + 2048u) & ~4095u; "
    "} else if (saved[n].type == VI_INT || saved[n].type == SI_INT || "
    "saved[n].type == PI_INT || saved[n].type == SP_INT || "
    "saved[n].type == DP_INT || saved[n].type == RSP_DMA_EVT) { "
    "saved[n].rel = (saved[n].rel + 256u) & ~511u; "
    "} "
    "n++; "
)
QUANT_NEW = (
    "saved[n].type = e->data.type; "
    "{ uint32_t rel_u = e->data.count - old_count; "
    "if (rel_u & UINT32_C(0x80000000)) { "
    "/* Modular-overdue (high-bit set): event was scheduled before "
    "old_count. Snap to 0 so it fires immediately on the next dispatch "
    "instead of wrapping ~4B cycles into the future. */ "
    "saved[n].rel = 0; "
    "} else if (saved[n].type == AI_INT) { "
    "saved[n].rel = (rel_u + 2048u) & ~4095u; "
    "} else if (saved[n].type == VI_INT || saved[n].type == SI_INT || "
    "saved[n].type == PI_INT || saved[n].type == SP_INT || "
    "saved[n].type == DP_INT || saved[n].type == RSP_DMA_EVT) { "
    "saved[n].rel = (rel_u + 256u) & ~511u; "
    "} else { "
    "saved[n].rel = rel_u; "
    "} } "
    "n++; "
)

# Refresh COUNT_REG at the top, before reading old_count. We anchor on the
# locals declaration that's the very first statement of the function body.
PREAMBLE_OLD = (
    "EMSCRIPTEN_KEEPALIVE void kn_normalize_event_queue(void) { "
    "/* Quantize timing-sensitive rel offsets so V8/JSC op-boundary drift cannot split menu/CSS RNG. */ "
    "struct cp0 *cp0 = &g_dev.r4300.cp0; uint32_t *cp0_regs = r4300_cp0_regs(cp0); "
)
PREAMBLE_NEW = (
    "EMSCRIPTEN_KEEPALIVE void kn_normalize_event_queue(void) { "
    "/* Quantize timing-sensitive rel offsets so V8/JSC op-boundary drift cannot split menu/CSS RNG. "
    "Refresh COUNT_REG first so overdue detection (signed clamp below) is accurate when called from "
    "the JS per-frame path; no-op on the post-state-load path where last_addr was just refreshed. */ "
    "cp0_update_count(&g_dev.r4300); "
    "struct cp0 *cp0 = &g_dev.r4300.cp0; uint32_t *cp0_regs = r4300_cp0_regs(cp0); "
)

# Zero cycle_count + next_interrupt right after the queue clear, before any
# add_interrupt_event_count call repopulates them.
RESET_META_OLD = "clear_queue(&cp0->q); cp0_regs[CP0_COUNT_REG] = 0; for (i = 0; i < n; i++)"
RESET_META_NEW = (
    "clear_queue(&cp0->q); cp0_regs[CP0_COUNT_REG] = 0; "
    "*r4300_cp0_cycle_count(cp0) = 0; *r4300_cp0_next_interrupt(cp0) = 0; "
    "for (i = 0; i < n; i++)"
)


def apply_normalize_fix() -> None:
    text = MAIN_C.read_text()
    if "rel_u & UINT32_C(0x80000000)" in text:
        print(f"[inject-normalize-fix] {MAIN_C}: signed-clamp already applied")
        return
    if PREAMBLE_OLD not in text:
        raise RuntimeError(f"preamble anchor not found in {MAIN_C}")
    if QUANT_OLD not in text:
        raise RuntimeError(f"quant-block anchor not found in {MAIN_C}")
    if RESET_META_OLD not in text:
        raise RuntimeError(f"reset-meta anchor not found in {MAIN_C}")
    text = text.replace(PREAMBLE_OLD, PREAMBLE_NEW, 1)
    text = text.replace(QUANT_OLD, QUANT_NEW, 1)
    text = text.replace(RESET_META_OLD, RESET_META_NEW, 1)
    MAIN_C.write_text(text)
    print(f"[inject-normalize-fix] {MAIN_C}: applied signed-clamp + cp0_update_count + meta-reset")


# ---------------------------------------------------------------------------
# vi_controller.c: reorder vi_vertical_interrupt_event so VI_INT reschedule
# happens BEFORE new_vi() (which yields to JS via retro_return → co_switch).
# Otherwise JS-driven kn_normalize_event_queue runs while VI handler is
# suspended mid-function with the just-fired VI_INT still in queue and
# overdue — wraps via 512-grid quantization and creates the duplicate
# VI_INT we observed in 6GUS7Z9N. Codex 2026-04-29.
#
# Also replace remove_interrupt_event(cp0) with remove_event(q, VI_INT) —
# defensive against any race that left q.first as something other than
# the VI_INT we sampled.
# ---------------------------------------------------------------------------
VI_C = SRC / "mupen64plus-core/src/device/rcp/vi/vi_controller.c"

VI_HANDLER_OLD = """void vi_vertical_interrupt_event(void* opaque)
{
    struct vi_controller* vi = (struct vi_controller*)opaque;
    if (vi->dp->do_on_unfreeze & DELAY_DP_INT)
        vi->dp->do_on_unfreeze |= DELAY_UPDATESCREEN;
    else
        gfx.updateScreen();

    /* allow main module to do things on VI event */
    new_vi();

    /* toggle vi field if in interlaced mode */
    vi->field ^= (vi->regs[VI_STATUS_REG] >> 6) & 0x1;

    /* schedule next vertical interrupt */
    if(CountPerScanlineOverride) {
        if (vi->regs[VI_V_SYNC_REG] == 0)
            vi->delay = 500000;
        else
            vi->delay = (vi->regs[VI_V_SYNC_REG] + 1) * vi->count_per_scanline;
    }

    uint32_t next_vi = *get_event(&vi->mi->r4300->cp0.q, VI_INT) + vi->delay;
    remove_interrupt_event(&vi->mi->r4300->cp0);
    add_interrupt_event_count(&vi->mi->r4300->cp0, VI_INT, next_vi);

    /* trigger interrupt */
    raise_rcp_interrupt(vi->mi, MI_INTR_VI);
}"""

VI_HANDLER_NEW = """void vi_vertical_interrupt_event(void* opaque)
{
    struct vi_controller* vi = (struct vi_controller*)opaque;
    if (vi->dp->do_on_unfreeze & DELAY_DP_INT)
        vi->dp->do_on_unfreeze |= DELAY_UPDATESCREEN;
    else
        gfx.updateScreen();

    /* 2026-04-29: schedule next vertical interrupt BEFORE new_vi(), because
     * new_vi() calls retro_return() which co_switches back to JS while the
     * handler is suspended. JS's per-frame kn_normalize_event_queue() must
     * see a consistent queue (no overdue VI_INT still sitting at q.first)
     * to avoid wrapping it via the 512-grid unsigned quantization. */
    if(CountPerScanlineOverride) {
        if (vi->regs[VI_V_SYNC_REG] == 0)
            vi->delay = 500000;
        else
            vi->delay = (vi->regs[VI_V_SYNC_REG] + 1) * vi->count_per_scanline;
    }

    {
        uint32_t *cur_vi = get_event(&vi->mi->r4300->cp0.q, VI_INT);
        if (cur_vi != NULL) {
            uint32_t next_vi = *cur_vi + vi->delay;
            /* Use remove_event(VI_INT) instead of remove_interrupt_event() to
             * remove the VI_INT we just sampled — defensive against any
             * pre-yield path that may have left q.first as a non-VI event. */
            remove_event(&vi->mi->r4300->cp0.q, VI_INT);
            add_interrupt_event_count(&vi->mi->r4300->cp0, VI_INT, next_vi);
        }
#ifdef __EMSCRIPTEN__
        else {
            extern volatile uint32_t kn_diag_vi_handler_no_event;
            kn_diag_vi_handler_no_event++;
        }
#endif
    }

    /* allow main module to do things on VI event (yields to JS via
     * retro_return). At this point the queue is already consistent. */
    new_vi();

    /* toggle vi field if in interlaced mode (preserved post-new_vi) */
    vi->field ^= (vi->regs[VI_STATUS_REG] >> 6) & 0x1;

    /* trigger interrupt */
    raise_rcp_interrupt(vi->mi, MI_INTR_VI);
}"""

def apply_vi_handler_reorder() -> None:
    text = VI_C.read_text()
    if "schedule next vertical interrupt BEFORE new_vi()" in text:
        print(f"[inject-normalize-fix] {VI_C}: VI handler reorder already applied")
        return
    if VI_HANDLER_OLD not in text:
        raise RuntimeError(f"vi_vertical_interrupt_event anchor not found in {VI_C}")
    text = text.replace(VI_HANDLER_OLD, VI_HANDLER_NEW, 1)
    VI_C.write_text(text)
    print(f"[inject-normalize-fix] {VI_C}: reordered VI handler (reschedule before new_vi) + remove_event(VI_INT)")


def apply() -> None:
    apply_normalize_fix()
    apply_vi_handler_reorder()


if __name__ == "__main__":
    apply()
