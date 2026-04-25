"""POST /api/desync-vision

Receives screenshots + suspect metadata from kn-vision-client.js,
calls Claude vision with a field-targeted prompt, persists the
verdict to desync_events. Content-hash dedupe to coalesce identical
calls."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db
from . import desync_prompts

router = APIRouter()

_CACHE: dict[str, dict] = {}
_CACHE_MAX = 1024

# Coalesce buffer — when multiple peers POST for the same
# (match_id, frame, field, slot), wait up to _COALESCE_MS for the
# second peer's screenshot before firing the vision call. Keeps the
# browser client thin (no cross-peer image exchange) and lets the
# server hold a single Claude call per suspect frame.
_PENDING: dict[tuple, list[PeerScreenshot]] = defaultdict(list)
_PENDING_REQ: dict[tuple, VisionRequest] = {}
_PENDING_TIMERS: dict[tuple, asyncio.Task] = {}
_COALESCE_MS = 500


class PeerScreenshot(BaseModel):
    slot: int
    png_b64: str = Field(..., description="base64-encoded PNG, downscaled to ≤512px")
    hash: int | None = None


class VisionRequest(BaseModel):
    match_id: str
    frame: int
    field: str
    slot: int | None = None
    trigger: str  # 'flag' | 'heartbeat'
    peers: list[PeerScreenshot]
    replay_meta: dict[str, Any] | None = None


async def _do_vision_call(req: VisionRequest) -> dict[str, Any]:
    """Run the vision call for a request that has 2+ peers."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(503, "vision disabled (no ANTHROPIC_API_KEY)")

    # Content-hash dedupe.
    h = hashlib.sha256()
    h.update(req.field.encode())
    h.update(str(req.slot or "").encode())
    for p in req.peers:
        h.update(p.png_b64.encode())
    content_hash = h.hexdigest()

    if content_hash in _CACHE:
        return {"cached": True, **_CACHE[content_hash]}

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)

    prompt = desync_prompts.render(req.field, req.slot)
    content_blocks: list[dict[str, Any]] = []
    for label, peer in zip(("A", "B"), req.peers[:2], strict=False):
        content_blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": peer.png_b64,
                },
            }
        )
        content_blocks.append({"type": "text", "text": f"(peer {label}, slot {peer.slot})"})
    content_blocks.append({"type": "text", "text": prompt})

    msg = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[{"role": "user", "content": content_blocks}],
    )

    raw_text = msg.content[0].text if msg.content else "{}"
    try:
        verdict = json.loads(raw_text)
    except json.JSONDecodeError:
        verdict = {"parse_error": True, "raw": raw_text, "equal": None, "confidence": "low"}

    await db.execute_write(
        """INSERT INTO desync_events
           (match_id, frame, field, slot, trigger, hashes_json,
            vision_verdict_json, vision_equal, vision_confidence,
            replay_meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            req.match_id,
            req.frame,
            req.field,
            req.slot,
            req.trigger,
            json.dumps([p.model_dump(exclude={"png_b64"}) for p in req.peers]),
            json.dumps(verdict),
            verdict.get("equal"),
            verdict.get("confidence"),
            json.dumps(req.replay_meta) if req.replay_meta else None,
        ),
    )

    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[content_hash] = {"verdict": verdict, "match_id": req.match_id, "frame": req.frame}

    return {"cached": False, "verdict": verdict, "match_id": req.match_id, "frame": req.frame}


async def _fire_vision(key: tuple) -> dict[str, Any] | None:
    """Fire the vision call for a coalesced key."""
    peers = _PENDING.pop(key, [])
    base_req = _PENDING_REQ.pop(key, None)
    timer = _PENDING_TIMERS.pop(key, None)
    if timer:
        timer.cancel()
    if len(peers) < 2 or base_req is None:
        return None
    base_req.peers = peers
    return await _do_vision_call(base_req)


@router.post("/desync-vision")
async def desync_vision(req: VisionRequest) -> dict[str, Any]:
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "vision disabled (no ANTHROPIC_API_KEY)")
    if not req.peers:
        raise HTTPException(400, "need at least 1 peer screenshot")

    key = (req.match_id, req.frame, req.field, req.slot)
    _PENDING[key].extend(req.peers)
    _PENDING_REQ[key] = req

    if len(_PENDING[key]) >= 2:
        verdict = await _fire_vision(key)
        return {"queued": False, **(verdict or {})}

    if key not in _PENDING_TIMERS:

        async def _timeout():
            await asyncio.sleep(_COALESCE_MS / 1000)
            await _fire_vision(key)

        _PENDING_TIMERS[key] = asyncio.create_task(_timeout())

    return {"queued": True, "match_id": req.match_id, "frame": req.frame}


async def _load_screenshots(match_id: str, frame: int) -> list[PeerScreenshot]:
    """Load all peer screenshots for (match_id, frame ±2) from the
    screenshots table (migration 0003). One per slot, closest-frame first."""
    rows = await db.query(
        """SELECT slot, data
           FROM screenshots
           WHERE match_id = ? AND frame BETWEEN ? AND ?
           ORDER BY slot, ABS(frame - ?)""",
        (match_id, frame - 2, frame + 2, frame),
    )
    seen_slots: set[int] = set()
    out: list[PeerScreenshot] = []
    for row in rows:
        if row["slot"] in seen_slots:
            continue
        seen_slots.add(row["slot"])
        img_bytes = row["data"]
        # img_bytes may already be base64 str (legacy rows) or raw bytes
        b64 = img_bytes if isinstance(img_bytes, str) else base64.b64encode(img_bytes).decode("ascii")
        out.append(PeerScreenshot(slot=row["slot"], png_b64=b64, hash=None))
    return out


async def run_postmortem(match_id: str) -> int:
    """For each unverified desync_event row in this match, load screenshots
    from the existing screenshots table and fire vision via _do_vision_call."""
    rows = await db.query(
        """SELECT id, match_id, frame, field, slot, trigger, hashes_json, replay_meta_json
           FROM desync_events
           WHERE match_id = ? AND vision_verdict_json IS NULL
           ORDER BY frame""",
        (match_id,),
    )
    processed = 0
    for row in rows:
        screenshots = await _load_screenshots(match_id, row["frame"])
        if len(screenshots) < 2:
            continue
        req = VisionRequest(
            match_id=row["match_id"],
            frame=row["frame"],
            field=row["field"],
            slot=row["slot"],
            trigger=row["trigger"],
            peers=screenshots,
            replay_meta=json.loads(row["replay_meta_json"]) if row["replay_meta_json"] else None,
        )
        try:
            await _do_vision_call(req)
            processed += 1
        except Exception as e:
            print(f"[postmortem] vision call failed for event {row['id']}: {e}")
    return processed
