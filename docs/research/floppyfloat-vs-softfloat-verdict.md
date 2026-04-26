# FloppyFloat vs Berkeley SoftFloat 3e — Verdict (2026-04-22)

Independent re-verification of the 2026-04-20 evaluation. Every claim
below is sourced from direct code read or a cited URL. When a claim
could not be verified against primary source, it is marked
**INCONCLUSIVE**.

**Final recommendation: stay on Berkeley SoftFloat 3e.**
FloppyFloat is blocked by a hard Clang/wasm32 limitation on
`_Float128`, not by the reasons the prior evaluation cited. Prior
evaluation had the right conclusion for the wrong reasons.

---

## Evidence summary — prior claims re-checked

### Claim 1 — "Only guarantees RNE; non-RNE falls back to host FPU" → **OVERTURNED**

Prior evaluation misread the README. FloppyFloat implements **all five
IEEE 754-2019 rounding modes** in software, using host RNE as a
baseline and then applying software "rectifications" based on
FastTwoSum error terms.

Evidence:

- Enum with all five modes, `vfpu.h:17-23`
  ([source](https://github.com/not-chciken/FloppyFloat/blob/main/src/vfpu.h)):
  ```
  enum RoundingMode {
    kRoundTiesToEven,
    kRoundTowardZero,
    kRoundTowardNegative,
    kRoundTowardPositive,
    kRoundTiesToAway
  }
  ```
- Explicit template instantiations for every mode × every type,
  `floppy_float.cpp:429-445` — e.g. for `Add<f64, kRoundTowardZero>`.
- Algorithm, `floppy_float.cpp:395-424`:
  ```
  if constexpr (rm == kRoundTiesToEven) {
    if (!inexact) { FT r = FastTwoSum<FT>(a, b, c); ... }
  } else {
    FT r = FastTwoSum<FT>(a, b, c);
    if (!IsZero(r)) {
      SetInexact();
      if constexpr (rm == kRoundTiesToAway) { ... explicit rectify ... }
      else { c = RoundResult<FT, FT, rm>(r, c); }  // software round
    }
  }
  ```
  The non-RNE path explicitly computes the rounding error `r` via
  `FastTwoSum` and calls `RoundResult` (software routine) to adjust `c`
  up or down. It does **not** re-delegate to host FPU's hardware
  rounding mode. `RmGuard` at `vfpu.cpp:203-210` only saves/restores the
  enum, never touches hardware FCSR.

The README sentence "FloppyFloat only relies on correct IEEE 754 FP
results in round to nearest mode" is a precondition on the host
(host's RNE must be IEEE 754 compliant), not a statement that
non-RNE falls through.

### Claim 2 — "Hybrid design defeats cross-JIT determinism" → **OVERTURNED**

In WebAssembly specifically, the "hybrid" reliance on host RNE is
safe. The WebAssembly spec requires bit-exact IEEE 754
correctly-rounded RNE for f32/f64 `add/sub/mul/div/sqrt`, across all
engines (V8, JSC, SpiderMonkey). That is the only invariant
FloppyFloat needs from the host.

Evidence:

- WASM core numerics: basic arithmetic is specified as correctly
  rounded RNE IEEE 754. The cross-JIT determinism gap we hit comes
  from **N64 MIPS convert-to-int opcodes** (trunc.w / cvt.w with
  FCR31 mode bits) and edge cases Emscripten's C `(int)x`,
  `truncf`, `fesetround`, etc. resolve inconsistently — not from core
  WASM arithmetic.
- FloppyFloat canonicalizes NaN outputs, `vfpu.cpp:103-110` + `GetQnan`
  usage in `Add` `floppy_float.cpp:379`. WASM NaN bit-pattern
  nondeterminism does not leak into downstream computation because
  any FloppyFloat NaN output is the canonical stored QNaN.

Caveat: fma goes through `std::fma`, not a WASM-native opcode. WASM
has no f32/f64 fma; the libc implementation may vary. **Not a
regression vs SoftFloat** — our SoftFloat patch doesn't wrap fma
either (it's not a MIPS VR4300 opcode).

### Claim 3 — "C++23 + uint128 may not compile clean under Emscripten" → **MIXED**

Two parts, different answers:

- `__uint128_t` — **VERIFIED working** under Emscripten. Our in-tree
  SoftFloat uses it via `opts-GCC.h` (see `build/softfloat/include/opts-GCC.h:65`)
  and has been shipping in production. The GitHub issue #5630
  ([emscripten-core/emscripten#5630](https://github.com/emscripten-core/emscripten/issues/5630))
  that said "not supported" was closed in 2017; situation has
  changed. Prior eval's doubt here was stale.
- `std::float128_t` / `_Float128` — **HARD BLOCKER**. Clang has not
  implemented `_Float128` for the wasm32 target; see
  [LLVM issue #97335](https://github.com/llvm/llvm-project/issues/97335)
  and the note that `__float128` is "only supported on x86_64."
  Emscripten 3.1.74 ships LLVM 19.1.6, which inherits this limitation.
  FloppyFloat unconditionally declares `using f128 = std::float128_t`
  at `utils.h:62` and uses `TwiceWidthType<f64>::type = f128` for
  the extended-precision path inside Mul/Fma
  (`floppy_float.cpp:621, 729`). So any f64 operation from FloppyFloat
  requires a working f128 on the target. Won't compile under
  Emscripten today.

### Claim 4 — "No WASM / emulator precedent" → **VERIFIED**

No published WASM build of FloppyFloat found. No emulator
production use found (Dolphin, ares, Mednafen, mupen64plus —
none). FloppyFloat is a 2024 research project; the paper is
IEEE DATE 2025
([10992803](https://ieeexplore.ieee.org/document/10992803/)). Not a
dealbreaker on its own, but compounds risk.

### Claim 5 — "API-incompatible; ~30 MIPS FPU wrappers" → **VERIFIED**

Our current SoftFloat wrappers in
[build/patches/mupen64plus-softfloat.patch](../../build/patches/mupen64plus-softfloat.patch)
and the patched
[build/src/mupen64plus-libretro-nx/mupen64plus-core/src/device/r4300/fpu.h](../../build/src/mupen64plus-libretro-nx/mupen64plus-core/src/device/r4300/fpu.h)
cover ~32 operations:

| Category | Ops wrapped |
|---|---|
| Basic arith f32 | add_s, sub_s, mul_s, div_s, sqrt_s |
| Basic arith f64 | add_d, sub_d, mul_d, div_d, sqrt_d |
| Int→float conv | cvt_s_w, cvt_d_w, cvt_s_l, cvt_d_l |
| Float↔float conv | cvt_s_d, cvt_d_s |
| Float→int (RNE) | round_w_s, round_l_s, round_w_d, round_l_d |
| Float→int (RZ)  | trunc_w_s, trunc_l_s, trunc_w_d, trunc_l_d |
| Float→int (RP)  | ceil_w_s, ceil_l_s, ceil_w_d, ceil_l_d |
| Float→int (RM)  | floor_w_s, floor_l_s, floor_w_d, floor_l_d |
| Mode-dispatched | cvt_w_s, cvt_w_d, cvt_l_s, cvt_l_d (→ above) |

FloppyFloat is templated C++ (`class FloppyFloat` in `floppy_float.h`);
our fpu.h is C inside a C translation unit. Migrating would require
a C++ shim compilation unit (~200–400 LOC) exposing `extern "C"`
adapters plus the patch to fpu.h to call them. The patch itself
becomes smaller per-site (just function calls), but the new shim is
net more code. Shipping risk — new, untested integration path.

---

## Specific verifications the prompt asked for

### 1. Rounding mode coverage
FloppyFloat: all of RNE, RZ, RU, RD, RNA implemented in software
(evidence above). No fallback to host hardware rounding.

### 2. N64 / SSB64 rounding usage
SSB64 **does** use non-RNE rounding modes in compiled code. Even
though its libultra init only sets FS+EV (not rounding bits) at
[`libultra/os/initialize.c:34`](../../build/recomp/vendor/smash64r/lib/ssb-decomp-re/src/libultra/os/initialize.c#L34):
```
__osSetFpcCsr(FPCSR_FS | FPCSR_EV); // flush denorm to zero, enable invalid operation
```
…IDO-compiled code emits `trunc.w.s` directly whenever C casts
`(int)float_val`. Confirmed in the decomp asm, e.g.
[`n_alResamplePull.s:59`](../../build/recomp/vendor/smash64r/lib/ssb-decomp-re/asm/nonmatchings/libultra/n_audio/n_env/n_alResamplePull.s#L59):
```
/* 2A95C 80029D5C 4600218D */  trunc.w.s  $f6, $f4
```
`trunc.w` is hardwired RZ regardless of FCR31. Multiple occurrences
across libultra/n_audio/ft/. Non-RNE is on the hot path.

Implication: RNE-only determinism would **not** be sufficient. Both
SoftFloat and FloppyFloat implement all four MIPS-required rounding
modes, so this is a push between them, not a differentiator.

### 3. Emscripten / WASM compilation
- `__uint128_t`: works (our SoftFloat uses it, ships in production).
- C++23: emsdk 3.1.74 ships LLVM 19.1.6; most C++23 features available.
- `std::float128_t` / `_Float128`: **not available on wasm32 target**
  (Clang limitation). FloppyFloat won't compile as-is.

### 4. API surface comparison
- SoftFloat today: `kn_from_f32(f32_add(kn_to_f32(a), kn_to_f32(b)))` —
  direct C macros + type-punning helpers, ~6 lines per op added to
  fpu.h.
- FloppyFloat replacement: same call sites, but going through an
  `extern "C"` shim that instantiates the template — e.g.
  `kn_ff_add_f32(a, b)` → `ff.Add<FfUtils::f32>(a, b)` in the shim.
  Net effort estimate if the `_Float128` blocker weren't present:
  ~1–2 days (shim + Makefile + patch rework + test).

### 5. Performance delta
README claims **1.28×–5.50×** faster than SoftFloat on AMD Threadripper
([README](https://github.com/not-chciken/FloppyFloat/blob/main/README.md)
Performance section). On WASM the speedup would come mostly from
using host f32/f64 hardware via Emscripten's WASM f32/f64 opcodes vs
SoftFloat's software bit manipulation. Could be meaningful on mobile
(thermal/battery), but is **not** a correctness driver. SoftFloat's
current 5–20× slowdown vs native is already accepted.

### 6. IEEE 754 edge cases
- NaN propagation: explicit schemes implemented
  (`kNanPropRiscv`, `kNanPropX86sse`, `kNanPropArm64DefaultNan`,
  `kNanPropArm64`; see `vfpu.h:47` and `Vfpu::SetupToX86` etc.).
  Bit-exact across hosts **provided** inputs are canonicalized.
- Subnormal handling: `tininess_before_rounding` flag exposed;
  detection/rectification done in software. MIPS default = false
  (`vfpu.cpp:108`), MIPS VR4300 actually detects tininess after
  rounding — matches.
- Denormal flush: depends on host. WASM host does not flush by
  default; MIPS wants flush-to-zero when FS=1. FloppyFloat has no
  dedicated FS flag — would need post-hoc flush in our shim.
  SoftFloat 3e also lacks this; we'd face the same issue. Push.

---

## Remaining risks if you still wanted FloppyFloat

1. **`_Float128` blocker** — requires upstream patch or fork.
   Forking adds maintenance burden forever.
2. **C++23 feature gaps in Emcc libc++** — `<stdfloat>` header,
   `std::numeric_limits<f128>::is_iec559`
   static_assert (`vfpu.h:13`) may fail even after patching out f128.
3. **NaN canonicalization only holds transitively** — if any
   non-FloppyFloat code path produces a NaN (e.g., `kn_native_fpu=1`
   bypass, intrinsics in RSP audio DSP, or gpu-fxn math that's not
   routed through FPU wrappers), downstream determinism is lost.
   Same constraint we live with under SoftFloat today.
4. **No emulator ever has shipped FloppyFloat in WASM.** We'd be
   first. Given that our netplay hinges on bit-exactness, "first"
   here is bad.

---

## Options considered

| Option | Feasibility | Effort | Recommendation |
|---|---|---|---|
| A. Swap to FloppyFloat as-is | Impossible — `_Float128` doesn't compile on wasm32 | — | No |
| B. Fork FloppyFloat, stub out f128 path | Feasible but invasive; f64 Mul/Fma loses its extended-precision path, accuracy implications unclear | 2–4 days + regression testing | No — accuracy risk |
| C. Fork FloppyFloat, emulate f128 via double-double or another soft-f128 | Feasible; keeps accuracy; heavier | 4–7 days + long-term maintenance | No — not worth it |
| D. Stay on SoftFloat 3e | Works today, shipping, known-good | 0 | **Yes** |
| E. Write our own tight soft FPU for the ~10 hot opcodes | Possible future optimization | 1–2 weeks | Defer; only if SoftFloat proves to be a perf bottleneck |

---

## Final recommendation

**Stay on Berkeley SoftFloat 3e.** Prior evaluation reached the right
conclusion, but for the wrong technical reasons. The real blockers:

1. `_Float128` is not available on the wasm32 target in current Clang/LLVM.
2. SoftFloat is already integrated, tested, and shipped (v0.23.0+).
3. Performance is not the constraint — determinism is. SoftFloat gives
   us determinism we trust; FloppyFloat would be a gamble.

Reopen this evaluation only if:
- Mobile SoftFloat overhead becomes a measurable perf/battery problem, AND
- Clang adds `_Float128` support on wasm32, OR
- An upstream-clean FloppyFloat fork without f128 dependence appears.

## Source citations

- FloppyFloat repo: <https://github.com/not-chciken/FloppyFloat>
- FloppyFloat paper: <https://ieeexplore.ieee.org/document/10992803/>
- Berkeley SoftFloat 3e: <https://github.com/ucb-bar/berkeley-softfloat-3>
- Clang `_Float128` status: <https://github.com/llvm/llvm-project/issues/97335>
- Emscripten __int128 history: <https://github.com/emscripten-core/emscripten/issues/5630>
- FloppyFloat rounding mode enum: `vfpu.h:17-23`
- FloppyFloat non-RNE algorithm: `floppy_float.cpp:395-424`
- FloppyFloat f128 dependency: `utils.h:62`, `utils.h:82-95`, `vfpu.h:13`
- Our SoftFloat wrappers: `build/patches/mupen64plus-softfloat.patch`
- Our SoftFloat __int128 usage: `build/softfloat/include/opts-GCC.h:65-98`
- Our patched FPU header: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/device/r4300/fpu.h`
- SSB64 `trunc.w.s` usage: `build/recomp/vendor/smash64r/lib/ssb-decomp-re/asm/nonmatchings/libultra/n_audio/n_env/n_alResamplePull.s:59`
- SSB64 libultra FPU init: `build/recomp/vendor/smash64r/lib/ssb-decomp-re/src/libultra/os/initialize.c:34`
- Emscripten 3.1.74 LLVM version: emsdk ChangeLog (LLVM 19.1.6)
