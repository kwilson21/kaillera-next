"""What the server sends matches the models the client's schemas come from.

server/src/api/payloads.py describes every Socket.IO payload, and
scripts/gen_protocol.py turns those models into web/src/protocol.gen.ts. The
server-to-client dicts are still built by hand in signaling.py, so this drives
the real handlers through a room's life (open, join, spectate, start, rejoin
mid-match, end) and holds every emitted payload and every join-room ack to its
model. The models forbid unknown keys: a field added to a payload without
adding it to the model fails here, before the client schema can fall behind.

Run: cd server && uv run pytest ../tests/test_protocol_payloads.py -v
"""

import asyncio
import importlib.util
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import BaseModel, ValidationError
from src.api import payloads, signaling
from src.api.payloads import (
    SERVER_EVENTS,
    EndGamePayload,
    GameEnded,
    GameStarted,
    JoinRoomAck,
    JoinRoomPayload,
    OpenRoomPayload,
    RenegotiateRequest,
    RomSharingUpdated,
    SessionLogAck,
    StartGamePayload,
    TokenMessage,
    UsersUpdated,
)
from src.api.signaling import (
    _end_game_locked,
    _join_room_locked,
    _leave,
    _open_room_locked,
    _players_payload,
    _sid_to_room,
    _start_game_locked,
    make_reconnect_token,
    rooms,
)

REPO = Path(__file__).parent.parent


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(autouse=True)
def clean_state():
    rooms.clear()
    _sid_to_room.clear()
    yield
    rooms.clear()
    _sid_to_room.clear()


def _run(coro):
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


def _extra(pid: str, **more) -> dict:
    return {"sessionid": "ROOM1", "persistentId": pid, "reconnectToken": make_reconnect_token(pid), **more}


async def _room_life_steps() -> dict[str, dict | None]:
    """Drive the handlers through one match; returns the socket acks by name."""
    acks: dict[str, dict | None] = {}

    async def join(name: str, sid: str, pid: str, **more) -> None:
        err, ack = await _join_room_locked(sid, JoinRoomPayload(extra=_extra(pid, player_name=name, **more)))
        assert err is None, err
        acks[name] = ack

    assert await _open_room_locked("sid-host", OpenRoomPayload(extra=_extra("pid-host", player_name="Host"))) is None
    await join("guest", "sid-guest", "pid-guest")
    await join("spectator", "sid-spec", "pid-spec", spectate=True)
    rom = {"ready": True, "hash": "S" + "ab" * 32, "name": "Smash.z64", "size": 16 * 1024 * 1024}
    assert await signaling.rom_ready("sid-host", rom) is None
    assert await signaling.rom_ready("sid-guest", {"ready": True, "hash": rom["hash"]}) is None
    assert await signaling.rom_sharing_toggle("sid-host", {"enabled": False}) is None
    assert await _start_game_locked("sid-host", StartGamePayload(mode="rollback", gameId="ssb64")) is None
    # The guest's socket drops and comes back while the match runs.
    await join("rejoin", "sid-guest-2", "pid-guest")
    match_id = rooms["ROOM1"].match_id
    flush = {"matchId": match_id, "epoch": "e1", "entries": [{"seq": 0, "msg": "boot"}, {"seq": 1, "msg": "tick"}]}
    acks["session-log"] = await signaling.session_log_handler("sid-host", flush)
    acks["session-log refused"] = await signaling.session_log_handler("sid-host", {**flush, "matchId": "other"})
    assert await _end_game_locked("sid-host", EndGamePayload()) is None
    # The host leaves: the guest becomes the owner and is asked to renegotiate.
    await _leave("sid-host")
    return acks


async def _room_life(db_path: str) -> dict[str, dict | None]:
    # The session-log ack comes from the database layer, so it runs for real.
    # Always closed: an open SQLite worker thread keeps a failed run from exiting.
    await signaling.db.init_db(db_path)
    try:
        return await _room_life_steps()
    finally:
        await signaling.db.close_db()


