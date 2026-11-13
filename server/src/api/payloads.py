"""Pydantic v2 payload models for Socket.IO event validation.

Each client-to-server model corresponds to one Socket.IO event handler in
signaling.py. The `validated` decorator wraps handlers to parse incoming
dicts through the model before the handler runs.

The server-to-client models at the bottom describe the dicts signaling.py
sends; tests/test_protocol_payloads.py holds the real payloads to them.

Every model here is also the source of the client's Effect Schemas:
scripts/gen_protocol.py writes web/src/protocol.gen.ts from this module
(`npm run protocol`), and CI fails when that file is stale. After changing a
model, regenerate and commit it.
"""

from __future__ import annotations

import logging
import sys
from functools import wraps
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

log = logging.getLogger(__name__)

# ── Mode coercion (back-compat) ──────────────────────────────────────────────
# Pre-rename clients send mode="lockstep". The product-facing engine is now
# "rollback" (same engine, renamed). Coerce BEFORE Literal validation so old
# clients keep working until cached tabs churn out. Removable in a follow-up
# deploy.


class _ModeCompatMixin:
    # The generated client schema does not accept "lockstep": it describes what
    # a current page sends. scripts/gen_protocol.py lists this validator as
    # known; any other validator stops generation until it is handled there.
    @field_validator("mode", mode="before")
    @classmethod
    def _coerce_legacy_mode(cls, v: Any) -> Any:
        if v == "lockstep":
            return "rollback"
        return v


# ── Decorator ────────────────────────────────────────────────────────────────


def validated(model_cls: type[BaseModel], *, error_response: Any = "Invalid data"):
    """Decorator that validates Socket.IO event data with a Pydantic model.

    Args:
        model_cls: The Pydantic model class to validate against.
        error_response: Value returned to the client when validation fails.
            Use a string for handlers that return ``str | None``, or a tuple
            like ``("Invalid data", None)`` for handlers that return a tuple.
    """

    def decorator(fn):
        @wraps(fn)
        async def wrapper(sid: str, data: Any = None):
            try:
                payload = model_cls.model_validate(data if isinstance(data, dict) else {})
            except ValidationError:
                return error_response
            return await fn(sid, payload)

        return wrapper

    return decorator


# ── open-room ────────────────────────────────────────────────────────────────


class OpenRoomExtra(BaseModel):
    sessionid: str = ""
    persistentId: str = ""
    reconnectToken: str = ""
    player_name: str = Field(default="Player", max_length=32)
    room_name: str = Field(default="Room", max_length=64)
    game_id: str = Field(default="", max_length=32)
    room_password: str | None = None
    # True when the page sending this has no game running: a first load or a
    # reload. A page whose socket merely reconnected under a running game
    # leaves it False (as do clients from before the field existed).
    fresh: bool = False
    # A page that still has a game running, taking its place in the room back
    # after a socket drop; `slot` and `matchId` say what it is playing. The
    # rule is the one on JoinRoomExtra. A dropped host that is taken back
    # comes back as a player: the room was handed on when it was dropped.
    resume: bool = False
    slot: int | None = Field(default=None, ge=0, le=3)
    matchId: str = Field(default="", max_length=64)


class OpenRoomPayload(BaseModel):
    extra: OpenRoomExtra = Field(default_factory=OpenRoomExtra)
    password: str | None = None
    maxPlayers: int = Field(default=4, ge=1, le=4)


# ── join-room ────────────────────────────────────────────────────────────────


class JoinRoomExtra(BaseModel):
    sessionid: str = ""
    persistentId: str = ""
    reconnectToken: str = ""
    player_name: str = Field(default="Player", max_length=32)
    spectate: bool = False
    # `resume` is true when the page still has a game running and is taking
    # its place in the room back after a socket drop; `slot` and `matchId`
    # are the slot it plays and the match it is in. A member is taken back as
    # always. A player the room dropped meanwhile (the grace window ran out)
    # may still be playing, since the players' connections are their own: it
    # is taken back into that slot if the room is still playing that match
    # and the slot is free, and refused with NOT_IN_ROOM otherwise, so the
    # page ends its game instead of carrying on with no signaling
    # (specs/room_lifecycle.qnt, nobodyIsStrandedInADroppedMatch).
    resume: bool = False
    slot: int | None = Field(default=None, ge=0, le=3)
    matchId: str = Field(default="", max_length=64)


