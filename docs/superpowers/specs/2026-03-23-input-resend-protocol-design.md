# Input Resend Protocol — Design Spec

## Problem

The lockstep engine's `MAX_STALL_MS = 3000` timeout fabricates inputs when a peer's input is missing for 3 seconds. Different players can fabricate different values (`_lastKnownInput[slot]` varies due to network timing), causing game states to diverge.

Confirmed in session H8J33NHV: 3-player game with mobile guest running 57-90 fps vs desktop at 100-180 fps. Desktop players repeatedly timed out waiting for slot 2's input and fabricated `s2=0`. Game states diverged visually.

## Solution

Replace single-stage fabrication with a two-stage timeout: request the missing input from the peer first, only fabricate (with deterministic value 0) if the resend also fails.

## File

`web/static/netplay-lockstep.js` — all changes are in this one file.

## New DC message

**Request:** `"resend:<frame>"` — string, sent to the peer whose input is missing.

**Response:** Existing 8-byte `Int32Array([frame, mask])` binary format. No new message type on the response side — indistinguishable from a normal input send. Receivers already handle duplicates (overwrite with same value).

## Two-stage timeout

```
stall starts (0s)
  └─ stage 1: stall + retry via setTimeout(1)  [existing behavior]
       │
  3s (MAX_STALL_MS) hit
  └─ send "resend:<frame>" to each missing peer's DC (once)
  └─ stage 2: continue stalling + retry via setTimeout(1)
       │
  5s (MAX_STALL_MS + RESEND_TIMEOUT_MS) hit
  └─ fabricate 0 for all missing slots, advance frame
```

**Constants:**
- `MAX_STALL_MS = 3000` — unchanged, triggers resend request
- `RESEND_TIMEOUT_MS = 2000` — new, hard deadline after resend request

**Deduplication:** Send the resend request only once per stall by checking `stallDuration < MAX_STALL_MS + 50` (the request fires in the narrow window when we first cross the threshold).

## Resend handler

In the `onmessage` string message block, add handling for `"resend:<frame>"`:

1. Parse the frame number from the message
2. Look up `_localInputs[frame]`
3. If found, send the 8-byte `Int32Array([frame, mask])` back over the same DC
4. If not found (already cleaned up), do nothing — requester hits hard timeout

## Fabrication change

When the hard timeout fires, fabricate **0** for all missing slots. Never use `_lastKnownInput[slot]` — it can differ across players. Every player independently computes 0, so game states stay in agreement even during fabrication.

## What doesn't change

- Stage 1 stall behavior (0–3s) is identical to today
- Input sending format (8-byte binary) unchanged
- Input receiving/parsing unchanged
- `_localInputs` cleanup timing unchanged (deleted at apply time, line 2358)
- No server-side changes
- No new state variables — use `_stallStart` to derive which stage we're in
