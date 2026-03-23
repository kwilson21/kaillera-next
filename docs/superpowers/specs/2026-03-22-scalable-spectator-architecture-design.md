# Scalable Spectator Architecture

## Problem

Each spectator currently requires a separate WebRTC MediaStream from the host —
a separate video encode and upload per viewer. This is O(n) on the host's CPU
and bandwidth and does not scale beyond a handful of spectators.

## Solution

Two spectator strategies, selectable by the user:

1. **Input-sync** (lockstep only): spectators receive the same small input data
   that players exchange and run their own emulator locally. No video at all.
2. **Video chunk relay** (either mode): host encodes canvas video as binary
   chunks via MediaRecorder, sends over DataChannel. Spectators relay chunks as
   raw bytes to other spectators — no decode, no re-encode, zero quality loss.
   The server assigns the relay tree topology.

Both strategies reuse existing systems (ROM sharing, late-join save state sync,
DataChannels, Socket.IO room state). Spectators can pause (disconnect) and
unpause (rejoin) at any time.

## Input-Sync Spectators (lockstep mode)

In lockstep, all players run identical emulators exchanging inputs every frame.
A spectator is essentially a "player who doesn't send inputs."

### Flow

1. Spectator joins room (existing flow).
2. ROM is shared via existing P2P ROM sharing.
3. Late-join save state sync delivers current game state (existing flow).
4. Spectator boots emulator in replay mode: receives all player inputs via
   DataChannel, feeds them to the local emulator each frame.
5. Spectator renders the game locally — pixel-perfect, zero bandwidth for video.

### Data budget

- ~4 bytes per player per frame x 4 players x 60 fps = ~960 bytes/sec total.
- Host cost: small — the host must compose a merged input frame (all players'
  inputs for the current frame, ~16 bytes) and send it on each spectator's
  DataChannel. The current lockstep tick loop (`getActivePeers()`) filters out
  spectators (slot === null), so input forwarding to spectators is new work.

### Replay mode tick loop

The spectator runs a different tick loop from players:

1. Does NOT read local input or send inputs to peers.
2. Waits for a merged input message from the host containing all players'
   inputs for the current frame (tagged with frame number).
3. Writes each player's input to the corresponding WASM memory slot.
4. Advances the emulator by one frame.

This is a simpler loop than the player tick (no input exchange, no stall
detection, no rollback). The host composes the merged message from the inputs
it already collects during its normal lockstep tick.

### Pause/unpause

- Pause: spectator disconnects from room, emulator stops.
- Unpause: spectator rejoins, receives fresh save state via late-join sync,
  resumes from current game state.

### Input distribution

Players already exchange inputs via peer-to-peer DataChannels. For input-sync
spectators, the simplest approach is to have one player (the host, slot 0)
forward the merged input frame to each spectator peer's DataChannel. The host
already has all player inputs (required for its own lockstep loop) and already
maintains DataChannel connections to spectators (used today for the video
stream). This adds negligible overhead — the input frame is ~16 bytes.

Alternatively, with the relay tree (below), the host sends inputs to tier-1
spectators, who forward to tier-2, etc. This distributes the fan-out. The
server's topology assignment applies equally to input forwarding and video
chunk forwarding.

## Video Chunk Relay (either mode)

For streaming mode (only host runs the emulator) or for lockstep spectators who
prefer not to run an emulator (e.g., mobile viewers), the host encodes canvas
video as binary chunks and spectators relay those chunks through a tree.

### Chunk capture (host)

```
canvas → captureStream(0) → MediaRecorder (WebM/VP8, 100ms timeslice)
  → ondataavailable → send chunk as binary on DataChannel
```

The host calls `captureStream(0)` on the game canvas (already done today for
the current spectator stream), creates a MediaRecorder with
`mimeType: 'video/webm; codecs=vp8'` and `timeslice: 100`, and sends each
`ondataavailable` blob as a binary message on the DataChannel to tier-1
spectators.

Audio (lockstep mode): the host's `_audioDestNode.stream` (already captured
for the current spectator system) is added as an audio track to the
MediaRecorder input, so chunks contain both video and audio.

Audio (streaming mode): streaming mode does not currently have an
`_audioDestNode`. The host must create an `AudioContext` +
`MediaStreamDestination` and route emulator audio to it (mirroring the lockstep
approach), or the video chunks will be video-only with audio handled via a
separate path (e.g., WebRTC audio track on the host's peer connection, which
is already the case today).

