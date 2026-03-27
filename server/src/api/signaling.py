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
  set-mode         — host changes netplay mode (lockstep/streaming)
  rom-sharing-toggle — host enables/disables P2P ROM sharing
  rom-ready        — player signals ROM is loaded
  rom-declare      — player declares ROM ownership (streaming mode)
  input-type       — player reports input type (keyboard/gamepad)
  device-type      — player reports device type (desktop/mobile)
  webrtc-signal    — ICE candidate / SDP offer / answer forwarding
  rom-signal       — WebRTC signaling for pre-game ROM transfer
  data-message     — broadcast to all peers in room (save states, late-join)
  snapshot         — game snapshot relay (broadcast to room)
  input            — input relay for streaming mode (broadcast to room)
  debug-sync       — upload sync diagnostic log
  debug-logs       — upload debug console log

Server → Room broadcasts:
  users-updated    — room state (players, spectators, owner)
  game-started     — game started with mode and settings
  game-ended       — game ended, back to lobby
  room-closed      — room force-closed (host left, server shutdown)
  rom-sharing-updated — ROM sharing toggle state changed

Room list is exposed via a FastAPI REST endpoint: GET /list?game_id=...
(see api/app.py — it imports `rooms` from here)
"""

import asyncio
import hmac
import logging
import os
import re
from dataclasses import dataclass, field

import socketio

from src import state
from src.api.payloads import (
    ClaimSlotPayload,
    DeviceTypePayload,
    EndGamePayload,
    InputTypePayload,
    JoinRoomPayload,
    OpenRoomPayload,
    RomDeclarePayload,
    RomReadyPayload,
    RomSharingTogglePayload,
    SetModePayload,
    SetNamePayload,
    StartGamePayload,
    validated,
)
from src.ratelimit import check, check_ip, cleanup, connection_allowed, register_sid, unregister_sid

log = logging.getLogger(__name__)

_ALNUM_RE = re.compile(r"^[A-Za-z0-9]+$")
_ALNUM_HYPHEN_RE = re.compile(r"^[A-Za-z0-9\-]+$")
_VALID_MODES = {"lockstep", "streaming"}
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "100"))
MAX_SPECTATORS = int(os.environ.get("MAX_SPECTATORS", "20"))


def _sanitize_str(value: str, max_len: int) -> str:
    """Strip angle brackets and truncate."""
    return re.sub(r"[<>]", "", str(value))[:max_len]


def configure_cors(origin: str) -> None:
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
    mode: str | None = None  # "lockstep" or "streaming", set on start-game
    rom_hash: str | None = None  # SHA-256 of ROM, set on start-game
    rom_sharing: bool = False  # whether host is sharing ROM via P2P
    rom_ready: set[str] = field(default_factory=set)  # sids that have a ROM loaded
    rom_declared: set[str] = field(default_factory=set)  # sids that declared ROM ownership (streaming)
    input_types: dict[str, str] = field(default_factory=dict)  # sid -> "keyboard" | "gamepad"
    device_types: dict[str, str] = field(default_factory=dict)  # sid -> "desktop" | "mobile"

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

_shutting_down = False


# ── Helpers ───────────────────────────────────────────────────────────────────


def _players_payload(room: Room) -> dict:
    """Return the payload emitted in users-updated."""
    pid_to_slot = {pid: slot for slot, pid in room.slots.items()}
    return {
        "players": {
            pid: {
                **info,
                "slot": pid_to_slot.get(pid),
                "romReady": info["socketId"] in room.rom_ready,
                "romDeclared": info["socketId"] in room.rom_declared,
                "inputType": room.input_types.get(info["socketId"], "keyboard"),
                "deviceType": room.device_types.get(info["socketId"], "desktop"),
            }
            for pid, info in room.players.items()
        },
        "spectators": dict(room.spectators.items()),
        "owner": room.owner,
        "romSharing": room.rom_sharing,
        "mode": room.mode,
        "status": room.status,
    }


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
    if old_sid in room.rom_declared:
        room.rom_declared.discard(old_sid)
        room.rom_declared.add(new_sid)
    if old_sid in room.input_types:
        room.input_types[new_sid] = room.input_types.pop(old_sid)
    if old_sid in room.device_types:
        room.device_types[new_sid] = room.device_types.pop(old_sid)


async def _leave(sid: str) -> None:
    """Remove sid from its room; handle ownership transfer and cleanup."""
    entry = _sid_to_room.pop(sid, None)
    if entry is None:
        return
    session_id, player_id, is_spectator = entry

    room = rooms.get(session_id)
    if room is None:
        return

    if is_spectator:
        room.spectators.pop(player_id, None)
    else:
        room.players.pop(player_id, None)
        # Free the slot
        rm_slot = None
        for s, pid in room.slots.items():
            if pid == player_id:
                rm_slot = s
                break
        if rm_slot is not None:
            del room.slots[rm_slot]

    room.rom_ready.discard(sid)
    room.rom_declared.discard(sid)
    room.input_types.pop(sid, None)
    room.device_types.pop(sid, None)

    await sio.leave_room(sid, session_id)
    log.info("SIO %s left room %s (playerId=%s, spectator=%s)", sid, session_id, player_id, is_spectator)

    if not room.players and not room.spectators:
        rooms.pop(session_id, None)
        await state.delete_room(session_id)
        log.info("Room %s deleted (empty)", session_id)
        return

    # Host left mid-game: close the room for everyone
    if room.owner == sid and room.status == "playing":
        await sio.emit("room-closed", {"reason": "host-left"}, room=session_id)
        # Clean up all remaining members
        for remaining_sid, (rsess, _, _) in list(_sid_to_room.items()):
            if rsess == session_id:
                del _sid_to_room[remaining_sid]
                await sio.leave_room(remaining_sid, session_id)
        rooms.pop(session_id, None)
        await state.delete_room(session_id)
        log.info("Room %s closed (host left mid-game)", session_id)
        return

    # Transfer ownership if the owner left (lobby only)
    if room.owner == sid and room.players:
        new_owner_pid, new_owner_info = next(iter(room.players.items()))
        new_owner_sid = new_owner_info["socketId"]
        room.owner = new_owner_sid
        room.rom_sharing = False
        # Move new owner to slot 0 (P1) if they're not already there
        if new_owner_pid and room.slots.get(0) != new_owner_pid:
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
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() if forwarded else environ.get("REMOTE_ADDR", "unknown")
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
        old_sid = existing.players[persistent_id]["socketId"]
        _swap_sid(existing, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, False)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(existing), room=session_id)
        await state.save_room(session_id, existing)
        log.info("SIO %s reconnected to room %s (host, persistentId=%s)", sid, session_id, persistent_id)
        return None

    if session_id in rooms:
        return "Room already exists"

    await _leave(sid)  # clean up if already in another room

    if len(rooms) >= MAX_ROOMS:
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
    log.info("SIO %s opened room %s (game=%s, persistentId=%s)", sid, session_id, game_id, persistent_id)
    return None  # success


@sio.on("join-room")
@validated(JoinRoomPayload, error_response=("Invalid data", None))
async def join_room(sid: str, payload: JoinRoomPayload) -> tuple[str | None, dict | None]:
    if not check(sid, "join-room"):
        return ("Rate limited", None)

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

    # Reconnect detection — BEFORE _leave
    is_returning_player = persistent_id in room.players
    is_returning_spectator = persistent_id in room.spectators
    if is_returning_player or is_returning_spectator:
        entry = room.players.get(persistent_id) or room.spectators.get(persistent_id)
        old_sid = entry["socketId"]
        _swap_sid(room, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, is_returning_spectator)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("SIO %s reconnected to room %s (persistentId=%s)", sid, session_id, persistent_id)
        return (None, _players_payload(room))

    await _leave(sid)  # clean up if already in another room

    if room.password and not hmac.compare_digest(room.password, password or ""):
        return ("Wrong password", None)

    if spectate:
        if len(room.spectators) >= MAX_SPECTATORS:
            return ("Room spectator limit reached", None)
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
    await state.save_room(session_id, room)
    log.info(
        "SIO %s %s room %s (persistentId=%s)", sid, "spectating" if spectate else "joined", session_id, persistent_id
    )
    return (None, _players_payload(room))


@sio.on("leave-room")
async def leave_room(sid: str, data: dict | None = None) -> None:
    await _leave(sid)


@sio.on("claim-slot")
@validated(ClaimSlotPayload)
async def claim_slot(sid: str, payload: ClaimSlotPayload) -> str | None:
    """Spectator claims a vacated player slot."""
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id, player_id, is_spectator = entry
    if not is_spectator:
        return "Not a spectator"
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"

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
    name = _sanitize_str(payload.name, 24).strip()
    if not name:
        return "Empty name"
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    # Update name in players or spectators
    for info in room.players.values():
        if info["socketId"] == sid:
            info["playerName"] = name
            break
    for info in room.spectators.values():
        if info["socketId"] == sid:
            info["playerName"] = name
            break
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    return None


@sio.on("start-game")
@validated(StartGamePayload)
async def start_game(sid: str, payload: StartGamePayload) -> str | None:
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can start the game"

    mode = payload.mode if payload.mode in _VALID_MODES else "lockstep"

    # Streaming: check all players declared ROM ownership
    # Lockstep: check all players have ROMs (or host is sharing)
    if mode == "streaming":
        for info in room.players.values():
            if info["socketId"] == room.owner:
                continue  # host has the ROM
            if info["socketId"] not in room.rom_declared:
                return "Not all players have declared ROM ownership"
    elif not room.rom_sharing:
        for info in room.players.values():
            if info["socketId"] not in room.rom_ready:
                return "Not all players have a ROM loaded"

    room.status = "playing"
    room.mode = mode
    if payload.romHash and len(payload.romHash) >= 16:
        room.rom_hash = payload.romHash
    await sio.emit(
        "game-started",
        {
            "mode": room.mode,
            "rollbackEnabled": payload.rollbackEnabled,
            "romHash": room.rom_hash,
        },
        room=session_id,
    )
    await state.save_room(session_id, room)
    log.info("Game started in room %s (mode=%s)", session_id, room.mode)
    return None


@sio.on("end-game")
@validated(EndGamePayload)
async def end_game(sid: str, payload: EndGamePayload) -> str | None:
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can end the game"

    room.status = "lobby"
    # mode persists for rematch convenience
    await sio.emit("game-ended", {}, room=session_id)
    # Broadcast fresh state so player list reflects current device/input types
    # (late-joiners' corrected types may not have been seen by all clients)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("Game ended in room %s", session_id)
    return None


@sio.on("set-mode")
@validated(SetModePayload)
async def set_mode(sid: str, payload: SetModePayload) -> str | None:
    """Host sets the game mode pre-game so guests can update their UI."""
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result
    if room.owner != sid:
        return "Only the host can set the mode"
    if room.status != "lobby":
        return "Cannot change mode during game"

    mode = payload.mode if payload.mode in _VALID_MODES else "lockstep"
    room.mode = mode
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("Mode set to %s in room %s", mode, session_id)
    return None


@sio.on("rom-sharing-toggle")
@validated(RomSharingTogglePayload)
async def rom_sharing_toggle(sid: str, payload: RomSharingTogglePayload) -> str | None:
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
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result

    if payload.ready:
        room.rom_ready.add(sid)
    else:
        room.rom_ready.discard(sid)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    return None


@sio.on("rom-declare")
@validated(RomDeclarePayload)
async def rom_declare(sid: str, payload: RomDeclarePayload) -> str | None:
    """Player declares they own a legal copy of the ROM (streaming mode)."""
    result = _get_room(sid)
    if result is None:
        return "Not in a room"
    session_id, room = result

    if payload.declared:
        room.rom_declared.add(sid)
    else:
        room.rom_declared.discard(sid)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    return None


@sio.on("input-type")
@validated(InputTypePayload)
async def input_type(sid: str, payload: InputTypePayload) -> str | None:
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


async def _relay(sid: str, data: dict, event: str, rate_key: str) -> None:
    """Validate, rate-check, and broadcast *data* to all peers in the sender's room."""
    if not isinstance(data, dict):
        return
    if not check(sid, rate_key):
        return
    result = _get_room(sid)
    if result is None:
        return
    session_id, _room = result
    await sio.emit(event, data, room=session_id, skip_sid=sid)


@sio.on("data-message")
async def data_message(sid: str, data: dict) -> None:
    await _relay(sid, data, "data-message", "data-message")


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
    import json

    entry = _sid_to_room.get(sid)
    room_id = entry[0] if entry else "unknown"
    info = data.get("info", {})
    logs = data.get("logs", [])
    if not isinstance(logs, list) or len(logs) > 5000:
        return

    # Always log summary + entries to stdout (captured by docker logs)
    slot = info.get("slot", "?")
    log.info("DEBUG-DUMP room=%s slot=%s entries=%d info=%s", room_id, slot, len(logs), json.dumps(info))
    for line in logs[:5000]:
        log.info("[P%s] %s", slot, str(line)[:500])

    # In DEBUG_MODE, also write to local file for convenience
    if os.environ.get("DEBUG_MODE"):
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
        log.info("Debug logs also written to: %s", out)


@sio.event
async def disconnect(sid: str) -> None:
    log.info("SIO disconnect %s", sid)
    unregister_sid(sid)
    if not _shutting_down:
        await _leave(sid)
