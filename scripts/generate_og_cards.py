"""Render static Open Graph cards as PNGs using Playwright.

Run from repo root: `uv run python scripts/generate_og_cards.py`

Output: web/static/og/cards/{game_id}-{play|watch}.png plus web/static/og/home.png.
The runtime server serves these as static files; there is no per-request browser.

Add a game by adding an entry to GAME_INFO in server/src/api/og.py and rerunning.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Make the server package importable when running from repo root
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from src.api.og import GAME_INFO, _build_card_html  # noqa: E402

CARDS_DIR = ROOT / "web" / "static" / "og" / "cards"
HOME_PNG = ROOT / "web" / "static" / "og" / "home.png"


async def render(html: str, out_path: Path, browser) -> None:
    page = await browser.new_page(viewport={"width": 1200, "height": 630})
    try:
        await page.set_content(html, wait_until="networkidle")
        png = await page.screenshot(type="png")
    finally:
        await page.close()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png)
    print(f"  wrote {out_path.relative_to(ROOT)} ({len(png)} bytes)")


async def main() -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            print("Generating per-game cards…")
            for game_id in GAME_INFO:
                for spectate, suffix in ((False, "play"), (True, "watch")):
                    html = _build_card_html(
                        room_name=None, game_id=game_id, spectate=spectate, player_names=None
                    )
                    await render(html, CARDS_DIR / f"{game_id}-{suffix}.png", browser)

            print("Generating homepage card…")
            html = _build_card_html(room_name=None, game_id=None, spectate=False, player_names=None)
            await render(html, HOME_PNG, browser)
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
