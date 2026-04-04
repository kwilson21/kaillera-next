"""In-memory per-IP rate limiting with rolling window."""

import hashlib
import logging
import os
import time
from collections import defaultdict, deque

log = logging.getLogger(__name__)

_disabled = os.environ.get("DISABLE_RATE_LIMIT") == "1"

_counters: dict[str, dict[str, deque[float]]] = defaultdict(lambda: defaultdict(deque))
_connections: dict[str, int] = defaultdict(int)
_sid_ip: dict[str, str] = {}

_LIMITS: dict[str, tuple[int, float]] = {
    "connect": (30, 60),
    "open-room": (5, 60),
    "join-room": (20, 60),
    "leave-room": (10, 10),
    "claim-slot": (5, 10),
    "set-name": (5, 10),
    "set-mode": (5, 10),
    "rom-sharing-toggle": (5, 10),
    "rom-ready": (10, 10),
    "rom-declare": (10, 10),
    "input-type": (5, 10),
    "device-type": (5, 10),
    "snapshot": (2, 1),
    "data-message": (60, 1),
    "room-lookup": (10, 60),
    "webrtc-signal": (60, 1),
    "input": (120, 1),
    "rom-signal": (60, 1),
    "cache-state": (5, 60),
    "session-log": (16, 30),  # 4 players × 1 flush per 30s + late-join bursts
    "client-event": (60, 60),
    "debug-sync": (5, 1),
    "debug-logs": (5, 60),
    "game-screenshot": (4, 3),  # 4 players × 1 per 5s + headroom
    "feedback": (5, 3600),  # 5 per hour per IP
    "admin": (30, 60),
}

# Rate-limit denial logging — log once per (ip, event) per 60s to avoid spam.
_warned: dict[tuple[str, str], float] = {}
_WARN_INTERVAL = 60.0

_IP_HASH_SALT = os.environ.get("IP_HASH_SALT", "")
if not _IP_HASH_SALT:
    import secrets as _secrets

    _IP_HASH_SALT = _secrets.token_hex(16)
    log.warning("IP_HASH_SALT not set — using random salt (rate correlation won't survive restarts)")


def ip_hash(ip: str) -> str:
    """Hash an IP address for storage. Does not store raw IPs."""
    return hashlib.sha256(f"{ip}{_IP_HASH_SALT}".encode()).hexdigest()[:16]


def ip_hash_for_sid(sid: str) -> str:
    """Hash the IP address associated with a Socket.IO sid."""
    ip = _sid_ip.get(sid, "unknown")
    return ip_hash(ip)


def extract_ip(source: object) -> str:
    """Extract client IP from a FastAPI Request or ASGI environ dict.

    Checks Cloudflare, then X-Forwarded-For, then falls back to the
    direct connection address.
    """
    if isinstance(source, dict):
        # ASGI environ dict (Socket.IO connect handler)
        cf_ip = source.get("HTTP_CF_CONNECTING_IP", "")
        if cf_ip:
            return cf_ip.strip()
        forwarded = source.get("HTTP_X_FORWARDED_FOR", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return source.get("REMOTE_ADDR", "unknown")
    # FastAPI Request object
    cf_ip = source.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    forwarded = source.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return source.client.host if source.client else "unknown"


MAX_CONNECTIONS_PER_IP = 20
_MAX_TRACKED_IPS = 10_000


def register_sid(sid: str, ip: str) -> None:
    _sid_ip[sid] = ip
    _connections[ip] += 1


def unregister_sid(sid: str) -> None:
    ip = _sid_ip.pop(sid, None)
    if ip and _connections[ip] > 0:
        _connections[ip] -= 1
        if _connections[ip] <= 0:
            del _connections[ip]


def _check_key(key: str, event: str) -> bool:
    """Shared rate-limit check for a given key (IP address) and event."""
    limit = _LIMITS.get(event)
    if not limit:
        return True
    if key not in _counters and len(_counters) >= _MAX_TRACKED_IPS:
        return False
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[key][event]
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.popleft()
    if len(timestamps) >= max_count:
        warn_key = (key, event)
        if now - _warned.get(warn_key, 0) >= _WARN_INTERVAL:
            _warned[warn_key] = now
            log.warning("Rate limited: %s (ip=%s…)", event, key[:8])
        return False
    timestamps.append(now)
    return True


def check(sid: str, event: str) -> bool:
    if _disabled:
        return True
    ip = _sid_ip.get(sid, "unknown")
    return _check_key(ip, event)


def check_ip(ip: str, event: str) -> bool:
    if _disabled:
        return True
    return _check_key(ip, event)


def connection_allowed(ip: str) -> bool:
    if _disabled:
        return True
    return _connections.get(ip, 0) < MAX_CONNECTIONS_PER_IP


def cleanup() -> None:
    now = time.monotonic()
    max_window = max(w for _, w in _LIMITS.values())
    stale_ips = []
    for ip, events in list(_counters.items()):
        for event, timestamps in list(events.items()):
            fresh = deque(t for t in timestamps if now - t < max_window)
            if fresh:
                events[event] = fresh
            else:
                del events[event]
        if not events:
            stale_ips.append(ip)
    for ip in stale_ips:
        del _counters[ip]
    # Also clean stale connection entries (defensive — unregister_sid should handle this)
    stale_conns = [ip for ip, count in _connections.items() if count <= 0]
    for ip in stale_conns:
        del _connections[ip]
    # Prune stale rate-limit warning timestamps
    stale_warns = [k for k, t in _warned.items() if now - t > _WARN_INTERVAL * 2]
    for k in stale_warns:
        del _warned[k]
    # Evict least-active IPs if tracking too many
    if len(_counters) > _MAX_TRACKED_IPS:
        sorted_ips = sorted(_counters.keys(), key=lambda ip: sum(len(q) for q in _counters[ip].values()))
        for ip in sorted_ips[: len(_counters) - _MAX_TRACKED_IPS]:
            del _counters[ip]
    if len(_warned) > _MAX_TRACKED_IPS:
        sorted_warns = sorted(_warned.keys(), key=lambda k: _warned[k])
        for k in sorted_warns[: len(_warned) - _MAX_TRACKED_IPS]:
            del _warned[k]
