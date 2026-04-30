"""
Socket.IO signaling server for kaillera-next netplay.

Handles room lifecycle, WebRTC signaling, ROM sharing coordination,
and game data relay. All events use the default Socket.IO namespace (/).

Client → Server events:
  open-room        — host creates a room
  join-room        — player joins an existing room (or as spectator)
  leave-room       — player leaves (also fired on disconnect)
  claim-slot       — spectator claims a vacated player slot
  start-game       — host starts the game (broadcasts mode + settings)
  end-game         — host ends the game (returns room to lobby)
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
  session-log      — periodic sync log flush (upserts into session_logs)
  game-screenshot  — periodic gameplay screenshot (debug/diagnostics)
  debug-sync       — upload sync diagnostic log
  debug-logs       — upload debug console log

Server → Client (targeted):
  upload-token     — HMAC token for upload endpoints (on join/open)
  reconnect-token  — HMAC token for session reconnection (on join/open)

Server → Room broadcasts:
  users-updated    — room state (players, spectators, owner)
  game-started     — game started with mode and settings
  game-ended       — game ended, back to lobby
  room-closed      — room force-closed (host left, server shutdown)
  rom-sharing-updated — ROM sharing toggle state changed

Room list is exposed via a FastAPI REST endpoint: GET /list?game_id=...
(see api/app.py — it imports `rooms` from here)

Disconnect grace period:
  Mid-game Socket.IO disconnects defer player removal for 30 seconds
  (_DISCONNECT_GRACE_SECONDS), allowing auto-reconnect to reclaim the
  slot. Cancelled on explicit leave-room or successful reconnect.
  Periodic 5-second re-stall prevents the host from running free
  indefinitely if the peer never reconnects.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import unicodedata
import uuid
from dataclasses import dataclass, field

import socketio

from src import db, state
from src.api import desync_vision
from src.api.payloads import (
    ClaimSlotPayload,
    DeviceTypePayload,
    EndGamePayload,
    InputTypePayload,
    JoinRoomPayload,
    OpenRoomPayload,
    RomReadyPayload,
    RomSharingTogglePayload,
    SessionLogPayload,
    SetGameIdPayload,
    SetModePayload,
    SetNamePayload,
    StartGamePayload,
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
_VALID_MODES = {"rollback", "streaming"}
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "100"))
MAX_SPECTATORS = int(os.environ.get("MAX_SPECTATORS", "20"))
_PER_IP_SPECTATOR_CAP = int(os.environ.get("PER_IP_SPECTATOR_CAP", "3"))
_RELAY_MAX_BYTES = 65_536
_SIGNAL_MAX_BYTES = 65_536
_DISCONNECT_GRACE_SECONDS = 30
# Short grace for lobby OWNER disconnects only — closes the ownership-churn
# race where a brief network blip transferred host privileges to another
# player. Mid-game already has the longer grace above; non-owner lobby
# disconnects still leave immediately so room state stays responsive.
_LOBBY_OWNER_GRACE_SECONDS = 5

# Per-instance signing key for HMAC tokens (upload + reconnect).
_TOKEN_KEY = secrets.token_bytes(32)

# Token TTLs. Both cover a normal match + reconnect window; on expiry the
# client must rejoin to get a fresh token.
_UPLOAD_TOKEN_TTL_S = 30 * 60
_RECONNECT_TOKEN_TTL_S = 30 * 60


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


def make_reconnect_token(persistent_id: str) -> str:
    """HMAC token that authorizes reconnect for a persistent_id.

    Bound to (persistent_id, expiry, signature, kind). Intentionally NOT
    bound to ip_hash: mobile network handoffs (5G↔Wi-Fi), CGNAT rotation,
    and VPN toggles all change the source IP mid-session, and the team has
    explicit product support for those handoffs. The realistic token-theft
    paths (XSS, local device access) already grant the attacker far worse
    capabilities than reclaiming a slot, so IP binding adds little real
    protection in exchange for breaking a supported user flow.
    """
    return _make_token(
        {
            "k": "reconnect",
            "pid": persistent_id,
            "exp": int(time.time()) + _RECONNECT_TOKEN_TTL_S,
        }
    )


def verify_reconnect_token(persistent_id: str, token: str) -> bool:
    """Verify a reconnect token: signature, expiry, persistent_id binding."""
    payload = _verify_token(token)
    if payload is None or payload.get("k") != "reconnect":
        return False
    return payload.get("pid") == persistent_id


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
    sio.cors_allowed_origins = origin


def set_shutting_down() -> None:
    global _shutting_down
    _shutting_down = True


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
    rom_sharing: bool = False  # whether host is sharing ROM via P2P
    rom_ready: set[str] = field(default_factory=set)  # sids that have a ROM loaded
    input_types: dict[str, str] = field(default_factory=dict)  # sid -> "keyboard" | "gamepad"
    device_types: dict[str, str] = field(default_factory=dict)  # sid -> "desktop" | "mobile"
    match_id: str | None = None  # per-match UUID, set on start-game, cleared on end-game

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


# ── Helpers ───────────────────────────────────────────────────────────────────


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
        "romSharing": room.rom_sharing,
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
        },
        "gameId": room.game_id,
        "game_id": room.game_id,
        "mode": room.mode,
        "status": room.status,
    }


def _clear_host_rom(room: Room) -> None:
    """Clear host ROM identity and invalidate player readiness."""
    room.rom_hash = None
    room.rom_name = None
    room.rom_size = None
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
    if room is None:
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
    if old_sid in room.input_types:
        room.input_types[new_sid] = room.input_types.pop(old_sid)
    if old_sid in room.device_types:
        room.device_types[new_sid] = room.device_types.pop(old_sid)


# Pending disconnect grace timers: persistent_id -> asyncio.Task
# When a player disconnects mid-game, we defer removal for
# _DISCONNECT_GRACE_SECONDS so Socket.IO auto-reconnect can reclaim
# their slot. Cancelled on successful reconnect.
_disconnect_grace_tasks: dict[str, asyncio.Task] = {}


def _cancel_disconnect_grace(persistent_id: str) -> None:
    """Cancel a pending disconnect grace timer if one exists."""
    task = _disconnect_grace_tasks.pop(persistent_id, None)
    if task and not task.done():
        task.cancel()
        log.info("Disconnect grace cancelled for %s (reconnected)", persistent_id)


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
    except asyncio.CancelledError:
        return  # Reconnected in time
    async with _room_lock:
        _disconnect_grace_tasks.pop(player_id, None)
        log.info("Disconnect grace expired for %s in room %s — removing", player_id, session_id)
        # Re-insert the entry so _leave can find it. The SID is dead but
        # _leave needs the mapping to locate the room/player.
        _sid_to_room[sid] = (session_id, player_id, False)
        await _leave(sid, reason)


async def _leave(sid: str, reason: str = "disconnect") -> None:
    """Remove sid from its room; handle ownership transfer and cleanup."""
    entry = _sid_to_room.pop(sid, None)
    if entry is None:
        return
    session_id, player_id, is_spectator = entry
    _cancel_disconnect_grace(player_id)

    room = rooms.get(session_id)
    if room is None:
        return

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
        if rm_slot is not None:
            del room.slots[rm_slot]

    room.rom_ready.discard(sid)
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
        await state.delete_room(session_id)
        log.info("Room %s deleted (empty)", session_id)
        return

    # Transfer ownership if the owner left.
    # Mid-game: keep the room alive so the host can reconnect (persistentId path)
    # AND so remaining peers continue play under a new owner. The previous behavior
    # of force-closing the room on any host disconnect punished tab backgrounding,
    # WiFi roams, and Playwright multi-tab orchestration.
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
        await sio.emit("webrtc-signal", {"requestRenegotiate": True}, to=new_owner_sid)

    await state.save_room(session_id, room)
    await sio.emit("users-updated", _players_payload(room), room=session_id)


# ── Startup ───────────────────────────────────────────────────────────────────


@sio.event
async def connect(sid: str, environ: dict) -> None:
    ip = extract_ip(environ)
    if not connection_allowed(ip):
        raise socketio.exceptions.ConnectionRefusedError("Too many connections")
    if not check_ip(ip, "connect"):
        raise socketio.exceptions.ConnectionRefusedError("Rate limited")
    register_sid(sid, ip)
    log.info("SIO connect %s (ip=%s)", sid, ip)


async def _cleanup_empty_rooms() -> None:
    """Periodically remove empty rooms and zombie rooms (no live sockets)."""
    _zombie_ages: dict[str, int] = {}  # session_id -> consecutive zombie ticks
    while True:
        await asyncio.sleep(60)
        to_delete = []
        for session_id, r in list(rooms.items()):
            if not r.players and not r.spectators:
                to_delete.append(session_id)
                continue
            # Zombie check: room has entries but no live sockets
            has_live = False
            for info in list(r.players.values()) + list(r.spectators.values()):
                if info["socketId"] in _sid_to_room:
                    has_live = True
                    break
            if not has_live:
                _zombie_ages[session_id] = _zombie_ages.get(session_id, 0) + 1
                if _zombie_ages[session_id] >= 5:  # 5 minutes grace period
                    to_delete.append(session_id)
            else:
                _zombie_ages.pop(session_id, None)
        async with _room_lock:
            for session_id in to_delete:
                del rooms[session_id]
                _zombie_ages.pop(session_id, None)
                await state.delete_room(session_id)
                log.info("Cleanup: deleted room %s", session_id)
        cleanup()


# ── Events ────────────────────────────────────────────────────────────────────


@sio.on("open-room")
@validated(OpenRoomPayload)
async def open_room(sid: str, payload: OpenRoomPayload) -> str | None:
    if not check(sid, "open-room"):
        return "Rate limited"
    async with _room_lock:
        return await _open_room_locked(sid, payload)


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
    if existing and persistent_id in existing.players:
        if not payload.extra.reconnectToken or not verify_reconnect_token(persistent_id, payload.extra.reconnectToken):
            return "Invalid reconnect token"
        _cancel_disconnect_grace(persistent_id)
        old_sid = existing.players[persistent_id]["socketId"]
        _swap_sid(existing, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, False)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(existing), room=session_id)
        await sio.emit("upload-token", {"token": make_upload_token(session_id)}, to=sid)
        await sio.emit("reconnect-token", {"token": make_reconnect_token(persistent_id)}, to=sid)
        await state.save_room(session_id, existing)
        log.info("SIO %s reconnected to room %s (host, persistentId=%s)", sid, session_id, persistent_id)
        return None

    if session_id in rooms:
        return "Room already exists"

    await _leave(sid)  # clean up if already in another room

    if len(rooms) >= MAX_ROOMS:
        log.warning("Server full, room rejected (MAX_ROOMS=%d)", MAX_ROOMS)
        return "Server is full"

    player_name = _sanitize_str(player_name, 32)
    room_name = _sanitize_str(room_name, 64)
    if not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32:
        game_id = "unknown"

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
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await sio.emit("upload-token", {"token": make_upload_token(session_id)}, to=sid)
    await sio.emit("reconnect-token", {"token": make_reconnect_token(persistent_id)}, to=sid)
    log.info("SIO %s opened room %s (game=%s, persistentId=%s)", sid, session_id, game_id, persistent_id)
    return None  # success


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
    if room is None:
        return ("Room not found", None)

    if room.password and not hmac.compare_digest(room.password, password or ""):
        return ("Wrong password", None)

    # Reconnect detection — BEFORE _leave
    is_returning_player = persistent_id in room.players
    is_returning_spectator = persistent_id in room.spectators
    if is_returning_player or is_returning_spectator:
        if not payload.extra.reconnectToken or not verify_reconnect_token(persistent_id, payload.extra.reconnectToken):
            return ("Invalid reconnect token", None)
        _cancel_disconnect_grace(persistent_id)
        entry = room.players.get(persistent_id) or room.spectators.get(persistent_id)
        old_sid = entry["socketId"]
        _swap_sid(room, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, is_returning_spectator)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(room), room=session_id)
        await sio.emit("upload-token", {"token": make_upload_token(session_id)}, to=sid)
        await sio.emit("reconnect-token", {"token": make_reconnect_token(persistent_id)}, to=sid)
        await state.save_room(session_id, room)
        log.info("SIO %s reconnected to room %s (persistentId=%s)", sid, session_id, persistent_id)
        resp = _players_payload(room)
        resp["status"] = room.status
        resp["mode"] = room.mode
        resp["rom_hash"] = room.rom_hash
        resp["rom_sharing"] = room.rom_sharing
        if room.match_id:
            resp["matchId"] = room.match_id
        return (None, resp)

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

    await sio.enter_room(sid, session_id)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await sio.emit("upload-token", {"token": make_upload_token(session_id)}, to=sid)
    await sio.emit("reconnect-token", {"token": make_reconnect_token(persistent_id)}, to=sid)
    await state.save_room(session_id, room)
    log.info(
        "SIO %s %s room %s (persistentId=%s)", sid, "spectating" if spectate else "joined", session_id, persistent_id
    )
    resp = _players_payload(room)
    resp["status"] = room.status
    resp["mode"] = room.mode
    resp["rom_hash"] = room.rom_hash
    resp["rom_sharing"] = room.rom_sharing
    if room.match_id:
        resp["matchId"] = room.match_id
    return (None, resp)


@sio.on("leave-room")
async def leave_room(sid: str, data: dict | None = None) -> None:
    if not check(sid, "leave-room"):
        return
    async with _room_lock:
        # Intentional leave — cancel any pending grace timer
        entry = _sid_to_room.get(sid)
        if entry:
            _cancel_disconnect_grace(entry[1])  # entry[1] = player_id
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

    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s claimed slot %d in room %s", sid, slot, session_id)
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
        await sio.emit("users-updated", _players_payload(room), room=session_id)
    return None


@sio.on("start-game")
@validated(StartGamePayload)
async def start_game(sid: str, payload: StartGamePayload) -> str | None:
    async with _room_lock:
        return await _start_game_locked(sid, payload)


async def _start_game_locked(sid: str, payload: StartGamePayload) -> str | None:
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can start the game"

    mode = payload.mode if payload.mode in _VALID_MODES else "rollback"

    # Streaming: host runs the only emulator; guests don't need a ROM.
    # Rollback: every player must have a ROM loaded (or host is sharing).
    if mode != "streaming" and not room.rom_sharing:
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
    if payload.gameId and _ALNUM_HYPHEN_RE.match(payload.gameId):
        room.game_id = payload.gameId
    await sio.emit(
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

    ended_match_id = room.match_id
    if room.match_id:
        await db.set_session_ended(room.match_id, None, "game-end")
        room.match_id = None

    room.status = "lobby"
    # mode persists for rematch convenience
    await sio.emit("game-ended", {"matchId": ended_match_id}, room=session_id)
    # Broadcast fresh state so player list reflects current device/input types
    # (late-joiners' corrected types may not have been seen by all clients)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("Game ended in room %s", session_id)
    await db.insert_client_event(
        {
            "type": "server_game_ended",
            "message": "",
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
    return None


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
        await sio.emit("users-updated", _players_payload(room), room=session_id)
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
        game_id = payload.game_id
        if not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32:
            game_id = "unknown"
        room.game_id = game_id
        await sio.emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("Game ID set to %s in room %s", game_id, session_id)
    return None


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

        room.rom_sharing = payload.enabled
        await sio.emit("rom-sharing-updated", {"romSharing": payload.enabled}, room=session_id)
        await state.save_room(session_id, room)
        log.info("ROM sharing %s in room %s", "enabled" if payload.enabled else "disabled", session_id)
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

        if sid == room.owner:
            if not payload.ready:
                _clear_host_rom(room)
            else:
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
            if _rom_hashes_conflict(room.rom_hash, payload.hash):
                room.rom_ready.discard(sid)
                await sio.emit("users-updated", _players_payload(room), room=session_id)
                await state.save_room(session_id, room)
                return "ROM does not match host"
            if room.rom_size is not None and payload.size is not None and room.rom_size != payload.size:
                room.rom_ready.discard(sid)
                await sio.emit("users-updated", _players_payload(room), room=session_id)
                await state.save_room(session_id, room)
                return "ROM does not match host"
            room.rom_ready.add(sid)
        else:
            room.rom_ready.discard(sid)
        await sio.emit("users-updated", _players_payload(room), room=session_id)
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
        await sio.emit("users-updated", _players_payload(room), room=session_id)
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
        await sio.emit("users-updated", _players_payload(room), room=session_id)
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


_WEBRTC_KEYS = ("offer", "answer", "candidate", "reconnect", "requestRenegotiate")
_ROM_SIGNAL_KEYS = ("offer", "answer", "candidate")


@sio.on("webrtc-signal")
async def webrtc_signal(sid: str, data: dict) -> None:
    await _relay_signal(sid, data, "webrtc-signal", _WEBRTC_KEYS)


@sio.on("rom-signal")
async def rom_signal(sid: str, data: dict) -> None:
    await _relay_signal(sid, data, "rom-signal", _ROM_SIGNAL_KEYS)


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
    session_id, _room = result

    target_sid = data.get("targetSid")
    if isinstance(target_sid, str) and target_sid:
        target_entry = _sid_to_room.get(target_sid)
        if target_entry and target_entry[0] == session_id:
            await sio.emit(event, data, to=target_sid)
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
    # Decode and store in DB
    import base64

    try:
        img_bytes = base64.b64decode(b64_data)
    except Exception:
        return
    # Cap at 50KB per screenshot
    if len(img_bytes) > 50_000:
        return
    await db.insert_screenshot(match_id, slot, frame, img_bytes)


_SESSION_LOG_MAX = 12 * 1024 * 1024  # 12MB cap for log_data — sized to hold the
# full client ring (SYNC_LOG_MAX=60000 entries × ~150 B/entry ≈ 9 MB) so a 60-min
# match's boot/menu/init events survive to the server. The drop-oldest-half
# fallback below kicks in only on pathologically verbose matches.

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


@sio.on("session-log")
@validated(SessionLogPayload)
async def session_log_handler(sid: str, payload: SessionLogPayload) -> None:
    """Receive periodic sync log flush from client. Upserts into session_logs table."""
    if not check(sid, "session-log"):
        return
    entry = _sid_to_room.get(sid)
    if not entry:
        return
    session_id, player_id, is_spectator = entry
    if is_spectator:
        return

    room = rooms.get(session_id)
    if not room or not room.match_id:
        return

    if not payload.matchId or payload.matchId != room.match_id:
        return

    pid_to_slot = {pid: s for s, pid in room.slots.items()}
    slot = pid_to_slot.get(player_id)

    _SUMMARY_MAX = 4096
    _CONTEXT_MAX = 2 * 1024 * 1024
    summary_clean = _sanitize_log_blob(payload.summary if isinstance(payload.summary, dict) else {})
    summary_str = json.dumps(summary_clean)
    if len(summary_str) > _SUMMARY_MAX:
        summary_str = "{}"

    context_clean = _sanitize_log_blob(payload.context if isinstance(payload.context, dict) else {})
    context = dict(context_clean) if isinstance(context_clean, dict) else {}
    if isinstance(payload.inputAudit, dict) and payload.inputAudit:
        context["inputAudit"] = _sanitize_log_blob(payload.inputAudit)
    context_str = json.dumps(context)
    if len(context_str) > _CONTEXT_MAX:
        context.pop("inputAudit", None)
        context_str = json.dumps(context)
        if len(context_str) > _SUMMARY_MAX:
            context_str = "{}"

    entries_raw = payload.entries if isinstance(payload.entries, list) else []
    entries = _sanitize_log_blob(entries_raw)
    if not isinstance(entries, list):
        entries = []
    log_data_str = json.dumps(entries)
    while len(log_data_str) > _SESSION_LOG_MAX and entries:
        # Keep LATEST entries (drop oldest) so reconnect/desync events survive
        entries = entries[len(entries) // 2 :]
        log_data_str = json.dumps(entries)

    await db.upsert_session_log(
        {
            "match_id": payload.matchId,
            "room": session_id,
            "slot": slot,
            "player_name": room.players.get(player_id, {}).get("playerName", "")[:32],
            "mode": room.mode,
            "log_data": log_data_str,
            "summary": summary_str,
            "context": context_str,
            "ip_hash": ip_hash_for_sid(sid),
        }
    )


@sio.event
async def disconnect(sid: str) -> None:
    log.info("SIO disconnect %s", sid)
    unregister_sid(sid)
    _drop_byte_history(sid)
    if _shutting_down:
        return

    async with _room_lock:
        # Mid-game disconnect grace: defer _leave so the player can reconnect
        # and reclaim their slot within _DISCONNECT_GRACE_SECONDS.
        entry = _sid_to_room.get(sid)
        if entry:
            session_id, player_id, is_spectator = entry
            room = rooms.get(session_id)
            if room and room.status == "playing" and not is_spectator:
                # Cancel any existing grace task before starting a new one —
                # a rapid reconnect→disconnect cycle could otherwise orphan
                # the old task while overwriting the dict entry.
                _cancel_disconnect_grace(player_id)
                log.info(
                    "SIO %s disconnect mid-game — %ds grace for %s in room %s",
                    sid,
                    _DISCONNECT_GRACE_SECONDS,
                    player_id,
                    session_id,
                )
                task = asyncio.create_task(_disconnect_grace_expiry(sid, session_id, player_id, "disconnect"))
                _disconnect_grace_tasks[player_id] = task
                return  # Don't call _leave yet
            # Lobby owner grace: serializes ownership transfer through a short
            # timer so a brief network blip on the host doesn't churn ownership
            # to the next player.
            if room and room.status != "playing" and not is_spectator and room.owner == sid:
                _cancel_disconnect_grace(player_id)
                log.info(
                    "SIO %s disconnect (lobby owner) — %ds grace for %s in room %s",
                    sid,
                    _LOBBY_OWNER_GRACE_SECONDS,
                    player_id,
                    session_id,
                )
                task = asyncio.create_task(
                    _disconnect_grace_expiry(sid, session_id, player_id, "disconnect", _LOBBY_OWNER_GRACE_SECONDS)
                )
                _disconnect_grace_tasks[player_id] = task
                return

        await _leave(sid)
