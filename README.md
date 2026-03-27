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

Requires Python 3.11+, Redis, [Tailscale](https://tailscale.com), and [just](https://github.com/casey/just).

```bash
# Install dependencies
just setup

# One-time: generate HTTPS certs (see Tailscale setup below)
just certs

# Start dev server (Redis + HTTPS)
just dev
# → https://<your-hostname>.ts.net:27888/
```

### Tailscale setup (required)

HTTPS is required — browsers need `crossOriginIsolated` (SharedArrayBuffer, high-res timers) which only works over secure contexts. Tailscale provides real Let's Encrypt certificates trusted by all devices including mobile — no CA installation needed.

#### 1. Install Tailscale

Install on your dev machine and any test devices (phone, tablet). All devices must be on the same Tailnet.

- **macOS:** [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142) or `brew install tailscale`
- **iOS/Android:** Install from your device's app store
- **Linux:** [tailscale.com/download/linux](https://tailscale.com/download/linux)

#### 2. Enable HTTPS certificates

In the [Tailscale admin console](https://login.tailscale.com/admin/dns), enable **DNS → HTTPS Certificates** for your Tailnet.

#### 3. Configure and generate certs

Add your Tailscale hostname to `.env` (find it at [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)):

```bash
# .env
TAILSCALE_HOSTNAME=your-machine.tail1234.ts.net
```

Then generate certs:

```bash
just certs
```

This handles the platform-specific cert generation (macOS sandbox, Linux) and copies them to `certs/`. Certs expire every ~90 days — just re-run `just certs` to renew.

#### 4. (Optional) ACL for cross-device access

If testing from a phone, ensure your Tailscale ACL allows traffic to port 27888. The default "allow all" ACL works; if customized, add a rule for `tcp:27888`.

#### Alternative: mkcert (localhost only)

[mkcert](https://github.com/FiloSottile/mkcert) works for localhost but requires installing its CA on every mobile device. Prefer Tailscale for cross-device testing.

### Docker

```bash
docker build -t kaillera-next .
docker run -p 27888:27888 -e ALLOWED_ORIGIN="https://yourdomain.com" kaillera-next
```

The Docker image runs as a non-root user with a health check on `/health`.

### Production (Docker Swarm / Portainer)

```bash
docker stack deploy -c docker-compose.prod.yml kaillera-next
```

Includes Redis for session persistence (blue-green deploys, reconnect survival) and persistent log volumes.

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
           │ + Redis             │
           │ :27888              │
           └─────────────────────┘
```

The server handles room creation, player coordination, and WebRTC signaling. Once peers are connected, game data flows directly between browsers — the server is idle during lockstep gameplay. Redis persists room state across deploys and reconnects.

All frontend assets are self-hosted (EmulatorJS, Socket.IO) — zero CDN dependencies. The server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers to enable `crossOriginIsolated` on all browsers, unlocking SharedArrayBuffer and high-resolution `performance.now()`.

## Project structure

```
server/              Python signaling server (FastAPI + Socket.IO + uvloop)
  src/
    main.py            Entry point — serves API, Socket.IO, and static frontend
    state.py           Redis-backed room persistence
    ratelimit.py       Per-IP rolling-window rate limiting
    api/
      app.py           REST endpoints, security headers (COOP/COEP/CSP)
      signaling.py     Socket.IO events — rooms, WebRTC relay, ROM sharing, game data
web/                 Static frontend (HTML + JS, served by FastAPI)
  index.html           Lobby — create/join rooms, invite links
  play.html            Game page — overlay, EmulatorJS embed, toolbar
  admin.html           Sync log management (pin, delete, download)
  static/
    play.js            Play page orchestrator (Socket.IO, overlay, ROM handling, engine dispatch)
    lobby.js           Lobby controller (room creation, invite links)
    netplay-lockstep.js    Deterministic lockstep engine (4P mesh WebRTC)
    netplay-streaming.js   Streaming engine (host video → guests via WebRTC MediaStream)
    gamepad-manager.js     True analog gamepad input (3-stage pipeline: deadzone → scale → N64 quantize)
    virtual-gamepad.js     On-screen touch controls for mobile
    shared.js              Input encoding/decoding, wire format, input application to WASM
    audio-worklet-processor.js  AudioWorklet ring buffer for lockstep audio
    core-redirector.js     Redirect EJS core download to patched WASM, IDB cache management
    api-sandbox.js         Browser API interception (rAF, performance.now, getGamepads)
    kn-state.js            Shared cross-module state
    socket.io.min.js       Self-hosted Socket.IO client (v4.8.3)
    ejs-loader.js          Self-hosted EmulatorJS loader (v4.2.3)
    ejs/                   Self-hosted EmulatorJS runtime, compression libs, localization
    ejs/cores/             Patched mupen64plus-next WASM core
build/               WASM core build system (Docker + C patches)
tests/               E2E tests (pytest + Playwright)
docs/                Roadmap, MVP plan, design specs
certs/               TLS certificates for HTTPS dev (gitignored)
```

## Building the WASM core

The pre-built patched core is included at `web/static/ejs/cores/`. You only need to rebuild if you modify the C patches.

The build compiles a patched mupen64plus-next core with:
- Deterministic timing exports (`_kn_set_deterministic`, `_kn_set_frame_time`)
- C-level resync exports (`_kn_sync_hash`, `_kn_sync_read`, `_kn_sync_write`, `_kn_sync_hash_regions`)
- Frame-locked audio exports (`_kn_get_audio_ptr`, `_kn_get_audio_samples`, `_kn_reset_audio`, `_kn_get_audio_rate`)
- Strict IEEE 754 floating-point (`-fno-fast-math`, `-ffp-contract=off`)
- NaN canonicalization via `wasm-opt --denan` (injected before `--asyncify`)
- Deterministic RNG (`srand(0)`) and RTC

### Build steps

```bash
# 1. Build the Docker image with Emscripten SDK (one-time, ~10 min)
docker build -t emulatorjs-builder build/

# 2. Compile the patched core (~5-15 min depending on CPU)
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh

# 3. Deploy to web/static/ejs/cores/
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

The build clones EmulatorJS's forks of mupen64plus-libretro-nx and RetroArch, applies patches from `build/patches/`, compiles to LLVM bitcode, links through RetroArch with asyncify, and packages into a 7z `.data` archive that EmulatorJS loads at runtime.

### Patches

| Patch | Description |
|---|---|
| `mupen64plus-kn-all.patch` | Core exports: deterministic timing, resync hash/read/write, audio capture |
| `mupen64plus-deterministic-timing.patch` | `features_cpu.c` and `profile.c` timing fixes |
| `mupen64plus-wasm-determinism.patch` | Strict FP compile flags, FPU NaN canonicalization, `srand(0)`, deterministic RTC |
| `retroarch-deterministic-timing.patch` | RetroArch `_emscripten_get_now()` override for frame-based timing |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS origin — set to your domain in production |
| `PORT` | `27888` | Server listen port |
| `MAX_ROOMS` | `50` | Maximum concurrent rooms |
| `MAX_SPECTATORS` | `10` | Maximum spectators per room |
| `REDIS_URL` | — | Redis connection URL (required for session persistence) |
| `ADMIN_KEY` | — | Admin API key for sync log management |
| `LOG_RETENTION_DAYS` | `7` | Auto-delete unpinned sync logs after N days |
| `LOG_MAX_FILES` | `500` | Maximum sync log files before oldest are pruned |

## REST endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /list?game_id=...` | Room listing (EmulatorJS-Netplay compatible) |
| `GET /room/{room_id}` | Room info (rate-limited) |
| `GET /ice-servers` | ICE/TURN server configuration |
| `GET /api/cached-state/{rom_hash}` | Retrieve cached save state |
| `POST /api/cache-state/{rom_hash}` | Upload save state to cache |
| `POST /api/sync-logs` | Upload sync diagnostic logs |
| `GET /api/admin/logs` | List sync logs (admin) |
| `DELETE /api/admin/logs/{name}` | Delete a sync log (admin) |
| `POST /api/admin/logs/{name}/pin` | Pin/unpin a sync log (admin) |

## Current status

V1 is feature-complete and deployment-ready:

- Lobby with room creation, invite links, and spectator support
- 4-player deterministic lockstep with auto frame delay
- Streaming mode (host video → guests) with SDP optimization
- Spectators and late join (mid-game state sync)
- Desync detection with opt-in star-topology resync
- P2P ROM sharing with legal consent flow
- True analog gamepad input (3-stage pipeline matching RMG-K/N-Rage)
- Virtual gamepad for mobile/touch devices
- Cross-origin isolation (COOP/COEP) for high-res timers on all browsers
- Per-IP rate limiting and security hardening (CSP, non-root Docker)
- Save state caching to eliminate host/guest boot asymmetry
- Redis-backed session persistence for zero-downtime deploys
- Self-hosted EmulatorJS and Socket.IO (zero CDN dependencies)

## License

GPL-3.0
