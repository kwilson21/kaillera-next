#!/usr/bin/env python3
"""Inject rollback-engine localization probes into kn_rollback.c.

Captures the rollback engine's most recent action (phase ID, frame, ring
slot, serialize/unserialize counters) into volatile globals so JS can dump
the values in its STEP-THREW handler. The cached-interpreter `unreachable`
/ `table index out of bounds` traps in stepOneFrame don't unwind through C,
so we need a snapshot of "what did the rollback engine just do" written to
memory the JS catch handler can read after the throw.

Phase IDs:
   10 = kn_pre_tick entry
   20 = endpoint_save BEFORE retro_serialize
   21 = endpoint_save AFTER retro_serialize
   30 = pacing_skip_save BEFORE
   31 = pacing_skip_save AFTER
   40 = rollback retro_unserialize BEFORE
   41 = rollback retro_unserialize AFTER
   50 = replay_save BEFORE
   51 = replay_save AFTER
   60 = normal_save BEFORE
   61 = normal_save AFTER
   70 = kn_pre_tick EXIT (normal return 0)
   71 = kn_pre_tick EXIT (replay return 2)
   72 = kn_pre_tick EXIT (pacing skip return 3)
   80 = kn_post_tick entry
   81 = kn_post_tick exit
  100 = inside rb_save_slot, BEFORE retro_serialize
  101 = inside rb_save_slot, AFTER retro_serialize

Idempotent — runs after mupen64plus-kn-all.patch. Remove this script and
its build.sh hook once the OOB root cause is found.
"""

import sys
import pathlib

# ---------------------------------------------------------------------------
# Globals + getters block. Inserted right after the retro_run forward decl
# at the top of kn_rollback.c so all code below has the macro available.
# ---------------------------------------------------------------------------
GLOBALS_ANCHOR = "extern void emscripten_mainloop(void);"

GLOBALS_INSERT = """extern void emscripten_mainloop(void);

/* Forward declaration for rb_log — used by inject-rb-probes.py probes
 * that fire BEFORE rb_log's static definition later in the file. */
static void rb_log(const char *fmt, ...);

/* ── Rollback-engine OOB-throw localization probes (diagnostic) ───────
 * Updated at every save/restore boundary so JS reads the last reached
 * point after a WASM RuntimeError in stepOneFrame. The cached-interpreter
 * trap doesn't unwind through C, so we leave breadcrumbs in volatile
 * globals. JS captures these in its STEP-THREW catch handler.
 * Remove this block (and inject-rb-probes.py) once root cause is found. */
volatile uint32_t kn_diag_rb_phase = 0;
volatile uint32_t kn_diag_rb_frame = 0;
volatile int32_t  kn_diag_rb_save_slot = -1;
volatile uint32_t kn_diag_rb_serialize_count = 0;
volatile int32_t  kn_diag_rb_serialize_ret = 0;
volatile uint32_t kn_diag_rb_unserialize_count = 0;
volatile int32_t  kn_diag_rb_unserialize_frame = -1;
volatile int32_t  kn_diag_rb_unserialize_ret = 0;
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_rb_phase(void)              { return kn_diag_rb_phase; }
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_rb_frame(void)              { return kn_diag_rb_frame; }
EMSCRIPTEN_KEEPALIVE int32_t  kn_get_diag_rb_save_slot(void)          { return kn_diag_rb_save_slot; }
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_rb_serialize_count(void)    { return kn_diag_rb_serialize_count; }
EMSCRIPTEN_KEEPALIVE int32_t  kn_get_diag_rb_serialize_ret(void)      { return kn_diag_rb_serialize_ret; }
EMSCRIPTEN_KEEPALIVE uint32_t kn_get_diag_rb_unserialize_count(void)  { return kn_diag_rb_unserialize_count; }
EMSCRIPTEN_KEEPALIVE int32_t  kn_get_diag_rb_unserialize_frame(void)  { return kn_diag_rb_unserialize_frame; }
EMSCRIPTEN_KEEPALIVE int32_t  kn_get_diag_rb_unserialize_ret(void)    { return kn_diag_rb_unserialize_ret; }
#endif
#define KN_RB_PROBE(p) (kn_diag_rb_phase = (uint32_t)(p), kn_diag_rb_frame = (uint32_t)rb.frame)
#define KN_RB_PROBE_SLOT(p, idx) (kn_diag_rb_save_slot = (int32_t)(idx), KN_RB_PROBE(p))
"""

