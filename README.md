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

**Rollback** — All players run the emulator in sync. Inputs are exchanged every frame over WebRTC DataChannels in a full mesh (up to 4 players, 6 connections). Uses a [patched mupen64plus-next WASM core](build/) with deterministic timing (`_kn_set_deterministic`, `_kn_set_frame_time`) and a [C-level GGPO-style rollback engine](build/kn_rollback/) (`_kn_pre_tick` / `_kn_post_tick`) that predicts remote inputs and replays on misprediction, keeping responsive play under ~150 ms RTT. Strict lockstep is the silent stall fallback inside the same engine (boot convergence, menu phase-lock gate, and stock cores without `kn_pre_tick`). Delay is symmetrically negotiated via host-authoritative broadcast at game start and works mobile↔mobile with bit-identical state across iOS Safari and desktop Chrome.

**Streaming** — Host runs the only emulator and streams the canvas as video to guests via WebRTC MediaStream. Guests send controller input back over a DataChannel. Zero desync by design — only one emulator instance exists. SDP is optimized for low-latency gaming (H264/VP9 preference, high bitrate floor, minimal jitter buffer).

Both modes support:
- Spectators (receive video stream, no input)
- Late join (mid-game state sync via compressed save state)
- Desync detection and opt-in resync (rollback)
- Virtual gamepad for mobile/touch devices
- Mode switching between games without page reload (WASM module hibernates between sessions)

## Quick start

Requires Python 3.11+, [uv](https://docs.astral.sh/uv/), and [just](https://github.com/casey/just).

```bash
# Install dependencies
just setup

# Start the server (HTTP, no Redis)
just serve
# → http://localhost:27888/
```

This is the fastest path to a running server. Over plain HTTP you can explore the lobby, create rooms, and use **streaming mode**. Rollback mode requires HTTPS — see below.

### What works without HTTPS

| Feature | HTTP | HTTPS |
|---|---|---|
| Lobby, rooms, Socket.IO | works | works |
| Streaming mode | works | works |
| Rollback mode | broken (needs SharedArrayBuffer) | works |
| High-res frame timing | degraded (~1ms vs ~5μs) | works |

Browsers gate `SharedArrayBuffer` and `performance.now()` precision behind
[cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated),
which requires a secure context (HTTPS). The server sends the required
`COOP`/`COEP` headers automatically — you just need HTTPS.

### Full setup (HTTPS + Redis)

```bash
# One-time: generate HTTPS certs (see HTTPS setup below)
just certs

# Start dev server (Redis + HTTPS)
just dev
# → https://<your-domain>:27888/
```

### HTTPS setup (required for rollback)

HTTPS is required — browsers need `crossOriginIsolated` (SharedArrayBuffer, high-res timers) which only works over secure contexts. `just certs` issues a real Let's Encrypt certificate via [lego](https://go-acme.github.io/lego/) using the Cloudflare DNS-01 challenge, so the cert is trusted by every device (including mobile) without installing a local CA. The subdomain never needs to resolve publicly — point it at your LAN IP via local DNS (AdGuard, Pi-hole, `/etc/hosts`, etc.).

#### 1. Install lego

```bash
brew install lego  # macOS
# or download a release: https://github.com/go-acme/lego/releases
```

#### 2. Create a Cloudflare API token

In the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens), create a token with **Zone:DNS:Edit** scoped to the zone you'll use.

#### 3. Configure and generate certs

Add to `server/.env`:

```bash
LEGO_EMAIL=you@example.com
LEGO_DOMAIN=kn-test.example.com
CLOUDFLARE_DNS_API_TOKEN=your-scoped-token-here
```

Then:

```bash
just certs
```

