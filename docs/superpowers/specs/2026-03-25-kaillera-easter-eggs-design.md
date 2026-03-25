# Kaillera Easter Eggs Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Nostalgic Kaillera references scattered throughout the project

## Overview

Add Easter eggs and nostalgic touches referencing the original Kaillera netplay system (2001, by Christophe Thibault) throughout kaillera-next. These range from user-visible UI changes to view-source-only HTML comments. The goal is to delight Kaillera veterans without compromising functionality.

## Decisions

- **Approach:** Scattered integration — changes go directly into existing files, no new constants file
- **Chat /me actions:** Deferred to when chat ships (no chat in V1)
- **Server-side error strings:** Left as-is (clients may parse them)
- **Streaming mode messages:** Left as-is (already feel right)
- **Desync wording:** Already uses "desync" — the classic Kaillera term

## Changes

### 1. Port 27888

The original Kaillera default port replaces the current port 8000.

**Files to update (all occurrences of port 8000):**
- `server/src/main.py` — change `port=8000` to `port=27888` in `uvicorn.run()`, update module docstring, update log message to: `"Listening on :27888 — the original Kaillera port"`
- `Dockerfile` line 25 — `EXPOSE 27888` instead of `EXPOSE 8000`
- `Dockerfile` line 28 — HEALTHCHECK URL from `localhost:8000` to `localhost:27888`
- `README.md` — all references to port 8000 (lines 35, 37, 50, 69)
- `CLAUDE.md` — architecture diagram `HTTP/WS :8000` → `HTTP/WS :27888`
- `tests/conftest.py` line 10 — `SERVER_URL = "http://localhost:27888"`
- `tests/test_input_resend.py` — port references
- `tests/test_pause_reconnect.py` — port references
- `tests/test_virtual_gamepad.py` — port reference
- `tests/scan_rdram.py` — port references
- `tests/scan_rdram_visual.py` — port reference

**Startup log addition** (console only, in main.py):
```
kaillera-next · continuing the legacy of Kaillera by Christophe Thibault
```

### 2. Lobby Credits & v0.9

**File: `web/index.html`**
- HTML comment near top: `<!-- kaillera-next: continuing the legacy of Kaillera (2001) by Christophe Thibault -->`
- HTML comment: `<!-- v0.9 forever -->`
- `<h1>` title attribute: `title="v0.9 forever"`
- Footer below `.lobby-card`: small muted text, centered — `Inspired by Kaillera by Christophe Thibault`
  - Styling: `font-size: 12px; color: #888; margin-top: 16px; text-align: center;`

### 3. "Waiting for players..."

**File: `web/play.html`** — the `#guest-status` element (line 133)

Currently reads `"Waiting for host to start..."`. Change to `"Waiting for players..."` — the classic Kaillera lobby message. This is visible to guests before the host starts the game. The host sees the Start button instead, so no conflict.

### 4. Frame Delay Connection Type Labels

**File: `web/static/play.js`** — `showEffectiveDelay()` function (line 2807)

Rewrite `showEffectiveDelay` to always display the Kaillera label for the effective (room) delay, not just when room > own. The label maps delay values to classic Kaillera connection types:

| Delay | Label |
|---|---|
| 0 | LAN |
| 1–2 | Excellent |
| 3–4 | Good |
| 5–6 | Average |
| 7 | Low |
| 8–9 | Bad |

The `#delay-effective` span always shows the label based on the room's effective delay:
- Normal: `(Good)` — just the Kaillera label in parens
- When room delay > own delay: `(room: 4 — Good)` — keeps the existing "room overrides you" info

The caller in `netplay-lockstep.js` (line ~1838) passes `(own, room)` — no signature change needed since we always use the `room` value for the label.

### 5. Classic Lockstep Messages

**File: `web/static/netplay-lockstep.js`**

| Current Message | Kaillera-style Replacement | Location |
|---|---|---|
| `"Peer connection failed"` (line 937) | `"Player dropped — connection failed"` | `onconnectionstatechange`, state `'failed'` |
| `"Peer connection unstable..."` (line 944) | `"Player connection unstable..."` | `onconnectionstatechange`, state `'disconnected'` |
| `"Connecting..."` (line 918) | `"Connecting to players..."` | `onconnectionstatechange`, state `'connecting'` |

`"Connected -- game on!"` (line 925) stays as-is.

Note: "Peer connection lost" was not found in the actual code — the `'disconnected'` state shows "Peer connection unstable..." which becomes "Player connection unstable...". The `'failed'` state leads to `handlePeerDisconnect` which removes the peer.

### 6. View-Source Easter Eggs

**File: `web/play.html`**
- HTML comment near top: `<!-- Netplay powered by the spirit of EmuLinker and SupraClient -->`

**File: `web/static/play.js`**
- At top of `DOMContentLoaded` handler (line 2821): `console.log('kaillera-next — v0.9 forever');`

### 7. Invite Share Text

**File: `web/static/play.js`** — three copy locations:

1. `copyLink()` (line 2240) — pre-game "Copy Link" button
   - Change copied text from raw URL to: `"Join my kaillera-next room: <URL>"`
2. `share-play` click handler (line 2864) — in-game "Copy Play Link"
   - Change copied text to: `"Join my kaillera-next room: <URL>"`
3. `share-watch` click handler (line 2870) — in-game "Copy Watch Link"
   - Change copied text to: `"Watch my kaillera-next room: <URL>"`

## Out of Scope

- Chat system and `/me` actions (V1 has no chat)
- About/credits page (no such page exists yet)
- Server-side error string changes (clients parse these)
- Streaming mode message changes (already feel right)
- Anti3D room name references (not user-visible)
- `kaillera://` protocol scheme (invite links work fine as HTTP URLs)

## Testing

- Verify server starts on port 27888
- Verify Dockerfile exposes 27888 and HEALTHCHECK hits 27888
- Verify all test files reference port 27888
- Verify frame delay labels appear correctly for all 10 values (0–9)
- Verify classic messages appear in lockstep mode connection state changes
- Verify lobby footer and HTML comments are present
- Verify `#guest-status` reads "Waiting for players..."
- Verify console.log fires on play page load
- Verify all three copy functions include prefix text
