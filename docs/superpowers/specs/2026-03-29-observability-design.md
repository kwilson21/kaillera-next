# Observability — Design Spec

**Date:** 2026-03-29
**Approach:** B — Logs + Error Beacon (self-contained, no external dependencies)

## Goal

Close the biggest observability blind spots so that when something breaks, you know
about it through the admin page without relying on user reports. Fits the existing
workflow: admin page → pull errors → feed to Claude for analysis.

## Scope

### In scope (build now)

1. **Missing warning logs** — ~6 one-liner `log.warning()` calls
2. **Meaningful health check** — `/health` pings Redis, reports room/player counts
3. **Client event beacon** — `POST /api/client-event` endpoint + client helper + instrumentation
4. **OG image error handling** — try/except + fallback PNG
5. **Playwright verification** — validate admin page errors tab and beacon flow with E2E tests

### Out of scope (deferred metrics phase)

See "Deferred: Metrics Phase" section at the bottom.

---

## 1. Missing Warning Logs

Add `log.warning()` where failures currently happen silently:

| Location | Condition | Log message |
|----------|-----------|-------------|
| `signaling.py:383` | MAX_ROOMS hit | `"Server full, room rejected (MAX_ROOMS=%d)"` |
| `signaling.py:349` | Rate limit on open-room | `"Rate limited: open-room"` |
| `signaling.py:415` | Rate limit on join-room | `"Rate limited: join-room"` |
| `app.py:466-467` | State cache full (507) | `"State cache full (%d entries)"` |
| `app.py:442-443` | Rate limit on cache-state | `"Rate limited: cache-state"` |
| `app.py:476-477` | Rate limit on sync-logs | `"Rate limited: sync-logs"` |

Rate limit warnings should log once per IP per event per minute to avoid log spam
(simple dict of `(ip_hash, event) → last_warned_time`). This dict must be pruned
in the existing `cleanup()` function in `ratelimit.py` to prevent unbounded growth.

---

## 2. Meaningful Health Check

Replace the current `/health` (always returns ok) with:

```python
@app.get("/health")
async def health():
    redis_ok = await state.ping()
    return {
        "status": "ok" if redis_ok else "degraded",
        "redis": redis_ok,
        "rooms": len(rooms),
        "players": sum(len(r.players) for r in rooms.values()),
    }
```

Add `ping()` to `state.py`:

```python
async def ping() -> bool:
    if not _redis:
        return True  # no Redis configured = not degraded, just ephemeral
    try:
        await _redis.ping()
        return True
    except Exception:
        return False
```

**Note:** `app.py` must import `state` (`from src import state`) — it doesn't currently.

Returns 200 even when degraded (server works without Redis, just loses persistence).
Docker HEALTHCHECK catches `degraded` state without false restarts.

---

## 3. Client Event Beacon

### 3a. Server endpoint: `POST /api/client-event`

**Location:** `app.py`, new route.

**Auth:** Existing upload token (same as sync logs — proves client was in a room).

**Rate limit:** New `"client-event"` entry in ratelimit.py — 10 per IP per 60 seconds.

**Payload:**

```json
{
  "type": "webrtc-fail",
  "msg": "ICE connection failed after 15s",
  "room": "ABC123",
  "slot": 0,
  "ua": "Chrome/126 Linux",
  "ts": 1711700000,
  "meta": {"iceState": "failed", "peerCount": 2}
}
```

**Validation:**
- `type` must be one of: `webrtc-fail`, `wasm-fail`, `desync`, `stall`, `reconnect`,
  `audio-fail`, `unhandled`, `compat`, `session-end`
