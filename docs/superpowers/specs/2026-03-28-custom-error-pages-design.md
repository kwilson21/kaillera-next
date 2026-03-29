# Custom HTTP Error Pages

## Summary

Add custom HTML error pages for 404, 500, and 429 errors that replace the default
plain-text/JSON responses with creative, themed pages. Each visit randomly selects
one of 4 themes — all built with CSS/SVG pixel art (no external assets, no copyright
issues). Pages match the site's dark theme and include easter eggs.

All other HTTP status codes (400, 401, 403, 413, 507) remain as JSON responses —
they only fire on API endpoints consumed by JavaScript `fetch()`, not browser navigation.

## Error Codes Covered

| Code | Meaning | When it fires |
|------|---------|---------------|
| 404  | Not Found | Unknown URL path |
| 500  | Internal Server Error | Unhandled exception |
| 429  | Rate Limited | Too many requests (future-proofed; currently API-only) |

## 4 Rotating Themes

Each error page randomly selects one of these themes. The error code adapts the copy
and details within each theme. A `?theme=N` query param overrides random selection
for testing/QA.

### Theme 1: Arcade Game Over

Classic arcade cabinet game over screen with CRT bezel, scanlines, and screen glow:
- **1UP / HI-SCORE / 2UP** header in classic arcade format
- **"GAME OVER"** in pulsing red text
- **"ROUND 404"** (or 500, 429) as the stage indicator
- **Pixel-art character** lying flat with X eyes, dizzy stars orbiting head, ghost
  floating up — universal game over imagery, not any specific game
- **Pixelated ground** with retro tile pattern
- **"CONTINUE?" countdown** from 9 to 0, ticking every second, turns red at 3
- **"INSERT COIN"** blinking in cyan below the countdown
- **High score table** with 3-letter initials (ASH, KAZ, YOU)
- **"CREDIT 00"** at the bottom
- **Auto-redirect to `/`** when countdown hits 0 (1.5s delay after reaching 0,
  text changes to "RETURNING TO LOBBY...")
- "INSERT COIN" button also links to `/` for immediate escape

Error-specific copy:
- 404: "ROUND 404", score 0040400
- 500: "ROUND 500", score 0050000
- 429: "ROUND 429", score 0042900

### Theme 2: Retro Glitch / Cartridge Tilt

N64 crash screen aesthetic:
- RGB scanline bars sweeping across the screen
- Corrupted hex memory addresses (e.g., `ADDR 0x00FF404F`) with real-time scramble
- Glitched error text with CSS clip-path red/blue offset animation
- CRT vignette overlay and scanline pattern
- Canvas-based static noise at low opacity
- CSS pixel-art N64 cartridge, tilted at 12°, wobbling animation
- "[ blow on it? ]" prompt below the cartridge, blinking
- N64 register dump: PC, RA, SP, BADVADDR with hex values
- Error-specific text: 404 = "CARTRIDGE NOT FOUND", 500 = "FATAL EXCEPTION",
  429 = "BUFFER OVERFLOW"
- Terminal-style "REBOOT SYSTEM" link with green-on-hover fill

### Theme 3: Interactive Mini-Game

