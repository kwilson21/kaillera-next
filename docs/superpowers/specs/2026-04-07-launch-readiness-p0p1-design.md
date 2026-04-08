# Launch Readiness P0-2 + P1 — Design Spec (Retrospective)

**Date:** 2026-04-07
**Status:** Shipped (commits fccccaf, f9debbc)
**Owner:** Kazon
**Tracks:** P0-2, P1-3, P1-4, P1-5, P1-6 in `project_launch_readiness_plan`
**Companion:** P0-1 spec at `2026-04-07-reliability-funnel-telemetry-design.md`

## Why retrospective

P0-1 had a full design doc because the work scope and three mid-flight pivots warranted one. The P1 items in this commit are smaller targeted UX fixes from the same launch-readiness audit, and were shipped directly from the audit findings without a separate brainstorm phase. This doc captures the design and verification after the fact so the launch-readiness work has a complete paper trail.

## Source

All five items below are documented findings from the 2026-04-07 launch-readiness audit (see `memory/project_launch_readiness_plan.md`). The audit identified specific code locations and concrete fix recommendations; this spec captures how each was implemented.

## P0-2: feedback FAB z-index

**Problem.** The feedback floating-action-button used `z-index: 99999` and the modal backdrop used `z-index: 100000`. The error modal uses `z-index: 300`. Result: when the error modal appeared (e.g., "Failed to create room"), the feedback FAB still floated above it and intercepted clicks meant for the "Back to Lobby" button. The audit flagged this as a launch-blocking UI bug.

**Fix.** Two CSS lines in `feedback.js`:
- `.kn-feedback-fab` z-index `99999` → `150` (above toolbar but well below error modal at 300)
- `.kn-feedback-backdrop` z-index `100000` → `301` (just above the error modal)

**Verification.** Playwright `getComputedStyle(fab).zIndex === '150'`.

## P1-3: User-facing surfaces for currently-silent failures

**Problem.** The audit found three "silent failure" cases where the user is left on a stuck spinner with no feedback because errors fire telemetry events but never reach the UI:
- shared.js:183 — `waitForEmulator` 30s timeout fires `KNEvent('wasm-fail')` but no toast
- play.js — ROM hash computation has no timeout and no `FileReader.onerror` handler
- netplay-lockstep.js / play.js — generic "Connection timed out" toast hides specific WebRTC failure reasons

**Fix.**

1. **Cross-module UI surfacing.** Exposed `window.knShowToast` and `window.knShowError` from play.js after their definitions. shared.js can now call them directly without event-bus plumbing. This hook will be reused for future silent-failure surfacing in other modules.

2. **Emulator boot timeout.** When `waitForEmulator` rejects (after 30s of polling without seeing `gameManager.Module`), in addition to the existing `wasm-fail` telemetry, now opens the error modal with a user-friendly message via `window.knShowError`. The player gets a "Back to Lobby" button instead of being stuck on a dead spinner.

3. **ROM hash timeout + onerror.** Wraps the FileReader + `hashArrayBuffer` call in:
   - A 15-second timeout that aborts the reader and shows a toast (`'ROM hash failed — try a smaller ROM or different browser'`) plus emits `KNEvent('compat', ..., {size})`
   - A `FileReader.onerror` handler that fires `KNEvent('compat', ...)` and shows `'Could not read ROM file — try dropping it again'`
   - A `try/catch` around `hashArrayBuffer` that fires `KNEvent('compat', ...)` and shows `'ROM hash failed — game may not work'`
   - A `_hashTimedOut` flag prevents the success path from running after the timeout

4. **Specific WebRTC failure reasons.** The 30-second connection-timeout handler in play.js now inspects each peer's `pc.connectionState`:
   - 0 peers in `KNState.peers` → "No peers connected" / "the other players never showed up — they may have left or the signaling server is unreachable"
   - any peer with state `failed` → "WebRTC connection failed" / "N of M peer connection(s) failed (likely NAT/firewall — try a different network or enable a TURN server)"
   - any peer in state `new`/`connecting` → "WebRTC handshake stalled" / "N of M peer connection(s) stuck in N state — ICE may not be reaching candidates"
   - Also fires `KNEvent('webrtc-fail', reason, {states})` so the funnel timeline shows the specific reason as a row

**Verification.** Playwright confirms `window.knShowToast` and `window.knShowError` are both defined globally on play.html. End-to-end emulator-boot-timeout is hard to trigger in a 30-second test, so deployment-level verification only.

## P1-4: users-updated race — investigated and dismissed

**Audit claim.** "Fix `users-updated` race at play.js:687 — listener must register before join-room emission. Symptom: stuck overlay, blank player list."

**Investigation.** Read the join flow end-to-end:
- play.js:370 registers `socket.on('users-updated', onUsersUpdated)` synchronously inside `connect()`
- `connect()` is called at play.js:4377, near the end of the IIFE
- All `const` declarations including `onUsersUpdated` (line 745) are evaluated before line 4377 runs, so the binding is defined when `socket.on` fires
- The `socket.emit('open-room')` (line 451) and `socket.emit('join-room')` (line 498) both happen inside `onConnect()`, which is triggered by the async `connect` event
- By the time the server processes either emit and broadcasts `users-updated`, the client listener is in place

