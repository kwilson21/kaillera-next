# ROM Library Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the single-slot ROM cache to a multi-ROM library with server-side hash verification and host-only ROM picker UI.

**Architecture:** Expand existing IndexedDB `kaillera-rom-cache` from v1→v2 with hash-keyed entries. Add `known_roms` SQLite table seeded from a committed JSON config file. Serve known hashes via `GET /api/rom-hashes`. Host sees a scrollable ROM list below the drop zone; guests get silent auto-matching from their cached library.

**Tech Stack:** IndexedDB (client storage), SQLite/aiosqlite + Alembic (server), FastAPI (REST endpoint), vanilla JS (IIFE pattern, no ES modules)

**Spec:** `docs/superpowers/specs/2026-04-02-rom-library-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/config/known_roms.json` | Create | Canonical ROM hash table (committed, community-editable) |
| `server/alembic/versions/0003_known_roms.py` | Create | Alembic migration: `known_roms` table |
| `server/src/db.py` | Modify | Add `get_known_roms()` and `sync_known_roms()` helpers |
| `server/src/api/app.py` | Modify | Add `GET /api/rom-hashes` endpoint |
| `server/src/main.py` | Modify | Call `sync_known_roms()` on startup after `init_db()` |
| `web/static/play.js` | Modify | Multi-ROM IDB cache, library UI, guest auto-match, host change notifications |
| `web/static/play.css` | Modify | ROM library list styles |
| `web/play.html` | Modify | Add `rom-library` container element below drop zone |
| `tests/test_db.py` | Modify | Test `known_roms` table creation and sync |
| `tests/test_server_rest.py` | Modify | Test `GET /api/rom-hashes` endpoint |

---

## Chunk 1: Server — Known ROM Hash Table

### Task 1: Create known_roms.json config file

**Files:**
- Create: `server/config/known_roms.json`

- [ ] **Step 1: Create the config directory and seed file**

```bash
mkdir -p server/config
```

Write `server/config/known_roms.json`:

```json
[
  {
    "sha256": "S6c078cf355ee4b8946e18e498e51e3c89a16e18d074f1e09894cfb066409fe4c",
    "game": "Super Smash Bros.",
    "region": "US",
    "format": "z64"
  }
]
```

Note: The `S` prefix matches the client's `hashArrayBuffer` output convention (SHA-256 hashes are prefixed with `S`). We'll need the actual SSB64 ROM hash — use a placeholder for now and update with the real hash once verified.

- [ ] **Step 2: Commit**

```bash
git add server/config/known_roms.json
git commit -m "feat: add known_roms.json seed file for ROM verification"
```

### Task 2: Alembic migration for known_roms table

**Files:**
- Create: `server/alembic/versions/0003_known_roms.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_db.py`:

```python
def test_known_roms_table_exists(tmp_db):
    """init_db creates known_roms table via migration."""
    asyncio.run(_run_known_roms_table_check(tmp_db))


async def _run_known_roms_table_check(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    tables = await query(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ()
    )
    table_names = [t["name"] for t in tables]
    assert "known_roms" in table_names
    # Verify schema
    cols = await query("PRAGMA table_info(known_roms)", ())
    col_names = {c["name"] for c in cols}
    assert col_names == {"sha256", "game", "region", "format"}
    await close_db()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/test_db.py::test_known_roms_table_exists -v`
Expected: FAIL — `known_roms` not in table_names

- [ ] **Step 3: Write the migration**

Create `server/alembic/versions/0003_known_roms.py`:

```python
"""Known ROMs table for ROM verification.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "known_roms",
        sa.Column("sha256", sa.Text, primary_key=True),
        sa.Column("game", sa.Text, nullable=False),
        sa.Column("region", sa.Text),
        sa.Column("format", sa.Text),
    )


def downgrade() -> None:
    op.drop_table("known_roms")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/test_db.py::test_known_roms_table_exists -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/alembic/versions/0003_known_roms.py tests/test_db.py
git commit -m "feat: add known_roms Alembic migration"
```

### Task 3: DB helpers — sync_known_roms and get_known_roms

**Files:**
- Modify: `server/src/db.py`
- Modify: `tests/test_db.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_db.py`:

