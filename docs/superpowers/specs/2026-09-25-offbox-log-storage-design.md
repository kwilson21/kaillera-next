# Off-box log storage (D1 + R2) with tiered retention

**Date:** 2026-09-25
**Status:** Approved in conversation; pending written-spec review
**Scope:** Server persistence layer, retention, admin API; two one-line-scale client changes

## Problem

Production runs on Render's free plan (`render.yaml`, service
`srv-dar79re0tbcc7399r1mg`). Free web services have no persistent disk, so
everything in `kn.db` (`server/src/db.py`, `DB_PATH` default `data/kn.db`) and
the Parquet archive (`server/src/match_rotation.py`, `PARQUET_DIR`) is wiped on
every deploy, restart, and 15-minute idle sleep. On 2026-09-25 this destroyed
the logs of a match that was actively being debugged; `/admin/api/stats` on
prod read 0 session logs, 0 client events, 0 feedback at the time of writing.

## Goal

Keep the free plan. Persist everything that lives in `kn.db` off the box in
Cloudflare (the account that already provides TURN), so that:

- Session logs, match metrics/Parquet, client events, desync verdicts,
  feedback and screenshots survive deploys, restarts and idle sleep.
- An in-progress match loses at most ~10 s of logs to a restart.
- The admin API keeps working with the **same paths and response fields**.
- Matches where something went wrong are kept until explicitly resolved (or
  very stale); normal matches are kept a short time.
- Abuse (log spam, forged signals, a leaked admin key) cannot exhaust the free
  quotas or run up an unbounded bill.

## Non-goals

- Changing the Socket.IO wire format, client flush cadence or upload caps.
- Touching the netplay tick loop, sync, input or the WASM core.
- `debug-sync` / `debug-logs`: they write to stdout or local files under
  `DEBUG_MODE` and are not in `kn.db`. They stay as they are.
- A Parquet download endpoint (R2 is readable directly with DuckDB/Polars).
- Hard-delete via the admin API.
- Migrating existing data: prod is already empty.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| What must survive | Everything in `kn.db` |
| Mid-match loss window | ~10 s |
| Store | D1 for small queryable rows, R2 for blobs (chosen over Litestream-to-R2 and R2-only) |
| Migrations | Replace Alembic with numbered plain-SQL files and a small runner shared by both backends |
| Crash signal gap | Add a global `error` listener in `play.js` (in scope) |
| Feedback → match link | Add `matchId` to feedback context (in scope) |

---

## 1. Architecture and data flow

### Storage split

| Data | D1 (rows) | R2 (objects) |
|---|---|---|
| Session logs | `session_logs` metadata: `match_id`, `room`, `slot`, `player_name`, `mode`, `summary` (≤ 4 KB), `ended_by`, timestamps, `blob_key`, `blob_bytes`, `ip_hash` | `matches/<match_id>/sessions/<slot>.json.gz` = `{"log_data": [...], "context": {...}}` |
| Match archive | `match_metrics` (unchanged columns; `parquet_path` holds the R2 key) | `matches/<match_id>/entries.zstd.parquet` |
| Screenshots | `screenshots`: `id`, `match_id`, `slot`, `frame`, `size`, `blob_key`, `created_at` | `matches/<match_id>/screenshots/<slot>-<frame>.jpg` |
| Feedback, client events, desync verdicts | As today | — |
| Retention, budgets, audit | `match_retention`, `server_state`, `admin_actions` (below) | — |

Every object for a match lives under `matches/<match_id>/`, so deleting a match is
one prefix delete. D1 rows never carry a value near D1's 2 MB row limit: the
large fields (`log_data`, `context` with `inputAudit`, image bytes) are in R2.

### Backends

`db.py` keeps its public functions (`init_db`, `close_db`, `query`,
`execute_write`, `upsert_session_log`, `set_session_ended`,
`insert_client_event`, `insert_feedback`, `insert_screenshot`, `get_screenshots`,
…) and the SQL they run. Behind them sits a backend with three operations,
`query(sql, params)`, `execute(sql, params)`, and `batch([(sql, params), ...])`:

