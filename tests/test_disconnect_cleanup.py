"""Room membership when a roster delivery observes a transport disconnect."""

import asyncio
import os
import signal
import subprocess
import sys
from unittest.mock import AsyncMock, Mock, patch

import pytest
import socketio
import uvicorn
from db_test_support import run_async
from src.api import signaling


@pytest.fixture
def server(monkeypatch):
    # Keep the real Socket.IO room manager and callback ordering. Replace
    # transport delivery and persistence so a drop is deterministic.
    server = socketio.AsyncServer(async_mode="asgi")
    server.on("disconnect", handler=signaling.disconnect)
    monkeypatch.setattr(server, "_send_eio_packet", AsyncMock())
    monkeypatch.setattr(signaling, "sio", server)
    monkeypatch.setattr(signaling, "_room_lock", asyncio.Lock())
    monkeypatch.setattr(signaling, "_waiting_disconnects", set())
    monkeypatch.setattr(signaling, "_disconnect_grace_tasks", {})
    monkeypatch.setattr(signaling, "_shutting_down", False)
    monkeypatch.setattr(signaling.state, "save_room", AsyncMock())
    monkeypatch.setattr(signaling.db, "insert_client_event", AsyncMock())
    with (
        patch.dict(signaling.rooms, clear=True),
        patch.dict(signaling._sid_to_room, clear=True),
        patch.dict(signaling._sid_host, clear=True),
    ):
        yield server


async def lobby(server):
    async def member(eio_sid, name):
        sid = await server.manager.connect(eio_sid, "/")
        await server.enter_room(sid, "ROOM")
        signaling._sid_host[sid] = "localhost"
        signaling._sid_to_room[sid] = ("ROOM", name, False)
        return sid

    host = await member("host-transport", "host")
    guest = await member("guest-transport", "guest")
    room = signaling.Room(host, "Room", "", None, 4)
    room.players = {"host": {"socketId": host}, "guest": {"socketId": guest}}
    room.slots = {0: "host", 1: "guest"}
    signaling.rooms["ROOM"] = room
    return room, guest


def test_lobby_disconnect_during_roster_delivery(server, monkeypatch):
    async def scenario():
        room, guest = await lobby(server)

        async def deliver(eio_sid, _packet):
            if eio_sid == "guest-transport":
                await server._handle_eio_disconnect(eio_sid, "transport close")

        monkeypatch.setattr(server, "_send_eio_packet", deliver)
        async with asyncio.timeout(2):
            await signaling.set_name(room.owner, {"name": "Host"})
            new_sid = await server.manager.connect("other-transport", "/")
            assert await signaling.open_room(new_sid, {"extra": {"sessionid": "NEXT"}}) is None
        assert guest not in signaling._sid_host
        assert guest not in signaling._sid_to_room
        assert room.slots == {0: "host"}
        assert list(server.manager.get_participants("/", "ROOM")) == [(room.owner, "host-transport")]
        signaling.db.insert_client_event.assert_awaited_once()

    run_async(scenario())


def test_uncontended_guest_leaves_before_disconnect_returns(server):
    async def scenario():
        room, guest = await lobby(server)
        await server._handle_eio_disconnect("guest-transport", "transport close")
        assert guest not in signaling._sid_to_room
        assert "guest" not in room.players
        assert not signaling._waiting_disconnects

    run_async(scenario())


def test_reclaim_ahead_of_deferred_cleanup_keeps_new_sid(server):
    async def scenario():
        room, guest = await lobby(server)
        room.status, room.match_id = "playing", "match"
        new_sid = await server.manager.connect("new-transport", "/")
        signaling._sid_host[new_sid] = "localhost"
        request = {
            "extra": {
                "sessionid": "ROOM",
                "persistentId": "guest",
                "reconnectToken": signaling.make_reconnect_token("ROOM", "guest"),
                "resume": True,
                "slot": 1,
                "matchId": "match",
            }
        }
        async with signaling._room_lock:
            returning = asyncio.create_task(signaling.join_room(new_sid, request))
            await asyncio.sleep(0)  # the rejoin is first in the room lock's queue
            await server._handle_eio_disconnect("guest-transport", "transport close")
            queued = tuple(signaling._waiting_disconnects)
            assert len(queued) == 1
        async with asyncio.timeout(2):
            assert (await returning)[0] is None
            await asyncio.gather(*queued)
        assert guest not in signaling._sid_to_room
        assert room.players["guest"]["socketId"] == new_sid
        assert room.slots[1] == "guest"
        assert not signaling._disconnect_grace_tasks
        assert (new_sid, "new-transport") in server.manager.get_participants("/", "ROOM")
        signaling.db.insert_client_event.assert_not_awaited()

    run_async(scenario())


