"""
Socket.IO signaling server for kaillera-next netplay.

Handles room lifecycle, WebRTC signaling, ROM sharing coordination,
and game data relay. All events use the default Socket.IO namespace (/).

Client → Server events:
  open-room        — host creates a room
  join-room        — player joins an existing room (or as spectator)
  leave-room       — player leaves (also fired on disconnect)
  claim-slot       — spectator claims a vacated player slot
  release-slot     — player gives up their slot to spectate ("Watch instead")
  start-game       — host starts the game (broadcasts mode + settings)
  end-game         — host ends the game (returns room to lobby)
  match-recovery-unverified — current owner or active P1 reports unverified recovery
  set-mode         — host changes netplay mode (rollback/streaming)
  rom-sharing-toggle — host enables/disables P2P ROM sharing
  rom-ready        — player signals ROM is loaded
  input-type       — player reports input type (keyboard/gamepad)
  device-type      — player reports device type (desktop/mobile)
  webrtc-signal    — ICE candidate / SDP offer / answer forwarding
  rom-signal       — WebRTC signaling for pre-game ROM transfer
  data-message     — broadcast to all peers in room (save states, late-join)
  snapshot         — game snapshot relay (broadcast to room)
  input            — input relay for streaming mode (broadcast to room)
  set-name         — player updates display name
  session-log      — periodic sync log flush; a delta of entries newer than
                     the server's last-acked seq, tagged with the client's
                     ring epoch, appended into session_log_chunks (acked
                     back as `{lastSeq}`)
  game-screenshot  — periodic gameplay screenshot (debug/diagnostics)
  debug-sync       — upload sync diagnostic log
  debug-logs       — upload debug console log

Server → Client (targeted):
  upload-token     — HMAC token for upload endpoints (on admission and renewal)
  reconnect-token  — HMAC token for session reconnection (on admission and renewal)

Server → Room broadcasts:
  users-updated    — room state (players, spectators, owner)
  game-started     — game started with mode and settings
  game-ended       — game ended, back to lobby
  rom-sharing-updated — ROM sharing toggle state changed

Room list is exposed via a FastAPI REST endpoint: GET /list?game_id=...
(see api/app.py — it imports `rooms` from here)

Disconnect grace period:
  Losing the host socket reserves the room until HOST_RETURN_GRACE_SECONDS
  elapses. The host can return sooner; expiry closes the room for everyone.
  Other mid-game players keep their slot for _DISCONNECT_GRACE_SECONDS or,
  while nobody is connected, up to _SILENT_ROOM_GRACE_SECONDS.
"""

import asyncio
import base64
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import time
import unicodedata
import uuid
from collections.abc import Awaitable
from dataclasses import dataclass, field
from itertools import chain

import socketio

from src import db, state, stats
from src.api import desync_vision, og_card
from src.api.og import feature_enabled_for_host
from src.api.payloads import (
    RELAY_SENDER_KEY,
    SERVER_EVENTS,
    ClaimSlotPayload,
    DeviceTypePayload,
    EndGamePayload,
    InputTypePayload,
    JoinRoomAck,
    JoinRoomExtra,
    JoinRoomPayload,
    MatchJoinedPayload,
    MatchRecoveryUnverifiedPayload,
    OpenRoomExtra,
    OpenRoomPayload,
    RelaySender,
    RomReadyPayload,
    RomSharingTogglePayload,
    SessionLogAck,
    SessionLogPayload,
    SetGameIdPayload,
    SetListedPayload,
    SetModePayload,
    SetNamePayload,
    StartGamePayload,
    checked,
    validated,
)
from src.ratelimit import (
    check,
    check_ip,
    cleanup,
    connection_allowed,
    extract_ip,
    ip_hash_for_sid,
    register_sid,
    unregister_sid,
)

log = logging.getLogger(__name__)

_ALNUM_RE = re.compile(r"^[A-Za-z0-9]+$")
_ALNUM_HYPHEN_RE = re.compile(r"^[A-Za-z0-9\-]+$")
_ANGLE_RE = re.compile(r"[<>]")
_VALID_MODES = {"rollback", "lockstep", "streaming"}
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "100"))
MAX_SPECTATORS = int(os.environ.get("MAX_SPECTATORS", "20"))
_PER_IP_SPECTATOR_CAP = int(os.environ.get("PER_IP_SPECTATOR_CAP", "3"))
_RELAY_MAX_BYTES = 65_536
_SIGNAL_MAX_BYTES = 65_536
_DISCONNECT_GRACE_SECONDS = 30
# A dropped guest keeps its place longer during a shared signaling outage.
# Its timer never extends the room's host-return deadline.
_SILENT_ROOM_GRACE_SECONDS = 300
_SILENT_ROOM_POLL_SECONDS = 5
# The answer to a rejoin marked `resume` from a client the room no longer
# counts as a member. The page matches on this text (web/src/rejoin-attempt.ts).
NOT_IN_ROOM = "Not in room"
# The answer to a fresh open-room from a member who is not the room's owner.
# The page then joins with join-room instead (web/static/play.js).
NOT_THE_OWNER = "Not the owner"
HOST_SEAT_UNAVAILABLE = "Host seat is no longer available"
HOST_RETURN_GRACE_SECONDS = max(1, int(os.environ.get("HOST_RETURN_GRACE_SECONDS", "120")))


# Signing key for HMAC tokens (upload + reconnect). Derived from the
# deployment's IP_HASH_SALT when set, so tokens stay valid across restarts
# and players can reclaim rooms restored from Redis; random otherwise.
def _token_key(secret: str) -> bytes:
    if not secret:
        return secrets.token_bytes(32)
    return hmac.new(secret.encode(), b"kaillera-next room tokens", hashlib.sha256).digest()


_TOKEN_KEY = _token_key(os.environ.get("IP_HASH_SALT", ""))

# Live room members receive new tokens before these expire.
_UPLOAD_TOKEN_TTL_S = 30 * 60
_RECONNECT_TOKEN_TTL_S = max(30 * 60, HOST_RETURN_GRACE_SECONDS + _UPLOAD_TOKEN_TTL_S // 2 + 1)


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _make_token(payload: dict) -> str:
    """Sign a payload as <b64-json>.<hmac-sha256-hex>."""
    body = _b64e(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = hmac.new(_TOKEN_KEY, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def _verify_token(token: str) -> dict | None:
    """Verify signature + expiry; return decoded payload or None."""
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    expected_sig = hmac.new(_TOKEN_KEY, body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, sig):
        return None
    try:
        payload = json.loads(_b64d(body).decode())
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    return payload


def make_upload_token(room_id: str) -> str:
    """HMAC token that authorizes sync-log + cache-state uploads for a room.

    Bound to (room_id, expiry). The cache-state route additionally checks
    that the room's actual rom_hash matches the requested one — a token
    from room A cannot overwrite cache for an unrelated ROM hash.
    """
    return _make_token(
        {
            "k": "upload",
            "room": room_id,
            "exp": int(time.time()) + _UPLOAD_TOKEN_TTL_S,
        }
    )


def verify_upload_token(room_id: str, token: str) -> bool:
    """Verify an upload token: signature, expiry, and room binding."""
    payload = _verify_token(token)
    if payload is None or payload.get("k") != "upload":
        return False
    return payload.get("room") == room_id


def make_reconnect_token(room_id: str, persistent_id: str) -> str:
    """Sign the room and player identity. IPs can change during a mobile handoff."""
    return _make_token(
        {
            "k": "reconnect",
            "room": room_id,
            "pid": persistent_id,
            "exp": int(time.time()) + _RECONNECT_TOKEN_TTL_S,
        }
    )


def verify_reconnect_token(room_id: str, persistent_id: str, token: str, *, allow_legacy: bool = True) -> bool:
    payload = _verify_token(token)
    if payload is None or payload.get("k") != "reconnect":
        return False
    # Unexpired tokens from the preceding release have no room claim.
    correct_room = payload.get("room") == room_id or (allow_legacy and "room" not in payload)
    return correct_room and payload.get("pid") == persistent_id


def _clean_game_id(game_id: str) -> str:
    """A room's game id as stored. Empty means the host has no ROM yet, or one
    the site does not know: the room is not labelled with a game it is not.
    Anything that is not a short alphanumeric id is "unknown"."""
    if game_id and (not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32):
        return "unknown"
    return game_id


def _sanitize_str(value: str, max_len: int) -> str:
    """Sanitize a player- or room-supplied display string.

    1. NFKC normalize so visually-equivalent forms collapse together.
    2. Drop characters in the C category (control/format) — this strips
       zero-width spaces (U+200B/200C/200D), BOM (U+FEFF), bidi overrides
       (U+202A-U+202E, U+2066-U+2069), and ASCII control bytes. These are
       used to spoof other players' display names ("invisibly the same").
    3. Strip angle brackets as a defense-in-depth against XSS sinks that
       miss escaping.
    4. Collapse runs of whitespace and trim, then truncate.
    """
    s = unicodedata.normalize("NFKC", str(value))
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] != "C")
    s = _ANGLE_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:max_len]


def configure_cors(origin: str | list[str]) -> None:
    # The origin check lives in the Engine.IO layer. This used to set
    # sio.cors_allowed_origins, which nothing reads: Engine.IO kept the
    # constructor's [] (no check), so ALLOWED_ORIGIN was never enforced for
    # sockets.
    sio.eio.cors_allowed_origins = origin


def set_shutting_down() -> None:
    global _shutting_down
    _shutting_down = True
    for task in tuple(_waiting_disconnects):
        task.cancel()


async def finish_room_shutdown() -> None:
    set_shutting_down()
    # A cleanup already holding the lock may still be persisting the room.
    # Finish that write before closing storage and discard future removals.
    async with _room_lock:
        if state.enabled():
            for code, room in rooms.items():
                if room.players and room.host_return_deadline is None:
                    room.host_return_deadline = _now_ms() + HOST_RETURN_GRACE_SECONDS * 1000
                    await state.save_room(code, room)
        for task in _disconnect_grace_tasks.values():
            task.cancel()
        _disconnect_grace_tasks.clear()


# ── Socket.IO server instance ─────────────────────────────────────────────────

# Use Redis pub/sub adapter when Redis is configured. This enables cross-instance
# event routing during blue-green deploys (both old and new containers share
# the same pub/sub channel) and is required for multi-replica scaling.
_redis_url = state.get_redis_url()
_client_manager = socketio.AsyncRedisManager(_redis_url) if _redis_url else None

sio = socketio.AsyncServer(
    async_mode="asgi",
    client_manager=_client_manager,
    cors_allowed_origins=[],  # Set by configure_cors() at startup
    max_http_buffer_size=4 * 1024 * 1024,  # 4MB
)


