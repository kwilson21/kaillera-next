# Custom Error Pages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add creative, themed error pages (4 rotating themes) for 404/500/429 HTTP errors, served via ASGI middleware to browser navigation requests.

**Architecture:** A single `web/error.html` file contains all 4 themes as `<template>` elements. An ASGI middleware in `app.py` intercepts error responses for browser requests (checking `Accept: text/html` and exempting API paths) and serves the error page with the error code injected via `data-error-code`. Inline JS selects a random theme (or `?theme=N` override) and adapts copy per error code.

**Tech Stack:** Python (FastAPI/ASGI middleware), HTML/CSS/JS (inline, no dependencies), canvas API (Theme 3 mini-game)

**Spec:** `docs/superpowers/specs/2026-03-28-custom-error-pages-design.md`
**Mockups:** `web/error-mockup.html`, `web/error-mockup-1.html`, `web/error-mockup-2.html`, `web/error-mockup-3.html`

---

## Chunk 1: Server-Side Middleware

### Task 1: ErrorPageMiddleware

**Files:**
- Modify: `server/src/api/app.py` (add `ErrorPageMiddleware` class and mount it in `create_app()`)

- [ ] **Step 1: Write the failing test**

Create `tests/test_error_pages.py`:

```python
"""Tests for custom error pages.

Run: pytest tests/test_error_pages.py -v
Uses the shared server_url fixture from conftest.py.
"""

import requests


def test_404_returns_html_for_browser(server_url):
    """Browser navigation to unknown path gets HTML error page."""
    r = requests.get(
        f"{server_url}/nonexistent-page",
        headers={"Accept": "text/html"},
        timeout=5,
    )
    assert r.status_code == 404
    assert "text/html" in r.headers["content-type"]
    assert "data-error-code" in r.text


def test_404_returns_default_for_api_client(server_url):
    """API clients (no text/html Accept) get default response, not HTML error page."""
    r = requests.get(
        f"{server_url}/nonexistent-page",
        headers={"Accept": "application/json"},
        timeout=5,
    )
    assert r.status_code == 404
    assert "text/html" not in r.headers.get("content-type", "")


def test_api_paths_not_intercepted(server_url):
    """API endpoints return JSON errors, not HTML error pages."""
    r = requests.get(
        f"{server_url}/room/NONEXIST",
        headers={"Accept": "text/html"},
        timeout=5,
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "Room not found"


def test_health_still_works(server_url):
    """Health endpoint unaffected by error middleware."""
    r = requests.get(f"{server_url}/health", timeout=5)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && python -m pytest ../tests/test_error_pages.py -v`
Expected: `test_404_returns_html_for_browser` FAILS (gets plain text, not HTML)

- [ ] **Step 3: Create a minimal `web/error.html` placeholder**

Create `web/error.html` with a minimal template that the middleware can serve. This
is just the skeleton — themes are added in later tasks.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Error — kaillera-next</title>
</head>
<body data-error-code="{{CODE}}">
<div id="root"></div>
<noscript><h1>Error {{CODE}}</h1><p>Something went wrong.</p><a href="/">Back to lobby</a></noscript>
<script>
(() => {
  const code = document.body.dataset.errorCode;
  document.title = `Error ${code} — kaillera-next`;

  // Theme selection: ?theme=N override or random
  const params = new URLSearchParams(location.search);
  const override = parseInt(params.get('theme'), 10);
  const themeIndex = (override >= 1 && override <= 4)
    ? override
    : Math.floor(Math.random() * 4) + 1;

  const tpl = document.getElementById(`theme-${themeIndex}`);
  if (tpl) {
    document.getElementById('root').appendChild(tpl.content.cloneNode(true));
  }

  // Replace all {{CODE}} placeholders in the activated theme
  document.getElementById('root').innerHTML =
    document.getElementById('root').innerHTML.replaceAll('{{CODE}}', code);

  // Run theme-specific init if defined
  const initFn = window[`initTheme${themeIndex}`];
  if (typeof initFn === 'function') initFn(code);
})();
</script>

