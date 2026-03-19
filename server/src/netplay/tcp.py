"""
Mupen64Plus TCP netplay handler.

One NetplayTCPProtocol instance is created per client connection.
Use create_tcp_handler(session_mgr) to get the factory for asyncio.create_server().
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable

from src.netplay.protocol import (
    DisconnectBody,
    EmulatorSettings,
    RegisterBody,
    RegistrationsResponse,
    SaveFilePacket,
    TCPPacketType,
)
from src.session import SessionManager

log = logging.getLogger(__name__)

# Fixed body sizes (bytes after the type byte) for each packet type.
# SEND_SAVE (0x01) is variable-length and handled separately.
_BODY_SIZE: dict[TCPPacketType, int] = {
    TCPPacketType.REQUEST_SAVE:      0,
    TCPPacketType.SEND_SETTINGS:     24,
    TCPPacketType.REQUEST_SETTINGS:  0,
    TCPPacketType.REGISTER:          7,
    TCPPacketType.GET_REGISTRATIONS: 0,
    TCPPacketType.DISCONNECT:        4,
}


class NetplayTCPProtocol(asyncio.Protocol):
    """Handles one Mupen64Plus TCP connection."""

    def __init__(self, session_mgr: SessionManager) -> None:
        self._mgr = session_mgr
        self._transport: asyncio.Transport | None = None
        self._buf = bytearray()
        self._reg_id: int | None = None   # set after REGISTER succeeds
        self._peer: str = "?"

    # ── asyncio.Protocol callbacks ────────────────────────────────────────────

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = transport  # type: ignore[assignment]
        peer = transport.get_extra_info("peername")
        self._peer = f"{peer[0]}:{peer[1]}" if peer else "?"
        log.info("TCP connect %s", self._peer)

    def connection_lost(self, exc: Exception | None) -> None:
        if exc:
            log.info("TCP disconnect %s (%s)", self._peer, exc)
        else:
            log.info("TCP disconnect %s", self._peer)
        if self._reg_id is not None:
            self._mgr.disconnect(self._reg_id)
            self._reg_id = None

    def data_received(self, data: bytes) -> None:
        self._buf.extend(data)
        self._process_buffer()

    # ── Stream reassembly ─────────────────────────────────────────────────────

    def _process_buffer(self) -> None:
        while self._buf:
            ptype_byte = self._buf[0]
            try:
                ptype = TCPPacketType(ptype_byte)
            except ValueError:
                log.warning("TCP %s: unknown packet type 0x%02x — closing", self._peer, ptype_byte)
                if self._transport:
                    self._transport.close()
                return

            if ptype == TCPPacketType.SEND_SAVE:
                # Variable-length: 1 type byte + 4 length prefix + N data bytes
                if len(self._buf) < 5:
                    return
                length = int.from_bytes(self._buf[1:5], "big")
                if len(self._buf) < 5 + length:
                    return
                body = bytes(self._buf[1 : 5 + length])
                del self._buf[: 5 + length]
                self._handle_send_save(SaveFilePacket.from_bytes(body))
            else:
                body_size = _BODY_SIZE[ptype]
                if len(self._buf) < 1 + body_size:
                    return
                body = bytes(self._buf[1 : 1 + body_size])
                del self._buf[: 1 + body_size]
                self._dispatch(ptype, body)

    def _dispatch(self, ptype: TCPPacketType, body: bytes) -> None:
        if ptype == TCPPacketType.REGISTER:
            self._handle_register(body)
        elif ptype == TCPPacketType.SEND_SETTINGS:
            self._handle_send_settings(body)
        elif ptype == TCPPacketType.REQUEST_SETTINGS:
            self._handle_request_settings()
        elif ptype == TCPPacketType.GET_REGISTRATIONS:
            self._handle_get_registrations()
        elif ptype == TCPPacketType.REQUEST_SAVE:
            self._handle_request_save()
        elif ptype == TCPPacketType.DISCONNECT:
            self._handle_disconnect(body)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _write(self, data: bytes) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.write(data)

    # ── Packet handlers ───────────────────────────────────────────────────────

    def _handle_register(self, body: bytes) -> None:
        pkt = RegisterBody.from_bytes(body)
        try:
            resp = self._mgr.register_player(pkt.reg_id, pkt.plugin, pkt.rawdata)
        except ValueError:
            log.warning(
                "TCP %s: REGISTER with unknown reg_id=%d — closing", self._peer, pkt.reg_id
            )
            if self._transport:
                self._transport.close()
            return
        self._reg_id = pkt.reg_id
        log.info(
            "TCP %s: registered reg_id=%d slot=%d", self._peer, pkt.reg_id, resp.assigned_slot
        )
        self._write(resp.pack())

    def _handle_send_settings(self, body: bytes) -> None:
        settings = EmulatorSettings.from_bytes(body)
        if self._reg_id is not None:
            self._mgr.set_settings(self._reg_id, settings)
            log.debug("TCP %s: emulator settings stored", self._peer)

    def _handle_request_settings(self) -> None:
        settings = self._mgr.get_settings(self._reg_id) if self._reg_id is not None else None
        if settings is None:
            log.warning("TCP %s: REQUEST_SETTINGS before settings available — sending zeros", self._peer)
            settings = EmulatorSettings(0, 0, 0, 0, 0, 0)
        self._write(settings.pack())

    def _handle_get_registrations(self) -> None:
        session = self._mgr.lookup_session(self._reg_id) if self._reg_id is not None else None
        if session is None:
            log.warning("TCP %s: GET_REGISTRATIONS with no active session — sending empty", self._peer)
            self._write(RegistrationsResponse.empty().pack())
            return
        self._write(session.to_registrations_response().pack())

    def _handle_send_save(self, pkt: SaveFilePacket) -> None:
        if self._reg_id is not None:
            self._mgr.store_save(self._reg_id, pkt.data)
            log.debug("TCP %s: save file stored (%d bytes)", self._peer, len(pkt.data))

    def _handle_request_save(self) -> None:
        data = self._mgr.get_save(self._reg_id) if self._reg_id is not None else None
        if data is None:
            log.warning("TCP %s: REQUEST_SAVE before save available — sending empty", self._peer)
            data = b""
        self._write(SaveFilePacket(data).pack())

    def _handle_disconnect(self, body: bytes) -> None:
        pkt = DisconnectBody.from_bytes(body)
        log.info("TCP %s: DISCONNECT reg_id=%d", self._peer, pkt.reg_id)
        self._mgr.disconnect(pkt.reg_id)
        if pkt.reg_id == self._reg_id:
            self._reg_id = None


# ── Factory ───────────────────────────────────────────────────────────────────

def create_tcp_handler(session_mgr: SessionManager) -> Callable[[], NetplayTCPProtocol]:
    """Return a protocol factory for asyncio.create_server()."""
    def factory() -> NetplayTCPProtocol:
        return NetplayTCPProtocol(session_mgr)
    return factory
