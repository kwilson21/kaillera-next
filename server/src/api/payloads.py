"""Pydantic v2 payload models for Socket.IO event validation.

Each model corresponds to one Socket.IO event handler in signaling.py.
The `validated` decorator wraps handlers to parse incoming dicts through
the model before the handler runs.
"""

from __future__ import annotations

from functools import wraps
from typing import Any

from pydantic import BaseModel, Field, ValidationError

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
    player_name: str = Field(default="Player", max_length=32)
    room_name: str = Field(default="Room", max_length=64)
    game_id: str = Field(default="", max_length=32)
    room_password: str | None = None


class OpenRoomPayload(BaseModel):
    extra: OpenRoomExtra = Field(default_factory=OpenRoomExtra)
    password: str | None = None
    maxPlayers: int = Field(default=4, ge=1, le=4)


# ── join-room ────────────────────────────────────────────────────────────────


class JoinRoomExtra(BaseModel):
    sessionid: str = ""
    persistentId: str = ""
    player_name: str = Field(default="Player", max_length=32)
    spectate: bool = False


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


class StartGamePayload(BaseModel):
    mode: str = "lockstep"
    rollbackEnabled: bool = False
    romHash: str | None = None


# ── end-game ─────────────────────────────────────────────────────────────────


class EndGamePayload(BaseModel):
    pass


# ── set-mode ─────────────────────────────────────────────────────────────────


class SetModePayload(BaseModel):
    mode: str = "lockstep"


# ── rom-sharing-toggle ───────────────────────────────────────────────────────


class RomSharingTogglePayload(BaseModel):
    enabled: bool = False


# ── rom-ready ────────────────────────────────────────────────────────────────


class RomReadyPayload(BaseModel):
    ready: bool = True


# ── rom-declare ──────────────────────────────────────────────────────────────


class RomDeclarePayload(BaseModel):
    declared: bool = True


# ── input-type ───────────────────────────────────────────────────────────────


class InputTypePayload(BaseModel):
    type: str = "keyboard"


# ── device-type ──────────────────────────────────────────────────────────────


class DeviceTypePayload(BaseModel):
    type: str = "desktop"