@pytest.fixture
def room_life(tmp_path):
    emitted: list[tuple[str, dict]] = []
    emit = AsyncMock(side_effect=lambda event, data=None, **kw: emitted.append((event, data)))
    with ExitStack() as stack:
        for target, name in [
            (signaling.sio, "emit"),
            (signaling.sio, "enter_room"),
            (signaling.sio, "leave_room"),
            (signaling.state, "save_room"),
            (signaling.db, "register_match"),
            (signaling.db, "set_session_ended"),
            (signaling.db, "insert_client_event"),
            (signaling.stats, "record_match"),
            (signaling.desync_vision, "run_postmortem"),
        ]:
            stack.enter_context(patch.object(target, name, new=emit if name == "emit" else AsyncMock()))
        # The scenario runs once per test, from one "IP": the limiter is not under test.
        stack.enter_context(patch.object(signaling, "check", new=lambda *a, **k: True))
        # A room only admits joiners while a player's socket is connected.
        sids = dict.fromkeys(("sid-host", "sid-guest", "sid-guest-2", "sid-spec"), "example.test")
        stack.enter_context(patch.dict(signaling._sid_host, sids))
        acks = _run(_room_life(str(tmp_path / "test.db")))
    return emitted, acks


def test_every_emitted_payload_matches_its_model(room_life):
    emitted, _ = room_life
    seen = set()
    for event, data in emitted:
        assert event in SERVER_EVENTS, f"{event} has no model in payloads.py"
        SERVER_EVENTS[event].model_validate(data)
        seen.add(event)
    assert seen == set(SERVER_EVENTS), "the scenario no longer reaches every modelled event"


def test_users_updated_covers_lobby_and_match(room_life):
    emitted, _ = room_life
    updates = [UsersUpdated.model_validate(d) for e, d in emitted if e == "users-updated"]
    assert {u.status for u in updates} == {"lobby", "playing"}
    # Empty room state (no ROM, no mode) and full state both pass.
    assert any(u.romHash is None and u.mode is None for u in updates)
    assert any(u.romHash and u.hostRom.size for u in updates)
    assert any(u.spectators for u in updates)
    assert any(p.slot is not None and p.romReady for u in updates for p in u.players.values())


def test_join_room_acks_match_the_model(room_life):
    _, acks = room_life
    for name in ("guest", "spectator", "rejoin"):
        JoinRoomAck.model_validate(acks[name])
    # Null in the lobby; mid-match it names the match.
    assert acks["guest"]["matchId"] is None and acks["spectator"]["matchId"] is None
    assert acks["rejoin"]["status"] == "playing"
    assert isinstance(acks["rejoin"]["matchId"], str)


def test_session_log_ack_matches_the_model(room_life):
    _, acks = room_life
    assert SessionLogAck.model_validate(acks["session-log"]).lastSeq == 1
    # A flush the server turns away carries no ack data.
    assert acks["session-log refused"] is None


def test_the_new_owner_is_asked_to_renegotiate(room_life):
    emitted, _ = room_life
    assert ("webrtc-signal", {"requestRenegotiate": True}) in emitted


def test_game_started_and_ended_name_the_same_match(room_life):
    emitted, _ = room_life
    started = next(GameStarted.model_validate(d) for e, d in emitted if e == "game-started")
    ended = next(GameEnded.model_validate(d) for e, d in emitted if e == "game-ended")
    assert started.matchId == ended.matchId
    assert started.mode == "rollback"


def test_game_ended_without_a_match_is_null():
    GameEnded.model_validate({"matchId": None})


def test_models_reject_drift():
    """An unknown key, a missing key or a changed type each fail validation."""
    room = signaling.Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    good = _players_payload(room)
    UsersUpdated.model_validate(good)
    with pytest.raises(ValidationError):
        UsersUpdated.model_validate({**good, "newField": 1})
    with pytest.raises(ValidationError):
        UsersUpdated.model_validate({k: v for k, v in good.items() if k != "listed"})
    with pytest.raises(ValidationError):
        UsersUpdated.model_validate({**good, "status": "paused"})
    with pytest.raises(ValidationError):
        UsersUpdated.model_validate({**good, "romSize": "12"})


# ── the check on the way out ─────────────────────────────────────────────────


def test_no_server_built_emit_bypasses_the_check():
    """Every emit with a literal event name goes through `_emit`, which checks it.

    The emits left on `sio.emit` are the relays, whose event name is a variable.
    """
    source = (REPO / "server" / "src" / "api" / "signaling.py").read_text(encoding="utf-8")
    direct = re.findall(r"sio\.emit\(\s*[\"']([a-z-]+)[\"']", source)
    assert direct == [], f"use _emit for {direct}"
    checked_events = set(re.findall(r"_emit\(\s*[\"']([a-z-]+)[\"']", source))
    assert checked_events == set(SERVER_EVENTS), "SERVER_EVENTS and the _emit call sites disagree"


