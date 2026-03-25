# kaillera-next MVP Implementation Plan

**Goal:** Friend clicks a link, lands in lobby, game starts, they are playing.
**Date:** 2026-03-19

---

## Current State Assessment

P0 items have shipped. The product layer is in place: lobby page, invite links,
host-controlled start flow, responsive layout, and gamepad support are all done.

**What shipped:**
- Lockstep engine (netplay-lockstep.js) -- 4-player mesh, spectators, late join, desync detection
- Streaming mode (netplay-streaming.js) -- zero-desync single-emu streaming
- Python signaling server (FastAPI + Socket.IO) -- rooms, WebRTC relay, slot management
- Lobby page (index.html) with create/join room flow and invite links
- Play page (play.html) with overlay, emulator embed, toolbar, gamepad support
- P2P ROM sharing, connection status, end game / restart flow

---

## Architecture Decision: Unified Play Page

Rather than two separate JS files with duplicated UI code, the MVP has:

```
web/
  index.html            -- Landing / lobby page (create or join a room)
  play.html             -- Game page (emulator + netplay, entered from lobby)
  static/
    lobby.js            -- Lobby logic (room creation, invite links, player list)
    lobby.css           -- Lobby styles
    play.js             -- Unified play page controller (loads the right netplay engine)
    play.css            -- Play page styles (responsive, mobile-friendly)
    gamepad-manager.js  -- Profile-based gamepad detection, mapping, slot assignment
    virtual-gamepad.js  -- On-screen touch controls for mobile
    api-sandbox.js      -- Browser API interception (rAF, getGamepads) for manual frame stepping
    kn-state.js         -- Shared state module
    shared.js           -- Shared utilities (cheats, escaping)
    core-redirector.js  -- Redirect EJS core download to patched WASM
    audio-worklet-processor.js -- AudioWorklet ring buffer for lockstep audio
    netplay-lockstep.js -- Deterministic lockstep engine (4P mesh WebRTC)
    netplay-streaming.js -- Streaming engine (host video → guests via WebRTC MediaStream)
```

The key refactor: extract the `buildUI()` / room management code out of the
netplay scripts. The netplay scripts only handle WebRTC + game sync logic.
`play.js` handles the UI shell and delegates to the right engine.

---

## Phases

### P0 -- Must Have for First Friend Test

These items are the minimum needed so that a friend can click a link, land on a
page that makes sense, and start playing. Without any one of these, the friend
test fails.

#### P0.1: Lobby Page with Invite Links [done]
**Effort: M (2-3 days)**
**Dependencies: None**

Create `web/index.html` as a proper landing page and `web/play.html` as the game page.

- Landing page: big "Create Room" button, "Join Room" input, brief explanation
- Creating a room generates a short room code (already exists) and redirects to
  `/play.html?room=ABC123&host=1&mode=lockstep`
- Invite URL: `https://yoursite.com/play.html?room=ABC123`
- When a guest visits the invite URL, they land on the play page and auto-join
- Also support manual code entry on the landing page
- Show a "Copy Link" button that copies the invite URL to clipboard
- The room code should be prominently displayed for voice-call sharing

**Acceptance criteria:**
- Host creates room, gets a shareable link
- Friend opens link, lands in lobby, sees host's name
- Manual code entry also works from the landing page

#### P0.2: Host-Controlled Start Flow [done]
**Effort: M (2-3 days)**
**Dependencies: P0.1**

Replace the current auto-start-on-connection behavior with an explicit flow.

- Play page shows a lobby/waiting state before the game starts
- Host sees a player list and a "Start Game" button (disabled until at least 2 players)
- Guests see the player list and "Waiting for host to start..."
- Host selects mode (Lockstep or Streaming) via a simple toggle/dropdown -- default: Lockstep
- Host clicks Start -> all clients load the ROM and begin the netplay handshake
- Add a server-side `start-game` Socket.IO event that the host emits, server broadcasts
- Emulator only loads after start signal (saves bandwidth for guests who are still setting up)

**Acceptance criteria:**
- Game does not start until host clicks Start
- All players see each other in the player list before start
- Mode selection works (lockstep vs streaming)

#### P0.3: Refactor Netplay Scripts for MVP Integration [done]
**Effort: M (2-3 days)**
**Dependencies: P0.1, P0.2**

The current netplay scripts are self-contained IIFEs that build their own UI and
manage their own room logic. For the MVP, they need to be refactored so:

- Room management (create/join/leave, Socket.IO connection) is handled by play.js
- The netplay engine receives the socket, session ID, player slot, and peer info
  as parameters -- not from its own UI
- The `buildUI()` function and room management code is removed from each engine
- Each engine exports an `init(config)` function that play.js calls after the host
  clicks Start
- The existing WebRTC, lockstep, and streaming logic remains unchanged

