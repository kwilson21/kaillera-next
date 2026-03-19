"""
Shared session state for the kaillera-next server.

SessionManager is the single source of truth for all active game sessions.
It is created once at startup and passed to the TCP handler, UDP handler,
and FastAPI app.

Lifecycle:
  1. API calls create_session() → session_id
  2. API calls add_player(session_id, slot) → pre-assigned reg_id
  3. Launcher passes reg_id to Mupen64Plus at startup
  4. Mupen64Plus TCP-connects → sends REGISTER with that reg_id
  5. TCP handler calls register_player(reg_id, plugin, rawdata)
  6. UDP packets route to the right session via lookup_session(reg_id)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from src.netplay.protocol import (
    DEFAULT_BUFFER_TARGET,
    EmulatorSettings,
    PlayerSlot,
    RegisterResponse,
    RegistrationsResponse,
)


# ── Player record ─────────────────────────────────────────────────────────────

@dataclass
class PlayerRecord:
    reg_id:     int
    slot:       int        # 0–3
    plugin:     int = 0
    rawdata:    int = 0
    registered: bool = False   # True once TCP REGISTER received


# ── Session ───────────────────────────────────────────────────────────────────

@dataclass
class Session:
    session_id: str
    slots: list[PlayerRecord | None] = field(default_factory=lambda: [None] * 4)
    settings: EmulatorSettings | None = None
    save_data: bytes | None = None

    @property
    def player_count(self) -> int:
        return sum(1 for s in self.slots if s is not None)

    def get_player(self, reg_id: int) -> PlayerRecord | None:
        for slot in self.slots:
            if slot is not None and slot.reg_id == reg_id:
                return slot
        return None

    def to_registrations_response(self) -> RegistrationsResponse:
        """Build the 24-byte GET_REGISTRATIONS reply (4 × 6-byte PlayerSlot)."""
        return RegistrationsResponse([
            PlayerSlot(p.reg_id, p.plugin, p.rawdata) if p is not None else PlayerSlot(0, 0, 0)
            for p in self.slots
        ])


# ── SessionManager ────────────────────────────────────────────────────────────

class SessionManager:
    """
    Synchronous shared state. Safe to call from asyncio coroutines because
    all access happens on a single event loop thread — no explicit locks needed.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._reg_index: dict[int, str] = {}   # reg_id → session_id
        self._next_reg_id: int = 1             # 0 is the null sentinel

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def create_session(self) -> str:
        """Create a new empty session and return its session_id."""
        session_id = uuid.uuid4().hex
        self._sessions[session_id] = Session(session_id=session_id)
        return session_id

    def get_session(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def remove_session(self, session_id: str) -> None:
        """Remove a session and clean up all its reg_id entries."""
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        for record in session.slots:
            if record is not None:
                self._reg_index.pop(record.reg_id, None)

    # ── Player slot management ────────────────────────────────────────────────

    def add_player(self, session_id: str, slot: int) -> int:
        """
        Pre-assign a reg_id for the given slot in the session.
        Returns the assigned reg_id.

        Raises KeyError if session_id is unknown.
        Raises ValueError if the slot is already occupied.
        """
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"session not found: {session_id!r}")
        if not (0 <= slot <= 3):
            raise ValueError(f"slot must be 0–3, got {slot}")
        if session.slots[slot] is not None:
            raise ValueError(f"slot {slot} already occupied")

        reg_id = self._next_reg_id
        self._next_reg_id += 1

        record = PlayerRecord(reg_id=reg_id, slot=slot)
        session.slots[slot] = record
        self._reg_index[reg_id] = session_id
        return reg_id

    def register_player(self, reg_id: int, plugin: int, rawdata: int) -> RegisterResponse:
        """
        Called by the TCP handler when Mupen64Plus sends REGISTER (0x05).
        Validates the reg_id, fills in plugin/rawdata, and returns the response.

        Raises ValueError if reg_id is unknown.
        """
        session = self.lookup_session(reg_id)
        if session is None:
            raise ValueError(f"unknown reg_id: {reg_id}")

        record = session.get_player(reg_id)
        assert record is not None  # invariant: reg_index and slots are in sync

        record.plugin = plugin
        record.rawdata = rawdata
        record.registered = True

        return RegisterResponse(assigned_slot=record.slot, buffer_target=DEFAULT_BUFFER_TARGET)

    def disconnect(self, reg_id: int) -> None:
        """
        Called by the TCP handler on DISCONNECT (0x07) or connection drop.
        Clears the player's slot and removes from the reg_index.
        Does not remove the session itself.
        """
        session = self.lookup_session(reg_id)
        if session is None:
            return
        record = session.get_player(reg_id)
        if record is not None:
            session.slots[record.slot] = None
        self._reg_index.pop(reg_id, None)

    # ── Settings ──────────────────────────────────────────────────────────────

    def set_settings(self, reg_id: int, settings: EmulatorSettings) -> None:
        """Store emulator settings for the session that owns reg_id."""
        session = self.lookup_session(reg_id)
        if session is not None:
            session.settings = settings

    def get_settings(self, reg_id: int) -> EmulatorSettings | None:
        """Return the session's emulator settings, or None if not yet set."""
        session = self.lookup_session(reg_id)
        return session.settings if session is not None else None

    # ── Save file ─────────────────────────────────────────────────────────────

    def store_save(self, reg_id: int, data: bytes) -> None:
        """Store the save file for the session that owns reg_id."""
        session = self.lookup_session(reg_id)
        if session is not None:
            session.save_data = data

    def get_save(self, reg_id: int) -> bytes | None:
        """Return the session's save file, or None if not yet received."""
        session = self.lookup_session(reg_id)
        return session.save_data if session is not None else None

    # ── Routing ───────────────────────────────────────────────────────────────

    def lookup_session(self, reg_id: int) -> Session | None:
        """
        Hot path for UDP routing. O(1) dict lookup.
        Returns None if reg_id is unknown or the session has been removed.
        """
        session_id = self._reg_index.get(reg_id)
        if session_id is None:
            return None
        return self._sessions.get(session_id)
