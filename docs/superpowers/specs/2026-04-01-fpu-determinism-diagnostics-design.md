# FPU Determinism Diagnostics

## Problem

The RSP audio skip workaround (`kn_set_skip_rsp_audio`) on guest prevents DRAM divergence during lockstep netplay, but it masks whether the emulated N64 FPU instructions are actually deterministic across ARM (Safari/iPhone) and x86 (Chrome/Mac) WASM engines. We need to verify whether FPU operations produce bit-identical results cross-platform so we can eventually remove the workaround and achieve true determinism.

## Key Insight

WASM basic float operations (`f32.add`, `f32.mul`, `f32.div`, `f32.sub`, `f32.sqrt`) are IEEE 754 deterministic per the WASM spec. The only specified non-determinism is NaN bit patterns, which is already handled by `--denan` + `fix-denan.py`. The `-ffp-contract=off` flag prevents FMA contraction. So FPU determinism is *theoretically* already achieved — this work verifies that empirically.

## Approach

Add C-level FPU operation tracing to all floating-point arithmetic functions in `fpu.h`. Peers exchange trace snapshots over DataChannel and diff them. No gameplay behavior changes. RSP audio skip stays as-is.

## Design

### C Layer: FPU Trace Ring Buffer

The trace infrastructure is split across two locations to avoid duplicate-symbol issues (`fpu.h` is included by multiple translation units — `cached_interp.c`, `pure_interp.c`, `new_dynarec.c`):

**Storage + exports** in `main.c` (single TU, where other `kn_*` globals live):

```c
#ifdef __EMSCRIPTEN__
#include <emscripten.h>

#define KN_FPU_TRACE_SIZE 4096  /* entries, power of 2 */

typedef struct {
    uint8_t  op;        /* operation ID (see table below) */
    uint8_t  pad[3];
    uint32_t frame;     /* current emulator frame number */
    uint64_t in1;       /* first input as raw bits (float->uint32 zero-extended, double->uint64) */
    uint64_t in2;       /* second input (0 for unary ops like sqrt, abs, neg) */
    uint64_t out;       /* output as raw bits */
} kn_fpu_trace_entry;   /* 32 bytes per entry */

int kn_fpu_trace_enabled = 0;
kn_fpu_trace_entry kn_fpu_trace_buf[KN_FPU_TRACE_SIZE];
uint32_t kn_fpu_trace_count = 0; /* total entries written, monotonic; head = count & (SIZE-1) */

EMSCRIPTEN_KEEPALIVE void kn_fpu_trace_enable(int enable) {
    kn_fpu_trace_enabled = enable;
    if (enable) {
        kn_fpu_trace_count = 0;
    }
}

EMSCRIPTEN_KEEPALIVE uint32_t kn_fpu_trace_get_count(void) {
    return kn_fpu_trace_count;
}

EMSCRIPTEN_KEEPALIVE kn_fpu_trace_entry* kn_fpu_trace_get_buf(void) {
    return kn_fpu_trace_buf;
}
#endif
```

**Extern declarations + inline recorder** in `fpu.h`:

```c
#ifdef __EMSCRIPTEN__
#define KN_FPU_TRACE_SIZE 4096

typedef struct {
    uint8_t  op;
    uint8_t  pad[3];
    uint32_t frame;
    uint64_t in1;
    uint64_t in2;
    uint64_t out;
} kn_fpu_trace_entry;

extern int kn_fpu_trace_enabled;
extern kn_fpu_trace_entry kn_fpu_trace_buf[];
extern uint32_t kn_fpu_trace_count;
extern int g_gs_vi_counter; /* frame counter from main.c, incremented per VI interrupt */

static inline void kn_fpu_trace_record(uint8_t op, uint64_t in1, uint64_t in2, uint64_t out) {
    if (!kn_fpu_trace_enabled) return;
    kn_fpu_trace_entry* e = &kn_fpu_trace_buf[kn_fpu_trace_count & (KN_FPU_TRACE_SIZE - 1)];
    e->op = op;
    e->frame = (uint32_t)g_gs_vi_counter;
    e->in1 = in1;
    e->in2 = in2;
    e->out = out;
    kn_fpu_trace_count++;
}
#endif
```

Uses `g_gs_vi_counter` (already defined in main.c, incremented per VI interrupt) as the frame counter.

**Operation IDs:**

| ID | Operation | Type |
|----|-----------|------|
| 0  | add_s     | binary, float |
| 1  | sub_s     | binary, float |
| 2  | mul_s     | binary, float |
| 3  | div_s     | binary, float |
| 4  | sqrt_s    | unary, float |
| 5  | abs_s     | unary, float |
| 6  | neg_s     | unary, float |
| 7  | add_d     | binary, double |
| 8  | sub_d     | binary, double |
| 9  | mul_d     | binary, double |
| 10 | div_d     | binary, double |
| 11 | sqrt_d    | unary, double |
| 12 | abs_d     | unary, double |
| 13 | neg_d     | unary, double |
| 14 | cvt_s_d   | unary, conversion |
| 15 | cvt_d_s   | unary, conversion |
| 16 | cvt_s_w   | unary, conversion |
| 17 | cvt_d_w   | unary, conversion |
| 18 | cvt_s_l   | unary, conversion |
| 19 | cvt_d_l   | unary, conversion |

