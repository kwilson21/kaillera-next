"""
Socket.IO signaling server — EmulatorJS-Netplay compatible.

EmulatorJS's built-in netplay UI connects to {EJS_netplayServer}/socket.io/
and fires these events:

  open-room   — host creates a room
  join-room   — player joins an existing room
  leave-room  — player leaves (also fired on disconnect)
  webrtc-signal — ICE candidate / SDP offer / answer forwarding
  data-message / snapshot / input — broadcast to all peers in room

Room list is exposed via a FastAPI REST endpoint: GET /list?game_id=...
(see api/app.py — it imports `rooms` from here)
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import re
import sys
from dataclasses import dataclass, field

import socketio

log = logging.getLogger(__name__)

_ALNUM_RE = re.compile(r"^[A-Za-z0-9]+$")
_ALNUM_HYPHEN_RE = re.compile(r"^[A-Za-z0-9\-]+$")
_VALID_MODES = {"lockstep", "streaming"}
_MAX_RELAY_SIZE = 2 * 1024 * 1024  # 2MB


def _sanitize_str(value: str, max_len: int) -> str:
    """Strip angle brackets and truncate."""
    return re.sub(r"[<>]", "", str(value))[:max_len]


def configure_cors(origin: str) -> None:
    sio.cors_allowed_origins = origin if origin != "*" else "*"


# ── Socket.IO server instance ─────────────────────────────────────────────────

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=[],  # Set by configure_cors() at startup
    max_http_buffer_size=4 * 1024 * 1024,  # 4MB
)


# ── Room state ────────────────────────────────────────────────────────────────

@dataclass
class Room:
    owner: str                        # sid of creator
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
    status: str = "lobby"       # "lobby" or "playing"
    mode: str | None = None     # "lockstep" or "streaming", set on start-game
    rom_hash: str | None = None # SHA-256 of ROM, set on start-game
    rom_sharing: bool = False     # whether host is sharing ROM via P2P

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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _players_payload(room: Room) -> dict:
    """Return the payload emitted in users-updated."""
    pid_to_slot = {pid: slot for slot, pid in room.slots.items()}
    return {
        "players": {
            pid: {**info, "slot": pid_to_slot.get(pid)}
            for pid, info in room.players.items()
        },
        "spectators": {
            pid: info
            for pid, info in room.spectators.items()
        },
        "owner": room.owner,
        "romSharing": room.rom_sharing,
    }


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

    await sio.leave_room(sid, session_id)
    log.info("SIO %s left room %s (playerId=%s, spectator=%s)", sid, session_id, player_id, is_spectator)

    if not room.players and not room.spectators:
        del rooms[session_id]
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
        del rooms[session_id]
        log.info("Room %s closed (host left mid-game)", session_id)
        return

    # Transfer ownership if the owner left (lobby only)
    if room.owner == sid and room.players:
        new_owner_info = next(iter(room.players.values()))
        new_owner_sid = new_owner_info["socketId"]
        new_owner_pid = None
        for pid, info in room.players.items():
            if info["socketId"] == new_owner_sid:
                new_owner_pid = pid
                break
        room.owner = new_owner_sid
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

    await sio.emit("users-updated", _players_payload(room), room=session_id)


# ── Startup ───────────────────────────────────────────────────────────────────

@sio.event
async def connect(sid: str, environ: dict) -> None:
    from src.ratelimit import register_sid, connection_allowed, check_ip
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    ip = forwarded.split(",")[0].strip() if forwarded else environ.get("REMOTE_ADDR", "unknown")
    if not connection_allowed(ip):
        raise socketio.exceptions.ConnectionRefusedError("Too many connections")
    if not check_ip(ip, "connect"):
        raise socketio.exceptions.ConnectionRefusedError("Rate limited")
    register_sid(sid, ip)
    log.info("SIO connect %s (ip=%s)", sid, ip)


async def _cleanup_empty_rooms() -> None:
    while True:
        await asyncio.sleep(60)
        empty = [sid for sid, r in list(rooms.items()) if not r.players and not r.spectators]
        for sid in empty:
            del rooms[sid]
            log.debug("Cleanup: deleted empty room %s", sid)
        from src.ratelimit import cleanup
        cleanup()


# ── Events ────────────────────────────────────────────────────────────────────

@sio.on("open-room")
async def open_room(sid: str, data: dict) -> str | None:
    from src.ratelimit import check
    if not check(sid, "open-room"):
        return "Rate limited"

    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    player_id: str = extra.get("playerId", sid)
    player_name: str = extra.get("player_name", "Player")
    room_name: str = extra.get("room_name", "Room")
    game_id: str = extra.get("game_id", "")
    password: str | None = data.get("password") or extra.get("room_password") or None
    max_players: int = int(data.get("maxPlayers", 4))

    if not session_id:
        return "Missing sessionid"
    if not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
        return "Invalid room code"
    if session_id in rooms:
        return "Room already exists"

    player_name = _sanitize_str(player_name, 32)
    room_name = _sanitize_str(room_name, 64)
    if not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32:
        game_id = "unknown"
    max_players = max(1, min(4, max_players))

    room = Room(
        owner=sid,
        room_name=room_name,
        game_id=game_id,
        password=password,
        max_players=max_players,
    )
    room.players[player_id] = {"socketId": sid, "playerName": player_name}
    room.slots[0] = player_id
    rooms[session_id] = room
    _sid_to_room[sid] = (session_id, player_id, False)

    await sio.enter_room(sid, session_id)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    log.info("SIO %s opened room %s (game=%s)", sid, session_id, game_id)
    return None  # success


@sio.on("join-room")
async def join_room(sid: str, data: dict) -> tuple[str | None, dict | None]:
    from src.ratelimit import check
    if not check(sid, "join-room"):
        return ("Rate limited", None)

    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    player_id: str = extra.get("userid", sid)
    player_name: str = extra.get("player_name", "Player")
    password: str | None = data.get("password") or None
    spectate: bool = extra.get("spectate", False)

    player_name = _sanitize_str(player_name, 32)

    room = rooms.get(session_id)
    if room is None:
        return ("Room not found", None)
    if room.password and not hmac.compare_digest(room.password, password or ""):
        return ("Wrong password", None)

    if spectate:
        room.spectators[player_id] = {"socketId": sid, "playerName": player_name}
        _sid_to_room[sid] = (session_id, player_id, True)
    else:
        slot = room.next_slot()
        if slot is None:
            return ("Room is full", None)
        room.players[player_id] = {"socketId": sid, "playerName": player_name}
        room.slots[slot] = player_id
        _sid_to_room[sid] = (session_id, player_id, False)

    await sio.enter_room(sid, session_id)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    log.info("SIO %s %s room %s (playerId=%s)", sid, "spectating" if spectate else "joined", session_id, player_id)
    return (None, _players_payload(room))


@sio.on("leave-room")
async def leave_room(sid: str, data: dict | None = None) -> None:
    await _leave(sid)


@sio.on("claim-slot")
async def claim_slot(sid: str, data: dict) -> str | None:
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

    requested_slot = data.get("slot")
    if requested_slot is not None:
        if not isinstance(requested_slot, int) or requested_slot < 0 or requested_slot > 3:
            return "Invalid slot"
        if requested_slot in room.slots:
            return "Slot already taken"
        slot = requested_slot
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
    log.info("SIO %s claimed slot %d in room %s", sid, slot, session_id)
    return None


@sio.on("start-game")
async def start_game(sid: str, data: dict) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id = entry[0]
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.owner != sid:
        return "Only the host can start the game"

    room.status = "playing"
    mode = data.get("mode", "lockstep")
    if mode not in _VALID_MODES:
        mode = "lockstep"
    room.mode = mode
    rom_hash = data.get("romHash")
    if rom_hash and isinstance(rom_hash, str) and len(rom_hash) == 64:
        room.rom_hash = rom_hash
    await sio.emit("game-started", {
        "mode": room.mode,
        "rollbackEnabled": data.get("rollbackEnabled", False),
        "romHash": room.rom_hash,
    }, room=session_id)
    log.info("Game started in room %s (mode=%s)", session_id, room.mode)
    return None


@sio.on("end-game")
async def end_game(sid: str, data: dict) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id = entry[0]
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.owner != sid:
        return "Only the host can end the game"

    room.status = "lobby"
    # mode persists for rematch convenience
    await sio.emit("game-ended", {}, room=session_id)
    log.info("Game ended in room %s", session_id)
    return None


@sio.on("webrtc-signal")
async def webrtc_signal(sid: str, data: dict) -> None:
    target: str | None = data.get("target")
    if not target:
        return
    sender_entry = _sid_to_room.get(sid)
    target_entry = _sid_to_room.get(target)
    if not sender_entry or not target_entry:
        return
    if sender_entry[0] != target_entry[0]:
        return
    await sio.emit("webrtc-signal", {"sender": sid, **data}, to=target)


@sio.on("data-message")
async def data_message(sid: str, data: dict) -> None:
    from src.ratelimit import check
    if not check(sid, "data-message"):
        return
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    if sys.getsizeof(str(data)) > _MAX_RELAY_SIZE:
        return
    session_id = entry[0]
    await sio.emit("data-message", data, room=session_id, skip_sid=sid)


@sio.on("snapshot")
async def snapshot(sid: str, data: dict) -> None:
    from src.ratelimit import check
    if not check(sid, "snapshot"):
        return
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    if sys.getsizeof(str(data)) > _MAX_RELAY_SIZE:
        return
    session_id = entry[0]
    await sio.emit("snapshot", data, room=session_id, skip_sid=sid)


@sio.on("input")
async def game_input(sid: str, data: dict) -> None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    session_id = entry[0]
    await sio.emit("input", data, room=session_id, skip_sid=sid)


@sio.event
async def disconnect(sid: str) -> None:
    from src.ratelimit import unregister_sid
    log.info("SIO disconnect %s", sid)
    unregister_sid(sid)
    await _leave(sid)
