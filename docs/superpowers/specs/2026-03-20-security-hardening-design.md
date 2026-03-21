# Security Hardening for Deployment

**Date:** 2026-03-20
**Branch:** mvp-p0-implementation

## Goal

Harden kaillera-next for public deployment behind Cloudflare Tunnels. Users should be able to create rooms, join rooms, and play — nothing else. No ROM hosted on the server. No join code enumeration. No cross-room interference.

## Threat Model

- **Casual scrapers** trying to download ROMs or enumerate assets
- **Malicious players** injecting XSS via player names, sending cross-room signals, or spamming room creation
- **Hotlinkers** embedding the ROM URL on other sites
- **Amplification abuse** via oversized data-message relay
- **Room code brute-force** attempting to discover active rooms by probing `/room/{id}`

Not in scope: authenticated user accounts, persistent sessions, encrypted room passwords (all v2+).

**Note on Socket.IO sids:** Socket.IO session IDs are server-generated, high-entropy, and not guessable. Cross-room WebRTC targeting is blocked by room validation (section 4), and unknown sids are rejected because they won't appear in `_sid_to_room`.

## Changes

### 1. ROM Removal — User-Supplied via Drag-and-Drop

- Delete `web/static/rom/` directory from the server entirely
- Remove `EJS_gameUrl` static path from `play.html`
- Add a drag-and-drop zone to the play page overlay (pre-game)
  - User drops a `.z64` / `.n64` / `.v64` ROM file
  - File is read as a blob URL via `URL.createObjectURL()`
  - `EJS_gameUrl` is set to the blob URL before EmulatorJS boots
  - ROM never leaves the user's browser; server never sees it
- Host and guest each supply their own ROM independently
- Store the filename in localStorage for convenience (auto-fill on return)

### 2. `/list` Endpoint — Strip Join Codes

Current response exposes session IDs (= join codes). Change to:

```json
[
  {
    "room_name": "Player's room",
    "host_name": "Player",
    "game_id": "ssb64",
    "player_count": 2,
    "max_players": 4,
    "status": "playing",
    "has_password": false
  }
]
```

No session ID, no socket IDs, no domain field. Room browsing is informational only — joining still requires the invite code.

### 3. `/room/{room_id}` Endpoint — Rate Limit + Minimal Response

This endpoint is needed for join validation (client checks room exists before emitting `join-room`). However, room codes are short and could be brute-forced.

- Rate-limit to 10 requests/minute per IP
- Return only: `{status, player_count, max_players, has_password}` — no player names, no socket IDs
- Increase room code entropy: use `crypto.getRandomValues()` with 8 alphanumeric characters (2.8 trillion combinations vs 60M currently)

### 4. Remove Legacy Endpoints

Delete from `app.py`:
- `POST /sessions`
- `GET /sessions/{session_id}`

These are V2 Mupen64Plus protocol endpoints, unused in V1.

Also remove the `domain` field from `Room` dataclass — it's client-supplied, unvalidated, and unused.

### 5. WebRTC Signal Relay — Same-Room Validation

In `webrtc_signal()`, before relaying:

```python
sender_entry = _sid_to_room.get(sid)
target_entry = _sid_to_room.get(target)
if not sender_entry or not target_entry:
    return
if sender_entry[0] != target_entry[0]:
    return  # different rooms — block
```

Prevents cross-room signal injection.

### 6. Input Validation

In `signaling.py`, validate all client-supplied fields:

| Field | Validation |
|-------|-----------|
| `sessionid` | Alphanumeric, 3-16 chars |
| `player_name` | Strip HTML tags, truncate to 32 chars |
| `room_name` | Strip HTML tags, truncate to 64 chars |
| `maxPlayers` | Clamp to 1-4 |
| `game_id` | Alphanumeric + hyphens, max 32 chars |
| `mode` | Must be `"lockstep"` or `"streaming"` |
| `password` | Optional, max 64 chars |
| `slot` (claim-slot) | Integer, 0-3 range check |

Add a `sanitize_str(value, max_len)` helper that strips `<>` characters and truncates.

Use `hmac.compare_digest()` for password comparison (constant-time).

### 7. XSS Prevention

In `play.js`, escape all user-supplied strings before DOM insertion:

```javascript
function escapeHtml(s) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(s));
  return div.innerHTML;
}
```