# ── Room state ────────────────────────────────────────────────────────────────


@dataclass
class Room:
    owner: str  # sid of creator
    room_name: str
    game_id: str
    password: str | None
    max_players: int
    players: dict[str, dict] = field(default_factory=dict)
    # players: playerId -> {"socketId": sid, "playerName": ..., ...}
    slots: dict[int, str] = field(default_factory=dict)
    # slots: slot_index (0-3) -> playerId
    spectators: dict[str, dict] = field(default_factory=dict)
    # spectators: playerId -> {"socketId": sid, "playerName": ...}
    status: str = "lobby"  # "lobby" or "playing"
    mode: str | None = None  # "rollback" or "streaming", set on start-game
    rom_hash: str | None = None  # SHA-256 of ROM, set on start-game
    rom_name: str | None = None  # Host-provided display name for the currently loaded ROM
    rom_size: int | None = None  # Host-provided byte size for the currently loaded ROM
    # The host has dropped a new ROM whose hash it has not sent yet
    # (rom-ready {ready: false, pending: true}): the room names no ROM, takes
    # no guest's word and refuses a start until the host's hash arrives.
    rom_changing: bool = False
    rom_sharing: bool = False  # whether host is sharing ROM via P2P
    rom_ready: set[str] = field(default_factory=set)  # sids that have a ROM loaded
    rom_prompt: set[str] = field(default_factory=set)  # sids at the ROM prompt: no ROM, asking for one
    input_types: dict[str, str] = field(default_factory=dict)  # sid -> "keyboard" | "gamepad"
    device_types: dict[str, str] = field(default_factory=dict)  # sid -> "desktop" | "mobile"
    match_id: str | None = None  # per-match UUID, set on start-game, cleared on end-game
    recovery_unverified_match_id: str | None = None
    host_return_deadline: int | None = None  # Unix epoch milliseconds, persisted across restarts
    listed: bool = False  # host opted in to the front-page board; never true with a password
    started_at: float | None = None  # wall-clock start of the current match, for the board
    # playerIds who joined after the current match began and are not in it
    # yet (at the ROM prompt, booting, or asking for its state). A page says
    # it is in with `match-joined`. Cleared when a match starts or ends.
    waiting_for_state: set[str] = field(default_factory=set)

    def next_slot(self) -> int | None:
        """Return the lowest available slot index, or None if full."""
        for i in range(self.max_players):
            if i not in self.slots:
                return i
        return None


# sessionId -> Room
rooms: dict[str, Room] = {}

# sid -> (sessionId, playerId, is_spectator)
_sid_to_room: dict[str, tuple[str, str, bool]] = {}

# Serialize all room-mutating operations. Python's GIL does NOT protect
# against interleaving across await points — two concurrent Socket.IO
# handlers can read stale room state and then both write, corrupting it.
# Every handler that reads then mutates rooms/_sid_to_room must hold this.
_room_lock = asyncio.Lock()

_shutting_down = False
_waiting_disconnects: set[asyncio.Task] = set()

# Latest board frame per listed, in-game room: session_id -> (jpeg bytes, wall time).
# Memory only, one per room; dropped when the room ends its match, unlists or closes.
_room_frames: dict[str, tuple[bytes, float]] = {}
_ROOM_FRAME_MAX_BYTES = 20_000
_ROOM_FRAME_MAX_W, _ROOM_FRAME_MAX_H = 640, 480  # captures are 320x240


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _emit(event: str, data: dict, **kwargs) -> None:
    """Send an event the server builds itself, held to its model on the way out.

    Every such event has a model in payloads.SERVER_EVENTS (a KeyError here
    means a new event was added without one). Relays of what a client sent go
    through sio.emit directly.
    """
    await sio.emit(event, checked(SERVER_EVENTS[event], data, event), **kwargs)


async def _send_member_tokens(sid: str, session_id: str, persistent_id: str) -> None:
    await _emit("upload-token", {"token": make_upload_token(session_id)}, to=sid)
    await _emit("reconnect-token", {"token": make_reconnect_token(session_id, persistent_id)}, to=sid)


async def renew_member_tokens() -> None:
    while True:
        await asyncio.sleep(min(_UPLOAD_TOKEN_TTL_S, _RECONNECT_TOKEN_TTL_S) / 2)
        for sid in tuple(_sid_to_room):
            entry = _sid_to_room.get(sid)
            if entry is None or sid not in _sid_host:
                continue
            session_id, player_id, _ = entry
            try:
                await _send_member_tokens(sid, session_id, player_id)
            except Exception:
                log.exception("Could not renew room tokens for socket %s", sid)


def _join_ack(room: Room) -> dict:
    """The data half of the join-room ack: the room, plus what a joiner needs to catch up."""
    resp = _players_payload(room)
    resp["rom_hash"] = room.rom_hash
    resp["rom_sharing"] = _room_rom_sharing(room)
    return checked(JoinRoomAck, resp, "join-room ack")


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def host_return_expired(room: Room) -> bool:
    return room.host_return_deadline is not None and room.host_return_deadline <= _now_ms()


def host_return_status(room: Room) -> dict:
    if room.host_return_deadline is None:
        return {}
    return {"hostReturnDeadline": room.host_return_deadline, "serverTime": _now_ms()}


def _players_payload(room: Room) -> dict:
    """Return the payload emitted in users-updated."""
    pid_to_slot = {pid: slot for slot, pid in room.slots.items()}
    return {
        "players": {
            pid: {
                "socketId": info["socketId"],
                "playerName": info.get("playerName", "Player"),
                "slot": pid_to_slot.get(pid),
                "romReady": info["socketId"] in room.rom_ready,
                "romPrompt": info["socketId"] in room.rom_prompt,
                "inputType": room.input_types.get(info["socketId"], "keyboard"),
                "deviceType": room.device_types.get(info["socketId"], "desktop"),
            }
            for pid, info in room.players.items()
        },
        "spectators": {
            pid: {
                "socketId": info["socketId"],
                "playerName": info.get("playerName", "Player"),
            }
            for pid, info in room.spectators.items()
        },
        "owner": room.owner,
        "romSharing": _room_rom_sharing(room),
        "romHash": room.rom_hash,
        "romName": room.rom_name,
        "rom_name": room.rom_name,
        "romSize": room.rom_size,
        "rom_size": room.rom_size,
        "hostRom": {
            "hash": room.rom_hash,
            "name": room.rom_name,
            "size": room.rom_size,
            "gameId": room.game_id,
            "game_id": room.game_id,
            "changing": room.rom_changing,
        },
        "gameId": room.game_id,
        "game_id": room.game_id,
        "mode": room.mode,
        "status": room.status,
        "matchId": room.match_id,
        "listed": room.listed,
        "recoveryUnverifiedMatchId": room.recovery_unverified_match_id,
        **host_return_status(room),
    }


def connected_players(room: Room) -> int:
    """Players (not spectators) whose socket is connected to this server right now."""
    return sum(1 for info in room.players.values() if info["socketId"] in _sid_host)


def room_is_live(room: Room) -> bool:
    """True while at least one player's socket is connected to this server.

    A room restored from Redis after a restart or nap keeps its members but
    none of their sockets: a zombie until someone returns. Players sitting in
    a disconnect grace window don't count, and neither do spectators: a room
    with nobody left to play in it has no host to join.
    """
    return connected_players(room) > 0


def room_host_name(room: Room) -> str:
    """Display name of the room's current owner, or "" if unknown."""
    for info in room.players.values():
        if info.get("socketId") == room.owner:
            return info.get("playerName", "")
    first = next(iter(room.players.values()), None)
    return first.get("playerName", "") if first else ""


def room_frame(session_id: str) -> tuple[bytes, float] | None:
    """Latest board frame for a room that may show one right now."""
    room = rooms.get(session_id)
    if (
        room is None
        or room.host_return_deadline is not None
        or not room.listed
        or room.status != "playing"
        or not room_is_live(room)
    ):
        return None
    return _room_frames.get(session_id)


def _board_frame(jpeg: bytes) -> bytes | None:
    """The board copy of a screenshot, at most _ROOM_FRAME_MAX_BYTES and 640x480.

    Only the header is read before the size check, so a small file that
    declares huge dimensions is refused without being decoded (the board
    frame and the invite card both decode it later). Busy frames are
    re-encoded here rather than in the browser, so the diagnostic
    screenshot stored for desync triage keeps its quality.
    """
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(jpeg))
        if img.format != "JPEG" or img.width > _ROOM_FRAME_MAX_W or img.height > _ROOM_FRAME_MAX_H:
            return None
        if len(jpeg) <= _ROOM_FRAME_MAX_BYTES:
            return jpeg
        img = img.convert("RGB")
        for quality in (45, 30):
            out = io.BytesIO()
            img.save(out, "JPEG", quality=quality)
            if out.tell() <= _ROOM_FRAME_MAX_BYTES:
                return out.getvalue()
    except Exception:
        log.warning("board frame: could not re-encode a %d-byte screenshot", len(jpeg))
    return None


def _drop_room_frame(session_id: str) -> None:
    _room_frames.pop(session_id, None)
    og_card.forget(session_id)


def _clear_host_rom(room: Room) -> None:
    """Clear host ROM identity and invalidate player readiness."""
    room.rom_hash = None
    room.rom_name = None
    room.rom_size = None
    room.rom_changing = False
    room.rom_ready.clear()


def _invalidate_non_host_rom_state(room: Room) -> None:
    """Keep only the host ready state after the host changes ROM."""
    room.rom_ready = {sid for sid in room.rom_ready if sid == room.owner}


def _rom_hashes_conflict(expected: str | None, actual: str | None) -> bool:
    """Return True only when two comparable client ROM hashes disagree."""
    if not expected or not actual:
        return False
    if expected[0] != actual[0]:
        return False
    return expected != actual


def _rom_identity(room: Room) -> tuple[str | None, str | None, int | None]:
    if room.rom_hash:
        return (room.rom_hash, None, room.rom_size)
    return (room.rom_hash, room.rom_name, room.rom_size)


def _get_room(sid: str) -> tuple[str, Room] | None:
    """Look up the room for a given sid. Returns (session_id, room) or None."""
    entry = _sid_to_room.get(sid)
    if entry is None:
        return None
    session_id = entry[0]
    room = rooms.get(session_id)
    if room is None or host_return_expired(room):
        return None
    return (session_id, room)


