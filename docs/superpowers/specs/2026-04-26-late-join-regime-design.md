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
`_readMenuLockstepPhase()` ([netplay-lockstep.js:1423](web/static/netplay-lockstep.js#L1423)),
which returns `{gameStatus, sceneCurr, inControllableMenu, gameplay, ...}`.

**One predicate decides the regime:** `phase.gameplay === true` (i.e.
`sceneCurr === 22 && gameStatus === 1`) means a match is actively running.
Anything else — title, mode select, CSS, stage select, results — is a safe
boundary.

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

- Joiner connects as a spectator (slot null), regardless of whether they
  asked to be a player.
- Existing spectator canvas-stream from host
  ([netplay-lockstep.js:4841](web/static/netplay-lockstep.js#L4841),
  `_hostStream = captureCanvas.captureStream(0)`) carries the live video.
  No emulator boots on the joiner; no save-state pause hits active peers.
- Joiner's gamepad and virtual-gamepad UI are dimmed/hidden with a clear
  status message: "Watching current match — controls activate at next
  character select."
- Local input is intentionally ignored at the input layer (already true for
  spectators today).
- When the active match ends and the host's `phase.gameplay` flips to false
  (results screen → CSS), the host runs a normal "promote spectator → player"
  flow that uses the existing player path: brief pause, state transfer,
  controls enable. Joiner sees "Joining match…" → "Controls enabled."

Reconnect is **not** late-join. A player whose slot was already in the active
roster and who lost connection comes back through today's pause-and-resync
regardless of phase — they have a P2 character that needs to keep playing.
The regime check applies only to *new* joiners (no prior slot).

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
                  is requester a known reconnect?
                ┌─────yes─────┘   └─────no──────┐
                ▼                                ▼
       reconnect path                   _isSmashRemix() ?
       (existing pause+resync)             ┌─yes─┘   └─no─┐
                                           ▼              ▼
                                  phase.gameplay ?    player path
                                   ┌─true─┘ └─false─┐
                                   ▼                ▼
                            spectator path     player path
                                   │                │
                                   │                ▼
                                   │       pause+state+resume
                                   │       controls enabled
                                   │
                              wait for phase.gameplay → false
                                   │
                                   ▼
                            promote to player
                            (player path: pause+state+resume)
                            controls enabled
```

The promotion at end-of-match runs the same code as a fresh CSS-time join.
Spectator state is plain — joiner is not in `_activeRoster`, has no input
loop, has no rollback ring entry. Promotion adds them via the existing
spectator → player transition path
([netplay-lockstep.js:2123–2133](web/static/netplay-lockstep.js#L2123)).

## UX

### Active players (during pause)

Replace the silent freeze with a small non-blocking banner anchored to the
toolbar:

> ⏸ **P3 joining…** *(2s)*

- Shown only when `_runSubstate === RUN_LATE_JOIN_PAUSE`.
- Counts up wall-clock seconds since pause began (`_lateJoinPausedAt` already
  exists at [netplay-lockstep.js:1335](web/static/netplay-lockstep.js#L1335)).
- Cleared on `late-join-resume` or timeout.

### Joiner (player path)

Replace generic "Loading…" with three explicit stages:

1. **Connecting** — WebRTC offer/answer/ICE complete to host.
2. **Syncing game state** — `late-join-state` received, decompressing,
   applying to RDRAM.
3. **Almost ready** — emulator booted, awaiting `late-join-resume`.

Each stage maps to an existing point in `dismissLateJoinPrompt` /
`initEngine` / `handleLateJoinState`. The status string is already routed
through `setStatus()` at [netplay-lockstep.js:2051](web/static/netplay-lockstep.js#L2051);
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
- **Joiner:** their incomplete player-init is torn down (`resetPeerState`
  for self-state, fall back to `_isSpectator = true`). Status flips to:
  "Sync failed — watching as spectator. Will retry at next character select."
- **No half-initialized player slot.** The joiner is either fully a player
  or fully a spectator; there is no in-between.

If the spectator-path canvas stream fails to start (host's `_hostStream`
not yet created, ICE fails, etc.), the joiner sees a still error card with
a manual "Retry" button. They are not promoted to the player path until a
spectator stream is at least attempted.

## Implementation surface

Files that change:

- **`web/static/netplay-lockstep.js`**
  - `handleLateJoinRequest` (line 2103): branch on `_readMenuLockstepPhase().gameplay`.
    For mid-match Smash Remix games, send `late-join-spectate` instead of
    `late-join-state`.
  - New message: `late-join-spectate` — tells joiner "you're a spectator,
    no state coming, watch the canvas stream."
  - New phase event: when host transitions from `phase.gameplay === true` to
    `false` (match ends), check for queued spectator-mode joiners and run
    promotion.
  - Reconnect detection: extend `request-late-join` payload to include
    `priorSlot` (from session storage / persistent ID). Host treats requests
    with a known prior slot as reconnects regardless of phase.

- **`web/static/play.js`**
  - `dismissLateJoinPrompt` / mid-game join handler ([play.js:707, 3079](web/static/play.js#L3079)):
    on receiving `late-join-spectate`, set `isSpectator = true` and skip
    `initEngine()`; show the persistent watching status.
  - Promotion handler: when host fires the promotion event, flip
    `isSpectator = false`, clear the watching banner, and run the existing
    player-init flow.
  - Stage-aware status copy in `setStatus` callback for the joiner.

- **`web/play.html`**
  - Banner element for active-players "P3 joining…" indicator.
  - Persistent watching status element (likely repurposed `#guest-status`).
  - Disabled-controls visual treatment for the spectator path.

No protocol breaking change for older clients — the message vocabulary
(`request-late-join`, `late-join-state`, `late-join-resume`) stays. New
messages (`late-join-spectate`, promotion event) are additive; an old client
receiving them ignores them and falls back to today's behavior, which is
exactly what we want for compatibility during deploy.

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

## Open questions

1. **Race: joiner connects exactly at CSS→match transition.** Host reads
   `phase.gameplay === false`, picks player path, sends `late-join-state`.
   By the time joiner's emulator boots and applies the state, the match has
   started. This is the same race we have today — the existing path handles
   it. Worth confirming via a session log that mid-CSS joins stay clean.

2. **Spectator stream startup latency.** Host's `_hostStream` is created on
   demand the first time a spectator connects. First-spectator may see a
   brief blank screen while the host attaches the canvas tracks. Acceptable
   for v1; if it's noticeable, add a "Connecting to stream…" status.

3. **Should we cache the regime decision per-joiner?** If `phase.gameplay`
   flips during the request handshake, the regime could change between
   "host decides path" and "joiner enters." The simpler answer is "host's
   decision wins; joiner trusts the message they got." Keep it that way.

## References

- `_readMenuLockstepPhase` — [netplay-lockstep.js:1423](web/static/netplay-lockstep.js#L1423)
- `handleLateJoinRequest` — [netplay-lockstep.js:2103](web/static/netplay-lockstep.js#L2103)
- `LATE_JOIN_TIMEOUT_MS` — [netplay-lockstep.js:425](web/static/netplay-lockstep.js#L425)
- `_hostStream` (spectator canvas stream) — [netplay-lockstep.js:4841](web/static/netplay-lockstep.js#L4841)
- `dismissLateJoinPrompt` — [play.js:3079](web/static/play.js#L3079)
- Spectator → player transition — [netplay-lockstep.js:2123](web/static/netplay-lockstep.js#L2123)