Lightweight canvas platformer where you collect the digits of the error code:
- Small pixel-art character (#6af color) on floating platforms (#3a5a8a)
- Digits of the error code (4, 0, 4) float as glowing collectibles with bob animation
- Arrow keys to move, Space/ArrowUp to jump (press-to-jump, no hold-spam)
- Touch controls for mobile: tap bottom-left/right to move, tap top half to jump
- Simple physics: gravity, single jump, platform collision (snap to top surface)
- Wrapping horizontal movement (go off right edge, appear on left)
- HUD showing SCORE, error code, and HI score
- Score counter (+100 per digit), high score persisted in localStorage
- Collecting all digits: victory overlay → auto-redirect to `/` after 2 seconds
- "Skip to Lobby" link below the game for immediate escape
- Fallback for no-JS: static version of the same scene with a link home

Implementation: vanilla JS + canvas, no dependencies. All inline in the HTML file.

### Theme 4: Kaillera Nostalgia (User's Favorite)

Full Windows XP desktop recreation with authentic Kaillera client:

**XP Desktop:**
- CSS gradient Bliss wallpaper (blue sky + green hills)
- Desktop icons: My Computer, Recycle Bin, Project64k.exe, Internet Explorer,
  AIM, N64 ROMs folder — all CSS/SVG drawn
- XP taskbar with Start button (green gradient, Windows flag), active window
  items, system tray with clock

**Kaillera Client Window (matching real SSClient/SupraclientC layout):**
- Window title: server name (e.g., "Galaxy 64")
- Left panel: chat/PARTYLINE with timestamped messages in `·HH:MM:SS PM:` format
- Right panel: user list with real columns — `UserID | Nick | Ping | Type | Status`
- Chat input bar with `Chat`, `Create`, `Join` buttons
- Game list with real columns — `GameID | Game | Emulator | Owner`
- Bottom tabs: `Login Info | Chatroom Options | Gameroom Options | Extended Emulinker X v3.1.3+ Gameroom Options`
- Login bar: `IP:` field, `Nick:` field, `Ping Spoof` field, `Quit Msg:` field,
  `Type:` dropdown (LAN/Excellent/Good/Average/Low/Bad), `Servers`/`Login`/`Logoff` buttons
- Status bar with `#Users` and `#Games` counts

**Authentic chat log** showing a real session flow:
- Server welcome: `<server> EmuLinker X v3.4`
- `<Client> Connected!`
- Player joins, creates game, game starts
- Error sequence: `Desync Detected!`, `Game Ended! Didn't receive a response for 15s.`,
  `Connection Lost!`, player dropped

**Real strings from SupraclientC source code:**
- Error: "Game Ended! Didn't receive a response for 15s."
- Error: "Could not create socket!."
- Error: "Invalid Address Format!"
- Error: "Error Resolving!"
- Status: "Not in a Server"
- Credits: SupraFast, Daniel Strusser, Trac, Moosehead, r@z

**XP Error Dialog** overlaying the Kaillera window:
- Red circle error icon with X
- Error message adapts per code (404 = "Connection Lost!", 500 = "Fatal Exception!",
  429 = "Server Full!")
- Fake memory address and diagnostic info
- Buttons: "Reconnect" (→ `/`), "Back to Lobby" (→ `/`), "Blow on Cartridge" (easter egg)

**Known Kaillera bugs referenced:**
- 20-minute lagout bug
- Desync detection timeout
- kailleraclient.dll crashes ("Crash detected! Someone call the Ghostbusters!")
- Client timeout / connection drops

## Architecture

### Single HTML file approach

All 4 themes live in one file (`web/error.html`) with a `<script>` block that:
1. Reads the error code from a `data-error-code` attribute on `<body>` (injected server-side)
2. Checks for `?theme=N` query param override, otherwise randomly selects a theme
3. Activates one of 4 `<template>` elements and injects into the page
4. Adapts error-specific copy (code number, message text, round number, collectible digits)

All CSS and JS is inline in the HTML file — no external `/static/` references. This
ensures the error page works even when StaticFiles itself is the source of the error.

### Server integration

Register an ASGI middleware that intercepts 404/500/429 responses and replaces them
with the error page HTML for browser navigation requests. This approach is necessary
because FastAPI's `exception_handler(404)` does not intercept 404s from the `StaticFiles`
sub-application mount — those are handled within Starlette's StaticFiles scope.

```python
class ErrorPageMiddleware:
    """ASGI middleware that serves custom error pages for browser requests."""

    def __init__(self, app, error_html: str):
        self.app = app
        self._error_html = error_html

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        # Skip API/WebSocket paths — those return JSON
        if path.startswith(("/api/", "/admin/api/", "/socket.io/",
                            "/health", "/list", "/room/", "/ice-servers",
                            "/og-image/")):
            await self.app(scope, receive, send)
            return

        # Check if this is a browser navigation request
        headers = dict(scope.get("headers", []))
        accept = headers.get(b"accept", b"").decode()
        if "text/html" not in accept:
            await self.app(scope, receive, send)
            return

        # Capture response status; if error, serve custom page
        status_code = None
        async def capture_send(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                if status_code in (404, 500, 429):
                    # Replace with error page
                    html = self._error_html.replace("{{CODE}}", str(status_code))
                    body = html.encode()
                    new_headers = [
                        (b"content-type", b"text/html; charset=utf-8"),
                        (b"content-length", str(len(body)).encode()),
                    ]
                    await send({"type": "http.response.start",
                                "status": status_code, "headers": new_headers})
                    await send({"type": "http.response.body", "body": body})
                    return
            if status_code not in (404, 500, 429):
                await send(message)

        await self.app(scope, receive, capture_send)
```

Mount order in `create_app()`: ErrorPageMiddleware wraps outside SecurityHeadersMiddleware
and CacheBustMiddleware so security headers still apply to error pages.

### File structure

```
web/
├── error.html              # all 4 themes in one file (inline CSS/JS)
├── error-mockup.html       # Theme 4 mockup (dev only, remove before deploy)
├── error-mockup-1.html     # Theme 1 mockup (dev only)
├── error-mockup-2.html     # Theme 2 mockup (dev only)
└── error-mockup-3.html     # Theme 3 mockup (dev only)
```

No new JS files, no external dependencies, no images. Everything is inline CSS/SVG
and vanilla JS.

## Content Guidelines

- All pixel art is original — generic silhouettes, not recognizable Nintendo characters
- Arcade theme uses universal game over tropes, not any specific game's assets
- Real Kaillera strings from open-source SupraclientC (MIT-compatible usage)
- Windows XP visual style is a parody/recreation, not using Microsoft assets
- "Blow on Cartridge" and other easter eggs are nostalgic callbacks, not IP infringement
- Error pages must still be functional: always provide a clear link home
- Basic accessibility: descriptive `<title>`, `role="alert"` on error message,
  keyboard-navigable action buttons

## Responsive Behavior

- Desktop (>768px): full layout as designed
- Mobile (<768px): simplified versions
  - Kaillera theme: just the error dialog (no full desktop/client)
  - Arcade theme: centered, scaled down within bezel
  - Glitch theme: works naturally (full-width scanlines)
  - Mini-game: touch controls, simplified platforms

## Performance

- No external requests (everything inline)
- No render-blocking resources
- Target: < 80KB combined file weight (all 4 themes in `<template>` elements,
  only the selected theme is activated and rendered)
- Mini-game canvas initializes lazily (only if that theme is selected)
- Static noise canvas uses requestAnimationFrame (no setInterval)

## Mockup References

- Theme 1 (Arcade Game Over): `web/error-mockup-1.html`
- Theme 2 (Retro Glitch): `web/error-mockup-2.html`
- Theme 3 (Mini-Game): `web/error-mockup-3.html`
- Theme 4 (Kaillera Nostalgia): `web/error-mockup.html`