<!-- Theme templates added in subsequent tasks -->
<template id="theme-1"></template>
<template id="theme-2"></template>
<template id="theme-3"></template>
<template id="theme-4"></template>
</body>
</html>
```

- [ ] **Step 4: Add `ErrorPageMiddleware` to `app.py`**

Add this class above `create_app()` in `server/src/api/app.py`:

```python
# ── Error page middleware ─────────────────────────────────────────────────────


class ErrorPageMiddleware:
    """ASGI middleware that serves custom HTML error pages for browser requests.

    Intercepts 404/500/429 responses for requests that accept text/html and
    are not on API paths. Injects the status code into the HTML template.
    """

    _API_PREFIXES = ("/api/", "/admin/api/", "/socket.io/", "/health",
                     "/list", "/room/", "/ice-servers", "/og-image/")

    def __init__(self, app, error_html: str) -> None:  # noqa: ANN001
        self.app = app
        self._error_html = error_html

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        # Skip API paths — they return JSON
        if any(path.startswith(p) for p in self._API_PREFIXES):
            await self.app(scope, receive, send)
            return

        # Only intercept browser navigation (Accept: text/html)
        headers = dict(scope.get("headers", []))
        accept = headers.get(b"accept", b"").decode()
        if "text/html" not in accept:
            await self.app(scope, receive, send)
            return

        # Capture response; replace error status with custom page
        intercepted = False

        async def capture_send(message: dict) -> None:
            nonlocal intercepted
            if message["type"] == "http.response.start":
                status = message["status"]
                if status in (404, 500, 429):
                    intercepted = True
                    html = self._error_html.replace("{{CODE}}", str(status))
                    body = html.encode()
                    await send({
                        "type": "http.response.start",
                        "status": status,
                        "headers": [
                            (b"content-type", b"text/html; charset=utf-8"),
                            (b"content-length", str(len(body)).encode()),
                        ],
                    })
                    await send({"type": "http.response.body", "body": body})
                    return
                await send(message)
            elif message["type"] == "http.response.body":
                if not intercepted:
                    await send(message)

        await self.app(scope, receive, capture_send)