# ---------------------------------------------------------------------------
# rb_save_slot — wrap retro_serialize with PRE/POST probes + counter.
# ---------------------------------------------------------------------------
SAVE_SLOT_ORIGINAL = """static int rb_save_slot(int idx, int frame, int mark_last) {
    if (!retro_serialize(rb.ring_bufs[idx], rb.state_size)) return 0;
    rb.ring_sf_state[idx] = sf_pack();"""

SAVE_SLOT_INSTRUMENTED = """static int rb_save_slot(int idx, int frame, int mark_last) {
    KN_RB_PROBE_SLOT(100, idx);
    int _ksz_ret = retro_serialize(rb.ring_bufs[idx], rb.state_size) ? 1 : 0;
    kn_diag_rb_serialize_count++;
    kn_diag_rb_serialize_ret = _ksz_ret;
    KN_RB_PROBE_SLOT(101, idx);
    if (!_ksz_ret) return 0;
    rb.ring_sf_state[idx] = sf_pack();"""

SAVE_SLOT_SPLIT_ORIGINAL = """static int rb_save_slot(int idx, int frame, int mark_last) {
    if (rb_using_split_state()) {
        uint32_t cpu_size;
        if (!rb_ensure_rdram_base() || !rb.ring_rdram_bufs || !rb.ring_cpu_bufs ||
            !rb.ring_cpu_sizes || !rb.ring_rdram_bufs[idx] || !rb.ring_cpu_bufs[idx]) {
            rb.split_save_failures++;
            return 0;
        }
        memcpy(rb.ring_rdram_bufs[idx], rb.rdram_base, rb.split_rdram_size);
        cpu_size = kn_sync_read_cpu(rb.ring_cpu_bufs[idx], rb.split_cpu_capacity);
        if (cpu_size == 0 || cpu_size > rb.split_cpu_capacity) {
            rb.split_save_failures++;
            return 0;
        }
        rb.ring_cpu_sizes[idx] = cpu_size;
        rb.split_last_cpu_size = cpu_size;
        rb.split_save_count++;
    } else if (!retro_serialize(rb.ring_bufs[idx], rb.state_size)) {
        return 0;
    }
    rb.ring_sf_state[idx] = sf_pack();"""

SAVE_SLOT_SPLIT_INSTRUMENTED = """static int rb_save_slot(int idx, int frame, int mark_last) {
    KN_RB_PROBE_SLOT(100, idx);
    rb_log("RBSV-ENTRY idx=%d frame=%d split=%d", idx, frame, rb_using_split_state());
    if (rb_using_split_state()) {
        uint32_t cpu_size;
        if (!rb_ensure_rdram_base() || !rb.ring_rdram_bufs || !rb.ring_cpu_bufs ||
            !rb.ring_cpu_sizes || !rb.ring_rdram_bufs[idx] || !rb.ring_cpu_bufs[idx]) {
            rb.split_save_failures++;
            kn_diag_rb_serialize_count++;
            kn_diag_rb_serialize_ret = 0;
            KN_RB_PROBE_SLOT(101, idx);
            rb_log("RBSV-NULL-PTR idx=%d", idx);
            return 0;
        }
        rb_log("RBSV-PRE-RDRAM-COPY idx=%d size=%u", idx, (unsigned)rb.split_rdram_size);
        memcpy(rb.ring_rdram_bufs[idx], rb.rdram_base, rb.split_rdram_size);
        rb_log("RBSV-PRE-READ-CPU idx=%d", idx);
        cpu_size = kn_sync_read_cpu(rb.ring_cpu_bufs[idx], rb.split_cpu_capacity);
        rb_log("RBSV-POST-READ-CPU idx=%d size=%u", idx, (unsigned)cpu_size);
        if (cpu_size == 0 || cpu_size > rb.split_cpu_capacity) {
            rb.split_save_failures++;
            kn_diag_rb_serialize_count++;
            kn_diag_rb_serialize_ret = 0;
            KN_RB_PROBE_SLOT(101, idx);
            return 0;
        }
        rb.ring_cpu_sizes[idx] = cpu_size;
        rb.split_last_cpu_size = cpu_size;
        rb.split_save_count++;
        kn_diag_rb_serialize_ret = 1;
    } else {
        int _ksz_ret = retro_serialize(rb.ring_bufs[idx], rb.state_size) ? 1 : 0;
        kn_diag_rb_serialize_ret = _ksz_ret;
        if (!_ksz_ret) {
            kn_diag_rb_serialize_count++;
            KN_RB_PROBE_SLOT(101, idx);
            return 0;
        }
    }
    kn_diag_rb_serialize_count++;
    KN_RB_PROBE_SLOT(101, idx);
    rb_log("RBSV-PRE-SF idx=%d", idx);
    rb.ring_sf_state[idx] = sf_pack();"""