def _swap_sid(room: Room, persistent_id: str, old_sid: str, new_sid: str) -> None:
    """Update all SID-keyed fields when a player reconnects with a new socket."""
    if room.owner == old_sid:
        room.owner = new_sid
    if persistent_id in room.players:
        room.players[persistent_id]["socketId"] = new_sid
    if persistent_id in room.spectators:
        room.spectators[persistent_id]["socketId"] = new_sid
    if old_sid in room.rom_ready:
        room.rom_ready.discard(old_sid)
        room.rom_ready.add(new_sid)
    if old_sid in room.rom_prompt:
        room.rom_prompt.discard(old_sid)
        room.rom_prompt.add(new_sid)
    if old_sid in room.input_types:
        room.input_types[new_sid] = room.input_types.pop(old_sid)
    if old_sid in room.device_types:
        room.device_types[new_sid] = room.device_types.pop(old_sid)


# A browser can reuse its persistent ID across rooms. Each membership has its own grace timer.
# When a player disconnects mid-game, we defer removal for
# _DISCONNECT_GRACE_SECONDS so Socket.IO auto-reconnect can reclaim
# their slot. Cancelled on successful reconnect.
_disconnect_grace_tasks: dict[tuple[str, str], asyncio.Task] = {}


def _cancel_disconnect_grace(session_id: str, persistent_id: str) -> None:
    """Cancel a pending disconnect grace timer if one exists."""
    task = _disconnect_grace_tasks.pop((session_id, persistent_id), None)
    if task and not task.done():
        task.cancel()
        log.info("Disconnect grace cancelled for %s in room %s", persistent_id, session_id)


def _nobody_is_connected_to_match(session_id: str) -> bool:
    """True for a playing room none of whose players has a socket here."""
    room = rooms.get(session_id)
    return room is not None and room.status == "playing" and connected_players(room) == 0


async def _disconnect_grace_expiry(
    sid: str,
    session_id: str,
    player_id: str,
    reason: str,
    grace_seconds: float = _DISCONNECT_GRACE_SECONDS,
) -> None:
    """Called after grace period expires — do the actual _leave cleanup."""
    try:
        await asyncio.sleep(grace_seconds)
        waited = grace_seconds
        while waited < _SILENT_ROOM_GRACE_SECONDS and _nobody_is_connected_to_match(session_id):
            await asyncio.sleep(_SILENT_ROOM_POLL_SECONDS)
            waited += _SILENT_ROOM_POLL_SECONDS
    except asyncio.CancelledError:
        return  # Reconnected in time
    async with _room_lock:
        key = (session_id, player_id)
        if _disconnect_grace_tasks.get(key) is not asyncio.current_task():
            return
        del _disconnect_grace_tasks[key]
        if _shutting_down or _sid_to_room.get(sid) != (session_id, player_id, False):
            return
        room = rooms.get(session_id)
        if room is None or room.players.get(player_id, {}).get("socketId") != sid:
            # The old connection no longer holds this seat.
            _sid_to_room.pop(sid, None)
            return
        log.info("Disconnect grace expired for %s in room %s — removing", player_id, session_id)
        await _leave(sid, reason)


async def _close_host_timeout(session_id: str, room: Room) -> None:
    """A reserved owner's deadline passed under the room lock."""
    del rooms[session_id]
    log.info("Room %s closed after its host return deadline", session_id)
    _drop_room_frame(session_id)
    members = []
    for pid, info in chain(room.players.items(), room.spectators.items()):
        sid = info["socketId"]
        if _sid_to_room.get(sid, (None,))[0] == session_id:
            _sid_to_room.pop(sid)
            members.append(sid)
        task = _disconnect_grace_tasks.pop((session_id, pid), None)
        if task and task is not asyncio.current_task():
            task.cancel()

    async def attempt(action: str, operation: Awaitable[None]) -> bool:
        try:
            await operation
            return True
        except Exception:
            log.exception("Could not %s while closing room %s", action, session_id)
            return False

    # The game end, closure notification and bookkeeping must survive each other's failures.
    if room.status == "playing":
        await attempt(
            "announce game end",
            _emit("game-ended", {"matchId": room.match_id, "reason": "host-timeout"}, room=session_id),
        )
    notice = {"reason": "host-timeout"}
    if not await attempt("announce room closure", _emit("room-closed", notice, room=session_id)):
        for sid in members:
            if sid in _sid_host:
                await attempt("notify remaining member", _emit("room-closed", notice, to=sid))
    if not await attempt("close socket room", sio.close_room(session_id)):
        for sid in members:
            await attempt("remove socket from room", sio.leave_room(sid, session_id))
    await attempt("delete saved room", state.delete_room(session_id))
    if room.status == "playing":
        await attempt("record match end", _record_match_end(session_id, room.match_id, "host-timeout"))


async def _wait_for_host_return(session_id: str, room: Room) -> None:
    while room.host_return_deadline is not None:
        await asyncio.sleep(max(0, room.host_return_deadline - _now_ms()) / 1000)
        async with _room_lock:
            if rooms.get(session_id) is not room or _shutting_down:
                return
            if host_return_expired(room):
                await _close_host_timeout(session_id, room)
                return


async def _reserve_host(session_id: str, room: Room, player_id: str) -> None:
    if room.host_return_deadline is None:
        room.host_return_deadline = _now_ms() + HOST_RETURN_GRACE_SECONDS * 1000
    if host_return_expired(room):
        await _close_host_timeout(session_id, room)
        return
    _cancel_disconnect_grace(session_id, player_id)
    _disconnect_grace_tasks[session_id, player_id] = asyncio.create_task(_wait_for_host_return(session_id, room))
    await state.save_room(session_id, room)
    await _emit("users-updated", _players_payload(room), room=session_id)


async def restore_host_reservations() -> None:
    """Restored owners have no socket on this server; resume their remaining time."""
    async with _room_lock:
        for code, room in list(rooms.items()):
            owner = next((pid for pid, player in room.players.items() if player["socketId"] == room.owner), None)
            if owner is not None:
                await _reserve_host(code, room, owner)


async def _leave(sid: str, reason: str = "disconnect") -> None:
    """Remove sid from its room; handle ownership transfer and cleanup."""
    entry = _sid_to_room.pop(sid, None)
    if entry is None:
        return
    session_id, player_id, is_spectator = entry
    _cancel_disconnect_grace(session_id, player_id)

    room = rooms.get(session_id)
    if room is None:
        return

    if room.owner == sid:
        room.host_return_deadline = None
    rm_slot = None  # referenced unconditionally below; spectator path leaves it None
    if is_spectator:
        room.spectators.pop(player_id, None)
    else:
        for s, pid in room.slots.items():
            if pid == player_id:
                rm_slot = s
                break
        if room.match_id and rm_slot is not None:
            await db.set_session_ended(room.match_id, rm_slot, reason)

        room.players.pop(player_id, None)
        room.waiting_for_state.discard(player_id)
        if rm_slot is not None:
            del room.slots[rm_slot]

    room.rom_ready.discard(sid)
    room.rom_prompt.discard(sid)
    room.input_types.pop(sid, None)
    room.device_types.pop(sid, None)

    await sio.leave_room(sid, session_id)
    log.info("SIO %s left room %s (playerId=%s, spectator=%s)", sid, session_id, player_id, is_spectator)

    # Log server-side disconnect to client_events so the session log
    # shows the full picture (previously only went to stdout).
    await db.insert_client_event(
        {
            "type": "server_disconnect",
            "message": reason,
            "meta": json.dumps(
                {
                    "playerId": player_id,
                    "sid": sid,
                    "spectator": is_spectator,
                    "match_id": room.match_id,
                    "slot": rm_slot,
                }
            ),
            "room": session_id,
            "slot": rm_slot if rm_slot is not None else -1,
            "ip_hash": "",
            "user_agent": "server",
        }
    )

    if not room.players and not room.spectators:
        rooms.pop(session_id, None)
        _drop_room_frame(session_id)
        await state.delete_room(session_id)
        log.info("Room %s deleted (empty)", session_id)
        return

    # Transfer ownership if the owner left.
    # Mid-game: keep the room alive so the host can reconnect (persistentId path)
    # AND so remaining peers continue play under a new owner. The previous behavior
    # of force-closing the room on any host disconnect punished tab backgrounding,
    # WiFi roams, and Playwright multi-tab orchestration.
    if room.owner == sid:
        # Listing was this host's consent; nobody who stays has given it.
        room.listed = False
        _drop_room_frame(session_id)
    if room.owner == sid and room.players:
        new_owner_pid, new_owner_info = next(iter(room.players.items()))
        new_owner_sid = new_owner_info["socketId"]
        room.owner = new_owner_sid
        room.rom_sharing = False
        if room.status != "playing":
            _clear_host_rom(room)
        # Move new owner to slot 0 (P1) only in lobby — never reshuffle slots mid-game
        # (would break input routing for the in-progress match).
        if room.status != "playing" and new_owner_pid and room.slots.get(0) != new_owner_pid:
            # Remove their old slot
            old_slot = None
            for s, pid in room.slots.items():
                if pid == new_owner_pid:
                    old_slot = s
                    break
            if old_slot is not None:
                del room.slots[old_slot]
            room.slots[0] = new_owner_pid
        log.info("Room %s ownership transferred to %s (slot 0)", session_id, new_owner_sid)
        await _emit("webrtc-signal", {"requestRenegotiate": True}, to=new_owner_sid)

    await state.save_room(session_id, room)
    await _emit("users-updated", _players_payload(room), room=session_id)
    # The players who were running the match may all be gone now.
    if not is_spectator:
        await _end_match_if_abandoned(session_id, room)


# ── Startup ───────────────────────────────────────────────────────────────────


_sid_host: dict[str, str] = {}  # sid -> Host header it connected with


@sio.event
async def connect(sid: str, environ: dict) -> None:
    ip = extract_ip(environ)
    if not connection_allowed(ip):
        raise socketio.exceptions.ConnectionRefusedError("Too many connections")
    if not check_ip(ip, "connect"):
        raise socketio.exceptions.ConnectionRefusedError("Rate limited")
    register_sid(sid, ip)
    _sid_host[sid] = environ.get("HTTP_HOST", "")
    log.info("SIO connect %s (ip=%s)", sid, ip)


async def _expire_rooms(previous: dict[str, tuple[Room, int]]) -> dict[str, tuple[Room, int]]:
    offline = {}
    async with _room_lock:
        for code, room in list(rooms.items()):
            if room.host_return_deadline is not None:
                if host_return_expired(room):
                    await _close_host_timeout(code, room)
                continue
            if room.players or room.spectators:
                members = chain(room.players.values(), room.spectators.values())
                if any(member["socketId"] in _sid_to_room for member in members):
                    continue
                # A newly opened room can reuse a code during the five-minute grace.
                previous_room, ticks = previous.get(code, (None, 0))
                ticks = ticks + 1 if previous_room is room else 1
                if ticks < 5:
                    offline[code] = (room, ticks)
                    continue
            del rooms[code]
            await state.delete_room(code)
            log.info("Cleanup: deleted room %s", code)
        for code in [key for key in _room_frames if key not in rooms]:
            _drop_room_frame(code)
    return offline