- `msg` truncated to 500 chars
- `meta` rejected if `json.dumps(meta)` exceeds 2048 bytes (don't truncate mid-JSON)
- Total body max 4KB
- Token required and verified

**Storage:** Written to `logs/errors/` as individual JSON files.
Filename: `evt-{type}-{room}-{ts}-{rand4}.json` (4-char random suffix prevents
collisions when multiple clients fire the same event type simultaneously).

**Directory constant:** `_ERROR_LOG_DIR = Path(os.environ.get("ERROR_LOG_DIR", "logs/errors"))`

**Admin API:** Follow existing sync log pattern:
- `GET /admin/api/errors` — list error files (sorted by time, newest first)
- `GET /admin/api/errors/{filename}` — view error content
- `DELETE /admin/api/errors/{filename}` — delete error

**Filename validation:** Add `_safe_error_filename()` mirroring existing `_safe_log_filename()` —
require `evt-` prefix, `.json` suffix, block directory traversal (`/`, `\`, `..`).

**Cleanup:** Extend existing `cleanup_old_logs()` to also clean `_ERROR_LOG_DIR` using
glob pattern `evt-*.json`, same retention policy. No separate cleanup task.

### 3b. KNState additions

`KNState` (in `kn-state.js`) currently lacks `room`, `slot`, and `uploadToken`.
Add these three properties. Set them from `play.js`:
- `KNState.room` — set when room code is known (from URL param or open-room)
- `KNState.slot` — set when slot is assigned (from `users-updated` payload)
- `KNState.uploadToken` — set when `upload-token` event is received

### 3c. Client helper: `KNEvent()`

Added to `shared.js` (already imported everywhere):

```javascript
window.KNEvent = (type, msg, meta = {}) => {
    if (!KNState.uploadToken) return;
    const body = JSON.stringify({
        type, msg, meta,
        room: KNState.room || '',
        slot: KNState.slot ?? -1,
        ua: navigator.userAgent,
        ts: Date.now()
    });
    navigator.sendBeacon(
        `/api/client-event?token=${KNState.uploadToken}`,
        new Blob([body], {type: 'application/json'})
    );
};
```

### 3d. Instrumentation points

Line numbers are approximate — locate by function/pattern name during implementation.

| # | File | Pattern to find | Type | Trigger |
|---|------|----------------|------|---------|
| 1 | `shared.js` | `addBufferedCandidate` catch block | `webrtc-fail` | ICE candidate add fails |
| 2 | `netplay-lockstep.js` | `connectionstatechange` → `failed` | `webrtc-fail` | Peer connection state → `failed` |
| 3 | `ejs-loader.js` | `filesmissing()` when non-minified fallback also fails | `wasm-fail` | WASM core fails to load (terminal failure) |
| 4 | `play.js` | New 30s timeout after emulator init | `wasm-fail` | Emulator `ready` event never fires |
| 5 | `netplay-lockstep.js` | Where desync detected / resync triggered | `desync` | Desync event with frame number |
| 6 | `netplay-lockstep.js` | Where INPUT-STALL logged to syncLog | `stall` | Input stall detected |
| 7 | `play.js` | `socket.on('reconnect', ...)` handler | `reconnect` | Reconnect completed (with attempts + downtime) |
| 8 | `netplay-lockstep.js` | AudioWorklet fallback path | `audio-fail` | AudioWorklet fails, ScriptProcessor used |
| 9 | `play.js` | `unhandledrejection` listener | `unhandled` | Any unhandled promise rejection |
| 10 | `play.js` | Page load feature detection (new) | `compat` | RTCPeerConnection, WebAssembly, or crossOriginIsolated missing |

### 3e. Session summary on unload

Upgrade existing `pagehide` beacon in `play.js` to send structured data:

```json
{
  "type": "session-end",
  "msg": "session complete",
  "room": "ABC123",
  "meta": {
    "duration": 1234,
    "reconnects": 2,
    "desyncs": 1,
    "stalls": 0,
    "mode": "lockstep",
    "players": 2
  }
}
```

Counters incremented alongside `KNEvent()` calls: `_sessionStats.desyncs++` etc.
Sent to the same `/api/client-event` endpoint.

### 3f. Admin page errors tab

Extend `admin.html` with an "Errors" tab alongside existing sync logs tab.
Same UI pattern: table of files, click to view JSON, delete button.
Add basic filtering by error type.

---

## 4. OG Image Error Handling

Wrap the `og_image` route in `app.py`:

```python
@app.get("/og-image/{room_id}.png")
def og_image(room_id: str, request: Request) -> Response:
    try:
        # ... existing logic ...
        img = generate_og_image(...)
    except Exception:
        log.warning("OG image generation failed for room %s", room_id, exc_info=True)
        fallback = _web_dir / "static" / "og" / "fallback.png"
        if fallback.exists():
            img = fallback.read_bytes()
        else:
            log.warning("OG fallback image missing at %s", fallback)
            raise HTTPException(status_code=500, detail="OG image unavailable")
    return Response(content=img, media_type="image/png", headers={"cache-control": "public, max-age=300"})
```

Create `web/static/og/fallback.png` — a static generic kaillera-next OG card.
Generate once with Playwright during development, check into the repo so it's
always available at deploy time.

---

## 5. Playwright E2E Verification

During implementation, validate with Playwright:
- Admin page errors tab renders correctly and displays test error entries
- Client beacon fires on simulated error conditions
- Health check returns correct degraded/ok status
- OG fallback image serves correctly when Playwright is unavailable

---

## Deferred: Metrics Phase

Build when the project has a consistent playerbase or when you need trend visibility.

| Item | What | Trigger to build |
|------|------|-----------------|
| Structured JSON logging | JSON log format, correlation IDs, ip_hash | Need to parse logs programmatically |
| In-memory metrics counters | connections/min, disconnects/min, errors/min, games started | Consistent playerbase, need trends |
| `/admin/api/metrics` endpoint | Rolling 24h time-series, 1-minute buckets | Alongside counters |
| Admin metrics tab | Sparklines for key metrics | Alongside endpoint |
| Alerting | Discord webhook when: Redis down >2min, error spike, zero rooms | Others playing without you present |
| Deploy smoke test | Post-deploy: create room, join, verify WS + OG | Frequent deploys |
| PostHog integration | JS snippet for funnels, device segmentation | Large enough playerbase for stats |
| OpenTelemetry | Trace IDs, OTel exporters | Probably never at this scale |
| Error sampling | Rate-limit high-frequency client events | Client-event volume becomes storage concern |
