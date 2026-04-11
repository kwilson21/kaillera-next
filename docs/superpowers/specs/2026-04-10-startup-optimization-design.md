# Startup Time Optimization

**Date:** 2026-04-10
**Status:** Design approved

## Problem

Game startup takes 30-40 seconds from "Start Game" to gameplay. Two bottlenecks dominate:

1. **WASM core download (8.8s uncached):** The guest downloads `mupen64plus_next-wasm.data` (~3MB) only after tapping the gesture prompt. The host has it cached from a previous session.
2. **Initial state transfer (20s):** A ~16MB savestate is captured by the host, gzip-compressed, sent via Socket.IO through the server to the guest, then decompressed and loaded. The server-side state cache (`/api/cached-state/{rom_hash}`) exists but uses an in-memory Python dict that's wiped on every deploy, so it's almost always empty.

## Solution

Two independent optimizations that together eliminate ~28s from the cold-start path.

### 1. WASM Core Preload

Add a preload hint to `play.html`:

```html
<link rel="preload" href="/static/ejs/cores/mupen64plus_next-wasm.data" as="fetch" crossorigin>
```

The browser starts downloading the WASM binary immediately on page load — while the user is in the lobby UI, waiting for players, or reading the gesture prompt. When EmulatorJS later requests the file during initialization, it's served from the browser's HTTP cache.

**Files changed:** `web/play.html` (1 line)

### 2. Persistent State Cache (SQLite)

Persist the boot savestate to the existing SQLite database so it survives server restarts and deploys.

**Schema** — new table via Alembic migration:

```sql
CREATE TABLE state_cache (
    rom_hash TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Write path:** `POST /api/cache-state/{rom_hash}` writes to both the in-memory `_state_cache` dict and the SQLite `state_cache` table. The existing endpoint already validates room token and ROM hash.

**Read path:** `GET /api/cached-state/{rom_hash}` checks the in-memory dict first (hot cache). On miss, queries SQLite. On SQLite hit, populates the in-memory dict and returns the state. On miss, returns 404 (client falls back to live capture as today).

**Startup:** States are loaded lazily on first request, not preloaded on server boot. A 16MB blob per ROM hash is acceptable in memory for a few active ROMs.

**Cleanup:** No automatic expiration. The table holds one entry per ROM hash ever played — a handful of rows in practice.

**Files changed:**
- `server/src/db.py` — add `state_cache` table model
- Alembic migration — create the table
- `server/src/api/app.py` — modify `get_cached_state()` and `cache_state()` to read/write SQLite on cache miss/upload

## Expected Impact

| Scenario | Before | After |
|----------|--------|-------|
| WASM download (uncached) | 8.8s blocking | ~0s (preloaded in background) |
| Initial state (first ever play) | 20s Socket.IO transfer | 20s (same — cache populates after) |
| Initial state (repeat play, same server session) | ~0s (in-memory cache hit) | ~0s (same) |
| Initial state (repeat play, after deploy) | 20s (cache lost) | <1s (SQLite hit → memory) |

Cold start drops from ~30s to ~20s on first-ever play, and to <5s on repeat plays after a deploy.

## Error Handling

- SQLite write failure: log warning, in-memory cache still works for the session
- SQLite read failure: log warning, fall back to live capture (existing behavior)
- Preload fetch failure: silent (browser handles gracefully, EJS re-fetches normally)

## Testing

- Verify preload: check Network tab shows WASM file loading before gesture tap
- Verify SQLite persistence: restart server, confirm `GET /api/cached-state/{hash}` returns 200
- Verify fallback: delete SQLite row, confirm live capture still works