async def _cleanup_empty_rooms() -> None:
    """Periodically remove empty rooms and rooms with no live sockets."""
    offline = {}
    while True:
        await asyncio.sleep(60)
        try:
            offline = await _expire_rooms(offline)
            cleanup()
        except Exception:
            log.exception("Room cleanup sweep failed")


# ── Events ────────────────────────────────────────────────────────────────────


@sio.on("open-room")
@validated(OpenRoomPayload)
async def open_room(sid: str, payload: OpenRoomPayload) -> str | None:
    if not check(sid, "open-room"):
        return "Rate limited"
    async with _room_lock:
        return await _open_room_locked(sid, payload)


async def _reconnect_member(
    room: Room, session_id: str, persistent_id: str, sid: str, *, spectator: bool, fresh: bool
) -> str | None:
    members = room.spectators if spectator else room.players
    old_sid = members[persistent_id]["socketId"]
    if fresh and old_sid == room.owner:
        # Duplicated tabs can inherit the same identity and proof. A retry
        # from the admitted socket is already satisfied, including after Start.
        if old_sid == sid:
            return None
        if old_sid in _sid_host:
            return "Host tab is still connected"
    _cancel_disconnect_grace(session_id, persistent_id)
    if old_sid == room.owner:
        room.host_return_deadline = None
    _swap_sid(room, persistent_id, old_sid, sid)
    _sid_to_room.pop(old_sid, None)
    _sid_to_room[sid] = (session_id, persistent_id, spectator)
    await sio.enter_room(sid, session_id)

    # A fresh owner has lost its emulator even when it came back via an
    # invite. A fresh guest can still get the state from the running host.
    if fresh and room.status == "playing" and room.owner == sid:
        await _end_match(session_id, room, "host-reload")
    else:
        if fresh and not spectator and room.status == "playing":
            room.waiting_for_state.add(persistent_id)
        await _emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
    await _send_member_tokens(sid, session_id, persistent_id)
    log.info("SIO %s reconnected to room %s (persistentId=%s)", sid, session_id, persistent_id)
    await _end_match_if_abandoned(session_id, room)
    return None


async def _open_room_locked(sid: str, payload: OpenRoomPayload) -> str | None:
    session_id = payload.extra.sessionid
    persistent_id = payload.extra.persistentId or sid
    player_name = payload.extra.player_name
    room_name = payload.extra.room_name
    game_id = payload.extra.game_id
    password = payload.password or payload.extra.room_password or None
    max_players = payload.maxPlayers

    if not session_id:
        return "Missing sessionid"
    if not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
        return "Invalid room code"

    # Reconnect detection — BEFORE _leave
    existing = rooms.get(session_id)
    if existing and host_return_expired(existing):
        await _close_host_timeout(session_id, existing)
        return NOT_IN_ROOM if payload.extra.resume else HOST_SEAT_UNAVAILABLE
    if existing and persistent_id in existing.players:
        if not verify_reconnect_token(session_id, persistent_id, payload.extra.reconnectToken):
            return "Invalid reconnect token"
        old_sid = existing.players[persistent_id]["socketId"]
        # A fresh page asking to open a room it is in but no longer owns (it
        # was dropped mid-match, the room was handed on, and it was taken
        # back as a player; its URL still says host). Opening would show it a
        # lobby over a match in play, or host controls the server refuses:
        # it has to come in through join-room.
        if payload.extra.fresh and existing.owner != old_sid:
            return NOT_THE_OWNER
        return await _reconnect_member(
            existing, session_id, persistent_id, sid, spectator=False, fresh=payload.extra.fresh
        )

    # A page resuming a game it is no longer a member of. If the room is
    # still playing that match the host is taken back as a player (the room
    # was handed to someone else when it was dropped, and stays theirs);
    # otherwise it is told so, before anything is created for it.
    if payload.extra.resume:
        if existing is None or existing.host_return_deadline is not None or not _password_ok(existing, password):
            return NOT_IN_ROOM
        return await _readmit_dropped_player(
            existing, session_id, sid, persistent_id, _sanitize_str(player_name, 32), payload.extra
        )

    if session_id in rooms:
        return "Room already exists"
    if verify_reconnect_token(session_id, persistent_id, payload.extra.reconnectToken, allow_legacy=False):
        return HOST_SEAT_UNAVAILABLE

    await _leave(sid)  # clean up if already in another room

    if len(rooms) >= MAX_ROOMS:
        log.warning("Server full, room rejected (MAX_ROOMS=%d)", MAX_ROOMS)
        return "Server is full"

    player_name = _sanitize_str(player_name, 32)
    room_name = _sanitize_str(room_name, 64)
    game_id = _clean_game_id(game_id)

    room = Room(
        owner=sid,
        room_name=room_name,
        game_id=game_id,
        password=password,
        max_players=max_players,
    )
    room.players[persistent_id] = {"socketId": sid, "playerName": player_name}
    room.slots[0] = persistent_id
    rooms[session_id] = room
    _sid_to_room[sid] = (session_id, persistent_id, False)
    await state.save_room(session_id, room)

    await sio.enter_room(sid, session_id)
    await _emit("users-updated", _players_payload(room), room=session_id)
    await _send_member_tokens(sid, session_id, persistent_id)
    log.info("SIO %s opened room %s (game=%s, persistentId=%s)", sid, session_id, game_id, persistent_id)
    return None  # success


def _password_ok(room: Room, password: str | None) -> bool:
    return not room.password or hmac.compare_digest(room.password, password or "")


async def _readmit_dropped_player(
    room: Room,
    session_id: str,
    sid: str,
    persistent_id: str,
    player_name: str,
    extra: OpenRoomExtra | JoinRoomExtra,
) -> str | None:
    """Take a dropped player back into the match it is still playing.

    The caller has checked the password and that the player is not a member.
    Returns NOT_IN_ROOM unless the room is playing the match the page names
    and the slot it names is free.
    """
    slot = extra.slot
    same_match = room.status == "playing" and bool(room.match_id) and extra.matchId == room.match_id
    if not same_match or slot is None or slot >= room.max_players or slot in room.slots:
        return NOT_IN_ROOM
    await _leave(sid)  # clean up if already in another room
    room.players[persistent_id] = {"socketId": sid, "playerName": player_name}
    room.slots[slot] = persistent_id
    _sid_to_room[sid] = (session_id, persistent_id, False)
    await sio.enter_room(sid, session_id)
    await _emit("users-updated", _players_payload(room), room=session_id)
    await _send_member_tokens(sid, session_id, persistent_id)
    await state.save_room(session_id, room)
    # Its session was marked ended when the room dropped it.
    if room.match_id:
        await db.reopen_session(room.match_id, slot)
    log.info(
        "SIO %s taken back into room %s after its grace ran out (slot %d, persistentId=%s)",
        sid,
        session_id,
        slot,
        persistent_id,
    )
    return None


@sio.on("join-room")
@validated(JoinRoomPayload, error_response=("Invalid data", None))
async def join_room(sid: str, payload: JoinRoomPayload) -> tuple[str | None, dict | None]:
    if not check(sid, "join-room"):
        return ("Rate limited", None)
    async with _room_lock:
        return await _join_room_locked(sid, payload)


async def _join_room_locked(sid: str, payload: JoinRoomPayload) -> tuple[str | None, dict | None]:
    session_id = payload.extra.sessionid
    persistent_id = payload.extra.persistentId or sid
    player_name = _sanitize_str(payload.extra.player_name, 32)
    password = payload.password or None
    spectate = payload.extra.spectate

    if not session_id or not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
        return ("Invalid room code", None)

    room = rooms.get(session_id)
    return_host = payload.extra.returnHost
    if room and host_return_expired(room):
        await _close_host_timeout(session_id, room)
        room = None
    if return_host and (room is None or room.players.get(persistent_id, {}).get("socketId") != room.owner):
        return (HOST_SEAT_UNAVAILABLE, None)
    if room is None:
        return ("Room not found", None)

    # Reconnect detection — BEFORE _leave, and before the password check: a
    # returning member proves itself with its reconnect token, and the page's
    # mid-game rejoin carries no password. Asking for one here refused every
    # signaling reconnect in a password room.
    is_returning_player = persistent_id in room.players
    is_returning_spectator = persistent_id in room.spectators
    if is_returning_player or is_returning_spectator:
        if not verify_reconnect_token(
            session_id, persistent_id, payload.extra.reconnectToken, allow_legacy=not return_host
        ):
            return (HOST_SEAT_UNAVAILABLE if return_host else "Invalid reconnect token", None)
        error = await _reconnect_member(
            room,
            session_id,
            persistent_id,
            sid,
            spectator=is_returning_spectator,
            fresh=return_host or not payload.extra.resume,
        )
        return (error, None) if error else (None, _join_ack(room))

    if room.host_return_deadline is not None:
        return ("Room closed", None)
    if not _password_ok(room, password):
        return ("Wrong password", None)

    # Zombie rule: a room no player is connected to (restored after a
    # restart) only takes back its own members, above. A new joiner would
    # otherwise walk into a room with a ghost for a host. A player inside a
    # disconnect grace window is on their way back, so the room stays open.
    # Spectators never enter a room with no connected player: if that
    # player doesn't return, nobody is left to host.
    player_returning = not spectate and any((session_id, pid) in _disconnect_grace_tasks for pid in room.players)
    if not room_is_live(room) and not player_returning:
        return ("Room closed", None)

    # A page resuming a game the room has dropped it from. Still playing
    # that match with its slot free: taken back. Otherwise refused, not let
    # in as a new player: it has to end that game first, then join.
    if payload.extra.resume:
        err = await _readmit_dropped_player(room, session_id, sid, persistent_id, player_name, payload.extra)
        if err:
            return (err, None)
        return (None, _join_ack(room))

    await _leave(sid)  # clean up if already in another room

    if spectate:
        if len(room.spectators) >= MAX_SPECTATORS:
            return ("Room spectator limit reached", None)
        # Per-IP-per-room spectator cap: stops a single host from filling
        # every spectator slot and locking real watchers out. Counted by
        # ip_hash of each existing spectator's socketId.
        ip_h = ip_hash_for_sid(sid)
        same_ip_count = sum(1 for s in room.spectators.values() if ip_hash_for_sid(s.get("socketId", "")) == ip_h)
        if same_ip_count >= _PER_IP_SPECTATOR_CAP:
            return ("Spectator limit reached for your network", None)
        room.spectators[persistent_id] = {"socketId": sid, "playerName": player_name}
        _sid_to_room[sid] = (session_id, persistent_id, True)
    else:
        slot = room.next_slot()
        if slot is None:
            return ("Room is full", None)
        room.players[persistent_id] = {"socketId": sid, "playerName": player_name}
        room.slots[slot] = persistent_id
        _sid_to_room[sid] = (session_id, persistent_id, False)
        # Joining a match in play: not in it until the page says so.
        if room.status == "playing":
            room.waiting_for_state.add(persistent_id)

    await sio.enter_room(sid, session_id)
    await _emit("users-updated", _players_payload(room), room=session_id)
    await _send_member_tokens(sid, session_id, persistent_id)
    await state.save_room(session_id, room)
    log.info(
        "SIO %s %s room %s (persistentId=%s)", sid, "spectating" if spectate else "joined", session_id, persistent_id
    )
    await _end_match_if_abandoned(session_id, room)
    return (None, _join_ack(room))


