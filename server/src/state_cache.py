"""Redis-backed save state cache.

Stores raw save state blobs keyed by rom_hash, served to guests so they
can sync with the host's emulator at game start.

Survives blue/green deploys so an in-progress match can still serve
late-joiners after the server flips. Falls back to an in-memory
OrderedDict when REDIS_URL is not configured (dev mode), matching the
graceful-degradation pattern in state.py.

Keys:
  kn:state:{rom_hash}  raw save state bytes (TTL 1h)
  kn:state-lru          sorted set, score=epoch_seconds, member=rom_hash
"""

import logging
import time
from collections import OrderedDict

from src import state

log = logging.getLogger(__name__)

_BLOB_PREFIX = "kn:state:"
_LRU_KEY = "kn:state-lru"
_TTL_SECONDS = 60 * 60  # 1h
_MAX_ENTRIES = 50

_redis = None  # binary-safe redis.asyncio.Redis instance or None
_local: OrderedDict[str, bytes] = OrderedDict()  # fallback when Redis unavailable


async def init() -> None:
    """Open a binary-safe Redis connection. No-op if REDIS_URL not configured."""
    global _redis
    url = state.get_redis_url()
    if not url:
        log.warning("Save state cache: REDIS_URL not configured — using in-memory only")
        return
    try:
        import redis.asyncio as aioredis

        _redis = aioredis.from_url(url, decode_responses=False)
        await _redis.ping()
        log.info("Save state cache: connected to Redis")
    except Exception:
        log.exception("Save state cache: Redis connection failed — using in-memory")
        _redis = None


async def close() -> None:
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


async def get(rom_hash: str) -> bytes | None:
    """Fetch a cached save state. Returns None if absent or on Redis error."""
    if _redis:
        try:
            blob = await _redis.get(f"{_BLOB_PREFIX}{rom_hash}")
            if blob is None:
                return None
            await _redis.zadd(_LRU_KEY, {rom_hash: time.time()})  # LRU touch
            return blob
        except Exception:
            log.exception("Save state cache: Redis get failed for %s", rom_hash[:16])
            return None
    if rom_hash not in _local:
        return None
    _local.move_to_end(rom_hash)
    return _local[rom_hash]


async def put(rom_hash: str, body: bytes) -> bool:
    """Cache a save state blob with TTL + LRU cap.

    Returns False when Redis was configured but the write failed, so callers
    can avoid telling clients a late-join state was cached when it was not.
    """
    if _redis:
        try:
            now = time.time()
            pipe = _redis.pipeline()
            pipe.set(f"{_BLOB_PREFIX}{rom_hash}", body, ex=_TTL_SECONDS)
            pipe.zadd(_LRU_KEY, {rom_hash: now})
            pipe.zremrangebyscore(_LRU_KEY, 0, now - _TTL_SECONDS)
            await pipe.execute()
            count = await _redis.zcard(_LRU_KEY)
            if count > _MAX_ENTRIES:
                evict_n = count - _MAX_ENTRIES
                stale = await _redis.zrange(_LRU_KEY, 0, evict_n - 1)
                if stale:
                    blob_keys = [_BLOB_PREFIX.encode() + m for m in stale]
                    await _redis.delete(*blob_keys)
                    await _redis.zrem(_LRU_KEY, *stale)
                    log.info("Save state cache: evicted %d entries", len(stale))
            log.info("Cached save state for ROM %s (%d KB)", rom_hash[:16], len(body) // 1024)
            return True
        except Exception:
            log.exception("Save state cache: Redis put failed for %s", rom_hash[:16])
            return False
    if rom_hash in _local:
        _local.move_to_end(rom_hash)
        _local[rom_hash] = body
    else:
        if len(_local) >= _MAX_ENTRIES:
            evicted, _ = _local.popitem(last=False)
            log.info("Save state cache (local): evicted %s", evicted[:16])
        _local[rom_hash] = body
    log.info("Cached save state for ROM %s (%d KB, local)", rom_hash[:16], len(body) // 1024)
    return True