- `SqliteBackend`: today's aiosqlite code. Used for local dev, tests and the
  self-hosted VPS.
- `D1Backend`: `httpx.AsyncClient` against
  `POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query`
  with `Authorization: Bearer {D1_API_TOKEN}`. It maps D1's JSON result into
  the same `list[dict]` shape `query()` returns today. The Cloudflare docs
  describe `params` as strings, so the contract tests must prove that integer
  and NULL parameters round-trip with the same results as SQLite.

A new `server/src/blobstore.py` has the same shape, with `put(key, bytes)`,
`get(key) -> bytes | None`, `delete_prefix(prefix)`, `list_prefixes(prefix)`:

- `LocalBlobStore`: a directory (default `data/blobs`).
- `R2BlobStore`: boto3 S3 client at `https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  calls run via `asyncio.to_thread`.

Selection: if `D1_DATABASE_ID`/`D1_API_TOKEN` are set, use D1; else SQLite. If
`R2_BUCKET` and keys are set, use R2; else local. Unset → the server behaves as
today on local disk.

### Ingest: spool, then ship

The `session-log` Socket.IO handler, the `/api/session-log` HTTP fallback and
`game-screenshot` keep all current validation and caps. After validation they
no longer write to the database on every flush:

1. Serialize and gzip the payload, and write it atomically (temp file +
   `os.replace`) to `data/spool/<match_id>/<slot>.json.gz` (screenshots:
   `data/spool/<match_id>/screenshots/<slot>-<frame>.jpg`). Disk, not RAM:
   Render free has 512 MB of RAM and a log can be 12 MB uncompressed.
2. Queue the small D1 writes (session-log metadata upsert, screenshot row) in
   the shipper's pending batch.

Client events are queued in the same pending batch. Feedback is written
directly to D1 (rare and valuable). If that write fails, it is queued and the
user still sees success.

`log_shipper` (new, `server/src/log_shipper.py`) runs every `SHIP_INTERVAL_SEC`
(10). Each tick it:

1. Uploads each dirty spool file to R2, then removes it from the spool.
2. Sends every pending D1 write in one `batch` request.
3. Enforces the global budgets (§5).

It also runs a final flush from the FastAPI lifespan shutdown (Render sends
SIGTERM before replacing an instance). Leftover spool files found at startup
are shipped on the first tick.

Per player this is at most one R2 PUT per 10 s. Per server it is about one D1
request per 10 s, or roughly 2.9k D1 row writes per hour with 4 players
active, well under the free 100k/day.

### Rotation

`match_rotation.sweep_pending` keeps its role: find ended matches without a
`match_metrics` row (now in D1), read each slot's log object from R2, and
merge them. It then:

- writes the Parquet file to R2,
- upserts `match_metrics`,
- runs the retention classifier (§2).

`desync_vision` reads screenshot bytes through `blobstore`.

### Migrations

Alembic (`server/alembic/`, `server/alembic.ini`) is replaced by
`server/migrations/NNNN_<name>.sql` and a runner in `db.py`. The runner
records applied files in `schema_migrations(version TEXT PRIMARY KEY,
applied_at TEXT)` and applies pending files in order through the active
backend, one statement at a time. `0001_baseline.sql` is today's schema
(the result of Alembic 0001–0007). Later migrations are added by the PRs that
need them. Existing local dev databases are deleted once; there is no Alembic
→ runner upgrade path.

---

## 2. Retention

### Match registration and the retention record

The server creates the `match_retention` row at `start-game`, when it assigns
`room.match_id` (a UUID4). This row is also what the ingest validation in §5
checks.

```sql
CREATE TABLE match_retention (
  match_id        TEXT PRIMARY KEY,
  room            TEXT NOT NULL,
  slots           TEXT NOT NULL,          -- JSON array of slots allowed to upload
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  tier            TEXT NOT NULL DEFAULT 'normal',   -- 'normal' | 'flagged'
  flag_reasons    TEXT NOT NULL DEFAULT '[]',       -- JSON list
  auto_flag_capped INTEGER NOT NULL DEFAULT 0,      -- 1 = auto-flags recorded but tier held at normal (§5)
  resolved_at     TEXT,
  resolved_note   TEXT,
  last_touched_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleting_at     TEXT                              -- tombstone (§4)
);
```

- `slots` grows when a late joiner or spectator claims a slot mid-match.
- `ended_at` is set on `game-end` (same place as `set_session_ended`).
- `last_touched_at` is updated on a flag, a resolve or unresolve, a manual
  note, and when an admin opens the match's detail.

`flag_match(match_id, signal, detail)` in `server/src/retention.py` is the
only way to flag a match. It is idempotent: it merges `{signal, count, slot,
first_f, note}` into `flag_reasons`, sets `tier='flagged'`, and touches the row.
It does nothing if `deleting_at` is set.

### Flag signals

Constants live in `retention.py`. Log-content signals are found in the same
single pass over merged entries that `_compute_metrics` already makes.

| Source | Signal | Threshold |
|---|---|---|
| Session log `msg` | `REPLAY-NORUN`, `RB-INVARIANT-VIOLATION`, `FATAL-RING-STALE`, `RB-LIVE-MISMATCH` | any |
| | `RB-CHECK` … `MISMATCH` | any |
| | `TICK-STUCK`, `RB-INPUT-STALL-TIMEOUT`, `PEER-PHANTOM`, `LOCAL-FREEZE`, `VISUAL-FREEZE` | any |
| | `INPUT-OOR` | ≥ 20 on one slot |
| Client events (`meta.match_id`, else same room within `created_at`…`ended_at`) | `wasm-fail`, `unhandled` | any; flagged when the event is ingested |
| `desync_events` | `vision_equal = 0` | any; flagged when the verdict is written |
| Feedback (`context.matchId`, else `roomCode` + submit time within the match window) | `feedback` | any; flagged at submit |
| Admin | `manual` with note | — |

### Client changes (the only ones)

- `web/static/play.js`: add `window.addEventListener('error', …)` beside the
  existing `unhandledrejection` listener. It sends
  `KNEvent('wasm-fail', …)` when `e.error instanceof WebAssembly.RuntimeError`,
  otherwise `KNEvent('unhandled', …)`. `KNEvent` already adds `match_id`
  (`shared.js`).
- `web/static/feedback.js` `_gatherContext()`: `if (KNState.matchId) ctx.matchId = KNState.matchId;`

### Tiers and windows

| State | Deleted when |
|---|---|
| `normal` | `LOG_RETENTION_DAYS` (default 7) after `ended_at`, or after `created_at` when `ended_at` is NULL |
| `flagged`, unresolved | only when stale: `last_touched_at` older than `FLAGGED_STALE_DAYS` (default 180) |
| `flagged`, resolved | `LOG_RETENTION_DAYS` after `resolved_at` (undo window) |
| Feedback rows (`feedback.resolved_at` added) | same rules as flagged: unresolved kept until stale (by `created_at`), resolved deleted `LOG_RETENTION_DAYS` after `resolved_at` |
| Client events with no match | `LOG_RETENTION_DAYS` after `created_at` |

Screenshots, desync verdicts and a match's client events follow their match.

---

## 3. Admin API

All existing paths and response fields stay the same. Consumers:
`web/static/admin.js`, `tools/analyze_match.py`,
`tests/test_session_log_flush_e2e.py`, `tests/desync-e2e.spec.mjs`,
`tests/determinism-automation.mjs`.

| Endpoint | Change |
|---|---|
| `GET /admin/api/session-logs` | SQL runs on D1. The per-match desync-count loop becomes one `GROUP BY match_id` query. New optional `tier=flagged\|normal`. Tombstoned matches hidden. |
| `GET /admin/api/session-logs/{id}` | `log_data`/`context` come from the R2 object. If the object is missing, both are `null` and the response carries `"log_deleted": true`. Touches retention. |
| `GET …/session-logs/{id}/export` | Streams JSONL from the R2 object; same format. |
| `GET /admin/api/input-audit/{match_id}` | Reads each slot's `context` from R2. |
| `GET /admin/api/screenshots/{match_id}`, `…/img/{id}` | Metadata from D1; image bytes proxied from R2 (no presigned URLs). |
| `GET /admin/api/matches`, `…/matches/{id}` | Joins `match_retention`; adds `tier`, `flag_reasons`, `resolved_at`, `resolved_note`, `last_touched_at`. New filters `tier=`, `unresolved=true`. With `tier=flagged`, `days` is ignored. Tombstoned matches: hidden in the list; detail returns 410. |
| `GET /admin/api/stats` | Counts from D1. Keeps `retention_days`. Adds `flagged_stale_days`, `tiers: {normal, flagged_unresolved, resolved}`, `storage: "d1+r2"\|"local"`, `storage_status: {state, last_error, spool_files, spool_bytes}`, `budgets` (§5). |
| `client-events`, `feedback`, `desync-events`, `session-timeline` | Same SQL on D1. Feedback responses add `resolved_at`. |

New endpoints (require `X-Admin-Key`; optional body `{"note": str}`, max 1 KB;
idempotent; return the updated row; `409` if the match is tombstoned):

- `POST /admin/api/matches/{id}/flag`
- `POST /admin/api/matches/{id}/resolve`
- `POST /admin/api/matches/{id}/unresolve`
- `POST /admin/api/feedback/{id}/resolve`
- `POST /admin/api/feedback/{id}/unresolve`

Each mutation writes an `admin_actions` row (§5).

Admin page (`admin.html`/`admin.js`): a tier badge and flag reasons in the
session-log detail, a Flagged/Unresolved filter, and Resolve/Unresolve
buttons on matches and feedback. All log-derived strings go through the
existing `escapeHtml`.

---

## 4. Error handling

### Deletion across R2 and D1 (no cross-store transaction)

R2 and D1 cannot share a transaction, and the D1 HTTP API's batch is not
documented as atomic. The documented rollback applies to the Worker binding's
`db.batch()`. Deletion is therefore a resumable three-step process, with a
tombstone, that is correct under interruption at any point:

1. **Mark:** `UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = ? AND deleting_at IS NULL AND <expiry condition>`.
   Because the expiry condition is in the same statement, a flag or resolve
   that landed first makes this a no-op. From here the match is hidden (list)
   or 410 (detail), and flag/resolve/unresolve return 409.
2. **R2:** list `matches/<id>/` and delete keys in batches of ≤ 1000. Deleting
   a key that is already gone is a no-op.
3. **D1:** delete `screenshots`, `desync_events`, the match's `client_events`,
   `session_logs` and `match_metrics`, and delete `match_retention` last. Each
   statement is idempotent on its own.

Each sweep first finishes every row with `deleting_at` set, then marks newly
expired ones. An interruption after step 1 or during step 2 or 3 leaves a hidden
match that the next sweep finishes. The tombstone is removed only after
everything else is gone. The shipper and `flag_match` skip tombstoned matches.

### Retention sweep

`retention_sweep` replaces `cleanup_old_data` in `app.py`. The old task's
first run came after 24 h, which never happens on a server that restarts
often. The new sweep runs 60 s after startup and then every 6 h. It depends
only on timestamps, so skipped runs are harmless. Weekly, tracked by
`server_state['last_orphan_sweep']`, it lists `matches/` prefixes in R2 and
deletes those with no `match_retention` row whose objects are older than
`LOG_RETENTION_DAYS`.

### Other failures

| Failure | Behavior |
|---|---|
| D1/R2 unreachable or quota exceeded while shipping | Spool files and pending rows are kept. Retry with exponential backoff capped at 5 min. One WARN per state change. Socket.IO handlers never await D1/R2. |
| D1 unreachable at boot | The server starts anyway. The shipper runs migrations before its first ship. Admin endpoints return 503 with the reason. `/health` stays OK. |
| Feedback write fails | Queued in the shipper; the user sees success. |
| Two instances overlap during a deploy | Both may ship the same `(match, slot)`. Uploads are the full log, so last writer wins. Rotation upserts. Sweep steps are idempotent. |
| R2 object missing on admin read | `log_deleted: true`, not a 500. |

---

## 5. Abuse resistance

### Admin key

- Current protections are kept: Render-generated key (`generateValue`),
  `hmac.compare_digest`, 30 requests/min per IP on admin routes. Auth runs
  before any query.
- The API has no hard-delete endpoint. The worst a leaked key can do is
  resolve matches, which then have a `LOG_RETENTION_DAYS` window before
  deletion.
- `admin_actions(id, action, target_type, target_id, note, ip_hash, created_at)`
  records every mutation. It is kept `FLAGGED_STALE_DAYS`, so a bad bulk
  resolve is visible and can be reversed within the undo window.
- Rotation: change `ADMIN_KEY` in Render and redeploy.

### Ingest validation

Today `/api/session-log` checks a room-bound upload token but trusts `matchId`
and `slot` from the body. A single room's token can therefore create unlimited
made-up matches. After this change, the session-log HTTP fallback, the
`session-log` Socket.IO handler and `game-screenshot` accept an upload only
if all of these hold:

- `match_retention` has the `match_id` (in-memory cache, D1 lookup on a miss,
  negative results cached for 60 s);
- its `room` equals the token's / sid's room;
- `slot` is in `slots`;
- `deleting_at` is NULL;
- it is within 30 min of `ended_at`, or within 4 h of `created_at` if
  `ended_at` is NULL.

Anything else is rejected before touching the spool. Match ids are UUID4 and
not guessable, so knowing a real match id requires having been in its room.

### Global budgets

Per-IP limits (`ratelimit.py`) stay. Site-wide daily budgets stop spam from
many IPs from exhausting the shared free tier or the bill:

| Env var | Default | Free-tier limit it protects |
|---|---|---|
| `BUDGET_D1_ROWS_PER_DAY` | 60000 | D1 100k rows written/day |
| `BUDGET_R2_UPLOAD_BYTES_PER_DAY` | 2 GB | R2 cost |
| `BUDGET_STORED_BYTES` | 8 GB | R2 10 GB free storage |
| `BUDGET_AUTO_FLAGGED_BYTES` | 2 GB | Unbounded growth from forged flag signals |

- Stored bytes = sum of `session_logs.blob_bytes`, `screenshots.size` and
  `match_metrics.parquet_bytes`, computed by the sweep.
- Counters are kept in memory and saved to `server_state` once a minute
  (~1.4k row writes/day), so a restart does not reset them.
- When a budget is exhausted, data is dropped in this order: screenshots, then
  client events with no match, then normal match logs, then flagged match
  data. Feedback is dropped last.
- When `BUDGET_AUTO_FLAGGED_BYTES` is exceeded, new auto-flags are still
  appended to `flag_reasons`, but the match stays `normal` and
  `auto_flag_capped = 1`. Manual and feedback flags ignore the cap.
- Budget state is reported in `/admin/api/stats`.
- `/api/client-event` (60/min per IP, ~86k/day from one IP) is covered by the
  D1 row budget.

### Tokens

- R2 token: Object Read & Write, limited to the one bucket.
- D1 token: D1 Edit. If Cloudflare cannot limit it to one database, keep only
  this database in the account, or use a separate Cloudflare account.
  Confirm this when the token is created.
- Both live only in Render's environment.
- The setup README includes turning on a Cloudflare billing notification for
  R2, because Cloudflare has no hard spend cap.

---

## 6. Configuration

| Var | Default | Notes |
|---|---|---|
| `CF_ACCOUNT_ID` | — | D1 endpoint and R2 endpoint |
| `D1_DATABASE_ID`, `D1_API_TOKEN` | — | unset → SQLite |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | — | unset → `data/blobs` |
| `LOG_RETENTION_DAYS` | 7 | was 14 |
| `FLAGGED_STALE_DAYS` | 180 | |
| `SHIP_INTERVAL_SEC` | 10 | |
| `BUDGET_*` | see §5 | |

`render.yaml` adds the secrets with `sync: false`. `deploy/render/README.md`
gains a one-time setup section:

1. Create the D1 database and the R2 bucket.
2. Create the two scoped tokens.
3. Enter the values in Render.
4. Turn on the Cloudflare billing notification.

The "Logs and the local SQLite database reset on every restart" line in that
README is updated. New dependency: `boto3` (declared directly in
`server/pyproject.toml` and locked).

---

## 7. Testing

- **Backend contract suite:** the same tests run against `SqliteBackend` and
  against `D1Backend` on an `httpx.MockTransport` fake. The fake executes the
  SQL on in-memory SQLite and returns D1's response JSON, and the suite covers
  integer/NULL params. The same suite runs `LocalBlobStore` and an in-memory
  fake R2.
- **Optional live test:** skipped unless the D1/R2 env vars are set. Run once
  during implementation, including a check of whether the `/query` batch is
  transactional; the design does not depend on the answer.
- **Classifier:** one fixture per signal; `INPUT-OOR` at 19 and 20.
- **Retention:** injectable clock for every window; the deletion interruption
  test fails at each step and asserts that repeated sweeps converge to fully
  deleted with no visible partial match; a flag racing with a mark.
- **Shipper:** dirty tracking, backoff, shutdown flush, startup spool recovery,
  and budget priority order.
- **Ingest validation:** unknown match, wrong room, wrong slot, expired
  window, tombstoned match.
- **Admin API:** existing tests pass unchanged, which shows the response
  shapes did not change. New endpoints, `admin_actions` rows, 409/410 paths.
- **End to end:** one local two-player match per PR that changes ingest
  (logs land, rotate, show in admin). `rb-two-player.mjs` is not required
  because the tick loop, sync and input are untouched.
- **Production check after cutover:** play a match, restart the Render
  service, and confirm the match, logs and metrics are still in the admin API.

---

## 8. Delivery (small PRs, in order)

1. `refactor(db)`: SQL migration runner and `0001_baseline.sql` replace
   Alembic; backend interface and `SqliteBackend`. No behavior change.
2. `feat(db)`: `D1Backend` and the contract suite.
3. `feat(logs)`: `blobstore` (local and R2), spool, `log_shipper` with the
   daily budgets (`BUDGET_D1_ROWS_PER_DAY`, `BUDGET_R2_UPLOAD_BYTES_PER_DAY`);
   `match_retention` registration at `start-game` and ingest validation.
   Session logs move to R2, and the admin detail, export and input-audit
   endpoints read from the blob store.
4. `feat(logs)`: screenshots move to the blob store (ingest, admin, `desync_vision`).
5. `feat(retention)`: classifier in rotation; flag hooks for client events,
   desync verdicts and feedback; `BUDGET_AUTO_FLAGGED_BYTES`; the two client
   changes.
6. `feat(retention)`: tombstoned `retention_sweep` replaces
   `cleanup_old_data`; stored-bytes accounting and `BUDGET_STORED_BYTES`;
   orphan sweep.
7. `feat(admin)`: retention fields and filters, flag/resolve endpoints,
   `admin_actions`, new stats fields.
8. `feat(admin)`: admin page badges, filters and buttons.
9. `chore(deploy)`: `render.yaml` env entries, README setup, cutover and the
   production check.

Before each merge, check the diff size against `main` (CLAUDE.md).
