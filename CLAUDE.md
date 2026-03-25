# kaillera-next — Project Context for Claude

## What this project is

A website where anyone can visit a URL and play retro games (initially SSB64)
online with friends — no emulator installation required. The browser runs EmulatorJS
(mupen64plus-next WASM core); players connect via WebRTC. The server handles rooms
and WebRTC signaling only.

The long-term goal is a clean protocol that desktop clients (Mupen64Plus, future Kaillera
compat) can also speak — but v1 ships the website first.

## Guiding principles

- **Finish it.** Scope decisions should favor shipping a working prototype over
  completeness. Cut features, not corners on what ships.
- **Python everywhere possible.** The developer's primary language is Python. Minimize
  the surface area of non-Python code.
- **Web-first in v1.** Browser + EmulatorJS + WebRTC. No installation for players.
- **Desktop clients in v2.** Mupen64Plus native netplay, Kaillera compat — after the
  website works.

## Architecture

```
V1 — Browser-based

  [Browser: EmulatorJS + ROM]        [Browser: EmulatorJS + ROM]
          │   Socket.IO (signaling)          │
          └──────────────┬───────────────────┘
                         ▼
              [kaillera-next server]
              Python FastAPI + Socket.IO
              - Room management (create/join/leave)
              - WebRTC offer/answer/ICE relay
              - Game data relay (save states, input)
              HTTP/WS :27888

  Lockstep mode: all players run the emulator in sync via WebRTC DataChannels.
  Streaming mode: host runs the emulator and streams video via WebRTC MediaStream.
  Server is idle after signaling completes (lockstep) or relays save states (initial sync).
```

## Repo structure

```
kaillera-next/
├── server/          # Python signaling + matchmaking server
│   ├── pyproject.toml
│   └── src/
│       ├── main.py          # entry point (FastAPI + Socket.IO + uvloop)
│       ├── ratelimit.py     # per-IP rate limiting
│       └── api/
│           ├── app.py       # FastAPI app (REST + security middleware)
│           └── signaling.py # Socket.IO events — rooms, WebRTC relay, game data
├── web/             # Static frontend
│   ├── index.html           # lobby: create/join rooms
│   ├── play.html            # game page: overlay + EmulatorJS + toolbar
│   └── static/
│       ├── lobby.js             # lobby controller
│       ├── play.js              # play page orchestrator
│       ├── netplay-lockstep.js  # deterministic lockstep engine (4P mesh)
│       ├── netplay-streaming.js # streaming engine (host video → guests)
│       ├── gamepad-manager.js   # gamepad profiles, remapping, slot assignment
│       ├── core-redirector.js   # redirect EJS core to patched WASM
│       ├── audio-worklet-processor.js  # AudioWorklet for lockstep audio
│       └── ejs/cores/           # patched mupen64plus-next WASM core
├── build/           # WASM core build system (Docker + patches)
├── tests/           # pytest + Playwright E2E tests
├── docs/            # roadmap and MVP plan
├── Dockerfile       # production Docker image
└── CHANGELOG.md     # version history
```

## V1 scope

| Feature | Status |
|---|---|
| Socket.IO signaling server (rooms + WebRTC relay) | done |
| Web lobby (create/join/spectate) | done |
| EmulatorJS embed + ROM drag-and-drop | done |
| Lockstep netplay (up to 4 players, mesh WebRTC) | done |
| Streaming netplay (host video → guests) | done |
| Spectators (canvas video stream from host) | done |
| Gamepad support (profiles, remapping wizard) | done |
| Late join (mid-game join with state sync) | done |
| Desync detection + resync (opt-in) | done |
| Security hardening (CSP, rate limiting, non-root Docker) | done |
| User auth / persistent rooms | later |
| Mupen64Plus desktop client | v2 |
| Kaillera protocol compat | v2 |
| KREC recording/playback | v2 |

## Socket.IO events

All events go through the default Socket.IO namespace (`/`).

| Event | Direction | Payload | Description |
|---|---|---|---|
| `open-room` | client→server | `{extra: {sessionid, playerId, player_name, room_name, game_id}, maxPlayers}` | Create room |
| `join-room` | client→server | `{extra: {sessionid, userid, player_name, spectate}}` | Join/spectate |
| `leave-room` | client→server | `{}` | Leave room |
| `claim-slot` | client→server | `{slot}` | Spectator → player |
| `start-game` | client→server | `{mode, rollbackEnabled}` | Host starts game |
| `end-game` | client→server | `{}` | Host ends game |
| `webrtc-signal` | bidirectional | `{target, offer/answer/candidate}` | WebRTC relay |
| `data-message` | client→server→room | `{type, ...}` | Save state / late-join relay |
| `snapshot` | client→server→room | `{...}` | Game snapshot relay |
| `input` | client→server→room | `{...}` | Input relay (streaming mode) |
| `rom-sharing-toggle` | client→server | `{enabled}` | Toggle host ROM sharing |
| `rom-ready` | client→server | `{ready}` | Player signals ROM loaded |
| `input-type` | client→server | `{type}` | Player reports input type (keyboard/gamepad) |
| `users-updated` | server→room | `{players, spectators, owner}` | Room state broadcast |
| `game-started` | server→room | `{mode, rollbackEnabled}` | Game started |
| `game-ended` | server→room | `{}` | Back to lobby |
| `room-closed` | server→room | `{reason}` | Room force-closed |

## Key decisions

- **Stack:** Python FastAPI + python-socketio + uvloop. Server latency doesn't affect
  game performance — WebRTC is P2P once the handshake completes.
- **Lockstep netplay:** Full mesh WebRTC DataChannels. Each player runs their own
  emulator; inputs are exchanged every frame with configurable delay buffering.
- **Streaming netplay:** Star topology. Host runs the only emulator, streams canvas
  video via WebRTC MediaStream. Guests send input back over DataChannel.
- **ROM handling:** User drag-and-drops ROM file; cached in IndexedDB.
- **Rooms are ephemeral:** No database. Rooms exist in memory while players are connected.
- **Patched WASM core:** mupen64plus-next compiled with deterministic timing patches
  (kn_set_deterministic, kn_set_frame_time) for lockstep sync. Falls back to stock
  CDN core with JS-level timing shim.

## Dev environment

- macOS (primary dev machine)
- Python 3.11+
- `uv` or `pip install .` for dependency management
- Docker for production builds
- `ALLOWED_ORIGIN` env var controls CORS (default `*`, set to your domain in production)
