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

### 1. Port 27886

The original Kaillera default port replaces the current port 8000.

**Files:**
- `server/src/main.py` — change `port=8000` to `port=27886`, update log message to: `"Listening on :27886 — the original Kaillera port"`
- `Dockerfile` — `EXPOSE 27886` instead of `EXPOSE 8000`

**Startup log addition** (console only, in main.py):
```
kaillera-next · continuing the legacy of Kaillera by Christophe Thibault
```

### 2. Lobby Credits & v0.9

**File: `web/index.html`**
- HTML comment near top: `<!-- kaillera-next: continuing the legacy of Kaillera (2001) by Christophe Thibault -->`
- HTML comment: `<!-- v0.9 forever -->`
- `<h1>` title attribute: `title="v0.9 forever"`
- Footer below lobby card: `Inspired by Kaillera by Christophe Thibault`

### 3. "Waiting for players..."

**File: `web/play.html`**
- When the room is waiting for others to join, show `"Waiting for players..."` as status text in the player list area

### 4. Frame Delay Connection Type Labels

**File: `web/static/play.js`**

The `#delay-effective` span shows the Kaillera connection type label alongside the numeric delay:

| Delay | Label | Display |
|---|---|---|
| 0 | LAN | `0 frames — LAN` |
| 1 | Excellent | `1 frame — Excellent` |
| 2 | Excellent | `2 frames — Excellent` |
| 3 | Good | `3 frames — Good` |
| 4 | Good | `4 frames — Good` |
| 5 | Average | `5 frames — Average` |
| 6 | Average | `6 frames — Average` |
| 7 | Low | `7 frames — Low` |
| 8 | Bad | `8 frames — Bad` |
| 9 | Bad | `9 frames — Bad` |

Format when Auto mode picks: `Auto: 3 frames — Good`
Format when manual: `3 frames — Good`

### 5. Classic Lockstep Messages

**File: `web/static/netplay-lockstep.js`**

| Current Message | Kaillera-style Replacement |
|---|---|
| `"Peer connection lost"` | `"Player dropped"` |
| `"Peer connection failed"` | `"Connection rejected"` |
| `"Connecting..."` (when awaiting peers) | `"Waiting for players..."` |

`"Connected -- game on!"` stays as-is — already has the right energy.

### 6. View-Source Easter Eggs

**File: `web/play.html`**
- HTML comment: `<!-- Netplay powered by the spirit of EmuLinker and SupraClient -->`

**File: `web/static/play.js`**
- `console.log("kaillera-next — v0.9 forever")` on page load

### 7. Invite Share Text

**File: `web/play.html` or `web/static/play.js`** (wherever the copy/share button lives)
- When copying invite link, prefix share text: `"Join my kaillera-next room: <URL>"`

## Out of Scope

- Chat system and `/me` actions (V1 has no chat)
- About/credits page (no such page exists yet)
- Server-side error string changes (clients parse these)
- Streaming mode message changes (already feel right)
- Anti3D room name references (not user-visible)
- `kaillera://` protocol scheme (invite links work fine as HTTP URLs)

## Testing

- Verify server starts on port 27886
- Verify Dockerfile exposes 27886
- Verify frame delay labels appear correctly for all 10 values (0–9)
- Verify classic messages appear in lockstep mode
- Verify lobby footer and HTML comments are present
- Verify console.log fires on play page load
- Verify invite link copy includes prefix text
