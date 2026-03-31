# Mobile Share Button & Compact Virtual Gamepad

**Date:** 2026-03-31
**Status:** Approved

## Problem

1. **Share button missing on mobile:** The toolbar Share button is not visible on iPhone in portrait mode. The `flex-wrap` + `flex: 1` spacer layout causes the share-wrapper to be squeezed out between the spacer and other buttons. Users cannot invite others to their game from mobile.

2. **Clipboard copy forces browser minimization:** The current share implementation copies links to the clipboard, requiring users to leave the browser (switch to Messages, etc.) to paste and send the link. This disrupts the WebSocket/Socket.IO connection and causes the server to enter a bugged state.

3. **Game canvas too small on mobile:** The virtual gamepad occupies ~60% of the screen in portrait mode, leaving only ~30% for the game canvas. Excessive padding, gaps, and margins in the gamepad layout waste vertical space.

## Design

### Feature 1: Mobile Share Button (Web Share API)

**Toolbar Share visibility fix:**
- Ensure the Share button is visible in the toolbar on all viewports: desktop, mobile portrait, and mobile landscape.
- Root cause: the `.toolbar-spacer` with `flex: 1` between the status text and the share-wrapper pushes subsequent items in a way that the share button gets lost during flex-wrap on narrow screens.
- Fix: restructure toolbar flex layout so Share is always visible. Options include removing the spacer's effect on the share button, or grouping the action buttons to ensure they wrap as a unit.

**Native share on mobile:**
- On mobile devices (detected via `navigator.share` availability), tapping the share options invokes `navigator.share()` instead of `navigator.clipboard.writeText()`.
- `navigator.share()` opens the native OS share sheet (iOS/Android), allowing the user to share via Messages, AirDrop, WhatsApp, etc. without leaving the browser.
- The share payload:
  - `title`: "Join my game on Kaillera Next" (play) or "Watch my game on Kaillera Next" (watch)
  - `url`: the play or watch link
- Button labels update on mobile: "Copy Play Link" → "Share Play Link", "Copy Watch Link" → "Share Watch Link".
- `navigator.share()` rejection handling: silently catch `AbortError` (user dismissed the share sheet). Only surface unexpected errors via toast.

**Desktop behavior unchanged:**
- Desktop continues using clipboard copy with the "copied!" toast. Button labels stay "Copy Play Link" / "Copy Watch Link".

**Fallback:**
- If `navigator.share()` is not available (older browsers, non-HTTPS), fall back to clipboard copy with "Copy" labels.

### Feature 2: Compact Virtual Gamepad (Portrait)

**Goal:** Maximize game canvas vertical space by reducing the virtual gamepad's footprint while maintaining usable touch targets.

**CSS changes (portrait mode):**

| Property | Current | Proposed |
|---|---|---|
| VGP container padding | `4px 16px` | `2px 8px` |
| Column padding-top | `12px` | `4px` |
| Column padding-bottom | `4px` | `2px` |
| Column gap | `8px` | TBD (target: 2-4px, validated via device test) |
| Stick top margin | `28px` | TBD (target: 4-8px, validated via device test) |
| Shoulder bar margin-bottom | implicit | `2px` |
| Start row padding | `4px 0` | `2px 0` |
| Z button translateY | `-34px` | Removed (Z moves to Start row) |

**Z button repositioning (portrait):**
- Currently: Z is in the right column inside `.vgp-z-portrait` which has `pointer-events: none !important` on the wrapper (the Z button itself gets pointer-events via `#virtual-gamepad * { pointer-events: auto }`). The wrapper uses `transform: translateY(-34px)` to float above the start area.
- Proposed: Z moves to the right of the Start button in the `.vgp-start-portrait` row at the bottom of the gamepad grid. The `.vgp-z-portrait` wrapper is removed entirely — Z becomes a sibling of Start in the same flex row. No `pointer-events: none` wrapper needed. This is cleaner and saves the 34px of negative transform space.

**Touch target minimums:**
- All interactive elements remain at usable sizes. Exact minimum sizes will be validated using the VGP 100-device visual test (25 devices × 4 variants) during implementation.
- The existing `clamp()` system with svh units handles responsive scaling — we're adjusting the spacing/margins around controls, not the controls themselves.

**Expected result:** Canvas grows from ~30% to ~40-45% of screen height on a standard iPhone.

### Feature 2b: Compact Virtual Gamepad (Landscape)

Deferred to a follow-up task. Landscape already uses design tokens and is less constrained on space. Portrait compaction is the priority; landscape can be tuned separately after validating portrait changes with the device test.

### Toolbar compaction

- Shorten the room code display (drop "Room:" prefix in `play.js` string literal, just show the code).
- Ensure all toolbar buttons (Share, Info, Remap, Leave, End) fit on a single row on mobile.
- The status text ("Connected -- game on!") is already intentionally suppressed to avoid wrapping; this stays.

## Files to modify

- `web/static/play.js` — Share button click handler: add `navigator.share()` path for mobile
- `web/static/play.css` — Toolbar layout fix for Share visibility; toolbar compaction
- `web/static/virtual-gamepad.js` — Portrait mode CSS: padding, gaps, margins, Z repositioning; landscape mode compaction

## Validation

- VGP 100-device visual test (`tests/vgp-device-test.mjs`) for gamepad layout across 25 devices
- Manual test on real iPhone (user's device) for share sheet behavior
- Playwright screenshot for toolbar visibility on mobile viewports

## Out of scope

- ROM caching bug (confirmed as TURN server bandwidth issue, not a code bug)
- Toolbar redesign beyond compaction
- Virtual gamepad overlay mode (controls on top of canvas)
- Landscape-specific Z button repositioning (landscape already handles Start+Z in the right panel)
