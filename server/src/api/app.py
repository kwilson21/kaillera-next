"""
FastAPI application — frontend WebSocket protocol + REST matchmaking API.

V1 endpoints:
  GET  /health
  GET  /list?game_id=...        EmulatorJS-Netplay room listing
  GET  /room/{room_id}          minimal room info (rate-limited)
  GET  /ice-servers             WebRTC ICE server config
  GET  /og-image/{room_id}.png  dynamic OG card image (Playwright screenshot)
  GET  /play.html               play page with injected OG meta tags
  GET  /                        homepage with injected OG meta tags
  GET  /api/cached-state/{h}    download cached save state
  POST /api/cache-state/{h}     upload save state to cache
  POST /api/session-log          HTTP fallback for session log flush
  POST /api/client-event        submit client error/diagnostic event
  POST /api/feedback            submit user feedback

Admin endpoints (auth via ADMIN_KEY env var):
  GET  /admin/api/stats                    server stats (DB-backed counts)
  GET  /admin/api/session-logs             list session logs (filtered, paged)
  GET  /admin/api/session-logs/{id}        session log detail
  GET  /admin/api/client-events            list client events (filtered, paged)
  GET  /admin/api/client-events/{id}       client event detail
  GET  /admin/api/feedback                 list feedback entries
  GET  /admin/api/feedback/{id}            single feedback entry
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess as _sp
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, Response, StreamingResponse

from src import db, state
from src.api.og import (
    _GAME_IMAGES_RAW,
    _ROM_SHARING_RAW,
    _inject_kn_config,
    build_og_tags,
    feature_enabled_for_host,
    generate_og_image,
    inject_og_tags,
)
from src.api.payloads import FeedbackPayload
from src.api.signaling import MAX_ROOMS, rooms, verify_upload_token
from src.ratelimit import check_ip, extract_ip, ip_hash

log = logging.getLogger(__name__)

_CLIENT_EVENT_MAX_SIZE = 4 * 1024  # 4KB max per event
_VALID_EVENT_TYPES = {
    "webrtc-fail",
    "wasm-fail",
    "desync",
    "stall",
    "reconnect",
    "audio-fail",
    "unhandled",
    "compat",
    "session-end",
    # Funnel telemetry stages (P0-1) — see project_launch_readiness_plan
    "room_created",
    "peer_joined",
    "webrtc_connected",
    "rom_loaded",
    "emulator_booted",
    "first_frame_rendered",
    "milestone_reached",
    "peer_left",
    "peer_reconnected",
}

_FEEDBACK_CONTEXT_MAX = 4096  # 4KB max for context JSON


async def cleanup_old_data() -> None:
    """Background task: delete session logs and client events older than retention period."""
    while True:
        await asyncio.sleep(86400)  # daily
        try:
            days = int(os.environ.get("LOG_RETENTION_DAYS", "14"))
            await db.execute_write(
                "DELETE FROM session_logs WHERE created_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            await db.execute_write(
                "DELETE FROM client_events WHERE created_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            log.info("DB cleanup complete (retention: %d days)", days)
        except Exception as e:
            log.warning("DB cleanup error: %s", e)


def _client_ip(request: Request) -> str:
    """Extract the real client IP, checking Cloudflare headers first."""
    return extract_ip(request)


# In-memory save state cache: rom_hash -> raw state bytes.
# Eliminates host/guest asymmetry — all players load the same cached state.
# Persists across games but not server restarts.
_state_cache: dict[str, bytes] = {}
_STATE_MAX_SIZE = 20 * 1024 * 1024  # 20MB raw save state


# ── Security headers middleware ───────────────────────────────────────────────


class SecurityHeadersMiddleware:
    """Pure ASGI middleware that injects security and cache-control headers."""

    _CSP = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "connect-src 'self' blob:; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "object-src 'none'"
    )

    def __init__(self, app, allow_cache: bool = False) -> None:  # noqa: FBT001, FBT002
        self.app = app
        self._allow_cache = allow_cache

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Extract the request path for cache-control decisions.
        path: str = scope.get("path", "/")

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                extra: list[tuple[bytes, bytes]] = [
                    (b"content-security-policy", self._CSP.encode()),
                    (b"x-frame-options", b"SAMEORIGIN"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"strict-transport-security", b"max-age=63072000; includeSubDomains"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"cache-control", self._cache_control(path).encode()),
                ]
                # COOP/COEP breaks OG image fetches by crawlers
                if not path.startswith(("/og-image/", "/static/og/")):
                    extra.append((b"cross-origin-opener-policy", b"same-origin"))
                    extra.append((b"cross-origin-embedder-policy", b"require-corp"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _cache_control(self, path: str) -> str:
        if not self._allow_cache:
            return "no-store, no-cache, must-revalidate, max-age=0"
        # WASM core + data — content-addressed via /api/core-info?h=<hash>,
        # so the URL itself changes when the file changes. Safe to cache for
        # a year (browsers + Cloudflare both treat ?h=… as part of the cache
        # key, so a new file = new URL = guaranteed cache miss).
        if path.startswith("/static/ejs/cores/"):
            return "public, max-age=31536000, immutable"
        # JS/CSS — always revalidate via ETag (304 if unchanged)
        if path.endswith((".js", ".css")):
            return "no-cache"
        # HTML pages — always revalidate (ETag still avoids re-download)
        if path.endswith(".html") or path == "/":
            return "no-cache"
        # API responses and everything else
        return "no-store"


# ── Cache busting middleware ──────────────────────────────────────────────────


_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "web", "static")
_VERSION_CACHE: dict = {"key": None, "value": "dev"}


def _git_head_version() -> str:
    """Resolve git HEAD short hash, or empty string if unavailable."""
    v = os.environ.get("GIT_VERSION", "").strip()
    if v:
        return v
    try:
        result = _sp.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=os.path.dirname(__file__),
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _static_mtime_signature() -> tuple[int, int]:
    """Cheap signature of static asset state — (max mtime, file count).

    Stat-only, no content reads. Recomputed every request, but stat is fast
    enough that walking ~30 files is sub-millisecond on local SSD.
    """
    max_mtime = 0
    count = 0
    try:
        for root, _, files in os.walk(_STATIC_DIR):
            for f in files:
                if f.endswith((".js", ".css", ".html", ".json")):
                    try:
                        st = os.stat(os.path.join(root, f))
                        if st.st_mtime_ns > max_mtime:
                            max_mtime = st.st_mtime_ns
                        count += 1
                    except OSError:
                        pass
    except Exception:
        pass
    return (max_mtime, count)


def _asset_version() -> str:
    """Derive a cache-busting version that reflects ACTUAL file state.

    The CacheBustMiddleware appends `?v=<this>` to every /static/ URL in
    served HTML. To force browsers to refetch JS/CSS after a file change,
    this string MUST change whenever the file contents change.

    Resolution order:
      1. GIT_VERSION env var (explicit override, e.g. CI/CD pipeline)
      2. git HEAD short hash combined with static-asset mtime signature.
         The mtime signature catches local edits that haven't been committed
         (the original git-HEAD-only version was stale across hot reloads
         and caused the 2026-04-07 dev test to silently serve cached JS
         despite a verified disk update).
      3. Pure mtime/count signature when git is unavailable.
      4. "dev" fallback.

    Cached by mtime signature so the cost of repeated calls is just a
    handful of stat() syscalls per request — no file reads.
    """
    sig = _static_mtime_signature()
    cached = _VERSION_CACHE
    if cached["key"] == sig:
        return cached["value"]

    git = _git_head_version()
    if sig[0] > 0:
        # 8-char base36 of mtime_ns is plenty unique for cache busting.
        mtime_tag = format(sig[0] & 0xFFFFFFFFFF, "x")[-8:]
        version = f"{git}-{mtime_tag}" if git else f"dev-{mtime_tag}"
    elif git:
        version = git
    else:
        version = "dev"

    _VERSION_CACHE["key"] = sig
    _VERSION_CACHE["value"] = version
    return version


# ── WASM core auto-discovery + content hash ──────────────────────────────────
#
# The patched WASM core is served with `Cache-Control: immutable, max-age=1y`
# so browsers and Cloudflare edge nodes will never refetch it on their own.
# To force a rollout when the WASM changes, the URL itself must change.
#
# We compute a SHA-256 prefix from the file contents at server startup and
# expose it via /api/core-info as `?h=<hash>`. The client (core-redirector.js)
# fetches that URL once at boot and uses it as the canonical core URL.
# Different content -> different hash -> different URL -> guaranteed cache miss
# at every layer (browser, Cloudflare, IDB). No human bookkeeping required.
#
# Re-checked on every request via mtime so a new file dropped into prod is
# picked up automatically without needing to restart the server.

_CORE_RELATIVE_PATH = "static/ejs/cores/mupen64plus_next-wasm.data"
_core_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "web", _CORE_RELATIVE_PATH)
_core_info_cache: dict | None = None
_core_info_mtime: float = 0.0


def _compute_core_info() -> dict:
    """Read the WASM core file and compute a content-addressed URL."""
    try:
        st = os.stat(_core_path)
    except FileNotFoundError:
        return {
            "url": "/" + _CORE_RELATIVE_PATH,
            "hash": "",
            "size": 0,
            "available": False,
        }
    h = hashlib.sha256()
    with open(_core_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    hash_prefix = h.hexdigest()[:16]
    return {
        "url": f"/{_CORE_RELATIVE_PATH}?h={hash_prefix}",
        "hash": hash_prefix,
        "size": st.st_size,
        "available": True,
    }


def _get_core_info() -> dict:
    """Returns cached core info, recomputing if the WASM file's mtime changes."""
    global _core_info_cache, _core_info_mtime
    try:
        mtime = os.stat(_core_path).st_mtime
    except FileNotFoundError:
        mtime = 0.0
    if _core_info_cache is None or mtime != _core_info_mtime:
        _core_info_cache = _compute_core_info()
        _core_info_mtime = mtime
    return _core_info_cache


