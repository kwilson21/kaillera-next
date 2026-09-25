"""ALLOWED_ORIGIN must reach the Engine.IO layer, where Socket.IO checks origins.

configure_cors() used to set only sio.cors_allowed_origins; Engine.IO kept
the constructor's [] (no check), so any website could open a socket.

    pytest tests/test_socket_cors.py --noconftest -p no:playwright
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from src.api import signaling  # noqa: E402


def test_configure_cors_reaches_engineio():
    before = signaling.sio.eio.cors_allowed_origins
    try:
        signaling.configure_cors(["https://a.example", "https://b.example"])
        assert signaling.sio.eio.cors_allowed_origins == [
            "https://a.example",
            "https://b.example",
        ]
        signaling.configure_cors("*")
        assert signaling.sio.eio.cors_allowed_origins == "*"
    finally:
        signaling.sio.eio.cors_allowed_origins = before