This is the riskiest item because it touches working, tested code. Approach:
1. Create a thin wrapper in play.js that provides the same globals the engines expect
2. Gut the UI/room code from the engines, keep the core logic
3. Verify with the same Playwright tests

**Acceptance criteria:**
- Lockstep v4 works end-to-end through the new UI
- Streaming mode works end-to-end through the new UI
- Existing Playwright tests still pass (or are updated to match new flow)

#### P0.4: Basic Responsive Layout [done]
**Effort: S (1 day)**
**Dependencies: P0.1**

Make the play page work on mobile screens.

- Game canvas scales to fit viewport width (CSS `max-width: 100%; height: auto`)
- Lobby UI is readable and usable on a phone screen (min 320px width)
- Buttons are touch-friendly (min 44px tap targets)
- No horizontal scrolling on mobile
- Meta viewport tag already exists in index.html

**Acceptance criteria:**
- Page loads and is usable on an iPhone SE-sized screen
- Game canvas fills available width without overflow
- All buttons are tappable

#### P0.5: Minimal Gamepad Support [done]
**Effort: S (1-2 days)**
**Dependencies: P0.3**

Make USB/Bluetooth controllers work out of the box.

- Use the Gamepad API to detect connected controllers
- Map the first connected gamepad to the player's slot using a sensible default
  mapping (Xbox/PS layout -> N64: A=A, B=B, triggers=Z/L, right stick=C-buttons)
- Show a small "Controller connected" indicator in the play UI
- No mapping UI yet -- just auto-detection with sane defaults
- EmulatorJS may already handle gamepad input; verify and integrate rather than
  duplicate

**Acceptance criteria:**
- Plug in an Xbox controller, it works for basic gameplay
- Player sees that their controller was detected

---

### P1 -- Should Have (Makes the Experience Good)

These items significantly improve the experience but are not blockers for the
first friend test. A friend can play without these, but they will ask "how do I..."

#### P1.1: Touch Controls for Mobile [done]
**Effort: L (3-4 days)**
**Dependencies: P0.4**

On-screen touch controls for phones/tablets.

- Detect touch-only devices (no gamepad, no physical keyboard)
- Show a virtual N64 controller overlay: D-pad (left thumb), A/B buttons (right thumb),
  Start button (center), Z/L/R along the top, C-buttons as a small cluster
- Analog stick via a virtual joystick (touch-drag circle)
- Overlay should be semi-transparent and not obscure the game canvas
- Force landscape orientation hint on mobile (or adapt layout for portrait)
- Touch controls only inject input for the local player's slot

**Acceptance criteria:**
- A friend on their phone can play through a match using only touch
- Controls are responsive and correctly mapped
- Overlay does not cover critical game elements

#### P1.2: Controller Mapping UI [done]
**Effort: M (2-3 days)**
**Dependencies: P0.5**

Let users customize their button mappings.

- Show during the lobby/pre-start phase
- Display an N64 controller diagram with labeled buttons
- "Press the button for A" -> user presses a key or gamepad button -> saved
- Support keyboard, gamepad, and (later) touch remapping
- Persist mappings in localStorage so they survive page reloads
- Provide a "Reset to Default" option
- Pre-populate with detected input device defaults

**Acceptance criteria:**
- User can remap all N64 buttons to their preferred keys/gamepad buttons
- Mappings persist across sessions
- Works for both keyboard and gamepad

#### P1.3: In-Game Chat [cut — not needed for friend test]
**Effort: M (2 days)**
**Dependencies: P0.3**

Text chat in the lobby and during gameplay.

- Lobby chat: use Socket.IO (server relays to room) -- add a `chat-message` event
- In-game chat: use WebRTC data channels (already established) for lower latency
- UI: a collapsible chat panel at the bottom or side of the screen
- Press Enter or tap a chat icon to open, type message, press Enter to send
- Show player name + message, with timestamps
- On mobile: chat opens a text input, keyboard pushes up the chat area
- Keep it minimal -- no emoji picker, no rich text, just plain messages

**Acceptance criteria:**
- Players can chat in the lobby before game starts
- Players can chat during gameplay
- Chat works on mobile

#### P1.4: Connection Status and Error Handling [done]
**Effort: S (1-2 days)**
**Dependencies: P0.3**

Users need to know what is happening, especially when things go wrong.

- Show connection status for each peer (connecting / connected / disconnected)
- Show ping/latency indicator per peer
- Graceful error messages: "Lost connection to [player]", "Room not found",
  "Room is full"
- Auto-reconnect attempt on transient disconnects
- Loading spinner while ROM is loading and emulator is initializing
- Progress indicator for save state transfer (late join)

**Acceptance criteria:**
- User always knows the state of their connection
- Errors produce human-readable messages with suggested actions
- No silent failures

#### P1.5: End Game / Rematch Flow [done]
**Effort: S (1 day)**
**Dependencies: P0.2**

After a game ends or if the host wants to restart.