def test_a_payload_off_its_model_raises_under_tests_and_logs_in_production(caplog):
    bad = {"matchId": 7}
    assert payloads.RAISE_ON_CONTRACT_FAILURE
    with pytest.raises(payloads.PayloadContractError, match="GameEnded"):
        payloads.checked(GameEnded, bad, "game-ended")
    with patch.object(payloads, "RAISE_ON_CONTRACT_FAILURE", new=False), caplog.at_level("ERROR"):
        # The payload still goes out: a broken contract must not take a room down.
        assert payloads.checked(GameEnded, bad, "game-ended") is bad
    assert "PAYLOAD-CONTRACT game-ended does not match GameEnded" in caplog.text


def test_an_event_without_a_model_cannot_be_emitted():
    with pytest.raises(KeyError):
        _run(signaling._emit("brand-new-event", {}))


def test_a_restored_room_with_a_legacy_mode_still_matches():
    """A room saved before the rename comes back as "rollback", so `mode` can be the two-value literal."""
    import json

    from src import state

    room = signaling.Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.mode = "rollback"
    saved = json.loads(state._serialize_room(room))
    saved["mode"] = "lockstep"
    restored = state._deserialize_room(saved)
    assert UsersUpdated.model_validate(_players_payload(restored)).mode == "rollback"


# ── the generator ────────────────────────────────────────────────────────────


def _generator():
    spec = importlib.util.spec_from_file_location("gen_protocol", REPO / "scripts" / "gen_protocol.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_schemas_are_current():
    gen = _generator()
    assert gen.OUT.read_text(encoding="utf-8") == gen.generate(), "run `npm run protocol` and commit the result"


def test_every_public_model_gets_a_schema_and_a_decoder():
    text = _generator().generate()
    models = [
        name
        for name, value in vars(payloads).items()
        if isinstance(value, type)
        and issubclass(value, BaseModel)
        and value.__module__ == payloads.__name__
        and not name.startswith("_")
    ]
    assert len(models) > 20
    for name in models:
        assert f"export const {name} = Schema.Struct(" in text
        assert f"export const decode{name} = Schema.decodeUnknownResult({name});" in text
    assert "_ServerMessage" not in text


def test_the_client_event_map_leaves_out_relayed_events():
    text = _generator().generate()
    block = text[text.index("export const serverEvents = {") :]
    block = block[: block.index("} as const;")]
    for event, model in SERVER_EVENTS.items():
        row = f"'{event}': {model.__name__},"
        assert (row in block) == (event not in payloads.RELAYED_EVENTS)
    assert "webrtc-signal" not in block


def test_generator_refuses_what_it_cannot_translate():
    """A new kind of field stops generation; it is never emitted as `Unknown`."""
    import types

    gen = _generator()

    def render(annotation, **field):
        from pydantic import Field, create_model

        module = types.ModuleType("fake_payloads")
        model = create_model("Thing", __module__="fake_payloads", value=(annotation, Field(**field)))
        module.Thing = model
        return gen.Generator(module).render()

    assert "value: Schema.NullOr(Schema.Literals(['a', 'b']))," in render(Literal["a", "b"] | None)
    assert "value: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)))," in render(int, default=3, ge=2)
    assert "value: Schema.Record(Schema.String, Schema.Array(Schema.Boolean))," in render(dict[str, list[bool]])
    assert "value: Schema.Literal(true)," in render(Literal[True])
    for annotation, field in [
        (int | str, {}),
        (bytes, {}),
        (dict[int, str], {}),
        (int, {"gt": 0}),
        (str, {"pattern": "a"}),
    ]:
        with pytest.raises(gen.Unsupported):
            render(annotation, **field)


def test_generator_refuses_a_validator_it_does_not_know():
    """A validator changes what a model accepts without changing its annotations."""
    import types

    from pydantic import field_validator

    gen = _generator()

    class Thing(BaseModel):
        value: str

        @field_validator("value", mode="before")
        @classmethod
        def _lowercase(cls, v):
            return v.lower()

    module = types.ModuleType("fake_payloads")
    Thing.__module__ = "fake_payloads"
    module.Thing = Thing
    with pytest.raises(gen.Unsupported, match="_lowercase"):
        gen.Generator(module).render()
    # The one validator payloads.py has is listed, with what the schema does about it.
    assert set(gen.KNOWN_VALIDATORS) == {"_coerce_legacy_mode"}
