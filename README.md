# kaillera-next

Play retro games online with friends — no downloads, no emulator setup. Visit the URL, drop your ROM, and play.

kaillera-next is a browser-based netplay platform built on [EmulatorJS](https://emulatorjs.org) (mupen64plus-next WASM core). Players connect through WebRTC for low-latency peer-to-peer gameplay, with the server handling only room management and signaling.

## How it works

1. One player creates a room and shares the invite link
2. Others join by clicking the link or entering the room code
3. Everyone drops their ROM file (drag-and-drop, cached in IndexedDB)
   — or the host shares their ROM via P2P transfer
4. Host picks a netplay mode and starts the game

### Netplay modes

**Lockstep** — All players run the emulator in perfect sync. Inputs are exchanged every frame over WebRTC DataChannels in a full mesh (up to 4 players, 6 connections). Uses a [patched mupen64plus-next WASM core](build/) with deterministic timing (`_kn_set_deterministic`, `_kn_set_frame_time`) for frame-accurate synchronization. Auto frame delay is negotiated via RTT measurement at game start.

**Streaming** — Host runs the only emulator and streams the canvas as video to guests via WebRTC MediaStream. Guests send controller input back over a DataChannel. Zero desync by design — only one emulator instance exists. SDP is optimized for low-latency gaming (VP9/H264 preference, high bitrate floor, minimal jitter buffer).

Both modes support:
- Spectators (receive video stream, no input)
- Late join (mid-game state sync via compressed save state)
- Desync detection and opt-in resync (lockstep)
- Virtual gamepad for mobile/touch devices

## Quick start

```bash
# Clone and install
git clone <repo-url>
cd kaillera-next
pip install server/

# Run (serves both API and web frontend on :27886)
kaillera-server
# → http://localhost:27886
```

Or run directly:

```bash
cd server && python -c "from src.main import run; run()"
```

### Docker

```bash
docker build -t kaillera-next .
docker run -p 27886:27886 -e ALLOWED_ORIGIN="https://yourdomain.com" kaillera-next
```

The Docker image runs as a non-root user with a health check on `/health`.

## Architecture

```
┌──────────────────┐         ┌──────────────────┐
│ Browser A        │         │ Browser B        │
│ EmulatorJS +     │◄──P2P──►│ EmulatorJS +     │
│ WebRTC mesh      │  WebRTC │ WebRTC mesh      │
└────────┬─────────┘         └────────┬─────────┘
         │  Socket.IO                 │
         └────────────┬───────────────┘
                      ▼
           ┌─────────────────────┐
           │ kaillera-next       │
           │ FastAPI + Socket.IO │
           │ :27886              │
           └─────────────────────┘
```

The server handles room creation, player coordination, and WebRTC signaling. Once peers are connected, game data flows directly between browsers — the server is idle during lockstep gameplay. For late join, compressed save states are relayed via Socket.IO (too large for WebRTC SCTP).

## Project structure

```
server/              Python signaling server (FastAPI + Socket.IO + uvloop)
  src/
    main.py            Entry point — serves API, Socket.IO, and static frontend
    ratelimit.py       Per-IP rolling-window rate limiting
    api/
      app.py           REST endpoints (/health, /list, /room, /ice-servers, state cache)
      signaling.py     Socket.IO events — rooms, WebRTC relay, ROM sharing, game data
web/                 Static frontend (HTML + JS, served by FastAPI)
  index.html           Lobby — create/join rooms, invite links
  play.html            Game page — overlay, EmulatorJS embed, toolbar
  static/
    play.js            Play page orchestrator (Socket.IO, overlay, ROM handling, engine dispatch)
    lobby.js           Lobby controller (room creation, invite links, player list)
    netplay-lockstep.js    Deterministic lockstep engine (4P mesh WebRTC)
    netplay-streaming.js   Streaming engine (host video → guests via WebRTC MediaStream)
    gamepad-manager.js     Profile-based gamepad detection, mapping, slot assignment
    virtual-gamepad.js     On-screen touch controls for mobile
    audio-worklet-processor.js  AudioWorklet ring buffer for lockstep audio
    core-redirector.js     Redirect EJS core download to patched WASM
    api-sandbox.js         Browser API interception (rAF, getGamepads) for manual frame stepping
    kn-state.js            Shared state module
    shared.js              Shared utilities
    ejs/cores/             Patched mupen64plus-next WASM core
build/               WASM core build system (Docker + C patches)
tests/               E2E tests (pytest + Playwright)
docs/                Roadmap, MVP plan, design specs
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS origin — set to your domain in production |

## REST endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /list?game_id=...` | Room listing (EmulatorJS-Netplay compatible) |
| `GET /room/{room_id}` | Room info (rate-limited) |
| `GET /ice-servers` | ICE/TURN server configuration |
| `GET /api/cached-state/{rom_hash}` | Retrieve cached save state |
| `POST /api/cache-state/{rom_hash}` | Upload save state to cache |

## Current status

V1 is feature-complete and deployment-ready:

- Lobby with room creation, invite links, and spectator support
- 4-player deterministic lockstep with auto frame delay
- Streaming mode (host video → guests) with SDP optimization
- Spectators and late join (mid-game state sync)
- Desync detection with opt-in star-topology resync
- P2P ROM sharing with legal consent flow
- Profile-based gamepad support with remapping wizard
- Virtual gamepad for mobile/touch devices
- Per-IP rate limiting and security hardening (CSP, non-root Docker)
- Save state caching to eliminate host/guest boot asymmetry

## License

GPL-3.0
