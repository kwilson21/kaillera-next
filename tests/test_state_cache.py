"""Tests for Redis-backed save-state cache behavior."""

import asyncio
import threading

from src import state_cache


def _run_async(coro):
    """Run a coroutine in a fresh thread/event loop.

    The Playwright plugin can own the main-thread loop during collection, so
    keep these small async checks isolated like the DB tests do.
    """
    result: list = []
    exc: list = []

    def _target():
        loop = asyncio.new_event_loop()
        try:
            result.append(loop.run_until_complete(coro))
        except BaseException as e:
            exc.append(e)
        finally:
            loop.close()

    t = threading.Thread(target=_target)
    t.start()
    t.join()
    if exc:
        raise exc[0]
    return result[0] if result else None


def test_put_returns_false_when_redis_write_fails(monkeypatch):
    class BrokenPipeline:
        def set(self, *args, **kwargs):
            return None

        def zadd(self, *args, **kwargs):
            return None

        def zremrangebyscore(self, *args, **kwargs):
            return None

        async def execute(self):
            raise RuntimeError("redis unavailable")

    class BrokenRedis:
        def pipeline(self):
            return BrokenPipeline()

    monkeypatch.setattr(state_cache, "_redis", BrokenRedis())

    assert _run_async(state_cache.put("S" + "a" * 16, b"state")) is False


def test_put_returns_true_for_local_cache(monkeypatch):
    monkeypatch.setattr(state_cache, "_redis", None)
    state_cache._local.clear()

    rom_hash = "S" + "b" * 16
    assert _run_async(state_cache.put(rom_hash, b"state")) is True
    assert _run_async(state_cache.get(rom_hash)) == b"state"