- Host gets "End Game" and "Restart" buttons during gameplay
- End Game: stops emulation, returns all players to the lobby state
- Restart: reloads the ROM / resets the emulator, starts a fresh game
- When host ends the game, guests see "Host ended the game" and return to lobby
- Players can change mode or settings between games

**Acceptance criteria:**
- Host can end a game and start a new one without anyone refreshing the page
- Mode can be changed between games

---

### P2 -- Nice to Have (Polish and Delight)

These items make the product feel polished but can be added after the first
successful friend test session.

#### P2.1: Sound and Visual Polish
**Effort: M (2-3 days)**

- Dark theme with consistent color palette
- Subtle animations (player join/leave, game start countdown)
- Sound effects for key events (player joined, game starting, chat message)
- Favicon and page title that updates ("Playing SSB64 -- kaillera-next")

#### P2.2: Spectator Mode Polish
**Effort: S (1-2 days)**

- Dedicated spectator view with larger video
- Spectator count shown in lobby
- Spectators can chat but not affect the game
- "Watch" link variant that goes straight to spectator mode

#### P2.3: Room Persistence and Rejoin
**Effort: M (2-3 days)**

- Store room ID in localStorage so refreshing the page re-joins
- Handle browser back button gracefully
- Room survives brief host disconnects (30-second grace period)

#### P2.4: Multiple ROM Support
**Effort: M (2-3 days)**

- ROM selection UI (dropdown or grid of available games)
- Server serves multiple ROMs from a directory
- Different default cheats per game

#### P2.5: Quality of Life
**Effort: S per item**

- Mute/unmute game audio
- Fullscreen toggle
- FPS/latency overlay (debug mode)
- Keyboard shortcut reference
- "About" page with setup instructions

---

## Recommended Implementation Order

```
Week 1:  P0.1 (Lobby + Invite Links)
         P0.4 (Basic Responsive Layout)
         -- milestone: friends can open a link and land on a page that makes sense

Week 2:  P0.3 (Refactor Netplay Scripts)
         P0.2 (Host-Controlled Start Flow)
         P0.5 (Minimal Gamepad Support)
         -- milestone: full create -> invite -> lobby -> start -> play flow works

Week 3:  P1.4 (Connection Status / Errors)
         P1.3 (Chat)
         P1.5 (End Game / Rematch)
         -- milestone: smooth end-to-end experience, ready for real friend test

Week 4:  P1.1 (Touch Controls)
         P1.2 (Controller Mapping UI)
         -- milestone: mobile players can actually play

Beyond:  P2.x items based on feedback from the friend test
```

---

## What to Cut If Time Is Short

**If you have 1 week:** Do P0.1 + P0.2 + P0.3 only. Skip gamepad auto-detect
(keyboard works), skip responsive (tell friends to use desktop), skip everything
else. This gets you: link -> lobby -> start -> play.

**If you have 2 weeks:** Add P0.4 + P0.5 + P1.4. Now mobile users can at least
see the game (though no touch controls), gamepad users can play, and error
messages exist.

**If you have 3 weeks:** Add P1.1 + P1.3 + P1.5. Now mobile users can play with
touch, everyone can chat, and you can restart games without refreshing.

**Always cut last:** P0.3 (the netplay refactor) is the foundation for everything
else. If this is too risky, an alternative is to keep the existing netplay scripts
mostly intact and just add a thin lobby wrapper that passes the room code via URL
parameter, then auto-creates/auto-joins based on URL state. This is less clean
but ships faster.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Netplay refactor breaks working code | Medium | High | Keep old scripts as fallback, run Playwright tests after each change |
| Touch controls are too laggy for fighting games | Medium | Medium | Streaming mode is more forgiving of input lag; recommend it for mobile |
| EmulatorJS performance on mobile | Medium | High | Test on real phones early; streaming mode offloads emulation to host |
| WebRTC fails on restrictive networks (corp WiFi) | Low | High | TURN server fallback (not in MVP, but note for users) |
| Gamepad API inconsistencies across browsers | Low | Medium | Stick to standard mappings, test Chrome + Safari + Firefox |

---

## Success Metrics for First Friend Test

1. **Completion rate:** Friend successfully joins and plays at least one match
2. **Time to play:** Under 2 minutes from clicking the link to gameplay
3. **Zero crashes:** No unrecoverable errors during a 30-minute session
4. **Mobile works:** At least one friend successfully plays from a phone
5. **Would play again:** Friend says yes when asked

---

## Server-Side Changes Needed

The signaling server needed these additions for the MVP:

1. **`start-game` event** -- Done. Host emits, server broadcasts to room.

2. **`chat-message` event** -- Cut from scope. Not needed for friend test.

3. **`ready` event** -- Replaced by `rom-ready` (player signals ROM loaded).

4. **Room info endpoint** -- Done. `GET /room/{room_id}` returns room state.