@sio.on("leave-room")
async def leave_room(sid: str, data: dict | None = None) -> None:
    if not check(sid, "leave-room"):
        return
    async with _room_lock:
        await _leave(sid, reason="leave")


@sio.on("claim-slot")
@validated(ClaimSlotPayload)
async def claim_slot(sid: str, payload: ClaimSlotPayload) -> str | None:
    """Spectator claims a vacated player slot."""
    if not check(sid, "claim-slot"):
        return "Rate limited"
    async with _room_lock:
        return await _claim_slot_locked(sid, payload)


async def _claim_slot_locked(sid: str, payload: ClaimSlotPayload) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id, player_id, is_spectator = entry
    if not is_spectator:
        return "Not a spectator"
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.status == "playing":
        return "Cannot claim slot during active game"

    if payload.slot is not None:
        if payload.slot in room.slots:
            return "Slot already taken"
        slot = payload.slot
    else:
        slot = room.next_slot()
    if slot is None:
        return "No slots available"

    # Move from spectators to players
    spec_info = room.spectators.pop(player_id, {})
    player_name = spec_info.get("playerName", "Player")
    room.players[player_id] = {"socketId": sid, "playerName": player_name}
    room.slots[slot] = player_id
    _sid_to_room[sid] = (session_id, player_id, False)

    await _emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s claimed slot %d in room %s", sid, slot, session_id)
    return None


@sio.on("release-slot")
async def release_slot(sid: str, data: dict | None = None) -> str | None:
    """Player gives up their slot and becomes a spectator ("Watch instead"),
    without leaving the room. Lobby-only — mid-game slot changes would
    reshuffle a running match. The host can't release their own slot (no
    remaining player to hand ownership to would make the room ownerless)."""
    if not check(sid, "release-slot"):
        return "Rate limited"
    async with _room_lock:
        return await _release_slot_locked(sid)


async def _release_slot_locked(sid: str) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id, player_id, is_spectator = entry
    if is_spectator:
        return "Already spectating"
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.status == "playing":
        return "Cannot switch to spectator during an active game"
    if room.owner == sid:
        return "Host can't switch to spectator"
    if len(room.spectators) >= MAX_SPECTATORS:
        return "Room spectator limit reached"
    ip_h = ip_hash_for_sid(sid)
    same_ip_count = sum(1 for s in room.spectators.values() if ip_hash_for_sid(s.get("socketId", "")) == ip_h)
    if same_ip_count >= _PER_IP_SPECTATOR_CAP:
        return "Spectator limit reached for your network"

    player_info = room.players.pop(player_id, None)
    if player_info is None:
        return "Not a player"
    player_name = player_info.get("playerName", "Player")
    for slot, pid in list(room.slots.items()):
        if pid == player_id:
            del room.slots[slot]
    room.spectators[player_id] = {"socketId": sid, "playerName": player_name}
    room.rom_ready.discard(sid)
    room.rom_prompt.discard(sid)
    _sid_to_room[sid] = (session_id, player_id, True)

    await _emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s released slot to spectate in room %s", sid, session_id)
    return None


@sio.on("set-name")
@validated(SetNamePayload)
async def set_name(sid: str, payload: SetNamePayload) -> str | None:
    if not check(sid, "set-name"):
        return "Rate limited"
    name = _sanitize_str(payload.name, 24).strip()
    if not name:
        return "Empty name"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result
        # Update name in players or spectators (SID is in one collection only)
        found = False
        for info in room.players.values():
            if info["socketId"] == sid:
                info["playerName"] = name
                found = True
                break
        if not found:
            for info in room.spectators.values():
                if info["socketId"] == sid:
                    info["playerName"] = name
                    break
        await _emit("users-updated", _players_payload(room), room=session_id)
    return None


@sio.on("start-game")
@validated(StartGamePayload)
async def start_game(sid: str, payload: StartGamePayload) -> str | None:
    async with _room_lock:
        return await _start_game_locked(sid, payload)


# register_match runs under the global room lock; D1 must not hold it long.
# A registration that times out is retried by the next log flush.
_REGISTER_TIMEOUT_SEC = 2.0


async def _start_game_locked(sid: str, payload: StartGamePayload) -> str | None:
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can start the game"
    if room.status == "playing":
        return None  # A queued Start is already satisfied by the live match.

    mode = payload.mode if payload.mode in _VALID_MODES else "rollback"

    # The host's new ROM is still being hashed: the start would carry the
    # previous ROM's hash, and no guest has been held to the new one
    # (specs/rom_identity.qnt, hostChangesThenStartsTest).
    if room.rom_changing:
        return "The host's ROM is still being checked"

    # Streaming: host runs the only emulator; guests don't need a ROM.
    # Rollback: every player must have a ROM loaded (or host is sharing).
    if mode != "streaming" and not _room_rom_sharing(room):
        for info in room.players.values():
            if info["socketId"] not in room.rom_ready:
                return "Not all players have a ROM loaded"

    # ROM-hash confirmation: the room's rom_hash is established by the host
    # via rom-ready, and guests have already verified their local hashes
    # against it before they could mark themselves rom_ready. Reject any
    # start-game that tries to flip the hash to something else — that path
    # was the cleanest way to spoof guests into playing under a hash label
    # they never actually agreed to. An empty payload.romHash is treated as
    # "no change" so legacy clients keep working.
    if payload.romHash and len(payload.romHash) >= 16:
        if room.rom_hash and payload.romHash != room.rom_hash:
            return "ROM hash changed since rom-ready — refusing to start"
        room.rom_hash = payload.romHash
    room.status = "playing"
    room.mode = mode
    room.match_id = str(uuid.uuid4())
    room.recovery_unverified_match_id = None
    room.waiting_for_state.clear()
    # Register before announcing the match, so log uploads quoting this id
    # are accepted. Logging never blocks a game: a failed write is logged and
    # only HTTP-fallback uploads for this match will be refused.
    try:
        await asyncio.wait_for(db.register_match(room.match_id, session_id), _REGISTER_TIMEOUT_SEC)
    except Exception as exc:
        log.warning("Match %s not registered; its HTTP log uploads will be refused: %s", room.match_id[:8], exc)
    room.started_at = time.time()
    # Stats never hold up the room lock (Redis round trips).
    asyncio.create_task(stats.record_match(room.started_at))
    if payload.gameId and _ALNUM_HYPHEN_RE.match(payload.gameId):
        room.game_id = payload.gameId
    await _emit(
        "game-started",
        {
            "mode": room.mode,
            "resyncEnabled": payload.resyncEnabled,
            "romHash": room.rom_hash,
            "romName": room.rom_name,
            "rom_name": room.rom_name,
            "romSize": room.rom_size,
            "rom_size": room.rom_size,
            "hostRom": {
                "hash": room.rom_hash,
                "name": room.rom_name,
                "size": room.rom_size,
                "gameId": room.game_id,
                "game_id": room.game_id,
                "changing": room.rom_changing,
            },
            "gameId": room.game_id,
            "matchId": room.match_id,
        },
        room=session_id,
    )
    await state.save_room(session_id, room)
    log.info("Game started in room %s (mode=%s)", session_id, room.mode)
    await db.insert_client_event(
        {
            "type": "server_game_started",
            "message": room.mode,
            "meta": json.dumps({"match_id": room.match_id, "mode": room.mode}),
            "room": session_id,
            "slot": -1,
            "ip_hash": "",
            "user_agent": "server",
        }
    )
    return None


@sio.on("match-joined")
@validated(MatchJoinedPayload)
async def match_joined(sid: str, payload: MatchJoinedPayload) -> str | None:
    """A player who joined a match in play is now in it (running, or let into its start)."""
    if not check(sid, "match-joined"):
        return "Rate limited"
    async with _room_lock:
        entry = _sid_to_room.get(sid)
        if entry is None:
            return "Not in a room"
        session_id, player_id, _is_spectator = entry
        room = rooms.get(session_id)
        if room is None or room.status != "playing" or room.match_id != payload.matchId:
            return None  # that match is over; nothing to record
        if player_id in room.waiting_for_state:
            room.waiting_for_state.discard(player_id)
            await state.save_room(session_id, room)
        return None


@sio.on("match-recovery-unverified")
@validated(MatchRecoveryUnverifiedPayload)
async def match_recovery_unverified(sid: str, payload: MatchRecoveryUnverifiedPayload) -> str | None:
    """Record unverified recovery from the room owner or its native slot-zero authority."""
    if not check(sid, "match-recovery-unverified"):
        return "Rate limited"
    async with _room_lock:
        entry = _sid_to_room.get(sid)
        if entry is None:
            return "Not in a room"
        session_id, player_id, spectator = entry
        room = rooms.get(session_id)
        if room is None:
            return "Not in a room"
        current_player = not spectator and room.players.get(player_id, {}).get("socketId") == sid
        # Ownership can transfer without reshuffling the active rollback slots.
        # The retained native snapshot authority may report, never end the game.
        may_report = room.owner == sid or (
            room.slots.get(0) == player_id and player_id not in room.waiting_for_state and sid in _sid_host
        )
        if not current_player or not may_report:
            return "Only the host or active player 1 can report unverified match recovery"
        if room.status != "playing" or room.mode not in ("rollback", "lockstep") or room.match_id != payload.matchId:
            return "Not the current rollback or lockstep match"
        if room.recovery_unverified_match_id == room.match_id:
            return None
        room.recovery_unverified_match_id = room.match_id
        await state.save_room(session_id, room)
        await _emit("users-updated", _players_payload(room), room=session_id)
        return None


