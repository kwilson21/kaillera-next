"""
Mupen64Plus native netplay packet definitions.

All multi-byte integers are big-endian (network byte order).
TCP and UDP share the same port (45000).

Note: This module covers the Mupen64Plus netplay protocol only.
Kaillera protocol compat will live in a separate module (v2).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import IntEnum


# ── Constants ─────────────────────────────────────────────────────────────────

CP0_REGS_COUNT = 32
DEFAULT_BUFFER_TARGET = 2


# ── Packet type enums ─────────────────────────────────────────────────────────

class TCPPacketType(IntEnum):
    SEND_SAVE         = 0x01  # P1 → server, variable length
    REQUEST_SAVE      = 0x02  # client → server, variable length
    SEND_SETTINGS     = 0x03  # P1 → server, 24 bytes
    REQUEST_SETTINGS  = 0x04  # client → server, 0 bytes (server replies 24)
    REGISTER          = 0x05  # client → server, 7 bytes
    GET_REGISTRATIONS = 0x06  # client → server, 0 bytes (server replies 24)
    DISCONNECT        = 0x07  # client → server, 4 bytes


class UDPPacketType(IntEnum):
    SEND_KEY    = 0x00  # client → server, 11 bytes
    RECV_KEY    = 0x01  # server → client, 5 + N×9 bytes
    REQUEST_KEY = 0x02  # client → server, 12 bytes
    PUSH_KEY    = 0x03  # server → client, 5 + N×9 bytes (gratuitous push)
    SYNC_DATA   = 0x04  # client → server, (CP0_REGS_COUNT×4) + 5 bytes


# ── Pre-compiled struct formats ───────────────────────────────────────────────
# All big-endian (">").  B=uint8  I=uint32

# TCP
_S_REGISTER_BODY   = struct.Struct(">BBBI")  # player, plugin, rawdata, reg_id
_S_REGISTER_RESP   = struct.Struct(">BB")    # assigned_slot, buffer_target
_S_SETTINGS        = struct.Struct(">6I")    # 6 × uint32 = 24 bytes
_S_PLAYER_SLOT     = struct.Struct(">IBB")   # reg_id, plugin, rawdata
_S_DISCONNECT_BODY = struct.Struct(">I")     # reg_id
_S_SAVE_LEN        = struct.Struct(">I")     # length prefix for save file

# UDP
_S_SEND_KEY    = struct.Struct(">BBIIB")    # type, control_id, netplay_count, keys, plugin
_S_REQUEST_KEY = struct.Struct(">BBIIBB")   # type, control_id, reg_id, netplay_count, spectator, buffer_size
_S_RECV_KEY_HDR = struct.Struct(">BBBBB")   # type, player, status, player_lag, event_count
_S_KEY_EVENT    = struct.Struct(">IIB")     # count, keys, plugin
_S_SYNC_HDR     = struct.Struct(">BI")      # type, vi_counter
_S_CP0_REGS     = struct.Struct(f">{CP0_REGS_COUNT}I")

# Size asserts — catch format string bugs at import time
assert _S_REGISTER_BODY.size == 7
assert _S_SETTINGS.size == 24
assert _S_PLAYER_SLOT.size == 6
assert _S_SEND_KEY.size == 11
assert _S_REQUEST_KEY.size == 12
assert _S_RECV_KEY_HDR.size == 5
assert _S_KEY_EVENT.size == 9
assert _S_SYNC_HDR.size == 5
assert _S_CP0_REGS.size == CP0_REGS_COUNT * 4


# ── Status bit constants (RECV_KEY / PUSH_KEY status byte) ───────────────────

STATUS_DESYNC  = 0x01  # bit 0: desync detected
STATUS_P1_DISC = 0x02  # bit 1: player 1 disconnected
STATUS_P2_DISC = 0x04  # bit 2: player 2 disconnected
STATUS_P3_DISC = 0x08  # bit 3: player 3 disconnected
STATUS_P4_DISC = 0x10  # bit 4: player 4 disconnected


# ── TCP dataclasses ───────────────────────────────────────────────────────────

@dataclass
class EmulatorSettings:
    """24-byte emulator settings block. Used for SEND_SETTINGS and GET_SETTINGS reply."""
    count_per_op:           int
    count_per_op_denom_pot: int
    disable_extra_mem:      int
    si_dma_duration:        int
    emumode:                int
    no_compiled_jump:       int

    def pack(self) -> bytes:
        return _S_SETTINGS.pack(
            self.count_per_op,
            self.count_per_op_denom_pot,
            self.disable_extra_mem,
            self.si_dma_duration,
            self.emumode,
            self.no_compiled_jump,
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> EmulatorSettings:
        return cls(*_S_SETTINGS.unpack(data[: _S_SETTINGS.size]))


@dataclass
class RegisterBody:
    """Body of a REGISTER (0x05) packet — 7 bytes after the type byte."""
    player:  int  # u8
    plugin:  int  # u8
    rawdata: int  # u8
    reg_id:  int  # u32be — assigned by matchmaking layer; 0 is null sentinel

    def pack(self) -> bytes:
        return _S_REGISTER_BODY.pack(self.player, self.plugin, self.rawdata, self.reg_id)

    @classmethod
    def from_bytes(cls, data: bytes) -> RegisterBody:
        return cls(*_S_REGISTER_BODY.unpack(data[: _S_REGISTER_BODY.size]))


@dataclass
class RegisterResponse:
    """Server → client reply to REGISTER."""
    assigned_slot: int
    buffer_target: int = DEFAULT_BUFFER_TARGET

    def pack(self) -> bytes:
        return _S_REGISTER_RESP.pack(self.assigned_slot, self.buffer_target)

    @classmethod
    def from_bytes(cls, data: bytes) -> RegisterResponse:
        return cls(*_S_REGISTER_RESP.unpack(data[: _S_REGISTER_RESP.size]))


@dataclass
class PlayerSlot:
    """A single 6-byte player registration slot in a GET_REGISTRATIONS response."""
    reg_id:  int  # u32be — 0 means empty slot
    plugin:  int  # u8
    rawdata: int  # u8

    def pack(self) -> bytes:
        return _S_PLAYER_SLOT.pack(self.reg_id, self.plugin, self.rawdata)

    @classmethod
    def from_bytes(cls, data: bytes) -> PlayerSlot:
        return cls(*_S_PLAYER_SLOT.unpack(data[: _S_PLAYER_SLOT.size]))


@dataclass
class RegistrationsResponse:
    """Server → client reply to GET_REGISTRATIONS (0x06) — 24 bytes = 4 × PlayerSlot."""
    slots: list[PlayerSlot]  # always exactly 4 elements

    def pack(self) -> bytes:
        assert len(self.slots) == 4
        return b"".join(s.pack() for s in self.slots)

    @classmethod
    def from_bytes(cls, data: bytes) -> RegistrationsResponse:
        n = _S_PLAYER_SLOT.size  # 6
        return cls([PlayerSlot.from_bytes(data[i * n : (i + 1) * n]) for i in range(4)])

    @classmethod
    def empty(cls) -> RegistrationsResponse:
        """Return a response with all slots empty (reg_id=0)."""
        return cls([PlayerSlot(0, 0, 0) for _ in range(4)])


@dataclass
class DisconnectBody:
    """Body of a DISCONNECT (0x07) packet — 4 bytes."""
    reg_id: int  # u32be

    def pack(self) -> bytes:
        return _S_DISCONNECT_BODY.pack(self.reg_id)

    @classmethod
    def from_bytes(cls, data: bytes) -> DisconnectBody:
        (reg_id,) = _S_DISCONNECT_BODY.unpack(data[: _S_DISCONNECT_BODY.size])
        return cls(reg_id)


@dataclass
class SaveFilePacket:
    """
    Used for both SEND_SAVE (0x01) and REQUEST_SAVE (0x02).

    Wire format after type byte: [length:u32be][data:bytes]

    The TCP handler reads `length` bytes, then passes the full payload
    (length prefix + data) to from_bytes().
    """
    data: bytes

    def pack(self) -> bytes:
        return _S_SAVE_LEN.pack(len(self.data)) + self.data

    @classmethod
    def from_bytes(cls, data: bytes) -> SaveFilePacket:
        (length,) = _S_SAVE_LEN.unpack(data[: _S_SAVE_LEN.size])
        return cls(data[_S_SAVE_LEN.size : _S_SAVE_LEN.size + length])


# ── UDP dataclasses ───────────────────────────────────────────────────────────

@dataclass
class SendKeyPacket:
    """SEND_KEY (0x00) — client → server, 11 bytes."""
    type:          int = UDPPacketType.SEND_KEY
    control_id:    int = 0
    netplay_count: int = 0
    keys:          int = 0
    plugin:        int = 0

    def pack(self) -> bytes:
        return _S_SEND_KEY.pack(self.type, self.control_id, self.netplay_count, self.keys, self.plugin)

    @classmethod
    def from_bytes(cls, data: bytes) -> SendKeyPacket:
        return cls(*_S_SEND_KEY.unpack(data[: _S_SEND_KEY.size]))


@dataclass
class RequestKeyPacket:
    """REQUEST_KEY (0x02) — client → server, 12 bytes."""
    type:          int = UDPPacketType.REQUEST_KEY
    control_id:    int = 0
    reg_id:        int = 0
    netplay_count: int = 0
    spectator:     int = 0
    buffer_size:   int = 0

    def pack(self) -> bytes:
        return _S_REQUEST_KEY.pack(
            self.type, self.control_id, self.reg_id,
            self.netplay_count, self.spectator, self.buffer_size,
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> RequestKeyPacket:
        return cls(*_S_REQUEST_KEY.unpack(data[: _S_REQUEST_KEY.size]))


@dataclass
class KeyEvent:
    """A single input event inside a RECV_KEY or PUSH_KEY packet. 9 bytes."""
    count:  int  # u32be — netplay frame count
    keys:   int  # u32be — packed controller state
    plugin: int  # u8

    def pack(self) -> bytes:
        return _S_KEY_EVENT.pack(self.count, self.keys, self.plugin)

    @classmethod
    def from_bytes(cls, data: bytes) -> KeyEvent:
        return cls(*_S_KEY_EVENT.unpack(data[: _S_KEY_EVENT.size]))


@dataclass
class RecvKeyPacket:
    """
    RECV_KEY (0x01) and PUSH_KEY (0x03) — server → client.

    Wire: 5-byte header + event_count × 9-byte KeyEvent
    """
    type:       int  # UDPPacketType.RECV_KEY or PUSH_KEY
    player:     int  # u8
    status:     int  # u8 — bitmask, see STATUS_* constants
    player_lag: int  # u8
    events:     list[KeyEvent] = field(default_factory=list)

    @property
    def event_count(self) -> int:
        return len(self.events)

    def pack(self) -> bytes:
        header = _S_RECV_KEY_HDR.pack(
            self.type, self.player, self.status, self.player_lag, len(self.events)
        )
        return header + b"".join(e.pack() for e in self.events)

    @classmethod
    def from_bytes(cls, data: bytes) -> RecvKeyPacket:
        hdr = _S_RECV_KEY_HDR.size  # 5
        t, player, status, player_lag, event_count = _S_RECV_KEY_HDR.unpack(data[:hdr])
        n = _S_KEY_EVENT.size  # 9
        events = [KeyEvent.from_bytes(data[hdr + i * n : hdr + (i + 1) * n]) for i in range(event_count)]
        return cls(t, player, status, player_lag, events)


@dataclass
class SyncDataPacket:
    """
    SYNC_DATA (0x04) — client → server.
    Sent every 600 VI interrupts for desync detection.
    Wire size: 5 + CP0_REGS_COUNT × 4 = 133 bytes.
    """
    type:           int = UDPPacketType.SYNC_DATA
    vi_counter:     int = 0
    cp0_registers:  list[int] = field(default_factory=lambda: [0] * CP0_REGS_COUNT)

    def pack(self) -> bytes:
        assert len(self.cp0_registers) == CP0_REGS_COUNT
        return _S_SYNC_HDR.pack(self.type, self.vi_counter) + _S_CP0_REGS.pack(*self.cp0_registers)

    @classmethod
    def from_bytes(cls, data: bytes) -> SyncDataPacket:
        hdr = _S_SYNC_HDR.size  # 5
        t, vi_counter = _S_SYNC_HDR.unpack(data[:hdr])
        cp0 = list(_S_CP0_REGS.unpack(data[hdr : hdr + _S_CP0_REGS.size]))
        return cls(t, vi_counter, cp0)


# ── Module-level size constants ───────────────────────────────────────────────

SYNC_DATA_WIRE_SIZE: int = _S_SYNC_HDR.size + _S_CP0_REGS.size  # 133


# ── Dispatch helpers ──────────────────────────────────────────────────────────

def parse_tcp_type(data: bytes) -> TCPPacketType:
    """Read the first byte and return its TCP packet type. Raises ValueError if unknown."""
    return TCPPacketType(data[0])


def parse_udp_type(data: bytes) -> UDPPacketType:
    """Read the first byte and return its UDP packet type. Raises ValueError if unknown."""
    return UDPPacketType(data[0])
