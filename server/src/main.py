"""
kaillera-next server entry point — V1 (browser-based EmulatorJS netplay).

Starts a single HTTP server on :27888 (the original Kaillera port) that handles:
  - Socket.IO signaling  (/socket.io/)
  - REST API             (/health, /list, /room)
  - Static web frontend  (/ → web/index.html, /static/roms/)

V2 will re-add TCP :45000 + UDP :45000 for Mupen64Plus native netplay.

Entry point: kaillera-server  (see pyproject.toml)
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

import socketio
import uvicorn

from src.api.app import create_app
from src.api.signaling import _cleanup_empty_rooms, configure_cors, rooms, sio

log = logging.getLogger(__name__)

# Path to the web/ directory (one level above server/)
_WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "web")


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_cleanup_empty_rooms())
    yield
    task.cancel()
    # Notify all connected clients before shutdown
    if rooms:
        log.info("Shutting down: notifying %d active room(s)", len(rooms))
        for session_id in list(rooms):
            try:
                await asyncio.wait_for(
                    sio.emit("room-closed", {"reason": "server-shutdown"}, room=session_id),
                    timeout=2.0,
                )
            except Exception:
                pass


def run() -> None:
    """Entry point called by `kaillera-server` CLI command."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    )

    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "*")
    if not allowed_origin:
        log.error("ALLOWED_ORIGIN environment variable is not set. Set it to your domain (e.g. 'https://yourdomain.com') or '*' for development.")
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

    # Use uvloop if available (not on all platforms)
    loop_setting = "auto"
    try:
        import uvloop  # noqa: F401
        loop_setting = "uvloop"
    except ImportError:
        pass

    log.info("kaillera-next · continuing the legacy of Kaillera by Christophe Thibault")
    log.info("Listening on :27888 — the original Kaillera port (loop=%s)", loop_setting)
    uvicorn.run(
        socket_app,
        host="0.0.0.0",
        port=27888,
        log_level="info",
        loop=loop_setting,
        # Trust X-Forwarded-For/Proto from reverse proxy so logs show real
        # client IPs and the app sees the correct scheme (https).
        proxy_headers=True,
        # Disable websocket-level keepalive pings — Socket.IO's Engine.IO
        # layer handles its own ping/pong. The websockets library's legacy
        # protocol has a race condition in _drain_helper that triggers
        # AssertionError when a connection closes mid-ping.
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