@sio.on("end-game")
@validated(EndGamePayload)
async def end_game(sid: str, payload: EndGamePayload) -> str | None:
    async with _room_lock:
        return await _end_game_locked(sid, payload)


async def _end_game_locked(sid: str, payload: EndGamePayload) -> str | None:
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can end the game"
    # A delayed retry from the previous match must not end a rematch.
    if payload.matchId is not None and room.match_id != payload.matchId:
        return None
    await _end_match(session_id, room, "game-end")
    return None


def match_is_abandoned(room: Room) -> bool:
    """Is the room playing a match that none of its players is running?

    True when every player left in it joined after the match began and is
    still waiting to get in. Late-join state comes only from a player running
    the match, so they would wait for ever: the room stayed "playing", each
    joiner timed out, and a reload put it straight back on the late-join path
    (specs/room_lifecycle.qnt, anAbandonedMatchIsEnded). A player inside a
    disconnect grace window is still in `players` and counts as running
    unless it too was waiting.
    """
    return room.status == "playing" and all(pid in room.waiting_for_state for pid in room.players)


async def _end_match_if_abandoned(session_id: str, room: Room) -> None:
    if match_is_abandoned(room):
        log.info("Room %s: nobody left is running the match, ending it", session_id)
        await _end_match(session_id, room, "abandoned")


async def _end_match(session_id: str, room: Room, reason: str) -> None:
    """Put a playing room back in the lobby and tell everyone in it."""
    ended_match_id = room.match_id
    room.match_id = None
    room.recovery_unverified_match_id = None
    room.waiting_for_state.clear()
    room.status = "lobby"
    room.started_at = None
    _drop_room_frame(session_id)

    # Broadcast the state change BEFORE the DB write below. `end-game` used
    # to await db.set_session_ended() first, which could queue behind a
    # client's session-log flush on the same connection (up to several
    # seconds under load) and delay this broadcast past the client's 5s
    # fallback. Room state (above) is already updated in memory, so the
    # broadcast reflects the true post-end state even though the DB row
    # hasn't been marked ended yet.
    # mode persists for rematch convenience
    await _emit("game-ended", {"matchId": ended_match_id, "reason": reason}, room=session_id)
    # Broadcast fresh state so player list reflects current device/input types
    # (late-joiners' corrected types may not have been seen by all clients)
    await _emit("users-updated", _players_payload(room), room=session_id)

    # Redis first, then the DB write: if set_session_ended raises, Redis must
    # already reflect the room back in "lobby" — otherwise a restart or
    # failover would restore this room still claiming to be mid-match even
    # though every client was already told the game ended above.
    await state.save_room(session_id, room)
    await _record_match_end(session_id, ended_match_id, reason)


async def _record_match_end(session_id: str, ended_match_id: str | None, reason: str) -> None:
    if ended_match_id:
        await db.set_session_ended(ended_match_id, None, reason)
    log.info("Game ended in room %s (%s)", session_id, reason)
    await db.insert_client_event(
        {
            "type": "server_game_ended",
            "message": reason,
            "meta": json.dumps({"match_id": ended_match_id}),
            "room": session_id,
            "slot": -1,
            "ip_hash": "",
            "user_agent": "server",
        }
    )
    # Kick off vision post-mortem for unverified desync_events. Async —
    # does not block the client end-game return.
    if ended_match_id:
        asyncio.create_task(desync_vision.run_postmortem(ended_match_id))


