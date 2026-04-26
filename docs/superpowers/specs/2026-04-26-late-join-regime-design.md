# Late-join regime by host game phase

**Date:** 2026-04-26
**Status:** design

## Problem

When a player joins a public room mid-match, today's flow pauses every active
peer's tick loop while the host serializes and sends a save state. The pause
itself is fine for v1 — public lobbies imply "if you have the link, you can
join" and a 1–2s freeze is acceptable. Three things are not fine:

1. **The pause is invisible.** Active players see a frozen game with no UI.
   They don't know what's happening or how long it'll last. In one observed
   session two iPhones froze for ~15s; a generic disconnect toast eventually
   appeared and play resumed without any explanation that someone was joining.

2. **The joiner shows opaque "Loading…" with no stages.** Connecting, state
   transfer, decompression, and emulator boot all hide behind one spinner.
   When something goes slow, every second feels like a hang.

3. **Mid-match join produces a "live" player whose inputs do nothing.**
   SSB64 and Smash Remix bake the match roster at character select. If P1+P2
   started a match and you join as P3 mid-match, the save state has no P3
   character to control. Inputs are perfectly delivered to the engine; there's
   nothing in-game to move. This was the root cause of the "loaded but inputs
   didn't work" symptom in the observed session.

The 15s `LATE_JOIN_TIMEOUT_MS` failsafe ([netplay-lockstep.js:425](web/static/netplay-lockstep.js#L425))
fires when the joiner can't complete in time, force-resumes everyone, and
leaves the joiner half-initialized. That is what produced the disconnect-toast
behavior and the half-working third instance.

## Approach

Pick the late-join regime from the host's current game phase, read at the
moment the late-join request arrives. The host already exposes phase via
`_readMenuLockstepPhase()` ([netplay-lockstep.js:1425](web/static/netplay-lockstep.js#L1425)),
which returns `{gameStatus, sceneCurr, inControllableMenu, gameplay, ...}`.

**One predicate decides the regime:** `phase.gameplay === true` (i.e.
`sceneCurr === 22 && gameStatus === 1`) means a match is actively running.
Anything else — title, mode select, CSS, stage select, results — is a safe
boundary.

`_readMenuLockstepPhase` short-circuits on `_isSmashRemix() === false`
(returns `gameplay: false`), so non-Smash games naturally fall to "safe
boundary" without an extra gate. The flow chart below shows the explicit
`_isSmashRemix()` check for clarity, but it's the same code path as
`phase.gameplay === false`.

Two regimes:

### Regime A — CSS / safe menu (player path)

- Joiner connects as a player.
- Existing `request-late-join` → `late-join-pause` → `late-join-state` →
  `late-join-resume` flow runs.
- Pause is brief because peers are at a menu, not in active gameplay; the
  visible "freeze" is at most a CSS that pauses for 1–2s.
- After state applies, joiner's controls activate.
- This is today's path with better UX (see §UX).

### Regime B — Mid-match (spectator path)

- Joiner is **demoted on the server** from `room.players` to
  `room.spectators` so the room state matches reality (see §Server-side
  state transitions). Existing slot is freed.
- Existing spectator canvas-stream from host
  ([netplay-lockstep.js:4868](web/static/netplay-lockstep.js#L4868),
  `_hostStream = captureCanvas.captureStream(0)`, attached per-peer in
  `startSpectatorStreamForPeer` at
  [netplay-lockstep.js:4908](web/static/netplay-lockstep.js#L4908), called from
  the new-peer branch at [netplay-lockstep.js:2724](web/static/netplay-lockstep.js#L2724))
  carries the live video. No emulator boots on the joiner; no save-state
  pause hits active peers.
- Joiner's gamepad and virtual-gamepad UI are dimmed/hidden with a clear
  status message: "Watching current match — controls activate at next
  character select."
- Local input is intentionally ignored at the input layer (already true for
  spectators today).
- When the active match ends and the host's `phase.gameplay` flips from true
  to false (results screen → CSS), the host runs a "promote spectator →
  player" flow that uses the existing player path: brief pause, state
  transfer, controls enable. Joiner sees "Joining match…" → "Controls
  enabled."

Reconnect is **not** late-join. The server already detects returning players
by `persistent_id` in the `join-room` handler ([signaling.py:475–488](server/src/api/signaling.py#L475))
and `_swap_sid` ([signaling.py:260](server/src/api/signaling.py#L260)) restores
their slot before the join completes. A reconnect therefore never reaches
the host's `request-late-join` handler with a regime decision — the flow
already short-circuits server-side. No `priorSlot` field is needed on
`request-late-join`; the regime check applies only to genuinely new
joiners.

### Game-detection fallback

`_readMenuLockstepPhase` is gated on `_isSmashRemix()`. For non-SSB64 games
the predicate returns `gameplay: false` even when a match is running, which
would incorrectly send mid-match joiners down the player path. Until we have
per-game phase reads, **non-Smash games default to today's behavior**: route
new joiners through the player path with pause-and-load. The "regime by
phase" logic only activates when `_isSmashRemix()` is true. This is a
conservative default; it preserves existing behavior for unsupported games.

## State transitions

```
        late-join request arrives at host
                      │
        (reconnects don't reach here; server short-circuits via persistent_id)
                      │
                      ▼
            phase.gameplay === true ?
              ┌─false─┘   └─true─┐
              ▼                   ▼
         player path        spectator path
              │                   │
              ▼                   ▼
     pause+state+resume    server demotes player → spectator
     controls enabled      attach host video stream
                           queue joiner for next promotion
                                   │
                              wait for phase edge:
                              gameplay true → false
                                   │
                                   ▼
                            promote queued joiner
                            (player path: pause+state+resume)
                            controls enabled
```

Promotion at end-of-match runs the same code as a fresh CSS-time join. The
spectator-side joiner is not in `_activeRoster`, has no input loop, no
rollback ring entry. Promotion goes through the same `claim-slot` + late-join
state-transfer machinery used for a normal at-CSS player path; see
§Server-side state transitions for the server contract.

### Phase-edge detector

The host detects `phase.gameplay: true → false` inside
`_broadcastPhaseIfNeeded` at [netplay-lockstep.js:5026](web/static/netplay-lockstep.js#L5026),
which already runs every tick (rate-limited), already gates on
`_isSmashRemix()`, and already reads `_readMenuLockstepPhase` at line 5028.
One new host-side variable, `_lastPhaseGameplay`, holds the previous-frame
value.
On a `true → false` transition, the host:

1. Drains a queue (`_pendingPromotions: SocketID[]`) of joiners parked in
   Regime B.
2. For each entry, fires the promotion flow (server event + DC handshake;
   see §Server-side state transitions).
3. Clears the queue.

Edge cases:

- **Multiple Regime B joiners queued.** Drain in FIFO order. Each promotion
  runs through the same pause-and-load; back-to-back is fine because we're
  already in a safe menu phase. If a slot runs out (>= max players), the
  remainder stays queued and the next end-of-match promotes nobody until
  someone leaves.
- **Match ends via host departure / room close.** `room-closed` already
  routes through normal teardown ([play.js handles `room-closed`]). The
  promotion queue is host-local state; if the host leaves, the queue dies
  with them, which is correct — there's no game to promote into.
- **Match ends via `end-game` (host clicked the button).** Same as natural
  end-of-match: `phase.gameplay` flips false, queue drains.
- **Phase reads transient false during gameplay (paused via Start).**
  `_readGameStatus` returns `2` for paused, which has `phase.gameplay
  === false` (gameplay requires `gameStatus === 1`). To avoid promoting
  during a Start-pause, the edge detector also requires
  `phase.inControllableMenu === true`. Pause + match-running has
  `inControllableMenu === false`.

## UX

### Active players (during pause)

Replace the silent freeze with a small non-blocking banner anchored to the
toolbar:

> ⏸ **P3 joining…** *(2s)*

- Shown only when `_runSubstate === RUN_LATE_JOIN_PAUSE`.
- Counts up wall-clock seconds since pause began (`_lateJoinPausedAt` already
  exists at [netplay-lockstep.js:1337](web/static/netplay-lockstep.js#L1337)).
- Cleared on `late-join-resume` or timeout.

### Joiner (player path)

Replace generic "Loading…" with three explicit stages:

1. **Connecting** — WebRTC offer/answer/ICE complete to host.
2. **Syncing game state** — `late-join-state` received, decompressing,
   applying to RDRAM.
3. **Almost ready** — emulator booted, awaiting `late-join-resume`.

Each stage maps to an existing point in `dismissLateJoinPrompt` /
`initEngine` / `handleLateJoinState`. The status string is already routed
through `setStatus()` at [netplay-lockstep.js:2074](web/static/netplay-lockstep.js#L2074);
this is a copy/timing change, not new plumbing.

### Joiner (spectator path)

Persistent status pinned in the toolbar area:

> 👀 **Watching current match** — controls activate at next character select

- Visible from the moment the spectator decision is made.
- Replaced by the player-path stage UI when promotion begins.
- Local gamepad UI dimmed; virtual gamepad hidden.

### Failure modes

If the player-path handshake doesn't complete within
`LATE_JOIN_TIMEOUT_MS` (15s):

- **Active players:** banner changes to "Couldn't add player — they're
  spectating." then dismisses after 3s. Match continues uninterrupted (no
  pause reset weirdness — joiner never finished entering the roster).
- **Joiner:** their incomplete player-init is torn down through
  `resetPeerState(slot, reason)` per **invariant I2**
  ([CLAUDE.md netplay invariants](docs/netplay-invariants.md)) — adding new
  per-peer state without routing cleanup through `resetPeerState` is a
  review-level violation. After teardown, the joiner is server-demoted to
  spectator (same path as Regime B mid-match join). Status flips to:
  "Sync failed — watching as spectator. Will retry at next character select."
- **No half-initialized player slot.** The joiner is either fully a player
  or fully a spectator; there is no in-between.

If the spectator-path canvas stream fails to start (host's `_hostStream`
not yet created, ICE fails, etc.), the joiner sees a still error card with
a manual "Retry" button. They are not promoted to the player path until a
spectator stream is at least attempted.

## Server-side state transitions

The server is the source of truth for `room.players` / `room.spectators`
and broadcasts `users-updated`. Two state moves are needed beyond today's
event vocabulary:

### Move 1: player → spectator (Regime B entry)

When the host responds with `late-join-spectate`, the joiner must release
its player slot. New server event, mirror of `_claim_slot_locked` at
[signaling.py:634](server/src/api/signaling.py#L634):

```
@sio.on("become-spectator")
async def become_spectator(sid):
    # Move sid from room.players to room.spectators, free their slot,
    # broadcast users-updated.
    # Returns:
    #   None on success
    #   "Not in a room"      — sid has no room mapping
    #   "Not a player"       — sid is already a spectator (no-op success
    #                          could also be acceptable; pick one)
    #   "Cannot self-demote — host" — owner_sid cannot become spectator
    #                          (host departure is handled via leave-room
    #                          and the existing host-migration path)
```

Why a new event instead of reusing `leave-room` + `join-room`: that round-trip
emits user-leave / user-join toasts to other peers, which is misleading
("they didn't leave; they got demoted"). A single `become-spectator`
keeps the user-facing player list stable.

**Transient `users-updated` window.** Between the joiner's initial
`join-room` (where they appear in `room.players` with a slot) and the
server-side `become-spectator` after the host's regime decision, other
peers briefly see the joiner as a player. With normal RTT this is a few
hundred milliseconds. To avoid a flickering "P3 joined → P3 left as
player → P3 watching" sequence in the toast UI, suppress the joiner-side
"joined as player" toast until either (a) the regime decision arrives or
(b) `LATE_JOIN_TIMEOUT_MS` elapses. Other peers' `users-updated` handlers
already debounce roster changes via the diff in [play.js:899](web/static/play.js#L899);
if the demotion lands within the same animation frame, the player-toast
never fires.

### Move 2: spectator → player (promotion at next CSS)

The existing `claim-slot` event is **blocked** while `room.status ==
"playing"` ([signaling.py:644](server/src/api/signaling.py#L644)) — a spectator
cannot self-claim during an active match-or-CSS session. This block is
correct for normal claim-slot semantics (random spectator grabbing a slot)
but breaks the host-driven promotion.

The simpler fix: add a new server event `host-promote-spectator`,
host-only, that performs the same `room.spectators` → `room.players` move
as `_claim_slot_locked` ([signaling.py:634](server/src/api/signaling.py#L634))
but with the room.status check replaced by a host identity check:

```
@sio.on("host-promote-spectator")
async def host_promote_spectator(sid, payload):
    # Host (sid == room.owner_sid) promotes a target spectator
    # (payload.target_sid) into a free player slot.
    # Returns:
    #   None on success
    #   "Not host"            — caller is not the room owner
    #   "Target not spectator" — target_sid not in room.spectators
    #   "No slots available"   — room.players is full (matches _claim_slot_locked)
    # Mirror of _claim_slot_locked but:
    #   - identity check: sid must be host
    #   - room.status check: skipped (host is asserting safe phase)
    #   - target: payload.target_sid (not the caller)
    # Broadcast users-updated.
```

The host fires this only inside the phase-edge detector (gameplay true →
false), so the safety guarantee that originally motivated the
"playing"-blocks-claim is upheld differently: trust the host's phase read
rather than the room's coarse status.

### Sequence: server event vs DC message

Promotion involves two messages — a server event for room-state truth and
a DC message for the save-state transfer. Their ordering matters:

1. **Host emits `host-promote-spectator`** to the server. Server moves the
   joiner from `room.spectators` to `room.players`, allocates a slot,
   broadcasts `users-updated` to the room.
2. **Host waits for the server's success acknowledgement** (callback
   returns `None`). On error, the host requeues the joiner for the next
   phase edge.
3. **Host sends DC `late-join-promote`** carrying the save state, exactly
   as today's `late-join-state` is sent in `sendLateJoinState`. The
   joiner's existing `handleLateJoinState` runs unchanged.
4. **Other peers** receive `users-updated` (showing the joiner as a
   player) and the host's broadcast `late-join-pause` simultaneously.
   Their tick loops pause; resume on `late-join-resume` after the joiner
   sends `late-join-ready`.

The joiner does **not** act on `users-updated` alone for promotion — they
wait for the DC `late-join-promote` message. This avoids a race where the
joiner sees themselves as a player (via `users-updated`) before the host's
state arrives.

For Regime B entry (Move 1), the symmetric sequence is: host sends DC
`late-join-spectate`, joiner emits `become-spectator` to the server, server
broadcasts demoted `users-updated`. Other peers' rosters update; no DC
state transfer occurs.

## Implementation surface

Files that change:

### `web/static/netplay-lockstep.js`

- `handleLateJoinRequest` ([line 2126](web/static/netplay-lockstep.js#L2126)):
  branch on `_readMenuLockstepPhase().gameplay`. Mid-match Smash Remix:
  send `late-join-spectate` (new DC/Socket.IO message) and push the
  requester's sid onto a host-local `_pendingPromotions` queue. Otherwise
  run today's `sendLateJoinState`.
- Phase-edge detector: extend `_broadcastPhaseIfNeeded` at
  [line 5026](web/static/netplay-lockstep.js#L5026) — already runs every
  tick (rate-limited), already gated on `_isSmashRemix()`, already reads
  the phase. Add `_lastPhaseGameplay` tracking and drain
  `_pendingPromotions` on a true → false transition where
  `inControllableMenu === true`.
- New incoming message handlers: `late-join-spectate` (joiner side, in
  `onDataMessage` near [line 2099](web/static/netplay-lockstep.js#L2099))
  triggers server demotion via `become-spectator`, attaches host stream;
  `late-join-promote` triggers the existing late-join-state pause-and-load
  flow.
- Failure path: `LATE_JOIN_TIMEOUT_MS` ([line 425](web/static/netplay-lockstep.js#L425))
  fallback now also calls `become-spectator` for the joiner before
  resuming peers, instead of leaving them as a half-initialized player.
- All per-peer cleanup in failure paths must route through
  `resetPeerState` per invariant I2.

### `web/static/play.js`

- The `request-late-join` emit site itself lives in
  `netplay-lockstep.js` ([line 3931](web/static/netplay-lockstep.js#L3931))
  and is unchanged. `play.js` only changes the response-handling side
  (new `late-join-spectate` and `late-join-promote` cases below).
- New handler for `late-join-spectate` (joiner side): set
  `isSpectator = true`, tear down the booting emulator if any, swap the
  overlay to the persistent watching status, ensure a video element is
  attached for the host stream.
- New handler for `late-join-promote` (joiner side): flip
  `isSpectator = false`, clear watching status, reuse the player-path
  `initEngine` flow.
- Stage-aware status copy fed into `setStatus`
  ([line 2074](web/static/netplay-lockstep.js#L2074)) — connecting / syncing /
  almost ready.
- Active-player banner driven by `_runSubstate === RUN_LATE_JOIN_PAUSE`
  observation. Wall-clock counter from `_lateJoinPausedAt`
  ([line 1337](web/static/netplay-lockstep.js#L1337)).

### `server/src/api/signaling.py`

- New `become-spectator` event (~30 lines). Inverse of
  `_claim_slot_locked` at [line 634](server/src/api/signaling.py#L634).
- New `host-promote-spectator` event (~40 lines). Mirror of `claim-slot`
  with host identity check and no `room.status` block.
- Both events broadcast `users-updated` and persist via `state.save_room`.
- `payloads.py`: two new Pydantic v2 models for the events.

### `web/play.html`

- Banner element for active-players "P3 joining…" indicator (toolbar slot).
- Persistent watching status element (likely repurposed `#guest-status`).
- Disabled-controls visual treatment for the spectator path.

The persistent watching banner appears immediately on `late-join-spectate`
receipt — before the host's video track has arrived — so the joiner sees
"Watching current match" with a brief "connecting to stream…" sub-status
that clears when the `<video>` element starts rendering frames.

No protocol breaking change for older peers via WebRTC DC: the new message
types (`late-join-spectate`, `late-join-promote`) are ignored by old
handlers, falling back to the timeout. Server changes are additive and
older clients never emit the new events.

## Out of scope

- Streaming-mode rooms. Streaming has a separate join path (host video to
  guests is the *only* video path); late-join semantics there are different.
  This spec is lockstep-only.
- Private rooms / invite-only / host approval. The whole point of the v1 is
  "public means free join with a brief pause." Later, private rooms can
  short-circuit the regime check entirely.
- Host migration during a queued promotion. Out of scope; the existing
  `room-closed` path handles host departure.
- Roster commit frame synchronization. Not needed: regime A is identical to
  today's flow, and regime B promotes only when `phase.gameplay` is already
  false (no active match → no roster desync risk).
- Per-game phase reads beyond Smash Remix. Other games default to today's
  pause-and-load behavior for new joiners.

## Decisions on previously-open questions

1. **Race: joiner connects exactly at CSS→match transition.** Host's
   regime decision is authoritative — once the host responds with
   `late-join-state` (Regime A), the joiner stays on the player path even
   if the match starts during state transfer. This is the same race
   today's code tolerates and there's no observed bug. No re-check at
   joiner-side state-apply time.

2. **Spectator stream startup latency.** Host's `_hostStream` is created
   lazily the first time a spectator connects. First-spectator may see a
   brief blank/black before the canvas track arrives. Mitigation: the
   "Watching current match" banner appears immediately on
   `late-join-spectate` receipt with a "connecting to stream…" sub-status
   that clears when the `<video>` element renders its first frame.

3. **Cache the regime decision per-joiner?** Yes — host's decision at the
   moment of `handleLateJoinRequest` is final. The joiner trusts the
   message they receive. No re-evaluation.

## References

- `_readMenuLockstepPhase` — [netplay-lockstep.js:1425](web/static/netplay-lockstep.js#L1425)
- `_readGameStatus` — [netplay-lockstep.js:1401](web/static/netplay-lockstep.js#L1401)
- `handleLateJoinRequest` — [netplay-lockstep.js:2126](web/static/netplay-lockstep.js#L2126)
- `onDataMessage` (where new handlers go) — [netplay-lockstep.js:2099](web/static/netplay-lockstep.js#L2099)
- `setStatus` — [netplay-lockstep.js:2074](web/static/netplay-lockstep.js#L2074)
- Per-tick phase read site (`_broadcastPhaseIfNeeded`) — [netplay-lockstep.js:5028](web/static/netplay-lockstep.js#L5028); other call sites at 1440 (inside `_readStrictPhaseLock`) and 1497 are nested helpers, not tick-loop entry points
- `LATE_JOIN_TIMEOUT_MS` — [netplay-lockstep.js:425](web/static/netplay-lockstep.js#L425)
- `_lateJoinPausedAt` — [netplay-lockstep.js:1337](web/static/netplay-lockstep.js#L1337)
- `_hostStream = captureStream(0)` — [netplay-lockstep.js:4868](web/static/netplay-lockstep.js#L4868)
- `startSpectatorStreamForPeer` — [netplay-lockstep.js:4908](web/static/netplay-lockstep.js#L4908) (called from line 2724)
- `request-late-join` emit site (joiner side, in `bootEmulator` →  late-join branch) — [netplay-lockstep.js:3931](web/static/netplay-lockstep.js#L3931)
- `dismissLateJoinPrompt` — [play.js:3079](web/static/play.js#L3079)
- Spectator → player transition (slot reassignment in `onUsersUpdated`) — [netplay-lockstep.js:2146](web/static/netplay-lockstep.js#L2146)
- Server `_claim_slot_locked` (template for new events) — [signaling.py:634](server/src/api/signaling.py#L634)
- Server reconnect short-circuit (`_swap_sid` in `join-room`) — [signaling.py:475](server/src/api/signaling.py#L475)
- Netplay invariants (I1, I2) — [docs/netplay-invariants.md](docs/netplay-invariants.md)
