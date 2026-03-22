# Resync Fix + In-Game Invite Links — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix resync failure after player disconnect, add in-game share button with play/spectate links, and auto-spectate when joining a full room.

**Architecture:** Three independent changes touching only client-side code. The resync fix is a ~7-line addition to the lockstep tick loop. The share button adds a toolbar dropdown with clipboard copy. The room-full behavior intercepts the existing join flow to auto-spectate with a banner.

**Tech Stack:** Vanilla JS, HTML, CSS (no frameworks — matches existing codebase)

**Spec:** `docs/superpowers/specs/2026-03-22-resync-fix-invite-links-design.md`

---

## Chunk 1: Resync Bug Fix

### Task 1: Zero disconnected player slots in the tick loop

**Files:**
- Modify: `web/static/netplay-lockstep.js:1644` (after inputPeers write loop, before `_remoteApplied++`)

- [ ] **Step 1: Add slot-zeroing code after the inputPeers write loop**

In `web/static/netplay-lockstep.js`, inside `tick()`, after line 1644 (the end of the `for (var m = 0; m < inputPeers.length; m++)` loop) and before line 1645 (`_remoteApplied++`), insert:

```javascript
      // Zero disconnected player slots so loadState() can't restore stale input
      for (var zs = 0; zs < 4; zs++) {
        if (zs === _playerSlot) continue;
        var hasInputPeer = false;
        for (var zi = 0; zi < inputPeers.length; zi++) {
          if (inputPeers[zi].slot === zs) { hasInputPeer = true; break; }
        }
        if (!hasInputPeer) writeInputToMemory(zs, 0);
      }
```

This runs inside the existing `if (applyFrame >= 0)` block, so it only executes once inputs are being applied. Variable names `zs`/`zi` avoid shadowing the outer loop variables `m`/`j`.

- [ ] **Step 2: Verify the insertion point is correct**

Read `web/static/netplay-lockstep.js` lines 1636-1650 to confirm the new code sits between the inputPeers loop and `_remoteApplied++`.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: zero disconnected player slots every tick to prevent resync failure"
```

---

## Chunk 2: In-Game Share Button

### Task 2: Add share button and dropdown to play.html

**Files:**
- Modify: `web/play.html:131-132` (toolbar section, after `.toolbar-spacer`, before `#toolbar-info`)

- [ ] **Step 1: Add share button and dropdown container to the toolbar**

In `web/play.html`, between the `<div class="toolbar-spacer"></div>` (line 131) and the `<button id="toolbar-info"` (line 132), insert:

```html
    <div id="share-wrapper" style="position:relative">
      <button id="toolbar-share" class="toolbar-toggle" title="Share invite link">Share</button>
      <div id="share-dropdown" class="share-dropdown hidden">
        <button id="share-play" class="share-option">Copy Play Link</button>
        <button id="share-watch" class="share-option">Copy Watch Link</button>
      </div>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add web/play.html
git commit -m "feat: add share button and dropdown to in-game toolbar"
```

### Task 3: Add share dropdown CSS

**Files:**
- Modify: `web/static/play.css` (append after toolbar-toggle styles, around line 331)

- [ ] **Step 1: Add share dropdown styles**

In `web/static/play.css`, after line 332 (`#toolbar-end:hover { background: #a44a4a; }`), add:

```css
/* Share dropdown */
#share-wrapper { position: relative; }
.share-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 6px;
  background: #1a1a2e;
  border: 1px solid #2a2a40;
  border-radius: 8px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 170px;
  z-index: 55;
}
.share-dropdown.hidden { display: none; }
.share-option {
  padding: 8px 12px !important;
  font-size: 12px !important;
  min-height: 32px !important;
  background: transparent !important;
  text-align: left;
  border-radius: 6px;
  white-space: nowrap;
}
.share-option:hover { background: #2a2a40 !important; }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.css
git commit -m "style: share dropdown positioning and appearance"
```

### Task 4: Add share button JS logic

**Files:**
- Modify: `web/static/play.js` (add share functions and wire up event listeners)

- [ ] **Step 1: Add share dropdown functions**

In `web/static/play.js`, after the `copyLink()` function (after line 1541), add:

```javascript
  // ── UI: In-Game Share Dropdown ──────────────────────────────────────

  function copyToClipboard(text, label) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(label + ' copied!');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(label + ' copied!');
    }
  }

  function toggleShareDropdown() {
    var dd = document.getElementById('share-dropdown');
    var btn = document.getElementById('toolbar-share');
    if (!dd) return;
    var isOpen = !dd.classList.contains('hidden');
    if (isOpen) {
      dd.classList.add('hidden');
      if (btn) btn.classList.remove('active');
    } else {
      dd.classList.remove('hidden');
      if (btn) btn.classList.add('active');
    }
  }

  function closeShareDropdown() {
    var dd = document.getElementById('share-dropdown');
    var btn = document.getElementById('toolbar-share');
    if (dd) dd.classList.add('hidden');
    if (btn) btn.classList.remove('active');
  }
```

- [ ] **Step 2: Wire up share button event listeners in DOMContentLoaded**

In `web/static/play.js`, after the `toolbarInfo` click listener (after line 2041), add:

```javascript
    var toolbarShare = document.getElementById('toolbar-share');
    if (toolbarShare) toolbarShare.addEventListener('click', toggleShareDropdown);

    var sharePlay = document.getElementById('share-play');
    if (sharePlay) sharePlay.addEventListener('click', function () {
      var url = window.location.origin + '/play.html?room=' + roomCode;
      copyToClipboard(url, 'Play link');
      closeShareDropdown();
    });

    var shareWatch = document.getElementById('share-watch');
    if (shareWatch) shareWatch.addEventListener('click', function () {
      var url = window.location.origin + '/play.html?room=' + roomCode + '&spectate=1';
      copyToClipboard(url, 'Watch link');
      closeShareDropdown();
    });

    // Close share dropdown on outside click or Escape
    document.addEventListener('click', function (e) {
      var wrapper = document.getElementById('share-wrapper');
      if (wrapper && !wrapper.contains(e.target)) closeShareDropdown();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeShareDropdown();
    });
```

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat: share dropdown with play and watch link copy"
```

### Task 5: Write E2E test for share button

**Files:**
- Modify: `tests/test_e2e.py` (add test after existing toolbar tests)

- [ ] **Step 1: Add share button E2E test**

In `tests/test_e2e.py`, after the last test function, add:

```python
def test_share_dropdown_copies_links(browser, server_url):
    """In-game share button shows dropdown with play and watch links."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SHR01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=SHR01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Share button exists
        expect(host.locator("#toolbar-share")).to_be_visible()

        # Dropdown initially hidden
        expect(host.locator("#share-dropdown")).to_be_hidden()

        # Click opens dropdown
        host.click("#toolbar-share")
        expect(host.locator("#share-dropdown")).to_be_visible(timeout=2000)
        expect(host.locator("#share-play")).to_be_visible()
        expect(host.locator("#share-watch")).to_be_visible()

        # Click share-play copies and closes dropdown
        host.click("#share-play")
        expect(host.locator("#share-dropdown")).to_be_hidden(timeout=2000)
    finally:
        host.close()
        guest.close()
```

- [ ] **Step 2: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test: E2E test for in-game share dropdown"
```

---

## Chunk 3: Auto-Spectate on Full Room

### Task 6: Add banner CSS

**Files:**
- Modify: `web/static/play.css` (append after share dropdown styles)

- [ ] **Step 1: Add room-full banner styles**

In `web/static/play.css`, after the share dropdown styles, add:

```css
/* Room-full banner */
.room-full-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 250;
  background: rgba(42, 42, 64, 0.95);
  color: #ccc;
  font-size: 13px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  animation: bannerSlideIn 0.3s ease;
}
.room-full-banner .banner-close {
  background: transparent !important;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px !important;
  min-height: auto !important;
  line-height: 1;
}
.room-full-banner .banner-close:hover { color: #eee; }
@keyframes bannerSlideIn {
  from { transform: translateY(-100%); }
  to { transform: translateY(0); }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.css
git commit -m "style: room-full banner appearance and animation"
```

### Task 7: Add auto-spectate logic in play.js

**Files:**
- Modify: `web/static/play.js:100-118` (non-host join flow)

- [ ] **Step 1: Add showRoomFullBanner helper**

In `web/static/play.js`, after the `showError` function (after line 1519), add:

```javascript
  function showRoomFullBanner() {
    var banner = document.createElement('div');
    banner.className = 'room-full-banner';
    banner.innerHTML = '<span>Game is full \u2014 you\u2019ve joined as a spectator</span>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'banner-close';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = function () { banner.remove(); };
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
    setTimeout(function () { if (banner.parentNode) banner.remove(); }, 5000);
  }
```

- [ ] **Step 2: Add auto-spectate on REST check (room full before join-room)**

In `web/static/play.js`, in the non-host join flow, after `var roomData = JSON.parse(xhr.responseText);` (line 108) and before the `socket.emit('join-room', ...` (line 110), insert:

```javascript
        // Room full: auto-join as spectator with banner
        if (!isSpectator && roomData.player_count >= roomData.max_players) {
          isSpectator = true;
        }
```

This silently switches to spectator mode before emitting `join-room`. The banner gets shown after the join succeeds (see step 3).

- [ ] **Step 3: Track whether auto-spectated and show banner after join**

Add a variable near the top state block (after line 41, after `_currentInputType`):

```javascript
  var _autoSpectated = false;       // true if we auto-joined as spectator due to full room
```

Update the room-full check from step 2 to also set the flag:

```javascript
        if (!isSpectator && roomData.player_count >= roomData.max_players) {
          isSpectator = true;
          _autoSpectated = true;
        }
```

Then, inside the `join-room` callback success path (after `mySlot = null;` on line 129, inside the `else if (isSpectator)` block), add:

```javascript
            if (_autoSpectated) showRoomFullBanner();
```

- [ ] **Step 4: Handle race condition — join-room returns "Room is full"**

In `web/static/play.js`, replace the error handler at line 118:

```javascript
          if (err) { showError('Failed to join: ' + err); return; }
```

with:

```javascript
          if (err) {
            // Room filled between REST check and join — auto-spectate
            if (err === 'Room is full') {
              isSpectator = true;
              _autoSpectated = true;
              socket.emit('join-room', {
                extra: {
                  sessionid: roomCode,
                  userid: socket.id,
                  player_name: playerName,
                  spectate: true,
                },
              }, function (err2, joinData2) {
                if (err2) { showError('Failed to join: ' + err2); return; }
                mySlot = null;
                if (joinData2) lastUsersData = joinData2;
                showRoomFullBanner();
                // Always show overlay — the game-started socket event
                // handler already transitions spectators into the game
                showOverlay();
              });
              return;
            }
            showError('Failed to join: ' + err);
            return;
          }
```

- [ ] **Step 5: Commit**

```bash
git add web/static/play.js web/static/play.css
git commit -m "feat: auto-spectate with banner when joining full room"
```

### Task 8: Write E2E test for auto-spectate on full room

**Files:**
- Modify: `tests/test_e2e.py`

- [ ] **Step 1: Add auto-spectate E2E test**

In `tests/test_e2e.py`, add:

```python
def test_auto_spectate_when_room_full(browser, server_url):
    """Joining a full room auto-spectates with a banner."""
    host = browser.new_page()
    p2 = browser.new_page()
    p3 = browser.new_page()
    p4 = browser.new_page()
    joiner = browser.new_page()

    try:
        # Fill room to 4 players
        host.goto(f"{server_url}/play.html?room=FULL01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        p2.goto(f"{server_url}/play.html?room=FULL01&name=P2")
        expect(p2.locator("#overlay")).to_be_visible(timeout=10000)

        p3.goto(f"{server_url}/play.html?room=FULL01&name=P3")
        expect(p3.locator("#overlay")).to_be_visible(timeout=10000)

        p4.goto(f"{server_url}/play.html?room=FULL01&name=P4")
        expect(p4.locator("#overlay")).to_be_visible(timeout=10000)

        # 5th player joins via play link (no spectate param)
        joiner.goto(f"{server_url}/play.html?room=FULL01&name=Late")
        # Should auto-spectate — overlay visible, banner appears
        expect(joiner.locator("#overlay")).to_be_visible(timeout=10000)
        expect(joiner.locator(".room-full-banner")).to_be_visible(timeout=5000)

        # Banner auto-dismisses
        expect(joiner.locator(".room-full-banner")).to_be_hidden(timeout=7000)
    finally:
        host.close()
        p2.close()
        p3.close()
        p4.close()
        joiner.close()
```

- [ ] **Step 2: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test: E2E test for auto-spectate on full room"
```

---

## Summary

| Task | Files | Description |
|---|---|---|
| 1 | `netplay-lockstep.js` | Zero disconnected slots in tick loop |
| 2 | `play.html` | Share button + dropdown HTML |
| 3 | `play.css` | Share dropdown styles |
| 4 | `play.js` | Share dropdown JS logic + event wiring |
| 5 | `test_e2e.py` | Share dropdown E2E test |
| 6 | `play.css` | Room-full banner styles |
| 7 | `play.js` | Auto-spectate logic + race condition handling |
| 8 | `test_e2e.py` | Auto-spectate E2E test |
