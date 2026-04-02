# ROM Library Design

## Problem

The current ROM cache stores exactly one ROM in IndexedDB under the key `'current'`. Loading a new game evicts the previous one. ROMs received via P2P sharing are also lost when the user loads a different game. Users must re-drop or re-download ROMs every time they switch games.

## Solution

Upgrade the single-slot ROM cache to a multi-ROM library. ROMs are stored by SHA-256 hash in IndexedDB, with metadata tracking name, source, and verification status. A canonical ROM hash table lives in the repo as a community-editable config file, synced to SQLite on server boot, and served to clients via API.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage approach | Expand existing IndexedDB store (v1→v2) | Smallest diff, evolves current code |
| Known ROM hashes | JSON config file → SQLite → REST API | Community-editable via PR, server is runtime source of truth |
| Verification | SHA-256 only, SSB64 for now | Already computed; minimal effort |
| UI location | Inline below drop zone on play page | No new pages or modals |
| Library visibility | Host only; guests get auto-matching | Guests don't choose — host picks the game |
| Management | Delete individual ROMs | Minimal, avoids over-engineering |
| List height | Scrollable, ~3 rows visible | Prevents infinite vertical growth |

## Data Model

### Client — IndexedDB

Database `kaillera-rom-cache` upgrades from version 1 to version 2.

Object store `roms`, keyed by SHA-256 hex string:

```
{
  blob:      ArrayBuffer,      // ROM data
  name:      string,           // display name (filename or verified game name)
  size:      number,           // bytes
  source:    'local' | 'p2p',  // where ROM came from
  verified:  boolean,          // hash matched known_roms table
  gameName:  string | null,    // verified game name or null
  addedAt:   number,           // Date.now() when first cached
  lastUsed:  number            // Date.now() updated on each load
}
```

**Migration (v1→v2):** Performed inside the `onupgradeneeded` handler. Read the existing `'current'` entry, compute its SHA-256 hash, insert it under the hash key with metadata populated from localStorage (`kaillera-rom-name`, `kaillera-rom-hash`), then delete the `'current'` key. All operations happen within the single upgrade transaction — if any step fails, the entire upgrade rolls back and the old `'current'` entry is preserved.

**Hash algorithm note:** The existing `hashArrayBuffer` function uses SHA-256 (via SubtleCrypto) on HTTPS/localhost origins, but falls back to FNV-1a on plain HTTP. IndexedDB keys use whichever hash the client produces (prefixed `S` or `F`). The `known_roms.json` table stores SHA-256 hashes only — verification is only possible when SubtleCrypto is available. FNV-hashed ROMs are stored and functional but marked `verified: false`.

### Server — SQLite

New Alembic migration `0003_known_roms.py`:

```sql
CREATE TABLE known_roms (
  sha256  TEXT PRIMARY KEY,
  game    TEXT NOT NULL,
  region  TEXT,
  format  TEXT
);
```

### Server — Config File

`server/config/known_roms.json` — community-editable, committed to repo:

```json
[
  {
    "sha256": "<hash>",
    "game": "Super Smash Bros.",
    "region": "US",
    "format": "z64"
  }
]
```

This file lives in `server/config/` (not `server/data/`) to avoid confusion with `server/data/kn.db` which is gitignored runtime data. On server startup (after migrations), the server reads this file and upserts all entries into the `known_roms` table. The DB is the runtime source of truth; the JSON file is the version-controlled source.

### REST API

`GET /api/rom-hashes` — returns the full `known_roms` table as JSON. Small payload, fetched once on page load and cached client-side in memory. Served with `Cache-Control: public, max-age=3600` so the browser avoids redundant fetches on reload.

Response:

```json
{
  "<sha256>": { "game": "Super Smash Bros.", "region": "US", "format": "z64" }
}
```

## UI Design

### Host View

The ROM drop zone on the play page gains a scrollable ROM list below it:

1. **Drop zone** — unchanged behavior (tap or drop ROM file)
2. **ROM Library list** — appears below drop zone when cached ROMs exist
   - Header row: "ROM Library" label + ROM count
   - Scrollable body: max ~3 visible rows, thin scrollbar
   - Each row shows: active indicator (green check), ROM name (ellipsized), verification status, file size, source label ("Dropped" / "From host"), delete button (✕)
   - Click a row to load that ROM as active
   - Active ROM highlighted with green left border + subtle background
   - When library is empty, list is hidden (drop zone only, same as today)

