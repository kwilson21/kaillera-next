"""
Mupen64Plus UDP netplay handler.

One NetplayUDPProtocol instance is shared across all clients — UDP is connectionless.
Use create_udp_handler(session_mgr) to get the factory for create_datagram_endpoint().

Routing strategy:
  - REQUEST_KEY carries a reg_id → we use it to map source addr → reg_id
  - SEND_KEY carries no reg_id → we look up the sender via the addr→reg_id map
    built from prior REQUEST_KEY packets

V1 scope: store inputs, respond to REQUEST_KEY with RECV_KEY.
  - No gratuitous PUSH_KEY (v2)
  - No input buffer pruning (v2 — add LRU eviction when memory matters)
  - SYNC_DATA logged and ignored (desync detection is v2)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable

from src.netplay.protocol import (
    KeyEvent,
    RecvKeyPacket,
    RequestKeyPacket,
    SendKeyPacket,
    SyncDataPacket,
    UDPPacketType,
)
from src.session import SessionManager

log = logging.getLogger(__name__)

# Type alias for UDP address tuples
_Addr = tuple[str, int]


class NetplayUDPProtocol(asyncio.DatagramProtocol):
    """Handles all Mupen64Plus UDP datagrams for all connected clients."""

    def __init__(self, session_mgr: SessionManager) -> None:
        self._mgr = session_mgr
        self._transport: asyncio.DatagramTransport | None = None

        # addr → reg_id: populated on first REQUEST_KEY from an address.
        # Used to attribute SEND_KEY traffic (which carries no reg_id).
        self._addr_to_reg_id: dict[_Addr, int] = {}

        # session_id → netplay_count → control_id → KeyEvent
        # TODO v2: add LRU eviction to bound memory usage
        self._inputs: dict[str, dict[int, dict[int, KeyEvent]]] = {}

    # ── asyncio.DatagramProtocol callbacks ────────────────────────────────────

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = transport  # type: ignore[assignment]
        log.info("UDP handler ready")

    def datagram_received(self, data: bytes, addr: _Addr) -> None:
        if not data:
            return
        try:
            ptype = UDPPacketType(data[0])
        except ValueError:
            log.debug("UDP %s: unknown type 0x%02x — dropped", addr, data[0])
            return

        if ptype == UDPPacketType.SEND_KEY:
            self._handle_send_key(data, addr)
        elif ptype == UDPPacketType.REQUEST_KEY:
            self._handle_request_key(data, addr)
        elif ptype == UDPPacketType.SYNC_DATA:
            self._handle_sync_data(data, addr)
        # RECV_KEY (0x01) and PUSH_KEY (0x03) are server→client only; ignore if received

    def error_received(self, exc: Exception) -> None:
        log.warning("UDP error: %s", exc)

    def connection_lost(self, exc: Exception | None) -> None:
        pass

    # ── Packet handlers ───────────────────────────────────────────────────────

    def _handle_send_key(self, data: bytes, addr: _Addr) -> None:
        pkt = SendKeyPacket.from_bytes(data)

        reg_id = self._addr_to_reg_id.get(addr)
        if reg_id is None:
            log.debug("UDP SEND_KEY from unknown addr %s — dropped (awaiting REQUEST_KEY)", addr)
            return

        session = self._mgr.lookup_session(reg_id)
        if session is None:
            return

        event = KeyEvent(count=pkt.netplay_count, keys=pkt.keys, plugin=pkt.plugin)
        self._store_input(session.session_id, pkt.netplay_count, pkt.control_id, event)

    def _handle_request_key(self, data: bytes, addr: _Addr) -> None:
        pkt = RequestKeyPacket.from_bytes(data)

        # Register addr → reg_id on first sight
        if addr not in self._addr_to_reg_id:
            self._addr_to_reg_id[addr] = pkt.reg_id
            log.debug("UDP: mapped %s → reg_id=%d", addr, pkt.reg_id)

        session = self._mgr.lookup_session(pkt.reg_id)
        if session is None:
            return

        events = list(
            self._inputs.get(session.session_id, {}).get(pkt.netplay_count, {}).values()
        )

        record = session.get_player(pkt.reg_id)
        player_slot = record.slot if record is not None else 0

        resp = RecvKeyPacket(
            type=UDPPacketType.RECV_KEY,
            player=player_slot,
            status=0,
            player_lag=0,
            events=events,
        )
        if self._transport:
            self._transport.sendto(resp.pack(), addr)

    def _handle_sync_data(self, data: bytes, addr: _Addr) -> None:
        pkt = SyncDataPacket.from_bytes(data)
        log.debug("UDP SYNC_DATA vi_counter=%d from %s", pkt.vi_counter, addr)

    # ── Input buffer ──────────────────────────────────────────────────────────

    def _store_input(
        self, session_id: str, netplay_count: int, control_id: int, event: KeyEvent
    ) -> None:
        (
            self._inputs
            .setdefault(session_id, {})
            .setdefault(netplay_count, {})
        )[control_id] = event


# ── Factory ───────────────────────────────────────────────────────────────────

def create_udp_handler(session_mgr: SessionManager) -> Callable[[], NetplayUDPProtocol]:
    """Return a protocol factory for asyncio.create_datagram_endpoint()."""
    def factory() -> NetplayUDPProtocol:
        return NetplayUDPProtocol(session_mgr)
    return factory
