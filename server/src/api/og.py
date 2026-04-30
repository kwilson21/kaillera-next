"""Open Graph cards: HTML template + static-URL meta tag injection.

Cards are pre-rendered at build time by `scripts/generate_og_cards.py`
and served as plain static files from `web/static/og/cards/`. There is
no runtime browser. `_build_card_html` is exported so the build script
can reuse the same template.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from urllib.parse import quote

log = logging.getLogger(__name__)

# ── Game registry ─────────────────────────────────────────────────────────────
# Community contributors: add an image file to web/static/og/ and one entry here.
# game_id must match what the frontend sends in open-room's extra.game_id.

GAME_INFO: dict[str, dict[str, str]] = {
    "ssb64": {"image": "ssb64.jpg", "name": "Super Smash Bros. 64"},
    "smash-remix": {"image": "smash-remix.jpg", "name": "Smash Remix"},
}

# Raw env var values — evaluated per-request via feature_enabled_for_host().
# Each can be "true" (all hosts), "false" (no hosts), or "domain1.com,domain2.com"
# (enabled only for the listed hostnames, port-stripped).
_GAME_IMAGES_RAW = os.environ.get("GAME_IMAGES_ENABLED", "true")
_ROM_SHARING_RAW = os.environ.get("ROM_SHARING_ENABLED", "true")


def feature_enabled_for_host(raw: str, host: str) -> bool:
    """Return True if the feature is enabled for the given request host.

    raw values:
      "true" / "" / "1"  → enabled for all hosts (default)
      "false" / "0"      → disabled for all hosts
      "a.com,b.com"      → enabled only when host matches one of the listed domains
    """
    val = raw.strip().lower()
    if val in ("true", "1", ""):
        return True
    if val in ("false", "0"):
        return False
    # Comma-separated domain allow-list — strip port before comparing.
    request_host = host.split(":")[0].lower()
    allowed = {d.strip().lower() for d in raw.split(",") if d.strip()}
    return request_host in allowed


# ── Paths ─────────────────────────────────────────────────────────────────────

_OG_DIR = Path(os.path.dirname(__file__)).parent.parent.parent / "web" / "static" / "og"


def _html_escape(s: str) -> str:
    """Escape HTML special characters."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _build_card_html(
    room_name: str | None,
    game_id: str | None,
    spectate: bool,
    player_names: list[str] | None = None,
    game_images_enabled: bool = True,
) -> str:
    """Build a self-contained HTML page for the OG card."""
    game_info = GAME_INFO.get(game_id) if game_id else None
    has_game_bg = game_images_enabled and game_info is not None and (_OG_DIR / game_info["image"]).exists()
    # Three render modes:
    #   - homepage: room_name=None, game_id=None (generic kaillera-next card)
    #   - per-game static: room_name=None, game_id=<known> (build-time card per game)
    #   - per-room: room_name set (legacy dynamic; only used by scripts/generate_og_cards.py
    #     for fallback cards now that runtime rendering is gone)
    is_homepage = room_name is None and game_id is None
    is_per_game_static = room_name is None and game_id is not None

    # Background image as base64 data URI for self-contained HTML
    bg_css = ""
    if has_game_bg:
        import base64

        bg_path = _OG_DIR / game_info["image"]
        b64 = base64.b64encode(bg_path.read_bytes()).decode()
        ext = bg_path.suffix.lstrip(".")
        bg_css = f'background-image: url("data:image/{ext};base64,{b64}"); background-size: cover; background-position: center;'

    # Overlay class
    overlay_class = "overlay-game" if has_game_bg else "overlay-generic"
    text_shadow_class = "text-shadowed" if has_game_bg else ""

    # kn watermark
    kn_html = '<div class="kn-bg">kn</div>' if has_game_bg else '<div class="kn-bg-generic">kn</div>'

    # Badge
    badge_html = ""
    if not is_homepage:
        if spectate:
            badge_html = '<div class="badge badge-watch">WATCH GAME</div>'
        else:
            badge_html = '<div class="badge badge-play">JOIN GAME</div>'

    # Headline
    if is_homepage:
        headline = "kaillera-next"
    elif spectate:
        headline = "Come watch!"
    else:
        headline = "Ready to fight?"

    # Subtitle
    if is_homepage:
        subtitle = "Play retro games online with friends"
        subtitle_class = "subtitle-default"
    elif is_per_game_static:
        subtitle = "Up to 4 players online" if not spectate else "Watch live"
        subtitle_class = "subtitle-blue"
    elif spectate and player_names and len(player_names) >= 2:
        if len(player_names) == 2:
            subtitle = f"{_html_escape(player_names[0])} vs {_html_escape(player_names[1])}"
        else:
            subtitle = (
                f"{_html_escape(player_names[0])}, {_html_escape(player_names[1])} & {len(player_names) - 2} more"
            )
        subtitle_class = "subtitle-blue"
    elif spectate:
        subtitle = f"{_html_escape(room_name)} is playing"
        subtitle_class = "subtitle-blue"
    else:
        subtitle = f"{_html_escape(room_name)} is waiting"
        subtitle_class = "subtitle-blue"

    # Game name
    if is_homepage:
        game_text = "no install needed &middot; up to 4 players"
    elif game_info:
        game_text = _html_escape(game_info["name"])
    else:
        game_text = _html_escape(game_id or "Unknown Game")

    # Tagline
    tagline = "kaillera-next"

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  @font-face {{
    font-family: 'Inter';
    src: url('file://{_OG_DIR / "Inter-Bold.ttf"}') format('truetype');
    font-weight: 700;
  }}
  body {{
    width: 1200px;
    height: 630px;
    overflow: hidden;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #1a1a2e;
  }}
  .card {{
    width: 1200px;
    height: 630px;
    position: relative;
    overflow: hidden;
    {bg_css}
  }}
  .bg-blur {{
    position: absolute;
    top: -4px; left: -4px; right: -4px; bottom: -4px;
    {bg_css}
    filter: blur(1px);
    transform: scale(1.03);
  }}
  .overlay {{
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 60px 80px;
    gap: 10px;
  }}
  .overlay-game {{
    background: linear-gradient(135deg, rgba(10,10,30,0.88) 0%, rgba(10,10,30,0.55) 50%, rgba(10,10,30,0.3) 100%);
  }}
  .overlay-generic {{
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  }}
  .kn-bg {{
    position: absolute;
    right: 20px;
    bottom: -20px;
    font-weight: 900;
    font-size: 380px;
    color: rgba(102, 170, 255, 0.30);
    letter-spacing: -14px;
    z-index: 2;
  }}
  .kn-bg-generic {{
    position: absolute;
    right: 20px;
    bottom: -20px;
    font-weight: 900;
    font-size: 420px;
    color: rgba(102, 170, 255, 0.06);
    letter-spacing: -16px;
  }}
  .text-shadowed .headline {{
    text-shadow: 0 3px 16px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,1);
  }}
  .text-shadowed .subtitle-blue,
  .text-shadowed .subtitle-default {{
    text-shadow: 0 2px 12px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,1);
  }}
  .text-shadowed .game-name {{
    text-shadow: 0 2px 10px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,1);
  }}
  .text-shadowed .tagline {{
    text-shadow: 0 1px 8px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,1);
  }}
  .badge {{
    display: inline-block;
    font-weight: 700;
    font-size: 44px;
    letter-spacing: 2px;
    padding: 14px 28px;
    border-radius: 8px;
    z-index: 3;
    position: relative;
    width: fit-content;
    margin-bottom: 4px;
  }}
  .badge-play {{
    background: rgba(102, 170, 255, 0.25);
    color: #6af;
  }}
  .badge-watch {{
    background: rgba(255, 170, 102, 0.25);
    color: #fa6;
  }}
  .headline {{
    font-weight: 800;
    font-size: 130px;
    color: #fff;
    z-index: 3;
    position: relative;
    line-height: 1.15;
  }}
  .subtitle-blue {{
    font-weight: 600;
    font-size: 72px;
    color: #6af;
    z-index: 3;
    position: relative;
  }}
  .subtitle-default {{
    font-weight: 600;
    font-size: 72px;
    color: #ccc;
    z-index: 3;
    position: relative;
  }}
  .game-name {{
    font-weight: 500;
    font-size: 56px;
    color: #ccc;
    z-index: 3;
    position: relative;
  }}
  .tagline {{
    font-weight: 400;
    font-size: 48px;
    color: #999;
    margin-top: 8px;
    z-index: 3;
    position: relative;
  }}