**Verdict.** Not reproducible in current code. The audit likely referred to an earlier state of the file or made an incorrect inference about line numbering. Marked dismissed in the launch-readiness plan. If a real race surfaces in the new funnel telemetry data (e.g., a session with `room_created` and `peer_joined` but a stuck pre-game overlay), revisit.

## P1-5: ROM transfer toast consolidation

**Problem.** A single ROM transfer fired up to 11 separate `showToast()` calls (cancelled, retrying, interrupted retry n/3, stalled, resume timed out, transfer failed, etc.) — each appearing for 2.7 seconds and disappearing. The audit called this "noise" and recommended consolidating into a single persistent progress UI.

**Fix.** Added `setRomTransferState(state, message)` helper that updates the existing `#rom-transfer-progress` DOM element in place:

| State | Border | Retry button | Notes |
|---|---|---|---|
| `receiving` | none | hidden | normal in-progress |
| `paused` | yellow | hidden | DC closed mid-transfer |
| `retrying` | blue | hidden | auto-retry in flight |
| `stalled` | yellow | shown | manual retry needed |
| `failed` | red | shown | transfer aborted (with reason in message) |
| `idle` | none | hidden (element hidden entirely) | success or cancelled |

Replaced 11 `showToast(...)` call sites that fired during transfers with `setRomTransferState(state, message)`. Success case (`afterRomTransferComplete`) sets state to `idle` since the existing `#rom-status` element above the progress UI already shows "Loaded: <name>".

The progress UI keeps the existing progress bar (`updateRomProgress`) and Retry/Cancel buttons. The state helper just adds the colored border + button visibility logic on top.

**Note on what's intentionally NOT consolidated:** ROM hash errors from P1-3b stay as toasts because they're terminal one-shot errors during initial ROM load, not transfer state transitions. They don't belong in the transfer progress UI.

**Verification.** Deployment-level only — full ROM transfer test would need a 2-player session in Playwright with one peer dropping a ROM. Code review confirms each `showToast` call site that mentioned "ROM transfer" has been migrated.

## P1-6: Phantom-peer notifications → persistent corner status

**Problem.** When a peer becomes unresponsive during gameplay, the lockstep engine fires `kn-peer-phantom` and play.js flashes a center-screen toast: `"{name} is unresponsive — continuing without them"`. Two seconds later it disappears. If the peer recovers, another flash. The audit called this exactly the "more distracting than helpful" experience the user wanted to fix.

**Fix.** Replaced both `kn-peer-phantom` and `kn-peer-recovered` event handlers with a persistent corner indicator:

- New element `#kn-peer-status` injected at `position: fixed; top: 64px; right: 12px; z-index: 120`
- Per-peer entry: a small dark pill with a colored dot (red for unresponsive), label `"P{slot}"` plus optional player name plus the state (`unresponsive`)
- `_peerStatusEntries` is a `Map<slot, {name, state}>` — adds on phantom, removes on recover
- When the map is empty, the indicator's innerHTML is empty (effectively invisible without removing the DOM element)
- Multiple disconnected peers stack vertically in the corner

**Label dedup edge case.** Initial implementation rendered `"P2 P2 unresponsive"` when no player name was known because the slot prefix and the `P${slot}` fallback name collided. Followup commit (`f9debbc`) drops the fallback name entirely — when no name is known the label is just `"P2 unresponsive"`; with a name it's `"P2 jimmy unresponsive"`.

**Verification.** Playwright behavioral test dispatched `kn-peer-phantom` and `kn-peer-recovered` events directly:
1. Phantom slot 2 → `"P2 unresponsive"` (1 child)
2. Phantom slot 3 → `"P2 unresponsive" + "P3 unresponsive"` (2 children, stacked)
3. Recover slot 2 → `"P3 unresponsive"` (1 child)
4. Recover slot 3 → empty (0 children)

All four assertions passed.

## What's NOT in this work

- The 4 P2 items in the launch readiness plan (data-driven top-3, mobile dvh/svh, play.js listener cleanup, mobile rollback gating). These wait for funnel telemetry data to drive priorities.
- P3-11 dev/ui.html harness — post-launch enabler.
- Any reliability *fix* that wasn't in the audit. Resist scope creep.

## Verification summary

| Item | Verification | Result |
|---|---|---|
| P0-2 | Playwright `getComputedStyle(fab).zIndex` | `'150'` ✓ |
| P1-3 (cross-module hooks) | Playwright `typeof window.knShowError` | `'function'` ✓ |
| P1-3 (boot timeout) | Code review only — 30s real-time test impractical | deployed |
| P1-3 (ROM hash timeout) | Code review — try/catch + onerror + 15s timer all in place | deployed |
| P1-3 (WebRTC reasons) | Code review — peer state inspection + KNEvent fire | deployed |
| P1-4 | Code reading — listener registered before emit confirmed | dismissed |
| P1-5 | Code review — all 11 transfer toast sites migrated | deployed |
| P1-6 | Playwright dispatched events → checked DOM after each | full E2E ✓ |

## Estimated cost vs actual

Original audit listed P1-3, P1-4, P1-5, P1-6 as separate items. Bundling P0-2 made it 5 items. Total time: ~2 hours including playwright verification rounds and the P1-6 label dedup followup. P1-4 dismissal was the cheapest item (read-only investigation).
