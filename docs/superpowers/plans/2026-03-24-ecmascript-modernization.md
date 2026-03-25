# ECMAScript Modernization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize all JavaScript in `web/static/` to consistent modern ECMAScript syntax.

**Architecture:** Purely mechanical syntax transforms inside existing IIFE + `window.*` structure. No behavioral changes, no module system changes, no build tooling changes.

**Tech Stack:** Vanilla JavaScript (ES2022+), no bundler, no framework.

**Spec:** `docs/superpowers/specs/2026-03-24-ecmascript-modernization-design.md`

---

## Transform Rules (reference for all tasks)

Every task applies these same transforms. Read once, apply everywhere.

1. **`var` → `const`/`let`:** `const` by default. `let` only when the binding is reassigned. Scan for `var` redeclarations in the same scope — rename duplicates before converting.
2. **`function` → arrow:** Convert function expressions to arrows. **DO NOT convert** if the function uses `this`, `arguments`, or is called with `new`. Keep all IIFE wrappers as `function`.
3. **String concat → template literals:** `'a ' + b + ' c'` → `` `a ${b} c` ``.
4. **Modern iteration:** `for (var i = 0; i < arr.length; i++)` → `for (const x of arr)` when index isn't needed. `Object.keys(o).forEach(k => { ... o[k] ... })` → `for (const [k, v] of Object.entries(o))`. **Keep** indexed loops on hot paths and typed arrays.
5. **`async`/`await`:** `.then()/.catch()` → `async`/`await` + `try`/`catch`. Only where the containing function can become `async` without breaking callers.
6. **Optional chaining:** `x && x.y && x.y.z` → `x?.y?.z` where it improves clarity.
7. **Destructuring:** Where it improves clarity, not forced.

---

## Chunk 1: Small Files (tasks 1-6)

### Task 1: kn-state.js (33 lines)

**Files:**
- Modify: `web/static/kn-state.js`

- [ ] **Step 1: Modernize kn-state.js**

This file is tiny. Apply all transforms:
- `var` in IIFE body → `const`
- Keep the IIFE wrapper as `function`

- [ ] **Step 2: Verify no syntax errors**

Run: Open browser dev console, load play.html, confirm no errors referencing kn-state.

- [ ] **Step 3: Commit**

```
git add web/static/kn-state.js
git commit -m "refactor: modernize kn-state.js to ES2022+"
```

---

### Task 2: api-sandbox.js (77 lines)

**Files:**
- Modify: `web/static/api-sandbox.js`

- [ ] **Step 1: Modernize api-sandbox.js**

Apply all transforms:
- `var` → `const`/`let`
- Function expressions → arrows (this file stores native browser APIs — check none use `this`)
- String concat → template literals
- Keep IIFE wrapper

- [ ] **Step 2: Commit**

```
git add web/static/api-sandbox.js
git commit -m "refactor: modernize api-sandbox.js to ES2022+"
```

---

### Task 3: shared.js (165 lines)

**Files:**
- Modify: `web/static/shared.js`

- [ ] **Step 1: Modernize shared.js**