Certs land in `certs/`. Re-run `just certs` to renew (Let's Encrypt certs expire every ~90 days).

#### Alternative: mkcert (localhost only)

[mkcert](https://github.com/FiloSottile/mkcert) works for localhost but requires installing its CA on every mobile device. Prefer the lego flow for cross-device testing.

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

The server handles room creation, player coordination, and WebRTC signaling. Once peers are connected, game data flows directly between browsers — the server is idle during rollback gameplay. Redis persists room state across deploys and reconnects.

All frontend assets are self-hosted (EmulatorJS, Socket.IO) — zero CDN dependencies. The server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers to enable `crossOriginIsolated` on all browsers, unlocking SharedArrayBuffer and high-resolution `performance.now()`.

## Project structure

```
server/              Python signaling server (FastAPI + Socket.IO + uvloop)
  src/
    main.py            Entry point — serves API, Socket.IO, and static frontend
    state.py           Redis-backed room persistence
    ratelimit.py       Per-IP rolling-window rate limiting
    db.py              SQLite database (aiosqlite + Alembic migrations)
    api/
      app.py           REST endpoints, security headers (COOP/COEP/CSP), admin API
      signaling.py     Socket.IO events — rooms, WebRTC relay, ROM sharing, game data
      payloads.py      Pydantic v2 payload models + @validated decorator
      og.py            Open Graph image generation (Playwright HTML screenshots)
web/                 Static frontend (HTML + JS, served by FastAPI)
  index.html           Lobby — create/join rooms, invite links
  play.html            Game page — overlay, EmulatorJS embed, toolbar
  admin.html           Admin dashboard (session logs, events, feedback, screenshots)
  error.html           Error/fallback page
  static/
    play.js            Play page orchestrator (Socket.IO, overlay, ROM handling, engine dispatch)
    lobby.js           Lobby controller (room creation, invite links)
    admin.js           Admin dashboard logic (sessions, events, feedback, screenshots)
    netplay-rollback.js    Primary engine: GGPO-style C-level rollback (4P mesh WebRTC, prediction + replay); strict lockstep is the silent stall fallback inside this file
    netplay-lockstep.js    Deprecated 16-line compat shim (loads window.NetplayLockstep alias for cached pages)
    netplay-streaming.js   Streaming engine (host video → guests via WebRTC MediaStream)
    gamepad-manager.js     True analog gamepad input (3-stage pipeline: deadzone → scale → N64 quantize)
    controller-settings.js In-game controller settings panel
    virtual-gamepad.js     On-screen touch controls for mobile
    shared.js              Input encoding/decoding, wire format, input application to WASM
    kn-audio.js            AudioWorklet pump + rollback audio capture
    kn-desync-detector.js  Field-granular cross-peer desync detection (RDRAM probes)
    kn-diagnostics.js      Rollback diagnostics ring buffer (RB-CHECK, audit log)
    kn-vision-client.js    Claude / GPT-4o vision client for screenshot-diff desync analysis
    audio-worklet-processor.js  AudioWorklet ring buffer for rollback audio
    core-redirector.js     Redirect EJS core download to patched WASM, IDB cache management
    api-sandbox.js         Browser API interception (rAF, performance.now, getGamepads)
    storage.js             Safe localStorage/sessionStorage wrapper
    kn-state.js            Shared cross-module state
    feedback.js            In-app feedback collection
    version.js             Version display + changelog modal
    version-guard.js       Cross-tab version mismatch guard (forces reload after deploys)
    ejs-loader.js          EmulatorJS loader shim (boot + script setup hooks)
    socket.io.min.js       Self-hosted Socket.IO client (v4.8.3)
    ejs/                   Self-hosted EmulatorJS runtime, compression libs, localization
    ejs/cores/             Patched mupen64plus-next WASM core
build/               WASM core build system (Docker + C patches)
tests/               E2E tests (pytest + Playwright) + VGP visual regression
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
| `mupen64plus-ai-determinism.patch` | AI DMA deterministic audio interface timing |
| `mupen64plus-fpu-trace.patch` | FPU operation tracing for cross-platform determinism verification |
| `mupen64plus-softfloat.patch` | SoftFloat FPU for bit-exact cross-platform floating point |
| `retroarch-deterministic-timing.patch` | RetroArch `_emscripten_get_now()` override + AUDIO_FLAG_SUSPENDED bypass |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | CORS origin — set to your domain in production |
| `PORT` | `27888` | Server listen port |
| `MAX_ROOMS` | `100` | Maximum concurrent rooms |
| `MAX_SPECTATORS` | `20` | Maximum spectators per room |
| `REDIS_URL` | — | Redis connection URL (required for session persistence) |
| `REDIS_HOST` | `redis` | Redis host (used if REDIS_URL not set) |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password |
| `ADMIN_KEY` | — | Admin API key for management endpoints |
| `LOG_RETENTION_DAYS` | `14` | Auto-delete old session data after N days |
| `DB_PATH` | `data/kn.db` | SQLite database file path |
| `IP_HASH_SALT` | random | Salt for IP address hashing (random per restart if unset) |
| `TRUSTED_PROXY_IPS` | — | Comma-separated trusted proxy IPs for X-Forwarded-For |
| `TURN_SECRET` | — | HMAC secret for time-limited TURN credentials |
| `TURN_SERVERS` | — | Comma-separated TURN server URLs |
| `ICE_SERVERS` | — | Legacy static ICE server config (JSON) |
| `DISABLE_HTTPS` | — | Set to disable HTTPS even when certs are present |
| `DISABLE_RATE_LIMIT` | — | Set to `1` to disable per-IP rate limiting (dev only) |
| `DEBUG_MODE` | — | Enable debug endpoints and local log files |
| `GIT_VERSION` | — | Override version string (set automatically in Docker) |

## REST endpoints

**Public:**

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /list?game_id=...` | Room listing (EmulatorJS-Netplay compatible) |
| `GET /room/{room_id}` | Room info (rate-limited) |
| `GET /ice-servers` | ICE/TURN server configuration |
| `GET /api/cached-state/{rom_hash}` | Retrieve cached save state |
| `POST /api/cache-state/{rom_hash}` | Upload save state to cache |
| `POST /api/session-log` | HTTP fallback for session log flush |
| `POST /api/client-event` | Client event logging |
| `POST /api/feedback` | Feedback submission |
| `GET /api/rom-hashes` | Known ROM hashes |
| `GET /og-image/{room_id}.png` | Open Graph card image for social sharing |

**Admin** (requires `ADMIN_KEY`):

| Endpoint | Description |
|---|---|
| `GET /admin/api/stats` | Server statistics |
| `GET /admin/api/session-logs` | List session logs |
| `GET /admin/api/session-logs/{log_id}` | Download a session log |
| `GET /admin/api/client-events` | List client events |
| `GET /admin/api/client-events/{event_id}` | Client event detail |
| `GET /admin/api/feedback` | List feedback |
| `GET /admin/api/feedback/{feedback_id}` | Feedback detail |
| `GET /admin/api/screenshots/{match_id}` | List screenshots for a match |
| `GET /admin/api/screenshots/img/{screenshot_id}` | Serve screenshot image |

## Current status

V1 is feature-complete and deployment-ready:

- Lobby with room creation, invite links, and spectator support
- 4-player deterministic rollback netcode (GGPO-style C-level engine, mobile↔mobile bit-identical)
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