def test_shutdown_preserves_members_awaiting_room_cleanup(server):
    async def scenario():
        room, guest = await lobby(server)
        async with signaling._room_lock:
            await server._handle_eio_disconnect("guest-transport", "transport close")
            queued = tuple(signaling._waiting_disconnects)
            assert len(queued) == 1
            signaling.set_shutting_down()
            async with asyncio.timeout(2):
                await asyncio.gather(*queued, return_exceptions=True)
            assert not signaling._waiting_disconnects
            assert queued[0].cancelled()
        assert guest not in signaling._sid_host
        assert room.players["guest"]["socketId"] == guest
        signaling.db.insert_client_event.assert_not_awaited()

    run_async(scenario())


def test_shutdown_drains_cleanup_that_already_started_persisting(server, monkeypatch):
    async def scenario():
        room, guest = await lobby(server)
        saving, release = asyncio.Event(), asyncio.Event()

        async def save(_room_id, changed):
            assert changed is room
            saving.set()
            await release.wait()

        monkeypatch.setattr(signaling.state, "save_room", save)
        async with asyncio.timeout(2):
            async with signaling._room_lock:
                await server._handle_eio_disconnect("guest-transport", "transport close")
                (cleanup,) = signaling._waiting_disconnects
            await saving.wait()
            stopping = asyncio.create_task(signaling.finish_room_shutdown())
            await asyncio.sleep(0)
            assert not stopping.done()
            assert not cleanup.cancelled()
            release.set()
            await asyncio.gather(stopping, cleanup)
        assert room.slots == {0: "host"}
        assert guest not in signaling._sid_to_room

    run_async(scenario())


def test_shutdown_cancels_owner_grace_and_preserves_the_room(server):
    async def scenario():
        room, _guest = await lobby(server)
        await server._handle_eio_disconnect("host-transport", "transport close")
        grace = signaling._disconnect_grace_tasks["host"]
        async with asyncio.timeout(2):
            await signaling.finish_room_shutdown()
            await asyncio.gather(grace, return_exceptions=True)
        assert grace.done()
        assert not signaling._disconnect_grace_tasks
        assert room.players["host"]["socketId"] == room.owner
        signaling.db.insert_client_event.assert_not_awaited()

    run_async(scenario())


def _check_sigterm_with_connected_guest():
    from src.main import run

    disconnects = []

    async def startup(runner, sockets=None):
        # Keep the real ASGI lifespan and Uvicorn's signal and shutdown
        # ordering. One in-memory connection stands in for the listener.
        await runner.lifespan.startup()
        assert not runner.lifespan.should_exit
        runner.servers = []
        runner.started = True
        await lobby(signaling.sio)

        def close_connection():
            runner.server_state.connections.remove(connection)
            task = asyncio.create_task(signaling.sio._handle_eio_disconnect("guest-transport", "transport close"))
            disconnects.append(task)
            runner.server_state.tasks.add(task)
            task.add_done_callback(runner.server_state.tasks.discard)

        connection = Mock(shutdown=close_connection)
        runner.server_state.connections.add(connection)
        signal.raise_signal(signal.SIGTERM)
        assert runner.should_exit

    # Uvicorn restores the previous handler and re-raises SIGTERM after exit.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with (
        patch.object(uvicorn.Server, "startup", startup),
        patch.object(signaling.sio, "_send_eio_packet", AsyncMock()),
        patch.object(signaling.state, "save_room", AsyncMock()) as save_room,
    ):
        run()
        (disconnect,) = disconnects
        disconnect.result()
        room = signaling.rooms["ROOM"]
        assert room.slots == {0: "host", 1: "guest"}, room.slots
        assert room.players["guest"]["socketId"] not in signaling._sid_host
        save_room.assert_not_awaited()


def test_sigterm_preserves_connected_guest_before_uvicorn_closes_transport(tmp_path):
    subprocess.run(
        [
            sys.executable,
            "-c",
            "from test_disconnect_cleanup import _check_sigterm_with_connected_guest as check; check()",
        ],
        env={
            "PYTHONPATH": os.pathsep.join(sys.path),
            "PYTHON_DOTENV_DISABLED": "1",
            "DISABLE_HTTPS": "1",
            "DB_PATH": str(tmp_path / "rooms.sqlite"),
        },
        check=True,
        timeout=10,
    )