```python
def test_sync_known_roms(tmp_db, tmp_path):
    """sync_known_roms loads JSON config into known_roms table."""
    asyncio.run(_run_sync_known_roms(tmp_db, tmp_path))


async def _run_sync_known_roms(tmp_db, tmp_path):
    import json
    from src.db import close_db, init_db, sync_known_roms, get_known_roms

    config_file = tmp_path / "known_roms.json"
    config_file.write_text(json.dumps([
        {"sha256": "Sabc123", "game": "Super Smash Bros.", "region": "US", "format": "z64"},
        {"sha256": "Sdef456", "game": "Super Smash Bros.", "region": "JP", "format": "z64"},
    ]))

    await init_db(tmp_db)
    await sync_known_roms(str(config_file))
    roms = await get_known_roms()
    assert len(roms) == 2
    assert roms["Sabc123"]["game"] == "Super Smash Bros."
    assert roms["Sdef456"]["region"] == "JP"

    # Verify idempotent (run again, same result)
    await sync_known_roms(str(config_file))
    roms2 = await get_known_roms()
    assert len(roms2) == 2
    await close_db()


def test_get_known_roms_empty(tmp_db):
    """get_known_roms returns empty dict when table is empty."""
    asyncio.run(_run_get_known_roms_empty(tmp_db))


async def _run_get_known_roms_empty(tmp_db):
    from src.db import close_db, init_db, get_known_roms

    await init_db(tmp_db)
    roms = await get_known_roms()
    assert roms == {}
    await close_db()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && python -m pytest tests/test_db.py::test_sync_known_roms tests/test_db.py::test_get_known_roms_empty -v`
Expected: FAIL — `sync_known_roms` and `get_known_roms` not defined

- [ ] **Step 3: Implement the helpers**

Add to `server/src/db.py`:

```python
import json


async def sync_known_roms(config_path: str) -> int:
    """Read known_roms.json and upsert into known_roms table. Returns count."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    try:
        with open(config_path) as f:
            entries = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log.warning("Failed to load known_roms config: %s", e)
        return 0
    count = 0
    for entry in entries:
        await _db.execute(
            """INSERT INTO known_roms (sha256, game, region, format)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(sha256) DO UPDATE SET
                 game=excluded.game, region=excluded.region, format=excluded.format""",
            (entry["sha256"], entry["game"], entry.get("region"), entry.get("format")),
        )
        count += 1
    await _db.commit()
    log.info("Synced %d known ROM(s) from %s", count, config_path)
    return count


async def get_known_roms() -> dict:
    """Return all known ROMs as {sha256: {game, region, format}}."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute("SELECT sha256, game, region, format FROM known_roms")
    rows = await cursor.fetchall()
    return {
        row[0]: {"game": row[1], "region": row[2], "format": row[3]}
        for row in rows
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && python -m pytest tests/test_db.py::test_sync_known_roms tests/test_db.py::test_get_known_roms_empty -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db.py tests/test_db.py
git commit -m "feat: add sync_known_roms and get_known_roms DB helpers"
```

### Task 4: REST endpoint — GET /api/rom-hashes

**Files:**
- Modify: `server/src/api/app.py`
- Modify: `tests/test_server_rest.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_server_rest.py`:

```python
def test_rom_hashes(server_url):
    """GET /api/rom-hashes returns known ROM hash table."""
    r = requests.get(f"{server_url}/api/rom-hashes", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)
    # Should have at least the seeded SSB64 entry
    assert len(data) >= 1
    # Verify structure of entries
    for sha, info in data.items():
        assert "game" in info
    # Verify Cache-Control header
    assert "max-age" in r.headers.get("Cache-Control", "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/test_server_rest.py::test_rom_hashes -v`
Expected: FAIL — 404 Not Found

- [ ] **Step 3: Implement the endpoint**

Add inside `create_app()` in `server/src/api/app.py`, after the existing `/api/` endpoints (around line 560):

```python
    @app.get("/api/rom-hashes")
    async def get_rom_hashes() -> Response:
        """Return known ROM hash table for client-side verification."""
        roms = await db.get_known_roms()
        return Response(
            content=json.dumps(roms),
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=3600"},
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/test_server_rest.py::test_rom_hashes -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/api/app.py tests/test_server_rest.py
git commit -m "feat: add GET /api/rom-hashes endpoint"
```

### Task 5: Sync known_roms.json on server startup

**Files:**
- Modify: `server/src/main.py`

- [ ] **Step 1: Add sync call to lifespan**

In `server/src/main.py`, inside the `lifespan()` function, after `await db.init_db()` (line 37), add:

```python
    # Sync known ROM hashes from config file into SQLite
    _config_path = os.path.join(os.path.dirname(__file__), "..", "config", "known_roms.json")
    await db.sync_known_roms(_config_path)
```

