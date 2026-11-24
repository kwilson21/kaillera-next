"""Room membership when a roster delivery observes a transport disconnect."""

import asyncio
import json
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
    monkeypatch.setattr(signaling, "check", lambda *_: True)
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


@pytest.fixture
def delete_record(server, monkeypatch):
    delete = AsyncMock()
    monkeypatch.setattr(signaling.state, "delete_room", delete)
    monkeypatch.setattr(signaling, "_room_frames", {})
    return delete


@pytest.mark.parametrize("rejoin_first", [True, False])
def test_reclaim_and_fifth_cleanup_tick_follow_lock_order(server, delete_record, rejoin_first):
    async def scenario():
        room, _ = await lobby(server)
        signaling._sid_to_room.clear()
        signaling._sid_host.clear()
        offline = {}
        for _ in range(4):
            offline = await signaling._expire_rooms(offline)
        returned = await server.manager.connect("reclaimed", "/")
        request = {
            "extra": {
                "sessionid": "ROOM",
                "persistentId": "host",
                "reconnectToken": signaling.make_reconnect_token("ROOM", "host"),
            }
        }
        reclaim = signaling.join_room(returned, request)
        sweep = signaling._expire_rooms(offline)
        async with signaling._room_lock:
            first, second = (reclaim, sweep) if rejoin_first else (sweep, reclaim)
            queued = [asyncio.create_task(op) for op in (first, second)]
            await asyncio.sleep(0)  # both have reached the FIFO room lock
        results = await asyncio.gather(*queued)
        error, _ = results[0 if rejoin_first else 1]
        if rejoin_first:
            assert error is None
            assert signaling.rooms["ROOM"] is room
            assert room.players["host"]["socketId"] == returned
            delete_record.assert_not_awaited()
        else:
            assert error == "Room not found"
            assert returned not in signaling._sid_to_room
            delete_record.assert_awaited_once_with("ROOM")

    run_async(scenario())


def test_replacement_with_same_code_gets_five_offline_ticks(server, delete_record):
    async def scenario():
        await lobby(server)
        signaling._sid_to_room.clear()
        offline = {}
        for _ in range(4):
            offline = await signaling._expire_rooms(offline)
        replacement = signaling.Room("other", "New room", "", None, 4)
        replacement.spectators["watcher"] = {"socketId": "watcher-sid"}
        signaling.rooms["ROOM"] = replacement
        for _ in range(4):
            offline = await signaling._expire_rooms(offline)
            assert signaling.rooms["ROOM"] is replacement
        signaling._sid_to_room["watcher-sid"] = ("ROOM", "watcher", True)
        offline = await signaling._expire_rooms(offline)
        delete_record.assert_not_awaited()
        del signaling._sid_to_room["watcher-sid"]
        for _ in range(4):
            offline = await signaling._expire_rooms(offline)
            assert signaling.rooms["ROOM"] is replacement
        await signaling._expire_rooms(offline)
        assert "ROOM" not in signaling.rooms
        delete_record.assert_awaited_once_with("ROOM")

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