class CacheBustMiddleware:
    """Appends ?v=<version> to /static/ asset references in HTML responses.

    The version is recomputed per-request via the `version_fn` callback so
    that hot-edited files in dev (and any production rolling restart) get a
    fresh URL immediately, without needing the server to restart.
    """

    _STATIC_REF = re.compile(rb'((?:src|href)=["\'])(/static/[^"\'?\s]+)(["\'])')

    def __init__(self, app, version_fn) -> None:  # noqa: ANN001
        self.app = app
        self._version_fn = version_fn

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "/")
        if path.startswith(("/static/", "/api/", "/socket.io/", "/admin/api/", "/og-image/")):
            await self.app(scope, receive, send)
            return

        start_message = None
        body_chunks: list[bytes] = []
        is_html = False

        async def capture_send(message: dict) -> None:
            nonlocal start_message, is_html
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                is_html = b"text/html" in headers.get(b"content-type", b"")
                if is_html:
                    start_message = message
                else:
                    await send(message)
            elif message["type"] == "http.response.body":
                if not is_html:
                    await send(message)
                else:
                    body_chunks.append(message.get("body", b""))
                    if not message.get("more_body", False):
                        body = b"".join(body_chunks)
                        version_bytes = self._version_fn().encode()
                        body = self._STATIC_REF.sub(
                            lambda m: m.group(1) + m.group(2) + b"?v=" + version_bytes + m.group(3),
                            body,
                        )
                        new_headers = [
                            (k, str(len(body)).encode()) if k == b"content-length" else (k, v)
                            for k, v in start_message.get("headers", [])
                        ]
                        start_message["headers"] = new_headers
                        await send(start_message)
                        await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, capture_send)


# ── Error page middleware ─────────────────────────────────────────────────────


class ErrorPageMiddleware:
    """ASGI middleware that serves custom HTML error pages for browser requests.

    Intercepts 404/500/429 responses for requests that accept text/html and
    are not on API paths. Injects the status code into the HTML template.
    """

    _API_PREFIXES = ("/api/", "/admin/api/", "/socket.io/", "/health", "/list", "/room/", "/ice-servers", "/og-image/")

    def __init__(self, app, error_html: str) -> None:  # noqa: ANN001
        self.app = app
        self._error_html = error_html

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        # Skip API paths — they return JSON
        if any(path.startswith(p) for p in self._API_PREFIXES):
            await self.app(scope, receive, send)
            return

        # Only intercept browser navigation (Accept: text/html)
        headers = dict(scope.get("headers", []))
        accept = headers.get(b"accept", b"").decode()
        if "text/html" not in accept:
            await self.app(scope, receive, send)
            return

        # Capture response; replace error status with custom page
        intercepted = False

        async def capture_send(message: dict) -> None:
            nonlocal intercepted
            if message["type"] == "http.response.start":
                status = message["status"]
                if status in (404, 500, 429):
                    intercepted = True
                    html = self._error_html.replace("{{CODE}}", str(status))
                    body = html.encode()
                    await send(
                        {
                            "type": "http.response.start",
                            "status": status,
                            "headers": [
                                (b"content-type", b"text/html; charset=utf-8"),
                                (b"content-length", str(len(body)).encode()),
                            ],
                        }
                    )
                    await send({"type": "http.response.body", "body": body})
                    return
                await send(message)
            elif message["type"] == "http.response.body":
                if not intercepted:
                    await send(message)

        await self.app(scope, receive, capture_send)


