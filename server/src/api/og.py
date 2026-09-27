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


def _kn_letters_path() -> str:
    """The KN tile's letters, read from the favicon so the cards and the tab
    icon can't drift apart (docs/landing-design.md §5.8)."""
    svg = (_OG_DIR.parent / "favicon.svg").read_text()
    match = re.search(r'<path[^>]*\sd="([^"]+)"', svg)
    return match.group(1) if match else ""


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
    """Build a self-contained 1200×630 Direction A preview card."""
    import base64

    game_info = GAME_INFO.get(game_id) if game_id else None
    image_path = _OG_DIR / game_info["image"] if game_info else None
    has_game_bg = bool(game_images_enabled and image_path and image_path.exists())
    bg_css = ""
    if has_game_bg and image_path:
        encoded = base64.b64encode(image_path.read_bytes()).decode()
        mime = "jpeg" if image_path.suffix.lower() in {".jpg", ".jpeg"} else image_path.suffix.lstrip(".")
        bg_css = f'background-image:url("data:image/{mime};base64,{encoded}");'

    is_homepage = room_name is None and game_id is None
    host_name = room_name or (player_names or [None])[0]
    host = _html_escape(host_name) if host_name else None
    game = _html_escape(game_info["name"] if game_info else game_id or "a retro game")
    if is_homepage:
        eyebrow = "PLAY TOGETHER"
        headline = "kaillera-next"
        detail = "Super Smash Bros. 64 online with friends. In your browser. No install."
        footer = "Free · No install · Bring your own ROM"
    else:
        eyebrow = "WATCH LIVE" if spectate else "YOU'RE INVITED"
        if spectate:
            headline = f"Come watch {host}'s room" if host else f"Watch {game} live"
        else:
            headline = f"{host} invited you to play {game}" if host else f"You're invited to play {game}"
        detail = "Live in your browser" if spectate else "Up to 4 players · in your browser"
        footer = "Free · No install · Bring your own ROM"

    logo = f"""<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#0e1218" stroke="#242c39"/>
      <path d="{_kn_letters_path()}" fill="#5aa8ff"/>
    </svg>"""
    corner_logo = "" if has_game_bg else logo
    footer_logo = logo.replace('class="logo"', 'class="footer-logo"').replace(
        'aria-hidden="true"', 'role="img" aria-label="kaillera-next"'
    )
    footer_content = (
        f"{footer_logo}{footer}" if has_game_bg else (footer if is_homepage else f"kaillera-next · {footer}")
    )
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:Barlow;src:url('file://{_OG_DIR.parent / "fonts" / "barlow-condensed-700-latin.woff2"}') format('woff2');font-weight:700}}
@font-face{{font-family:Plex;src:url('file://{_OG_DIR.parent / "fonts" / "ibm-plex-sans-var-latin.woff2"}') format('woff2');font-weight:400 600}}
*{{box-sizing:border-box}}html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}body{{background:#0e1218;color:#e8ecf1;font-family:Plex,system-ui,sans-serif}}
.card{{position:relative;width:100%;height:100%;{bg_css}background-size:cover;background-position:center}}
.shade{{position:absolute;inset:0;background:{"linear-gradient(90deg,rgba(14,18,24,.97) 0%,rgba(14,18,24,.88) 52%,rgba(14,18,24,.30) 100%)" if has_game_bg else "linear-gradient(135deg,#0e1218 0%,#151b25 70%,#17283d 100%)"}}}
.rule{{position:absolute;left:64px;top:58px;width:72px;height:6px;background:#5aa8ff}}.logo{{position:absolute;right:58px;top:52px;width:76px;height:76px}}
.copy{{position:absolute;left:64px;right:210px;top:92px;bottom:65px;display:flex;flex-direction:column;justify-content:center}}
.eyebrow{{font:700 28px Barlow,sans-serif;letter-spacing:.16em;color:#5aa8ff;margin-bottom:16px}}
.headline{{font:700 {104 if is_homepage else 76}px/.92 Barlow,'Arial Narrow',sans-serif;letter-spacing:-.02em;text-transform:{"none" if is_homepage else "uppercase"};max-width:940px}}
.detail{{font:400 33px/1.25 Plex,sans-serif;color:#c3cad3;margin-top:25px;max-width:850px}}.footer{{position:absolute;left:64px;bottom:43px;display:flex;align-items:center;gap:12px;font:600 24px Plex,sans-serif;color:#8b95a5}}.footer-logo{{width:40px;height:40px;flex:none}}
</style></head><body><div class="card"><div class="shade"></div><div class="rule"></div>{corner_logo}<main class="copy"><div class="eyebrow">{eyebrow}</div><div class="headline">{headline}</div><div class="detail">{detail}</div></main><div class="footer">{footer_content}</div></div></body></html>"""


# ── HTML meta tag injection ───────────────────────────────────────────────────

_HEAD_RE = re.compile(r"(<head[^>]*>)", re.IGNORECASE)


def build_og_tags(
    host: str,
    room_id: str | None = None,
    room_name: str | None = None,
    game_id: str | None = None,
    spectate: bool = False,
    image_url: str | None = None,
    join_page: bool = False,
) -> str:
    """Build OG meta tag HTML string for injection into <head>.

    Every value that lands inside a content="..." attribute is HTML-escaped;
    every value that lands inside a URL is percent-encoded with quote(safe="").
    Treat callers as untrusted: room_name in particular flows from query
    strings on the missing-room fallback path.
    """
    game_info = GAME_INFO.get(game_id) if game_id else None

    # Card images are now prebuilt static images (see scripts/generate_og_cards.py).
    # Pick the per-game card if we recognize the game, else fall back to home.png.
    if image_url:
        pass  # caller composed a live card (og_card.py)
    elif game_info:
        suffix = "watch" if spectate else "play"
        image_url = f"https://{host}/static/og/cards/{quote(game_id, safe='')}-{suffix}.jpg"
    else:
        image_url = f"https://{host}/static/og/home.png"

    if room_id and room_name:
        game_label = game_info["name"] if game_info else (game_id or "")
        title = f"Come watch! {room_name} is playing" if spectate else f"Ready to fight? {room_name} is waiting"
        if game_label:
            title += f" \u00b7 {game_label}"
        description = "kaillera-next \u2014 play retro games online with friends"
        if join_page:
            page_url = f"https://{host}/join?room={quote(room_id, safe='')}"
        else:
            page_url = f"https://{host}/play.html?room={quote(room_id, safe='')}"
        if game_id and not join_page:
            page_url += f"&game={quote(game_id, safe='')}"
        if spectate:
            page_url += "&spectate=1"
    else:
        title = "kaillera-next"
        description = "Play retro games online with friends \u2014 no install needed"
        page_url = f"https://{host}/"

    image_type = "image/jpeg" if image_url.lower().split("?", 1)[0].endswith((".jpg", ".jpeg")) else "image/png"
    return (
        f'<meta property="og:title" content="{_html_escape(title)}" />\n'
        f'    <meta property="og:description" content="{_html_escape(description)}" />\n'
        f'    <meta property="og:image" content="{_html_escape(image_url)}" />\n'
        f'    <meta property="og:image:type" content="{image_type}" />\n'
        f'    <meta property="og:image:width" content="1200" />\n'
        f'    <meta property="og:image:height" content="630" />\n'
        f'    <meta property="og:url" content="{_html_escape(page_url)}" />\n'
        f'    <meta property="og:type" content="website" />\n'
        f'    <meta name="twitter:card" content="summary_large_image" />'
    )


# The static pages carry generic tags for the landing Worker's copy; the
# server's own tags replace them.
_STATIC_OG_RE = re.compile(r"[ \t]*<!-- og:static.*?<!-- /og:static -->\n?", re.DOTALL)


def inject_og_tags(html: str, og_tags: str) -> str:
    """Inject OG meta tags into cached HTML by inserting after <head> opening tag,
    replacing the page's static fallback block if it has one."""
    html = _STATIC_OG_RE.sub("", html, count=1)
    return _HEAD_RE.sub(lambda m: f"{m.group(1)}\n    {og_tags}", html, count=1)


def _keepalive_seconds() -> int:
    """KEEPALIVE_SECONDS: how often the play page pings /health; 0 (default) is off."""
    try:
        return max(0, int(os.environ.get("KEEPALIVE_SECONDS", "0")))
    except ValueError:
        return 0


def _inject_kn_config(html: str, *, rom_sharing_enabled: bool) -> str:
    """Inject server-side feature flags as window.KN_CONFIG before </head>."""
    config_js = (
        f'<script>window.KN_CONFIG = {{"romSharingEnabled": {"true" if rom_sharing_enabled else "false"}, '
        f'"keepaliveSeconds": {_keepalive_seconds()}}};</script>'
    )
    return html.replace("</head>", f"  {config_js}\n</head>", 1)