- [ ] **Step 2: Verify server starts cleanly**

Run: `cd server && python -c "from src.main import run; print('import ok')"`
Expected: `import ok` (verifies no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add server/src/main.py
git commit -m "feat: sync known_roms.json on server startup"
```

---

## Chunk 2: Client — Multi-ROM IndexedDB Library

### Task 6: Upgrade IndexedDB schema (v1→v2) and multi-ROM cache functions

**Files:**
- Modify: `web/static/play.js` (~line 2170, ROM IDB Cache section)

- [ ] **Step 1: Fetch known ROM hashes on page load**

At the top of the play.js IIFE (near the other module-level variables around line 79-90), add:

```javascript
  let _knownRoms = {}; // populated from /api/rom-hashes on load
```

In the initialization section (inside `setupPlayPage()` or early in the IIFE execution), fetch the hash table:

```javascript
  // Fetch known ROM hashes for verification
  fetch('/api/rom-hashes')
    .then((r) => r.ok ? r.json() : {})
    .then((data) => { _knownRoms = data; })
    .catch(() => {}); // non-fatal — verification just won't work
```

- [ ] **Step 2: Rewrite openRomDB with v2 migration**

Replace the existing `openRomDB` function (~line 2175-2190) with:

```javascript
  const _ROM_DB = 'kaillera-rom-cache';
  const _ROM_STORE = 'roms';
  const _ROM_DB_VERSION = 2;

  const openRomDB = (cb) => {
    if (typeof indexedDB === 'undefined') {
      cb(null);
      return;
    }
    const req = indexedDB.open(_ROM_DB, _ROM_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // Fresh install — create store
        db.createObjectStore(_ROM_STORE);
      }

      if (oldVersion < 2 && oldVersion >= 1) {
        // Migration: move 'current' key to hash-keyed entry.
        // All operations stay synchronous within the upgrade transaction —
        // async calls (like SubtleCrypto) would cause the transaction to
        // auto-commit prematurely. Use the cached hash from localStorage.
        const tx = req.transaction;
        const store = tx.objectStore(_ROM_STORE);
        const getReq = store.get('current');
        getReq.onsuccess = () => {
          if (!getReq.result) return;
          const buf = getReq.result;
          const name = _safeGet('localStorage', 'kaillera-rom-name') || 'Unknown ROM';
          const hash = _safeGet('localStorage', 'kaillera-rom-hash');
          if (hash) {
            store.put({
              blob: buf,
              name,
              size: buf.byteLength,
              source: 'local',
              verified: false,
              gameName: null,
              addedAt: Date.now(),
              lastUsed: Date.now(),
            }, hash);
          }
          // If no cached hash exists, we lose this ROM — acceptable since
          // it means the ROM was never successfully hashed before.
          store.delete('current');
        };
      }
    };
    req.onsuccess = () => cb(req.result);
    req.onerror = () => cb(null);
  };
```

- [ ] **Step 3: Rewrite cacheRom to store by hash with metadata**

Replace the existing `cacheRom` function (~line 2192-2202):

```javascript
  const cacheRom = (blob, { name, source = 'local' } = {}) => {
    const reader = new FileReader();
    reader.onload = async () => {
      let hash = null;
      try {
        hash = await hashArrayBuffer(reader.result);
      } catch (_) {
        return; // can't cache without a hash
      }
      const verified = !!(hash && _knownRoms[hash]);
      const gameName = verified ? _knownRoms[hash].game : null;
      openRomDB((db) => {
        if (!db) return;
        const tx = db.transaction(_ROM_STORE, 'readwrite');
        tx.objectStore(_ROM_STORE).put({
          blob: reader.result,
          name: gameName || name || 'Unknown ROM',
          size: reader.result.byteLength,
          source,
          verified,
          gameName,
          addedAt: Date.now(),
          lastUsed: Date.now(),
        }, hash);
      });
      // Re-render library if host
      if (isHost) renderRomLibrary();
    };
    reader.readAsArrayBuffer(blob instanceof Blob ? blob : new Blob([blob]));
  };
