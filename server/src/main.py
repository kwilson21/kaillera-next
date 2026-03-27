"""
kaillera-next server entry point — V1 (browser-based EmulatorJS netplay).

Starts a single HTTP server on :27888 (the original Kaillera port) that handles:
  - Socket.IO signaling  (/socket.io/)
  - REST API             (/health, /list, /room)
  - Static web frontend  (/ → web/index.html, /static/roms/)

V2 will re-add TCP :45000 + UDP :45000 for Mupen64Plus native netplay.

Entry point: kaillera-server  (see pyproject.toml)
"""

import asyncio
import logging
import os
import signal
import sys
from contextlib import asynccontextmanager

import socketio
import uvicorn

from src import state
from src.api.app import cleanup_old_logs, create_app
from src.api.signaling import _cleanup_empty_rooms, configure_cors, rooms, set_shutting_down, sio

log = logging.getLogger(__name__)

# Path to the web/ directory (one level above server/)
_WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "web")


@asynccontextmanager
async def lifespan(_app):
    await state.init()
    restored = await state.load_all_rooms()
    if restored:
        rooms.update(restored)
        log.info("Restored %d room(s) from Redis", len(restored))
    task = asyncio.create_task(_cleanup_empty_rooms())
    log_task = asyncio.create_task(cleanup_old_logs())
    yield
    set_shutting_down()
    task.cancel()
    log_task.cancel()
    if rooms:
        log.info("Shutting down gracefully, %d room(s) preserved in Redis", len(rooms))
    await state.close()


def run() -> None:
    """Entry point called by `kaillera-server` CLI command."""
    from dotenv import load_dotenv

    load_dotenv()  # loads .env from cwd (server/) if it exists

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    )

    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "").strip() or "*"
    if allowed_origin == "REQUIRED":
        log.error(
            "ALLOWED_ORIGIN environment variable is not set. Set it to your domain (e.g. 'https://yourdomain.com') or '*' for development."
        )
        sys.exit(1)
    if allowed_origin == "*":
        log.warning("CORS allowed origin is '*' — set ALLOWED_ORIGIN for production")
    log.info("CORS allowed origin: %s", allowed_origin)
    configure_cors(allowed_origin)

    app = create_app(lifespan=lifespan)

    # Serve web/ as static files — must be mounted BEFORE Socket.IO wraps the app
    from fastapi.staticfiles import StaticFiles

    web_dir = os.path.abspath(_WEB_DIR)
    if os.path.isdir(web_dir):
        app.mount("/static", StaticFiles(directory=os.path.join(web_dir, "static")), name="static")
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
        log.info("Serving web frontend from %s", web_dir)
    else:
        log.warning("web/ directory not found at %s — frontend not served", web_dir)

    # Wrap FastAPI with Socket.IO ASGI middleware
    socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

    # Set shutdown flag immediately on signal, before uvicorn closes connections.
    # This prevents disconnect handlers from corrupting Redis state.
    _original_sigint = signal.getsignal(signal.SIGINT)
    _original_sigterm = signal.getsignal(signal.SIGTERM)

    def _on_shutdown_signal(sig, frame):
        set_shutting_down()
        log.info("Shutdown signal received, preserving room state")
        handler = _original_sigint if sig == signal.SIGINT else _original_sigterm
        if callable(handler):
            handler(sig, frame)
        elif handler == signal.SIG_DFL:
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _on_shutdown_signal)
    signal.signal(signal.SIGTERM, _on_shutdown_signal)

    port = int(os.environ.get("PORT", "27888"))
    log.info("kaillera-next · continuing the legacy of Kaillera by Christophe Thibault")

    # HTTPS if certs are present (enables crossOriginIsolated on all browsers)
    cert_dir = os.path.join(os.path.dirname(__file__), "..", "..", "certs")
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")
    ssl_kwargs = {}
    if os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_kwargs["ssl_certfile"] = cert_file
        ssl_kwargs["ssl_keyfile"] = key_file
        log.info("Listening on :%d (HTTPS)", port)
    else:
        log.info("Listening on :%d", port)

    # Trust proxy headers only from specified IPs (comma-separated).
    # Default "*" trusts all — set TRUSTED_PROXY_IPS in production.
    trusted_proxies = os.environ.get("TRUSTED_PROXY_IPS", "*").strip()

    uvicorn.run(
        socket_app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        # Trust X-Forwarded-For/Proto from reverse proxy so logs show real
        # client IPs and the app sees the correct scheme (https).
        proxy_headers=True,
        forwarded_allow_ips=trusted_proxies,
        # Disable websocket-level keepalive pings — Socket.IO's Engine.IO
        # layer handles its own ping/pong. The websockets library's legacy
        # protocol has a race condition in _drain_helper that triggers
        # AssertionError when a connection closes mid-ping.
        ws_ping_interval=None,
        ws_ping_timeout=None,
        **ssl_kwargs,
    )
