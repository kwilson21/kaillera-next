#!/usr/bin/env python3
"""
Audio capture diagnostic injector.

Adds counters and a kn_dump_audio_state export to the bundled mupen64plus
core for the 2026-04-29 silent-iPhone-audio investigation. Idempotent.

Usage:
    python3 build/inject-audio-diag.py <SRC_DIR>

where SRC_DIR is the mupen64plus-libretro-nx checkout (defaults to
build/src/mupen64plus-libretro-nx relative to repo root).
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "build/src/mupen64plus-libretro-nx")

# ---------------------------------------------------------------------------
# main.c: counter globals + kn_dump_audio_state + kn_diag_reset
# ---------------------------------------------------------------------------
MAIN_C = SRC / "mupen64plus-core/src/main/main.c"
MAIN_C_INJECTION = r"""

#ifdef __EMSCRIPTEN__
/* 2026-04-29 silent-iPhone-audio diagnostic. Counters track aiLenChanged
 * invocations, AI DMA scheduling, and capture-skip causes. State dump
 * snapshots AI controller + cp0 event queue at restore stages. Removed
 * once the post-kn-sync audio-silence root cause is fixed. */
volatile uint32_t kn_diag_do_dma_count = 0;
volatile uint32_t kn_diag_ai_end_dma_count = 0;
volatile uint32_t kn_diag_ai_len_changed_count = 0;
volatile uint32_t kn_diag_capture_direct_count = 0;
volatile uint32_t kn_diag_capture_skipped_count = 0;
volatile uint32_t kn_diag_last_game_freq = 0;
volatile uint32_t kn_diag_last_skip_reason = 0;

EMSCRIPTEN_KEEPALIVE void kn_diag_reset_audio_counters(void) {
    kn_diag_do_dma_count = 0;
    kn_diag_ai_end_dma_count = 0;
    kn_diag_ai_len_changed_count = 0;
    kn_diag_capture_direct_count = 0;
    kn_diag_capture_skipped_count = 0;
    kn_diag_last_skip_reason = 0;
}

EMSCRIPTEN_KEEPALIVE void kn_dump_audio_state(uint32_t *out, int max_words) {
    if (!out || max_words < 28) return;
    extern int kn_deterministic_mode;
    extern int kn_audio_sample_count;
    extern int kn_audio_rate;
    extern int kn_skip_audio_output;
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
    print(f"[inject-audio-diag] {MAIN_C}: appended counter globals + kn_dump_audio_state")


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

# Replace early-returns in kn_capture_audio_direct with itemized skip reasons
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

# Increment kn_diag_capture_direct_count whenever capture actually proceeds
AB_CAPTURE_TAIL_OLD = "   kn_audio_sample_count += (int)out_frames;\n}\n"
AB_CAPTURE_TAIL_NEW = """#ifdef __EMSCRIPTEN__
   kn_diag_capture_direct_count++;
#endif
   kn_audio_sample_count += (int)out_frames;
}
"""

# Counter at very top of aiLenChanged, BEFORE byte-swap and BEFORE skip check
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

# Skip counter at the kn_skip_audio_output early-return path
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
    inject_ai_c()
    inject_ab_c()
    print("[inject-audio-diag] complete")


if __name__ == "__main__":
    main()
