# Off-box log storage (D1 + R2) with tiered retention

**Date:** 2026-09-25
**Status:** Approved 2026-09-25. Revised 2026-09-28 after the first PRs shipped (see "Revision 2026-09-28"); the revision is pending review.
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

## Revision 2026-09-28

**Shipped and running in production:**

| PR | What |
|---|---|
| #41 | Clients send session-log *deltas* by monotonic `seq`; the server appends them as `session_log_chunks` rows (was Alembic 0008, now migration `0002`) instead of rewriting a 12 MB blob every 5 s |
| #44 | `Backend` interface, `SqliteBackend`, `D1Backend`, plain-SQL migrations replacing Alembic |
| #46 | Session-log flushes split into chunks of at most 512 KB (D1 rows hold at most 2 MB) |
| #48 | `blobstore.py` (local folder / R2); screenshot bytes in R2 under `matches/<id>/screenshots/`, rows keep `blob_key` and `size` (migration `0003`) |
| #49 | httpx request lines no longer logged at INFO |

Production has used D1 (`kaillera-next-logs`) since 2026-09-28 and R2
(`kaillera-next-screenshots`) since #48. Live checks against both passed:
integer/float/NULL params bind correctly, and D1's HTTP batch **is** atomic.

**What changes in this spec because of that:**

1. **No spool or shipper.** #41 turned each flush into a small append, so
   ingest writes straight to D1 (session logs, client events) and R2
   (screenshots). The loss window is effectively zero rather than ~10 s. The
   "Ingest: spool, then ship" design below is replaced by "Ingest: direct
   writes", and the shipper's jobs (budgets, retries) move to the write path.
2. **D1 is the hot store, R2 the archive.** D1's free tier caps a database at
   500 MB, and flagged matches' logs are kept for months, so they can't all
   stay in D1. When rotation processes an ended match it writes the merged
   entries as Parquet and each slot's `context` as JSON to R2, then (after
   `D1_HOT_DAYS`, default 2) deletes that match's chunks from D1 and clears
   `session_logs.context`. Admin reads use D1 while the chunks exist and the
   R2 archive after.
3. **Context size fix (a live bug).** Both session-log handlers allow
   `context` (with `inputAudit`) up to 2 MiB = 2,097,152 bytes, and it shares
   a D1 row with `summary`. D1 rows are capped at 2,000,000 bytes, so a long
   match's flushes fail once its audit passes ~1.99 MB until it passes the
   2 MiB cap and is dropped. The cap drops to 1.5 MB (next PR).
4. **Delivery (§8) is renumbered** around what has shipped.

---

## 1. Architecture and data flow

### Storage split