class JoinRoomPayload(BaseModel):
    extra: JoinRoomExtra = Field(default_factory=JoinRoomExtra)
    password: str | None = None


# ── claim-slot ───────────────────────────────────────────────────────────────


class ClaimSlotPayload(BaseModel):
    slot: int | None = Field(default=None, ge=0, le=3)


# ── set-name ─────────────────────────────────────────────────────────────────


class SetNamePayload(BaseModel):
    name: str = Field(default="", max_length=24)


# ── start-game ───────────────────────────────────────────────────────────────


class StartGamePayload(_ModeCompatMixin, BaseModel):
    mode: Literal["rollback", "streaming"] = "rollback"
    resyncEnabled: bool = True
    romHash: str | None = None
    gameId: str | None = Field(default=None, max_length=32)


# ── match-joined ─────────────────────────────────────────────────────────────


class MatchJoinedPayload(BaseModel):
    """A player who joined a match in play says it is now in it.

    Until then the server counts it as waiting, and ends a match in which
    every player left is waiting (signaling.match_is_abandoned).
    """

    matchId: str = Field(max_length=64)


# ── end-game ─────────────────────────────────────────────────────────────────


class EndGamePayload(BaseModel):
    pass


# ── set-mode ─────────────────────────────────────────────────────────────────


class SetModePayload(_ModeCompatMixin, BaseModel):
    mode: Literal["rollback", "streaming"] = "rollback"


class SetGameIdPayload(BaseModel):
    game_id: str = Field(default="ssb64", max_length=32)


# ── rom-sharing-toggle ───────────────────────────────────────────────────────


class RomSharingTogglePayload(BaseModel):
    enabled: bool = False


# ── set-listed ───────────────────────────────────────────────────────────────


class SetListedPayload(BaseModel):
    listed: bool = False


# ── rom-ready ────────────────────────────────────────────────────────────────


class RomReadyPayload(BaseModel):
    ready: bool = True
    hash: str | None = None
    name: str | None = Field(default=None, max_length=128)
    size: int | None = Field(default=None, ge=0, le=512 * 1024 * 1024)


# ── input-type ───────────────────────────────────────────────────────────────


class InputTypePayload(BaseModel):
    type: str = "keyboard"


# ── device-type ──────────────────────────────────────────────────────────────


class DeviceTypePayload(BaseModel):
    type: str = "desktop"


# ── session-log ─────────────────────────────────────────────────────────────


class SessionLogPayload(BaseModel):
    matchId: str = ""
    entries: list = Field(default_factory=list)
    # Identifies the client's in-memory sync-log ring instance (regenerated
    # whenever the ring is created or cleared — see db.append_session_log).
    # Lets the server tell a genuine reload/reconnect/slot-reuse (which
    # restarts the client's seq counter at 0) apart from a resend, so the
    # new ring's entries aren't deduped away against a stale last_seq.
    epoch: str = Field(default="", max_length=64)
    summary: dict = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)
    # The whole input audit, as clients sent it before audit deltas: still
    # stored in context for cached older pages.
    inputAudit: dict = Field(default_factory=dict)
    # {epoch, entries}: the input audit records the server hasn't acked
    # (see db.append_session_flush).
    audit: dict = Field(default_factory=dict)


# ── feedback ────────────────────────────────────────────────────────────────


class FeedbackPayload(BaseModel):
    category: Literal["bug", "feature", "general"]
    message: str = Field(min_length=1, max_length=2000)
    email: str | None = Field(default=None, max_length=254)
    company_fax: str | None = None  # honeypot — non-empty = bot
    page: str | None = Field(default=None, max_length=20)
    context: dict | None = None


# ── server → client ──────────────────────────────────────────────────────────
# What signaling.py sends, duplicate snake_case keys included (older cached
# pages read them). signaling.py builds each payload as a dict and passes it
# through `checked` on its way out (`_emit`, and the two structured acks), so
# every send is held to its model where it happens. `extra="forbid"` and
# `strict` make a key the model does not name, or a value of another type, a
# contract failure: a new field has to be added here (and so to the generated
# client schema) before it ships.

RoomStatus = Literal["lobby", "playing"]
GameMode = Literal["rollback", "streaming"]


class _ServerMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RoomPlayer(_ServerMessage):
    socketId: str
    playerName: str
    # None while the player holds no slot.
    slot: int | None
    romReady: bool
    inputType: str
    deviceType: str


