"""In-memory per-IP rate limiting with rolling window."""

import time
from collections import defaultdict, deque

_counters: dict[str, dict[str, deque[float]]] = defaultdict(lambda: defaultdict(deque))
_connections: dict[str, int] = defaultdict(int)
_sid_ip: dict[str, str] = {}

_LIMITS: dict[str, tuple[int, float]] = {
    "connect": (30, 60),
    "open-room": (5, 60),
    "join-room": (20, 60),
    "snapshot": (2, 1),
    "data-message": (60, 1),
    "room-lookup": (10, 60),
    "webrtc-signal": (60, 1),
    "input": (120, 1),
    "rom-signal": (60, 1),
    "cache-state": (5, 60),
    "sync-logs": (10, 60),
    "debug-sync": (5, 1),
    "debug-logs": (5, 60),
}

MAX_CONNECTIONS_PER_IP = 20


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
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[key][event]
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.popleft()
    if len(timestamps) >= max_count:
        return False
    timestamps.append(now)
    return True


def check(sid: str, event: str) -> bool:
    ip = _sid_ip.get(sid, "unknown")
    return _check_key(ip, event)


def check_ip(ip: str, event: str) -> bool:
    return _check_key(ip, event)


def connection_allowed(ip: str) -> bool:
    return _connections.get(ip, 0) < MAX_CONNECTIONS_PER_IP


def cleanup() -> None:
    now = time.monotonic()
    stale_ips = []
    for ip, events in list(_counters.items()):
        for event, timestamps in list(events.items()):
            fresh = deque(t for t in timestamps if now - t < 120)
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