| Data | D1 (rows) | R2 (objects) |
|---|---|---|
| Session logs (hot) | `session_logs` (metadata, `summary` ≤ 4 KB, `context` ≤ 1.5 MB, `last_seq`, `log_epoch`) and `session_log_chunks` (entries, ≤ 512 KB per row) | — |
| Session logs (archive, after rotation) | `session_logs` kept with `context` cleared; chunks deleted after `D1_HOT_DAYS` | `matches/<match_id>/entries.zstd.parquet` (all slots' entries) and `matches/<match_id>/sessions/<slot>.context.json.gz` |
| Match metrics | `match_metrics` (unchanged columns; `parquet_path` holds the R2 key) | — |
| Screenshots | `screenshots`: `id`, `match_id`, `slot`, `frame`, `size`, `blob_key`, `created_at` | `matches/<match_id>/screenshots/<slot>-<frame>.jpg` |
| Feedback, client events, desync verdicts | As today | — |
| Retention, budgets, audit | `match_retention`, `server_state`, `admin_actions` (below) | — |

Every object for a match lives under `matches/<match_id>/`, so deleting a match is
one prefix delete. D1 rows stay under D1's 2 MB row limit: chunks are split at
512 KB, `context` is capped at 1.5 MB, and image bytes are in R2. D1's total
size stays bounded because ended matches move to the R2 archive.

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

`server/src/blobstore.py` (shipped in #48) has `put(key, bytes, content_type)`,
`get(key) -> bytes | None` and `delete(keys)`. Retention adds
`delete_prefix(prefix)` and `list_prefixes(prefix)`:

- `LocalBlobStore`: a directory (default `data/blobs`).
- `R2BlobStore`: boto3 S3 client at `https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  calls run via `asyncio.to_thread`.

Selection: if `D1_DATABASE_ID`/`D1_API_TOKEN` are set, use D1; else SQLite. If
`R2_BUCKET` and keys are set, use R2; else local. Unset → the server behaves as
today on local disk.

### Ingest: direct writes

*(Replaces the original "spool, then ship" design: #41 made each flush a
small append, so there is nothing to batch.)*

- **Session logs:** the `session-log` Socket.IO handler and the
  `/api/session-log` HTTP fallback call `db.append_session_log`, which writes
  the new chunks, the size-cap delete and the metadata upsert to D1 in one
  atomic batch. A failed write raises, the client isn't acked, and it resends
  those entries on its next flush (dedupe by `seq`).
- **Screenshots:** `db.insert_screenshot` puts the bytes in R2, then writes the
  row. Best-effort: a failed upload stores nothing.
- **Client events and feedback:** one D1 insert each, as before.
- **Budgets** (§5) are counted in the `db` write functions, not a shipper.

Rough volume with 4 players: about 14k D1 row writes per hour of play
(well under 100k/day at today's traffic) and 48 screenshot PUTs per minute.

### Rotation

`match_rotation.sweep_pending` keeps its role: find ended matches without a
`match_metrics` row, read each slot's entries (`db.get_full_log_entries`),
and merge them. It then:

- writes the Parquet file to R2 (`matches/<id>/entries.zstd.parquet`) instead
  of the local disk, and each slot's `context` to
  `matches/<id>/sessions/<slot>.context.json.gz`;
- upserts `match_metrics`;
- runs the retention classifier (§2).

A later pass of the same sweeper **evicts** archived matches from D1 once
they are `D1_HOT_DAYS` past `ended_at`: it deletes their
`session_log_chunks` and sets `session_logs.context = '{}'`, recording
`archived_at` on `match_retention`. It never evicts a match whose Parquet
upload failed. Admin detail, export and input-audit read the chunks and
`context` from D1 while present, and from the R2 archive otherwise.

`desync_vision` reads screenshot bytes through `blobstore` (shipped in #48).

### Migrations

Alembic (`server/alembic/`, `server/alembic.ini`) is replaced by
`server/migrations/NNNN_<name>.sql` and a runner in `db.py`. The runner
records applied files in `schema_migrations(version TEXT PRIMARY KEY,
applied_at TEXT)` and applies pending files in order through the active
backend as one batch per file. `0001_baseline.sql` is the schema Alembic
0001–0007 produced and applies over an existing Alembic database;
`0002_session_log_chunks.sql` carries Alembic 0008 (#41), and databases
already at Alembic 0008 get it recorded rather than re-run
(`_ALEMBIC_EQUIVALENTS`); `0003_screenshot_blobs.sql` rebuilds `screenshots`.
Existing migrations are never edited; every change is a new file.

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
| `GET /admin/api/session-logs/{id}` | `log_data`/`context` come from D1 chunks while the match is hot, and from the R2 archive (Parquet filtered to the slot, context JSON) after eviction. If neither exists, both are `null` and the response carries `"log_deleted": true`. Touches retention. |
| `GET …/session-logs/{id}/export` | Streams JSONL from the same source; same format. |
| `GET /admin/api/input-audit/{match_id}` | Reads each slot's `context` from D1, or the R2 archive after eviction. |
| `GET /admin/api/screenshots/{match_id}`, `…/img/{id}` | Metadata from D1; image bytes proxied from R2 (no presigned URLs). Shipped in #48. |
| `GET /admin/api/matches`, `…/matches/{id}` | Joins `match_retention`; adds `tier`, `flag_reasons`, `resolved_at`, `resolved_note`, `last_touched_at`. New filters `tier=`, `unresolved=true`. With `tier=flagged`, `days` is ignored. Tombstoned matches: hidden in the list; detail returns 410. |
| `GET /admin/api/stats` | Counts from D1. Keeps `retention_days`. Adds `flagged_stale_days`, `tiers: {normal, flagged_unresolved, resolved}`, `storage: "d1+r2"\|"local"`, `storage_status: {state, last_error, d1_bytes, r2_bytes}`, `budgets` (§5). |
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
2. **R2:** list `matches/<id>/` (screenshots, Parquet, context archives) and
   delete keys in batches of ≤ 1000. Deleting a key that is already gone is a
   no-op.
3. **D1:** delete `screenshots`, `desync_events`, the match's `client_events`,
   `session_log_chunks`, `session_logs` and `match_metrics`, and delete
   `match_retention` last. Each statement is idempotent on its own.

Each sweep first finishes every row with `deleting_at` set, then marks newly
expired ones. An interruption after step 1 or during step 2 or 3 leaves a hidden
match that the next sweep finishes. The tombstone is removed only after
everything else is gone. Ingest validation (§5) and `flag_match` skip
tombstoned matches.

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
| D1 unreachable or over quota during a session-log flush | The append raises, the client isn't acked, and it resends those entries next flush. Gameplay is unaffected. |
| R2 unreachable during a screenshot | That screenshot is skipped with a warning. |
| R2 unreachable during rotation | The match isn't archived or evicted; the next sweep retries. |
| D1 unreachable at boot | Today boot fails and Render keeps the previous instance. Accepted: a deploy during a D1 outage simply doesn't go live. |
| Two instances overlap during a deploy | Appends dedupe by `seq`; rotation upserts; sweep steps are idempotent. |
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

Anything else is rejected before anything is written. Match ids are UUID4 and
not guessable, so knowing a real match id requires having been in its room.

### Global budgets

Per-IP limits (`ratelimit.py`) stay. Site-wide daily budgets stop spam from
many IPs from exhausting the shared free tier or the bill:

| Env var | Default | Free-tier limit it protects |
|---|---|---|
| `BUDGET_D1_ROWS_PER_DAY` | 60000 | D1 100k rows written/day |
| `BUDGET_R2_UPLOAD_BYTES_PER_DAY` | 2 GB | R2 cost |
| `BUDGET_STORED_BYTES` | 8 GB | R2 10 GB free storage |
| `BUDGET_D1_BYTES` | 400 MB | D1 500 MB per database (free) |
| `BUDGET_AUTO_FLAGGED_BYTES` | 2 GB | Unbounded growth from forged flag signals |

- R2 stored bytes = sum of `screenshots.size`, `match_metrics.parquet_bytes`
  and archived context sizes, computed by the sweep. D1 bytes come from the
  `size_after` field D1 returns with every query.
- Over `BUDGET_D1_BYTES`, the sweep evicts archived matches early (oldest
  first) before anything is dropped.
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
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | — | unset → `blobs/` next to the SQLite file; production bucket `kaillera-next-screenshots` (it holds every match's objects despite the name) |
| `LOG_RETENTION_DAYS` | 7 | was 14 |
| `FLAGGED_STALE_DAYS` | 180 | |
| `D1_HOT_DAYS` | 2 | days after `ended_at` before an archived match leaves D1 |
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
- **Archive and eviction:** a rotated match's Parquet and context land in the
  blob store; eviction deletes chunks only after a successful archive; admin
  detail, export and input-audit return identical data before and after
  eviction.
- **Budgets:** counters at the write path and the drop priority order.
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

Done: #44 (backends, migrations), #46 (chunk splitting), #48 (screenshots in
R2), #49 (quiet httpx logs), and the D1/R2 cutover on Render.

Remaining:

1. `fix(logs)`: cap session-log `context` at 1.5 MB in both handlers
   (revision item 3).
2. `feat(logs)`: `match_retention` registration at `start-game` and ingest
   validation (§5), plus the daily D1-rows and R2-bytes budgets.
3. `feat(logs)`: archive at rotation (Parquet and context to R2), eviction
   after `D1_HOT_DAYS`, admin reads that fall back to the archive,
   `BUDGET_D1_BYTES`.
4. `feat(retention)`: classifier in rotation; flag hooks for client events,
   desync verdicts and feedback; `BUDGET_AUTO_FLAGGED_BYTES`; the two client
   changes.
5. `feat(retention)`: tombstoned `retention_sweep` replaces
   `cleanup_old_data`; stored-bytes accounting and `BUDGET_STORED_BYTES`;
   orphan sweep.
6. `feat(admin)`: retention fields and filters, flag/resolve endpoints,
   `admin_actions`, new stats fields.
7. `feat(admin)`: admin page badges, filters and buttons.
8. `feat(admin)`: feedback triage fields and endpoint, `triaged=false`
   filter, `admin_actions.actor`, triage display on the admin page (§9).
   Then create the daily routine.

Before each merge, check the diff size against `main` (CLAUDE.md).

---

## 9. Daily feedback routine (follow-up after §8 item 8)

Once feedback persists, a scheduled cloud agent processes new feedback every
day. Feedback has persisted since the 2026-09-28 cutover; the routine is set
up once its API (§8 item 8) ships.

### API additions (§8 item 8)

- Migration: `feedback` gains `triaged_at`, `triage_category`, `triage_note`
  (≤ 4 KB).
- `POST /admin/api/feedback/{id}/triage` with body `{category, note}`.
  `category` is one of `bug`, `crash`, `desync`, `ux`, `spam`, `duplicate`,
  `other`. Idempotent: `triaged_at` is set only on the first call, and later
  calls update category and note.
- `GET /admin/api/feedback` gains the filter `triaged=false`.
- `admin_actions` gains `actor`, taken from an optional `X-Admin-Actor`
  header (e.g. `routine`). The header is informational only and grants no
  access.
- The admin page shows the triage category and note on each feedback entry.

Unresolved is not used as the "needs processing" marker, because real bugs
stay unresolved until fixed and would be re-investigated every day.

### Routine behavior

A scheduled cloud agent runs daily. It has a checkout of this repo, and the
prod admin key comes from its environment, never its prompt. Each run:

1. Fetch feedback with `triaged=false`.
2. For each report, look up the linked match (`context.matchId`, else room +
   time) with its `tier` and `flag_reasons`.
3. Categorize:
   - **Spam or duplicate:** triage, then resolve with a note (e.g.
     `duplicate of #123`). A duplicate is the same match, or the same
     `ip_hash` with near-identical text within 24 h. Only resolve when
     confident; uncertain reports stay unresolved.
   - **Crash or desync with a linked match:** run `tools/analyze_match.py`
     against the prod admin API and store a diagnosis of ≤ 2 KB in
     `triage_note`. At most 5 investigations per run; the rest are left for
     the next run.
   - **Everything else:** triage only, left unresolved for the owner.
4. Send one push notification: counts per category, the top issues in one
   line each, and any reports skipped because of the cap. It never includes
   emails or IP hashes.

### Guardrails

- Feedback text is untrusted input to an agent that holds the admin key. The
  routine prompt treats it strictly as data. The routine calls only the
  triage and resolve endpoints.
- A wrong resolve can be undone for `LOG_RETENTION_DAYS`, and every action
  is recorded in `admin_actions` with `actor=routine`.
- When creating the routine, confirm that a cloud routine can hold the key as
  a secret and send push notifications. If it cannot send push
  notifications, the digest is the routine run's own output.
