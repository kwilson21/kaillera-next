"""Open Graph image generation and HTML meta tag injection.

Generates 1200x630 PNG preview cards for shared links using Pillow.
"""

from __future__ import annotations

import io
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── Game registry ─────────────────────────────────────────────────────────────
# Community contributors: add an image file to web/static/og/ and one entry here.
# game_id must match what the frontend sends in open-room's extra.game_id.

GAME_INFO: dict[str, dict[str, str]] = {
    "ssb64": {"image": "ssb64.jpg", "name": "Super Smash Bros. 64"},
}

# ── Paths ─────────────────────────────────────────────────────────────────────

_OG_DIR = Path(os.path.dirname(__file__)).parent.parent.parent / "web" / "static" / "og"
_FONT_PATH = _OG_DIR / "Inter-Bold.ttf"

# ── Constants ─────────────────────────────────────────────────────────────────

WIDTH, HEIGHT = 1200, 630
_LEFT_PAD = 72

# Colors
_WHITE = (255, 255, 255)
_LIGHT_GRAY = (204, 204, 204)
_GRAY = (153, 153, 153)
_DARK_BG = (26, 26, 46)  # #1a1a2e
_MID_BG = (22, 33, 62)  # #16213e
_DEEP_BG = (15, 52, 96)  # #0f3460
_BLUE_ACCENT = (102, 170, 255)  # #6af
_ORANGE_ACCENT = (255, 170, 102)  # #fa6