@pytest.mark.parametrize("status", ["lobby", "playing"])
@pytest.mark.parametrize("with_guest", [False, True])
def test_host_has_the_same_return_deadline_with_or_without_other_players(server, monkeypatch, status, with_guest):
    async def scenario():
        now = 10_000
        monkeypatch.setattr(signaling, "_now_ms", lambda: now)
        monkeypatch.setattr(signaling, "HOST_RETURN_GRACE_SECONDS", 120)
        events = AsyncMock(wraps=server.emit)
        monkeypatch.setattr(server, "emit", events)
        monkeypatch.setattr(signaling.db, "set_session_ended", AsyncMock())
        monkeypatch.setattr(signaling.desync_vision, "run_postmortem", AsyncMock())
        room, guest = await lobby(server)
        if not with_guest:
            await server._handle_eio_disconnect("guest-transport", "transport close")
        elif status == "playing":
            await signaling.join_room(
                await server.manager.connect("spectator", "/"),
                {
                    "extra": {"sessionid": "ROOM", "persistentId": "watcher", "spectate": True},
                },
            )
        room.status = status
        room.match_id = "current" if status == "playing" else None
        await server._handle_eio_disconnect("host-transport", "transport close")
        deadline = room.host_return_deadline
        assert deadline == now + 120_000
        _, roster = events.await_args.args
        assert roster["hostReturnDeadline"] == deadline and roster["serverTime"] == now
        assert signaling._join_ack(room)["hostReturnDeadline"] == deadline
        assert room.owner == room.players["host"]["socketId"]
        assert await signaling.join_room("stranger", {"extra": {"sessionid": "ROOM"}}) == ("Room closed", None)

        now = deadline
        returned = await server.manager.connect("too-late", "/")
        error, _ = await signaling.join_room(
            returned,
            {
                "extra": {
                    "sessionid": "ROOM",
                    "persistentId": "host",
                    "returnHost": True,
                    "reconnectToken": signaling.make_reconnect_token("ROOM", "host"),
                }
            },
        )
        assert error == signaling.HOST_SEAT_UNAVAILABLE
        assert "ROOM" not in signaling.rooms
        assert (
            await signaling.open_room(
                returned,
                {
                    "extra": {
                        "sessionid": "ROOM",
                        "persistentId": "host",
                        "fresh": True,
                        "reconnectToken": signaling.make_reconnect_token("ROOM", "host"),
                    }
                },
            )
            == signaling.HOST_SEAT_UNAVAILABLE
        )
        assert "ROOM" not in signaling.rooms
        assert guest not in signaling._sid_to_room
        assert not signaling._disconnect_grace_tasks
        assert list(server.manager.get_participants("/", "ROOM")) == []
        events.assert_awaited_with("room-closed", {"reason": "host-timeout"}, room="ROOM")
        if status == "playing":
            signaling.db.set_session_ended.assert_awaited_once_with("current", None, "host-timeout")

    run_async(scenario())


@pytest.mark.parametrize("failure", ["game-ended", "room-closed", "socket-close", "delete", "match-log"])
def test_expiry_attempts_other_notifications_and_cleanup_after_a_failure(server, monkeypatch, failure):
    async def scenario():
        room, guest = await lobby(server)
        room.status, room.match_id, room.host_return_deadline = "playing", "current", 1
        signaling._sid_host.pop(room.owner)
        signaling.rooms["EMPTY"] = signaling.Room("none", "Empty", "", None, 4)
        events = []

        async def emit(event, data, **options):
            target = options.get("to") or options["room"]
            events.append((event, target))
            if event == failure and target == "ROOM":
                raise RuntimeError("broadcast failed")

        monkeypatch.setattr(server, "emit", emit)
        close = AsyncMock(wraps=server.close_room)
        if failure == "socket-close":
            close.side_effect = RuntimeError("socket close failed")
        monkeypatch.setattr(server, "close_room", close)

        async def delete(code):
            if code == "ROOM" and failure == "delete":
                raise RuntimeError("delete failed")

        delete = AsyncMock(side_effect=delete)
        monkeypatch.setattr(signaling.state, "delete_room", delete)
        record = AsyncMock(side_effect=RuntimeError("match logging failed") if failure == "match-log" else None)
        monkeypatch.setattr(signaling, "_record_match_end", record)

        await signaling._expire_rooms({})
        assert ("game-ended", "ROOM") in events and ("room-closed", "ROOM") in events
        if failure == "room-closed":
            assert ("room-closed", guest) in events
        close.assert_awaited_once_with("ROOM")
        assert not signaling.rooms and not signaling._sid_to_room
        assert guest not in {sid for sid, _ in server.manager.get_participants("/", "ROOM")}
        assert [call.args[0] for call in delete.await_args_list] == ["ROOM", "EMPTY"]
        record.assert_awaited_once_with("ROOM", "current", "host-timeout")

    run_async(scenario())