Apply all transforms:
- `var` → `const`/`let` (note: `_bootPromise` is reassigned to `null` after resolve — use `let`)
- `function` → arrows
- `.then()/.catch()` → `async`/`await` in `applyStandardCheats` (fire-and-forget, safe to make async)
- `waitForEmulator` uses a Promise constructor with polling — keep as-is (can't easily convert polling to await)
- Template literals for log strings

- [ ] **Step 2: Commit**

```
git add web/static/shared.js
git commit -m "refactor: modernize shared.js to ES2022+"
```

---

### Task 4: virtual-gamepad.js (339 lines)

**Files:**
- Modify: `web/static/virtual-gamepad.js`

- [ ] **Step 1: Modernize virtual-gamepad.js**

Apply all transforms:
- `var` → `const`/`let`
- Traditional `for` loops → `for...of` where index not needed (button creation loop, touch iteration loops)
- Function expressions → arrows
- String concat → template literals (CSS string array and DOM construction)
- Keep IIFE wrapper

- [ ] **Step 2: Commit**

```
git add web/static/virtual-gamepad.js
git commit -m "refactor: modernize virtual-gamepad.js to ES2022+"
```

---

### Task 5: gamepad-manager.js (329 lines)

**Files:**
- Modify: `web/static/gamepad-manager.js`

- [ ] **Step 1: Modernize gamepad-manager.js**

Apply all transforms:
- `var _nativeGetGamepads = function () { ... }` → `const _nativeGetGamepads = () => ...`
- `var` → `const`/`let` throughout
- `for...in` loops on objects → `Object.entries()` or `Object.values()`
- Traditional `for` loops → `for...of` where safe
- String concat → template literals
- Keep IIFE wrapper

- [ ] **Step 2: Commit**

```
git add web/static/gamepad-manager.js
git commit -m "refactor: modernize gamepad-manager.js to ES2022+"
```

---

### Task 6: core-redirector.js (97 lines) — HAS TRAPS

**Files:**
- Modify: `web/static/core-redirector.js`

- [ ] **Step 1: Modernize core-redirector.js**

Apply transforms with these **explicit exceptions**:
- `var` → `const`/`let` (`idbClearPromise` is declare-then-assign → `let`)
- **DO NOT convert** the `fetch` interceptor — it uses `this` and `arguments`
- **DO NOT convert** the `XMLHttpRequest.prototype.open` interceptor — uses `this` and `arguments`
- Other function expressions → arrows where safe
- Template literals, optional chaining as appropriate
- Keep IIFE wrapper

- [ ] **Step 2: Commit**

```
git add web/static/core-redirector.js
git commit -m "refactor: modernize core-redirector.js to ES2022+ (preserve this/arguments traps)"
```

---

### Task 7: lobby.js (70 lines)

**Files:**
- Modify: `web/static/lobby.js`

- [ ] **Step 1: Modernize lobby.js**

This file is already mostly modern. Sweep for any remaining `var` or function expressions.
Note: loaded from `index.html`, not `play.html` — no dependency on play-page scripts.

- [ ] **Step 2: Commit**

```
git add web/static/lobby.js
git commit -m "refactor: modernize lobby.js to ES2022+"
```

---

## Chunk 2: netplay-streaming.js (task 8)

### Task 8: netplay-streaming.js (988 lines)

**Files:**
- Modify: `web/static/netplay-streaming.js`

- [ ] **Step 1: Convert variable declarations**

Sweep all `var` → `const`/`let`. Check for redeclarations in the same scope.

- [ ] **Step 2: Convert function expressions to arrows**

Convert callbacks and named function expressions. Keep the IIFE wrapper.
No known `this`/`arguments`/constructor traps in this file.

- [ ] **Step 3: Convert string concatenation to template literals**

Focus on diagnostic `console.log` statements and status messages.

- [ ] **Step 4: Convert iteration patterns**

- `Object.keys().forEach()` → `for...of Object.entries()`
- Traditional indexed loops → `for...of` where index not needed
- Keep indexed loops on typed array operations

- [ ] **Step 5: Convert promise chains to async/await**

`.then()/.catch()` chains in WebRTC signal handling → `async`/`await`.
Check that containing functions are fire-and-forget before making async.

- [ ] **Step 6: Apply optional chaining**

`window.EJS_emulator && window.EJS_emulator.gameManager` → `window.EJS_emulator?.gameManager` etc.

- [ ] **Step 7: Commit**

```
git add web/static/netplay-streaming.js
git commit -m "refactor: modernize netplay-streaming.js to ES2022+"
```

---

## Chunk 3: netplay-lockstep.js (task 9) — LARGEST, MOST TRAPS

### Task 9: netplay-lockstep.js (3,570 lines)

**Files:**
- Modify: `web/static/netplay-lockstep.js`

**Known traps (from spec review):**
- `_HijackAC` (~line 1514): constructor, assigned to `window.AudioContext`, called with `new` → **DO NOT convert to arrow**
- `console.log` interceptor (~line 156): uses `arguments` → **DO NOT convert**
- `mod.pauseMainLoop` / `mod.resumeMainLoop` patches (~lines 532-541): use `.apply(this, arguments)` → **DO NOT convert**
- `var mod` redeclared in `startLockstep()` (~lines 2219 and 2250): rename second to avoid `let` redeclaration error
- Inline Worker code string (~lines 2853-2906): **DO NOT modernize** code inside string literals
- Hot-path `tick()` function and `writeInputToMemory()`: **keep indexed `for` loops**

- [ ] **Step 1: Fix var redeclarations**

Before any `var` → `const`/`let` conversion, find and rename `var` redeclarations in the same function scope. Known: `var mod` in `startLockstep()` appears twice — rename second occurrence (likely already `mod2` in some places, make consistent).

- [ ] **Step 2: Convert variable declarations**

Sweep all `var` → `const`/`let`. This is the bulk of the work (~450 declarations).
- `const` for anything not reassigned
- `let` for loop counters, accumulators, state flags that change

- [ ] **Step 3: Convert function expressions to arrows**

Convert ~170 function expressions. **Check each one:**
- Skip `_HijackAC` (constructor)
- Skip `console.log` interceptor (uses `arguments`)
- Skip `pauseMainLoop`/`resumeMainLoop` patches (use `arguments` + `this`)
- Skip IIFE wrapper
- Convert all callbacks, event handlers, `.forEach()` callbacks, `.then()` callbacks

- [ ] **Step 4: Convert string concatenation to template literals**

~167 instances, mostly diagnostic logging. Convert all `console.log` calls that use `+` concatenation.
**Exception:** Do not modify strings inside the inline Worker code block (lines ~2853-2906).

- [ ] **Step 5: Convert iteration patterns**

- `Object.keys(x).forEach()` → `for...of Object.entries()`
- `Object.values(x).forEach()` → `for...of Object.values()`
- Traditional loops where index is unused → `for...of`
- **Keep** indexed loops in: `tick()`, `writeInputToMemory()`, `getHashBytes()`, INPUT_BASE scan, HEAPU8 operations

- [ ] **Step 6: Convert promise chains to async/await**

~28 `.then()/.catch()` chains. Convert where containing function is fire-and-forget.
Key candidates:
- `handleLateJoinState` (`.then()` on `decodeAndDecompress`)
- `handleSaveStateMsg` (same pattern)
- `sendInitialState` (already `async`)
- `fetchCachedState` (`.then()/.catch()` chain)
- WebRTC `createOffer`/`createAnswer` chains

- [ ] **Step 7: Apply optional chaining and destructuring**

- `window.EJS_emulator && window.EJS_emulator.gameManager` patterns → `?.`
- Repeated `gm && gm.Module` → `gm?.Module`
- Destructuring where it reduces repetition

- [ ] **Step 8: Commit**

```
git add web/static/netplay-lockstep.js
git commit -m "refactor: modernize netplay-lockstep.js to ES2022+ (preserve constructor/arguments traps)"
```

---

## Chunk 4: play.js and audio-worklet-processor.js (tasks 10-11)

### Task 10: play.js (3,046 lines)

**Files:**
- Modify: `web/static/play.js`

No known `this`/`arguments`/constructor traps in this file (it's the orchestrator, not a monkey-patcher). Standard transforms throughout.

- [ ] **Step 1: Convert variable declarations**

Sweep all `var` → `const`/`let`. Check for redeclarations.

- [ ] **Step 2: Convert function expressions to arrows**

~115 function expressions. All should be safe to convert (no `this`/`arguments` usage).
Keep the IIFE wrapper.

- [ ] **Step 3: Convert string concatenation to template literals**

Focus on status messages, toast messages, and DOM construction.

- [ ] **Step 4: Convert iteration patterns**

Traditional loops → `for...of` where index not needed.
`Object.keys().forEach()` → `Object.entries()`.

- [ ] **Step 5: Convert promise chains to async/await**

~18 `.then()/.catch()` chains. ROM loading, hash computation, fetch calls.

- [ ] **Step 6: Apply optional chaining and destructuring**

- EJS emulator access patterns → `?.`
- DOM element lookups where null-checked → `?.`

- [ ] **Step 7: Commit**

```
git add web/static/play.js
git commit -m "refactor: modernize play.js to ES2022+"
```

---

### Task 11: audio-worklet-processor.js (54 lines)

**Files:**
- Modify: `web/static/audio-worklet-processor.js`

- [ ] **Step 1: Modernize audio-worklet-processor.js**

Already mostly modern. Sweep for any remaining `var`. Note: runs in AudioWorklet scope — `class` syntax is already used. Minimal changes expected.

- [ ] **Step 2: Commit**

```
git add web/static/audio-worklet-processor.js
git commit -m "refactor: modernize audio-worklet-processor.js to ES2022+"
```

---

## Chunk 5: Final review and memory update (task 12)

### Task 12: Post-modernization review

- [ ] **Step 1: Run a grep for remaining `var ` declarations**

```bash
grep -rn '\bvar ' web/static/*.js
```

Expected: zero results (or only inside inline Worker strings / comments).

- [ ] **Step 2: Run a grep for remaining `.then(` chains**

```bash
grep -rn '\.then(' web/static/*.js
```

Expected: zero or near-zero (only cases where async/await wasn't feasible).

- [ ] **Step 3: Run a grep for string concatenation in console.log**

```bash
grep -rn "console\.log.*' +" web/static/*.js
```

Expected: zero results.

- [ ] **Step 4: Final commit if any cleanup needed**

```
git add web/static/
git commit -m "refactor: final cleanup pass for ECMAScript modernization"
```