### Guest View

Guests do **not** see the ROM library list. They see the same drop zone as today. The library works behind the scenes for auto-matching:

- **Guest has matching ROM cached:** Auto-loads silently. Drop zone shows "ROM matched — [game name] loaded".
- **ROM sharing enabled, guest lacks ROM:** P2P transfer flow (unchanged from today).
- **ROM sharing off, guest lacks ROM:** Drop zone prompts "Drop the matching ROM to continue."

### Host ROM Change Notifications

When the host switches ROMs mid-lobby, guests receive clear messaging:

- **Toast notification:** "Host selected a different game"
- **Auto-match:** If guest has the new ROM cached, it loads automatically — "ROM matched — [game name] loaded"
- **ROM sharing on, no match:** "Host changed to a different game. Loading from host..."
- **ROM sharing off, no match:** "Host changed to a different game. Drop the matching ROM to continue."

This replaces the current generic "ROM mismatch" error with context about what happened.

## Changes to Existing Code

### play.js — ROM IDB Cache Section (~line 2170)

- `openRomDB`: Handle version 2 upgrade with migration logic
- `cacheRom(blob, { name, source })`: Write by SHA-256 key instead of `'current'`. Hash is computed internally from the blob. `verified` and `gameName` are looked up from the in-memory known-ROM table (fetched at page load). If the table hasn't loaded yet, store `verified: false` and `gameName: null` — verification can be retroactively applied on next page load.
- `loadCachedRom`: Becomes `loadRomFromLibrary(hash)` — load a specific ROM by hash
- New: `getRomLibrary()` — returns all ROM metadata (without blobs) for rendering the list
- New: `deleteRomFromLibrary(hash)` — remove a ROM entry
- New: `autoMatchRom(hostHash)` — check if library contains the host's ROM, load if found

### play.js — ROM Drop Zone Init (~line 1971)

- Render library list below drop zone (host only)
- Re-render list when ROMs are added/deleted
- Wire click-to-load and delete handlers

### play.js — ROM Sharing / Transfer (~line 1660)

- `cacheRom` call already exists — just needs updated signature (source: 'p2p')

### play.js — Guest Auto-Match

The single integration point for library auto-match is the existing `romHashMismatch` check in the `users-updated` handler (~line 620-650), which is the first place guest code learns the host's ROM hash. Currently this path clears a mismatched cached ROM — instead, it should call `autoMatchRom(hostHash)` to check the library first. If a match is found, load it silently. If not, fall through to the existing ROM sharing / manual drop flow.

- Replace generic "ROM mismatch" messaging with contextual messages

### play.js — Library UI on Role Change

The library list renders only for hosts. If room ownership transfers mid-session (host leaves, guest becomes host), re-render the ROM section to show the library list. Hook into the existing `users-updated` handler where `isHost` can change.

### Server — New Files

- `server/config/known_roms.json` — canonical ROM hash table (committed to repo)
- `server/alembic/versions/0003_known_roms.py` — migration
- `server/src/db.py` — add `get_known_roms()` query helper
- `server/src/api/app.py` — add `GET /api/rom-hashes` endpoint

### Server — Startup

- `server/src/main.py` — after `init_db()`, sync `known_roms.json` → SQLite

## Deferred Work

The following are explicitly out of scope for this implementation but noted for future consideration:

- **Extended verification:** CRC32, MD5, SHA1 checks (like smash64.dev)
- **ROM format detection:** Magic byte header parsing (z64 vs n64 vs v64)
- **Auto byte-swap conversion:** Convert between ROM formats automatically
- **ROM patching:** Apply patches to ROMs (like smash64.dev supports)
- **Multi-game known ROM table:** Currently SSB64 only; add more games as needed
- **Storage eviction:** LRU eviction when storage is full (N64 ROMs are small enough this is unlikely to matter soon)
- **Library on lobby page:** Pre-select ROM before entering a room
- **ROM rename / favorites / reorder:** Only delete is supported for now
- **Admin UI for hash management:** Hashes are managed via PR to known_roms.json