```

- [ ] **Step 4: Replace loadCachedRom with library-aware functions**

Replace the existing `loadCachedRom` function (~line 2204-2272) with three new functions:

```javascript
  const getRomLibrary = (cb) => {
    openRomDB((db) => {
      if (!db) { cb([]); return; }
      const tx = db.transaction(_ROM_STORE, 'readonly');
      const store = tx.objectStore(_ROM_STORE);
      const req = store.openCursor();
      const entries = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value;
          entries.push({
            hash: cursor.key,
            name: val.name,
            size: val.size,
            source: val.source,
            verified: val.verified,
            gameName: val.gameName,
            addedAt: val.addedAt,
            lastUsed: val.lastUsed,
          });
          cursor.continue();
        } else {
          // Sort by lastUsed descending
          entries.sort((a, b) => b.lastUsed - a.lastUsed);
          cb(entries);
        }
      };
      req.onerror = () => cb([]);
    });
  };

  const loadRomFromLibrary = (hash, cb) => {
    openRomDB((db) => {
      if (!db) { cb(false); return; }
      const tx = db.transaction(_ROM_STORE, 'readwrite');
      const req = tx.objectStore(_ROM_STORE).get(hash);
      req.onsuccess = () => {
        if (!req.result?.blob) { cb(false); return; }
        const val = req.result;
        const blob = new Blob([val.blob]);
        _romBlob = blob;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        _romHash = hash;
        KNState.romHash = hash;
        _safeSet('localStorage', 'kaillera-rom-name', val.name);
        _safeSet('localStorage', 'kaillera-rom-hash', hash);
        // Update lastUsed
        tx.objectStore(_ROM_STORE).put({ ...val, lastUsed: Date.now() }, hash);
        // Enable ROM sharing checkbox if host
        const romShareCb = document.getElementById('opt-rom-sharing');
        if (romShareCb && isHost) romShareCb.disabled = false;
        notifyRomReady();
        cb(true, val.name);
      };
      req.onerror = () => cb(false);
    });
  };

  // Stub — replaced by full implementation in Task 10 (Chunk 3)
  let renderRomLibrary = () => {};

  const deleteRomFromLibrary = (hash) => {
    openRomDB((db) => {
      if (!db) return;
      const tx = db.transaction(_ROM_STORE, 'readwrite');
      tx.objectStore(_ROM_STORE).delete(hash);
      // If we deleted the active ROM, clear it
      if (_romHash === hash) clearLoadedRom();
      renderRomLibrary();
    });
  };

  const autoMatchRom = (hostHash) => {
    openRomDB((db) => {
      if (!db) return;
      const tx = db.transaction(_ROM_STORE, 'readonly');
      const req = tx.objectStore(_ROM_STORE).get(hostHash);
      req.onsuccess = () => {
        if (!req.result?.blob) return;
        // Found a match — load it
        loadRomFromLibrary(hostHash, (ok, name) => {
          if (ok) {
            const displayName = name || 'cached ROM';
            showToast(`ROM matched — ${displayName} loaded`);
            const drop = document.getElementById('rom-drop');
            const statusEl = document.getElementById('rom-status');
            if (drop) drop.classList.add('loaded');
            if (statusEl) statusEl.textContent = `Loaded: ${displayName}`;
            if (_pendingLateJoin) dismissLateJoinPrompt();
          }
        });
      };
    });
  };
```

- [ ] **Step 5: Update loadCachedRom call in setupRomDrop**

In `setupRomDrop()` (~line 2017-2029), replace:

```javascript
    loadCachedRom((cachedName) => {
      if (cachedName) {
        drop.classList.add('loaded');
        if (statusEl) statusEl.textContent = `Loaded: ${cachedName} (drop to change)`;
        if (_pendingLateJoin) {
          dismissLateJoinPrompt();
        }
      } else if (savedRom && statusEl) {
        statusEl.textContent = `Last used: ${savedRom} (file not cached — drop again)`;
      }
    });
```

with:

```javascript
    // Auto-load the most recently used ROM from library
    const lastHash = _safeGet('localStorage', 'kaillera-rom-hash');
    if (lastHash) {
      loadRomFromLibrary(lastHash, (ok, name) => {
        if (ok) {
          drop.classList.add('loaded');
          if (statusEl) statusEl.textContent = `Loaded: ${name} (drop to change)`;
          if (_pendingLateJoin) dismissLateJoinPrompt();
        } else if (savedRom && statusEl) {
          statusEl.textContent = `Last used: ${savedRom} (file not cached — drop again)`;
        }
        // Render library for host after loading
        if (isHost) renderRomLibrary();
      });
    } else {
      if (isHost) renderRomLibrary();
    }
```

- [ ] **Step 6: Update cacheRom call sites**

In `loadRomData()` (~line 2067), update:
```javascript
    // Before:
    cacheRom(file);
    // After:
    cacheRom(file, { name: displayName, source: 'local' });
