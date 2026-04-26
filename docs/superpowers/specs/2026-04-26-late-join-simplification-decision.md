# Late-join simplification decision

**Date:** 2026-04-26
**Status:** active direction

## Decision

Do not ship the spectator-first late-join regime from
`2026-04-26-late-join-regime-design.md`.

Return to the original player-first late-join model and make it reliable:

- A player who joins a running room joins as a player when a slot is available.
- If the room is full, the joiner is auto-rotated to spectator.
- Explicit watch links (`?spectate=1`) remain spectators.
- Late join should never use the spectator stream as a transition state.
- The host may briefly pause while transferring state, but active players should see a clear status/toast.
- The joiner should load state as quickly as practical and then send inputs as part of the active roster.

## What We Learned

The spectator-first design solved one theoretical issue but created too much ownership surface:

- It conflated queued late joiners with real spectators.
- It required new server events, promotion queues, failure demotion, phase reporting, and new state-machine transitions.
- It made CSS joins fragile because `room.status === "playing"` is too coarse; a started room can be at CSS.
- It created a bad UX failure mode: a late joiner could receive a stream and have no inputs.
- The system does not currently have a dedicated product owner for a multi-regime late-join flow, so the added complexity is not worth it.

The simpler target is to keep one late-join path and improve it.

## Minimal Scope

Keep the current `request-late-join` flow:

1. Joiner enters the room as a player if a slot is open.
2. Joiner boots the emulator.
3. Joiner requests state from the host.
4. Host pauses active players briefly and sends current state.
5. Joiner applies state.
6. Joiner sends `late-join-ready`.
7. Host broadcasts the roster so every peer includes the joiner's slot.
8. Joiner inputs begin flowing normally.

Targeted improvements only:

- Target the large `late-join-state` payload to the joiner instead of broadcasting it to all room members.
- Keep the host timeout recovery simple: resume active peers and disconnect/retry the joiner if state application does not complete.
- Add a lightweight status/toast for active players: someone is joining / resumed.
- Verify the joiner slot is included in the roster after `late-join-ready`.

## Explicit Non-goals

- No server-side promotion queue.
- No `host-promote-spectator` event.
- No `become-spectator` failure recovery loop.
- No automatic spectator stream for late joiners.
- No host phase reporting as part of v1.
- No CSS-vs-gameplay regime split beyond the existing player-first behavior.

## Edge Cases To Preserve

- Full room: auto-rotate to spectator.
- Explicit spectator/watch link: stay spectator and receive normal spectator behavior.
- Reconnect: preserve the existing reconnect path.
- Non-Smash games: keep the same late-join mechanics.
- Timeout: active players must resume even if the joiner fails.

## Verification

Before shipping the simplified fix, test:

- Two-player running room, third player late joins and can send inputs.
- Existing players see a short joining/resume indication and are not left frozen.
- Full fifth joiner becomes spectator.
- Explicit watch link remains spectator.
- The large late-join state is delivered only to the target joiner.
