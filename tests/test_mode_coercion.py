"""Classic and legacy mode values at the room protocol and Redis boundaries."""

import json

import pytest
from src import state
from src.api import signaling
from src.api.payloads import SetModePayload, StartGamePayload


def test_payloads_default_to_rollback():
    assert StartGamePayload().mode == "rollback"
    assert SetModePayload().mode == "rollback"


def test_every_mode_is_taken_as_itself():
    for mode in ("rollback", "classic", "lockstep", "streaming"):
        assert StartGamePayload.model_validate({"mode": mode}).mode == mode
        assert SetModePayload.model_validate({"mode": mode}).mode == mode


@pytest.mark.parametrize("value", ["classic", "lockstep"])
def test_classic_room_mode_round_trips(value):
    room = signaling.Room(
        owner="sid-host",
        room_name="Test",
        game_id="ssb64",
        password=None,
        max_players=4,
    )
    room.mode = value
    restored = state._deserialize_room(json.loads(state._serialize_room(room)))
    assert restored.mode == "classic"
