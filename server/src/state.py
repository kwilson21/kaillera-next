"""Redis-backed room state persistence.

Persists Room objects to Redis so they survive server restarts.
Operates as a write-through cache — in-memory `rooms` dict is primary,
Redis is the backing store. If REDIS_URL is not set, all operations
are silent no-ops (graceful degradation).

Keys: kn:room:{sessionId} — JSON-serialized Room dataclass
TTL: 12 hours (refreshed on each write)
"""

import json
import logging
import os
from dataclasses import asdict

log = logging.getLogger(__name__)

_KEY_PREFIX = "kn:room:"
_TTL_SECONDS = 12 * 60 * 60  # 12 hours

_redis = None  # redis.asyncio.Redis instance or None


def _serialize_room(room) -> str:
    """Convert Room dataclass to JSON string."""
    d = asdict(room)
    # Sets are not JSON-serializable — convert to lists
    d["rom_ready"] = list(d["rom_ready"])
    d["rom_declared"] = list(d["rom_declared"])
    # Slot keys must be strings in JSON; we convert back on load
    d["slots"] = {str(k): v for k, v in d["slots"].items()}
    return json.dumps(d)


def _deserialize_room(d: dict):
    """Reconstruct Room from a parsed JSON dict."""
    from src.api.signaling import Room

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
        mode=d.get("mode"),
        rom_hash=d.get("rom_hash"),
        rom_sharing=d.get("rom_sharing", False),
        rom_ready=set(d.get("rom_ready", [])),
        rom_declared=set(d.get("rom_declared", [])),
        input_types=d.get("input_types", {}),
        device_types=d.get("device_types", {}),
    )


async def init() -> None:
    """Connect to Redis if REDIS_URL is configured."""
    global _redis
    url = os.environ.get("REDIS_URL", "")
    if not url:
        log.warning("REDIS_URL not configured — rooms will not survive restarts")
        return
    try:
        import redis.asyncio as aioredis

        _redis = aioredis.from_url(url, decode_responses=True)
        await _redis.ping()
        log.info("Connected to Redis at %s", url.split("@")[-1])  # hide credentials
    except Exception:
        log.exception("Failed to connect to Redis — falling back to in-memory only")
        _redis = None


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


async def load_all_rooms() -> dict:
    """Load all rooms from Redis. Returns empty dict if Redis is unavailable."""
    if not _redis:
        return {}
    try:
        result = {}
        async for key in _redis.scan_iter(f"{_KEY_PREFIX}*"):
            session_id = key[len(_KEY_PREFIX) :]
            raw = await _redis.get(key)
            if raw:
                result[session_id] = _deserialize_room(json.loads(raw))
        log.info("Hydrated %d room(s) from Redis", len(result))
        return result
    except Exception:
        log.exception("Failed to load rooms from Redis")
        return {}