```

In the P2P ROM transfer completion (~line 1673), update:
```javascript
    // Before:
    cacheRom(blob);
    // After:
    cacheRom(blob, { name: displayName, source: 'p2p' });
```

- [ ] **Step 7: Commit**

```bash
git add web/static/play.js
git commit -m "feat: multi-ROM IndexedDB library with hash-keyed storage"
```

### Task 7: Guest auto-match and host change notifications

**Files:**
- Modify: `web/static/play.js` (~line 631-650, users-updated handler)

- [ ] **Step 1: Replace clearLoadedRom with autoMatchRom in users-updated**

In the `users-updated` handler (~line 633-650), replace:

```javascript
      if (_romHash && !_romSharingEnabled && romHashMismatch(_hostRomHash, _romHash)) {
        console.log(
          '[play] host ROM hash changed — clearing mismatched cached ROM (host:',
          _hostRomHash?.substring(0, 16),
          'ours:',
          _romHash?.substring(0, 16),
          ')',
        );
        clearLoadedRom();
        // Tell server we no longer have a ROM
        if (socket?.connected) socket.emit('rom-ready', { ready: false });
      } else if ((_romBlob || _romBlobUrl) && _romHash && !romHashMismatch(_hostRomHash, _romHash)) {
        // Hash matches — if we haven't notified yet, do so now
        notifyRomReady();
      }
```

with:

```javascript
      if (_romHash && !_romSharingEnabled && romHashMismatch(_hostRomHash, _romHash)) {
        console.log(
          '[play] host ROM hash changed (host:',
          _hostRomHash?.substring(0, 16),
          'ours:',
          _romHash?.substring(0, 16),
          ') — checking library',
        );
        clearLoadedRom();
        if (socket?.connected) socket.emit('rom-ready', { ready: false });
        // Try auto-match from library before prompting
        showToast('Host selected a different game');
        autoMatchRom(_hostRomHash);
      } else if ((_romBlob || _romBlobUrl) && _romHash && !romHashMismatch(_hostRomHash, _romHash)) {
        notifyRomReady();
      }
```

- [ ] **Step 2: Update ROM mismatch error messages**

Replace generic mismatch messages with contextual ones at three locations:

In the join-room handler (~line 571-572), this fires when a guest joins and their ROM doesn't match:

```javascript
    // Before:
    showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
    // After:
    showError("Your ROM doesn't match the host's game. Drop the correct ROM or enable ROM sharing.");
```

In the game-started handler (~line 775), this fires when the game starts mid-session:

```javascript
    // Before:
    showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
    // After:
    showError("Your ROM doesn't match the host's game. Drop the correct ROM to continue.");
```

In the late-join handler (~line 2513), this fires when attempting to join a game in progress:

```javascript
    // Before:
    showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
    // After:
    showError("Your ROM doesn't match the host's game. Drop the correct ROM to rejoin.");
```

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat: guest auto-match from ROM library, contextual mismatch messages"
```

---

## Chunk 3: Client — ROM Library UI

### Task 8: Add ROM library HTML container

**Files:**
- Modify: `web/play.html`

- [ ] **Step 1: Add library container below rom-drop**

In `web/play.html`, after the `rom-drop` div (after line 71), add:

```html
          <div id="rom-library" style="display: none"></div>
```

This goes between the closing `</div>` of `rom-drop` and the `rom-sharing-prompt` div.

- [ ] **Step 2: Commit**

```bash
git add web/play.html
git commit -m "feat: add rom-library container to play.html"
```

### Task 9: ROM library CSS styles

**Files:**
- Modify: `web/static/play.css`

- [ ] **Step 1: Add ROM library styles**

Add after the existing `.rom-drop.loaded` rule (~line 926):

```css
/* ROM Library */
.rom-library {
  border: 1px solid #2a2a40;
  border-radius: 6px;
  overflow: hidden;
  margin-top: 8px;
}

.rom-library-header {
  padding: 6px 10px;
  background: #222238;
  color: #888;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.rom-library-header .rom-count {
  color: #666;
  font-size: 10px;
}

.rom-library-list {
  max-height: 132px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #333 transparent;
}

.rom-library-item {
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border-top: 1px solid #1e1e30;
  transition: background 0.15s;
}

.rom-library-item:first-child {
  border-top: none;
}

.rom-library-item:hover {
  background: rgba(255, 255, 255, 0.03);
}

.rom-library-item.active {
  background: rgba(68, 170, 68, 0.08);
  border-left: 3px solid #4a4;
  padding-left: 7px;
}

.rom-library-item .rom-check {
  color: transparent;
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.rom-library-item.active .rom-check {
  color: #4a4;
}

.rom-library-item .rom-info {
  flex: 1;
  min-width: 0;
}

.rom-library-item .rom-name {
  color: #aaa;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rom-library-item.active .rom-name {
  color: #ddd;
}

.rom-library-item .rom-meta {
  color: #666;
  font-size: 10px;
  display: flex;
  gap: 8px;
}

.rom-library-item .rom-meta .verified {
  color: #4a4;
}

.rom-library-item .rom-meta .unverified {
  color: #888;
}

.rom-library-item .rom-delete {
  background: none;
  border: 1px solid #333;
  color: #666;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s, color 0.15s;
}

.rom-library-item .rom-delete:hover {
  border-color: #a44;
  color: #a44;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.css
git commit -m "feat: ROM library list CSS styles"
```

