# Robust ROM Transfer Design

**Date:** 2026-03-24
**Scope:** Guest-side ROM transfer state machine in `web/static/play.js`

## Problem

The current ROM transfer has three bugs:

1. **Stall loop** — A 3s polling watchdog checks for 10s staleness, closes the DC, and
   hopes `onclose` triggers resume. If no new DC arrives, the guest sits in
   `_romTransferWaitingResume = true` forever with the watchdog still firing.
2. **No chunk caching** — When the host toggles sharing off/on, all received chunks are
   discarded and the transfer restarts from byte 0.
3. **Fragile resume** — Resume depends on the host re-initiating a DataChannel. If the
   host doesn't (e.g. sharing was toggled off then on), the guest waits indefinitely.

## Design

### State machine

Replace scattered boolean flags (`_romTransferInProgress`, `_romTransferWaitingResume`)
with a single `_romTransferState` string enum:

```
idle → receiving → paused → complete
         ↑            ↓
         └── resuming ←┘
```

**States:**

| State | Meaning |
|-------|---------|
| `idle` | No transfer. Chunks may or may not be cached. |
| `receiving` | DC open, chunks arriving, stall timer active. |
| `paused` | DC closed or host disabled sharing. Chunks preserved. Waiting for conditions to restart. |
| `resuming` | Guest re-requested transfer with cached offset. Waiting for new DC. |
| `complete` | ROM assembled, blob created. |

**Transitions:**

| From | Event | To | Action |
|------|-------|----|--------|
| `idle` | guest accepts sharing + DC arrives | `receiving` | Start stall timer |
| `receiving` | chunk arrives | `receiving` | Reset stall timer |
| `receiving` | `rom-complete` message | `complete` | Stop timers, assemble ROM |
| `receiving` | DC closes unexpectedly | `paused` | Stop stall timer, increment retry count |
| `receiving` | stall timeout (10s no chunks) | `paused` | Close DC, increment retry count |
| `receiving` | host disables sharing | `paused` | Close DC, stop timers |
| `receiving` | user cancels | `idle` | Close DC, stop timers, **clear chunks** |
| `paused` | host re-enables sharing | `resuming` | Emit `rom-accepted` with offset, start resume timeout |
| `paused` | auto-retry (if retries < max) | `resuming` | Short backoff, then emit `rom-accepted` with offset |
| `paused` | user cancels | `idle` | **Clear chunks** |
| `resuming` | new DC arrives | `receiving` | Send `rom-resume` with offset, start stall timer |
| `resuming` | resume timeout (15s) | `paused` | Increment retry count, show toast |
| `complete` | `onGameEnded` | `idle` | Full cleanup via `resetRomTransfer()` |
| any | `onGameEnded` | `idle` | Full cleanup via `resetRomTransfer()` |

### Chunk caching rules

Chunks are **only cleared** when:
1. User explicitly cancels the transfer.
2. A new `rom-header` arrives with a different hash or size (host changed ROM).

Chunks are **preserved** across:
- Stall timeouts
- DC closures
- Host toggling sharing off/on
- Max retry exhaustion (guest stays in `paused` with chunks intact)

This means if the host re-enables sharing 5 minutes later, the guest resumes from
where it left off without re-downloading.

### Stall detection

Replace the 3s `setInterval` watchdog with a single `setTimeout` that resets on every
received chunk:

```
on chunk received:
    clearTimeout(_romTransferStallTimer)
    _romTransferStallTimer = setTimeout(onStall, 10000)

onStall:
    close DC
    transition to paused
    if retries < 3:
        schedule auto-retry after 2s backoff
    else:
        stay paused, show "ROM transfer stalled — cancel or wait for host"
```

No more interval polling. No more checking `_romTransferWaitingResume` inside a loop.

### Resume flow

When transitioning to `resuming` (from `paused`):

1. Guest emits `rom-accepted` via Socket.IO `data-message` with `{ type: 'rom-accepted', sender: socket.id }`.
2. Start a 15s resume timeout. If no DC arrives, fall back to `paused`.
3. Host receives `rom-accepted`, creates a DC with `_waitForResume = true` (existing pattern in `startRomTransferTo`).
4. Guest receives the new DC in `onExtraDataChannel`, transitions to `receiving`, and sends `rom-resume` with the cached byte offset over the DC.
5. Host receives `rom-resume` and calls `sendRomOverChannel(dc, peerSid, offset)`.

This is the existing two-step resume dance — no new protocol fields needed.

### Clean cancellation and cleanup

Two cleanup functions:

**`cancelRomTransfer()`** — user-initiated cancel (clears chunks):

