"""Render static Open Graph cards with Playwright.

Run from the repository root. Photo-backed game cards are JPEGs (quality 85,
stepped down if necessary); the flat-colour home card remains a PNG. No
rendered images are committed by this script's implementation change.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from src.api.og import GAME_INFO, _build_card_html  # noqa: E402

CARDS_DIR = ROOT / "web" / "static" / "og" / "cards"
HOME_PNG = ROOT / "web" / "static" / "og" / "home.png"
MAX_BYTES = 300 * 1024


async def render(html: str, out_path: Path, browser, *, photo: bool) -> None:
    page = await browser.new_page(viewport={"width": 1200, "height": 630})
    with tempfile.TemporaryDirectory() as tmp:
        card = Path(tmp) / "card.html"
        card.write_text(html, encoding="utf-8")
        try:
            await page.goto(card.as_uri(), wait_until="networkidle")
            await page.evaluate("document.fonts.ready")
            for font in ("Barlow", "Plex"):
                if not await page.evaluate(f"document.fonts.check('700 16px {font}')"):
                    raise RuntimeError(
                        f"{font} did not load for {out_path.name}; not saving"
                    )
            if photo:
                data = b""
                for quality in range(85, 39, -5):
                    data = await page.screenshot(type="jpeg", quality=quality)
                    if len(data) <= MAX_BYTES:
                        break
            else:
                data = await page.screenshot(type="png")
        finally:
            await page.close()
    if len(data) > MAX_BYTES:
        raise RuntimeError(f"{out_path.name} is {len(data)} bytes (limit {MAX_BYTES})")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    print(f"  wrote {out_path.relative_to(ROOT)} ({len(data)} bytes)")


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            print("Generating per-game cards…")
            for game_id in GAME_INFO:
                for spectate, suffix in ((False, "play"), (True, "watch")):
                    html = _build_card_html(None, game_id, spectate, None)
                    await render(
                        html, CARDS_DIR / f"{game_id}-{suffix}.jpg", browser, photo=True
                    )
            print("Generating homepage card…")
            html = _build_card_html(None, None, False, None)
            await render(html, HOME_PNG, browser, photo=False)
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