Apply to:
- `showToast()` messages containing player names
- Player list slot names in `updatePlayerList()`
- `showError()` — refactor to use `textContent` for error messages; use a separate DOM element for the "Back to lobby" link instead of injecting HTML via `innerHTML`
- Any other DOM insertion of server-supplied data

### 8. CORS Lockdown

`ALLOWED_ORIGIN` environment variable:
- Dev default: `*`
- Production: set to `https://yourdomain.com`

Applied to:
- `socketio.AsyncServer(cors_allowed_origins=ALLOWED_ORIGIN)`
- FastAPI CORS middleware (for REST endpoints)

### 9. Rate Limiting

In-memory per-IP counters with 60-second rolling window:

| Event / Endpoint | Limit |
|-----------------|-------|
| `open-room` | 5 per minute per IP |
| `join-room` | 20 per minute per IP |
| `connect` | 30 per minute per IP |
| `snapshot` | 2 per second per sid |
| `data-message` | 60 per second per sid |
| `GET /room/{id}` | 10 per minute per IP |
| Max concurrent connections | 20 per IP |

Implementation: dict of `{ip: {event: [timestamps]}}`. Clean up stale entries every 60s. Applied as early checks in each handler. IP extracted from `environ` in the connect handler and stored per-sid.

When limit exceeded, return an error string to the client (Socket.IO ack) or HTTP 429.

Note: `input` events are high-frequency (60/sec per player) and essential for gameplay — not rate-limited. Rooms are small (max 4 players + spectators) and Cloudflare absorbs volumetric attacks at the edge.

### 10. Payload Size Limits

- Reduce `max_http_buffer_size` from 16MB to 4MB (save states are ~1.5MB compressed)
- Add explicit size check in `data-message` handler: reject if serialized payload > 2MB
- Add explicit size check in `snapshot` handler: same 2MB limit

### 11. Security Headers

FastAPI middleware adding response headers:

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.emulatorjs.org https://cdn.socket.io 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws: https://cdn.emulatorjs.org; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob: https://cdn.emulatorjs.org; font-src 'self' https://cdn.emulatorjs.org data:
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

- `unsafe-eval` required by EmulatorJS (Emscripten)
- `unsafe-inline` in `script-src` required for inline scripts in `play.html` (EJS config + netplay loader). Future improvement: move to external JS files with nonces.
- `unsafe-inline` in `style-src` for EmulatorJS dynamic styles
- `connect-src` includes EmulatorJS CDN for core/asset downloads
- `worker-src` includes EmulatorJS CDN for web workers and `blob:` for audio worklets
- `font-src` for EmulatorJS UI fonts
- `SAMEORIGIN` instead of `DENY` for X-Frame-Options (EmulatorJS may use internal iframes)
- `blob:` in media-src for ROM loading and audio

## Deployment

Docker container on Unraid/Portainer, exposed via Cloudflare Tunnels. Performance impact of Docker is negligible — the server is a lightweight Python signaling relay (no game logic, no heavy compute). WebRTC game data flows P2P once established; the server only handles ~10 signaling messages per game session.

A `Dockerfile` will be included. No special networking requirements — single port (8000), HTTP only (Cloudflare handles TLS).

## Files Changed

| File | Change |
|------|--------|
| `web/static/rom/` | Delete entirely |
| `web/play.html` | Remove `EJS_gameUrl` static path, refactor inline scripts, add drop zone markup |
| `web/static/play.js` | Add ROM drop handler, `escapeHtml()`, fix `showError()`, set `EJS_gameUrl` from blob |
| `web/static/play.css` | Drop zone styling |
| `web/static/lobby.js` | Use `crypto.getRandomValues()` for room codes, 8 chars |
| `server/src/api/app.py` | Remove `/sessions` endpoints, strip join codes from `/list`, minimal `/room/{id}` response, rate limit `/room/{id}`, add security headers middleware, add CORS middleware |
| `server/src/api/signaling.py` | Input validation, rate limiting, WebRTC room check, payload limits, CORS config, remove `domain` field, `hmac.compare_digest` for passwords, `claim-slot` validation |
| `server/src/main.py` | Read `ALLOWED_ORIGIN` env var |
| `Dockerfile` | New — production container |

## Out of Scope

- User accounts / authentication
- Encrypted room passwords (bcrypt/scrypt)
- Server-side ROM validation
- Cloudflare WAF rules (handled at CF layer)
- Database / persistent storage
- Timing-attack-resistant password hashing (constant-time comparison is sufficient for plaintext room passwords in v1; hashing is v2)