# ---------------------------------------------------------------------------
# Per-call-site probe wrappers in kn_pre_tick. The replacements include the
# original line plus surrounding context so each substitution is unique.
# ---------------------------------------------------------------------------
PROBE_PATCHES = [
    # kn_pre_tick entry probe — right after the !rb.initialized guard.
    (
        "int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy, int frame_adv) {\n"
        "    int s, idx, apply_frame;\n"
        "    if (!rb.initialized) return -1;\n"
        "\n"
        "    if (rb.endpoint_save_pending && rb.replay_remaining == 0) {\n"
        "        int endpoint_idx = rb.frame % rb.ring_size;\n"
        "        rb_save_slot(endpoint_idx, rb.frame, 1);\n",

        "int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy, int frame_adv) {\n"
        "    int s, idx, apply_frame;\n"
        "    if (!rb.initialized) return -1;\n"
        "    KN_RB_PROBE(10);\n"
        "\n"
        "    if (rb.endpoint_save_pending && rb.replay_remaining == 0) {\n"
        "        int endpoint_idx = rb.frame % rb.ring_size;\n"
        "        KN_RB_PROBE_SLOT(20, endpoint_idx);\n"
        "        rb_save_slot(endpoint_idx, rb.frame, 1);\n"
        "        KN_RB_PROBE_SLOT(21, endpoint_idx);\n",
    ),
    # Pacing-skip ring-needs-save (line 881).
    (
        "        if (ring_needs_save) {\n"
        "            int save_idx = rb.frame % rb.ring_size;\n"
        "            rb_save_slot(save_idx, rb.frame, 1);\n"
        "        }\n"
        "        return 3; /* ring maintained, skip frame advance */\n"
        "    }\n",

        "        if (ring_needs_save) {\n"
        "            int save_idx = rb.frame % rb.ring_size;\n"
        "            KN_RB_PROBE_SLOT(30, save_idx);\n"
        "            rb_save_slot(save_idx, rb.frame, 1);\n"
        "            KN_RB_PROBE_SLOT(31, save_idx);\n"
        "        }\n"
        "        KN_RB_PROBE(72);\n"
        "        return 3; /* ring maintained, skip frame advance */\n"
        "    }\n",
    ),
    # Rollback restore — state-backend restore wrapper.
    (
        "            if (rb.rdram_base && rb.saved_rdram)\n"
        "                memcpy(rb.saved_rdram, rb.rdram_base, 0x800000);\n"
        "\n"
        "            if (!rb_restore_slot_state(ring_idx)) {\n"
        "                rb.failed_rollbacks++;\n"
        "                rb_log(\"RESTORE-FAILED f=%d ring[%d]=%d depth=%d backend=%d (failed_rollbacks=%d)\",\n"
        "                    rb_frame, ring_idx, rb.ring_frames[ring_idx], depth,\n"
        "                    rb.state_backend, rb.failed_rollbacks);\n"
        "                return 0;\n"
        "            }\n",

        "            if (rb.rdram_base && rb.saved_rdram)\n"
        "                memcpy(rb.saved_rdram, rb.rdram_base, 0x800000);\n"
        "\n"
        "            KN_RB_PROBE_SLOT(40, ring_idx);\n"
        "            kn_diag_rb_unserialize_count++;\n"
        "            kn_diag_rb_unserialize_frame = (int32_t)rb_frame;\n"
        "            int _krb_restore_ret = rb_restore_slot_state(ring_idx);\n"
        "            kn_diag_rb_unserialize_ret = _krb_restore_ret;\n"
        "            KN_RB_PROBE_SLOT(41, ring_idx);\n"
        "            if (!_krb_restore_ret) {\n"
        "                rb.failed_rollbacks++;\n"
        "                rb_log(\"RESTORE-FAILED f=%d ring[%d]=%d depth=%d backend=%d (failed_rollbacks=%d)\",\n"
        "                    rb_frame, ring_idx, rb.ring_frames[ring_idx], depth,\n"
        "                    rb.state_backend, rb.failed_rollbacks);\n"
        "                return 0;\n"
        "            }\n",
    ),
    # Replay save + return 2 (line 973 + line 993).
    (
        "        rb_log(\"C-REPLAY-FRAME f=%d remaining=%d apply=%d save_idx=%d\",\n"
        "            rb.frame, rb.replay_remaining, replay_apply, save_idx);\n"
        "        rb_save_slot(save_idx, rb.frame, 0);\n",

        "        rb_log(\"C-REPLAY-FRAME f=%d remaining=%d apply=%d save_idx=%d\",\n"
        "            rb.frame, rb.replay_remaining, replay_apply, save_idx);\n"
        "        KN_RB_PROBE_SLOT(50, save_idx);\n"
        "        rb_save_slot(save_idx, rb.frame, 0);\n"
        "        KN_RB_PROBE_SLOT(51, save_idx);\n",
    ),
    (
        "        return 2; /* 2 = JS should step the emulator for a replay frame */\n",

        "        KN_RB_PROBE(71);\n"
        "        return 2; /* 2 = JS should step the emulator for a replay frame */\n",
    ),
    # Normal-tick save (line 1090) + return 0 at end of kn_pre_tick.
    (
        "        {\n"
        "            int save_idx = rb.frame % rb.ring_size;\n"
        "            if (rb.last_save_frame != rb.frame) {\n"
        "                rb_save_slot(save_idx, rb.frame, 1);\n"
        "            }\n"
        "        }\n",

        "        {\n"
        "            int save_idx = rb.frame % rb.ring_size;\n"
        "            if (rb.last_save_frame != rb.frame) {\n"
        "                KN_RB_PROBE_SLOT(60, save_idx);\n"
        "                rb_save_slot(save_idx, rb.frame, 1);\n"
        "                KN_RB_PROBE_SLOT(61, save_idx);\n"
        "            }\n"
        "        }\n",
    ),
    (
        "    return 0; /* 0 = normal tick, JS should do stepOneFrame */\n"
        "}\n",

        "    KN_RB_PROBE(70);\n"
        "    return 0; /* 0 = normal tick, JS should do stepOneFrame */\n"
        "}\n",
    ),
    # kn_post_tick entry/exit.
    (
        "int kn_post_tick(void) {\n"
        "    if (!rb.initialized) return -1;\n"
        "    rb.frame++;\n",

        "int kn_post_tick(void) {\n"
        "    if (!rb.initialized) return -1;\n"
        "    KN_RB_PROBE(80);\n"
        "    rb.frame++;\n",
    ),
]