# Badge backgrounds (color with alpha simulated on dark bg)
_BLUE_BADGE_BG = (26 + int(102 * 0.25), 26 + int(170 * 0.25), 46 + int(255 * 0.25))
_ORANGE_BADGE_BG = (26 + int(255 * 0.25), 26 + int(170 * 0.25), 46 + int(102 * 0.25))


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Load Inter Bold at the given size, falling back to default."""
    try:
        return ImageFont.truetype(str(_FONT_PATH), size)
    except (OSError, IOError):
        return ImageFont.load_default()


def _draw_dark_gradient(img: Image.Image) -> None:
    """Draw the dark gradient background onto img."""
    draw = ImageDraw.Draw(img)
    for x in range(WIDTH):
        t = x / WIDTH
        if t < 0.5:
            s = t / 0.5
            r = int(_DARK_BG[0] + (_MID_BG[0] - _DARK_BG[0]) * s)
            g = int(_DARK_BG[1] + (_MID_BG[1] - _DARK_BG[1]) * s)
            b = int(_DARK_BG[2] + (_DEEP_BG[2] - _DARK_BG[2]) * s)
        else:
            s = (t - 0.5) / 0.5
            r = int(_MID_BG[0] + (_DEEP_BG[0] - _MID_BG[0]) * s)
            g = int(_MID_BG[1] + (_DEEP_BG[1] - _MID_BG[1]) * s)
            b = int(_MID_BG[2] + (_DEEP_BG[2] - _MID_BG[2]) * s)
        draw.line([(x, 0), (x, HEIGHT)], fill=(r, g, b))


def _draw_gradient_overlay(img: Image.Image) -> Image.Image:
    """Draw semi-transparent dark gradient overlay for text legibility over game images."""
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(WIDTH):
        t = x / WIDTH
        alpha = int(217 - 140 * t)
        draw.line([(x, 0), (x, HEIGHT)], fill=(10, 10, 30, alpha))
    return Image.alpha_composite(img, overlay)


def _draw_text_with_shadow(
    draw: ImageDraw.ImageDraw,
    pos: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill: tuple[int, int, int],
    shadow: bool = False,
) -> None:
    """Draw text, optionally with a heavy drop shadow."""
    x, y = pos
    if shadow:
        for dx, dy in [(0, 4), (0, 0)]:
            draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0))
    draw.text(pos, text, font=font, fill=fill)


def _draw_kn_watermark(img: Image.Image, large: bool = False) -> Image.Image:
    """Draw the kn watermark in the bottom-right."""
    watermark = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(watermark)
    if large:
        font = _load_font(220)
        opacity = int(255 * 0.06)
        x, y = WIDTH - 30, HEIGHT - 20
    else:
        font = _load_font(160)
        opacity = int(255 * 0.30)
        x, y = WIDTH - 20, HEIGHT - 10
    bbox = draw.textbbox((0, 0), "kn", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x - tw, y - th), "kn", font=font, fill=(*_BLUE_ACCENT, opacity))
    return Image.alpha_composite(img, watermark)


def _draw_badge(
    draw: ImageDraw.ImageDraw,
    y: int,
    text: str,
    color: tuple[int, int, int],
    bg: tuple[int, int, int],
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> int:
    """Draw a colored badge pill. Returns the height consumed."""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad_x, pad_y = 20, 10
    draw.rounded_rectangle(
        [_LEFT_PAD, y, _LEFT_PAD + tw + pad_x * 2, y + th + pad_y * 2],
        radius=8,
        fill=bg,
    )
    draw.text((_LEFT_PAD + pad_x, y + pad_y), text, font=font, fill=color)
    return th + pad_y * 2 + 16


def _format_players(player_names: list[str], host_name: str) -> str:
    """Format player names for spectate card subtitle."""
    if len(player_names) >= 2:
        if len(player_names) == 2:
            return f"{player_names[0]} vs {player_names[1]}"
        return f"{player_names[0]}, {player_names[1]} & {len(player_names) - 2} more"
    return f"{host_name} is playing"


def generate_og_image(
    room_name: str | None,
    game_id: str | None,
    spectate: bool,
    player_names: list[str] | None = None,
) -> bytes:
    """Generate a 1200x630 OG card image.

    Args:
        room_name: Room owner's display name (None for homepage).
        game_id: Game identifier for background lookup (None for homepage).
        spectate: True for "WATCH GAME" badge, False for "JOIN GAME".
        player_names: List of player names in room (for spectate cards).

    Returns:
        PNG image as bytes.
    """
    game_info = GAME_INFO.get(game_id) if game_id else None
    has_game_bg = False

    img = Image.new("RGBA", (WIDTH, HEIGHT), _DARK_BG)

    # Try to load game background
    if game_info:
        bg_path = _OG_DIR / game_info["image"]
        if bg_path.exists():
            try:
                bg = Image.open(bg_path).convert("RGBA")
                bg = bg.resize((WIDTH, HEIGHT), Image.LANCZOS)
                bg = bg.filter(ImageFilter.GaussianBlur(radius=1))
                img.paste(bg, (0, 0))
                has_game_bg = True
            except Exception:
                pass

    if has_game_bg:
        img = _draw_gradient_overlay(img)
    else:
        _draw_dark_gradient(img)

    # Watermark
    img = _draw_kn_watermark(img, large=not has_game_bg)

    draw = ImageDraw.Draw(img, "RGBA")

    # Fonts — large for OG card readability (cards render ~300px wide on mobile)
    font_badge = _load_font(32)
    font_headline = _load_font(72)
    font_subtitle = _load_font(44)
    font_game = _load_font(36)
    font_tagline = _load_font(28)

    shadow = has_game_bg
    is_homepage = room_name is None

    # Calculate total block height to vertically center
    # Badge ~55, headline ~85, subtitle ~60, game ~50, tagline ~40, gaps ~40
    block_h = 330 if not is_homepage else 275
    y = (HEIGHT - block_h) // 2

    # Badge
    if not is_homepage:
        badge_text = "WATCH GAME" if spectate else "JOIN GAME"
        badge_color = _ORANGE_ACCENT if spectate else _BLUE_ACCENT
        badge_bg = _ORANGE_BADGE_BG if spectate else _BLUE_BADGE_BG
        y += _draw_badge(draw, y, badge_text, badge_color, badge_bg, font_badge)

    # Headline
    if is_homepage:
        headline = "kaillera-next"
    elif spectate:
        headline = "Come watch!"
    else:
        headline = "Ready to fight?"
    _draw_text_with_shadow(draw, (_LEFT_PAD, y), headline, font_headline, _WHITE, shadow=shadow)
    y += 88

    # Subtitle (host info / player matchup)
    if is_homepage:
        subtitle = "Play retro games online with friends"
        subtitle_color = _LIGHT_GRAY
    elif spectate and player_names:
        subtitle = _format_players(player_names, room_name or "")
        subtitle_color = _BLUE_ACCENT
    elif spectate:
        subtitle = f"{room_name} is playing"
        subtitle_color = _BLUE_ACCENT
    else:
        subtitle = f"{room_name} is waiting"
        subtitle_color = _BLUE_ACCENT
    _draw_text_with_shadow(draw, (_LEFT_PAD, y), subtitle, font_subtitle, subtitle_color, shadow=shadow)
    y += 60

    # Game name
    if is_homepage:
        game_text = "no install needed \u00b7 up to 4 players"
    elif game_info:
        game_text = game_info["name"]
    else:
        game_text = game_id or "Unknown Game"
    _draw_text_with_shadow(draw, (_LEFT_PAD, y), game_text, font_game, _LIGHT_GRAY, shadow=shadow)
    y += 52

    # Tagline
    tagline = "kaillera-next"
    _draw_text_with_shadow(draw, (_LEFT_PAD, y), tagline, font_tagline, _GRAY, shadow=shadow)

    # Output as PNG
    img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


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
        if spectate:
            title = f"Come watch! {room_name} is playing"
        else:
            title = f"Ready to fight? {room_name} is waiting"
        if game_label:
            title += f" \u00b7 {game_label}"
        description = "kaillera-next \u2014 play retro games online with friends"
        image_url = f"https://{host}/og-image/{room_id}.png"
        if spectate:
            image_url += "?spectate=1"
        page_url = f"https://{host}/play.html?room={room_id}"
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
        f'    <meta property="og:url" content="{page_url}" />\n'
        f'    <meta property="og:type" content="website" />\n'
        f'    <meta name="twitter:card" content="summary_large_image" />'
    )


def inject_og_tags(html: str, og_tags: str) -> str:
    """Inject OG meta tags into cached HTML by inserting after <head> opening tag."""
    return _HEAD_RE.sub(rf"\1\n    {og_tags}", html, count=1)
