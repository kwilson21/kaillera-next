# Reliability Funnel Telemetry — Design Spec

**Date:** 2026-04-07
**Status:** Shipped (pivoted from aggregate to session-centric view mid-implementation)
**Owner:** Kazon
**Tracks:** P0-1 in `project_launch_readiness_plan`

## Mid-implementation pivots

This spec underwent three pivots during implementation. Each was pushed by the user as they saw an early version and realized what they actually needed. The sections below document the final shipped design, not the intermediate versions.

**Pivot 1 — aggregate → session-centric.** Originally the view was an aggregate dashboard showing stage-by-stage drop-off across all sessions in a time window. The user pointed out that the real workflow starts from a specific user (feedback, shared room code, or player name) and needs the funnel attached to that session. The aggregate `/admin/api/funnel` endpoint and Funnel tab were removed; a new `/admin/api/session-timeline` endpoint and enriched session detail viewer took their place.

**Pivot 2 — single-column checklist → per-participant multi-column checklist.** The first pivoted version collapsed everyone in a session into one funnel checklist. The user noted that in solo sessions `peer_joined` is marked as a failure (wrong — it's not applicable), and that in multiplayer sessions one peer can get stuck while another sails through. The checklist was rewritten as a per-participant table: one column per participant, one row per stage, with `—` for not-applicable cells. Two new events (`peer_left`, `peer_reconnected`) were added so the table can also surface peer lifecycle history.

**Pivot 3 — checklist → timeline.** The per-participant checklist immediately ran into more edge cases: "what if a peer joins, leaves, rejoins, leaves again?" Each new scenario needed a new rule (solo-host handling, left-gracefully detection, left-permanently tracking). The user observed: *"we are collecting events then building an accurate timeline"* — the checklist was fighting the data. The checklist and all its per-stage state-machine helpers (`applicableStagesForSlot`, `hasLeftPermanently`, per-participant failed-stage detection) were removed. The primary view is now a single chronological timeline with a small header summary above it. The timeline natively handles every edge case because it doesn't abstract — it shows the raw story. This pivot also locked in the long-term direction: everything with a timestamp (screenshots, input audit, feedback, sync log) should hang off the same timeline in future iterations. See `memory/project_session_timeline_vision.md`.

## Problem

The 2026-04-07 launch-readiness audit confirmed that happy-path reliability of `create room → join room → first frame rendered → sustained gameplay` is the #1 blocker for public sharing. The audit found 30+ failure branches in the funnel.

The existing 9 client_event types (`webrtc-fail`, `wasm-fail`, `desync`, `stall`, `reconnect`, `audio-fail`, `unhandled`, `compat`, `session-end` at app.py:63-73) are **failure-typed**, not **stage-typed**. They tell us *what* broke but not *where in the funnel* it broke, and they only fire when something obviously fails — silent stalls produce no event at all.

When a user reports a problem — through feedback, a shared room code, or just a player name — there's currently no way to look at *their* session and see which stages they reached, which they didn't, and what errors occurred in between. The existing session detail view shows the session log's summary and screenshots, but not the stage-by-stage narrative.

## Goal

1. Add seven stage-typed telemetry events that mark progress through the create→join→play funnel.
2. Enrich the existing admin session detail view with a per-session funnel checklist (which stages this session reached, with inline error events for stages that weren't reached) plus a chronological timeline of every stage and error event for the session.
3. Add lookup paths into the session detail view: a search box on Session Logs (room code / player name / match ID), and a room-code link on feedback rows that jumps to the matching session.

This work is **observation, not intervention.** It does not fix any reliability bugs. It gives the operator the data they need to diagnose what broke for a specific user, so the next fix is targeted rather than guessed.

## Scope

### In scope

1. **Nine** new event types added to the `client_events` allowlist:
   - Seven stage events: `room_created`, `peer_joined`, `webrtc_connected`, `rom_loaded`, `emulator_booted`, `first_frame_rendered`, `milestone_reached`
   - Two peer-lifecycle events: `peer_left`, `peer_reconnected`
2. Emission of those events at the right moments in the existing client code. Peer lifecycle events are emitted only from the host (slot 0) and carry the affected peer's slot in `meta.peer_slot`, so the timeline has a single authoritative record instead of N duplicates.
3. `KNEvent` helper enriched to auto-include `match_id` in event meta (no per-call-site threading)
4. New `/admin/api/session-timeline?match_id=X&room=Y` endpoint returning all `client_events` for a single session, sorted chronologically
5. **Session detail viewer enriched with a session header summary + unified chronological timeline** (replaces the original checklist view entirely). The timeline is the primary narrative view. Slot colorization via row tints and slot badges lets the operator visually follow individual participants down the timeline. Smart relative timestamps (`+450ms` / `+12.4s` / `+1m 23s`). Extension point for future integrations (screenshots, input audit, feedback, sync log).
6. Search box on the Session Logs tab (room code / player name / match ID)
7. `player_name` filter on `/admin/api/session-logs`
8. Room-code link on feedback rows that navigates to the matching session
9. Input audit link on each session log row that opens the existing `/admin/api/input-audit/{match_id}` endpoint in the viewer

### Out of scope (deferred)

- `flow_failed` event with stage context — deferred to P1 alongside the silent-failure UX work, because both touch the same catch blocks and timeout handlers
- User-facing error toasts for currently-silent failures — P1
- ROM transfer toast consolidation — P1
- Any reliability *fix* — P0-1 only observes, P1+ acts on what it observes
- Aggregate dashboards, charts, or time-windowed funnel views — explicitly not what this project needs
- Sampling, rate limiting, or aggregation — scale is small enough to log every event

### Mode coverage

**v1 instruments lockstep mode only.** Three of the seven emission sites live in `netplay-lockstep.js`, so a streaming-mode session will not fire `webrtc_connected`, `first_frame_rendered`, or `milestone_reached`. The session-centric view handles this gracefully — a streaming session's funnel checklist will show the early stages reached and the later stages not reached, but since the operator is looking at a *specific* session they know whether it was streaming and can interpret the result accordingly. Streaming-mode telemetry is deferred to a future iteration.

## The seven events

All events use the existing `client_events` table and `KNEvent()` helper at shared.js:593-610. No schema migration. The only server change is adding seven strings to the `_VALID_EVENT_TYPES` allowlist at app.py:63-73.

| Event | Fires when | Payload (`meta` field) |
|---|---|---|
| `room_created` | Host receives successful `open-room` ack | `{}` (room is on the row, no extras needed) |
| `peer_joined` | Any client receives successful `join-room` ack | `{slot, is_spectator}` |
| `webrtc_connected` | A peer connection's DataChannel reaches `open` state for the first time in this session | `{remote_slot}` |
| `rom_loaded` | The ROM blob is ready and the client has emitted `rom-ready` to the server | `{bytes, method}` where method is `"local"` or `"shared"` |
| `emulator_booted` | EJS frame counter advances from 0 → 1 (WASM core started running) | `{}` |
| `first_frame_rendered` | Lockstep `startGameSequence()` fires (frame ≥ MIN_BOOT_FRAMES = 120, input exchange begins). **Note:** name is slightly aspirational — this measures "lockstep handshake complete and input exchange started," which is the meaningful "the player can play now" signal. Kept named `first_frame_rendered` for funnel readability. | `{}` |
| `milestone_reached` | Frame counter reaches 1800 (~30 seconds of sustained gameplay at 60fps) | `{frame: 1800}` |

**Why these seven and not fewer:** The gap between any two adjacent events is one of the documented silent-failure zones in the audit. Collapsing any pair (e.g., merging `emulator_booted` and `first_frame_rendered`) would erase the ability to distinguish "WASM never booted" from "WASM booted but lockstep handshake stalled," which the audit identified as distinct failure modes (shared.js:150-157 frame-stuck-at-6 vs wasm-fail).

**Why no `flow_failed`:** Wiring stage context into the existing catch blocks is the bulk of the cost and naturally belongs with the P1 silent-failure UX work — both touch the same code paths. Doing them together is cheaper than doing them separately.

## Correlation strategy

Each stage event needs to be tied to the session that produced it so the timeline query can pull back the right rows.

**Schema discovery during implementation:** the `client_events` table has no `match_id` column — only `type`, `message`, `meta`, `room`, `slot`, `ip_hash`, `user_agent`, `created_at`. Rather than add a schema migration, the implementation stuffs `match_id` into the `meta` JSON blob and uses SQLite `json_extract(meta, '$.match_id')` in queries.

- **Pre-game events** (`room_created`, `peer_joined`): correlate by `room` column. Before game-started fires, `KNState.matchId` is null, so these events have no `match_id` in meta.
- **In-game events** (`webrtc_connected`, `rom_loaded`, `emulator_booted`, `first_frame_rendered`, `milestone_reached`, plus all failure events like `webrtc-fail`): correlate by `match_id` extracted from `meta`. `KNState.matchId` is set the moment game-started fires.
- **The `KNEvent` helper at shared.js:593-619 was enriched to auto-include `match_id` in meta whenever `KNState.matchId` is set.** This avoids threading match_id through every call site and also improves existing diagnostic events (`webrtc-fail`, `wasm-fail`, etc.) which previously lost match context.
- **The session-timeline endpoint** accepts both `match_id` and `room` as query params and `UNION`s them, so a single session's full narrative (pre-game + in-game) is retrieved in one query.

## Emission sites

All emissions go through the existing `KNEvent(type, msg, meta)` helper at shared.js:593-610. The helper already POSTs to `/api/client-event`, swallows network failures silently, and never breaks user flow. No new helper needed.

| Event | File | Anchor |
|---|---|---|
| `room_created` | `web/static/lobby.js` | inside the `open-room` callback, after server ack |
| `peer_joined` | `web/static/play.js` | inside the `join-room` callback at play.js:557 (existing `join-ack` breadcrumb is the marker) |
| `webrtc_connected` | `web/static/netplay-lockstep.js` | first time a peer's DataChannel `onopen` fires for that peer in the current session, around line 1914-1942 |
| `rom_loaded` | `web/static/play.js` | immediately before or after the existing `rom-ready` socket emit |
| `emulator_booted` | `web/static/shared.js` | inside the `waitForEmulator` polling loop the first time `frames > 0` is observed, around line 150-163 |
| `first_frame_rendered` | `web/static/netplay-lockstep.js` | inside `startGameSequence()` at the existing entry point |
| `milestone_reached` | `web/static/netplay-lockstep.js` | per-frame in the input loop, gated by a `_milestone1800Sent` flag to fire exactly once per session |

Each emission is one line. Each must be idempotent (the gating flag for `milestone_reached`, and one-shot semantics for the others by virtue of where they fire).

## Admin view (shipped)

No new tab. The existing **Session Logs** tab is the entry point and the existing session detail viewer is enriched with two new panels.

### Session Logs tab — search box

A single text input above the session list, placeholder: "Search room code, player name, or match ID…". Debounced at 250ms. The client-side handler classifies the input:

- Long hex string (≥16 chars) → `?match_id=X`
- Short alphanumeric (3-16 chars) → `?room=X`
- Anything else → `?player_name=X`

All three filters hit `/admin/api/session-logs` which was extended with a new `player_name` LIKE filter.

### Session detail viewer — header summary + chronological timeline

When a session log row is clicked, the viewer fetches `/admin/api/session-timeline?match_id=X&room=Y` and renders two panels:

**Session header** — a one-line summary bar computed from the events:
- Duration (from first to last event, formatted with smart relative time)
- Total event count
- Participant badges — one colored pill per slot discovered in the event stream (host is always present if `room_created` exists)
- Error summary — comma-separated list of error types with counts (`webrtc-fail×3, stall×1`) or "no errors"

**Session timeline** — a single flat chronological table. Every event is a row. Columns:
- **Time** — smart relative formatting (`+450ms`, `+12.4s`, `+1m 23s`). Tabular figures so column aligns. Left border colored by slot.
- **Who** — colored slot badge (`P1`, `P2`, etc.) or blank for unattributed events. Each slot has a stable color that's also used for row background tinting, so you can visually follow a single participant's events down the timeline.
- **Event** — the event type, colored green for stages, yellow for lifecycle events, red for errors, gray for other.
- **Detail** — the event's `message` field plus a dim inline preview of its `meta` fields (`bytes=2048 peer_slot=1`). `match_id` is filtered out of meta since it's redundant with the session context.

Error rows have a darker red background. Lifecycle rows (`peer_left`, `peer_reconnected`) get neutral-yellow styling to distinguish them from both stages and errors.

**Why a timeline and not a checklist:** the checklist attempted to summarize the session into categorical cells ("reached" / "failed" / "N/A"), but every new edge case (solo host, graceful leave, reconnect, late join) required a new rule. The timeline doesn't abstract — it shows the raw narrative in order. A peer that joined, left, rejoined, and left again produces four rows, no rules needed. The operator can scan the timeline and understand what happened without the view having to decide for them.

**Designed as an extension point.** The renderer takes a flat chronological list and dispatches per event type. Adding a new row type (screenshots at their frame position, feedback submissions at their submit time, sync log entries, etc.) is a matter of giving the new item a timestamp and a renderer branch. See `memory/project_session_timeline_vision.md` for the long-term direction.

### Session detail viewer — chronological event timeline

Below the funnel checklist, a second panel lists every event (stage + error + lifecycle) for the session in chronological order with smart relative timestamps. Error rows are highlighted red. The slot column attributes `peer_left`/`peer_reconnected` to the affected peer (via `meta.peer_slot`) rather than to the host that emitted them. This gives the operator the full narrative without having to mentally reconstruct it from the JSON dump below.

**Timestamp formatting** (applies to both the checklist and the timeline):

| Elapsed | Format |
|---|---|
| < 1 second | `+450ms` |
| < 1 minute | `+12.4s` |
| ≥ 1 minute | `+1m 23s` or `+5m` |

This is the `formatRelTime` helper in admin.js. It replaces the original `T+12,400ms` format that was technically correct but unreadable at a glance.

### Feedback → session link

Feedback rows that include `context.roomCode` now render the room code as a link. Clicking the link switches to the Session Logs tab, populates the search box with the room code, and reloads. One click from "user reported a bug" to "here's their session's funnel."

### Input audit link (bundled)

Each session log row's header has an "input audit" link that fetches `/admin/api/input-audit/{match_id}` and displays the raw JSON in the existing viewer. Spec originally said "new tab" but that endpoint requires the `x-admin-key` header and has no query-param auth path, so it's rendered inline instead — same UX, more secure.

### Removed

The aggregate `/admin/api/funnel` endpoint and the Funnel tab that were built in the first pass of implementation have been removed. They answered a question (aggregate drop-off rates over time) that is not the operator's actual question (what happened to *this specific user*).

## Failure handling

- **`KNEvent` POST fails**: silently swallowed by the existing helper. Telemetry never breaks user flow.
- **Allowlist rejection**: should not happen since all 7 types are added in the same PR; if it does, server returns 400 and KNEvent swallows it.
- **Duplicate emission**: most events are naturally one-shot due to where they fire. `milestone_reached` requires an explicit per-session gating flag (`_milestone1800Sent`).
- **Out-of-order events**: the funnel SQL uses `created_at` ordering and `LEFT JOIN`s, so an out-of-order event simply doesn't count toward the funnel — it does not corrupt it.
- **Network failures during room creation** (the very first event): if `room_created` fails to POST, that user is invisible to the funnel. This is acceptable for v1; can be addressed via local buffering in a later iteration.

## Privacy

- **No player names** in event payloads. Slot index is sufficient for the funnel.
- **No ROM hashes**. The `rom_loaded` event captures bytes and method only.
- **Room codes and match IDs** are already logged in `session_logs` and `client_events`. No new PII surface.

## Success criteria

This work is done when:

1. All 9 event types are in the `_VALID_EVENT_TYPES` allowlist
2. All 9 emission sites are wired and verified to fire (manual playthrough produces stage rows in `client_events` for solo sessions, and lifecycle rows when peers join/leave/reconnect)
3. The session detail viewer, when opened for a completed session, shows the session header summary (duration, participant badges, error summary) and a chronological timeline with every event as a row
4. Searching the Session Logs tab by room code, player name, or match ID returns the matching session
5. Clicking the room code on a feedback row navigates to the Session Logs tab with that room pre-filtered
6. Opening the viewer for a session that failed mid-funnel shows the failure narratively — the error events appear as red rows in the timeline at the right timestamp, adjacent to the stages around them
7. The input audit link on a session log row opens the existing endpoint's JSON in the viewer
8. Multi-peer sessions visually distinguish participants via slot colorization (badge + row tint) so the operator can follow one peer's events down the timeline

## Non-goals

- Aggregate dashboards of any kind
- Charts, sankey diagrams, visualizations beyond a plain HTML checklist + table
- Real-time updates
- Cohort analysis
- Anomaly detection or alerting
- Dashboards for non-funnel data (OG card stats, feedback breakdown, etc.)

## Open questions

None at design time. All clarifying questions resolved during brainstorming on 2026-04-07.

## Estimated cost

Original estimate ~1 hour. Actual cost ~2 hours including the mid-implementation pivot from aggregate to session-centric view.

## Appendix: session-timeline SQL

The `/admin/api/session-timeline?match_id=X&room=Y` endpoint runs:

```sql
SELECT id, type, message, meta, room, slot, created_at
FROM client_events
WHERE json_extract(meta, '$.match_id') = :match_id
   OR room = :room
ORDER BY created_at ASC, id ASC
LIMIT 500
```

The `OR` unions pre-game events (keyed only by `room`) with in-game events (keyed by `match_id` in the meta JSON). Either parameter alone is sufficient. 500 rows is more than enough for a single session — most sessions produce <50 events.
