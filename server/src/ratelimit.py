"""In-memory per-IP rate limiting with rolling window."""
from __future__ import annotations

import time
from collections import defaultdict

_counters: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
_connections: dict[str, int] = defaultdict(int)
_sid_ip: dict[str, str] = {}

_LIMITS: dict[str, tuple[int, float]] = {
    "connect": (30, 60),
    "open-room": (5, 60),
    "join-room": (20, 60),
    "snapshot": (2, 1),
    "data-message": (60, 1),
    "room-lookup": (10, 60),
}

MAX_CONNECTIONS_PER_IP = 20


def register_sid(sid: str, ip: str) -> None:
    _sid_ip[sid] = ip
    _connections[ip] += 1


def unregister_sid(sid: str) -> None:
    ip = _sid_ip.pop(sid, None)
    if ip and _connections[ip] > 0:
        _connections[ip] -= 1


def check(sid: str, event: str) -> bool:
    ip = _sid_ip.get(sid, "unknown")
    limit = _LIMITS.get(event)
    if not limit:
        return True
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[ip][event]
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= max_count:
        return False
    timestamps.append(now)
    return True


def check_ip(ip: str, event: str) -> bool:
    limit = _LIMITS.get(event)
    if not limit:
        return True
    max_count, window = limit
    now = time.monotonic()
    timestamps = _counters[ip][event]
    cutoff = now - window
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= max_count:
        return False
    timestamps.append(now)
    return True


def connection_allowed(ip: str) -> bool:
    return _connections.get(ip, 0) < MAX_CONNECTIONS_PER_IP


def cleanup() -> None:
    now = time.monotonic()
    stale_ips = []
    for ip, events in list(_counters.items()):
        for event, timestamps in list(events.items()):
            events[event] = [t for t in timestamps if now - t < 120]
            if not events[event]:
                del events[event]
        if not events:
            stale_ips.append(ip)
    for ip in stale_ips:
        del _counters[ip]