@sio.on("set-mode")
@validated(SetModePayload)
async def set_mode(sid: str, payload: SetModePayload) -> str | None:
    """Host sets the game mode pre-game so guests can update their UI."""
    if not check(sid, "set-mode"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result
        if room.owner != sid:
            return "Only the host can set the mode"
        if room.status != "lobby":
            return "Cannot change mode during game"

        mode = payload.mode if payload.mode in _VALID_MODES else "rollback"
        room.mode = mode
        await _emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("Mode set to %s in room %s", mode, session_id)
    return None


@sio.on("set-game-id")
@validated(SetGameIdPayload)
async def set_game_id(sid: str, payload: SetGameIdPayload) -> str | None:
    """Host updates game_id after ROM identification."""
    if not check(sid, "set-game-id"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result
        if room.owner != sid:
            return "Only the host can set the game"
        game_id = _clean_game_id(payload.game_id)
        room.game_id = game_id
        await _emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("Game ID set to %s in room %s", game_id, session_id)
    return None


def _rom_sharing_allowed(sid: str | None) -> bool:
    """Whether ROM_SHARING_ENABLED allows P2P ROM transfer for this socket.

    Same rule the page uses (feature_enabled_for_host on the Host the socket
    connected with), enforced here too: a client could send the events even
    though the page hides the toggle. "false" refuses everywhere.
    """
    raw = os.environ.get("ROM_SHARING_ENABLED", "true")
    return feature_enabled_for_host(raw, _sid_host.get(sid or "", ""))


def _room_rom_sharing(room: Room) -> bool:
    """room.rom_sharing, unless this server doesn't allow it for the host.

    A room restored from Redis can carry a flag set before sharing was
    turned off; it must not advertise sharing or skip the ROM check.
    """
    return room.rom_sharing and _rom_sharing_allowed(room.owner)


@sio.on("rom-sharing-toggle")
@validated(RomSharingTogglePayload)
async def rom_sharing_toggle(sid: str, payload: RomSharingTogglePayload) -> str | None:
    if not check(sid, "rom-sharing-toggle"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result
        if room.owner != sid:
            return "Only the host can toggle ROM sharing"
        if payload.enabled and not _rom_sharing_allowed(sid):
            return "ROM sharing is disabled on this server"

        room.rom_sharing = payload.enabled
        await _emit("rom-sharing-updated", {"romSharing": payload.enabled}, room=session_id)
        await state.save_room(session_id, room)
        log.info("ROM sharing %s in room %s", "enabled" if payload.enabled else "disabled", session_id)
    return None


@sio.on("set-listed")
@validated(SetListedPayload)
async def set_listed(sid: str, payload: SetListedPayload) -> str | None:
    """Host lists the room on the front-page board, or takes it off."""
    if not check(sid, "set-listed"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result
        if room.owner != sid:
            return "Only the host can list the room"
        if payload.listed and room.password:
            return "Rooms with a password can't be listed"
        room.listed = payload.listed
        if not room.listed:
            _drop_room_frame(session_id)
        await _emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("Room %s %s", session_id, "listed" if room.listed else "unlisted")
    return None


@sio.on("rom-ready")
@validated(RomReadyPayload)
async def rom_ready(sid: str, payload: RomReadyPayload) -> str | None:
    if not check(sid, "rom-ready"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result

        # Any word but "no ROM, at the prompt" ends the prompt.
        if not payload.ready and payload.prompt and sid != room.owner:
            room.rom_prompt.add(sid)
        else:
            room.rom_prompt.discard(sid)
        if sid == room.owner:
            if not payload.ready:
                _clear_host_rom(room)
                # A new ROM being hashed: until its hash arrives the room
                # names none, so no guest is judged against the ROM the host
                # had before (specs/rom_identity.qnt, HOST_DROP_SAYS_CHANGING).
                room.rom_changing = payload.pending
            else:
                room.rom_changing = False
                old_identity = _rom_identity(room)
                if payload.hash is not None:
                    room.rom_hash = payload.hash if len(payload.hash) >= 16 else None
                elif payload.name is not None or payload.size is not None:
                    room.rom_hash = None
                if payload.name is not None:
                    rom_name = _sanitize_str(payload.name, 128).strip()
                    room.rom_name = rom_name or None
                if payload.size is not None:
                    room.rom_size = payload.size
                if old_identity != _rom_identity(room):
                    _invalidate_non_host_rom_state(room)
                room.rom_ready.add(sid)
        elif payload.ready:
            # Nothing to hold the word against while the host's ROM is
            # changing; the guest's page says ready again once the room has
            # the host's new hash. A page that sends it anyway judged against
            # the ROM the host had before (its word was in flight, or it is
            # an older page).
            if room.rom_changing:
                room.rom_ready.discard(sid)
                await _emit("users-updated", _players_payload(room), room=session_id)
                await state.save_room(session_id, room)
                return "The host is changing ROM"
            if _rom_hashes_conflict(room.rom_hash, payload.hash):
                room.rom_ready.discard(sid)
                await _emit("users-updated", _players_payload(room), room=session_id)
                await state.save_room(session_id, room)
                return "ROM does not match host"
            if room.rom_size is not None and payload.size is not None and room.rom_size != payload.size:
                room.rom_ready.discard(sid)
                await _emit("users-updated", _players_payload(room), room=session_id)
                await state.save_room(session_id, room)
                return "ROM does not match host"
            room.rom_ready.add(sid)
        else:
            room.rom_ready.discard(sid)
        await _emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
    return None


@sio.on("input-type")
@validated(InputTypePayload)
async def input_type(sid: str, payload: InputTypePayload) -> str | None:
    if not check(sid, "input-type"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result

        itype = payload.type if payload.type in ("keyboard", "gamepad") else "keyboard"
        room.input_types[sid] = itype
        await _emit("users-updated", _players_payload(room), room=session_id)
    return None


@sio.on("device-type")
@validated(DeviceTypePayload)
async def device_type(sid: str, payload: DeviceTypePayload) -> str | None:
    if not check(sid, "device-type"):
        return "Rate limited"
    async with _room_lock:
        result = _get_room(sid)
        if result is None:
            return "Not in a room"
        session_id, room = result

        dtype = payload.type if payload.type in ("desktop", "mobile") else "desktop"
        room.device_types[sid] = dtype
        await _emit("users-updated", _players_payload(room), room=session_id)
    return None


async def _relay_signal(sid: str, data: dict, event: str, keys: tuple[str, ...]) -> None:
    """Shared relay logic for WebRTC signaling events."""
    if not isinstance(data, dict):
        return
    if not check(sid, event):
        return
    target: str | None = data.get("target")
    if not target:
        return
    sender_entry = _sid_to_room.get(sid)
    target_entry = _sid_to_room.get(target)
    if not sender_entry or not target_entry:
        return
    if sender_entry[0] != target_entry[0]:
        return
    payload = {"sender": sid, "target": target}
    for key in keys:
        value = data.get(key)
        if value is not None:
            try:
                val_size = len(json.dumps(value, separators=(",", ":")))
                if val_size > _SIGNAL_MAX_BYTES:
                    log.warning(
                        "Signal %s dropped: %s field %d bytes exceeds %d limit (sid=%s)",
                        event,
                        key,
                        val_size,
                        _SIGNAL_MAX_BYTES,
                        sid,
                    )
                    return
            except (TypeError, ValueError, OverflowError):
                return
            payload[key] = value
    await sio.emit(event, payload, to=target)


# `attemptId` ({page, attempt}) says which connection attempt a signal belongs
# to (web/src/attempt-id.ts); pages from before it send none. Like the rest,
# it is relayed as the sender wrote it. `startupReconnect` marks a reconnect
# offer as a startup retry from a page that has not started its game: without
# it, a page that has (in a room of three, its channel with another player
# opened first) takes the retry for a gameplay reconnect and resyncs during
# boot (specs/peer_connection.qnt, startupRetryIsNotAReconnect). Keys not
# listed here are dropped.
_WEBRTC_KEYS = ("offer", "answer", "candidate", "reconnect", "startupReconnect", "requestRenegotiate", "attemptId")
_ROM_SIGNAL_KEYS = ("offer", "answer", "candidate")


@sio.on("webrtc-signal")
async def webrtc_signal(sid: str, data: dict) -> None:
    await _relay_signal(sid, data, "webrtc-signal", _WEBRTC_KEYS)


@sio.on("rom-signal")
async def rom_signal(sid: str, data: dict) -> None:
    # Relay only while the sender's room is actually sharing (host enabled it
    # on a host this server allows). Keyed on the room, not the sender, so a
    # guest on another hostname can still answer the host's offer.
    entry = _sid_to_room.get(sid)
    room = rooms.get(entry[0]) if entry else None
    if room is None or not _room_rom_sharing(room):
        return
    await _relay_signal(sid, data, "rom-signal", _ROM_SIGNAL_KEYS)


def _relay_sender(sid: str, room: Room) -> dict:
    """The stamp `_relay` puts on a message: who sent it, as the server knows it."""
    entry = _sid_to_room.get(sid)
    slot = None
    if entry is not None and not entry[2]:
        slot = next((int(s) for s, pid in room.slots.items() if pid == entry[1]), None)
    return RelaySender(sid=sid, slot=slot, owner=room.owner == sid).model_dump()


async def _relay(sid: str, data: dict, event: str, rate_key: str, max_bytes: int = _RELAY_MAX_BYTES) -> None:
    """Validate, rate-check, and relay *data* to a room or targetSid."""
    if not isinstance(data, dict):
        return
    if not check(sid, rate_key):
        return
    try:
        payload_size = len(json.dumps(data, separators=(",", ":")))
    except (TypeError, ValueError, OverflowError):
        return
    if payload_size > max_bytes:
        log.warning("Relay %s dropped: %d bytes exceeds %d limit (sid=%s)", event, payload_size, max_bytes, sid)
        return
    if not _check_byte_budget(sid, rate_key, payload_size):
        log.warning("Relay %s throttled: byte budget exhausted (sid=%s, %d bytes)", event, sid, payload_size)
        return
    result = _get_room(sid)
    if result is None:
        return
    session_id, room = result

    # Everything else in the message is whatever the sender wrote, and any
    # member of the room, spectators included, can send one. The stamp is the
    # one part a receiver can believe: it replaces whatever the sender put
    # under the same key. Added after the size and budget checks, so it does
    # not count against the sender.
    data = {**data, RELAY_SENDER_KEY: _relay_sender(sid, room)}

    target_sid = data.get("targetSid")
    if isinstance(target_sid, str) and target_sid:
        target_entry = _sid_to_room.get(target_sid)
        if target_entry and target_entry[0] == session_id:
            await sio.emit(event, data, to=target_sid)
        return

    # Players only, not spectators: one upload from the sender, fanned out
    # here, so a 4-player initial state doesn't cost the sender three uploads
    # against its byte budget.
    if data.get("toPlayers") is True:
        for player in list(room.players.values()):
            player_sid = player.get("socketId")
            if isinstance(player_sid, str) and player_sid and player_sid != sid:
                await sio.emit(event, data, to=player_sid)
        return

    await sio.emit(event, data, room=session_id, skip_sid=sid)


# Save states are ~1.5MB gzipped; data-message needs a higher cap than input/snapshot.
_DATA_MSG_MAX_BYTES = 4 * 1024 * 1024  # 4MB (matches Socket.IO max_http_buffer_size)

# Per-sender outbound byte budgets — sit on top of the per-event count limits.
# A legitimate save-state sync is ~1.5MB and happens at match boundaries; any
# sender exceeding 8MB/sec sustained on data-message is broadcasting garbage.
# Stops a single attacker from amplifying via the room broadcast (4MB × 60/sec
# at the count limit ≈ 240MB/sec/sender × N peers in the room).
from collections import deque as _deque  # noqa: E402

_BYTE_BUDGETS: dict[str, tuple[int, float]] = {
    "data-message": (8 * 1024 * 1024, 1.0),  # 8MB / 1s
    "snapshot": (256 * 1024, 1.0),  # 256KB / 1s
    "input": (1024 * 1024, 1.0),  # 1MB / 1s
}
_byte_history: dict[tuple[str, str], _deque] = {}


def _check_byte_budget(sid: str, event: str, byte_count: int) -> bool:
    """Return False if this send would push the (sid, event) sender over budget."""
    budget = _BYTE_BUDGETS.get(event)
    if not budget:
        return True
    cap, window = budget
    now = time.monotonic()
    key = (sid, event)
    q = _byte_history.get(key)
    if q is None:
        q = _deque()
        _byte_history[key] = q
    cutoff = now - window
    while q and q[0][0] < cutoff:
        q.popleft()
    total = sum(b for _, b in q) + byte_count
    if total > cap:
        return False
    q.append((now, byte_count))
    return True


def _drop_byte_history(sid: str) -> None:
    """Remove sender's byte tracking on disconnect."""
    for event in list(_BYTE_BUDGETS):
        _byte_history.pop((sid, event), None)


@sio.on("data-message")
async def data_message(sid: str, data: dict) -> None:
    await _relay(sid, data, "data-message", "data-message", max_bytes=_DATA_MSG_MAX_BYTES)


@sio.on("snapshot")
async def snapshot(sid: str, data: dict) -> None:
    await _relay(sid, data, "snapshot", "snapshot")


@sio.on("input")
async def game_input(sid: str, data: dict) -> None:
    await _relay(sid, data, "input", "input")


@sio.on("debug-sync")
async def debug_sync(sid: str, data: dict) -> None:
    """Real-time sync status — appends to logs/live.log for live tailing.
    Only active when DEBUG_MODE=1 env var is set."""
    if not os.environ.get("DEBUG_MODE"):
        return
    if not check(sid, "debug-sync"):
        return
    from pathlib import Path

    slot = data.get("slot", "?")
    try:
        slot = str(int(slot))
    except (TypeError, ValueError):
        slot = "x"
    msg = str(data.get("msg", ""))[:1000]  # cap message size
    log_dir = Path(__file__).parent.parent.parent.parent / "logs"
    log_dir.mkdir(exist_ok=True)
    with open(log_dir / "live.log", "a") as f:  # noqa: ASYNC230 — debug-only, gated behind DEBUG_MODE
        f.write(f"[P{slot}] {msg}\n")
        f.flush()


@sio.on("debug-logs")
async def debug_logs(sid: str, data: dict) -> None:
    """Receive debug logs from a client and log to stdout.
    In DEBUG_MODE, also writes to local file."""
    if not check(sid, "debug-logs"):
        return

    entry = _sid_to_room.get(sid)
    room_id = entry[0] if entry else "unknown"
    info = data.get("info", {})
    logs = data.get("logs", [])
    if not isinstance(logs, list) or len(logs) > 5000:
        return

    # Always log summary + entries to stdout (captured by docker logs)
    slot = info.get("slot", "?")
    try:
        slot = str(int(slot))
    except (TypeError, ValueError):
        slot = "x"
    log.info("DEBUG-DUMP room=%s slot=%s entries=%d info=%s", room_id, slot, len(logs), json.dumps(info))
    for line in logs[:5000]:
        log.info("[P%s] %s", slot, str(line)[:500])

    if not os.environ.get("DEBUG_MODE"):
        return

    from datetime import datetime
    from pathlib import Path

    filename = f"debug-{room_id}-slot{slot}-{datetime.now().strftime('%H%M%S')}.log"
    log_dir = Path(__file__).parent.parent.parent.parent / "logs"
    log_dir.mkdir(exist_ok=True)
    out = log_dir / filename
    with open(out, "w") as f:  # noqa: ASYNC230 — debug-only, gated behind DEBUG_MODE
        f.write(f"Room: {room_id}  SID: {sid}\n")
        f.write(f"Info: {json.dumps(info, indent=2)}\n")
        f.write(f"Entries: {len(logs)}\n---\n")
        for line in logs[:5000]:
            f.write(str(line)[:500] + "\n")
    log.info("Debug logs written to: %s", out)


@sio.on("game-screenshot")
async def game_screenshot(sid: str, data: dict) -> None:
    """Receive periodic gameplay screenshot from client. Stored as ground-truth
    for the vision-based desync pipeline (see desync_vision.py / KNDesync); the
    actual NEQ verdict is produced by Claude vision when KNDesync flags a
    suspect frame, not by this handler."""
    if not check(sid, "game-screenshot"):
        return
    entry = _sid_to_room.get(sid)
    if not entry:
        return
    session_id, player_id, is_spectator = entry
    if is_spectator:
        return
    match_id = data.get("matchId")
    slot = data.get("slot")
    frame = data.get("frame")
    b64_data = data.get("data")
    if not match_id or slot is None or not b64_data or not frame:
        return
    # Validate match_id matches the room's current match
    room = rooms.get(session_id)
    if not room or room.match_id != match_id:
        return
    # Screenshot keys are per slot: a player may only upload their own.
    own_slot = next((s for s, pid in room.slots.items() if pid == player_id), None)
    if own_slot is None or slot != own_slot:
        return
    # Decode and store in DB
    import base64

    try:
        img_bytes = base64.b64decode(b64_data)
    except Exception:
        return
    # Cap at 50KB per screenshot
    if len(img_bytes) > 50_000:
        return
    # The host's frame doubles as the room's preview on the front-page board
    # when the room is listed. Only the latest is kept, in memory.
    if room.listed and sid == room.owner and img_bytes[:2] == b"\xff\xd8":
        # Pillow work runs off the event loop so frames can't stall signaling.
        board = await asyncio.to_thread(_board_frame, img_bytes)
        # The room may have been unlisted, ended or handed over meanwhile:
        # store only if it is still this host's listed match.
        now_room = rooms.get(session_id)
        still_ok = now_room is room and room.listed and room.owner == sid and room.match_id == match_id
        if board is not None and still_ok:
            _room_frames[session_id] = (board, time.time())
    await db.insert_screenshot(match_id, slot, frame, img_bytes)


_SESSION_LOG_MAX = 12 * 1024 * 1024  # 12MB cap on one flush's entries. Clients send
# only the entries the server hasn't acked (at most SYNC_LOG_FLUSH_MAX_ENTRIES),
# so this only bounds a stale pre-delta client resending its whole ring.

_LOG_BLOB_MAX_DEPTH = 6
_LOG_BLOB_MAX_KEYS = 256
_LOG_BLOB_MAX_LIST_LEN = 4096
_LOG_BLOB_MAX_STR = 8192


def _sanitize_log_blob(obj: object, depth: int = 0) -> object:
    """Defensively shape an untrusted JSON-ish blob from session-log payloads.

    The client controls `summary`, `context`, and `inputAudit` contents and
    we store the JSON serialization in SQLite. Without limits an attacker
    can inject deeply-nested JSON, megabyte-long string values, or
    control-character-laden text that pollutes the admin dashboard or
    primes downstream LLM analysis. We coerce to a known shape rather
    than reject — legitimate clients should always pass through untouched.
    """
    if depth > _LOG_BLOB_MAX_DEPTH:
        return None
    if obj is None or isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float)):
        return obj
    if isinstance(obj, str):
        # Printable ASCII holds no control characters: skip the per-character
        # scan, which costs ~0.8s for a full 60k-entry log.
        if obj.isascii() and obj.isprintable():
            return obj[:_LOG_BLOB_MAX_STR]
        cleaned = "".join(ch for ch in obj if ch == "\n" or ch == "\t" or unicodedata.category(ch)[0] != "C")
        return cleaned[:_LOG_BLOB_MAX_STR]
    if isinstance(obj, list):
        return [_sanitize_log_blob(item, depth + 1) for item in obj[:_LOG_BLOB_MAX_LIST_LEN]]
    if isinstance(obj, dict):
        out = {}
        for i, (k, v) in enumerate(obj.items()):
            if i >= _LOG_BLOB_MAX_KEYS:
                break
            if not isinstance(k, str):
                continue
            key = "".join(ch for ch in k if unicodedata.category(ch)[0] != "C")[:128]
            if not key:
                continue
            out[key] = _sanitize_log_blob(v, depth + 1)
        return out
    return None


# Size of the client's sync-log ring (SYNC_LOG_MAX in netplay-rollback.js): the
# most one flush can legitimately carry.
_SESSION_LOG_MAX_ENTRIES = 60_000


# `context` (with the delta-encoded inputAudit, which grows with match length)
# shares a session_logs row with `summary`, and a Cloudflare D1 row holds at
# most 2,000,000 bytes. Past this cap the audit is dropped, then the context.
_SESSION_LOG_CONTEXT_MAX = 1_500_000


def _session_log_context(context_raw: object, input_audit: object) -> str:
    """Sanitized context JSON with inputAudit attached, within _SESSION_LOG_CONTEXT_MAX.

    The audit is dropped first when it doesn't fit; a context still over
    4 KB without it becomes "{}".
    """
    context_clean = _sanitize_log_blob(context_raw if isinstance(context_raw, dict) else {})
    context = dict(context_clean) if isinstance(context_clean, dict) else {}
    if isinstance(input_audit, dict) and input_audit:
        context["inputAudit"] = _sanitize_log_blob(input_audit)
    context_str = json.dumps(context)
    if len(context_str) > _SESSION_LOG_CONTEXT_MAX:
        context.pop("inputAudit", None)
        context_str = json.dumps(context)
        if len(context_str) > 4096:
            context_str = "{}"
    return context_str


def _session_log_entries(entries_raw: object, max_bytes: int) -> list:
    """A session log flush's entries: the newest ones whose JSON fits `max_bytes`.

    Entries are sanitized one by one. Passing the whole list through
    _sanitize_log_blob capped it at _LOG_BLOB_MAX_LIST_LEN (4096) and kept the
    oldest, so a verbose match's log stopped about 90s in (match 1cd13296).
    """
    if not isinstance(entries_raw, list):
        return []
    entries = [_sanitize_log_blob(e, 1) for e in entries_raw[-_SESSION_LOG_MAX_ENTRIES:]]
    # Drop the oldest until the list fits: each entry costs its JSON plus the
    # ", " separator, the list its brackets.
    sizes = [len(json.dumps(e)) + 2 for e in entries]
    total = sum(sizes) + 2
    start = 0
    while total > max_bytes and start < len(entries):
        total -= sizes[start]
        start += 1
    return entries[start:]


# Bytes of input audit records kept from one flush; clients send at most
# 5,000 (AUDIT_FLUSH_MAX in netplay-rollback.js), about 350 KB.
_SESSION_LOG_AUDIT_MAX = 1024 * 1024


def _session_log_audit(audit_raw: object) -> tuple[str, list]:
    """A flush's input audit epoch and records, the newest that fit _SESSION_LOG_AUDIT_MAX.

    Records without an epoch are dropped: they couldn't be deduped.
    """
    if not isinstance(audit_raw, dict):
        return "", []
    epoch = audit_raw.get("epoch")
    if not isinstance(epoch, str) or not epoch:
        return "", []
    return epoch[:64], _session_log_entries(audit_raw.get("entries"), _SESSION_LOG_AUDIT_MAX)


@sio.on("session-log")
@validated(SessionLogPayload)
async def session_log_handler(sid: str, payload: SessionLogPayload) -> dict | None:
    """Receive a periodic sync log flush from client.

    `payload.entries` is a delta — only entries newer than the seq the
    server last acked — so this appends into `session_log_chunks` instead
    of rewriting the whole `session_logs.log_data` blob (see db.append_session_log).
    Returns `{"lastSeq": ..., "auditLastSeq": ...}` as the socket ack so the
    client can advance its flush cursors; the client resends anything the
    server hasn't acked. No ack data when the flush was turned away.
    """
    if not check(sid, "session-log"):
        return None
    entry = _sid_to_room.get(sid)
    if not entry:
        return None
    session_id, player_id, is_spectator = entry
    if is_spectator:
        return None

    room = rooms.get(session_id)
    if not room or not room.match_id:
        return None

    if not payload.matchId or payload.matchId != room.match_id:
        return None
    _register_match_soon(payload.matchId, session_id)

    pid_to_slot = {pid: s for s, pid in room.slots.items()}
    slot = pid_to_slot.get(player_id)
    # Turned away before sanitizing: the client resends unacked entries.
    # Nothing awaits between here and append_session_log taking its place, so
    # a burst can't pile up past this check holding decoded flushes.
    if db.session_log_busy(payload.matchId, slot):
        return None

    _SUMMARY_MAX = 4096
    summary_clean = _sanitize_log_blob(payload.summary if isinstance(payload.summary, dict) else {})
    summary_str = json.dumps(summary_clean)
    if len(summary_str) > _SUMMARY_MAX:
        summary_str = "{}"

    context_str = _session_log_context(payload.context, payload.inputAudit)

    # Newest entries win, so reconnect/desync events near the end survive.
    entries = _session_log_entries(payload.entries, _SESSION_LOG_MAX)
    audit_epoch, audit_entries = _session_log_audit(payload.audit)

    ack = await db.append_session_flush(
        {
            "match_id": payload.matchId,
            "room": session_id,
            "slot": slot,
            "player_name": room.players.get(player_id, {}).get("playerName", "")[:32],
            "mode": room.mode,
            "entries": entries,
            "epoch": payload.epoch,
            "summary": summary_str,
            "context": context_str,
            "ip_hash": ip_hash_for_sid(sid),
            "audit_epoch": audit_epoch,
            "audit_entries": audit_entries,
        }
    )
    return ack if ack is None else checked(SessionLogAck, ack, "session-log ack")


# Log-flush match registrations in flight, one per match (see _register_match_soon).
_registering: dict[str, asyncio.Task] = {}


def _register_match_soon(match_id: str, session_id: str) -> None:
    """Register the live match from a log flush (no-op after the first time),
    so matches started before a deploy or whose start-game registration failed
    still accept HTTP-fallback uploads.

    Runs in the background: the first flushes after a restart would otherwise
    wait on D1 holding their decoded payloads, outside append_session_log's cap.
    """
    if match_id in _registering:
        return

    async def register() -> None:
        try:
            await db.register_match(match_id, session_id)
        except Exception as exc:
            log.warning("Match %s not registered from a log flush: %s", match_id[:8], exc)
        finally:
            _registering.pop(match_id, None)

    _registering[match_id] = asyncio.create_task(register())


def _disconnect_finished(task: asyncio.Task) -> None:
    _waiting_disconnects.discard(task)
    if not task.cancelled() and (error := task.exception()) is not None:
        log.error("%s failed", task.get_name(), exc_info=error)


@sio.event
async def disconnect(sid: str, reason: str | None = None) -> None:
    log.info("SIO disconnect %s (%s)", sid, reason)
    unregister_sid(sid)
    _sid_host.pop(sid, None)
    _drop_byte_history(sid)
    if _shutting_down:
        return

    # A roster send under the lock can await this transport callback. Let
    # delivery return before taking the lock for this SID's membership.
    if _room_lock.locked():
        task = asyncio.create_task(_disconnect_from_room(sid), name=f"disconnect room member {sid}")
        _waiting_disconnects.add(task)
        task.add_done_callback(_disconnect_finished)
        return
    await _disconnect_from_room(sid)


async def _disconnect_from_room(sid: str) -> None:
    async with _room_lock:
        _waiting_disconnects.discard(asyncio.current_task())
        if _shutting_down:
            return
        # Mid-game disconnect grace: defer _leave so the player can reconnect
        # and reclaim their slot within _DISCONNECT_GRACE_SECONDS.
        entry = _sid_to_room.get(sid)
        if entry:
            session_id, player_id, is_spectator = entry
            room = rooms.get(session_id)
            if room and not is_spectator and room.owner == sid:
                await _reserve_host(session_id, room, player_id)
                return
            if room and room.status == "playing" and not is_spectator:
                # Cancel any existing grace task before starting a new one —
                # a rapid reconnect→disconnect cycle could otherwise orphan
                # the old task while overwriting the dict entry.
                _cancel_disconnect_grace(session_id, player_id)
                log.info(
                    "SIO %s disconnect mid-game — %ds grace for %s in room %s",
                    sid,
                    _DISCONNECT_GRACE_SECONDS,
                    player_id,
                    session_id,
                )
                task = asyncio.create_task(_disconnect_grace_expiry(sid, session_id, player_id, "disconnect"))
                _disconnect_grace_tasks[session_id, player_id] = task
                return  # Don't call _leave yet

        await _leave(sid)
