"""Invite card composed at request time from a listed room's latest frame.

1200x630 JPEG: the live frame on the left, the game, "<host>'s room · in
game" and the name on the right. Rooms that are unlisted, waiting, or have
no frame keep the prebuilt per-game card (og.py). One composed card is
cached per room and rebuilt only when a new frame lands.
"""

from __future__ import annotations

import io
import logging
import threading
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

log = logging.getLogger(__name__)

_FONT = Path(__file__).resolve().parents[3] / "web" / "static" / "og" / "Inter-Bold.ttf"
_W, _H = 1200, 630
_BG = (14, 18, 24)  # --bg
_TEXT = (232, 236, 241)  # --text
_MUTED = (139, 149, 165)  # --muted
_ACCENT = (90, 168, 255)  # --accent

_cache: dict[str, tuple[float, bytes]] = {}  # room code -> (frame time, jpeg)
_lock = threading.Lock()


@lru_cache(maxsize=8)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(str(_FONT), size)
    except OSError:
        log.warning("og_card: %s missing, using the default font", _FONT)
        return ImageFont.load_default()


def _fit(draw: ImageDraw.ImageDraw, text: str, size: int, max_w: int):  # noqa: ANN202
    """(text, font) that fits max_w: shrink in 4 px steps to 28 px, then truncate with an ellipsis."""
    while size > 28 and draw.textlength(text, font=_font(size)) > max_w:
        size -= 4
    font = _font(size)
    if draw.textlength(text, font=font) > max_w:
        while text and draw.textlength(text + "\u2026", font=font) > max_w:
            text = text[:-1]
        text = text.rstrip() + "\u2026"
    return text, font


def compose(frame_jpeg: bytes, game: str, host_name: str) -> bytes:
    card = Image.new("RGB", (_W, _H), _BG)
    frame = Image.open(io.BytesIO(frame_jpeg)).convert("RGB")
    # 4:3 frame, 640x480, vertically centred with a 60 px left margin.
    frame = frame.resize((640, 480), Image.Resampling.BILINEAR)
    card.paste(frame, (60, (_H - 480) // 2))
    draw = ImageDraw.Draw(card)
    x, max_w = 740, _W - 740 - 50
    draw.text((x, 150), "kaillera-next", font=_font(30), fill=_ACCENT)
    text, font = _fit(draw, game, 56, max_w)
    draw.text((x, 210), text, font=font, fill=_TEXT)
    who = f"{host_name}'s room \u00b7 in game" if host_name else "In game"
    text, font = _fit(draw, who, 38, max_w)
    draw.text((x, 300), text, font=font, fill=_MUTED)
    out = io.BytesIO()
    card.save(out, "JPEG", quality=82)
    return out.getvalue()


def card_for(code: str, frame: tuple[bytes, float], game: str, host_name: str) -> bytes:
    # Called from the threadpool (sync endpoint): guard the shared cache.
    with _lock:
        cached = _cache.get(code)
    if cached and cached[0] == frame[1]:
        return cached[1]
    jpeg = compose(frame[0], game, host_name)
    with _lock:
        _cache[code] = (frame[1], jpeg)
    return jpeg


def forget(code: str) -> None:
    """Drop a room's cached card (it closed, unlisted or ended its match)."""
    with _lock:
        _cache.pop(code, None)