</style>
</head>
<body>
<div class="card">
  {"<div class='bg-blur'></div>" if has_game_bg else ""}
  <div class="overlay {overlay_class} {text_shadow_class}">
    {kn_html}
    {badge_html}
    <div class="headline">{headline}</div>
    <div class="{subtitle_class}">{subtitle}</div>
    <div class="game-name">{game_text}</div>
    <div class="tagline">{tagline}</div>
  </div>
</div>
</body>
</html>"""


# ── HTML meta tag injection ───────────────────────────────────────────────────

_HEAD_RE = re.compile(r"(<head[^>]*>)", re.IGNORECASE)


def build_og_tags(
    host: str,
    room_id: str | None = None,
    room_name: str | None = None,
    game_id: str | None = None,
    spectate: bool = False,
) -> str:
    """Build OG meta tag HTML string for injection into <head>.

    Every value that lands inside a content="..." attribute is HTML-escaped;
    every value that lands inside a URL is percent-encoded with quote(safe="").
    Treat callers as untrusted: room_name in particular flows from query
    strings on the missing-room fallback path.
    """
    game_info = GAME_INFO.get(game_id) if game_id else None

    # Card images are now prebuilt static PNGs (see scripts/generate_og_cards.py).
    # Pick the per-game card if we recognize the game, else fall back to home.png.
    if game_info:
        suffix = "watch" if spectate else "play"
        image_url = f"https://{host}/static/og/cards/{quote(game_id, safe='')}-{suffix}.png"
    else:
        image_url = f"https://{host}/static/og/home.png"

    if room_id and room_name:
        game_label = game_info["name"] if game_info else (game_id or "")
        title = f"Come watch! {room_name} is playing" if spectate else f"Ready to fight? {room_name} is waiting"
        if game_label:
            title += f" \u00b7 {game_label}"
        description = "kaillera-next \u2014 play retro games online with friends"
        page_url = f"https://{host}/play.html?room={quote(room_id, safe='')}"
        if game_id:
            page_url += f"&amp;game={quote(game_id, safe='')}"
        if spectate:
            page_url += "&amp;spectate=1"
    else:
        title = "kaillera-next"
        description = "Play retro games online with friends \u2014 no install needed"
        page_url = f"https://{host}/"

    return (
        f'<meta property="og:title" content="{_html_escape(title)}" />\n'
        f'    <meta property="og:description" content="{_html_escape(description)}" />\n'
        f'    <meta property="og:image" content="{_html_escape(image_url)}" />\n'
        f'    <meta property="og:image:width" content="1200" />\n'
        f'    <meta property="og:image:height" content="630" />\n'
        f'    <meta property="og:url" content="{_html_escape(page_url)}" />\n'
        f'    <meta property="og:type" content="website" />\n'
        f'    <meta name="twitter:card" content="summary_large_image" />'
    )


def inject_og_tags(html: str, og_tags: str) -> str:
    """Inject OG meta tags into cached HTML by inserting after <head> opening tag."""
    return _HEAD_RE.sub(rf"\1\n    {og_tags}", html, count=1)


def _inject_kn_config(html: str, *, rom_sharing_enabled: bool) -> str:
    """Inject server-side feature flags as window.KN_CONFIG before </head>."""
    config_js = (
        f'<script>window.KN_CONFIG = {{"romSharingEnabled": {"true" if rom_sharing_enabled else "false"}}};</script>'
    )
    return html.replace("</head>", f"  {config_js}\n</head>", 1)