def test_room_sweeper_runs_again_after_an_unexpected_failure(monkeypatch):
    sweep = AsyncMock(side_effect=[RuntimeError("failed sweep"), {}])
    monkeypatch.setattr(signaling, "_expire_rooms", sweep)
    monkeypatch.setattr(signaling.asyncio, "sleep", AsyncMock(side_effect=[None, None, asyncio.CancelledError()]))
    with pytest.raises(asyncio.CancelledError):
        run_async(signaling._cleanup_empty_rooms())
    assert sweep.await_count == 2


@pytest.mark.parametrize("resume", [True, False])
def test_host_rejoins_just_before_deadline_and_cancels_closure(server, monkeypatch, resume):
    async def scenario():
        now = 0
        monkeypatch.setattr(signaling, "_now_ms", lambda: now)
        monkeypatch.setattr(signaling.db, "set_session_ended", AsyncMock())
        monkeypatch.setattr(signaling.desync_vision, "run_postmortem", AsyncMock())
        room, _ = await lobby(server)
        room.status, room.match_id = "playing", "current"
        await server._handle_eio_disconnect("host-transport", "transport close")
        now = room.host_return_deadline - 1
        sid = await server.manager.connect("returned-transport", "/")
        signaling._sid_host[sid] = "localhost"
        error, ack = await signaling.join_room(
            sid,
            {
                "extra": {
                    "sessionid": "ROOM",
                    "persistentId": "host",
                    "resume": resume,
                    "returnHost": not resume,
                    "slot": 0,
                    "matchId": "current",
                    "reconnectToken": signaling.make_reconnect_token("ROOM", "host"),
                }
            },
        )
        assert error is None
        assert ack["owner"] == sid and ack.get("hostReturnDeadline") is None
        assert room.status == ("playing" if resume else "lobby")
        assert not signaling._disconnect_grace_tasks
        now += 1
        await signaling._expire_rooms({})
        assert signaling.rooms["ROOM"] is room

    run_async(scenario())


def test_explicit_leave_forfeits_the_host_seat_without_a_timer(server):
    async def scenario():
        room, guest = await lobby(server)
        await signaling.leave_room(room.owner)
        assert not signaling._disconnect_grace_tasks
        assert room.owner == guest and room.host_return_deadline is None
        sid = await server.manager.connect("former-host", "/")
        err, _ = await signaling.join_room(
            sid,
            {
                "extra": {
                    "sessionid": "ROOM",
                    "persistentId": "host",
                    "returnHost": True,
                    "reconnectToken": signaling.make_reconnect_token("ROOM", "host"),
                }
            },
        )
        assert err == signaling.HOST_SEAT_UNAVAILABLE
        assert room.owner == guest

    run_async(scenario())


@pytest.mark.parametrize("reserved", [True, False])
def test_shutdown_persists_the_deadline_without_restarting_an_existing_window(server, monkeypatch, reserved):
    async def scenario():
        room, _ = await lobby(server)
        monkeypatch.setattr(signaling.state, "enabled", lambda: True)
        monkeypatch.setattr(signaling, "_now_ms", lambda: 100_000)
        if reserved:
            room.host_return_deadline = 100_001
            await signaling._reserve_host("ROOM", room, "host")
        await signaling.finish_room_shutdown()
        expected = 100_001 if reserved else 100_000 + signaling.HOST_RETURN_GRACE_SECONDS * 1000
        assert room.host_return_deadline == expected
        signaling.state.save_room.assert_awaited_with("ROOM", room)
        assert not signaling._disconnect_grace_tasks

    run_async(scenario())


def test_restored_deadline_expires_on_its_own_even_with_a_connected_guest(server):
    async def scenario():
        room, guest = await lobby(server)
        deadline = signaling._now_ms() + 100
        room.host_return_deadline = deadline
        restored = signaling.state._deserialize_room(json.loads(signaling.state._serialize_room(room)))
        signaling.rooms["ROOM"] = restored
        await signaling.restore_host_reservations()
        assert restored.host_return_deadline == deadline
        await asyncio.wait_for(signaling._disconnect_grace_tasks["ROOM", "host"], timeout=2)
        assert guest not in signaling._sid_to_room and "ROOM" not in signaling.rooms

    run_async(scenario())


