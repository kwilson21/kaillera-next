
/*============================================================================

platform.h — SoftFloat 3e platform configuration for WASM (Emscripten).

WASM is always little-endian. Emscripten's clang supports __builtin_clz and
64-bit integers, so we enable the fast-path optimizations.

=============================================================================*/

#define LITTLEENDIAN 1

#ifdef __GNUC_STDC_INLINE__
#define INLINE inline
#else
#define INLINE extern inline
#endif

#define SOFTFLOAT_BUILTIN_CLZ 1
#define SOFTFLOAT_FAST_INT64 1
#include "opts-GCC.h"
