"""The three ways a match is played, as the server takes them.

rollback, lockstep and streaming are each their own mode. "lockstep" was also
the name rollback had before it was renamed; the server used to read it as
rollback. Pages reload on every deploy and rooms last hours, so nothing sends
it in that sense any more, and it now means the lockstep mode a host picks.

Run: cd server && uv run pytest ../tests/test_mode_coercion.py -v
"""

import json

from src import state
from src.api import signaling
from src.api.payloads import SetModePayload, StartGamePayload


def test_payloads_default_to_rollback():
    assert StartGamePayload().mode == "rollback"
    assert SetModePayload().mode == "rollback"


def test_every_mode_is_taken_as_itself():
    for mode in ("rollback", "lockstep", "streaming"):
        assert StartGamePayload.model_validate({"mode": mode}).mode == mode
        assert SetModePayload.model_validate({"mode": mode}).mode == mode


def test_the_server_keeps_a_lockstep_room_lockstep():
    assert "lockstep" in signaling._VALID_MODES
    room = signaling.Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.mode = "lockstep"
    restored = state._deserialize_room(json.loads(state._serialize_room(room)))
    assert restored.mode == "lockstep"
