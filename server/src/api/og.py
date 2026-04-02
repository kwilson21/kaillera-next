"""Open Graph image generation and HTML meta tag injection.

Generates 1200x630 PNG preview cards by screenshotting HTML templates via Playwright.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

log = logging.getLogger(__name__)

# ── Game registry ─────────────────────────────────────────────────────────────
# Community contributors: add an image file to web/static/og/ and one entry here.
# game_id must match what the frontend sends in open-room's extra.game_id.

GAME_INFO: dict[str, dict[str, str]] = {
    "ssb64": {"image": "ssb64.jpg", "name": "Super Smash Bros. 64"},
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

# ── Playwright browser singleton ──────────────────────────────────────────────

_browser = None
_playwright = None


async def _get_browser():
    """Lazy-init a headless Chromium browser."""
    global _browser, _playwright
    if _browser is None:
        from playwright.async_api import async_playwright

        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True)
        log.info("OG image renderer: Playwright browser started")
    return _browser


async def close_browser() -> None:
    """Close the Playwright browser and stop the Playwright instance."""
    global _browser, _playwright
    if _browser is not None:
        await _browser.close()
        _browser = None
        log.info("OG image renderer: Playwright browser closed")
    if _playwright is not None:
        await _playwright.stop()
        _playwright = None


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
    is_homepage = room_name is None

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


async def generate_og_image(
    room_name: str | None,
    game_id: str | None,
    spectate: bool,
    player_names: list[str] | None = None,
    game_images_enabled: bool = True,
) -> bytes:
    """Generate a 1200x630 OG card image by screenshotting HTML.

    Args:
        room_name: Room owner's display name (None for homepage).
        game_id: Game identifier for background lookup (None for homepage).
        spectate: True for "WATCH GAME" badge, False for "JOIN GAME".
        player_names: List of player names in room (for spectate cards).
        game_images_enabled: When False, renders text-only card with no game art.

    Returns:
        PNG image as bytes.
    """
    html = _build_card_html(room_name, game_id, spectate, player_names, game_images_enabled)
    browser = await _get_browser()
    page = await browser.new_page(viewport={"width": 1200, "height": 630})
    try:
        await page.set_content(html, wait_until="networkidle")
        return await page.screenshot(type="png")
    finally:
        await page.close()


# ── HTML meta tag injection ───────────────────────────────────────────────────

_HEAD_RE = re.compile(r"(<head[^>]*>)", re.IGNORECASE)


def build_og_tags(
    host: str,
    room_id: str | None = None,
    room_name: str | None = None,
    game_id: str | None = None,
    spectate: bool = False,
) -> str:
    """Build OG meta tag HTML string for injection into <head>."""
    game_info = GAME_INFO.get(game_id) if game_id else None

    if room_id and room_name:
        game_label = game_info["name"] if game_info else (game_id or "")
        title = f"Come watch! {room_name} is playing" if spectate else f"Ready to fight? {room_name} is waiting"
        if game_label:
            title += f" \u00b7 {game_label}"
        description = "kaillera-next \u2014 play retro games online with friends"
        img_params = []
        if game_id:
            img_params.append(f"game={game_id}")
        if spectate:
            img_params.append("spectate=1")
        image_url = f"https://{host}/og-image/{room_id}.png"
        if img_params:
            image_url += "?" + "&".join(img_params)
        page_url = f"https://{host}/play.html?room={room_id}"
        if game_id:
            page_url += f"&game={game_id}"
        if spectate:
            page_url += "&spectate=1"
    else:
        title = "kaillera-next"
        description = "Play retro games online with friends \u2014 no install needed"
        image_url = f"https://{host}/static/og/home.png"
        page_url = f"https://{host}/"

    return (
        f'<meta property="og:title" content="{title}" />\n'
        f'    <meta property="og:description" content="{description}" />\n'
        f'    <meta property="og:image" content="{image_url}" />\n'
        f'    <meta property="og:image:width" content="1200" />\n'
        f'    <meta property="og:image:height" content="630" />\n'
        f'    <meta property="og:url" content="{page_url}" />\n'
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