### Task 10: Render ROM library list (host only)

**Files:**
- Modify: `web/static/play.js`

- [ ] **Step 1: Add renderRomLibrary function**

Replace the `renderRomLibrary` stub (defined in Task 6) with the full implementation:

```javascript
  renderRomLibrary = () => {
    const container = document.getElementById('rom-library');
    if (!container) return;

    // Only show for host
    if (!isHost) {
      container.style.display = 'none';
      return;
    }

    getRomLibrary((entries) => {
      if (entries.length === 0) {
        container.style.display = 'none';
        return;
      }

      container.style.display = '';
      container.className = 'rom-library';

      const formatSize = (bytes) => {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${bytes} B`;
      };

      let html = `<div class="rom-library-header"><span>ROM Library</span><span class="rom-count">${entries.length} ROM${entries.length !== 1 ? 's' : ''}</span></div>`;
      html += '<div class="rom-library-list">';

      for (const entry of entries) {
        const isActive = entry.hash === _romHash;
        const verifiedLabel = entry.verified
          ? `<span class="verified">Verified — ${entry.gameName}</span>`
          : '<span class="unverified">Unverified</span>';
        const sourceLabel = entry.source === 'p2p' ? 'From host' : '';

        html += `<div class="rom-library-item${isActive ? ' active' : ''}" data-hash="${entry.hash}">`;
        html += `<span class="rom-check">\u2713</span>`;
        html += '<div class="rom-info">';
        html += `<div class="rom-name">${entry.name}</div>`;
        html += `<div class="rom-meta">${verifiedLabel}<span>${formatSize(entry.size)}</span>${sourceLabel ? `<span>${sourceLabel}</span>` : ''}</div>`;
        html += '</div>';
        html += `<button class="rom-delete" data-hash="${entry.hash}" title="Remove from library">\u2715</button>`;
        html += '</div>';
      }

      html += '</div>';
      container.innerHTML = html;

      // Wire click handlers
      for (const item of container.querySelectorAll('.rom-library-item')) {
        item.addEventListener('click', (e) => {
          // Don't trigger load when clicking delete
          if (e.target.closest('.rom-delete')) return;
          const hash = item.dataset.hash;
          if (hash === _romHash) return; // already active
          loadRomFromLibrary(hash, (ok, name) => {
            if (ok) {
              const drop = document.getElementById('rom-drop');
              const statusEl = document.getElementById('rom-status');
              if (drop) drop.classList.add('loaded');
              if (statusEl) statusEl.textContent = `Loaded: ${name}`;
              renderRomLibrary();
            }
          });
        });
      }

      for (const btn of container.querySelectorAll('.rom-delete')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRomFromLibrary(btn.dataset.hash);
        });
      }
    });
  };
```

- [ ] **Step 2: Re-render library on role change**

In the `users-updated` handler, after the existing `isHost` detection logic (around where `showToast('You are now the host')` is called, ~line 688), add:

```javascript
        renderRomLibrary();
```

This ensures the library list appears when a guest becomes host via ownership transfer.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat: render ROM library list for host, re-render on role change"
```

### Task 11: Verify end-to-end manually

- [ ] **Step 1: Start the dev server and verify**

1. Start the server (`cd server && python -m src.main` or however you run it)
2. Open a room as host
3. Drop a ROM — verify it appears in the library list below the drop zone
4. Drop a second ROM — verify both appear, most recent on top
5. Click the first ROM in the list — verify it loads
6. Click the delete button on a ROM — verify it's removed
7. Refresh the page — verify ROMs persist
8. Open `GET /api/rom-hashes` in browser — verify JSON response

- [ ] **Step 2: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: ROM library integration fixups"
```
