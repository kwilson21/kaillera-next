# Coordinated Lockstep Roster

## Problem

In the current lockstep implementation, each player independently discovers which
peer slots are active based on their own WebRTC DataChannel state. When a player
joins or leaves, different players may start/stop including that slot's input at
different frames. Any disagreement = permanent desync.

Example from real session: P3 late-joins, P0/P2/P3 exchange inputs correctly, but
P1's DC to P3 dies and never recovers. P1 runs the entire game writing zero for
slot 3 while everyone else applies P3's real inputs. The game states diverge
immediately and permanently.

## Design

### Core Invariant

**All players must agree on exactly which slots are active on every frame.**

The host (slot 0) is the sole authority. It broadcasts the full active slot list
over DataChannels whenever the roster changes. Every player applies the roster at
the specified frame, regardless of their individual DC state. If a player has no
DC to a newly-added slot, it fabricates zeros for that slot — but so does everyone
else who can't reach that peer, and the roster itself is consistent.

### Roster Message

Sent by host over DC to all peers. Idempotent — contains the full state, not a diff.

```
roster:<frame>:<slot>,<slot>,...
```

Example: `roster:4772:0,1,2,3` means "from frame 4772 onward, slots 0/1/2/3 are active."

`_activeRoster` includes the local player's slot (the complete set of all player
slots). `getInputPeers()` naturally returns only the remote subset since the local
player is not in `_peers`.

### Data Flow

#### Game Start (normal 2P+ join)

No change. All players are present before lockstep starts. The initial roster
is implicitly the set of all connected players when `startLockstep()` runs.
The host broadcasts the initial roster in `startLockstep()` so every player
has an explicit authoritative baseline.

#### Late-Join

Current flow (unchanged):
1. Late joiner connects, boots emulator, sends `request-late-join`
2. Host captures state at frame X, pauses lockstep, sends `late-join-pause` to all peers
3. Host sends state to late joiner via Socket.IO
4. Late joiner loads state, starts lockstep, sends `late-join-ready`
5. Host resumes, sends `late-join-resume` to all peers

New addition — between steps 2 and 3:
- Host broadcasts `roster:X:0,1,2,3` to all peers via DC
- All peers apply the roster immediately (see Frame Semantics below)

This means even if P1 has no DC to P3, P1 starts including slot 3 (zeros) at
exactly frame X. Once P1's DC to P3 forms (via mesh heal or reconnect), real
inputs replace zeros. But the roster was always consistent across all players.

#### Player Disconnect

Current flow has each player independently removing the dropped peer from their
roster when their own DC dies. This causes frame disagreement.

New flow:
1. Host detects a player has permanently dropped (DC dies → reconnect fails →
   `hardDisconnectPeer` fires on host)
2. Host broadcasts `roster:Y:0,1,2` (without the dropped slot) to all peers
3. All peers apply the roster immediately (see Frame Semantics below)
4. Until peers receive the roster update, they continue fabricating zeros for
   the dropped slot — this is fine because everyone fabricates the same value

**Non-host disconnect detection**: When a non-host player's DC to another peer
dies, it does NOT modify the roster. It continues including that slot (fabricating
zeros as needed via the existing phantom/stall-timeout mechanism) until the host
broadcasts an updated roster.

#### Host Disconnect

If the host disconnects, the game is already over for all players — no one can
get slot 0's input. This is the existing behavior and doesn't change.

### Frame Semantics

When a roster message arrives with frame F:
- If `F <= _frameNum` (current frame): apply immediately on the next tick.
  This is the normal case — the host sends the roster after pausing, and peers
  are at or past the pause frame by the time they receive it.
- If `F > _frameNum`: apply when `_frameNum` reaches F. This handles the edge
  case where the roster arrives before the peer has advanced to that frame.

Since the late-join pause freezes all peers, and fabrication always produces
zeros, the exact application frame doesn't affect determinism — every player
writes the same values. The frame number primarily serves as a log correlation
aid for debugging.

### Roster Delivery on Reconnect

