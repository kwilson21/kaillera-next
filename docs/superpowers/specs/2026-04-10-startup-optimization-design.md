# Startup Time Optimization

**Date:** 2026-04-10
**Status:** Design approved

## Problem

Game startup takes 30-40 seconds from "Start Game" to gameplay. Two bottlenecks dominate:

1. **WASM core download (8.8s uncached):** The guest downloads `mupen64plus_next-wasm.data` (~1.4MB) only after tapping the gesture prompt. The host has it cached from a previous session.
2. **Initial state transfer (20s):** A ~16MB savestate is captured by the host, gzip-compressed, sent via Socket.IO through the server to the guest, then decompressed and loaded. The server-side state cache (`/api/cached-state/{rom_hash}`) exists but uses an in-memory Python dict that's wiped on every deploy, so it's almost always empty.

## Solution

Two independent optimizations that together eliminate ~28s from the cold-start path.

### 1. WASM Core Preload

The WASM core URL is content-addressed via `/api/core-info` (returns a URL like `/static/ejs/cores/mupen64plus_next-wasm.data?h=abc123`). A static `<link rel="preload">` won't match the cache key because the query param differs.

Instead, add a small inline script at the top of `play.html` (in lockstep mode only) that fetches `/api/core-info` and dynamically injects a preload link:

```javascript
fetch('/api/core-info', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(info => {
    if (info?.url) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.href = info.url;
      link.as = 'fetch';
      link.crossOrigin = '';
      document.head.appendChild(link);
    }
  })
  .catch(() => {}); // silent — EJS will fetch normally
```

This fires immediately on page load — the `/api/core-info` response is tiny (~100 bytes, <50ms). The browser then starts downloading the WASM binary in the background while the user is in the lobby UI. When `core-redirector.js` later requests the same content-addressed URL, it's already in the HTTP cache.

Note: `core-redirector.js` already fetches `/api/core-info` itself, but only after it's loaded (which happens later in the page lifecycle). The inline script runs earlier, giving the browser a head start.

**Files changed:** `web/play.html` (small inline script in `<head>`)

### 2. Persistent State Cache (Disk Files)

Persist the boot savestate as files on disk so it survives server restarts and deploys. Disk files are the natural storage for opaque 16MB blobs — no SQLite WAL churn, no blocking the main database connection, no Alembic migration needed.

**Storage layout:**

```
data/state-cache/{rom_hash}.bin
```

The `data/` directory already exists for the SQLite database. The `state-cache/` subdirectory is created on first write.

**Write path:** `POST /api/cache-state/{rom_hash}` writes to both the in-memory `_state_cache` dict and `data/state-cache/{rom_hash}.bin`. Uses atomic write (write to `.tmp`, then `os.replace`) to prevent serving partial files. The existing endpoint already validates room token and ROM hash.

**Read path:** `GET /api/cached-state/{rom_hash}` checks the in-memory dict first (hot cache). On miss, checks if the file exists on disk. On file hit, reads into memory, populates the in-memory dict (respecting the existing `_MAX_CACHE_ENTRIES=50` cap), and returns. On miss, returns 404 (client falls back to live capture as today).

**In-memory eviction:** When loading from disk into memory and the in-memory cache is at capacity (50 entries), serve the response directly from the file read without populating the dict. The dict acts as a hot cache, not a required layer.

**Startup:** States are loaded lazily on first request, not preloaded on server boot.

**Cleanup:** No automatic expiration. The directory holds one file per ROM hash ever played — a handful of files in practice.

**Docker:** The `data/` directory is already a Docker volume mount. State cache files persist alongside the SQLite database with no additional configuration.

**Files changed:**
- `server/src/api/app.py` — modify `get_cached_state()` to fall through to disk on memory miss; modify `cache_state()` to write to disk alongside memory

## Expected Impact

| Scenario | Before | After |
|----------|--------|-------|
| WASM download (uncached guest) | 8.8s blocking | ~0s (preloaded in background) |
| Initial state (first ever play) | 20s Socket.IO transfer | 20s (same — cache populates after) |
| Initial state (repeat play, same server session) | ~0s (in-memory cache hit) | ~0s (same) |
| Initial state (repeat play, after deploy) | 20s (cache lost) | <1s (disk read → memory) |

Cold start drops from ~30s to ~20s on first-ever play, and to <5s on repeat plays after a deploy.

## Error Handling

- Disk write failure: log warning, in-memory cache still works for the session
- Disk read failure: log warning, fall back to live capture (existing behavior)
- Preload fetch failure: silent (browser handles gracefully, EJS re-fetches normally)
- `/api/core-info` unavailable: preload script catches silently, `core-redirector.js` falls back to un-hashed URL as today

## Testing

- Verify preload: Network tab shows WASM file downloading before gesture tap
- Verify disk persistence: restart server, confirm `GET /api/cached-state/{hash}` returns 200
- Verify fallback: delete cache file, confirm live capture still works
- Verify atomic write: kill server mid-upload, confirm no partial `.bin` files