# ── App factory ───────────────────────────────────────────────────────────────


def create_app(lifespan=None) -> FastAPI:
    """Create and return the FastAPI app."""
    app = FastAPI(
        title="kaillera-next",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    production = os.environ.get("ALLOWED_ORIGIN", "*") != "*"
    version = _asset_version()
    # Pass the function (not the value) so the middleware re-evaluates
    # per-request — file edits propagate without a server restart.
    app.add_middleware(CacheBustMiddleware, version_fn=_asset_version)
    app.add_middleware(SecurityHeadersMiddleware, allow_cache=production)

    # Load error page template
    _error_html_path = Path(os.path.dirname(__file__)).parent.parent.parent / "web" / "error.html"
    if _error_html_path.exists():
        _error_html = _error_html_path.read_text()
        app.add_middleware(ErrorPageMiddleware, error_html=_error_html)
        log.info("Custom error pages loaded")
    else:
        log.warning("web/error.html not found — using default error responses")

    log.info("Cache bust version: %s", version)

    # Pre-compute allowed hosts set once at app creation time
    _raw_origin = os.environ.get("ALLOWED_ORIGIN", "").strip()
    _allowed_hosts: set[str] | None = None
    if _raw_origin and _raw_origin != "*":
        _allowed_hosts = set()
        for _origin in _raw_origin.split(","):
            _origin = _origin.strip().rstrip("/")
            if "://" in _origin:
                _origin = _origin.split("://", 1)[1]
            _allowed_hosts.add(_origin)
            if ":" in _origin:
                _allowed_hosts.add(_origin.split(":")[0])
        _allowed_hosts.add("localhost")

    def _validated_host(request: Request) -> str:
        """Return the Host header if it matches ALLOWED_ORIGIN, else a safe fallback."""
        host = request.headers.get("host", "localhost")
        if _allowed_hosts is None:
            return host
        if host in _allowed_hosts:
            return host
        return next(iter(_allowed_hosts))

    @app.get("/favicon.ico", include_in_schema=False)
    @app.get("/apple-touch-icon.png", include_in_schema=False)
    @app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
    async def favicon_redirect() -> RedirectResponse:
        return RedirectResponse(url="/static/favicon.svg", status_code=302)

    @app.get("/health")
    async def health() -> dict:
        redis_ok = await state.ping()
        return {
            "status": "ok" if redis_ok else "degraded",
            "redis": redis_ok,
            "rooms": len(rooms),
            "players": sum(len(r.players) for r in rooms.values()),
        }

    # Patched WASM core auto-discovery. Returns the canonical URL of the
    # current core file with a content-hash query param so cache-busting
    # is automatic. See `_compute_core_info` for the rationale.
    @app.get("/api/core-info")
    async def core_info() -> dict:
        return _get_core_info()

    @app.get("/ice-servers")
    def ice_servers(request: Request) -> list:
        if not check_ip(_client_ip(request), "ice-servers"):
            raise HTTPException(status_code=429, detail="Rate limited")

        # Public STUN servers (free, no auth needed)
        stun_servers = [
            {"urls": "stun:stun.cloudflare.com:3478"},
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": "stun:stun1.l.google.com:19302"},
        ]

        # Verify request is from an active room participant
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not token or not room_id or room_id not in rooms or not verify_upload_token(room_id, token):
            return stun_servers

        # Check for legacy static ICE_SERVERS (backwards compatible)
        legacy = os.environ.get("ICE_SERVERS")
        if legacy:
            try:
                return json.loads(legacy)
            except json.JSONDecodeError:
                log.warning("ICE_SERVERS env var contains invalid JSON")

        # Generate HMAC time-limited TURN credentials
        turn_secret = os.environ.get("TURN_SECRET", "")
        turn_urls_raw = os.environ.get("TURN_SERVERS", "")
        if not turn_secret or not turn_urls_raw:
            return stun_servers

        # Credentials expire in 24 hours (username = expiry:random_id)
        expiry = int(time.time()) + 86400
        username = f"{expiry}:{room_id}"
        mac = hmac.new(turn_secret.encode(), username.encode(), hashlib.sha1)
        credential = base64.b64encode(mac.digest()).decode()

        # Build TURN server entries from comma-separated TURN_SERVERS env
        turn_entries = []
        for url in turn_urls_raw.split(","):
            url = url.strip()
            if url:
                turn_entries.append(
                    {
                        "urls": url,
                        "username": username,
                        "credential": credential,
                    }
                )

        return stun_servers + turn_entries

    @app.get("/room/{room_id}")
    def get_room(room_id: str, request: Request) -> dict:
        if not check_ip(_client_ip(request), "room-lookup"):
            raise HTTPException(status_code=429, detail="Rate limited")
        room = rooms.get(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        return {
            "status": room.status,
            "player_count": len(room.players),
            "max_players": room.max_players,
            "has_password": room.password is not None,
            "rom_hash": room.rom_hash,
            "rom_sharing": room.rom_sharing,
            "mode": room.mode,
        }

    @app.get("/list")
    def list_rooms(request: Request, game_id: str | None = None) -> list:
        if not check_ip(_client_ip(request), "room-lookup"):
            raise HTTPException(status_code=429, detail="Rate limited")
        result = []
        for room in rooms.values():
            if game_id and room.game_id != game_id:
                continue
            first_player = next(iter(room.players.values()), {})
            result.append(
                {
                    "room_name": room.room_name,
                    "host_name": first_player.get("playerName", ""),
                    "game_id": room.game_id,
                    "player_count": len(room.players),
                    "max_players": room.max_players,
                    "status": room.status,
                    "has_password": room.password is not None,
                }
            )
        return result

    _ROM_HASH_RE = re.compile(r"^[SF]?[0-9a-fA-F]{16,64}$")
    _MAX_CACHE_ENTRIES = 50

    def _validate_rom_hash(rom_hash: str) -> None:
        """Ensure rom_hash is a valid hex string, optionally prefixed with S (SHA-256) or F (FNV)."""
        if not _ROM_HASH_RE.match(rom_hash):
            raise HTTPException(status_code=400, detail="Invalid ROM hash format")

    def _rom_hash_in_active_room(rom_hash: str) -> bool:
        """Check if any active room references this ROM hash."""
        return any(r.rom_hash == rom_hash for r in rooms.values())

    @app.get("/api/cached-state/{rom_hash}")
    async def get_cached_state(rom_hash: str, request: Request) -> Response:
        if not check_ip(_client_ip(request), "cache-state"):
            raise HTTPException(status_code=429, detail="Rate limited")
        _validate_rom_hash(rom_hash)
        if rom_hash not in _state_cache:
            raise HTTPException(status_code=404, detail="No cached state")
        return Response(
            content=_state_cache[rom_hash],
            media_type="application/octet-stream",
        )

    @app.post("/api/cache-state/{rom_hash}")
    async def cache_state(rom_hash: str, request: Request) -> dict:
        if not check_ip(_client_ip(request), "cache-state"):
            raise HTTPException(status_code=429, detail="Rate limited")
        _validate_rom_hash(rom_hash)
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not room_id or not verify_upload_token(room_id, token):
            raise HTTPException(status_code=403, detail="Invalid upload token")
        if not _rom_hash_in_active_room(rom_hash):
            raise HTTPException(status_code=403, detail="ROM hash not associated with any active room")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > _STATE_MAX_SIZE:
                raise HTTPException(status_code=413, detail="State too large")
            chunks.append(chunk)
        body = b"".join(chunks)
        if len(_state_cache) >= _MAX_CACHE_ENTRIES and rom_hash not in _state_cache:
            log.warning("State cache full (%d entries)", _MAX_CACHE_ENTRIES)
            raise HTTPException(status_code=507, detail="Cache full")
        _state_cache[rom_hash] = body
        log.info("Cached save state for ROM %s (%d KB)", rom_hash[:16], len(body) // 1024)
        return {"status": "cached", "size": len(body)}

    # ── Auth dependencies ─────────────────────────────────────────────

    def _require_upload_token(request: Request) -> None:
        """Dependency: rate limit + verify upload token against room query param."""
        if not check_ip(_client_ip(request), "client-event"):
            raise HTTPException(status_code=429, detail="Rate limited")
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not token or not room_id or room_id not in rooms or not verify_upload_token(room_id, token):
            raise HTTPException(status_code=403, detail="Invalid token")

    def _require_admin(request: Request) -> None:
        """Dependency: rate limit + admin key verification."""
        if not check_ip(_client_ip(request), "admin"):
            raise HTTPException(status_code=429, detail="Rate limited")
        _admin_auth(request)

    # ── Session log HTTP fallback ─────────────────────────────────────────
    # Mirrors the Socket.IO session-log handler but over HTTP.
    # Used when socket.emit fails (browser quirks, transport issues).

    _SESSION_LOG_HTTP_MAX = 2 * 1024 * 1024  # 2MB — same as Socket.IO handler

    def _require_upload_token_relaxed(request: Request) -> None:
        """Verify upload token HMAC without requiring the room to still exist."""
        if not check_ip(_client_ip(request), "session-log"):
            raise HTTPException(status_code=429, detail="Rate limited")
        token = request.query_params.get("token", "")
        room_id = request.query_params.get("room", "")
        if not token or not room_id or not verify_upload_token(room_id, token):
            raise HTTPException(status_code=403, detail="Invalid token")

    @app.post("/api/session-log")
    async def session_log_http(request: Request, _auth: None = Depends(_require_upload_token_relaxed)) -> dict:
        body = await request.body()
        if len(body) > _SESSION_LOG_HTTP_MAX:
            raise HTTPException(status_code=413, detail="Payload too large")
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty payload")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc

        match_id = data.get("matchId", "")
        if not match_id:
            raise HTTPException(status_code=400, detail="Missing matchId")

        room_id = request.query_params.get("room", "")
        slot = data.get("slot")
        player_name = str(data.get("playerName", ""))[:32]
        mode = str(data.get("mode", ""))[:16]

        entries = data.get("entries", [])
        if not isinstance(entries, list):
            entries = []
        log_data_str = json.dumps(entries)
        while len(log_data_str) > _SESSION_LOG_HTTP_MAX and entries:
            entries = entries[: len(entries) // 2]
            log_data_str = json.dumps(entries)

        summary = data.get("summary", {})
        context = data.get("context", {})
        # kaillera-next: include inputAudit in the context column. The audit
        # is a delta-encoded dict of the local + remote input histories used
        # for cross-peer diffing. See Option G in the rollback diagnostics.
        input_audit = data.get("inputAudit")
        if isinstance(input_audit, dict) and isinstance(context, dict):
            context["inputAudit"] = input_audit
        summary_str = json.dumps(summary) if isinstance(summary, dict) else "{}"
        context_str = json.dumps(context) if isinstance(context, dict) else "{}"
        if len(summary_str) > 4096:
            summary_str = "{}"
        # context may contain inputAudit (Option G), which can reach up to
        # ~1 MB per side. Allow up to 2 MB — same budget as log_data.
        if len(context_str) > 2 * 1024 * 1024:
            # Drop the audit rather than the whole context.
            if isinstance(context, dict) and "inputAudit" in context:
                context.pop("inputAudit", None)
            context_str = json.dumps(context)
            if len(context_str) > 4096:
                context_str = "{}"

        hashed_ip = ip_hash(_client_ip(request))
        await db.upsert_session_log(
            {
                "match_id": match_id,
                "room": room_id,
                "slot": slot,
                "player_name": player_name,
                "mode": mode,
                "log_data": log_data_str,
                "summary": summary_str,
                "context": context_str,
                "ip_hash": hashed_ip,
            }
        )
        log.info("Session log (HTTP fallback): match=%s room=%s slot=%s", match_id[:8], room_id, slot)
        return {"status": "saved"}

    # ── ROM hash table ──────────────────────────────────────────────────

    # Load known ROM hashes from config file into memory once at import time.
    _known_roms_path = os.path.join(os.path.dirname(__file__), "..", "..", "config", "known_roms.json")
    _known_roms: dict = {}
    try:
        with open(_known_roms_path) as _f:
            _known_roms = {
                entry["sha256"]: {"game": entry["game"], "region": entry.get("region"), "format": entry.get("format")}
                for entry in json.load(_f)
            }
        log.info("Loaded %d known ROM(s) from %s", len(_known_roms), _known_roms_path)
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as _e:
        log.warning("Failed to load known_roms config: %s", _e)

    _known_roms_json = json.dumps(_known_roms)

    @app.get("/api/rom-hashes")
    async def get_rom_hashes() -> Response:
        """Return known ROM hash table for client-side verification."""
        return Response(
            content=_known_roms_json,
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=3600"},
        )

    # ── Client event beacon ─────────────────────────────────────────────

    @app.post("/api/client-event")
    async def client_event(request: Request, _auth: None = Depends(_require_upload_token)) -> dict:
        body = await request.body()
        if len(body) > _CLIENT_EVENT_MAX_SIZE:
            raise HTTPException(status_code=413, detail="Event too large")
        if len(body) == 0:
            raise HTTPException(status_code=400, detail="Empty event")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        evt_type = data.get("type", "")
        if evt_type not in _VALID_EVENT_TYPES:
            raise HTTPException(status_code=400, detail="Invalid event type")
        msg = str(data.get("msg", ""))[:500]
        meta = data.get("meta", {})
        if not isinstance(meta, dict) or len(json.dumps(meta)) > 2048:
            raise HTTPException(status_code=400, detail="Meta too large")
        room = str(data.get("room", ""))[:32]
        hashed_ip = ip_hash(_client_ip(request))
        row_id = await db.insert_client_event(
            {
                "type": evt_type,
                "message": msg,
                "meta": json.dumps(meta),
                "room": room,
                "slot": data.get("slot"),
                "ip_hash": hashed_ip,
                "user_agent": data.get("ua", ""),
            }
        )
        log.info("Client event: %s room=%s msg=%s id=%d", evt_type, room, msg[:100], row_id)
        return {"status": "saved", "id": row_id}

    # ── Feedback submission ──────────────────────────────────────────────

    @app.post("/api/feedback")
    async def submit_feedback(request: Request) -> dict:
        if not check_ip(_client_ip(request), "feedback"):
            raise HTTPException(status_code=429, detail="Rate limited")
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON") from exc
        try:
            payload = FeedbackPayload.model_validate(body)
        except Exception:
            raise HTTPException(status_code=422, detail="Invalid feedback data") from None

        # Honeypot check — silent discard
        if payload.company_fax:
            return {"status": "saved", "id": 0}

        # Context size check — drop if over 4KB
        context_str = None
        if payload.context is not None:
            context_str = json.dumps(payload.context)
            if len(context_str) > _FEEDBACK_CONTEXT_MAX:
                context_str = None

        # Hash IP for correlation without tracking
        hashed_ip = ip_hash(_client_ip(request))

        row_id = await db.insert_feedback(
            {
                "category": payload.category,
                "message": payload.message,
                "email": payload.email,
                "page": payload.page,
                "context": context_str,
                "ip_hash": hashed_ip,
            }
        )
        log.info("Feedback saved: id=%d category=%s page=%s", row_id, payload.category, payload.page)
        return {"status": "saved", "id": row_id}

    # ── Admin API ─────────────────────────────────────────────────────────

    def _admin_auth(request: Request) -> None:
        """Check admin key. ADMIN_KEY must be set — blocks all access if unset."""
        admin_key = os.environ.get("ADMIN_KEY")
        if not admin_key:
            raise HTTPException(status_code=403, detail="Admin access disabled (ADMIN_KEY not configured)")
        key = request.headers.get("x-admin-key")
        if not key or not hmac.compare_digest(admin_key, key):
            raise HTTPException(status_code=401, detail="Invalid admin key")

    @app.get("/admin/api/stats")
    async def admin_stats(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        session_log_rows = await db.query("SELECT COUNT(*) as cnt FROM session_logs", ())
        client_event_rows = await db.query("SELECT COUNT(*) as cnt FROM client_events", ())
        feedback_rows = await db.query("SELECT COUNT(*) as cnt FROM feedback", ())
        return {
            "rooms": len(rooms),
            "max_rooms": MAX_ROOMS,
            "players": sum(len(r.players) for r in rooms.values()),
            "spectators": sum(len(r.spectators) for r in rooms.values()),
            "session_log_count": session_log_rows[0]["cnt"] if session_log_rows else 0,
            "client_event_count": client_event_rows[0]["cnt"] if client_event_rows else 0,
            "feedback_count": feedback_rows[0]["cnt"] if feedback_rows else 0,
            "retention_days": int(os.environ.get("LOG_RETENTION_DAYS", "14")),
        }

    # ── Admin session logs API ───────────────────────────────────────────

    @app.get("/admin/api/session-logs")
    async def admin_session_logs_list(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        room = request.query_params.get("room")
        match_id = request.query_params.get("match_id")
        mode = request.query_params.get("mode")
        has_desyncs = request.query_params.get("has_desyncs")
        player_name = request.query_params.get("player_name")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]
        if room:
            conditions.append("room = ?")
            params.append(room)
        if match_id:
            conditions.append("match_id = ?")
            params.append(match_id)
        if mode and mode in ("lockstep", "streaming"):
            conditions.append("mode = ?")
            params.append(mode)
        if has_desyncs == "true":
            conditions.append("json_extract(summary, '$.desyncs') > 0")
        if player_name:
            conditions.append("player_name LIKE ?")
            params.append(f"%{player_name}%")

        where = " AND ".join(conditions)
        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM session_logs WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT id, match_id, room, slot, player_name, mode, summary, ended_by, created_at, updated_at FROM session_logs WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        for entry in entries:
            if entry.get("summary") and isinstance(entry["summary"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["summary"] = json.loads(entry["summary"])

        # Enrich with visual desync counts from screenshot_comparisons
        match_ids = {e["match_id"] for e in entries if e.get("match_id")}
        desync_counts: dict[str, int] = {}
        for mid in match_ids:
            rows = await db.query(
                "SELECT COUNT(*) as cnt FROM screenshot_comparisons WHERE match_id = ? AND is_desync = 1",
                (mid,),
            )
            if rows and rows[0]["cnt"]:
                desync_counts[mid] = rows[0]["cnt"]
        for entry in entries:
            mid = entry.get("match_id")
            if mid and mid in desync_counts:
                entry["visual_desync_count"] = desync_counts[mid]

        return {"total": total, "entries": entries}

    @app.get("/admin/api/session-logs/{log_id}")
    async def admin_session_log_detail(request: Request, log_id: int, _auth: None = Depends(_require_admin)) -> dict:
        rows = await db.query("SELECT * FROM session_logs WHERE id = ?", (log_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Session log not found")
        entry = rows[0]
        for field in ("log_data", "summary", "context"):
            if entry.get(field) and isinstance(entry[field], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry[field] = json.loads(entry[field])

        # Bundle client events for the same match/room so the full picture
        # is visible in one API call (DC failures, WebRTC state, milestones).
        match_id = entry.get("match_id")
        room = entry.get("room")
        conditions = []
        params: list = []
        if match_id:
            conditions.append("json_extract(meta, '$.match_id') = ?")
            params.append(match_id)
        if room:
            conditions.append("room = ?")
            params.append(room)
        if conditions:
            where = " OR ".join(conditions)
            event_rows = await db.query(
                f"""SELECT id, type, message, meta, slot, created_at
                    FROM client_events
                    WHERE {where}
                    ORDER BY created_at ASC, id ASC
                    LIMIT 200""",
                tuple(params),
            )
            for row in event_rows:
                if row.get("meta") and isinstance(row["meta"], str):
                    with contextlib.suppress(json.JSONDecodeError, TypeError):
                        row["meta"] = json.loads(row["meta"])
            entry["client_events"] = event_rows
        else:
            entry["client_events"] = []

        # Bundle SSIM comparisons for this match
        if match_id:
            ssim_rows = await db.query(
                """SELECT frame, ssim, is_desync, created_at
                   FROM screenshot_comparisons
                   WHERE match_id = ?
                   ORDER BY frame ASC
                   LIMIT 200""",
                (match_id,),
            )
            entry["ssim"] = ssim_rows
        else:
            entry["ssim"] = []

        return entry

    @app.get("/admin/api/session-logs/{log_id}/export")
    async def admin_session_log_export(
        log_id: int,
        format: str = "jsonl",
        _auth: None = Depends(_require_admin),
    ) -> StreamingResponse:
        """Stream a session log's entries as newline-delimited JSON.

        Designed for analysis tools that load the data via Polars
        `pl.scan_ndjson` or DuckDB `read_json_auto` — line-oriented
        formats avoid loading the entire log_data array into memory
        on either side and let downstream tools push down filters and
        aggregations efficiently.

        Each line is one entry from `log_data` augmented with the
        parent session metadata (id, match_id, room, slot, player_name,
        mode) so the analyzer can do cross-peer joins without a second
        request. The first line is a metadata header marked
        `{"_kind":"meta", ...}` containing the session-level summary.
        """
        if format != "jsonl":
            raise HTTPException(status_code=400, detail="Only format=jsonl is supported")
        rows = await db.query("SELECT * FROM session_logs WHERE id = ?", (log_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Session log not found")
        entry = rows[0]

        # Pre-parse the JSON-stored fields. log_data is a JSON array of
        # entries; summary and context are JSON objects.
        log_data = entry.get("log_data") or "[]"
        if isinstance(log_data, str):
            try:
                log_data = json.loads(log_data)
            except json.JSONDecodeError:
                log_data = []
        if not isinstance(log_data, list):
            log_data = []

        summary = entry.get("summary") or "{}"
        if isinstance(summary, str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                summary = json.loads(summary)

        context_obj = entry.get("context") or "{}"
        if isinstance(context_obj, str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                context_obj = json.loads(context_obj)

        meta = {
            "_kind": "meta",
            "id": entry.get("id"),
            "match_id": entry.get("match_id"),
            "room": entry.get("room"),
            "slot": entry.get("slot"),
            "player_name": entry.get("player_name"),
            "mode": entry.get("mode"),
            "ended_by": entry.get("ended_by"),
            "created_at": str(entry.get("created_at")),
            "updated_at": str(entry.get("updated_at")),
            "summary": summary,
            "context": context_obj,
            "entry_count": len(log_data),
        }

        # Stable per-line metadata included on every entry so the
        # downstream analyzer can group by match/peer without joining
        # back to the meta line.
        per_line_meta = {
            "session_id": entry.get("id"),
            "match_id": entry.get("match_id"),
            "slot": entry.get("slot"),
        }

        async def generate():
            yield (json.dumps(meta) + "\n").encode("utf-8")
            for row_entry in log_data:
                if not isinstance(row_entry, dict):
                    continue
                # Merge per-line metadata into each entry. Don't mutate
                # the original dict — make a shallow copy.
                merged = {**per_line_meta, **row_entry}
                yield (json.dumps(merged, separators=(",", ":")) + "\n").encode("utf-8")

        return StreamingResponse(
            generate(),
            media_type="application/x-ndjson",
            headers={
                "content-disposition": f'attachment; filename="session-{log_id}.jsonl"',
                "x-entry-count": str(len(log_data)),
            },
        )

    # ── Admin match metrics (precomputed by src.match_rotation) ─────────
    # These endpoints read from the `match_metrics` table, which is
    # populated by the background rotation sweeper (see match_rotation.py).
    # They exist to keep listings/detail cheap — no JSON blob re-parsing
    # on every request. If a match hasn't been rotated yet (e.g. sweep
    # hasn't fired since game-end), the listing simply won't include it;
    # the detail endpoint returns 404 and the caller can retry shortly.

    @app.get("/admin/api/matches")
    async def admin_matches_list(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        """List recently-rotated matches with their precomputed metrics."""
        try:
            days = int(request.query_params.get("days", "7"))
        except ValueError:
            days = 7
        try:
            limit = min(int(request.query_params.get("limit", "50")), 500)
        except ValueError:
            limit = 50

        rows = await db.query(
            """
            SELECT match_id, mode, peer_count, frames, duration_sec, ended_by,
                   mismatch_count, first_divergence_frame, last_clean_frame,
                   rollbacks, predictions, correct_predictions, max_rollback_depth,
                   failed_rollbacks, tolerance_hits, pacing_throttle_count,
                   parquet_path, parquet_bytes, entry_count, rotated_at, created_at
            FROM match_metrics
            WHERE created_at > datetime('now', ?)
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (f"-{days} days", limit),
        )
        return {"matches": rows, "count": len(rows)}

    @app.get("/admin/api/matches/{match_id}")
    async def admin_match_detail(match_id: str, _auth: None = Depends(_require_admin)) -> dict:
        """Return one match's precomputed metrics row."""
        rows = await db.query("SELECT * FROM match_metrics WHERE match_id = ?", (match_id,))
        if not rows:
            # Fall back to prefix match so CLI tools can pass a short id.
            rows = await db.query(
                "SELECT * FROM match_metrics WHERE match_id LIKE ? LIMIT 1",
                (f"{match_id}%",),
            )
        if not rows:
            raise HTTPException(status_code=404, detail="Match not rotated yet")
        return rows[0]

    # ── Admin input-audit diff (Option G) ────────────────────────────────
    # Pulls the delta-encoded input history from both peers of a given match
    # and diffs them. Each peer uploads:
    #   context.inputAudit.local  = array of { f, b, lx, ly, cx, cy }
    #   context.inputAudit.remote = { slot: [ ... ] }
    # "local" = inputs this peer generated. "remote" = inputs this peer
    # received from each other peer. For a 2-player match, peer 0's local
    # should equal peer 1's remote[0], and peer 1's local should equal
    # peer 0's remote[1]. If they don't match, the input protocol is
    # dropping or reordering packets — the emulator determinism hypothesis
    # is wrong.
    @app.get("/admin/api/input-audit/{match_id}")
    async def admin_input_audit(match_id: str, _auth: None = Depends(_require_admin)) -> dict:
        rows = await db.query(
            "SELECT slot, player_name, context FROM session_logs WHERE match_id = ? ORDER BY slot",
            (match_id,),
        )
        if not rows:
            raise HTTPException(status_code=404, detail="No session logs for match")

        peers: dict = {}
        for row in rows:
            ctx = row.get("context") or "{}"
            if isinstance(ctx, str):
                try:
                    ctx = json.loads(ctx)
                except json.JSONDecodeError:
                    ctx = {}
            audit = ctx.get("inputAudit") if isinstance(ctx, dict) else None
            peers[row["slot"]] = {
                "player_name": row.get("player_name"),
                "audit": audit,
            }

        def inputs_eq(a, b):
            return (
                a.get("f") == b.get("f")
                and a.get("b") == b.get("b")
                and a.get("lx") == b.get("lx")
                and a.get("ly") == b.get("ly")
                and a.get("cx") == b.get("cx")
                and a.get("cy") == b.get("cy")
            )

        diffs = []
        for sender_slot, sender in peers.items():
            sender_audit = sender.get("audit") or {}
            sender_local = sender_audit.get("local") or []
            for receiver_slot, receiver in peers.items():
                if receiver_slot == sender_slot:
                    continue
                receiver_audit = receiver.get("audit") or {}
                remote_map = receiver_audit.get("remote") or {}
                receiver_remote = remote_map.get(str(sender_slot)) or remote_map.get(sender_slot) or []
                min_len = min(len(sender_local), len(receiver_remote))
                mismatches = []
                for i in range(min_len):
                    if not inputs_eq(sender_local[i], receiver_remote[i]):
                        mismatches.append(
                            {
                                "index": i,
                                "sender": sender_local[i],
                                "receiver": receiver_remote[i],
                            }
                        )
                        if len(mismatches) >= 20:
                            break
                verdict = "IDENTICAL"
                if mismatches:
                    verdict = "MISMATCH"
                elif len(sender_local) != len(receiver_remote):
                    verdict = "PARTIAL"
                diffs.append(
                    {
                        "sender_slot": sender_slot,
                        "receiver_slot": receiver_slot,
                        "sender_entries": len(sender_local),
                        "receiver_entries": len(receiver_remote),
                        "compared": min_len,
                        "mismatch_count": len(mismatches),
                        "first_mismatches": mismatches[:20],
                        "verdict": verdict,
                    }
                )

        return {
            "match_id": match_id,
            "peer_count": len(peers),
            "peers": {
                s: {
                    "player_name": p["player_name"],
                    "local_entries": len((p.get("audit") or {}).get("local") or []),
                    "remote_entries": {
                        k: len(v or []) for k, v in ((p.get("audit") or {}).get("remote") or {}).items()
                    },
                }
                for s, p in peers.items()
            },
            "diffs": diffs,
        }

    # ── Admin client events API ──────────────────────────────────────────

    @app.get("/admin/api/client-events")
    async def admin_client_events_list(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        evt_type = request.query_params.get("type")
        room = request.query_params.get("room")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]
        if evt_type and evt_type in _VALID_EVENT_TYPES:
            conditions.append("type = ?")
            params.append(evt_type)
        if room:
            conditions.append("room = ?")
            params.append(room)

        where = " AND ".join(conditions)
        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM client_events WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT * FROM client_events WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        for entry in entries:
            if entry.get("meta") and isinstance(entry["meta"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["meta"] = json.loads(entry["meta"])
        return {"total": total, "entries": entries}

    @app.get("/admin/api/client-events/{event_id}")
    async def admin_client_event_detail(request: Request, event_id: int, _auth: None = Depends(_require_admin)) -> dict:
        rows = await db.query("SELECT * FROM client_events WHERE id = ?", (event_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Client event not found")
        entry = rows[0]
        if entry.get("meta") and isinstance(entry["meta"], str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                entry["meta"] = json.loads(entry["meta"])
        return entry

    # ── Admin feedback API ───────────────────────────────────────────────

    @app.get("/admin/api/feedback")
    async def admin_feedback_list(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        category = request.query_params.get("category")
        days = int(request.query_params.get("days", "30"))
        limit = min(int(request.query_params.get("limit", "50")), 200)
        offset = int(request.query_params.get("offset", "0"))

        conditions = ["created_at > datetime('now', ?)"]
        params: list = [f"-{days} days"]

        if category and category in ("bug", "feature", "general"):
            conditions.append("category = ?")
            params.append(category)

        where = " AND ".join(conditions)

        total_rows = await db.query(f"SELECT COUNT(*) as cnt FROM feedback WHERE {where}", tuple(params))
        total = total_rows[0]["cnt"] if total_rows else 0

        params_with_paging = params + [limit, offset]
        entries = await db.query(
            f"SELECT * FROM feedback WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            tuple(params_with_paging),
        )
        # Parse context JSON strings back to dicts for the response
        for entry in entries:
            if entry.get("context") and isinstance(entry["context"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    entry["context"] = json.loads(entry["context"])
        return {"total": total, "entries": entries}

    @app.get("/admin/api/feedback/{feedback_id}")
    async def admin_feedback_single(request: Request, feedback_id: int, _auth: None = Depends(_require_admin)) -> dict:
        rows = await db.query("SELECT * FROM feedback WHERE id = ?", (feedback_id,))
        if not rows:
            raise HTTPException(status_code=404, detail="Feedback not found")
        entry = rows[0]
        if entry.get("context") and isinstance(entry["context"], str):
            with contextlib.suppress(json.JSONDecodeError, TypeError):
                entry["context"] = json.loads(entry["context"])
        return entry

    # ── Session timeline (P0-1 reliability telemetry) ────────────────────
    # Returns all client_events for a single session (correlated by room and
    # match_id) in chronological order. Consumed by the admin session detail
    # view to render the per-session funnel checklist + event timeline.
    # See docs/superpowers/specs/2026-04-07-reliability-funnel-telemetry-design.md

    @app.get("/admin/api/session-timeline")
    async def admin_session_timeline(request: Request, _auth: None = Depends(_require_admin)) -> dict:
        match_id = request.query_params.get("match_id")
        room = request.query_params.get("room")
        if not match_id and not room:
            raise HTTPException(status_code=400, detail="match_id or room required")

        # A session's events span both pre-game (keyed by room, no match_id in
        # meta) and in-game (match_id present in meta). We union both paths so
        # the timeline shows the full sequence from room_created through
        # milestone_reached plus any failure events.
        conditions = []
        params: list = []
        if match_id:
            conditions.append("json_extract(meta, '$.match_id') = ?")
            params.append(match_id)
        if room:
            conditions.append("room = ?")
            params.append(room)
        where = " OR ".join(conditions)

        rows = await db.query(
            f"""SELECT id, type, message, meta, room, slot, created_at
                FROM client_events
                WHERE {where}
                ORDER BY created_at ASC, id ASC
                LIMIT 500""",
            tuple(params),
        )
        # Parse meta JSON for client consumption; tolerate malformed rows.
        for row in rows:
            if row.get("meta") and isinstance(row["meta"], str):
                with contextlib.suppress(json.JSONDecodeError, TypeError):
                    row["meta"] = json.loads(row["meta"])
        return {"events": rows, "count": len(rows)}

    # ── Screenshot routes ──────────────────────────────────────────────────

    @app.get("/admin/api/screenshots/{match_id}")
    async def admin_screenshots_list(request: Request, match_id: str, _auth: None = Depends(_require_admin)) -> dict:
        """List all screenshots for a given match (metadata only, no blobs)."""
        screenshots = await db.get_screenshots(match_id)
        return {"matchId": match_id, "screenshots": screenshots}

    @app.get("/admin/api/screenshots/{match_id}/comparisons")
    async def admin_screenshot_comparisons(
        request: Request, match_id: str, _auth: None = Depends(_require_admin)
    ) -> dict:
        """List SSIM comparison results for a match."""
        comparisons = await db.get_screenshot_comparisons(match_id)
        desync_count = sum(1 for c in comparisons if c["is_desync"])
        return {
            "matchId": match_id,
            "comparisons": comparisons,
            "desyncCount": desync_count,
            "totalComparisons": len(comparisons),
        }

    @app.get("/admin/api/screenshots/img/{screenshot_id}")
    async def admin_screenshot_image(request: Request, screenshot_id: int, key: str = "") -> Response:
        """Serve a single screenshot JPEG from the database.
        Accepts admin key via header OR ?key= query param (for <img src>)."""
        admin_key = os.environ.get("ADMIN_KEY")
        if not admin_key:
            raise HTTPException(status_code=403, detail="Admin access disabled")
        provided = request.headers.get("x-admin-key") or key
        if not provided or not hmac.compare_digest(admin_key, provided):
            raise HTTPException(status_code=401, detail="Invalid admin key")
        data = await db.get_screenshot_data(screenshot_id)
        if not data:
            raise HTTPException(status_code=404, detail="Screenshot not found")
        return Response(content=data, media_type="image/jpeg")

    # ── OG card routes ────────────────────────────────────────────────────

    _web_dir = Path(os.path.dirname(__file__)).parent.parent.parent / "web"
    _play_html: str | None = None
    _index_html: str | None = None

    def _get_play_html() -> str:
        nonlocal _play_html
        if _play_html is None:
            _play_html = (_web_dir / "play.html").read_text()
        return _play_html

    def _get_index_html() -> str:
        nonlocal _index_html
        if _index_html is None:
            _index_html = (_web_dir / "index.html").read_text()
        return _index_html

    def _owner_name(room) -> str:  # noqa: ANN001
        """Get room owner's display name."""
        for p in room.players.values():
            if p.get("socketId") == room.owner:
                return p.get("playerName", room.room_name)
        return room.room_name

    def _player_names(room) -> list[str]:  # noqa: ANN001
        """Get list of player display names in the room."""
        return [p.get("playerName", "?") for p in room.players.values()]

    _fallback_png = _web_dir / "static" / "og" / "fallback.png"

    @app.get("/og-image/{room_id}.png")
    async def og_image(room_id: str, request: Request) -> Response:
        try:
            room = rooms.get(room_id)
            spectate = request.query_params.get("spectate") == "1"
            game_hint = request.query_params.get("game")  # fallback from URL param
            game_images = feature_enabled_for_host(_GAME_IMAGES_RAW, request.headers.get("host", ""))
            if room:
                names = _player_names(room) if spectate else None
                game_id = room.game_id or game_hint
                img = await generate_og_image(
                    _owner_name(room), game_id, spectate, player_names=names, game_images_enabled=game_images
                )
            else:
                img = await generate_og_image(room_id, game_hint, spectate, game_images_enabled=game_images)
        except Exception:
            log.warning("OG image generation failed for room %s", room_id, exc_info=True)
            if _fallback_png.exists():
                img = _fallback_png.read_bytes()
            else:
                log.warning("OG fallback image missing at %s", _fallback_png)
                raise HTTPException(status_code=500, detail="OG image unavailable") from None
        return Response(
            content=img,
            media_type="image/png",
            headers={"cache-control": "public, max-age=300"},
        )

    @app.get("/play.html")
    def play_page(request: Request) -> Response:
        room_id = request.query_params.get("room")
        spectate = request.query_params.get("spectate") == "1"
        host = _validated_host(request)
        game_hint = request.query_params.get("game")
        room = rooms.get(room_id) if room_id else None
        if room:
            game_id = room.game_id or game_hint
            tags = build_og_tags(host, room_id, _owner_name(room), game_id, spectate)
        elif room_id:
            tags = build_og_tags(host, room_id, room_id, game_hint, spectate)
        else:
            tags = build_og_tags(host)
        html = inject_og_tags(_get_play_html(), tags)
        html = _inject_kn_config(html, rom_sharing_enabled=feature_enabled_for_host(_ROM_SHARING_RAW, host))
        return Response(content=html, media_type="text/html")

    @app.get("/")
    def index_page(request: Request) -> Response:
        host = _validated_host(request)
        tags = build_og_tags(host)
        html = inject_og_tags(_get_index_html(), tags)
        return Response(content=html, media_type="text/html")

    return app
