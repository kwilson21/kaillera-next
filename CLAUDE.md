# kaillera-next — Project Context for Claude

## What this project is

A modern, cross-platform reimagining of Kaillera netplay. The goal is to let players
play retro games (initially SSB64 via Mupen64Plus) online together, with a clean
protocol that allows anyone to build their own frontend.

The original Kaillera is abandoned and Windows-only. This project modernizes it while
staying compatible enough to matter.

## Guiding principles

- **Finish it.** Scope decisions should favor shipping a working prototype over
  completeness. Cut features, not corners on what ships.
- **Python everywhere possible.** The developer's primary language is Python. Minimize
  the surface area of non-Python code.
- **Protocol-first in v2.** For v1, build the whole stack and extract the spec from
  what ships. The frontend↔server WebSocket protocol gets formally documented in v2.
- **Don't split the community without a plan.** We target Mupen64Plus native netplay
  for v1 (cross-platform, modern), then add Kaillera protocol compatibility in v2.

## Architecture

```
Layer 1 — Emulator ↔ Server
  [Mupen64Plus]  ── Mupen64Plus native netplay (TCP+UDP) ──┐
  [legacy clients]── Kaillera protocol (UDP) ─────────── (v2)─┤
                                                              [Matchmaking Server]

Layer 2 — Server (Python / FastAPI + asyncio)
  - Speaks Mupen64Plus netplay protocol (TCP port 45000, UDP port 45000)
  - Manages rooms, relay, KREC recording
  - Exposes the Frontend WebSocket protocol (HTTP/WS port 8000)

Layer 3 — Frontend ↔ Server  (the public protocol)
  [Desktop Launcher]──┐
  [Discord Bot]       ├── Frontend WebSocket protocol ── [Server]
  [Any client]    ────┘
```

## Monorepo structure

```
kaillera-next/
├── server/       # Python matchmaking + relay server
│   ├── pyproject.toml
│   └── src/
│       ├── main.py          # entry point — starts TCP, UDP, and HTTP servers
│       ├── session.py       # SessionManager — shared state across all servers
│       ├── netplay/
│       │   ├── protocol.py  # packet definitions (struct pack/unpack)
│       │   ├── tcp.py       # TCP handler (registration, settings, saves)
│       │   └── udp.py       # UDP handler (per-frame input relay)
│       └── api/
│           └── app.py       # FastAPI app — frontend WebSocket + REST (later)
├── launcher/     # Desktop launcher — Python + pywebview (later)
└── protocol/     # Frontend WebSocket protocol spec (v2)
```

## V1 scope

| Feature | Status |
|---|---|
| Mupen64Plus native netplay relay server | in progress |
| Matchmaking / lobby API (FastAPI) | pending |
| KREC recording | pending |
| Desktop launcher (Python + pywebview) | pending |
| 4 players + spectators | pending |
| Kaillera protocol compat | v2 |
| P2P / STUN | v2 |
| KREC playback | v2 |
| Protocol spec published | v2 |

## Mupen64Plus netplay protocol — quick reference

All multi-byte integers are **big-endian** (network byte order).
TCP and UDP share the same port (45000).

### TCP packets (after the type byte is read)

| Type | Direction | Remaining bytes | Description |
|---|---|---|---|
| 0x01 | P1→server | variable | Send save file |
| 0x02 | client→server | variable | Request save file |
| 0x03 | P1→server | 24 | Send emulator settings |
| 0x04 | client→server | 0 (server replies 24B) | Request settings |
| 0x05 | client→server | 7 | Register player |
| 0x06 | client→server | 0 (server replies 24B) | Get all registrations |
| 0x07 | client→server | 4 | Disconnect notice |

**Register (0x05) remaining 7 bytes:** `player:u8, plugin:u8, rawdata:u8, reg_id:u32be`
**Response:** `assigned_slot:u8, buffer_target:u8`

**Get registrations (0x06) response — 24 bytes (4 × 6):**
Each player slot: `reg_id:u32be, plugin:u8, rawdata:u8`  (0 reg_id = empty slot)

**Settings — 24 bytes (6 × u32/i32 big-endian):**
`count_per_op, count_per_op_denom_pot, disable_extra_mem, si_dma_duration, emumode, no_compiled_jump`

### UDP packets

| Type | Direction | Size | Description |
|---|---|---|---|
| 0x00 | client→server | 11 | Send key input |
| 0x01 | server→client | 5 + N×9 | Receive key input |
| 0x02 | client→server | 12 | Request key input |
| 0x03 | server→client | 5 + N×9 | Receive key input (gratuitous push) |
| 0x04 | client→server | (CP0_REGS×4)+5 | Sync data (desync detection) |

**Send key (0x00):** `type:u8, control_id:u8, netplay_count:u32be, keys:u32be, plugin:u8`

**Request key (0x02):**
`type:u8, control_id:u8, reg_id:u32be, netplay_count:u32be, spectator:u8, buffer_size:u8`

**Receive key (0x01 / 0x03) header — 5 bytes:**
`type:u8, player:u8, status:u8, player_lag:u8, event_count:u8`
status bits: bit0=desync, bits1-4=player N disconnected
Each event (9 bytes): `count:u32be, keys:u32be, plugin:u8`

**Sync data (0x04):**
`type:u8, vi_counter:u32be, cp0_registers[CP0_REGS_COUNT × u32be]`
CP0_REGS_COUNT = 32. Sent every 600 VI interrupts for desync detection.

### reg_id

- Assigned by our matchmaking layer (not by the emulator)
- Passed to Mupen64Plus by the launcher at startup
- Used to attribute UDP traffic to the correct session/player
- 0 is the null/sentinel value — server must assign non-zero IDs

## Key decisions made

- **Language split:** Python for server + launcher. Thin C bridge for the DLL (v2).
- **Emulator:** Mupen64Plus for v1 — cross-platform, well-built, user-confirmed.
- **Frontend:** Desktop app via Python + pywebview (HTML/CSS/JS UI in a native window).
- **Relay-only for v1:** No P2P / STUN until v2. Server relays all UDP frames.
- **KREC:** Record in v1, playback in v2. Reference implementation: n02 client (OSS).
- **Buffer target default:** 2 frames.
- **Ports:** TCP 45000 + UDP 45000 (matches Mupen64Plus default), HTTP/WS 8000.

## Dev environment

- macOS (primary dev machine)
- Python 3.11+
- `uv` or `pip install -e .` for dependency management

## What to work on next

1. Implement `server/src/netplay/protocol.py` — packet struct definitions
2. Implement `server/src/session.py` — SessionManager
3. Implement `server/src/netplay/tcp.py` — TCP handler
4. Implement `server/src/netplay/udp.py` — UDP relay
5. Implement `server/src/main.py` — entry point
6. Smoke test: connect two Mupen64Plus instances and verify inputs relay
