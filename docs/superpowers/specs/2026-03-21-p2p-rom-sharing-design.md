# P2P ROM Sharing — Design Spec

## Overview

Host-to-peer ROM sharing over WebRTC DataChannels. The server never sees ROM
data — it only tracks whether sharing is enabled. Both parties must consent:
the host opts in with a legal disclaimer, and each joiner accepts or declines.

## Approach

Option A: host sends the ROM directly to each joiner over a dedicated WebRTC
DataChannel (`rom-transfer`). With max 4 players the host uploads the ROM at
most 3 times. Simple, no server involvement in the data path, fits the
existing architecture.

## Signaling & State

### Server (signaling.py)

- Add `rom_sharing: bool = False` to the `Room` dataclass.
- New event `rom-sharing-toggle` (client→server): host sends `{enabled: bool}`.
  Server validates sender is room owner, updates `room.rom_sharing`, broadcasts
  `rom-sharing-updated {enabled: bool}` to all room members.
- `GET /room/:id` response includes `rom_sharing` (snake_case, matching Python
  convention). Socket.IO payloads use `romSharing` (camelCase, matching JS
  convention). The client maps between them — same pattern as existing
  `rom_hash`/`romHash`.
- `users-updated` broadcasts include `romSharing` for existing members.
- On ownership transfer (host leaves): `rom_sharing` resets to `false`.

### Client (play.js)

- `_romSharingEnabled`: tracks current room state.
- `_romSharingDecision`: `'accepted'`, `'declined'`, or `null`. Page-lifetime
  scoped (not persisted). Leaving and rejoining (which reloads the page) resets
  it to `null`, so the joiner is re-prompted. This is intentional. Survives
  host toggling off and back on within the same page load — no re-prompt.

## Transfer Mechanism

### Transfer initiation

1. Joiner clicks Accept in the prompt UI.
2. Joiner sends `{type: 'rom-accepted'}` over the existing `lockstep`
   DataChannel (or via Socket.IO `data-message` if WebRTC is not yet connected
   — see "Mid-game joiner sequence" below). When using the Socket.IO fallback,
   the message is broadcast to all room members via `data-message`; the host
   filters by sender sid and other peers ignore it.
3. Host receives this, creates a new DataChannel labeled `'rom-transfer'` on
   the existing `RTCPeerConnection` for that peer.
4. Joiner receives the new channel via the `ondatachannel` delegation hook
   (see "DataChannel delegation" below) and begins reassembly when data arrives.

### DataChannel

- Label: `'rom-transfer'`, created on the existing `RTCPeerConnection`.
- `binaryType: 'arraybuffer'`, ordered + reliable (default SCTP).
- Set `dc.bufferedAmountLowThreshold = 256 * 1024` after creating the channel.
- Separate from the `'lockstep'` channel — no interference with input traffic.

### DataChannel delegation

The lockstep engine currently assigns `peer.pc.ondatachannel` as a property
(single handler) to receive the `lockstep` channel. To support additional
channels like `rom-transfer`, the engine's `ondatachannel` handler checks
`e.channel.label`: if the label is `'lockstep'`, it handles it as before; for
any other label, it delegates to a callback registered by play.js (e.g.,
`engine.onExtraDataChannel(remoteSid, channel)`). This keeps the lockstep
engine unaware of ROM transfer details while giving play.js access to new
channels on existing peer connections.

### Message delegation

The lockstep engine's `onmessage` handler on the `lockstep` DataChannel
processes known message types (`ready`, `emu-ready`, `sync-hash:*`, etc.).
To support `{type: 'rom-accepted'}` without coupling the engine to ROM logic,
the engine forwards unrecognized string messages to a callback registered by
play.js (e.g., `engine.onUnhandledMessage(remoteSid, data)`). The host's
play.js listens for `rom-accepted` messages through this hook and initiates
the transfer.

### Protocol

1. **Header** (JSON string):
   `{type: 'rom-header', name: 'game.z64', size: 16777216, hash: 'abc123...'}`
   The host uses the already-computed `_romHash` (from initial ROM load) as the
   `hash` field. If `_romHash` is null (hash computation failed during load),
   the header omits `hash` and the joiner skips verification.
2. **Data chunks**: raw `ArrayBuffer`, 64KB each.
3. **Completion** (JSON string): `{type: 'rom-complete'}`

Maximum accepted ROM size: 128MB. The receiver rejects the transfer if
`header.size` exceeds this limit. The sender also refuses to share ROMs above
this limit.

### Flow control

Sender checks `dc.bufferedAmount` before each chunk. If above 1MB, pauses and
resumes on `dc.onbufferedamountlow`.

### Reassembly

Joiner collects chunks into an array, creates a `Blob` on completion, verifies
`blob.size === header.size`, computes SHA-256 and compares to `header.hash`.

### Failure handling

- DataChannel closes mid-transfer: toast "ROM transfer interrupted", fall back
  to ROM drop zone. `_romSharingDecision` stays set (no re-prompt).
- Hash mismatch after reassembly: discard, show error, fall back to manual upload.

## UI & User Experience

### Host — overlay checkbox

