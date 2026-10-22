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

  Rollback mode: GGPO-style C-level rollback engine. All players run their own
    emulator and exchange inputs over WebRTC DataChannels; misprediction triggers
    bit-exact replay via the patched WASM core. Strict lockstep is the silent
    fallback path inside the same engine when the core does not export kn_pre_tick.
  Streaming mode: host runs the only emulator and streams video via WebRTC MediaStream.
  Server is idle once signaling completes (rollback) or relays save states for
  initial sync and late join.
```

## Repo structure

```
kaillera-next/
├── server/          # Python signaling + matchmaking server
│   ├── pyproject.toml
│   └── src/
│       ├── main.py          # entry point (FastAPI + Socket.IO + uvloop)
│       ├── state.py         # Redis-backed room persistence
│       ├── state_cache.py   # Redis-backed save-state cache for late joiners
│       ├── ratelimit.py     # per-IP rate limiting
│       ├── db.py            # database: SQLite or Cloudflare D1 backend (src/dbbackend/), SQL migrations in server/migrations/
│       ├── migrate.py       # plain-SQL schema migrations shared by SQLite/D1 (replaces Alembic)
│       ├── blobstore.py     # blob storage for screenshots (R2 in prod, local folder in dev)
│       ├── retention.py     # flags matches with a crash/freeze/desync; sweeps expired ones
│       ├── match_rotation.py # rolls up ended session logs into Parquet + match_metrics rows
│       ├── stats.py         # "matches started in last 7 days" counter for the front page
│       ├── landing_build.py # content-hash build id shared by the server and the landing Worker
│       └── api/
│           ├── app.py       # FastAPI app (REST + security middleware)
│           ├── og.py        # OG meta-tag injection + build-time-rendered OG cards
│           ├── og_card.py   # live per-room invite card composed from the host's latest frame (PIL)
│           ├── turn.py      # Cloudflare Realtime TURN credentials for /ice-servers
│           ├── signaling.py # Socket.IO events — rooms, WebRTC relay, game data
│           ├── payloads.py  # Pydantic v2 payload models for Socket.IO validation
│           ├── desync_vision.py  # Claude/GPT-4o vision endpoint for screenshot diff
│           └── desync_prompts.py # Prompt templates for vision-based desync analysis
├── web/             # Static frontend
│   ├── index.html           # front page: open-rooms board, create/join (static, no framework)
│   ├── join.html            # invite page (/join?room=CODE): who invited you, Join vs Watch, waking
│   ├── play.html            # game page: overlay + EmulatorJS + toolbar
│   ├── admin.html           # admin dashboard: session logs, client events, feedback, desync events, stats
│   ├── error.html           # error/fallback page
│   └── static/
│       ├── landing.js           # front page: board poll, waking state, header marks
│       ├── join.js              # invite page: room lookup, full/closed/in-app states
│       ├── lagviz.js            # waking-state lag visualizer (front page + invite page)
│       ├── landing.css          # front page styles (direction A tokens)
│       ├── fonts/               # self-hosted Barlow Condensed + IBM Plex Sans (OFL)
│       ├── play.js              # play page orchestrator
│       ├── netplay-rollback.js  # primary engine — GGPO-style C-level rollback (4P mesh)
│       ├── rollback-shadow-worker.js # experimental presentation-only shadow worker used by netplay-rollback.js
│       ├── netplay-lockstep.js  # deprecated compat shim (loads window.NetplayLockstep alias)
│       ├── netplay-streaming.js # streaming engine (host video → guests)
│       ├── shared.js            # input encoding/decoding, cheats, wire format
│       ├── gamepad-manager.js   # gamepad profiles, remapping, slot assignment
│       ├── switch2-usb.js       # WebUSB handshake that wakes the Switch 2 Pro Controller
│       ├── controller-settings.js # in-game controller settings panel
│       ├── virtual-gamepad.js   # on-screen touch controls for mobile
│       ├── kn-state.js          # cross-module shared state (KNState)
│       ├── kn-audio.js          # AudioWorklet + lockstep audio capture
│       ├── kn-desync-detector.js # field-granular cross-peer desync detection
│       ├── kn-diagnostics.js    # rollback diagnostics (RB-CHECK, audit log)
│       ├── kn-vision-client.js  # Claude/GPT-4o vision API client for screenshot diff
│       ├── storage.js           # safe localStorage/sessionStorage wrapper
│       ├── api-sandbox.js       # save/restore native browser APIs
│       ├── core-redirector.js   # redirect EJS core to patched WASM
│       ├── ejs-loader.js        # EmulatorJS loader shim (booting + script setup hooks)
│       ├── audio-worklet-processor.js  # AudioWorklet for lockstep audio
│       ├── feedback.js          # in-app feedback collection
│       ├── version.js           # version display + changelog modal
│       ├── version-guard.js     # cross-tab version mismatch guard (forces reload after deploys)
│       ├── admin.js             # admin dashboard logic (sessions, events, feedback, screenshots)
│       └── ejs/cores/           # patched mupen64plus-next WASM core
├── build/           # WASM core build system (Docker + patches)
├── deploy/static/   # landing Worker (serves / and /join, proxies the rest; route live on kaillera-next.thesuperhuman.us)
├── tests/           # pytest + Playwright E2E tests
├── docs/            # roadmap, netplay invariants, and design/research notes
├── Dockerfile       # production Docker image
└── CHANGELOG.md     # version history
```

## V1 scope

| Feature | Status |
|---|---|
| Socket.IO signaling server (rooms + WebRTC relay) | done |
| Web lobby (create/join/spectate) | done |
| EmulatorJS embed + ROM drag-and-drop | done |
| Rollback netplay (up to 4 players, GGPO-style C-level engine, mesh WebRTC, lockstep stall fallback) | done |
| Streaming netplay (host video → guests via WebRTC MediaStream) | done |
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
| `open-room` | client→server | `{extra: {sessionid, persistentId, reconnectToken, player_name, room_name, game_id}, password, maxPlayers}` | Create room |
| `join-room` | client→server | `{extra: {sessionid, persistentId, reconnectToken, player_name, spectate}, password}` | Join/spectate |
| `leave-room` | client→server | `{}` | Leave room |
| `claim-slot` | client→server | `{slot}` | Spectator → player |
| `release-slot` | client→server | `{}` | Player → spectator ("Watch instead"), lobby only |
| `start-game` | client→server | `{mode, resyncEnabled, romHash, gameId}` | Host starts game (`mode`: `"rollback"` \| `"streaming"`; legacy `"lockstep"` coerced to `"rollback"`) |
| `end-game` | client→server | `{}` | Host ends game |
| `set-name` | client→server | `{name}` | Update player display name |
| `set-mode` | client→server | `{mode}` | Host sets game mode |
| `set-game-id` | client→server | `{game_id}` | Host updates game_id after ROM identification |
| `webrtc-signal` | bidirectional | `{target, offer/answer/candidate/reconnect/requestRenegotiate}` | WebRTC relay |
| `rom-signal` | bidirectional | `{target, ...}` | Pre-game ROM transfer signaling |
| `data-message` | client→server→room | `{type, ...}` | Save state / late-join relay (4MB max) |
| `snapshot` | client→server→room | `{...}` | Game snapshot relay (64KB max) |
| `input` | client→server→room | `{...}` | Input relay (streaming mode, 64KB max) |
| `rom-sharing-toggle` | client→server | `{enabled}` | Toggle host ROM sharing |
| `set-listed` | client→server | `{listed}` | Host lists the room on the front-page board (never with a password) |
| `rom-ready` | client→server | `{ready, hash, name, size}` | Player signals ROM loaded (hash/name/size establish or check ROM identity) |
| `input-type` | client→server | `{type}` | Player reports input type (keyboard/gamepad) |
| `device-type` | client→server | `{type}` | Player reports device type |
| `session-log` | client→server | `{matchId, epoch, entries, summary, context, audit}` | Periodic sync log flush: only the log entries and input audit records (`audit: {epoch, entries}`) the server hasn't acked; acks `{lastSeq, auditLastSeq}` |
| `debug-sync` | client→server | `{...}` | Upload sync diagnostic log |
| `debug-logs` | client→server | `{...}` | Upload debug console log |
| `game-screenshot` | client→server | `{matchId, slot, frame, data}` | Periodic gameplay screenshot (debug mode) |
| `users-updated` | server→room | `{players, spectators, owner, romSharing, romHash, romName, romSize, hostRom, gameId, mode, status, listed}` | Room state broadcast |
| `upload-token` | server→client | `{token}` | HMAC token for upload endpoints |
| `reconnect-token` | server→client | `{token}` | HMAC token for session reconnection |
| `rom-sharing-updated` | server→room | `{romSharing}` | ROM sharing state changed |
| `game-started` | server→room | `{mode, resyncEnabled, romHash, romName, romSize, hostRom, gameId, matchId}` | Game started |
| `game-ended` | server→room | `{matchId}` | Back to lobby |

## Key decisions

- **Stack:** Python FastAPI + python-socketio + uvloop. Server latency doesn't affect
  game performance — WebRTC is P2P once the handshake completes.
- **Rollback netplay:** Full mesh WebRTC DataChannels. Each player runs their own
  emulator; the C-level GGPO-style rollback engine (`build/kn_rollback/kn_rollback.c`)
  predicts remote inputs, advances locally, and replays via state ring buffer +
  amortized restore on misprediction. Cross-platform determinism via SoftFloat FPU.
  Strict lockstep is the silent stall fallback inside the same engine (boot
  convergence, menu phase-lock gate) and the path used when the core does not
  export `kn_pre_tick`. Menu lockstep gate reads `game_status` from RDRAM.
  Host-authoritative resync remains as fallback for reconnection and late join.
- **Streaming netplay:** Star topology. Host runs the only emulator, streams canvas
  video via WebRTC MediaStream. Guests send input back over DataChannel.
- **ROM handling:** User drag-and-drops ROM file; cached in IndexedDB.
- **Rooms are ephemeral:** Live room state (players, slots, mode) stays in memory, with
  optional Redis persistence for zero-downtime deploys and reconnect survival — no SQL
  row per room. A separate database (SQLite or Cloudflare D1, `src/db.py`) persists
  session logs, match metrics, desync events and feedback for diagnostics and retention.
- **Patched WASM core:** mupen64plus-next compiled with deterministic timing patches
  (`kn_set_deterministic`, `kn_set_frame_time`), SoftFloat FPU, and rollback engine
  exports (`kn_pre_tick`, `kn_post_tick`, etc.). Falls back to stock CDN core with
  JS-level timing shim — in that case the engine takes its strict lockstep path.

## Netplay invariants

Two codified invariants govern the netplay tick loop. See
[docs/netplay-invariants.md](docs/netplay-invariants.md):

- **I1 — No stall without a timeout:** every tick-loop early-return that
  waits on external events has a wall-clock deadline and a recovery
  action. Every deadline site is listed in the invariants doc.
- **I2 — Reconnect starts clean:** all per-peer cleanup routes through
  `resetPeerState(slot, reason)`. Adding per-peer state without updating
  `resetPeerState` is a review-level violation.
- **Rollback integrity** (R1-R6): the C rollback engine must produce
  bit-correct state or fail loudly. Dev builds throw on violation;
  production logs `REPLAY-NORUN`, `RB-INVARIANT-FIXUP`,
  `FATAL-RING-STALE`, or `RB-LIVE-MISMATCH`. No mid-match auto-resync
  from these events — fix the root cause instead. See
  [docs/netplay-invariants.md §Rollback Integrity](docs/netplay-invariants.md).

A detection-only tick watchdog (MF6) logs `TICK-STUCK` for any residual
stall past I1/I2. **It takes no recovery action by design** — its only
job is to surface bugs we haven't found yet. Auto-recovery was
considered and rejected; see the rejected-alternatives section in the
invariants doc before proposing any watchdog that *acts* on stalls.

## Versioning

- **Auto-versioning** via a GitHub Actions workflow (`.github/workflows/version-bump.yml`)
  that runs `scripts/bump-version.sh` on push to `main` (also runnable locally via `just deploy`)
- Commit messages use **conventional commits**: `feat:` → minor bump, `fix:` → patch bump, anything else → no bump
- Only runs on the `main` branch
- Version displayed in page footer (`web/static/version.json`), changelog in modal (`web/static/changelog.json`)
- PRs are squash-merged; PR title becomes the commit message

## Lessons for agents

Hard-won rules from past sessions. Follow them unless the user says otherwise.

- **Keep PRs small and check size before merging.** Retargeting a stacked PR
  to `main` pulls in every unmerged commit of its base (#11 grew from ~3k to
  ~19k lines by absorbing #9). Look at the diff against `main` right before
  merging and flag anything unexpectedly large to the user.
- **Don't commit agent scratch work.** Iteration prompts, notes and one-off
  experiment scripts stay out of `docs/` and `tests/`. Scripts that are
  committed read paths from env vars, never a hardcoded `/Users/...`.
- **Netplay changes need a real two-player run.** `tests/rb-two-player.mjs`
  with `JITTER=20` must pass (all gameplay and game-state hashes match)
  before merging anything that touches the tick loop, sync, input or core.
  Headless single-page demo metrics are not enough.
- **Don't edit files under a running test.** `version-guard.js` reloads pages
  when served files change, which kills in-flight two-player runs. Make
  unrelated edits in a separate `git worktree`.
- **The cloud container distorts results.** Two headless emulators run at
  ~7–11 fps with software GL; canvas readbacks take seconds (use
  `?knperf=light`), measured RTT is inflated (so negotiated delay is too), and
  the menu autopilot can overshoot into Team Battle at delay ≥ 10. Treat
  multi-second freezes and menu timeouts there as environment first; confirm
  real bugs from the logs.
- **Which hash to trust.** `kn_game_state_hash` is the determinism signal:
  RDRAM minus blocks tainted by audio/framebuffer writes, plus the saved CPU
  state unless `kn_skip_post_rdram_in_hash` is set, so equal hashes don't
  always prove equal CPU state. `kn_full_state_hash` includes the tainted
  blocks, which legitimately differ after headless replays.
- **Core artifacts ship together.** The `.data` archive and the standalone
  `mupen64plus_next_libretro.{js,wasm}` (used by the Mode 2 worker) must come
  from the same build; URLs are content-hashed via `/api/core-info`.
- **Never tolerate a prediction mismatch.** Any "close enough" input match
  leaves peers with different state that nothing corrects. The C engine
  used to accept stick values in the same zone without a rollback; #14 made
  matching exact. Don't reintroduce a tolerance: filter jitter at the input
  source instead (`KNShared.createStickDeadband`).

## Dev environment

- macOS (primary dev machine)
- Python 3.11+
- `uv` or `pip install .` for dependency management
- Docker for production builds
- `ALLOWED_ORIGIN` env var controls CORS (default `*`, set to your domain in production)
- `PORT` (default 27888), `MAX_ROOMS` (default 100), `MAX_SPECTATORS` (default 20)
- `KEEPALIVE_SECONDS` (default 0 = off): play pages ping `/health` this often
- `PUBLIC_ORIGINS`: extra origins allowed to read `/health`, `/list`, `/room/*`,
  `/api/stats/public` (a static landing page on another domain); only matters
  when `ALLOWED_ORIGIN` is a specific origin (with `*`, any origin may read them)
- `KN_PROXY_SECRET`: shared with the landing Worker (`PROXY_SECRET` there);
  the server trusts the visitor IP the Worker forwards (`X-KN-Client-IP`)
  only when this matches. May be a comma-separated list ("new,old") to
  rotate the secret with no gap: either entry is trusted while both are
  listed. Unset = never trusted
- `IP_HASH_SALT`: salts IP hashes and also derives the room-token signing key,
  so reconnect tokens stay valid across restarts (random per process if unset)
- `REDIS_URL` (or `REDIS_PASSWORD` plus `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB`): backs the
  Redis room persistence above. Without `REDIS_URL`, `REDIS_PASSWORD` is required;
  host/port then default to `redis:6379`. With neither set, Redis is disabled and
  rooms stay in memory only
- `DB_PATH`: SQLite file location for the persistent database (`src/db.py`)
- `D1_DATABASE_ID`, `D1_API_TOKEN` (with `CF_ACCOUNT_ID`): switches `src/db.py` to the
  Cloudflare D1 backend instead of SQLite
- `ADMIN_KEY`: required to use the admin dashboard/API
- `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`: Cloudflare Realtime TURN credentials for
  `/ice-servers`
- `ANTHROPIC_API_KEY`, `DESYNC_VISION_ENABLED` (`=1`): enable the Claude/GPT-4o
  desync-vision endpoint
- `PER_IP_SPECTATOR_CAP` (default 3): max spectator slots one IP can hold in a room
- `ROM_SHARING_ENABLED` (default `true`): toggle host ROM P2P sharing
- `GAME_IMAGES_ENABLED` (default `true`): read into `og.py`'s `_GAME_IMAGES_RAW`
  but not currently wired to anything — OG-card game images are always on
- `LOG_RETENTION_DAYS` (default 7): how long a normal (non-flagged) match's
  session logs are kept before the retention sweep deletes them
- `FLAGGED_STALE_DAYS` (default 180): how long an unresolved flagged match's
  logs are kept before the retention sweep deletes them
- `DEBUG_MODE`: enables `debug-sync` and local log files; `debug-logs` writes to stdout even when unset
- `.env` file supported via python-dotenv
