#!/usr/bin/env python3
"""
Audio capture diagnostic injector.

Adds counters, a kn_dump_audio_state export, AI-invariant violation probes,
and an alloc-failure counter to the bundled mupen64plus core for the
2026-04-29 silent-iPhone-audio investigation. Idempotent.

Usage:
    python3 build/inject-audio-diag.py <SRC_DIR>
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "build/src/mupen64plus-libretro-nx")

# ---------------------------------------------------------------------------
# main.c: counter globals + kn_dump_audio_state + invariant probe
# ---------------------------------------------------------------------------
MAIN_C = SRC / "mupen64plus-core/src/main/main.c"
MAIN_C_INJECTION = r"""

#ifdef __EMSCRIPTEN__
/* 2026-04-29 silent-iPhone-audio diagnostic. Counters track aiLenChanged
 * invocations, AI DMA scheduling, capture-skip causes, and the AI invariant
 * "AI_STATUS_BUSY set ⇒ AI_INT scheduled". The state dump snapshots AI
 * controller + cp0 event queue at restore stages. Removed once the
 * post-kn-sync audio-silence root cause is fixed. */
volatile uint32_t kn_diag_do_dma_count = 0;
volatile uint32_t kn_diag_ai_end_dma_count = 0;
volatile uint32_t kn_diag_ai_len_changed_count = 0;
volatile uint32_t kn_diag_capture_direct_count = 0;
volatile uint32_t kn_diag_capture_skipped_count = 0;
volatile uint32_t kn_diag_last_game_freq = 0;
volatile uint32_t kn_diag_last_skip_reason = 0;

/* Invariant probe state. */
volatile uint32_t kn_diag_normalize_calls = 0;
volatile uint32_t kn_diag_alloc_fail_count = 0;
volatile uint32_t kn_diag_busy_no_int_pre_normalize = 0;
volatile uint32_t kn_diag_busy_no_int_post_normalize = 0;
volatile uint32_t kn_diag_busy_no_int_post_step = 0;
volatile uint32_t kn_diag_busy_no_int_post_kn_sync_write = 0;
volatile uint32_t kn_diag_busy_no_int_post_cleanup = 0;
volatile int32_t  kn_diag_last_ai_signed_rel_pre_normalize = 0;
volatile int32_t  kn_diag_last_ai_signed_rel_post_normalize = 0;
volatile uint32_t kn_diag_last_ai_count_pre_normalize = 0;
volatile uint32_t kn_diag_last_ai_count_post_normalize = 0;
volatile int      kn_diag_first_violation_captured = 0;
volatile uint32_t kn_diag_first_violation_location = 0;
volatile uint32_t kn_diag_first_violation_status = 0;
volatile uint32_t kn_diag_first_violation_count_reg = 0;
volatile uint32_t kn_diag_first_violation_dma = 0;
volatile uint32_t kn_diag_first_violation_eod = 0;
volatile uint32_t kn_diag_first_violation_normalize_calls = 0;

/* VI_INT-specific probe state (codex 2026-04-29: VI handler suspends mid-
 * function via retro_return → co_switch; track duplicates and signed rels
 * of the first two VI_INTs in queue to confirm the overdue+future pattern. */
volatile uint32_t kn_diag_vi_handler_no_event = 0;
volatile uint32_t kn_diag_vi_int_count_pre_normalize = 0;
volatile uint32_t kn_diag_vi_int_count_post_normalize = 0;
volatile int32_t  kn_diag_vi_first_signed_rel = 0;
volatile int32_t  kn_diag_vi_second_signed_rel = 0;

EMSCRIPTEN_KEEPALIVE void kn_diag_reset_audio_counters(void) {
    kn_diag_do_dma_count = 0;
    kn_diag_ai_end_dma_count = 0;
    kn_diag_ai_len_changed_count = 0;
    kn_diag_capture_direct_count = 0;
    kn_diag_capture_skipped_count = 0;
    kn_diag_last_skip_reason = 0;
    kn_diag_normalize_calls = 0;
    kn_diag_alloc_fail_count = 0;
    kn_diag_busy_no_int_pre_normalize = 0;
    kn_diag_busy_no_int_post_normalize = 0;
    kn_diag_busy_no_int_post_step = 0;
    kn_diag_busy_no_int_post_kn_sync_write = 0;
    kn_diag_busy_no_int_post_cleanup = 0;
    kn_diag_first_violation_captured = 0;
    kn_diag_vi_handler_no_event = 0;
}