### Chunk relay (spectator)

A relay spectator receives a binary chunk on its parent DataChannel and:

1. Appends the chunk to its local MSE SourceBuffer for playback.
2. Forwards the identical bytes on each child DataChannel.

No decode, no re-encode. The relay peer's CPU cost is near zero — it is piping
bytes between DataChannels.

### MSE playback (spectator)

Each spectator creates a `<video>` element backed by a MediaSource:

```
new MediaSource() → sourceopen → addSourceBuffer('video/webm; codecs=vp8')
  → on each chunk: sourceBuffer.appendBuffer(chunk)
```

The video element plays the stream. The spectator sees the same quality as the
host regardless of tree depth.

**Initialization segment**: MSE requires the first appended buffer to be a
valid WebM initialization segment (EBML header + Tracks). MediaRecorder
produces this as its first `ondataavailable` blob. The host (or relay parent)
must cache this init segment and send it to any new spectator before forwarding
live chunks. Without this, a mid-stream joiner's MSE will reject chunks.

**Append queuing**: MSE's SourceBuffer throws if `appendBuffer()` is called
while `updating === true`. The implementation must queue incoming chunks and
append them sequentially (listen for `updateend` to dequeue the next chunk).
At 10 chunks/second this is manageable.

### Relay tree topology

```
Host (root)
├── Spectator A (tier-1 relay)
│   ├── Spectator D (tier-2)
│   └── Spectator E (tier-2)
├── Spectator B (tier-1 relay)
│   └── Spectator F (tier-2)
└── Spectator C (tier-1 relay)
```

- Branching factor: 3 (each node relays to at most 3 children).
- Max depth: 3 tiers.
- Capacity: 3 + 9 + 27 = 39 spectators from a single host encode.
- Latency per tier: ~100-200ms (MediaRecorder buffering). Tier-2 spectators
  see ~200-400ms delay — acceptable for watching.

### Server topology management

The signaling server (signaling.py) manages the tree centrally. It already
knows every participant via Socket.IO room state.

**Parent assignment**: when a video spectator joins, the server picks a parent:

1. Collect all nodes in the tree (host + relay spectators).
2. Filter to nodes with fewer than 3 children and marked as relay-eligible.
3. Prefer the shallowest node (lowest tier), break ties by fewest children.
4. Tell the new spectator which peer to connect to (via a new
   `spectator-assigned` Socket.IO event containing the parent's socket ID).
5. The parent's client creates a new WebRTC peer connection (via the existing
   signaling relay) and opens a dedicated DataChannel (`{ ordered: true }`,
   reliable) to the new spectator for chunk forwarding. This is a new
   connection path — spectator-to-spectator WebRTC connections do not exist in
   the current architecture but the signaling relay (`webrtc-signal` handler)
   already supports any-to-any within a room.

**Churn recovery**: when a relay node disconnects:

1. Server detects disconnect (existing `_leave` handler).
2. Server identifies orphaned children (spectators whose parent was the
   disconnected node).
3. Server reassigns each orphan to a new parent using the same assignment
   algorithm.
4. Orphaned spectators reconnect — interruption of ~3-6 seconds (server
   notification + new WebRTC handshake + ICE/DTLS + init segment + next
   keyframe), then stream resumes. The orphan's MSE SourceBuffer must be
   cleared and re-initialized with the new parent's init segment.

**Relay eligibility and connection quality**: not all spectators should relay.

- On connect, each spectator measures DataChannel RTT to their parent via a
  quick ping/pong exchange (3 round trips, take median).
- Spectator reports RTT to server via Socket.IO.
- Server marks spectators with RTT above a threshold (e.g., 200ms) as
  "leaf-only" — they are never assigned children.
- If a relay node's children report degraded chunk delivery (e.g., chunks
  arriving late or gaps), the server can reassign those children to a better
  relay. This uses the same churn recovery path.

## Spectator Mode Selection

When a spectator joins a running lockstep game, they are offered a choice:

- **"Run game locally"** → input-sync path (needs ROM, runs emulator)
- **"Watch stream"** → video chunk relay path (lighter, no ROM needed)

In streaming mode, spectators always use the video chunk relay (only the host
has the emulator).

The choice is presented in the existing late-join overlay UI. Default is
input-sync for desktop browsers, video relay for mobile (detected via
`screen.width < 768` combined with user agent heuristics —
`navigator.maxTouchPoints` alone misclassifies touch-enabled laptops).

