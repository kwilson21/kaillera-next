"""Redis-backed room state persistence.

Persists Room objects to Redis so they survive server restarts.
Operates as a write-through cache — in-memory `rooms` dict is primary,
Redis is the backing store. If REDIS_URL is not set, all operations
are silent no-ops (graceful degradation).

Keys: kn:room:{sessionId} — JSON-serialized Room dataclass
TTL: 12 hours (refreshed on each write)
"""

import asyncio
import json
import logging
import os
from dataclasses import asdict
from urllib.parse import quote

import redis.asyncio as aioredis
from redis.exceptions import AuthenticationError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

log = logging.getLogger(__name__)

_KEY_PREFIX = "kn:room:"
_TTL_SECONDS = 12 * 60 * 60  # 12 hours

_redis = None  # redis.asyncio.Redis instance or None


def get_redis_url() -> str:
    """Build Redis URL from env vars, URL-encoding the password to handle special chars."""
    url = os.environ.get("REDIS_URL", "")
    if url:
        return url
    password = os.environ.get("REDIS_PASSWORD", "")
    if not password:
        return ""
    host = os.environ.get("REDIS_HOST", "redis")
    port = os.environ.get("REDIS_PORT", "6379")
    db = os.environ.get("REDIS_DB", "0")
    encoded_pw = quote(password, safe="")
    return f"redis://:{encoded_pw}@{host}:{port}/{db}"


def _serialize_room(room) -> str:
    """Convert Room dataclass to JSON string."""
    d = asdict(room)
    # Sets are not JSON-serializable — convert to lists
    d["rom_ready"] = list(d["rom_ready"])
    # An unfinished rewind returns to the lobby on a server restart.
    del d["resume_ready"]
    d["rom_prompt"] = list(d["rom_prompt"])
    d["waiting_for_state"] = list(d["waiting_for_state"])
    # Slot keys must be strings in JSON; we convert back on load
    d["slots"] = {str(k): v for k, v in d["slots"].items()}
    return json.dumps(d)


def _deserialize_room(d: dict):
    """Reconstruct Room from a parsed JSON dict."""
    from src.api.payloads import canonical_game_mode
    from src.api.signaling import Room

    mode_value = canonical_game_mode(d.get("mode"))

    return Room(
        owner=d["owner"],
        room_name=d["room_name"],
        game_id=d["game_id"],
        password=d.get("password"),
        max_players=d["max_players"],
        players=d.get("players", {}),
        slots={int(k): v for k, v in d.get("slots", {}).items()},
        spectators=d.get("spectators", {}),
        status=d.get("status", "lobby"),
        mode=mode_value,
        rom_hash=d.get("rom_hash"),
        rom_name=d.get("rom_name"),
        rom_size=d.get("rom_size"),
        rom_changing=bool(d.get("rom_changing", False)),
        rom_sharing=d.get("rom_sharing", False),
        rom_ready=set(d.get("rom_ready", [])),
        rom_prompt=set(d.get("rom_prompt", [])),
        input_types=d.get("input_types", {}),
        device_types=d.get("device_types", {}),
        match_id=d.get("match_id"),
        match_participants={int(k): v for k, v in d.get("match_participants", {}).items()},
        resync_enabled=d.get("resync_enabled", True),
        dual_input_enabled=d.get("dual_input_enabled", False),
        resume_from_match_id=d.get("resume_from_match_id"),
        resume_deadline=d.get("resume_deadline"),
        recovery_unverified_match_id=(
            d.get("match_id")
            if d.get("status") == "playing"
            and mode_value in ("rollback", "classic")
            and d.get("recovery_unverified_match_id") == d.get("match_id")
            else None
        ),
        listed=bool(d.get("listed", False)) and d.get("password") is None,
        started_at=d.get("started_at"),
        host_return_deadline=d.get("host_return_deadline"),
        waiting_for_state=set(d.get("waiting_for_state", [])),
    )


async def init() -> dict:
    """Restore configured room storage before accepting joins or writes."""
    global _redis
    url = get_redis_url()
    if not url:
        log.warning("REDIS_URL not configured — rooms will not survive restarts")
        return {}

    client = aioredis.from_url(url, decode_responses=True)
    try:
        for attempt in range(3):
            try:
                restored = await _load_rooms(client)
                break
            except AuthenticationError:
                raise
            except (RedisConnectionError, RedisTimeoutError):
                if attempt == 2:
                    raise
                log.warning("Room storage unavailable during startup, retrying restore")
                await asyncio.sleep(2**attempt)
    except BaseException:
        await client.aclose()
        raise

    _redis = client
    log.info("Restored %d room(s) from Redis", len(restored))
    return restored


def enabled() -> bool:
    """Whether rooms are being persisted to Redis right now."""
    return _redis is not None


async def ping() -> bool:
    """Check if Redis is reachable. Returns True if no Redis configured (ephemeral mode)."""
    if _redis is None:
        return not get_redis_url()
    try:
        await _redis.ping()
        return True
    except Exception:
        return False


async def close() -> None:
    """Close the Redis connection."""
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


async def save_room(session_id: str, room) -> None:
    """Persist room to Redis with 12h TTL. No-op if Redis is unavailable."""
    if not _redis:
        return
    try:
        data = _serialize_room(room)
        await _redis.set(f"{_KEY_PREFIX}{session_id}", data, ex=_TTL_SECONDS)
    except Exception:
        log.exception("Failed to save room %s to Redis", session_id)


async def delete_room(session_id: str) -> None:
    """Remove room from Redis. No-op if Redis is unavailable."""
    if not _redis:
        return
    try:
        await _redis.delete(f"{_KEY_PREFIX}{session_id}")
    except Exception:
        log.exception("Failed to delete room %s from Redis", session_id)


async def _load_rooms(client) -> dict:
    result = {}
    async for key in client.scan_iter(f"{_KEY_PREFIX}*"):
        session_id = key[len(_KEY_PREFIX) :]
        try:
            raw = await client.get(key)
            if raw is None:
                continue  # The key expired between SCAN and GET.
            result[session_id] = _deserialize_room(json.loads(raw))
        except (KeyError, ValueError, TypeError, AttributeError):
            log.exception("Skipping unreadable stored room %s", session_id)
    return result
