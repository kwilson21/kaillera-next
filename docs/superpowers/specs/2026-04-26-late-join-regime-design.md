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

**Anyone joining a Smash Remix room while `room.status === "playing"`
always enters as a spectator.** The decision is made at `join-room`
time on the joiner's client (the join-room ack already includes
`room.status` — [play.js:648](web/static/play.js#L648); the spec adds
`game_id` to that response, see §Game-detection below). No emulator
boots, no ROM is required up front, no late-join state transfer fires
from the spectator path. Non-Smash-Remix games keep today's behavior.

The host then decides *when* to promote a queued spectator into a player
slot. The promotion predicate is `phase.inControllableMenu === true`
(host is at title/menus/CSS/stage-select — scenes 1, 7-21 in
`_isControllableMenuScene` at [netplay-lockstep.js:1416](web/static/netplay-lockstep.js#L1416)).
That set is exactly "scenes where the in-game player roster isn't yet
baked," which is the underlying invariant the spec was reaching for in
v1.

Why `inControllableMenu` is the right predicate, and not `phase.gameplay`:

- **Mid-match** (scene 22, gameStatus 1): roster baked → spectator only. ✓
- **Start-pause** (scene 22, gameStatus 2): roster baked → spectator only.
  `phase.gameplay === false` would have wrongly classified this as safe;
  `inControllableMenu === false` correctly classifies it as not-safe.
- **Results screen** (scene 24): match ended, but you can't add a P3
  here either; CSS hasn't shown yet. `inControllableMenu === false` →
  stay queued.
- **CSS / stage select** (scenes in 7-21): roster not yet baked →
  player slot is admissible. ✓

`_readMenuLockstepPhase` short-circuits on `_isSmashRemix() === false`
(returns `inControllableMenu: false`). For non-Smash games the predicate
is never satisfied, so spectators are never auto-promoted by this
mechanism. Non-Smash games therefore default to today's behavior:
joiners start as players via the existing `request-late-join` flow when
the room status flips to "playing", which is unchanged.

### Spectator entry (always, when `room.status === "playing"` and Smash Remix)

- `play.js` already auto-spectates when the room is full
  ([line 571](web/static/play.js#L571)). Extend the same gate to:
  `if (roomData.status === 'playing' && roomData.gameId === 'smash-remix') { isSpectator = true; _autoSpectated = true; }`.
  This forces every late joiner through the spectator path on Smash
  Remix rooms, regardless of whether the host is at CSS or mid-match.
  Other games keep today's player-first behavior. No new server event
  is needed; the existing `join-room` with `spectate: true` does the
  job.
- **Intent tracking** — distinguish "user wants to play but was
  auto-routed to spectator" from "user explicitly chose to spectate."
  The auto-spectate gate sets `_autoSpectated = true` only when the
  gate itself fires. An explicit spectator (URL `?spectate=1`,
  spectator link, etc.) keeps `_autoSpectated = false`.

  The `join-room` extra payload carries this intent to the server:
  `extra.autoSpectated: bool`. The server stores it on the spectator
  info dict and exposes it through `_players_payload` so the host
  can read it from `users-updated`.

  **The host only enqueues spectators where `autoSpectated === true`
  in `_pendingPromotions`.** Explicit spectators are left alone; they
  watch indefinitely and are never auto-promoted.

  Future: a "Play next match" button on the explicit-spectator UI
  that emits a new `request-promotion` server event flipping
  `autoSpectated` to true. Out of scope for v1 but the field shape
  supports it.
- Host's per-peer canvas stream
  ([netplay-lockstep.js:4868](web/static/netplay-lockstep.js#L4868),
  `_hostStream = captureCanvas.captureStream(0)`, attached in
  `startSpectatorStreamForPeer` at
  [netplay-lockstep.js:4908](web/static/netplay-lockstep.js#L4908),
  called from the new-peer branch at
  [netplay-lockstep.js:2724](web/static/netplay-lockstep.js#L2724)) starts
  delivering video on its own. No emulator boots on the joiner.
- Joiner's gamepad / virtual-gamepad UI is dimmed/hidden with a status
  message: "Watching current match — joining at next character select."
- ROM readiness still progresses during spectator mode: the existing ROM
  prompt and host ROM-sharing flow run as today, so by the time the host
  promotes the joiner, the ROM is in IndexedDB / cached. ROM readiness
  is a hard precondition for promotion (see §Promotion gating below).

### Promotion to player

The host promotes a queued spectator on the rising edge of
`phase.inControllableMenu` (false → true), and immediately if a queued
spectator's ROM becomes ready while the host is already in a controllable
menu. Promotion runs the existing player-path machinery
(`sendLateJoinState` → DC pause → state transfer → resume), with two
changes:

1. The server-side move from `room.spectators` to `room.players` happens
   first via a new `host-promote-spectator` event (see §Server-side state
   transitions). The existing `claim-slot` is unsuitable because it's
   blocked by `room.status == "playing"` ([signaling.py:644](server/src/api/signaling.py#L644)).
2. `late-join-state` is targeted to a single SID via a new `targetSid`
   field, since `data-message` is room-broadcast and multiple promotions
   could otherwise collide (see §Targeted relay).

Promotion timing in practice:

- **Joiner arrives during CSS/menus.** Host sees `inControllableMenu ===
  true` immediately on the join, ROM may or may not be ready. Host waits
  on ROM ready, then fires promotion. Total spectator-mode time: a few
  hundred ms to a few seconds (ROM-dependent).
- **Joiner arrives during a match.** Host sees `inControllableMenu ===
  false`, queues the joiner. Joiner watches video until the match ends,
  results screen passes, and CSS appears. Host fires promotion at the
  CSS transition.

### Reconnect

Reconnect is **not** late-join. The server detects returning players by
`persistent_id` in `join-room` ([signaling.py:475–488](server/src/api/signaling.py#L475))
and `_swap_sid` ([signaling.py:260](server/src/api/signaling.py#L260))
restores their slot before the join completes. The new flow applies
only to genuinely new joiners (no prior slot for their
`persistent_id`).

**Subtlety: the auto-spectate gate fires before the server's reconnect
short-circuit is observable.** The client-side gate at
[play.js:571](web/static/play.js#L571) decides `spectate: true` based
on `roomData.status === "playing"` and `gameId === "smash-remix"`,
emits `join-room` with that flag, and only then sees the ack. The
server's reconnect path overrides the `spectate` flag — a reconnecting
player whose `persistent_id` is in `room.players` is restored to the
player slot regardless of what they emitted.

That means client-side state can disagree with server-side state right
after the ack: client thinks `isSpectator = true`, server's
`users-updated` shows the SID in `players`. The client must
**reconcile** at ack time:

1. Inspect the join-room ack body. Find self by `socketId === socket.id`.
2. If self is in `ack.players` despite the client having emitted
   `spectate: true`, this is a server-detected reconnect. Set
   `isSpectator = false`, clear `_autoSpectated`, and run the legacy
   `request-late-join` path that today's reconnect goes through (the
   existing `bootEmulator` → `request-late-join` flow at
   [netplay-lockstep.js:3899–3937](web/static/netplay-lockstep.js#L3899)).
3. The Chunk 5.4 self-promotion handler (in the implementation plan)
   must skip this case: only fire promotion-induced boot when the
   *first* `users-updated`/ack showed self in spectators. Otherwise
   reconnects double-up.

The distinguisher is "was self in players in the FIRST authoritative
roster snapshot." Capture this in the join-room ack handler and
remember it across subsequent `users-updated` deliveries.

### Game-detection: scope and required server changes

The host-side phase reader (`_readMenuLockstepPhase`,
`_readGameStatus`, `_readSceneCurr`) is gated on `_isSmashRemix()` at
[netplay-lockstep.js:1345](web/static/netplay-lockstep.js#L1345), which
only matches `_config.gameId === 'smash-remix'` and two Smash Remix
ROM hashes. **Vanilla SSB64 is not currently covered.** Two paths:

- **Recommended for v1: scope to Smash Remix only.** The auto-spectate
  gate fires only when the room game is Smash Remix; vanilla SSB64 and
  other games fall to today's `request-late-join` player path. This
  matches what the host-side phase reader actually supports today and
  avoids widening scope.
- **Optional v1.x: widen the helper.** Replace `_isSmashRemix()` calls
  in the new code paths with a new `_supportsSmashPhaseRead()` that
  returns true for both vanilla SSB64 and Smash Remix. Verify the same
  RDRAM addresses (`0x800A4D18` for game_status, scene cursor) hold for
  vanilla SSB64 before flipping. This is a safe refactor but separate
  from this spec.

The decision is "scope to Smash Remix" unless verification of vanilla
addresses lands first; the spec assumes Smash-Remix-only.

**Server payload changes required.** The auto-spectate gate in
`play.js` needs to know the room's `game_id` at `join-room` ack time
*and* at the `GET /room/{room_id}` lookup that precedes joining:

- `GET /room/{room_id}` ([app.py:618](server/src/api/app.py#L618))
  currently returns `status`, `player_count`, `max_players`,
  `has_password`, `rom_hash`, `rom_sharing`, `mode`. **Add
  `game_id`.**
- `join-room` ack response ([signaling.py:601–608](server/src/api/signaling.py#L601))
  currently spreads `_players_payload(room)` and adds `status`, `mode`,
  `rom_hash`, `rom_sharing`. **Add `game_id`** (server-side `room.game_id`).

Without these two additions the spectator-first gate cannot be
implemented client-side as written.

The UX downside (for non-Smash-Remix games) is that mid-match joiners
might still see the "controls do nothing" symptom if those games also
bake their roster, but that's the status quo, not a regression.

## State transitions

```
            joiner emits join-room
                      │
                      ▼
        roomData.status === "playing" && Smash game ?
          ┌─yes─┘                 └─no──┐
          ▼                              ▼
   spectate: true                 spectate: false
   (forced)                       (today's path: player slot,
                                   request-late-join, etc.)
          │
          ▼
    server places in spectators
    (or short-circuits as reconnect via persistent_id)
          │
          ▼
    host's per-peer spectator stream
    starts; joiner watches live video
          │
          │  ROM prompt / host ROM-sharing
          │  runs in parallel; joiner emits
          │  rom-ready when complete
          ▼
    host's promotion gate:
      romReady AND phase.inControllableMenu === true
      AND slot available
          │
          ▼
   host emits host-promote-spectator
          │
          ▼
   server moves joiner: spectators → players,
   broadcasts users-updated
          │
          ▼
   host sends targeted late-join-state
   (DC pause + state transfer)
          │
          ▼
   joiner boots emulator, applies state,
   emits late-join-ready
          │
          ▼
   host broadcasts late-join-resume,
   pacing reset, controls enabled
```

### Phase-edge detector

The host's promotion gate checks `phase.inControllableMenu === true` on
the rising edge (false → true), and also re-checks whenever a queued
spectator transitions to ROM-ready (handled in the `rom-ready` server
event handler — host watches this). The detector lives in
`_broadcastPhaseIfNeeded` at
[netplay-lockstep.js:5026](web/static/netplay-lockstep.js#L5026) — runs
every tick (rate-limited), already gated on `_isSmashRemix()`, already
reads `_readMenuLockstepPhase` at line 5028.

One new host-side variable, `_lastInControllableMenu`, holds the
previous-frame value. On a `false → true` transition, the host drains
the `_pendingPromotions` queue (FIFO) and runs the promotion flow per
entry that has both `romReady === true` AND `autoSpectated === true`.
Entries without ROM stay queued across cycles. Explicit spectators
(`autoSpectated === false`) are never enqueued in the first place
(see §Spectator entry intent tracking).

Why `inControllableMenu` rising edge (not `gameplay` falling edge): a
match goes scene 22 (gameplay) → scene 24 (results) → scene 18 (CSS).
The `gameplay → false` edge fires at the 22→24 boundary (results
screen), where you still can't promote. By the time the controllable
CSS scene appears, gameplay has long been false, so a `gameplay`-edge
detector misses the actual safe point. `inControllableMenu` rising edge
fires at the 24→18 boundary, which is exactly when CSS becomes
available. Same logic applies for any controllable-menu scene the game
returns to.

Edge cases:

- **Multiple queued joiners.** Drain in FIFO order. Each promotion runs
  through the same pause-and-load; back-to-back is fine because we're
  already in a safe menu phase. If `room.players` fills (4 players), the
  remainder stays queued.
- **Match ends via host departure / room close.** `room-closed` already
  routes through normal teardown. The promotion queue is host-local
  state; if the host leaves, the queue dies with them — correct, no
  game to promote into.
- **Match ends via `end-game` (host clicked the button).** Same as
  natural end-of-match: `inControllableMenu` flips true at the next
  controllable scene, queue drains.
- **Joiner arrives at CSS already (host already inControllableMenu).**
  No edge to detect. The host runs the same gate check on `rom-ready`
  arrival or on the `users-updated` that adds the new spectator,
  whichever comes second.
- **Multiple controllable-menu transitions during a single session.**
  Edge fires repeatedly; queue is drained on each. Idempotent — empty
  queue means no-op.

## UX

### Active players (during pause)

Replace the silent freeze with a small non-blocking banner anchored to the
toolbar:

> ⏸ **P3 joining…** *(2s)*

- Shown only when `_runSubstate === RUN_LATE_JOIN_PAUSE`.
- Counts up wall-clock seconds since pause began (`_lateJoinPausedAt` already
  exists at [netplay-lockstep.js:1337](web/static/netplay-lockstep.js#L1337)).
- Cleared on `late-join-resume` or timeout.

### Joiner (spectator-first, then promoted)

The joiner sees three sequential states:

1. **Watching current match** — persistent status pinned to the toolbar:
   "👀 Watching current match — joining at next character select." ROM
   prompt and host-sharing UI are still visible/active during this phase
   so the joiner can get their ROM ready.
2. **Promoting…** — when the host fires the promotion path, status flips
   to staged copy, replacing "Loading…":
   - **Connecting** — WebRTC pause / state transfer in progress.
   - **Syncing game state** — `late-join-state` received, decompressing,
     applying to RDRAM.
   - **Almost ready** — emulator booted, awaiting `late-join-resume`.
3. **Controls enabled** — gamepad / virtual-gamepad UI un-dims. Watching
   banner clears.

Each promotion stage maps to an existing point in `bootEmulator` /
`handleLateJoinState`. Status copy routes through `setStatus()` at
[netplay-lockstep.js:2074](web/static/netplay-lockstep.js#L2074); this is
a copy/timing change, not new plumbing. The emulator boot now happens at
promotion time rather than at join time.

### Failure modes

If promotion's `late-join-state` handshake doesn't complete within
`LATE_JOIN_TIMEOUT_MS` (15s):

- **Active players:** banner changes to "Couldn't add player — they're
  watching." then dismisses after 3s. Match continues uninterrupted.
- **Joiner:** their booting emulator is torn down. All per-peer
  cleanup routes through `resetPeerState(slot, reason)` per
  **invariant I2** ([docs/netplay-invariants.md](docs/netplay-invariants.md)) —
  adding new per-peer state without routing cleanup through
  `resetPeerState` is a review-level violation. Joiner emits
  `become-spectator` to the server (see §Server-side state transitions);
  server moves them back from players to spectators and broadcasts
  `users-updated`. Joiner self-state: `_isSpectator = true`,
  `_playerSlot = null`. Status flips to: "Sync failed — back to
  watching. Will retry at next character select." The host re-queues
  this SID into `_pendingPromotions` so the next safe-phase edge tries
  again.
- **No half-initialized player slot.** Either fully a player (state
  applied, controls live) or fully a spectator (no roster slot, watching
  stream).

If the spectator-mode canvas stream fails to start (host's `_hostStream`
not yet created, ICE fails, etc.), the joiner sees a status banner with
a manual "Retry" button. They are not eligible for promotion until a
spectator stream is at least attempted (so they can confirm video
arrives).

### Demotion: peer cleanup on the wire

When the server moves a SID from `room.players` to `room.spectators`
(triggered by `become-spectator` on a failure path, or by an out-of-band
admin action), every peer's `onUsersUpdated` at
[netplay-lockstep.js:2137](web/static/netplay-lockstep.js#L2137) needs
to:

1. Detect that the SID's old `peer.slot` no longer matches their entry
   in the new `players` payload (they're now in `spectators`).
2. Call `resetPeerState(oldSlot, reason='demoted-to-spectator')` for
   that peer's prior slot.
3. Set `peer.slot = null` on the existing `_peers[sid]` entry.
4. Trigger `startSpectatorStreamForPeer(sid)` (host-side only) so the
   demoted peer starts receiving canvas video.

For the demoted peer themselves: `_playerSlot = null`, `_isSpectator =
true`, mirror the `onUsersUpdated` cleanup for any peer entries they
held as a "player." The existing zombie-peer eviction at
[netplay-lockstep.js:2183](web/static/netplay-lockstep.js#L2183) is for
SID-renaming; demotion is a different case and needs the new branch
above.

## Server-side state transitions

The server is the source of truth for `room.players` / `room.spectators`
and broadcasts `users-updated`. Spectator-first entry uses today's
`join-room` with `spectate: true` — no new event for the entry path. Two
new events are needed:

### `host-promote-spectator` — happy-path promotion

The existing `claim-slot` event is blocked while `room.status ==
"playing"` ([signaling.py:644](server/src/api/signaling.py#L644)) — that
block is correct for the normal claim-slot semantics (random spectator
grabbing a slot mid-match) but blocks the host-driven promotion. New
event, host-only, mirror of `_claim_slot_locked` at
[signaling.py:634](server/src/api/signaling.py#L634):

```
@sio.on("host-promote-spectator")
async def host_promote_spectator(sid, payload):
    # Host (sid == room.owner_sid) promotes payload.target_sid from
    # room.spectators into a free player slot.
    # Returns:
    #   None on success
    #   "Not host"             — caller is not the room owner
    #   "Target not spectator" — target_sid not in room.spectators
    #   "No slots available"   — room.players is full
    # Same room.spectators → room.players move as _claim_slot_locked,
    # but identity check replaces the room.status block. Broadcast
    # users-updated to the room. Persist via state.save_room.
```

The host fires this only inside the phase-edge detector
(`inControllableMenu` rising edge or rom-ready arrival while already in
a controllable menu), so the safety guarantee that originally motivated
the "playing"-blocks-claim is upheld differently: trust the host's
phase read rather than the room's coarse status.

### `become-spectator` — failure recovery only

If the targeted `late-join-state` transfer fails after promotion (joiner
worker stalls past `LATE_JOIN_TIMEOUT_MS`, decompression throws, etc.),
the joiner is already in `room.players` server-side but their emulator
isn't actually running. They need to be moved back to spectators so
other peers' rosters reflect reality and they aren't expected to send
inputs. New event, mirror of `_claim_slot_locked` for the inverse:

```
@sio.on("become-spectator")
async def become_spectator(sid):
    # Move sid from room.players to room.spectators, free their slot,
    # broadcast users-updated. Used only on failure recovery paths,
    # not on the happy path.
    # Returns:
    #   None on success
    #   "Not in a room"             — sid has no room mapping
    #   "Already spectator"         — sid is already in room.spectators (no-op)
    #   "Cannot self-demote: host"  — owner_sid cannot become spectator
    #                                 (host departure goes through leave-room
    #                                 and the existing host-migration path)
```

This is also what the joiner's own LATE-JOIN-TIMEOUT cleanup calls. The
host's existing `hardDisconnectPeer` path on timeout
([netplay-lockstep.js:4630](web/static/netplay-lockstep.js#L4630)) is
unchanged for cases where the joiner has actually disconnected.

### Sequence: server event vs DC message during promotion

1. Host emits `host-promote-spectator` to server. Server moves joiner
   from `room.spectators` to `room.players`, allocates slot, broadcasts
   `users-updated`. Server returns success ack to the host callback.
2. Host receives the ack. On error, host requeues the joiner for the
   next phase edge.
3. Host sends targeted `late-join-state` via Socket.IO `data-message`
   with `targetSid` set (see §Targeted relay). Existing
   `sendLateJoinState` machinery runs unchanged otherwise.
4. Other peers receive `users-updated` (showing the joiner as a player)
   and the host's broadcast `late-join-pause` (DC-side). Their tick
   loops pause; resume on `late-join-resume` after the joiner sends
   `late-join-ready`.

The joiner does **not** act on `users-updated` alone for promotion. The
arrival of a `late-join-state` carrying their `targetSid` is the
trigger to boot the emulator and apply state. This avoids a race where
the joiner sees themselves as a player before the host's state has
been sent.

### Targeted relay

Today's `late-join-state` rides on Socket.IO `data-message`, which
broadcasts to every peer in the room
([signaling.py:1020](server/src/api/signaling.py#L1020), `room=session_id,
skip_sid=sid`). With multiple queued joiners, two simultaneous
promotions could collide on the receiver side — the second joiner
might run their `handleLateJoinState` against the first joiner's state
because the only filter today is `_isSpectator || _phase ===
PHASE_RUNNING`.

Add a `targetSid` field to `late-join-state`. Receiver-side
`handleLateJoinState`
([netplay-lockstep.js:4653](web/static/netplay-lockstep.js#L4653)):

```
if (msg.targetSid && msg.targetSid !== socket.id) return;
```

This is forward-compatible: an old `late-join-state` with no `targetSid`
falls through unchanged. Sender-side `sendLateJoinState`
([netplay-lockstep.js:4639](web/static/netplay-lockstep.js#L4639)) sets
`targetSid: remoteSid` on every emit.

**Why not switch to a new server event with explicit per-SID targeting?**
The save-state payload is up to 4MB. Reusing `data-message`'s existing
size limit (`_DATA_MSG_MAX_BYTES`, 4MB) and rate limiting avoids new
server-side plumbing. The `targetSid` filter on the receiver costs one
string comparison per message and is cheap.

### Transient `users-updated` window

For non-Smash games (or pre-rollout clients), a joiner who explicitly
asked to be a player will appear in `room.players` immediately on
`join-room`, before the host has any chance to act. That's the existing
behavior and the spec doesn't change it.

For Smash games on the new path, the joiner enters as a spectator from
the start (`spectate: true` set client-side based on `roomData.status ===
"playing"`), so there's no "appears as player, then moved to spectator"
flicker. Other peers see a single "watching" event, then later a
"joined slot N" event when promotion fires. The
`diffForToasts` in [play.js:893](web/static/play.js#L893) is an immediate
diff (not a debounce), so each `users-updated` produces toast output —
but with a single state change per peer-visible event, the toasts are
clean.

## Implementation surface

Files that change:

### `web/static/play.js`

- Auto-spectate gate around [line 571](web/static/play.js#L571): extend
  the existing `roomData.player_count >= max_players` check to also
  set `isSpectator = true` AND `_autoSpectated = true` when
  `roomData.status === "playing"` AND `roomData.gameId === "smash-remix"`.
  Pass `autoSpectated: _autoSpectated` in the `join-room` extra
  payload so the server can propagate intent.
- **Reconcile-on-ack** for reconnect detection: in the join-room
  callback (line 591 + line 609), inspect the ack body. Find self by
  `socketId === socket.id`. If self is in `ack.players` despite the
  client emitting `spectate: true`, treat as reconnect: set
  `isSpectator = false`, `_autoSpectated = false`, run the existing
  bootEmulator → request-late-join legacy path. Capture the
  authoritative initial roster snapshot in a new local
  `_initialRosterSelfRole: 'player' | 'spectator'` so the
  self-promotion handler in `users-updated` can distinguish
  reconnects (was already a player) from genuine promotions (was a
  spectator first).
- Decouple emulator boot from join: today `bootEmulator()` runs from
  `dismissLateJoinPrompt` ([line 3079](web/static/play.js#L3079)) for
  mid-game joiners. Move the boot trigger to a new
  `onPromotedToPlayer()` callback fired by `netplay-lockstep.js` when
  the host's promotion path lands. Spectator-mode joiners never hit
  `bootEmulator` until promotion.
- ROM prompt timing: keep today's prompt for spectator-mode joiners so
  the ROM is ready before promotion. Existing `notifyRomReady()`
  emission and `rom-sharing-prompt` UI are unchanged.
- Promotion-stage status copy fed into `setStatus`
  ([netplay-lockstep.js:2074](web/static/netplay-lockstep.js#L2074)) —
  connecting / syncing / almost ready.
- Active-player banner driven by `_runSubstate === RUN_LATE_JOIN_PAUSE`
  observation; wall-clock counter from `_lateJoinPausedAt`
  ([netplay-lockstep.js:1337](web/static/netplay-lockstep.js#L1337)).
- Watching-spectator banner shown when `isSpectator && roomData.status
  === "playing"`. Sub-status "connecting to stream…" until host video
  arrives.

### `web/static/netplay-lockstep.js`

- Host: extend `_broadcastPhaseIfNeeded`
  ([line 5026](web/static/netplay-lockstep.js#L5026)) to maintain
  `_lastInControllableMenu` and detect the `false → true` rising edge.
  On that edge, drain `_pendingPromotions` for ROM-ready entries.
- Host: new event handler for `rom-ready` arrivals on a queued
  spectator: re-evaluate the gate; if `inControllableMenu` is already
  true, fire promotion immediately.
- Host: `_pendingPromotions: { sid, romReady, queuedAt }[]` —
  populated when the host first sees a new spectator (`onUsersUpdated`)
  in a `room.status === "playing"` room.
- Host: new helper `promoteSpectator(sid)` that emits
  `host-promote-spectator` to the server, awaits the ack, and on success
  calls existing `sendLateJoinState(sid)` (which now includes the
  `targetSid` field).
- Host: `sendLateJoinState`
  ([line 4639](web/static/netplay-lockstep.js#L4639)) adds
  `targetSid: remoteSid` to the emit payload. No other change.
- Joiner: `handleLateJoinState`
  ([line 4653](web/static/netplay-lockstep.js#L4653)) adds
  `if (msg.targetSid && msg.targetSid !== socket.id) return;` at the
  top, before any state mutation.
- **Joiner: buffer for early-arriving state.** The current handler
  returns early on `_isSpectator || _phase === PHASE_RUNNING` and
  assumes `gameManager` exists. With the spectator-first flow, a
  targeted `late-join-state` can arrive *before* the joiner's
  `bootEmulator` has finished — the `users-updated` flipping the
  joiner to a player only fires after the server move, but the host's
  `late-join-state` follows immediately on the same tick. The new
  flow must:
  1. On `late-join-state` with `targetSid === socket.id`: cache the
     full message in a joiner-local `_pendingLateJoinMsg` buffer.
  2. Trigger `onPromotedToPlayer()` if not already in flight; this
     drives `play.js` to call `bootEmulator`.
  3. Once `EJS_emulator?.gameManager?.Module` is ready, run the
     existing decompression and state-apply path with the cached
     message. Clear the buffer.
  4. If `_pendingLateJoinMsg` is still set after
     `LATE_JOIN_TIMEOUT_MS`, the boot stalled — fall through to the
     existing failure path (`become-spectator`, re-queue).
- `onUsersUpdated` ([line 2137](web/static/netplay-lockstep.js#L2137)):
  detect SID demotion (was in `players` last tick, now in `spectators`).
  For each demoted SID:
  - `resetPeerState(oldSlot, 'demoted-to-spectator')` — invariant I2.
  - Set existing `_peers[sid].slot = null`.
  - If we're host, call `startSpectatorStreamForPeer(sid)`.
  - If the demoted SID is self, set `_playerSlot = null` and
    `_isSpectator = true`.
- Failure path: the existing `LATE_JOIN_TIMEOUT_MS` host-side timeout
  ([line 4633](web/static/netplay-lockstep.js#L4633)) currently
  hard-disconnects the peer. Change it (for the new spectator-first
  flow) to: emit `become-spectator` for the joiner, leave the peer's
  WebRTC connection up so they keep getting video, and re-queue them
  in `_pendingPromotions` for retry at the next safe-phase edge.

### `server/src/api/signaling.py`

- New `become-spectator` event (~30 lines). Inverse of
  `_claim_slot_locked` at [line 634](server/src/api/signaling.py#L634).
  Used only on failure recovery paths.
- New `host-promote-spectator` event (~40 lines). Mirror of `claim-slot`
  with host identity check and no `room.status` block.
- Both events broadcast `users-updated` and persist via `state.save_room`.
- `payloads.py`: two new Pydantic v2 models for the events.
- **`_players_payload` ([line 220](server/src/api/signaling.py#L220))
  must expose `romReady` AND `autoSpectated` for spectators**, not
  just `socketId` and `playerName`. The host needs both fields:
  - `romReady: info["socketId"] in room.rom_ready` — promotion gate
    checks ROM is loaded.
  - `autoSpectated: bool(info.get("autoSpectated", False))` —
    promotion gate skips explicit spectators.
- **`gameId` added to** the `join-room` ack response
  ([line 603](server/src/api/signaling.py#L603)) — one extra line:
  `resp["gameId"] = room.game_id`.
- **`JoinRoomExtra` payload accepts `autoSpectated: bool`** (Pydantic
  model in `payloads.py`). Server stores it on the spectator info
  dict at the spectator-creation site in the `join-room` handler:
  `room.spectators[persistent_id] = {"socketId": sid, "playerName":
  player_name, "autoSpectated": payload.extra.autoSpectated or False}`.
  Defaults to `False` for backward compat (explicit spectators on
  old clients).

### `server/src/api/app.py`

- **`GET /room/{room_id}` ([line 618](server/src/api/app.py#L618))
  must return `game_id`** in its response dict so the lobby can decide
  whether to apply the spectator-first gate before the join-room
  round-trip.

### `web/play.html`

- Banner element for active-players "P3 joining…" indicator (toolbar slot).
- Persistent watching status element (likely repurposed `#guest-status`).
- Disabled-controls visual treatment for the spectator path.

### `server/src/api/payloads.py`

- `HostPromoteSpectatorPayload { targetSid: str }`
- `BecomeSpectatorPayload {}` (empty body; sender identifies via sid)
- `JoinRoomExtra` (existing model) gains `autoSpectated: bool = False`
  field. Backward-compat default for old clients.

### Out-of-spec for v1

- ROM-not-ready state shown to the joiner during long matches: a
  "Get your ROM ready while you watch" prompt is the existing UI; no new
  affordance. If a joiner never resolves their ROM, they stay queued
  forever — matches today's behavior of "no ROM, no play."
- Promoting more than one spectator at a single edge: serial drain.
  Each promotion takes 1–2s of pause; multiple promotions chain. If
  this is too slow in practice, batched promotion is a v2 follow-up.

No protocol breaking change for older peers: the new events
(`host-promote-spectator`, `become-spectator`) are not emitted by old
clients, and the new `targetSid` field on `late-join-state` is ignored
by old client handlers (forward compat). An old client joining a new
host's room enters as a player via the existing path because
`roomData.status === "playing"` only triggers the new auto-spectate gate
when the joiner is on the new code.

## Out of scope

- Streaming-mode rooms. Streaming has a separate join path (host video to
  guests is the *only* video path); late-join semantics there are different.
  This spec is lockstep-only.
- Private rooms / invite-only / host approval. The whole point of the v1 is
  "public means free join with a brief pause." Later, private rooms can
  short-circuit the regime check entirely.
- Host migration during a queued promotion. Out of scope; the existing
  `room-closed` path handles host departure.
- Roster commit frame synchronization. Not needed: promotion only fires
  while `inControllableMenu === true`, where lockstep is already
  pausing/aligning at the menu (no active gameplay frames to disagree
  on).
- Per-game phase reads beyond Smash Remix. Other games default to today's
  pause-and-load behavior for new joiners.

## Decisions on previously-open questions

1. **Race: joiner connects exactly at CSS→match transition.** With the
   spectator-first design this race no longer exists. Joiner is a
   spectator until the host explicitly fires `host-promote-spectator`
   on a confirmed `inControllableMenu === true`. If the menu phase
   ends before promotion completes, the in-flight promotion still
   finishes (state-applied joiner becomes a player); the next promotion
   waits for the next safe-phase edge.

2. **Spectator stream startup latency.** Host's `_hostStream` is created
   lazily the first time a spectator connects. First-spectator may see a
   brief blank/black before the canvas track arrives. Mitigation: the
   "Watching current match" banner appears immediately on `users-updated`
   with a "connecting to stream…" sub-status that clears when the
   `<video>` element renders its first frame.

3. **Promotion ordering vs `users-updated`.** The joiner waits for the
   targeted `late-join-state` (with their `targetSid`) to start booting
   the emulator. They do not act on `users-updated` showing them as a
   player alone — that arrives slightly before the state and would
   otherwise race the boot.

4. **What if the joiner's ROM never resolves?** They stay queued forever.
   Same as today's "you joined but can't play because no ROM" failure
   mode. The host's queue holds the entry; the joiner sees the watching
   banner with the existing ROM prompt visible. Host has no special UI
   for this — the queue is invisible to other players.

## References

- `_readMenuLockstepPhase` — [netplay-lockstep.js:1425](web/static/netplay-lockstep.js#L1425)
- `_readGameStatus` — [netplay-lockstep.js:1401](web/static/netplay-lockstep.js#L1401)
- `_isControllableMenuScene` — [netplay-lockstep.js:1416](web/static/netplay-lockstep.js#L1416)
- `handleLateJoinRequest` (today's path, used by reconnects) — [netplay-lockstep.js:2126](web/static/netplay-lockstep.js#L2126)
- `onUsersUpdated` (demotion cleanup goes here) — [netplay-lockstep.js:2137](web/static/netplay-lockstep.js#L2137)
- `onDataMessage` (where targetSid filter goes) — [netplay-lockstep.js:2099](web/static/netplay-lockstep.js#L2099)
- `setStatus` — [netplay-lockstep.js:2074](web/static/netplay-lockstep.js#L2074)
- Per-tick phase read site (`_broadcastPhaseIfNeeded`) — [netplay-lockstep.js:5028](web/static/netplay-lockstep.js#L5028); other call sites at 1440 (inside `_readStrictPhaseLock`) and 1497 are nested helpers, not tick-loop entry points
- `LATE_JOIN_TIMEOUT_MS` — [netplay-lockstep.js:425](web/static/netplay-lockstep.js#L425)
- `_lateJoinPausedAt` — [netplay-lockstep.js:1337](web/static/netplay-lockstep.js#L1337)
- `_hostStream = captureStream(0)` — [netplay-lockstep.js:4868](web/static/netplay-lockstep.js#L4868)
- `startSpectatorStreamForPeer` — [netplay-lockstep.js:4908](web/static/netplay-lockstep.js#L4908) (called from line 2724)
- `request-late-join` emit site (joiner side, in `bootEmulator` →  late-join branch) — [netplay-lockstep.js:3931](web/static/netplay-lockstep.js#L3931)
- `dismissLateJoinPrompt` — [play.js:3079](web/static/play.js#L3079)
- Auto-spectate gate (extend here for new flow) — [play.js:571](web/static/play.js#L571)
- `roomData.status` access in join-room ack handler — [play.js:648](web/static/play.js#L648)
- `_isSmashRemix()` helper (gameId === 'smash-remix' or hash match) — [netplay-lockstep.js:1345](web/static/netplay-lockstep.js#L1345)
- `_players_payload` (spectator romReady missing today) — [signaling.py:220](server/src/api/signaling.py#L220)
- `GET /room/{room_id}` (game_id missing today) — [app.py:618](server/src/api/app.py#L618)
- `join-room` ack response (game_id missing today) — [signaling.py:601](server/src/api/signaling.py#L601)
- `data-message` server relay (broadcast, no per-SID targeting) — [signaling.py:1020](server/src/api/signaling.py#L1020)
- `sendLateJoinState` emit site (add `targetSid` here) — [netplay-lockstep.js:4639](web/static/netplay-lockstep.js#L4639)
- `handleLateJoinState` receiver (add `targetSid` filter here) — [netplay-lockstep.js:4653](web/static/netplay-lockstep.js#L4653)
- Server `_claim_slot_locked` (template for new events) — [signaling.py:634](server/src/api/signaling.py#L634)
- Server `claim-slot` blocked while playing — [signaling.py:644](server/src/api/signaling.py#L644)
- Server reconnect short-circuit (`_swap_sid` in `join-room`) — [signaling.py:475](server/src/api/signaling.py#L475)
- Netplay invariants (I1, I2) — [docs/netplay-invariants.md](docs/netplay-invariants.md)