When a peer reconnects (DC transitions to open after a reconnect), the host
re-sends the current roster to that peer. This happens in the DC `onopen`
callback: if the host has an `_activeRoster`, it sends it immediately.

This ensures that a peer who missed a roster update during their disconnection
period gets the current state without waiting for the next roster change.

### Implementation Changes

#### New State: `_activeRoster`

Replace `_peerInputStarted` as the source of truth for which slots are active.

```javascript
let _activeRoster = null;  // Set<number> of active slots, null until first roster received
```

When `_activeRoster` is null (pre-game), the existing `_peerInputStarted`
behavior applies. Once the first roster is received, `_activeRoster` is the
sole authority.

#### `getInputPeers()` Change

Currently filters by DC state and `_peerInputStarted`. New behavior when
`_activeRoster` is set:

Returns all peers whose slot is in `_activeRoster`, regardless of DC state
or `_peerInputStarted`. The `reconnecting` flag is NOT used to exclude peers
from the roster — a reconnecting peer's slot still gets zeros written to
the emulator. The stall/fabrication path handles missing input for roster
slots that have no working DC:
- If a roster slot has no DC and no buffered input → stall timeout fires →
  fabricate zeros (existing mechanism)
- This is identical behavior across all players since everyone has the same
  roster and everyone fabricates the same value (zero)

#### Roster Message Handling (all players)

On receiving `roster:<frame>:<slots>` via DC:
1. Parse the slot list into a Set
2. Set `_activeRoster`
3. Log the roster change with frame number and slot list
4. Also log in the periodic INPUT-LOG for post-mortem comparison

#### Host Roster Broadcasting

The host broadcasts the roster:
- In `startLockstep()` — initial roster for all connected players
- In `sendLateJoinState()` — updated roster including the new slot
- In `hardDisconnectPeer()` — updated roster excluding the dropped slot
- In the DC `onopen` callback — re-send current roster to reconnected peer

#### Input Application Change

The zero-slot-clearing loop changes from "zero slots not in inputPeers" to
"zero all 4 slots, then overwrite with actual input for the local slot and
each roster peer that has input." This is simpler and ensures consistency:
every slot is either written from real input or zeroed, with no conditional
checks on peer state.

#### `hardDisconnectPeer()` Change (non-host)

Non-host players no longer remove `_peerInputStarted` or modify the roster
when a peer disconnects. The peer transitions to phantom/fabricating state
(existing behavior) and the slot stays in the roster until the host says
otherwise. Input is fabricated as zeros — identical on all players.

#### `hardDisconnectPeer()` Change (host)

Host computes the new roster (all remaining connected player slots), broadcasts
it, then removes the peer from `_peers` as before.

### Dual Source of Truth: `_knownPlayers` vs `_activeRoster`

`_knownPlayers` is populated from `users-updated` (server-pushed). It
reflects room membership — who the server says is in the room.

`_activeRoster` is populated from roster messages (host-pushed via DC). It
reflects the lockstep input set — which slots participate in the game loop.

These serve different purposes:
- `_knownPlayers` drives mesh health checks and WebRTC connection initiation
- `_activeRoster` drives input application and the deterministic game loop

A player can be in `_knownPlayers` but not in `_activeRoster` (just joined,
hasn't been added to roster yet). A player can be in `_activeRoster` but
removed from `_knownPlayers` (server processed the leave before the host's
roster update arrives). Both cases are handled correctly by the design.

### Mesh Health Check

The periodic mesh health check (every 300 frames / ~5s) remains. It
reconciles `_knownPlayers` against actual DC state and re-initiates
connections to missing/zombie peers. This is the self-healing layer that
gets DCs working so real inputs can flow, but it does not affect the
roster — the roster is set by the host.

### What Doesn't Change

- WebRTC signaling (offers, answers, ICE candidates)
- DataChannel setup and message format
- Input encoding/decoding (16-byte binary frames)
- Late-join state transfer mechanism (Socket.IO for large payloads)
- Spectator handling (completely separate path)
- Frame pacing and FRAME-CAP logic
- The server — no gameplay changes on the server side
