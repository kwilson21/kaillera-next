# Dynamic Open Graph Cards

## Problem

Sharing kaillera-next links on iMessage, Discord, Slack, Twitter/X shows a plain default card with no preview image or description. Invite links should look polished and communicate what the link is for.

## Solution

Server-side dynamic OG meta tag injection + Pillow-generated OG images. When a crawler or browser requests a page, FastAPI intercepts the request, looks up room state, and injects `<meta>` tags with a dynamically generated preview image.

## Card Variants

Four card types, determined by URL:

| URL | Card Type | Badge | Background |
|-----|-----------|-------|------------|
| `/` | Homepage | none | Dark gradient |
| `/play.html?room=X` | Play invite | "JOIN GAME" (blue) | Game image or generic |
| `/play.html?room=X&spectate=1` | Watch invite | "WATCH GAME" (orange) | Game image or generic |
| `/play.html?room=X` (room not found) | Generic invite | "JOIN GAME" (blue) | Dark gradient |

## OG Meta Tags

Injected into HTML responses before serving:

```html
<!-- Play invite example -->
<meta property="og:title" content="Join Agent 21's room · SSB64" />
<meta property="og:description" content="kaillera-next — play retro games online with friends" />
<meta property="og:image" content="https://{host}/og-image/{room_id}.png" />
<meta property="og:url" content="https://{host}/play.html?room={room_id}" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />

<!-- Watch invite example -->
<meta property="og:title" content="Watch Agent 21's room · SSB64" />

<!-- Homepage -->
<meta property="og:title" content="kaillera-next" />
<meta property="og:description" content="Play retro games online with friends — no install needed" />
<meta property="og:image" content="https://{host}/static/og/home.png" />
```

## Image Generation

### Endpoint

`GET /og-image/{room_id}.png` — generates a 1200x630 PNG on the fly using Pillow.

### Composition (game image background)

```
┌─────────────────────────────────────────┐
│  [game background, 1px blur]            │
│  [dark gradient overlay]                │
│                                         │
│  ┌────────────┐                         │
│  │ JOIN GAME  │  (blue badge)           │
│  └────────────┘                         │
│  Agent 21's room         (white, bold)  │
│  Super Smash Bros. 64    (light gray)   │
│                                         │
│  kaillera-next · play retro    (gray)   │
│  games online with friends         kn   │
│                               (30%, bg) │
└─────────────────────────────────────────┘
```

- Background: game-specific image with 1px Gaussian blur, scaled to cover 1200x630
- Overlay: dark gradient (left-heavy) for text legibility
- Text: heavy drop shadows (only when game image background is present)
- "kn" watermark: bottom-right, 30% opacity, blended into background
- Badge: colored pill — blue `rgba(102,170,255,0.25)` for play, orange `rgba(255,170,102,0.25)` for watch

### Composition (generic / homepage)

Same layout but:
- Background: solid dark gradient (`#1a1a2e` → `#16213e` → `#0f3460`)
- No text shadows (not needed against controlled gradient)
- "kn" watermark: larger, 6% opacity, further bottom-right
- Homepage omits badge, uses "kaillera-next" as title

### Font

Bundle Inter Bold (`.ttf`) for consistent rendering across environments.

### Caching

- `Cache-Control: public, max-age=300` (5 min) for room images
- Homepage image is a pre-generated static file served by `StaticFiles` (normal static caching applies)

## Game Registry

Combined mapping from `game_id` to background image and display name:

```
web/static/og/
├── ssb64.jpg          # SSB64 NA box art
├── home.png           # pre-generated homepage card
└── Inter-Bold.ttf     # bundled font
```

Mapping lives in the OG module as a dict:

```python
GAME_INFO = {
    "ssb64": {"image": "ssb64.jpg", "name": "Super Smash Bros. 64"},
}
```

Community contributors add an image file + one entry in the dict. No match found → generic dark gradient fallback, `game_id` used as display name.

## Server Changes

### New dependency

`Pillow` added to `pyproject.toml`.

### New module

`server/src/api/og.py` — contains:
- `generate_og_image()` — Pillow image composition
- `inject_og_tags()` — HTML meta tag injection
- Game registry dict

### Route changes

Routes registered in `app.py` **before** the `StaticFiles` catch-all mount:

1. `GET /og-image/{room_id}.png` — image generation endpoint
2. `GET /play.html` — intercepts static file, injects dynamic OG tags, serves modified HTML
3. `GET /` — intercepts index, injects static OG tags (points to pre-generated `home.png`)

### How HTML interception works

1. Read `play.html` and `index.html` from disk once at startup, cache in memory
2. On request: look up room from `?room=` param, determine card type from `?spectate=` param
3. Insert `<meta>` tags into `<head>` section of the cached HTML
4. Return modified HTML with correct `Content-Type`
5. If room not found or no `?room=` param: inject generic/fallback tags

### Room data lookup

The `room_id` in URLs corresponds to the `sessionId` key in the `rooms` dict (set during `open-room` via `extra.sessionid`). This is the same key used by the existing `/room/{room_id}` endpoint.

To get the owner's display name: find the player entry whose `socketId` matches `room.owner`, then read their `playerName`. If the owner has disconnected or the room is empty, fall back to `room.room_name`.

### COOP/COEP header exemption

The `/og-image/` endpoint must be excluded from `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` headers. Crawlers (iMessage, Discord, Slack, Twitter/X) fetch OG images as cross-origin requests — COEP `require-corp` would block them from rendering in preview cards. The `SecurityHeadersMiddleware` should skip these headers for paths starting with `/og-image/`.

### What does NOT change

- No modifications to `play.html` or `index.html` source files
- No changes to Socket.IO, signaling, or any frontend JS
- Existing middleware continues to apply (security headers exempt `/og-image/` from COEP only, cache busting unchanged)

## Assets to Source

- SSB64 NA box art image (cropped/optimized for 1200x630)
- Pre-generated `home.png` homepage card (1200x630, generic dark gradient layout)
- Inter Bold TTF font file