/* Returns 1 if AI_STATUS_BUSY is set but no AI_INT is in the cp0 event
 * queue — i.e., the AI controller invariant is violated. Increments the
 * per-location counter and (one-shot) captures a snapshot of counters/regs
 * at the first violation seen. AI_STATUS_BUSY (0x40000000) is hardcoded
 * here because the macro is local to ai_controller.c. */
EMSCRIPTEN_KEEPALIVE int kn_diag_check_invariant(int location_id) {
    if (!(g_dev.ai.regs[AI_STATUS_REG] & UINT32_C(0x40000000))) return 0;
    extern unsigned int* get_event(const struct interrupt_queue* q, int type);
    if (get_event(&g_dev.r4300.cp0.q, AI_INT) != NULL) return 0;

    switch (location_id) {
        case 1: kn_diag_busy_no_int_pre_normalize++; break;
        case 2: kn_diag_busy_no_int_post_normalize++; break;
        case 3: kn_diag_busy_no_int_post_step++; break;
        case 4: kn_diag_busy_no_int_post_kn_sync_write++; break;
        case 5: kn_diag_busy_no_int_post_cleanup++; break;
        default: break;
    }

    if (!kn_diag_first_violation_captured) {
        kn_diag_first_violation_captured = 1;
        kn_diag_first_violation_location = (uint32_t)location_id;
        kn_diag_first_violation_status = g_dev.ai.regs[AI_STATUS_REG];
        kn_diag_first_violation_count_reg = r4300_cp0_regs(&g_dev.r4300.cp0)[CP0_COUNT_REG];
        kn_diag_first_violation_dma = kn_diag_do_dma_count;
        kn_diag_first_violation_eod = kn_diag_ai_end_dma_count;
        kn_diag_first_violation_normalize_calls = kn_diag_normalize_calls;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE void kn_dump_audio_state(uint32_t *out, int max_words) {
    if (!out || max_words < 56) return;
    extern int kn_deterministic_mode;
    extern int kn_audio_sample_count;
    extern int kn_audio_rate;
    extern int kn_skip_audio_output;
    /* Live count of VI_INT events in queue and their first two signed rels —
     * sampled at dump time. Pre-normalize counters are updated by the
     * normalize-entry probe; this captures the live snapshot. */
    {
        struct cp0 *_kdcp = &g_dev.r4300.cp0;
        uint32_t _kdcnt = r4300_cp0_regs(_kdcp)[CP0_COUNT_REG];
        int _vi_n = 0;
        kn_diag_vi_first_signed_rel = 0;
        kn_diag_vi_second_signed_rel = 0;
        for (struct node *_e = _kdcp->q.first; _e != NULL; _e = _e->next) {
            if (_e->data.type != VI_INT) continue;
            int32_t _rel = (int32_t)(_e->data.count - _kdcnt);
            if (_vi_n == 0) kn_diag_vi_first_signed_rel = _rel;
            else if (_vi_n == 1) kn_diag_vi_second_signed_rel = _rel;
            _vi_n++;
        }
    }
    int i = 0;
    out[i++] = g_dev.ai.regs[AI_STATUS_REG];
    out[i++] = g_dev.ai.regs[AI_LEN_REG];
    out[i++] = g_dev.ai.regs[AI_DRAM_ADDR_REG];
    out[i++] = g_dev.ai.regs[AI_DACRATE_REG];
    out[i++] = (uint32_t)g_dev.ai.fifo[0].address;
    out[i++] = (uint32_t)g_dev.ai.fifo[0].length;
    out[i++] = (uint32_t)g_dev.ai.fifo[0].duration;
    out[i++] = (uint32_t)g_dev.ai.fifo[1].address;
    out[i++] = (uint32_t)g_dev.ai.fifo[1].length;
    out[i++] = (uint32_t)g_dev.ai.fifo[1].duration;
    out[i++] = (uint32_t)g_dev.ai.last_read;
    out[i++] = g_dev.ai.delayed_carry;
    out[i++] = (uint32_t)g_dev.ai.samples_format_changed;
    {
        uint32_t *cp0_regs = r4300_cp0_regs(&g_dev.r4300.cp0);
        out[i++] = cp0_regs[CP0_COUNT_REG];
        out[i++] = *r4300_cp0_next_interrupt(&g_dev.r4300.cp0);
        out[i++] = (uint32_t)*r4300_cp0_cycle_count(&g_dev.r4300.cp0);
        out[i++] = cp0_regs[CP0_COMPARE_REG];
    }
    out[i++] = (uint32_t)kn_deterministic_mode;
    out[i++] = (uint32_t)kn_skip_audio_output;
    out[i++] = (uint32_t)kn_audio_sample_count;
    out[i++] = (uint32_t)kn_audio_rate;
    out[i++] = kn_diag_last_game_freq;
    out[i++] = kn_diag_last_skip_reason;
    out[i++] = kn_diag_do_dma_count;
    out[i++] = kn_diag_ai_end_dma_count;
    out[i++] = kn_diag_ai_len_changed_count;
    out[i++] = kn_diag_capture_direct_count;
    out[i++] = kn_diag_capture_skipped_count;
    /* Invariant-probe block (16 words). */
    out[i++] = kn_diag_normalize_calls;
    out[i++] = kn_diag_alloc_fail_count;
    out[i++] = kn_diag_busy_no_int_pre_normalize;
    out[i++] = kn_diag_busy_no_int_post_normalize;
    out[i++] = kn_diag_busy_no_int_post_step;
    out[i++] = kn_diag_busy_no_int_post_kn_sync_write;
    out[i++] = kn_diag_busy_no_int_post_cleanup;
    out[i++] = (uint32_t)kn_diag_last_ai_signed_rel_pre_normalize;
    out[i++] = (uint32_t)kn_diag_last_ai_signed_rel_post_normalize;
    out[i++] = kn_diag_last_ai_count_pre_normalize;
    out[i++] = kn_diag_last_ai_count_post_normalize;
    out[i++] = kn_diag_first_violation_location;
    out[i++] = kn_diag_first_violation_status;
    out[i++] = kn_diag_first_violation_count_reg;
    out[i++] = kn_diag_first_violation_dma;
    out[i++] = kn_diag_first_violation_eod;
    /* VI register block (12 words) — codex 2026-04-29 to confirm vi->delay
     * isn't 0 in post-restore state and to expose the duplicate-VI_INT
     * pattern via first-two signed rels. */
    out[i++] = g_dev.vi.regs[VI_V_SYNC_REG];
    out[i++] = g_dev.vi.regs[VI_V_INTR_REG];
    out[i++] = g_dev.vi.regs[VI_STATUS_REG];
    out[i++] = (uint32_t)g_dev.vi.delay;
    out[i++] = (uint32_t)g_dev.vi.count_per_scanline;
    out[i++] = (uint32_t)g_dev.vi.field;
    out[i++] = kn_diag_vi_handler_no_event;
    out[i++] = kn_diag_vi_int_count_pre_normalize;
    out[i++] = kn_diag_vi_int_count_post_normalize;
    out[i++] = (uint32_t)kn_diag_vi_first_signed_rel;
    out[i++] = (uint32_t)kn_diag_vi_second_signed_rel;
    out[i++] = 0; /* reserved */
    /* Event queue. */
    if (i + 1 > max_words) return;
    int evt_count_idx = i;
    out[i++] = 0;
    int evt_count = 0;
    {
        struct cp0 *cp0_q = &g_dev.r4300.cp0;
        uint32_t cnt = r4300_cp0_regs(cp0_q)[CP0_COUNT_REG];
        for (struct node *e = cp0_q->q.first; e != NULL; e = e->next) {
            if (i + 2 > max_words) break;
            out[i++] = (uint32_t)e->data.type;
            out[i++] = (uint32_t)(e->data.count - cnt);
            evt_count++;
        }
    }
    out[evt_count_idx] = (uint32_t)evt_count;
}
#endif
"""

def inject_main_c() -> None:
    text = MAIN_C.read_text()
    if "kn_dump_audio_state" in text:
        print(f"[inject-audio-diag] {MAIN_C}: already injected, skipping")
        return
    MAIN_C.write_text(text + MAIN_C_INJECTION)
    print(f"[inject-audio-diag] {MAIN_C}: appended counter globals + kn_dump_audio_state + invariant probe")


# ---------------------------------------------------------------------------
# main.c: wrap kn_normalize_event_queue with pre/post invariant probe.
# Existing function is on a single very long line; we inject probe blocks
# right after the opening brace and right before the closing one.
# ---------------------------------------------------------------------------
NORMALIZE_PRE_OLD = (
    "EMSCRIPTEN_KEEPALIVE void kn_normalize_event_queue(void) { "
    "/* Quantize timing-sensitive rel offsets so V8/JSC op-boundary drift cannot split menu/CSS RNG. */ "
    "struct cp0 *cp0 = &g_dev.r4300.cp0; uint32_t *cp0_regs = r4300_cp0_regs(cp0); "
)
NORMALIZE_PRE_NEW = (
    NORMALIZE_PRE_OLD
    + "{ extern volatile uint32_t kn_diag_normalize_calls; "
      "extern volatile int32_t kn_diag_last_ai_signed_rel_pre_normalize; "
      "extern volatile uint32_t kn_diag_last_ai_count_pre_normalize; "
      "extern volatile uint32_t kn_diag_vi_int_count_pre_normalize; "
      "extern int kn_diag_check_invariant(int); "
      "kn_diag_normalize_calls++; "
      "kn_diag_check_invariant(1); "
      "{ uint32_t _kdc = cp0_regs[CP0_COUNT_REG]; "
      "int _ai_seen = 0; uint32_t _vi_n = 0; "
      "for (struct node *_e = cp0->q.first; _e != NULL; _e = _e->next) { "
      "if (_e->data.type == VI_INT) _vi_n++; "
      "if (_e->data.type == AI_INT && !_ai_seen) { "
      "kn_diag_last_ai_signed_rel_pre_normalize = (int32_t)(_e->data.count - _kdc); "
      "kn_diag_last_ai_count_pre_normalize = _e->data.count; "
      "_ai_seen = 1; } } "
      "kn_diag_vi_int_count_pre_normalize = _vi_n; } } "
)

NORMALIZE_POST_OLD = "cp0->last_addr = *r4300_pc(&g_dev.r4300); }"
NORMALIZE_POST_NEW = (
    "cp0->last_addr = *r4300_pc(&g_dev.r4300); "
    "{ extern volatile int32_t kn_diag_last_ai_signed_rel_post_normalize; "
    "extern volatile uint32_t kn_diag_last_ai_count_post_normalize; "
    "extern volatile uint32_t kn_diag_vi_int_count_post_normalize; "
    "extern int kn_diag_check_invariant(int); "
    "{ uint32_t _kdc = cp0_regs[CP0_COUNT_REG]; "
    "int _ai_seen = 0; uint32_t _vi_n = 0; "
    "kn_diag_last_ai_signed_rel_post_normalize = 0; "
    "kn_diag_last_ai_count_post_normalize = 0; "
    "for (struct node *_e = cp0->q.first; _e != NULL; _e = _e->next) { "
    "if (_e->data.type == VI_INT) _vi_n++; "
    "if (_e->data.type == AI_INT && !_ai_seen) { "
    "kn_diag_last_ai_signed_rel_post_normalize = (int32_t)(_e->data.count - _kdc); "
    "kn_diag_last_ai_count_post_normalize = _e->data.count; "
    "_ai_seen = 1; } } "
    "kn_diag_vi_int_count_post_normalize = _vi_n; } "
    "kn_diag_check_invariant(2); } }"
)

def inject_normalize_probe() -> None:
    text = MAIN_C.read_text()
    if "kn_diag_last_ai_signed_rel_pre_normalize = (int32_t)" in text:
        print(f"[inject-audio-diag] {MAIN_C}: kn_normalize_event_queue probe already injected")
        return
    if NORMALIZE_PRE_OLD not in text:
        raise RuntimeError(f"normalize PRE anchor not found in {MAIN_C}")
    if NORMALIZE_POST_OLD not in text:
        raise RuntimeError(f"normalize POST anchor not found in {MAIN_C}")
    text = text.replace(NORMALIZE_PRE_OLD, NORMALIZE_PRE_NEW, 1)
    text = text.replace(NORMALIZE_POST_OLD, NORMALIZE_POST_NEW, 1)
    MAIN_C.write_text(text)
    print(f"[inject-audio-diag] {MAIN_C}: wrapped kn_normalize_event_queue with invariant probes")


# ---------------------------------------------------------------------------
# ai_controller.c: externs + counter increments
# ---------------------------------------------------------------------------
AI_C = SRC / "mupen64plus-core/src/device/rcp/ai/ai_controller.c"
AI_INCLUDE_ANCHOR = '#include "device/rdram/rdram.h"\n'
AI_EXTERNS = """
#ifdef __EMSCRIPTEN__
extern volatile uint32_t kn_diag_do_dma_count;
extern volatile uint32_t kn_diag_ai_end_dma_count;
#endif
"""
AI_DO_DMA_OLD = "static void do_dma(struct ai_controller* ai, struct ai_dma* dma)\n{\n"
AI_DO_DMA_NEW = AI_DO_DMA_OLD + "#ifdef __EMSCRIPTEN__\n    kn_diag_do_dma_count++;\n#endif\n"
AI_END_OLD = "void ai_end_of_dma_event(void* opaque)\n{\n"
AI_END_NEW = AI_END_OLD + "#ifdef __EMSCRIPTEN__\n    kn_diag_ai_end_dma_count++;\n#endif\n"

def inject_ai_c() -> None:
    text = AI_C.read_text()
    if "kn_diag_do_dma_count" in text:
        print(f"[inject-audio-diag] {AI_C}: already injected, skipping")
        return
    if AI_INCLUDE_ANCHOR not in text:
        raise RuntimeError(f"include anchor not found in {AI_C}")
    text = text.replace(AI_INCLUDE_ANCHOR, AI_INCLUDE_ANCHOR + AI_EXTERNS, 1)
    if AI_DO_DMA_OLD not in text:
        raise RuntimeError(f"do_dma anchor not found in {AI_C}")
    text = text.replace(AI_DO_DMA_OLD, AI_DO_DMA_NEW, 1)
    if AI_END_OLD not in text:
        raise RuntimeError(f"ai_end_of_dma_event anchor not found in {AI_C}")
    text = text.replace(AI_END_OLD, AI_END_NEW, 1)
    AI_C.write_text(text)
    print(f"[inject-audio-diag] {AI_C}: injected counters")


# ---------------------------------------------------------------------------
# interrupt.c: count alloc_node failures inside add_interrupt_event_count
# ---------------------------------------------------------------------------
INTERRUPT_C = SRC / "mupen64plus-core/src/device/r4300/interrupt.c"
INTERRUPT_OLD = """    event = alloc_node(&cp0->q.pool);
    if (event == NULL)
    {
        DebugMessage(M64MSG_ERROR, "Failed to allocate node for new interrupt event");
        return;
    }"""
INTERRUPT_NEW = """    event = alloc_node(&cp0->q.pool);
    if (event == NULL)
    {
#ifdef __EMSCRIPTEN__
        extern volatile uint32_t kn_diag_alloc_fail_count;
        kn_diag_alloc_fail_count++;
#endif
        DebugMessage(M64MSG_ERROR, "Failed to allocate node for new interrupt event");
        return;
    }"""

def inject_interrupt_c() -> None:
    text = INTERRUPT_C.read_text()
    if "kn_diag_alloc_fail_count" in text:
        print(f"[inject-audio-diag] {INTERRUPT_C}: already injected, skipping")
        return
    if INTERRUPT_OLD not in text:
        raise RuntimeError(f"alloc-fail anchor not found in {INTERRUPT_C}")
    text = text.replace(INTERRUPT_OLD, INTERRUPT_NEW, 1)
    INTERRUPT_C.write_text(text)
    print(f"[inject-audio-diag] {INTERRUPT_C}: injected alloc-fail counter")


# ---------------------------------------------------------------------------
# audio_backend_libretro.c: externs + counter increments + skip-path
# ---------------------------------------------------------------------------
AB_C = SRC / "custom/mupen64plus-core/plugin/audio_libretro/audio_backend_libretro.c"
AB_EXTERN_ANCHOR = "int kn_skip_audio_output = 0;\n"
AB_EXTERNS = """
#ifdef __EMSCRIPTEN__
extern volatile uint32_t kn_diag_ai_len_changed_count;
extern volatile uint32_t kn_diag_capture_direct_count;
extern volatile uint32_t kn_diag_capture_skipped_count;
extern volatile uint32_t kn_diag_last_game_freq;
extern volatile uint32_t kn_diag_last_skip_reason;
#endif
"""

AB_CAPTURE_OLD = """   if (!kn_deterministic_mode || !raw_data || frames == 0 || GameFreq <= 0)
      return;

   kn_audio_rate = OUTPUT_RATE;
   space = 48000 - kn_audio_sample_count;
   if (space <= 0)
      return;
"""
AB_CAPTURE_NEW = """#ifdef __EMSCRIPTEN__
   if (!kn_deterministic_mode) { kn_diag_last_skip_reason |= 0x02u; kn_diag_capture_skipped_count++; return; }
   if (!raw_data)              { kn_diag_last_skip_reason |= 0x04u; kn_diag_capture_skipped_count++; return; }
   if (frames == 0)            { kn_diag_last_skip_reason |= 0x08u; kn_diag_capture_skipped_count++; return; }
   if (GameFreq <= 0)          { kn_diag_last_skip_reason |= 0x10u; kn_diag_capture_skipped_count++; return; }
#else
   if (!kn_deterministic_mode || !raw_data || frames == 0 || GameFreq <= 0)
      return;
#endif

   kn_audio_rate = OUTPUT_RATE;
   space = 48000 - kn_audio_sample_count;
   if (space <= 0)
   {
#ifdef __EMSCRIPTEN__
      kn_diag_last_skip_reason |= 0x20u; kn_diag_capture_skipped_count++;
#endif
      return;
   }
"""

AB_CAPTURE_TAIL_OLD = "   kn_audio_sample_count += (int)out_frames;\n}\n"
AB_CAPTURE_TAIL_NEW = """#ifdef __EMSCRIPTEN__
   kn_diag_capture_direct_count++;
#endif
   kn_audio_sample_count += (int)out_frames;
}
"""

AB_AILEN_OLD = """static void aiLenChanged(void* user_data, const void* buffer, size_t size)
{
   uint32_t i;
   int16_t *out      = NULL;
   int16_t *raw_data = (int16_t*)buffer;
   size_t frames     = size / 4;
   uint8_t *p        = (uint8_t*)buffer;
"""
AB_AILEN_NEW = AB_AILEN_OLD + """
#ifdef __EMSCRIPTEN__
   kn_diag_ai_len_changed_count++;
   kn_diag_last_game_freq = (uint32_t)GameFreq;
#endif
"""

AB_SKIP_OLD = """   if (kn_skip_audio_output) {
      return;
   }"""
AB_SKIP_NEW = """   if (kn_skip_audio_output) {
#ifdef __EMSCRIPTEN__
      kn_diag_last_skip_reason |= 0x01u;
      kn_diag_capture_skipped_count++;
#endif
      return;
   }"""

def inject_ab_c() -> None:
    text = AB_C.read_text()
    if "kn_diag_ai_len_changed_count" in text:
        print(f"[inject-audio-diag] {AB_C}: already injected, skipping")
        return
    for old, new, label in [
        (AB_EXTERN_ANCHOR, AB_EXTERN_ANCHOR + AB_EXTERNS, "externs"),
        (AB_CAPTURE_OLD, AB_CAPTURE_NEW, "kn_capture_audio_direct skip-paths"),
        (AB_CAPTURE_TAIL_OLD, AB_CAPTURE_TAIL_NEW, "kn_capture_audio_direct success counter"),
        (AB_AILEN_OLD, AB_AILEN_NEW, "aiLenChanged top counter"),
        (AB_SKIP_OLD, AB_SKIP_NEW, "kn_skip_audio_output return path"),
    ]:
        if old not in text:
            raise RuntimeError(f"anchor missing for {label} in {AB_C}")
        text = text.replace(old, new, 1)
    AB_C.write_text(text)
    print(f"[inject-audio-diag] {AB_C}: injected counters + skip-path instrumentation")


def main() -> None:
    inject_main_c()
    inject_normalize_probe()
    inject_ai_c()
    inject_interrupt_c()
    inject_ab_c()
    print("[inject-audio-diag] complete")


if __name__ == "__main__":
    main()