```
function cancelRomTransfer():
    close _romTransferDC if open
    clearTimeout(_romTransferStallTimer)
    clearTimeout(_romTransferResumeTimer)
    clearInterval(_romAcceptPollInterval)
    clear _romTransferChunks
    clear _romTransferHeader
    _romTransferBytesReceived = 0
    _romTransferRetries = 0
    _romTransferState = 'idle'
    update UI
```

**`resetRomTransfer()`** — game-end cleanup (called by `onGameEnded`):

Same as `cancelRomTransfer()`. Consolidates the inline cleanup currently in
`onGameEnded` (lines 484-495) so all timer/state teardown goes through one path.
`onGameEnded` replaces its inline cleanup with a single `resetRomTransfer()` call.

### Variables

**Remove:**
- `_romTransferInProgress` — replaced by state check (`state === 'receiving'` or `'resuming'`)
- `_romTransferWaitingResume` — replaced by state check (`state === 'resuming'`)
- `_romTransferResumeAttempts` — renamed to `_romTransferRetries`
- `_romTransferWatchdog` — replaced by `_romTransferStallTimer`

**Add:**
- `_romTransferState` — `'idle' | 'receiving' | 'paused' | 'resuming' | 'complete'`
- `_romTransferStallTimer` — setTimeout ID
- `_romTransferResumeTimer` — setTimeout ID
- `_romTransferRetries` — number, capped at 3 for auto-retry

**Keep unchanged:**
- `_romTransferChunks`, `_romTransferHeader`, `_romTransferDC`
- `_romTransferDCs` (host-side sender channels)
- `_romTransferBytesReceived`, `_romTransferLastChunkAt`
- `_romSharingEnabled`, `_romSharingDecision`
- `_romAcceptPollInterval`

### UI mapping

The `updateRomSharingUI()` function maps states to display:

| State | UI |
|-------|----|
| `idle` (no chunks) | Drop zone or accept/decline prompt |
| `idle` (has chunks) | Drop zone or accept/decline prompt |
| `receiving` | Progress bar |
| `paused` | Progress bar with "paused" text + cancel button |
| `resuming` | Progress bar with "reconnecting..." text + cancel button |
| `complete` | "Loaded" state in drop zone |

### Required changes to existing functions

**`onRomSharingUpdated`** (line 517): When host disables sharing and we're mid-transfer,
the current code clears chunks (`_romTransferChunks = []`). This must change to preserve
chunks — only close the DC and transition to `paused`. Chunks are preserved so that when
sharing is re-enabled, we resume from the cached offset.

**`startPreGameRomTransfer`** (line 770): Currently has no `onmessage` handler for
`rom-resume` and always starts from byte 0. Add an `onmessage` handler on the DC that
listens for `rom-resume` messages (same pattern as `startRomTransferTo` lines 863-872),
and add `_waitForResume` support so pre-game resume works.

**`onPeerReconnected`** (~line 1643): Currently checks `_romTransferWaitingResume`. Must
be updated to check `_romTransferState === 'paused'` instead.

**`onGameEnded`** (~line 484): Replace inline ROM cleanup with `resetRomTransfer()` call.

### Resume approach

Keep the existing two-step resume dance: host creates DC with `_waitForResume = true`,
guest sends `rom-resume` with offset over the DC once it opens. This already works in
`startRomTransferTo` and avoids complicating the `rom-accepted` data-message protocol.
No `resumeOffset` field needed in `rom-accepted`.

### What doesn't change

- **`sendRomOverChannel`** — Already supports `startOffset`. No changes.
- **Server-side signaling** — No changes to `signaling.py`.
- **`registerRomSignalHandler`**, **`cleanupPreGameConnections`** — Unchanged.
- **`finishRomTransfer`** — Assembly logic is fine; just called from the `receiving → complete` transition.
- **`afterRomTransferComplete`** — Post-transfer boot logic unchanged.

### Edge cases

- **Host changes ROM mid-transfer:** New `rom-header` has different hash/size → clear chunks, restart from 0.
- **Guest refreshes page:** All in-memory state lost. Fresh accept → fresh transfer. By design.
- **Multiple stalls in a row:** Each stall increments retry count. After 3 auto-retries, guest stays `paused`. Manual cancel or host action required.
- **Host toggles off during `resuming`:** Cancel resume timeout, transition to `paused`.
- **`sendRomOverChannel(dc, peerSid, 0)`:** The `!startOffset` check treats 0 as falsy, so offset 0 sends the header (fresh start). This is correct — a resume from byte 0 is equivalent to a fresh transfer.
- **Peer reconnect during paused state:** `onPeerReconnected` sees `state === 'paused'`, host creates new DC with `_waitForResume = true`, guest sends `rom-resume` on DC open.
