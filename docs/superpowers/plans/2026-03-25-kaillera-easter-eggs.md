# Kaillera Easter Eggs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nostalgic Kaillera references throughout kaillera-next — port 27888, connection type labels, classic messages, credits, and view-source Easter eggs.

**Architecture:** Scattered string/config changes across existing files. No new files, no new abstractions. Each task is an independent set of edits that can be committed separately.

**Tech Stack:** Python (FastAPI/uvicorn), HTML, JavaScript, Docker

**Spec:** `docs/superpowers/specs/2026-03-25-kaillera-easter-eggs-design.md`

---

## Chunk 1: Infrastructure & Server

### Task 1: Port 27888 — Server & Docker

**Files:**
- Modify: `server/src/main.py:1-12,91-95`
- Modify: `Dockerfile:25,27-28`

- [ ] **Step 1: Update main.py module docstring**

Change the docstring at top of `server/src/main.py`:

```python
"""
kaillera-next server entry point — V1 (browser-based EmulatorJS netplay).

Starts a single HTTP server on :27888 (the original Kaillera port) that handles:
  - Socket.IO signaling  (/socket.io/)
  - REST API             (/health, /list, /room)
  - Static web frontend  (/ → web/index.html, /static/roms/)

V2 will re-add TCP :45000 + UDP :45000 for Mupen64Plus native netplay.

Entry point: kaillera-server  (see pyproject.toml)
"""
```

- [ ] **Step 2: Update port and log messages in main.py**

In `server/src/main.py`, replace the log line and port:

```python
    log.info("kaillera-next · continuing the legacy of Kaillera by Christophe Thibault")
    log.info("Listening on :27888 — the original Kaillera port (loop=%s)", loop_setting)
    uvicorn.run(
        socket_app,
        host="0.0.0.0",
        port=27888,
```

- [ ] **Step 3: Update Dockerfile**

In `Dockerfile`, change line 25 and line 28:

```dockerfile
EXPOSE 27888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:27888/health')"
```

- [ ] **Step 4: Verify server starts on 27888**

Run: `cd /Users/kazon/kaillera-next/server && python -c "from src.main import run; run()" &`
Expected: Log output shows `Listening on :27888` and `continuing the legacy of Kaillera`
Then kill the server.

- [ ] **Step 5: Commit**

```bash
git add server/src/main.py Dockerfile
git commit -m "feat: change default port to 27888 (original Kaillera port)"
```

### Task 2: Port 27888 — Documentation

**Files:**
- Modify: `README.md:35,37,50,69`
- Modify: `CLAUDE.md:37`

- [ ] **Step 1: Update README.md**

Replace all four occurrences of port 8000:

Line 35: `# Run (serves both API and web frontend on :27888)`
Line 37: `# → http://localhost:27888`
Line 50: `docker run -p 27888:27888 -e ALLOWED_ORIGIN="https://yourdomain.com" kaillera-next`
Line 69: `│ :27888               │`

- [ ] **Step 2: Update CLAUDE.md**

Line 37: `HTTP/WS :27888`

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update port references from 8000 to 27888"
```

### Task 3: Port 27888 — Test Files

**Files:**
- Modify: `tests/conftest.py:10`
- Modify: `tests/test_input_resend.py:6,13`
- Modify: `tests/test_pause_reconnect.py:5,30,34,36`
- Modify: `tests/test_virtual_gamepad.py:12`
- Modify: `tests/scan_rdram.py:8,16`
- Modify: `tests/scan_rdram_visual.py:22`

- [ ] **Step 1: Update all test file port references**

Replace every `8000` with `27888` in these files:

`tests/conftest.py` line 10:
```python
SERVER_URL = "http://localhost:27888"
```

`tests/test_input_resend.py` line 6:
```
Expects the dev server to be running on localhost:27888.
```
Line 13:
```python
SERVER_URL = "http://localhost:27888"
```

`tests/test_pause_reconnect.py` line 5:
```
Requires: dev server running at localhost:27888, ROM file at ROM_PATH.
```
Line 30:
```python
    url = "http://localhost:27888"
```
Lines 34, 36: replace `localhost:8000` with `localhost:27888`

`tests/test_virtual_gamepad.py` line 12:
```python
SERVER = "http://localhost:27888"
```

`tests/scan_rdram.py` line 8:
```
Requires: dev server running at localhost:27888, ROM file available.
```
Line 16:
```python
SERVER = "http://localhost:27888"
```

`tests/scan_rdram_visual.py` line 22:
```python
SERVER = "http://localhost:27888"
```

- [ ] **Step 2: Commit**

```bash
git add tests/
git commit -m "test: update port references from 8000 to 27888"
```

---

## Chunk 2: HTML Easter Eggs

### Task 4: Lobby Credits & v0.9

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add HTML comments and footer to index.html**

Replace the entire `web/index.html` content:

```html
<!DOCTYPE html>
<!-- kaillera-next: continuing the legacy of Kaillera (2001) by Christophe Thibault -->
<!-- v0.9 forever -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>kaillera-next</title>
  <link rel="stylesheet" href="/static/lobby.css">
</head>
<body>
  <div class="lobby-card">
    <h1 title="v0.9 forever">kaillera-next</h1>
    <input id="player-name" placeholder="Your name" autocomplete="off">
    <button id="create-btn">Create Room</button>
    <div class="divider">or join a game</div>
    <div class="join-row">
      <input id="room-code" placeholder="Room code or invite link" autocomplete="off">
      <button id="join-btn">Join</button>
      <button id="watch-btn">Watch</button>
    </div>
  </div>
  <p style="font-size:12px;color:#888;margin-top:16px;text-align:center;">Inspired by Kaillera by Christophe Thibault</p>
  <script src="/static/lobby.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify in browser**

