"""In-memory per-IP rate limiting with rolling window."""

import hashlib
import hmac
import ipaddress
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
    "release-slot": (5, 10),
    "set-name": (5, 10),
    "set-mode": (5, 10),
    "rom-sharing-toggle": (5, 10),
    "set-listed": (5, 10),
    "rom-ready": (10, 10),
    "input-type": (5, 10),
    "device-type": (5, 10),
    "snapshot": (2, 1),
    "data-message": (60, 1),
    "room-lookup": (30, 60),
    # 404s on /room/{id} are tracked separately so an enumerator hitting
    # unknown room codes burns through the miss budget fast, while
    # legitimate polling of an existing room stays under "room-lookup".
    "room-lookup-miss": (5, 60),
    # Front-page board: each open tab polls /list every 10 s (6/min) and the
    # stats about once a minute. 240/min leaves room for ~30 tabs behind one
    # household or carrier NAT. Frames are fetched per listed room.
    "board": (240, 60),
    "room-frame": (240, 60),
    # A page fetches ICE servers once per room join. Generous because players
    # can share an IP (LAN, carrier NAT); Cloudflare calls are bounded by
    # turn.py's cache and failure backoff, not by this.
    "ice-servers": (60, 60),
    "webrtc-signal": (60, 1),
    "input": (120, 1),
    "rom-signal": (60, 1),
    "cache-state": (5, 60),
    "session-log": (16, 30),  # 4 players × 1 flush per 30s + late-join bursts
    "client-event": (60, 60),
    "debug-sync": (5, 1),
    "debug-logs": (5, 60),
    "game-screenshot": (12, 5),  # 4 players burst simultaneously every 5s; headroom for spectators/jitter/local dev
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


# Render sets RENDER=true in every service. Render runs all services behind
# Cloudflare, whose edge sets True-Client-IP / CF-Connecting-IP to the real
# visitor, including for direct *.onrender.com requests. X-Forwarded-For's
# first entry is whatever the client sent (Render only appends), so it is
# never used there.
_ON_RENDER = os.environ.get("RENDER") == "true"

# The landing Worker (deploy/static/worker.js) sits in front of the server.
# Cloudflare sets CF-Connecting-IP on a Worker's subrequests to the Worker's
# own address, so the Worker forwards the visitor's IP in X-KN-Client-IP with
# a shared secret; the header counts only when the secret matches.
#
# KN_PROXY_SECRET may hold a comma-separated list, so a rotation can add the
# new secret alongside the old one before removing it: while both are
# configured here, the Worker's header is trusted whichever one it presents.
_PROXY_SECRET = os.environ.get("KN_PROXY_SECRET", "")


def _proxy_secrets() -> list[str]:
    """Parse KN_PROXY_SECRET into its individual entries.

    Re-parses `_PROXY_SECRET` on every call (cheap) rather than caching, so
    tests that monkeypatch the module attribute see the change immediately.
    """
    return [s.strip() for s in _PROXY_SECRET.split(",") if s.strip()]


# Warn at most once per (reason) per _PROXY_WARN_INTERVAL, so a misconfigured
# secret or a spoofed header doesn't spam the log.
_proxy_warned: dict[str, float] = {}
_PROXY_WARN_INTERVAL = 600.0

# The Worker's own egress range (documented in deploy/static/worker.js). If
# KN_PROXY_SECRET is set here but the Worker sends no X-KN-Client-IP (its own
# PROXY_SECRET is unset), the normal IP rule resolves to an address in this
# range for every visitor — that's the silent one-IP-for-the-whole-site bug.
_CF_WORKER_NET = ipaddress.ip_network("2a06:98c0::/29")


def _is_worker_address(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip) in _CF_WORKER_NET
    except ValueError:
        return False


def _warn_proxy_once(message: str) -> None:
    """Log `message` at most once per _PROXY_WARN_INTERVAL, keyed by its own text."""
    now = time.monotonic()
    last = _proxy_warned.get(message)
    if last is None or now - last >= _PROXY_WARN_INTERVAL:  # monotonic can start near 0
        _proxy_warned[message] = now
        log.warning("%s", message)


def extract_ip(source: object) -> str:
    """Extract client IP from a FastAPI Request or ASGI environ dict.

    Checks Cloudflare, then X-Forwarded-For, then falls back to the
    direct connection address. On Render, only the Cloudflare-set headers.
    """
    if isinstance(source, dict):
        # ASGI environ dict (Socket.IO connect handler)
        def header(name: str) -> str:
            return source.get("HTTP_" + name.upper().replace("-", "_"), "")

        peer = source.get("REMOTE_ADDR", "unknown")
    else:
        # FastAPI Request object
        def header(name: str) -> str:
            return source.headers.get(name, "")

        peer = source.client.host if source.client else "unknown"

    proxied_ip = header("x-kn-client-ip")
    if proxied_ip:
        secrets = _proxy_secrets()
        if not secrets:
            _warn_proxy_once("X-KN-Client-IP present but KN_PROXY_SECRET is unset — falling back to the normal IP rule")
        else:
            # Compare against every configured secret — never short-circuit
            # on the first match — so timing can't reveal which one (if any)
            # matched, only whether trust was granted.
            supplied = header("x-kn-proxy-auth").encode()
            matched = False
            for secret in secrets:
                if hmac.compare_digest(supplied, secret.encode()):
                    matched = True
            if not matched:
                _warn_proxy_once(
                    "X-KN-Client-IP present but the proxy auth didn't match — falling back to the normal IP rule"
                )
            else:
                try:
                    return str(ipaddress.ip_address(proxied_ip.strip()))
                except ValueError:
                    _warn_proxy_once(
                        "X-KN-Client-IP present but the forwarded value wasn't a single IP address"
                        " — falling back to the normal IP rule"
                    )

    if _ON_RENDER:
        for name in ("true-client-ip", "cf-connecting-ip"):
            if header(name):
                result = header(name).strip()
                break
        else:
            result = "unknown"
    else:
        cf_ip = header("cf-connecting-ip")
        if cf_ip:
            result = cf_ip.strip()
        else:
            forwarded = header("x-forwarded-for")
            result = forwarded.split(",")[0].strip() if forwarded else peer

    # No X-KN-Client-IP at all, but the server expects one from the landing
    # Worker and the normal rule resolved to the Worker's own address: the
    # Worker is very likely missing its own PROXY_SECRET, so it never sent
    # the header — this is the silent one-IP-for-the-whole-site bug.
    if not proxied_ip and _PROXY_SECRET and _is_worker_address(result):
        _warn_proxy_once(
            "a request came from a Cloudflare Worker without X-KN-Client-IP"
            " — is PROXY_SECRET set on the landing Worker?"
        )

    return result


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
