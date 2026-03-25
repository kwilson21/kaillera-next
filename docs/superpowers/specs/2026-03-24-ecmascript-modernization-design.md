# ECMAScript Modernization — Design Spec

**Date:** 2026-03-24
**Scope:** All JavaScript files in `web/static/`
**Approach:** Hybrid — modernize syntax inside existing IIFE + `window` structure

## Goal

Eliminate mixed old/new ECMAScript patterns across the codebase. Every file should
use consistent modern syntax. No behavioral changes — purely mechanical transforms.

## What Changes

### Variable Declarations

`var` → `const` (default) or `let` (only when reassigned).

```javascript
// Before
var peers = {};
var running = false;
var i;
for (i = 0; i < arr.length; i++) { ... }

// After
const peers = {};
let running = false;
for (let i = 0; i < arr.length; i++) { ... }
```

### Arrow Functions

Traditional `function` expressions → arrow functions, except:
- IIFE wrappers (keep `(function () { ... })()`)
- Functions that use `this` binding
- Functions used as constructors

```javascript
// Before
socket.on('data-message', function (msg) { ... });
var attempt = function () { ... };

// After
socket.on('data-message', (msg) => { ... });
const attempt = () => { ... };
```

### Template Literals

String concatenation with `+` → template literals.

```javascript
// Before
console.log('[lockstep] boot slot=' + _playerSlot + ' f=' + frames + '/' + MIN_BOOT_FRAMES);

// After
console.log(`[lockstep] boot slot=${_playerSlot} f=${frames}/${MIN_BOOT_FRAMES}`);
```

### Modern Iteration

Traditional `for` loops → `for...of`, `.forEach()`, or array methods where index is not needed.
`Object.keys().forEach()` → `for (const [k, v] of Object.entries())` or `Object.values()`.

```javascript
// Before
for (var i = 0; i < buttons.length; i++) {
  var btn = buttons[i];
  ...
}
Object.keys(peers).forEach(function (sid) {
  var p = peers[sid];
  ...
});

// After
for (const btn of buttons) { ... }
for (const [sid, p] of Object.entries(peers)) { ... }
```

**Keep traditional `for` loops when:**
- Index is needed for logic (not just element access)
- Performance-critical hot paths (lockstep tick loop) where `for...of` iterator overhead matters
- Iterating over typed arrays (`HEAPU8`) where index is the interface

### Async/Await

`.then()/.catch()` chains → `async`/`await` with `try`/`catch`, where the
containing function can become async without changing its caller contract.

```javascript
// Before
decodeAndDecompress(msg.data).then(function (bytes) {
  gm.loadState(bytes);
  enterManualMode();
  startLockstep();
}).catch(function (err) {
  console.log('[lockstep] failed:', err);
});

// After
try {
  const bytes = await decodeAndDecompress(msg.data);
  gm.loadState(bytes);
  enterManualMode();
  startLockstep();
} catch (err) {
  console.log(`[lockstep] failed: ${err}`);
}
```

### Optional Chaining and Nullish Coalescing

Verbose null checks → `?.` and `??` where they improve clarity.

```javascript
// Before
var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
var mod = gm && gm.Module;

// After
const gm = window.EJS_emulator?.gameManager;
const mod = gm?.Module;
```

### Destructuring

Where it improves clarity (not forced everywhere).

```javascript
// Before
var width = rect.width;
var height = rect.height;

// After
const { width, height } = rect;
```

## What Does NOT Change

- **IIFE wrappers** — EmulatorJS requires globals on `window`; IIFEs provide
  isolation without a build step.
- **`window.X` exports** — Cross-module communication via `window.KNState`,
  `window.NetplayLockstep`, `window.VirtualGamepad`, etc. stays as-is.
- **`audio-worklet-processor.js`** — Runs in AudioWorklet scope with restrictions.
  Minimal changes only (already mostly modern).
- **Hot-path `for` loops** — The lockstep tick loop and WASM memory scanning use
  indexed iteration for a reason. Don't convert to `for...of`.
- **EJS integration points** — `window.EJS_*` globals, `gm.simulateInput` hooks,
  `ejs.virtualGamepad` access. These are dictated by EmulatorJS, not us.

## File Order

Modernize smallest/simplest files first to validate the transform patterns,
then tackle the large files where most of the debt lives.

| Order | File | Size | Modernization Debt |
|-------|------|------|--------------------|
| 1 | `kn-state.js` | 34 lines | Minimal — warm-up |
| 2 | `shared.js` | 166 lines | Low — few `var`, promise chains |
| 3 | `virtual-gamepad.js` | 340 lines | Medium — `var`, traditional loops |
| 4 | `gamepad-manager.js` | 328 lines | Medium — mixed patterns |
| 5 | `core-redirector.js` | ~100 lines | Low — mostly clean |
| 6 | `lobby.js` | ~200 lines | Minimal — mostly modern |
| 7 | `netplay-streaming.js` | 785 lines | Medium-high — mixed throughout |
| 8 | `netplay-lockstep.js` | 3,571 lines | Highest — 450+ var, 167 string concat |
| 9 | `play.js` | ~3,000 lines | High — scattered legacy patterns |
| 10 | `audio-worklet-processor.js` | ~50 lines | Minimal — already modern |

## Risk Mitigation

- **Purely mechanical transforms.** Same semantics, different syntax. No logic changes.
- **One file at a time.** Each file is independently testable.
- **Preserve hot paths.** Don't convert performance-sensitive indexed loops.
- **Keep IIFE structure.** No module system changes, no build tooling changes.
- **`const` by default.** Accidentally using `const` where `let` was needed produces
  an immediate, obvious runtime error — far safer than the silent bugs `var` enables.

## Validation

No automated test suite exists. Validation is:
1. No syntax errors (file loads without throwing)
2. Code review of each transformed file (mechanical correctness)
3. Manual smoke test of core flows (lobby → game start → lockstep → late join)