Open `http://localhost:27888/` — confirm:
- Footer text "Inspired by Kaillera by Christophe Thibault" visible below lobby card
- Hovering over "kaillera-next" title shows "v0.9 forever" tooltip
- View source shows both HTML comments

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat: add Kaillera credits and v0.9 Easter eggs to lobby"
```

### Task 5: Play Page Easter Eggs

**Files:**
- Modify: `web/play.html:1-2,133`

- [ ] **Step 1: Add HTML comment to play.html**

After line 1 (`<!DOCTYPE html>`), add:
```html
<!-- Netplay powered by the spirit of EmuLinker and SupraClient -->
```

- [ ] **Step 2: Change guest-status text**

Change line 133 from:
```html
      <p id="guest-status" style="display:none">Waiting for host to start...</p>
```
to:
```html
      <p id="guest-status" style="display:none">Waiting for players...</p>
```

- [ ] **Step 3: Commit**

```bash
git add web/play.html
git commit -m "feat: add EmuLinker/SupraClient comment and classic waiting message"
```

---

## Chunk 3: JavaScript Changes

### Task 6: Frame Delay Connection Type Labels

**Files:**
- Modify: `web/static/play.js:2815-2823`

- [ ] **Step 1: Rewrite showEffectiveDelay**

Replace the `showEffectiveDelay` function in `web/static/play.js` (lines 2815–2823):

```javascript
  const KAILLERA_LABELS = ['LAN', 'Excellent', 'Excellent', 'Good', 'Good', 'Average', 'Average', 'Low', 'Bad', 'Bad'];

  const showEffectiveDelay = (own, room) => {
    const el = document.getElementById('delay-effective');
    if (!el) return;
    const label = KAILLERA_LABELS[room] ?? '';
    if (room > own) {
      el.textContent = `(room: ${room} — ${label})`;
    } else {
      el.textContent = label ? `(${label})` : '';
    }
  };
```

- [ ] **Step 2: Verify labels display**

Open play page, create a room, check the delay picker area. When frame delay is set:
- Delay 0 → shows `(LAN)`
- Delay 3 → shows `(Good)`
- Delay 8 → shows `(Bad)`

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat: show Kaillera connection type labels on frame delay"
```

### Task 7: Console Easter Egg & Invite Share Text

**Files:**
- Modify: `web/static/play.js:2248,2837,2871-2874,2878-2881`

- [ ] **Step 1: Add console.log at top of DOMContentLoaded**

In `web/static/play.js`, at the very top of the `DOMContentLoaded` handler (after line 2837 `document.addEventListener('DOMContentLoaded', () => {`), add:

```javascript
    console.log('kaillera-next — v0.9 forever');
```

- [ ] **Step 2: Update copyLink() share text**

In `copyLink()` (line 2248), change the URL variable usage. Replace:
```javascript
  const copyLink = () => {
    const url = `${window.location.origin}/play.html?room=${roomCode}`;
    // navigator.clipboard requires HTTPS; use execCommand fallback for HTTP
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied!');
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
```

With:
```javascript
  const copyLink = () => {
    const url = `${window.location.origin}/play.html?room=${roomCode}`;
    const shareText = `Join my kaillera-next room: ${url}`;
    // navigator.clipboard requires HTTPS; use execCommand fallback for HTTP
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(shareText).then(() => {
        showToast('Link copied!');
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = shareText;
```

- [ ] **Step 3: Update share-play click handler**

In the `share-play` handler (line 2872), change:
```javascript
    if (sharePlay) sharePlay.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}`;
      copyToClipboard(url, 'Play link');
```
to:
```javascript
    if (sharePlay) sharePlay.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}`;
      copyToClipboard(`Join my kaillera-next room: ${url}`, 'Play link');
```

- [ ] **Step 4: Update share-watch click handler**

In the `share-watch` handler (line 2879), change:
```javascript
    if (shareWatch) shareWatch.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}&spectate=1`;
      copyToClipboard(url, 'Watch link');
```
to:
```javascript
    if (shareWatch) shareWatch.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}&spectate=1`;
      copyToClipboard(`Watch my kaillera-next room: ${url}`, 'Watch link');
```

- [ ] **Step 5: Verify**

- Open play page, check browser dev console for "kaillera-next — v0.9 forever"
- Click Copy Link, paste — should show "Join my kaillera-next room: ..."
- In-game, Copy Play Link → "Join my kaillera-next room: ..."
- In-game, Copy Watch Link → "Watch my kaillera-next room: ..."

- [ ] **Step 6: Commit**

```bash
git add web/static/play.js
git commit -m "feat: add v0.9 console log and Kaillera-style invite share text"
```

### Task 8: Classic Lockstep Messages

**Files:**
- Modify: `web/static/netplay-lockstep.js:939,958,965`

- [ ] **Step 1: Update connection state messages**

In `web/static/netplay-lockstep.js`, inside `onconnectionstatechange`:

Line 939 — change:
```javascript
      if (s === 'connecting') setStatus('Connecting...');
```
to:
```javascript
      if (s === 'connecting') setStatus('Connecting to players...');
```

Line 958 — change:
```javascript
        setStatus('Peer connection failed');
```
to:
```javascript
        setStatus('Player dropped — connection failed');
```

Line 965 — change:
```javascript
          setStatus('Peer connection unstable...');
```
to:
```javascript
          setStatus('Player connection unstable...');
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: use Kaillera-style connection status messages"
```
