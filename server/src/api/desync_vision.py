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
import logging
import os
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, insert, select

from .. import db
from ..schema import DesyncEvent, Screenshot
from . import desync_prompts

log = logging.getLogger(__name__)

router = APIRouter()


def is_enabled() -> bool:
    """Vision postmortems are billable Claude calls. Require BOTH a
    DESYNC_VISION_ENABLED=1 flag AND an ANTHROPIC_API_KEY — key presence
    alone shouldn't silently turn on billing."""
    return os.getenv("DESYNC_VISION_ENABLED") == "1" and bool(os.getenv("ANTHROPIC_API_KEY"))


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
    # The frame the picture shows. Peers capture at a frame they agree on
    # (kn-desync-detector.js); None from a client older than that, or from a
    # postmortem, which pairs stored screenshots by frame itself.
    captured_frame: int | None = None


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
    if not is_enabled():
        raise HTTPException(503, "vision disabled (set DESYNC_VISION_ENABLED=1 and ANTHROPIC_API_KEY)")
    api_key = os.getenv("ANTHROPIC_API_KEY")

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

    await db.run(
        insert(DesyncEvent).values(
            match_id=req.match_id,
            frame=req.frame,
            field=req.field,
            slot=req.slot,
            trigger=req.trigger,
            hashes_json=json.dumps([p.model_dump(exclude={"png_b64"}) for p in req.peers]),
            vision_verdict_json=json.dumps(verdict),
            vision_equal=verdict.get("equal"),
            vision_confidence=verdict.get("confidence"),
            replay_meta_json=json.dumps(req.replay_meta) if req.replay_meta else None,
        )
    )

    await _flag_if_desynced(req.match_id, req.frame, verdict)

    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[content_hash] = {"verdict": verdict, "match_id": req.match_id, "frame": req.frame}

    return {"cached": False, "verdict": verdict, "match_id": req.match_id, "frame": req.frame}


async def _flag_if_desynced(match_id: str, frame: int, verdict: dict) -> None:
    """A vision verdict of 'not equal' keeps the match until resolved (retention)."""
    if verdict.get("equal") is not False:
        return
    try:
        await db.flag_match(match_id, [{"signal": "vision-desync", "count": 1, "first_f": frame}])
    except Exception as exc:
        log.warning("Flagging %s for a vision desync failed: %s", match_id[:8], exc)


async def _fire_vision(key: tuple) -> dict[str, Any] | None:
    """Fire the vision call for a coalesced key."""
    peers = _PENDING.pop(key, [])
    base_req = _PENDING_REQ.pop(key, None)
    timer = _PENDING_TIMERS.pop(key, None)
    if timer:
        timer.cancel()
    if len(peers) < 2 or base_req is None:
        return None
    # Two pictures of different frames of a moving game differ whether or not
    # the peers do; a verdict on them would be a false "desynced".
    frames = {p.captured_frame for p in peers[:2]}
    if len(frames) > 1:
        log.info("desync-vision: not comparing pictures of different frames %s for %s", sorted(frames, key=str), key)
        return {"skipped": "captured_at_different_frames", "match_id": base_req.match_id, "frame": base_req.frame}
    base_req.peers = peers
    return await _do_vision_call(base_req)


@router.post("/desync-vision")
async def desync_vision(req: VisionRequest) -> dict[str, Any]:
    if not is_enabled():
        raise HTTPException(503, "vision disabled (set DESYNC_VISION_ENABLED=1 and ANTHROPIC_API_KEY)")
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
    """Load all peer screenshots for (match_id, frame ±2): rows from the
    screenshots table, bytes from the blob store. One per slot, closest-frame
    first."""
    rows = await db.fetch(
        select(Screenshot.slot, Screenshot.blob_key, Screenshot.data)
        .where(Screenshot.match_id == match_id, Screenshot.frame.between(frame - 2, frame + 2))
        .order_by(Screenshot.slot, func.abs(Screenshot.frame - frame))
    )
    seen_slots: set[int] = set()
    out: list[PeerScreenshot] = []
    for row in rows:
        if row["slot"] in seen_slots:
            continue
        seen_slots.add(row["slot"])
        img_bytes = await db.read_screenshot(row)
        if img_bytes is None:
            continue
        # img_bytes may already be base64 str (legacy rows) or raw bytes
        b64 = img_bytes if isinstance(img_bytes, str) else base64.b64encode(img_bytes).decode("ascii")
        out.append(PeerScreenshot(slot=row["slot"], png_b64=b64, hash=None))
    return out


async def run_postmortem(match_id: str) -> int:
    """For each unverified desync_event row in this match, load screenshots
    from the existing screenshots table and fire vision via _do_vision_call.

    No-op if the vision feature flag is off — keeps the signaling caller
    unconditional while ensuring billable calls only fire when explicitly
    enabled."""
    if not is_enabled():
        return 0
    rows = await db.fetch(
        select(
            DesyncEvent.id,
            DesyncEvent.match_id,
            DesyncEvent.frame,
            DesyncEvent.field,
            DesyncEvent.slot,
            DesyncEvent.trigger,
            DesyncEvent.hashes_json,
            DesyncEvent.replay_meta_json,
        )
        .where(DesyncEvent.match_id == match_id, DesyncEvent.vision_verdict_json.is_(None))
        .order_by(DesyncEvent.frame)
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
