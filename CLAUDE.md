# kaillera-next — Project Context for Claude

## What this project is

A website where anyone can visit a URL, log in, and play retro games (initially SSB64)
online with friends — no emulator installation required. The browser runs EmulatorJS;
players connect via WebRTC. The server handles rooms and WebRTC signaling only.

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
              HTTP/WS :8000

  Once WebRTC is established → game data flows P2P, server is idle.

V2 — Desktop clients (after v1 ships)

  [Mupen64Plus] ── binary TCP+UDP :45000 ── [server]
  [Kaillera clients] ── Kaillera UDP ────── [server]
```

## Monorepo structure

```
kaillera-next/
├── server/          # Python signaling + matchmaking server
│   ├── pyproject.toml
│   └── src/
│       ├── main.py          # entry point (FastAPI + Socket.IO + uvloop)
│       ├── session.py       # RoomManager — shared state
│       └── api/
│           ├── app.py       # FastAPI app (REST + static file serving)
│           └── signaling.py # Socket.IO namespace — room + WebRTC relay
├── web/             # Static frontend
│   ├── index.html   # lobby: create/join rooms
│   ├── play.html    # game page: EmulatorJS embed + signaling client
│   └── static/      # EmulatorJS assets
└── netplay/         # V2: Mupen64Plus binary protocol (existing protocol.py etc.)
```

## V1 scope

| Feature | Status |
|---|---|
| Socket.IO signaling server (rooms + WebRTC relay) | next |
| Web lobby (create/join room) | next |
| EmulatorJS embed + in-browser play | next |
| 2-player WebRTC netplay | next |
| User auth / persistent rooms | later |
| 4 players + spectators | v2 |
| Mupen64Plus desktop client | v2 |
| Kaillera protocol compat | v2 |
| KREC recording/playback | v2 |

## Socket.IO signaling — event reference

All events go through the `signaling` Socket.IO namespace (`/signaling`).

| Event | Direction | Payload | Description |
|---|---|---|---|
| `create_room` | client→server | `{username}` | Create room, server emits `room_created` |
| `room_created` | server→client | `{room_id, username}` | Confirms creation |
| `join_room` | client→server | `{room_id, username}` | Join existing room |
| `room_joined` | server→client | `{room_id, username, peer_username}` | Confirms join, tells both peers |
| `offer` | client→server | `{room_id, sdp}` | WebRTC offer (host→guest) |
| `answer` | client→server | `{room_id, sdp}` | WebRTC answer (guest→host) |
| `ice_candidate` | client→server | `{room_id, candidate}` | ICE candidate (either direction) |
| `leave_room` | client→server | `{room_id}` | Leave/disconnect |
| `peer_left` | server→client | `{username}` | Notifies remaining player |
| `error` | server→client | `{message}` | Error feedback |

## Key decisions made

- **Stack:** Python FastAPI + python-socketio + uvloop. Server latency doesn't affect
  game performance — WebRTC is P2P once the handshake completes.
- **EmulatorJS netplay:** Browser-native WebRTC for game data. Server only relays
  the ~10 signaling messages needed to establish the connection.
- **ROM handling:** Served statically from the server for v1. Legal note: only serve
  ROMs you own.
- **Rooms are ephemeral:** No database for v1. Rooms exist in memory while players
  are connected.
- **2-player first:** EmulatorJS netplay is 1 host + 1 guest. 4-player is v2.

## Dev environment

- macOS (primary dev machine)
- Python 3.11+
- `uv` or `pip install -e .` for dependency management

## What to work on next

1. Update `server/pyproject.toml` — add `python-socketio[asyncio_client]`, `uvloop`
2. Implement `server/src/api/signaling.py` — Socket.IO room + WebRTC relay
3. Update `server/src/main.py` — mount Socket.IO alongside FastAPI
4. Build `web/play.html` — EmulatorJS embed + Socket.IO signaling client
5. Build `web/index.html` — room lobby (create/join)
6. Smoke test: two browser tabs, verify WebRTC handshake, load ROM, play