```

- [ ] **Step 5: Mount the middleware in `create_app()`**

In `create_app()`, after the existing middleware lines, add the error page middleware.
It must be added FIRST (before CacheBust and SecurityHeaders) so that the other
middlewares still process the error page response:

```python
def create_app(lifespan=None) -> FastAPI:
    """Create and return the FastAPI app."""
    app = FastAPI(
        title="kaillera-next",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    production = os.environ.get("ALLOWED_ORIGIN", "*") != "*"
    version = _asset_version()
    app.add_middleware(CacheBustMiddleware, version=version)
    app.add_middleware(SecurityHeadersMiddleware, allow_cache=production)

    # Load error page template
    _error_html_path = Path(os.path.dirname(__file__)).parent.parent.parent / "web" / "error.html"
    if _error_html_path.exists():
        _error_html = _error_html_path.read_text()
        app.add_middleware(ErrorPageMiddleware, error_html=_error_html)
        log.info("Custom error pages loaded")
    else:
        log.warning("web/error.html not found — using default error responses")

    log.info("Cache bust version: %s", version)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && python -m pytest ../tests/test_error_pages.py -v`
Expected: All 4 tests PASS

- [ ] **Step 7: Also verify existing tests still pass**

Run: `cd server && python -m pytest ../tests/test_server_rest.py -v`
Expected: All existing tests PASS (API paths still return JSON)

- [ ] **Step 8: Commit**

```bash
git add server/src/api/app.py web/error.html tests/test_error_pages.py
git commit -m "feat: add ErrorPageMiddleware and error.html skeleton"
```

---

## Chunk 2: Theme 1 — Arcade Game Over

### Task 2: Port mockup into `<template id="theme-1">`

**Files:**
- Modify: `web/error.html` (populate `<template id="theme-1">`)
- Reference: `web/error-mockup-1.html`

- [ ] **Step 1: Copy Theme 1 content into the template**

Port the content from `web/error-mockup-1.html` into `<template id="theme-1">` in
`web/error.html`. Adapt for the template system:
- Replace hardcoded "404" with `{{CODE}}`
- Replace hardcoded score with a `data-score` attribute that JS will set
- Replace "ROUND 404" with "ROUND {{CODE}}"
- All CSS goes inside a `<style>` tag within the template
- Keep the countdown JS — it will be called via `initTheme1(code)`

The template content should include:
- All the CSS from the mockup (scoped inside the template)
- The full HTML structure (cabinet, screen, HUD, game over, scene, countdown, high scores)
- A `<script>` block defining `window.initTheme1 = function(code) { ... }` that starts the countdown timer and sets error-specific copy

Error-specific adaptations in `initTheme1(code)`:
- "ROUND {{CODE}}" is already handled by the replaceAll
- Score: set `.hud-value` for 1UP to `00${code}00` padded to 7 digits
- Countdown auto-redirect to `/` after reaching 0

- [ ] **Step 2: Test locally**

Open `http://localhost:27888/nonexistent?theme=1` in browser.
Expected: Arcade game over screen with "ROUND 404", countdown, INSERT COIN.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add Theme 1 (Arcade Game Over) to error pages"
```

---

## Chunk 3: Theme 2 — Retro Glitch

### Task 3: Port mockup into `<template id="theme-2">`

**Files:**
- Modify: `web/error.html` (populate `<template id="theme-2">`)
- Reference: `web/error-mockup-2.html`

- [ ] **Step 1: Copy Theme 2 content into the template**

Port from `web/error-mockup-2.html` into `<template id="theme-2">`.
Adaptations:
- Replace "ERR 404" with "ERR {{CODE}}"
- Replace "CARTRIDGE NOT FOUND" with error-specific text set by `initTheme2(code)`:
  - 404: "CARTRIDGE NOT FOUND"
  - 500: "FATAL EXCEPTION"
  - 429: "BUFFER OVERFLOW"
- Replace hardcoded hex addresses — keep the scramble JS
- Canvas noise and scanline animations go in `initTheme2(code)`
- Memory dump addresses adapt per code

- [ ] **Step 2: Test locally**

Open `http://localhost:27888/nonexistent?theme=2` in browser.
Expected: Glitch screen with scanlines, scrambling hex, tilted cartridge.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add Theme 2 (Retro Glitch) to error pages"
```

---

## Chunk 4: Theme 3 — Mini-Game

### Task 4: Port mockup into `<template id="theme-3">`

**Files:**
- Modify: `web/error.html` (populate `<template id="theme-3">`)
- Reference: `web/error-mockup-3.html`

- [ ] **Step 1: Copy Theme 3 content into the template**

Port from `web/error-mockup-3.html` into `<template id="theme-3">`.
Adaptations:
- Collectible digits derived from `code.split('')` (e.g., "404" → ["4","0","4"])
- HUD error code display: "ERROR {{CODE}}"
- Canvas game initialization in `initTheme3(code)`:
  - Parse code digits for collectibles
  - Set up canvas, player, platforms, physics
  - Start game loop with requestAnimationFrame
- High score key in localStorage: `kn-error-hiscore`
- Victory redirect to `/` after 2 seconds
- Touch controls for mobile

- [ ] **Step 2: Test locally**

Open `http://localhost:27888/nonexistent?theme=3` in browser.
Expected: Playable platformer, arrow keys + space work, digits collectible.
Test: collect all 3 digits → victory overlay → redirect to `/`.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add Theme 3 (Mini-Game) to error pages"
```

---

## Chunk 5: Theme 4 — Kaillera Nostalgia

### Task 5: Port mockup into `<template id="theme-4">`

**Files:**
- Modify: `web/error.html` (populate `<template id="theme-4">`)
- Reference: `web/error-mockup.html`

- [ ] **Step 1: Copy Theme 4 content into the template**

Port from `web/error-mockup.html` into `<template id="theme-4">`.
This is the largest theme. Adaptations:
- Error dialog message adapts per code in `initTheme4(code)`:
  - 404: "Connection Lost!" / "The page you're looking for has been dropped from the server."
  - 500: "Fatal Exception!" / "The server encountered an unrecoverable error."
  - 429: "Server Full!" / "Too many connections. Please wait before retrying."
- Error dialog hex address incorporates the code: `0x00${code}F`
- Chat log error line uses the code: `Connection Lost! (Error ${code})`
- "Blow on Cartridge" button easter egg: changes text to "💨 Pfffft!" on click
- "Reconnect" and "Back to Lobby" buttons navigate to `/`

- [ ] **Step 2: Test locally**

Open `http://localhost:27888/nonexistent?theme=4` in browser.
Expected: Full XP desktop with Kaillera client window and error dialog overlay.
Test: "Blow on Cartridge" button changes text. "Reconnect" navigates to `/`.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add Theme 4 (Kaillera Nostalgia) to error pages"
```

---

## Chunk 6: Polish and Cleanup

### Task 6: Responsive mobile styles

**Files:**
- Modify: `web/error.html` (add `@media` queries to each theme's `<style>`)

- [ ] **Step 1: Add mobile breakpoints**

Add `@media (max-width: 768px)` rules to each theme:
- Theme 1 (Arcade): scale cabinet width to 95vw, reduce font sizes
- Theme 2 (Glitch): reduce font sizes, cartridge scales down
- Theme 3 (Mini-Game): canvas scales to viewport width, touch controls visible
- Theme 4 (Kaillera): hide the XP desktop/client window, show only the error dialog centered on a dark background

- [ ] **Step 2: Test on mobile viewport**

Use browser dev tools to test at 375px width for each theme:
- `?theme=1` through `?theme=4`
Expected: All themes readable and functional at mobile width.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add responsive mobile styles to error pages"
```

### Task 7: Accessibility

**Files:**
- Modify: `web/error.html`

- [ ] **Step 1: Add accessibility attributes**

In each theme template:
- Add `role="alert"` to the main error message element
- Ensure all action buttons/links have descriptive text
- Ensure the page `<title>` is set to `Error {code} — kaillera-next` (already done in skeleton JS)
- Add `aria-label` to the "Skip to Lobby" / "INSERT COIN" / "Reconnect" action buttons

- [ ] **Step 2: Test keyboard navigation**

Tab through each theme — all action buttons should be focusable and activatable
with Enter/Space.

- [ ] **Step 3: Commit**

```bash
git add web/error.html
git commit -m "feat: add accessibility attributes to error pages"
```

### Task 8: Remove mockup files

**Files:**
- Delete: `web/error-mockup.html`, `web/error-mockup-1.html`, `web/error-mockup-2.html`, `web/error-mockup-3.html`

- [ ] **Step 1: Delete mockup files**

```bash
rm web/error-mockup.html web/error-mockup-1.html web/error-mockup-2.html web/error-mockup-3.html
```

- [ ] **Step 2: Commit**

```bash
git add -u web/error-mockup*.html
git commit -m "chore: remove error page mockup files"
```

### Task 9: Final verification

- [ ] **Step 1: Run all tests**

```bash
cd server && python -m pytest ../tests/test_error_pages.py ../tests/test_server_rest.py -v
```
Expected: All tests PASS.

- [ ] **Step 2: Manual smoke test all 4 themes**

Visit `http://localhost:27888/this-does-not-exist` multiple times — verify random
theme selection works. Then test each with `?theme=1` through `?theme=4`.

Verify:
- Theme 1: countdown works, redirects to `/` at 0, "INSERT COIN" links to `/`
- Theme 2: scanlines animate, hex scrambles, cartridge wobbles, "REBOOT SYSTEM" links to `/`
- Theme 3: game plays, digits collectible, victory redirects, "Skip to Lobby" works
- Theme 4: XP desktop renders, Kaillera client has real layout, "Blow on Cartridge" easter egg, "Reconnect" links to `/`

- [ ] **Step 3: Verify API endpoints still return JSON**

```bash
curl -s http://localhost:27888/room/NONEXIST | python -m json.tool
curl -s http://localhost:27888/health | python -m json.tool
```
Expected: JSON responses, not HTML.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: error page polish from smoke testing"
```
