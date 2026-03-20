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
import logging
from dataclasses import dataclass, field

import socketio

log = logging.getLogger(__name__)

# ── Socket.IO server instance ─────────────────────────────────────────────────

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    max_http_buffer_size=16 * 1024 * 1024,  # 16MB — save states are ~3-5MB gzipped+b64
)


# ── Room state ────────────────────────────────────────────────────────────────

@dataclass
class Room:
    owner: str                        # sid of creator
    room_name: str
    game_id: str
    domain: str
    password: str | None
    max_players: int
    players: dict[str, dict] = field(default_factory=dict)
    # players: playerId -> {"socketId": sid, "playerName": ..., ...}
    slots: dict[int, str] = field(default_factory=dict)
    # slots: slot_index (0-3) -> playerId
    spectators: dict[str, dict] = field(default_factory=dict)
    # spectators: playerId -> {"socketId": sid, "playerName": ...}
    status: str = "lobby"       # "lobby" or "playing"
    mode: str | None = None     # "lockstep-v4" or "streaming", set on start-game

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

    # Transfer ownership if the owner left
    if room.owner == sid and room.players:
        new_owner_info = next(iter(room.players.values()))
        new_owner_sid = new_owner_info["socketId"]
        room.owner = new_owner_sid
        log.info("Room %s ownership transferred to %s", session_id, new_owner_sid)
        await sio.emit("webrtc-signal", {"requestRenegotiate": True}, to=new_owner_sid)

    await sio.emit("users-updated", _players_payload(room), room=session_id)


# ── Startup ───────────────────────────────────────────────────────────────────

@sio.event
async def connect(sid: str, environ: dict) -> None:
    log.info("SIO connect %s", sid)


@sio.on("startup")  # internal — called once at server start via create_task
async def _noop(*_) -> None:
    pass


async def _cleanup_empty_rooms() -> None:
    while True:
        await asyncio.sleep(60)
        empty = [sid for sid, r in list(rooms.items()) if not r.players and not r.spectators]
        for sid in empty:
            del rooms[sid]
            log.debug("Cleanup: deleted empty room %s", sid)


# ── Events ────────────────────────────────────────────────────────────────────

@sio.on("open-room")
async def open_room(sid: str, data: dict) -> str | None:
    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    player_id: str = extra.get("playerId", sid)
    player_name: str = extra.get("player_name", "Player")
    room_name: str = extra.get("room_name", "Room")
    game_id: str = extra.get("game_id", "")
    domain: str = extra.get("domain", "")
    password: str | None = data.get("password") or extra.get("room_password") or None
    max_players: int = int(data.get("maxPlayers", 4))

    if not session_id:
        return "Missing sessionid"
    if session_id in rooms:
        return "Room already exists"

    room = Room(
        owner=sid,
        room_name=room_name,
        game_id=game_id,
        domain=domain,
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
    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    player_id: str = extra.get("userid", sid)
    player_name: str = extra.get("player_name", "Player")
    password: str | None = data.get("password") or None
    spectate: bool = extra.get("spectate", False)

    room = rooms.get(session_id)
    if room is None:
        return ("Room not found", None)
    if room.password and room.password != password:
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
    room.mode = data.get("mode", "lockstep-v4")
    await sio.emit("game-started", {
        "mode": room.mode,
        "rollbackEnabled": data.get("rollbackEnabled", False),
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
    await sio.emit("webrtc-signal", {"sender": sid, **data}, to=target)


@sio.on("data-message")
async def data_message(sid: str, data: dict) -> None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return
    session_id = entry[0]
    await sio.emit("data-message", data, room=session_id, skip_sid=sid)


@sio.on("snapshot")
async def snapshot(sid: str, data: dict) -> None:
    entry = _sid_to_room.get(sid)
    if entry is None:
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
    log.info("SIO disconnect %s", sid)
    await _leave(sid)