- Location: `#host-controls` section in the pre-game overlay.
- Label: "Share ROM with players", unchecked by default.
- Disclaimer text (always visible below checkbox):
  > By sharing, you confirm you have the legal right to distribute this file.
  > Recipients must own a legal copy of this game.
- Enabled only when host has a ROM loaded (`_romBlob` exists).
- Toggling emits `rom-sharing-toggle`. Can toggle pre-game or mid-game.
- Hidden in streaming mode (guests don't need ROMs). When the host switches
  mode to streaming, the checkbox hides and sharing is disabled client-side
  (emit `rom-sharing-toggle {enabled: false}`). Switching back to lockstep
  does not re-enable it automatically.

### Joiner — accept/decline prompt

Shown when `rom-sharing-updated` fires with `enabled: true` and
`_romSharingDecision === null`:

> The host is offering to share their ROM file with you.
>
> By accepting, you confirm you own a legal copy of this game.
> The file is transferred directly from the host — not through any server.
>
> **[Accept]** **[Decline — I'll load my own]**

- Accept: `_romSharingDecision = 'accepted'`. Hides ROM drop zone. Shows
  progress UI. Signals host to begin transfer (see "Transfer initiation").
- Decline: `_romSharingDecision = 'declined'`. ROM drop zone stays visible.

### Progress UI

Replaces ROM drop zone content during transfer:
`"Receiving ROM... 45% (7.2 / 16.0 MB)"`

Cancel button available during transfer — closes the `rom-transfer`
DataChannel, discards received chunks, shows ROM drop zone. Does not reset
`_romSharingDecision` (user can still manually load a ROM).

On completion: `"Loaded: game.z64 (from host)"` with `.loaded` class.

### ROM drop zone visibility

| Sharing | Decision | Transfer | Drop zone shows |
|---------|----------|----------|-----------------|
| on | accepted | in progress | progress bar + cancel |
| on | accepted | complete | "Loaded: name (from host)" |
| on | declined | — | normal drop zone |
| on | null | — | accept/decline prompt |
| off | any | — | normal drop zone |

### Mid-game joiner sequence

`GET /room/:id` returns `rom_sharing: true`. The joiner sees the accept/decline
prompt instead of the late-join ROM prompt. On accept:

1. `initEngine()` is called without a ROM. The engine establishes WebRTC
   connections but does not call `bootEmulator()`.
2. Once the DataChannel to the host is open, joiner sends `{type: 'rom-accepted'}`
   over the `lockstep` channel.
3. Host creates the `rom-transfer` DataChannel and sends the ROM.
4. Joiner receives ROM, sets `_romBlob`, calls `bootEmulator()`, then the
   engine proceeds with late-join state sync as normal.

This requires play.js's `initEngine()` function to conditionally skip the
`bootEmulator()` call when no ROM is loaded. The lockstep engine's own `init()`
does not call `bootEmulator()` — that call originates in play.js's `initEngine()`
(which calls `bootEmulator()` then creates the engine). In connect-only mode,
play.js skips `bootEmulator()`, creates the engine (which establishes WebRTC),
and defers `bootEmulator()` until the ROM transfer completes.

### ROM is ephemeral

Shared ROMs live only in memory (`_romBlob`). Not cached to IndexedDB. Discarded
when the user leaves or the page unloads.

## Edge Cases

### Ownership transfer

Host leaves → new host inherits → `rom_sharing` resets to `false` server-side.
New host must explicitly re-enable. In-progress transfers abort; joiners fall
back to ROM drop zone.

Joiners who already completed a transfer retain their ROM in memory. They are
not re-prompted or re-transferred. If the new host enables sharing and has a
different ROM, existing joiners keep their original ROM (hash mismatch will be
caught at game start by the existing `romHash` check in `start-game`).

### Host toggles sharing off mid-transfer

Host closes all `rom-transfer` DataChannels. Joiners who completed keep their
ROM. Joiners mid-transfer fall back to drop zone.

### Spectators

Spectators don't need ROMs. ROM sharing prompt is skipped. If a spectator
claims a player slot while sharing is enabled and `_romSharingDecision === null`,
they get prompted at that point.

### Lockstep vs streaming

- Lockstep: all players need the ROM. Sharing applies to all player-slot joiners.
- Streaming: only host runs the emulator. ROM sharing checkbox hidden/disabled.

### Start game gating

Host can start even if transfers are in progress. Joiners who accepted but
haven't received the ROM yet see "Receiving ROM..." in the overlay while
others play. Once transfer completes, `bootEmulator()` runs and they join.

## Files Changed

- `server/src/api/signaling.py` — `Room` dataclass field, event handlers,
  broadcast updates, ownership-transfer reset.
- `web/static/play.js` — toggle, prompt, transfer logic, progress UI,
  drop zone visibility, DataChannel management.
- `web/play.html` — checkbox + disclaimer markup, progress bar element.
- `web/static/netplay-lockstep.js` — expose peer connections for ROM transfer
  DataChannel creation (e.g., `getPeerConnection(sid)` accessor or
  `ondatachannel` hook that delegates non-lockstep channels to play.js).
  Support "connect-only" mode for mid-game joiners awaiting ROM transfer.
