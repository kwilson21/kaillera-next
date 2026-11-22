"""Cloudflare Realtime TURN credentials for /ice-servers.

With CF_TURN_KEY_ID and CF_TURN_API_TOKEN set, the server asks Cloudflare for
short-lived TURN credentials and hands them to room participants. The key id
and token stay on the server; browsers only see the generated credentials.

Credentials are cached and shared until half their lifetime has passed, so a
busy server makes at most a few Cloudflare calls a day. A failure is cached
for FAILURE_BACKOFF_SECONDS so an outage doesn't turn every /ice-servers
request into another outbound call. The cache is keyed to the configured
key and token, so rotating them takes effect on the next request.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time

import httpx

log = logging.getLogger(__name__)

_API = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
TTL_SECONDS = 24 * 60 * 60
CACHE_SECONDS = TTL_SECONDS // 2
MIN_REMAINING_SECONDS = TTL_SECONDS - CACHE_SECONDS
LEGACY_UNKNOWN_TTL_SECONDS = 30 * 60
FAILURE_BACKOFF_SECONDS = 60

_cache: tuple[str, float, list[dict]] | None = None  # (config key, expires_at, servers)
_lock = asyncio.Lock()


def configured() -> bool:
    return bool(os.environ.get("CF_TURN_KEY_ID") and os.environ.get("CF_TURN_API_TOKEN"))


def _usable(servers: object) -> list[dict]:
    """Keep TURN entries with credentials; drop port-53 URLs.

    Cloudflare also offers turn:...:53, which browsers block, and a STUN
    entry the caller already has. Accepts either a list of entries or the
    single-object shape older responses used.
    """
    if isinstance(servers, dict):
        servers = [servers]
    if not isinstance(servers, list):
        return []
    out = []
    for s in servers:
        if not isinstance(s, dict) or not s.get("username") or not s.get("credential"):
            continue
        urls = s.get("urls")
        urls = [urls] if isinstance(urls, str) else urls
        if not isinstance(urls, list):
            continue
        urls = [u for u in urls if isinstance(u, str) and u.startswith("turn") and not u.split("?")[0].endswith(":53")]
        if urls:
            out.append({"urls": urls, "username": s["username"], "credential": s["credential"]})
    return out


def legacy_relay_ttl(servers: object) -> int | None:
    """Use the configured validity for static relays, capped by dated usernames."""
    if not isinstance(servers, list):
        return None
    relays = []
    for server in servers:
        if not isinstance(server, dict):
            continue
        urls = server.get("urls")
        urls = [urls] if isinstance(urls, str) else urls
        if isinstance(urls, list) and any(
            isinstance(url, str) and url.lower().startswith(("turn:", "turns:")) for url in urls
        ):
            relays.append(server)
    if not relays:
        return None
    try:
        ttl = int(os.environ.get("ICE_SERVERS_TTL_SECONDS", TTL_SECONDS))
    except ValueError:
        ttl = 0
    if not 1 <= ttl <= TTL_SECONDS:
        log.warning("ICE_SERVERS_TTL_SECONDS must be an integer between 1 and 86400")
        ttl = LEGACY_UNKNOWN_TTL_SECONDS
    next_second = int(time.time()) + 1
    for server in relays:
        username = server.get("username")
        if isinstance(username, str):
            timestamp, delimiter, _ = username.partition(":")
            if delimiter and len(timestamp) == 10 and timestamp.isascii() and timestamp.isdigit():
                ttl = min(ttl, int(timestamp) - next_second)
    # A 1-second lease is already too short for the watcher's safety margin.
    return max(1, ttl)


def _config_key() -> str:
    raw = f"{os.environ['CF_TURN_KEY_ID']}\0{os.environ['CF_TURN_API_TOKEN']}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _cached(key: str, now: float) -> list[dict] | None:
    if _cache and _cache[0] == key and _cache[1] > now:
        return _cache[2]
    return None


async def ice_servers(client: httpx.AsyncClient | None = None) -> list[dict]:
    """TURN servers for a room participant, or [] if unavailable."""
    global _cache
    if not configured():
        return []
    key = _config_key()
    hit = _cached(key, time.monotonic())
    if hit is not None:
        return hit
    async with _lock:
        now = time.monotonic()
        hit = _cached(key, now)
        if hit is not None:
            return hit
        url = _API.format(key_id=os.environ["CF_TURN_KEY_ID"])
        headers = {"Authorization": f"Bearer {os.environ['CF_TURN_API_TOKEN']}"}
        servers: list[dict] = []
        try:
            if client is None:
                async with httpx.AsyncClient(timeout=5) as c:
                    resp = await c.post(url, headers=headers, json={"ttl": TTL_SECONDS})
            else:
                resp = await client.post(url, headers=headers, json={"ttl": TTL_SECONDS})
            resp.raise_for_status()
            servers = _usable(resp.json().get("iceServers"))
            if not servers:
                log.warning("Cloudflare TURN response had no usable servers")
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            # Never log the response body or headers: they carry credentials.
            log.warning("Cloudflare TURN credentials unavailable: %s", type(e).__name__)
        ttl = CACHE_SECONDS if servers else FAILURE_BACKOFF_SECONDS
        _cache = (key, now + ttl, servers)
        return servers


def reset_cache() -> None:
    global _cache
    _cache = None
