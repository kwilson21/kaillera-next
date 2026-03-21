# kaillera-next

Play retro games online with friends — no downloads, no emulator setup. Visit the URL, drop your ROM, and play.

kaillera-next is a browser-based netplay platform built on [EmulatorJS](https://emulatorjs.org). Players connect through WebRTC for low-latency peer-to-peer gameplay, with the server handling only room management and signaling.

## How it works

1. One player creates a room and shares the invite link
2. Others join by pasting the link or room code
3. Everyone drops their ROM file (drag-and-drop, cached locally)
4. Host picks a mode and starts the game

### Netplay modes

**Lockstep** — All players run the emulator in perfect sync. Inputs are exchanged every frame over WebRTC DataChannels in a full mesh (up to 4 players, 6 connections). Uses a [patched mupen64plus-next WASM core](build/) with deterministic timing for frame-accurate synchronization.

**Streaming** — Host runs the only emulator and streams the canvas as video to guests via WebRTC. Guests send controller input back over a DataChannel. Zero desync by design — only one emulator exists.

Both modes support spectators (receive video stream, no input) and late join (mid-game state sync).

## Quick start

```bash
# Clone and install
git clone https://github.com/user/kaillera-next.git
cd kaillera-next
pip install server/

# Run
cd server && python -c "from src.main import run; run()"
# → http://localhost:8000
```

### Docker

```bash
docker build -t kaillera-next .
docker run -p 8000:8000 -e ALLOWED_ORIGIN="https://yourdomain.com" kaillera-next
```

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
           │ :8000               │
           └─────────────────────┘
```

The server handles room creation, player coordination, and WebRTC signaling (~10 messages per connection). Once peers are connected, game data flows directly between browsers. The server is idle during gameplay (lockstep) or relays initial save states (late join).

## Project structure

```
server/        Python signaling server (FastAPI + Socket.IO)
web/           Static frontend (HTML + JS)
build/         WASM core build system (Docker + C patches)
tests/         E2E tests (pytest + Playwright)
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS origin — set to your domain in production |

## Current status

V1 is feature-complete: lobby, 4-player lockstep, streaming mode, spectators, gamepad support, late join, desync detection, and Docker deployment.

## License

GPL-3.0