def main():
    if len(sys.argv) != 2:
        print("usage: inject-rb-probes.py <mupen64plus-libretro-nx-dir>", file=sys.stderr)
        sys.exit(1)
    src = pathlib.Path(sys.argv[1]) / "kn_rollback.c"
    if not src.exists():
        # kn_rollback.c is copied into the source tree by build.sh; resolve
        # against the rollback subdir if the standard layout doesn't apply.
        alt = pathlib.Path(sys.argv[1]) / "kn_rollback" / "kn_rollback.c"
        if alt.exists():
            src = alt
        else:
            print(f"    inject-rb-probes.py: {src} not found", file=sys.stderr)
            sys.exit(1)
    text = src.read_text()
    if "kn_diag_rb_phase" in text:
        print("    inject-rb-probes.py: already injected, skipping")
        return
    if GLOBALS_ANCHOR not in text:
        print("    inject-rb-probes.py: anchor not found", file=sys.stderr)
        sys.exit(1)
    text = text.replace(GLOBALS_ANCHOR, GLOBALS_INSERT, 1)

    if SAVE_SLOT_ORIGINAL in text:
        text = text.replace(SAVE_SLOT_ORIGINAL, SAVE_SLOT_INSTRUMENTED, 1)
    elif SAVE_SLOT_SPLIT_ORIGINAL in text:
        text = text.replace(SAVE_SLOT_SPLIT_ORIGINAL, SAVE_SLOT_SPLIT_INSTRUMENTED, 1)
    else:
        print("    inject-rb-probes.py: rb_save_slot baseline did not match", file=sys.stderr)
        sys.exit(1)

    for orig, new in PROBE_PATCHES:
        if orig not in text:
            print(f"    inject-rb-probes.py: patch baseline did not match:\n---\n{orig[:200]}\n---", file=sys.stderr)
            sys.exit(1)
        text = text.replace(orig, new, 1)

    src.write_text(text)
    print(f"    inject-rb-probes.py: injected rollback-engine probes into {src}")


if __name__ == "__main__":
    main()
