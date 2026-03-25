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

**Edge cases:**
- Declare-then-assign patterns (`var x; ... x = val;`) must become `let`, not `const`.
- `var` redeclared in the same function scope (e.g., `var mod` twice in `startLockstep()`)
  must be renamed or scoped — `let`/`const` does not allow redeclaration.

### Arrow Functions

Traditional `function` expressions → arrow functions, except:
- IIFE wrappers (keep `(function () { ... })()`)
- Functions that use `this` binding
- Functions that use `arguments`
- Functions used as constructors (called with `new`)

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

**Constraint:** A function can only become `async` if no caller depends on it
returning a non-Promise value (or returning synchronously). Fire-and-forget
callers are safe. Functions whose return value is checked are not.

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
- **Inline Worker code strings** — The string-built Web Worker in
  `netplay-lockstep.js` (lines ~2853-2906) runs in a separate context. Do not
  modernize code inside string literals.
- **Functions using `arguments`** — Arrow functions don't have `arguments`.
  These must stay as `function` expressions:
  - `console.log` interceptor in `netplay-lockstep.js` (~line 156)
  - `mod.pauseMainLoop` / `mod.resumeMainLoop` monkey-patches (~lines 532-541)
  - `fetch` / `XMLHttpRequest.prototype.open` interceptors in `core-redirector.js`
- **Functions used as constructors** — Arrow functions can't be called with `new`:
  - `_HijackAC` in `netplay-lockstep.js` (~line 1514) — assigned to
    `window.AudioContext` and called with `new` by EmulatorJS
- **Functions relying on dynamic `this`** — The fetch/XHR interceptors in
  `core-redirector.js` use `this` to forward calls to the original methods.
  Arrow functions would bind `this` to the IIFE scope instead.

## File Order

Modernize smallest/simplest files first to validate the transform patterns,
then tackle the large files where most of the debt lives.

| Order | File | Size | Modernization Debt | Notes |
|-------|------|------|--------------------|-------|
| 1 | `kn-state.js` | 34 lines | Minimal — warm-up | |
| 2 | `api-sandbox.js` | ~78 lines | Low — `var` declarations | Loaded first on play.html |
| 3 | `shared.js` | 166 lines | Low — few `var`, promise chains | |
| 4 | `virtual-gamepad.js` | 340 lines | Medium — `var`, traditional loops | |
| 5 | `gamepad-manager.js` | 328 lines | Medium — mixed patterns | |
| 6 | `core-redirector.js` | ~100 lines | Low — has `this`/`arguments` traps | |
| 7 | `lobby.js` | ~200 lines | Minimal — mostly modern | Loaded from index.html, not play.html |
| 8 | `netplay-streaming.js` | 785 lines | Medium-high — mixed throughout | |
| 9 | `netplay-lockstep.js` | 3,571 lines | Highest — constructor trap, var redecls | |
| 10 | `play.js` | ~3,000 lines | High — scattered legacy patterns | |
| 11 | `audio-worklet-processor.js` | ~50 lines | Minimal — already modern | AudioWorklet scope |

## Risk Mitigation

- **Purely mechanical transforms.** Same semantics, different syntax. No logic changes.
- **One file at a time.** Each file is independently testable.
- **Preserve hot paths.** Don't convert performance-sensitive indexed loops.
- **Keep IIFE structure.** No module system changes, no build tooling changes.
- **`const` by default.** Accidentally using `const` where `let` was needed produces
  an immediate, obvious runtime error — far safer than the silent bugs `var` enables.
- **Explicit do-not-convert checklist.** Before converting any `function` expression,
  check: does it use `this`? `arguments`? Is it called with `new`? If yes to any → keep
  as `function`.
- **`var` redeclaration scan.** Before converting `var` → `let`/`const`, check for
  duplicate declarations in the same function scope. Rename duplicates first.

## Validation

No automated test suite exists. Validation is:
1. No syntax errors (file loads without throwing)
2. Code review with explicit checklist for `arguments`, `this`, constructors,
   `var` redeclarations, and declare-then-assign patterns
3. Manual smoke tests covering major code paths:
   - Lobby → create room → join
   - Lockstep 2P (host + guest)
   - Streaming 2P (host + guest)
   - Spectator join
   - Late join during lockstep
   - Mobile gesture → virtual gamepad input
