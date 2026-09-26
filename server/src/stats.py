"""Public numbers for the front page: matches started in the last 7 days.

Real or absent, never padded. A count is only reported when this server
has been recording for the whole 7-day window; otherwise the answer is
None and the page shows no number.

Where match starts are kept:
- Redis (REDIS_URL set): a sorted set, so the count survives restarts and
  naps. `kn:stats:since` marks when recording began.
- No Redis: process memory. The window then starts at process start, so on
  a host that restarts often (Render free tier) the count stays absent.
  The SQLite session logs are not used: they reset on every restart too.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections import deque

from src import state

log = logging.getLogger(__name__)

WEEK_SECONDS = 7 * 24 * 60 * 60
_MATCHES_KEY = "kn:stats:matches"
_SINCE_KEY = "kn:stats:since"

_process_start = time.time()
_local: deque[float] = deque()


def _prune_local(now: float) -> None:
    cutoff = now - WEEK_SECONDS
    while _local and _local[0] < cutoff:
        _local.popleft()


async def record_match(started_at: float) -> None:
    """Count one match start. Never raises: stats must not break a game start."""
    _local.append(started_at)
    _prune_local(started_at)
    r = state._redis
    if r is None:
        return
    try:
        await r.set(_SINCE_KEY, str(started_at), nx=True)
        await r.zadd(_MATCHES_KEY, {f"{started_at:.3f}:{uuid.uuid4().hex[:8]}": started_at})
        await r.zremrangebyscore(_MATCHES_KEY, "-inf", started_at - WEEK_SECONDS)
    except Exception:
        log.exception("stats: failed to record match in Redis")


async def matches_this_week(now: float | None = None) -> int | None:
    """Matches started in the last 7 days, or None if we can't know."""
    now = time.time() if now is None else now
    r = state._redis
    if r is not None:
        try:
            since_raw = await r.get(_SINCE_KEY)
            if since_raw is None:
                # Nothing recorded yet: start the window now.
                await r.set(_SINCE_KEY, str(now), nx=True)
                return None
            if now - float(since_raw) < WEEK_SECONDS:
                return None
            return int(await r.zcount(_MATCHES_KEY, now - WEEK_SECONDS, "+inf"))
        except Exception:
            log.exception("stats: failed to read matches from Redis")
            return None
    if now - _process_start < WEEK_SECONDS:
        return None
    _prune_local(now)
    return len(_local)