`mov_s`/`mov_d` excluded (pure copy, no computation).

**Instrumentation example** (`add_s`):

```c
M64P_FPU_INLINE void add_s(uint32_t* fcr31, const float* source1, const float* source2, float* target)
{
    set_rounding(*fcr31);
    fpu_reset_cause(fcr31);
    fpu_check_input_float(fcr31, source1);
    fpu_check_input_float(fcr31, source2);
    fpu_reset_exceptions();

    *target = *source1 + *source2;

    fpu_check_exceptions(fcr31);
    fpu_check_output_float(fcr31, target);

#ifdef __EMSCRIPTEN__
    {
        uint32_t i1, i2, o;
        memcpy(&i1, source1, 4);
        memcpy(&i2, source2, 4);
        memcpy(&o, target, 4);
        kn_fpu_trace_record(0, i1, i2, o);
    }
#endif
}
```

Same pattern for all 20 ops. `memcpy` for type-punning (avoids strict aliasing UB). Float values zero-extend to uint64 in the trace entry.

### Build Integration

**New file:** `build/patches/mupen64plus-fpu-trace.patch`
- Patches `fpu.h`: adds extern declarations, inline recorder, instrumentation in each of the 20 FPU functions
- Patches `main.c`: adds trace buffer storage, exported accessor functions, `kn_fpu_trace_entry` typedef

**Modified:** `build/patches/retroarch-deterministic-timing.patch`
- Add to `EXPORTED_FUNCTIONS`: `_kn_fpu_trace_enable`, `_kn_fpu_trace_get_count`, `_kn_fpu_trace_get_buf`

**Modified:** `build/build.sh`
- Apply new patch after existing patches

### JS Layer: Trace Exchange

**File:** `web/static/netplay-lockstep.js`

Periodic trace comparison synchronized by frame number:

1. **Snapshot capture:** Every N frames (e.g., 300), each peer reads the trace buffer from WASM memory:
   - Call `Module._kn_fpu_trace_get_count()` to get total ops recorded
   - Call `Module._kn_fpu_trace_get_buf()` to get the buffer pointer
   - Read `KN_FPU_TRACE_SIZE * 32` bytes from HEAPU8 at the buffer pointer
   - Extract entries matching the target frame window and compute a hash

2. **Synchronization:** Comparison is keyed on frame number, not operation count. Each peer extracts trace entries for the frame range `[currentFrame - 300, currentFrame]` from the ring buffer and hashes those entries. This avoids false mismatches from peers being at slightly different operation counts.

3. **Exchange:** Host broadcasts `{ type: 'fpu-trace-hash', frame: <uint32>, hash: <uint32>, count: <uint32> }` over DataChannel. Guests compare their hash for the same frame range.

4. **On mismatch:** Both peers dump their trace entries for the divergent frame range and send them via the `debug-sync` Socket.IO event for offline analysis. Log the first divergent entry: op type, frame number, input bits (hex), output bits (hex).

5. **On match:** Log once: `FPU trace verified: N ops matched across peers (frames X-Y)`.

**Enable/disable:** Trace is enabled at game start (`Module._kn_fpu_trace_enable(1)`) and disabled at game end. Controlled by a `fpuTrace` flag (default: enabled in lockstep mode).

### Performance

- **Tracing disabled:** Single branch per FPU op (`if (!kn_fpu_trace_enabled) return;`). ~0 overhead.
- **Tracing enabled:** One `memcpy` + ring buffer write per FPU op. ~1000 FPU ops/frame * 32 bytes = 32KB/frame. Ring buffer holds 4096 entries = last ~4 frames. Hash comparison every 300 frames. Negligible.
- **Buffer size:** 4096 * 32 = 128KB static allocation. Acceptable.

### Files Changed

| File | Change |
|------|--------|
| `build/patches/mupen64plus-fpu-trace.patch` | **New.** Trace buffer in main.c + instrumentation in fpu.h |
| `build/patches/retroarch-deterministic-timing.patch` | Add 3 new exports |
| `build/build.sh` | Apply new patch |
| `web/static/netplay-lockstep.js` | Trace enable/disable, periodic hash exchange, mismatch logging |

### Success Criteria

- Cross-platform lockstep session (Safari/iPhone + Chrome/Mac) runs SSB64 for 10+ minutes with FPU trace enabled
- Trace hashes match at every comparison interval -> FPU determinism empirically confirmed
- If mismatch found -> trace dump identifies the exact divergent operation, frame, and bit pattern

### What Happens Next

- **If traces match:** FPU is deterministic. Next step is removing `kn_set_skip_rsp_audio` in a separate branch and verifying gameplay stays in sync.
- **If traces diverge:** The dump tells us exactly which operations differ. Targeted fix (possibly SoftFloat for just those ops) in a follow-up.
