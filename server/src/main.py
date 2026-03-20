"""
kaillera-next server entry point — V1 (browser-based EmulatorJS netplay).

Starts a single HTTP server on :8000 that handles:
  - Socket.IO signaling  (/socket.io/)
  - REST API             (/health, /list, /room)
  - Static web frontend  (/ → web/index.html, /static/rom/ssb64.z64)

V2 will re-add TCP :45000 + UDP :45000 for Mupen64Plus native netplay.

Entry point: kaillera-server  (see pyproject.toml)
"""

from __future__ import annotations

import asyncio
import logging
import os

import socketio
import uvicorn
import uvloop

from src.api.app import create_app
from src.api.signaling import _cleanup_empty_rooms, configure_cors, sio

log = logging.getLogger(__name__)

# Path to the web/ directory (one level above server/)
_WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "web")


def run() -> None:
    """Entry point called by `kaillera-server` CLI command."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    )

    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "*")
    log.info("CORS allowed origin: %s", allowed_origin)
    configure_cors(allowed_origin)

    app = create_app()

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

    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())

    @app.on_event("startup")
    async def startup() -> None:
        asyncio.create_task(_cleanup_empty_rooms())

    log.info("HTTP + Socket.IO listening on :8000")
    uvicorn.run(socket_app, host="0.0.0.0", port=8000, log_level="info")