## What this replaces

The current spectator system in netplay-lockstep.js:

- `startSpectatorStream()` — captures canvas at 640x480 via `captureStream`,
  adds MediaStream tracks to each spectator's RTCPeerConnection individually.
- `startSpectatorStreamForPeer()` / `addStreamToPeer()` — adds tracks to a
  specific peer connection.
- `showSpectatorVideo()` — creates a `<video>` element from incoming
  MediaStream tracks.

All of this is replaced. The canvas capture changes from MediaStream tracks to
MediaRecorder chunks. The per-peer track management changes to per-peer
DataChannel chunk forwarding. The spectator video element changes from a
WebRTC-backed `<video>` to an MSE-backed `<video>`.

In netplay-streaming.js, the host's `pc.ontrack` video streaming to spectators
is similarly replaced with chunk-based forwarding.

## New Socket.IO events

| Event | Direction | Payload | Description |
|---|---|---|---|
| `spectator-assigned` | server→client | `{parentSid, mode}` | Tells spectator which peer to connect to and the spectator mode |
| `spectator-quality` | client→server | `{rtt}` | Spectator reports connection quality |

## Code changes by file

| File | Change | ~Lines |
|---|---|---|
| `shared.js` (new) | MSE playback (init segment caching, append queuing), chunk relay logic (receive + forward + backpressure), shared constants/functions extracted from lockstep+streaming | ~180 |
| `netplay-lockstep.js` | Replace `startSpectatorStream` with MediaRecorder chunk capture; compose and send merged input frames to spectators; spectator replay-mode tick loop; spectator-to-spectator peer connection support | ~120 |
| `netplay-streaming.js` | Replace per-peer video track adding with chunk capture + DataChannel forwarding; audio capture setup | ~60 |
| `signaling.py` | Relay tree data structure, parent selection algorithm, orphan detection and reassignment in `_leave`, relay eligibility tracking, `spectator-assigned` and `spectator-quality` events | ~150 |
| `play.js` | Spectator mode choice UI in late-join overlay, pause/unpause flow | ~50 |

~560 lines new, replacing ~80 lines of current spectator code. Net: ~480 lines.

## Risks and mitigations

1. **MediaRecorder → MSE codec compatibility**: MediaRecorder must produce
   chunks that MSE can consume without gaps. VP8 WebM is the safest
   combination. Mitigation: validate this pairing in isolation first before
   wiring up the full chain.

2. **Safari MSE + WebM**: Safari's MSE support for WebM is limited (added in
   Safari 15, still has quirks). Mitigation: detect Safari and fall back to
   standard WebRTC MediaStream relay (the current approach, capped at a few
   spectators). Alternatively, use `video/mp4; codecs=avc1` for MediaRecorder
   on Safari if supported.

3. **Keyframe propagation**: When a new spectator joins mid-stream, they need
   a keyframe to start decoding. MediaRecorder produces keyframes periodically
   (default ~1-2 seconds for VP8). The new spectator may see a brief blank
   before the first keyframe arrives. `MediaRecorder.requestData()` does NOT
   force a keyframe — it only flushes buffered data. Mitigation: accept the
   1-2 second wait for the next natural keyframe. The cached init segment
   (see MSE playback section) ensures the SourceBuffer is ready to receive it.

4. **DataChannel message size**: WebRTC DataChannel has a default max message
   size of ~256KB (SCTP). At 640x480 VP8, 100ms chunks are ~10-50KB — well
   within limits. No chunking of chunks needed.

5. **DataChannel backpressure**: When a relay node forwards chunks, if a
   downstream DataChannel is congested, `dc.send()` buffers data internally.
   The implementation must monitor `dc.bufferedAmount` and skip forwarding to
   congested children rather than letting the buffer grow unbounded. This also
   serves as a signal to the server to mark that child as a poor relay
   candidate.

6. **Relay capacity assumes all nodes are eligible**: The "39 spectators" max
   assumes every spectator can relay. In practice, some will be leaf-only
   (high RTT, slow connections). Effective capacity depends on the ratio of
   relay-eligible nodes. The branching factor should be configurable.

## Not in scope

- SFU or media server infrastructure.
- HLS/DASH segmenting or CDN integration.
- Distributed topology algorithms — the server picks parents centrally.
- Cloudflare Calls or TURN server integration.
- Recording or DVR functionality for spectators.