def test_startup_drops_expired_reservations_and_grants_legacy_rooms_one_window(server, monkeypatch):
    async def scenario():
        now = 100_000
        monkeypatch.setattr(signaling, "_now_ms", lambda: now)
        room, _ = await lobby(server)
        room.host_return_deadline = now
        legacy = signaling.Room("old-sid", "Old room", "", None, 4)
        legacy.players["host"] = {"socketId": "old-sid"}
        signaling.rooms["OLDER"] = legacy
        await signaling.restore_host_reservations()
        assert "ROOM" not in signaling.rooms
        assert legacy.host_return_deadline == now + signaling.HOST_RETURN_GRACE_SECONDS * 1000
        original = legacy.host_return_deadline
        now += 5000
        await signaling.restore_host_reservations()
        assert legacy.host_return_deadline == original

    run_async(scenario())


def test_same_browser_hosting_two_rooms_has_independent_grace(server, monkeypatch):
    async def scenario():
        first, _ = await lobby(server)
        second_host = await server.manager.connect("other-transport", "/")
        signaling._sid_host[second_host] = "localhost"
        opened = {"extra": {"sessionid": "OTHER", "persistentId": "host"}}
        assert await signaling.open_room(second_host, opened) is None

        # Hold the first timer until the host has returned to the second room.
        release = asyncio.Event()
        wait_for_host = signaling._wait_for_host_return

        async def grace(code, room):
            await release.wait()
            await wait_for_host(code, room)

        monkeypatch.setattr(signaling, "_wait_for_host_return", grace)
        await server._handle_eio_disconnect("host-transport", "transport close")
        await server._handle_eio_disconnect("other-transport", "transport close")
        timers = list(signaling._disconnect_grace_tasks.values())
        assert len(timers) == 2
        returned = await server.manager.connect("returned-transport", "/")
        signaling._sid_host[returned] = "localhost"
        error, _ = await signaling.join_room(
            returned,
            {
                "extra": {
                    "sessionid": "OTHER",
                    "persistentId": "host",
                    "returnHost": True,
                    "reconnectToken": signaling.make_reconnect_token("OTHER", "host"),
                }
            },
        )
        assert error is None
        first.host_return_deadline = 1
        release.set()
        await asyncio.gather(*timers, return_exceptions=True)
        assert "ROOM" not in signaling.rooms
        assert signaling.rooms["OTHER"].owner == returned
        assert signaling.rooms["OTHER"].slots == {0: "host"}
        assert not signaling._disconnect_grace_tasks

    run_async(scenario())


@pytest.mark.parametrize("replaced", ["timer", "seat"])
def test_expired_grace_leaves_a_replacement_alone(server, replaced):
    async def scenario():
        room, _ = await lobby(server)
        old_sid = room.owner
        async with signaling._room_lock:
            old = asyncio.create_task(signaling._disconnect_grace_expiry(old_sid, "ROOM", "host", "disconnect", 0))
            key = ("ROOM", "host")
            signaling._disconnect_grace_tasks[key] = old
            if replaced == "timer":
                replacement = asyncio.create_task(asyncio.sleep(0))
                signaling._disconnect_grace_tasks[key] = replacement
            else:
                room.owner = room.players["host"]["socketId"] = "new-socket"
                signaling._sid_to_room["new-socket"] = ("ROOM", "host", False)
        await old
        assert room.slots == {0: "host", 1: "guest"}
        if replaced == "timer":
            await replacement
            assert signaling._disconnect_grace_tasks[key] is replacement
        else:
            assert old_sid not in signaling._sid_to_room
            assert room.owner == "new-socket"
        signaling.db.insert_client_event.assert_not_awaited()

    run_async(scenario())


def test_shutdown_cancels_owner_grace_and_preserves_the_room(server):
    async def scenario():
        room, _guest = await lobby(server)
        await server._handle_eio_disconnect("host-transport", "transport close")
        grace = signaling._disconnect_grace_tasks["ROOM", "host"]
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
