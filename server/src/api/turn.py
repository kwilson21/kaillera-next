"""Cloudflare Realtime TURN credentials for /ice-servers.

With CF_TURN_KEY_ID and CF_TURN_API_TOKEN set, the server asks Cloudflare for
short-lived TURN credentials and hands them to room participants. The key id
and token stay on the server; browsers only see the generated credentials.

Credentials are cached and shared until half their lifetime has passed, so a
busy server makes at most a few Cloudflare calls a day.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx

log = logging.getLogger(__name__)

_API = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
TTL_SECONDS = 24 * 60 * 60

_cache: tuple[float, list[dict]] | None = None  # (expires_at, servers)
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
        urls = [urls] if isinstance(urls, str) else urls or []
        urls = [u for u in urls if isinstance(u, str) and u.startswith("turn") and not u.split("?")[0].endswith(":53")]
        if urls:
            out.append({"urls": urls, "username": s["username"], "credential": s["credential"]})
    return out


async def ice_servers(client: httpx.AsyncClient | None = None) -> list[dict]:
    """TURN servers for a room participant, or [] if unavailable."""
    global _cache
    if not configured():
        return []
    now = time.time()
    if _cache and _cache[0] > now:
        return _cache[1]
    async with _lock:
        if _cache and _cache[0] > now:
            return _cache[1]
        url = _API.format(key_id=os.environ["CF_TURN_KEY_ID"])
        headers = {"Authorization": f"Bearer {os.environ['CF_TURN_API_TOKEN']}"}
        try:
            if client is None:
                async with httpx.AsyncClient(timeout=5) as c:
                    resp = await c.post(url, headers=headers, json={"ttl": TTL_SECONDS})
            else:
                resp = await client.post(url, headers=headers, json={"ttl": TTL_SECONDS})
            resp.raise_for_status()
            servers = _usable(resp.json().get("iceServers"))
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            # Never log the response body or headers: they carry credentials.
            log.warning("Cloudflare TURN credentials unavailable: %s", type(e).__name__)
            return []
        if not servers:
            log.warning("Cloudflare TURN response had no usable servers")
            return []
        _cache = (now + TTL_SECONDS / 2, servers)
        return servers


def reset_cache() -> None:
    global _cache
    _cache = None