class RoomSpectator(_ServerMessage):
    socketId: str
    playerName: str


class HostRom(_ServerMessage):
    hash: str | None
    name: str | None
    size: int | None
    gameId: str
    game_id: str


class UsersUpdated(_ServerMessage):
    """`users-updated`: the room as every member should see it."""

    # Keyed by persistent player id.
    players: dict[str, RoomPlayer]
    spectators: dict[str, RoomSpectator]
    # Socket id of the host.
    owner: str
    romSharing: bool
    romHash: str | None
    romName: str | None
    rom_name: str | None
    romSize: int | None
    rom_size: int | None
    hostRom: HostRom
    gameId: str
    game_id: str
    # None until the host picks a mode or starts a game.
    mode: GameMode | None
    status: RoomStatus
    listed: bool


class JoinRoomAck(UsersUpdated):
    """The second value of the `join-room` ack (the first is an error or null)."""

    rom_hash: str | None
    rom_sharing: bool
    # The running match, or None in the lobby.
    matchId: str | None


class GameStarted(_ServerMessage):
    """`game-started`."""

    mode: GameMode
    resyncEnabled: bool
    romHash: str | None
    romName: str | None
    rom_name: str | None
    romSize: int | None
    rom_size: int | None
    hostRom: HostRom
    gameId: str
    matchId: str


class GameEnded(_ServerMessage):
    """`game-ended`."""

    # None when the room had no match to end.
    matchId: str | None


class RomSharingUpdated(_ServerMessage):
    """`rom-sharing-updated`."""

    romSharing: bool


class RenegotiateRequest(_ServerMessage):
    """`webrtc-signal` as the server itself sends it, to a room's new owner.

    Every other `webrtc-signal` is a relay of what a peer sent.
    """

    requestRenegotiate: Literal[True]


class SessionLogAck(_ServerMessage):
    """The `session-log` ack: the last log and audit seq the server has stored.

    A flush the server turns away is acked with no data at all.
    """

    lastSeq: int
    auditLastSeq: int


class TokenMessage(_ServerMessage):
    """`upload-token` and `reconnect-token`."""

    token: str


class RelaySender(_ServerMessage):
    """Who sent a relayed `data-message`, `snapshot` or `input`, as the server knows it.

    The server puts it on every message it relays, under `knFrom`
    (`RELAY_SENDER_KEY`), replacing anything the sender put there. The rest
    of a relayed message is the sender's own words.
    """

    sid: str
    # None for a spectator, and for a player holding no slot.
    slot: int | None
    owner: bool


RELAY_SENDER_KEY = "knFrom"


# Each event the server sends with a payload of its own making, and its model.
# `webrtc-signal` is also a relay of what peers send each other, so only the
# server's own use of it is described here (see RELAYED_EVENTS).
SERVER_EVENTS: dict[str, type[BaseModel]] = {
    "users-updated": UsersUpdated,
    "game-started": GameStarted,
    "game-ended": GameEnded,
    "rom-sharing-updated": RomSharingUpdated,
    "upload-token": TokenMessage,
    "reconnect-token": TokenMessage,
    "webrtc-signal": RenegotiateRequest,
}

# Events that (also) carry what another client sent, forwarded as received.
# The client cannot decode these as server messages by event name alone.
RELAYED_EVENTS = frozenset({"webrtc-signal", "rom-signal", "data-message", "snapshot", "input"})


class PayloadContractError(Exception):
    """A payload the server built does not match its model."""


# Under pytest a mismatch raises, so every server test that drives a handler
# also checks the contract. In production it is logged and the payload still
# goes out: a broken contract must not take a room down.
RAISE_ON_CONTRACT_FAILURE = "pytest" in sys.modules


def checked(model_cls: type[BaseModel], data: dict, what: str) -> dict:
    """Hold a payload the server built to its model, then return it unchanged.

    Logs `PAYLOAD-CONTRACT` on a mismatch (or raises, under tests).
    """
    try:
        model_cls.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()[:5])
        if RAISE_ON_CONTRACT_FAILURE:
            raise PayloadContractError(f"{what} does not match {model_cls.__name__}: {problems}") from exc
        log.error("PAYLOAD-CONTRACT %s does not match %s: %s", what, model_cls.__name__, problems)
    return data
