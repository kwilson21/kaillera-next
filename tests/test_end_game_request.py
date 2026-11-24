"""Match-bound end requests cannot end a later rematch."""

import asyncio
from unittest.mock import AsyncMock, patch

from src.api import signaling
from src.api.payloads import EndGamePayload


def test_stale_end_retry_does_not_end_rematch():
    room = signaling.Room(
        owner="host", room_name="Test", game_id="ssb64", password=None, max_players=4
    )
    room.match_id = "new-match"
    room.status = "playing"
    end = AsyncMock()
    with (
        patch.object(signaling, "_get_room", return_value=("ROOM", room)),
        patch.object(signaling, "_end_match", end),
    ):
        assert (
            asyncio.run(
                signaling._end_game_locked("host", EndGamePayload(matchId="old-match"))
            )
            is None
        )
        end.assert_not_awaited()
        assert (
            asyncio.run(
                signaling._end_game_locked("host", EndGamePayload(matchId="new-match"))
            )
            is None
        )
        end.assert_awaited_once_with("ROOM", room, "game-end")


def test_legacy_end_and_owner_authorization_are_preserved():
    room = signaling.Room(
        owner="host", room_name="Test", game_id="ssb64", password=None, max_players=4
    )
    end = AsyncMock()
    with (
        patch.object(signaling, "_get_room", return_value=("ROOM", room)),
        patch.object(signaling, "_end_match", end),
    ):
        assert (
            asyncio.run(signaling._end_game_locked("guest", EndGamePayload()))
            == "Only the host can end the game"
        )
        end.assert_not_awaited()
        assert asyncio.run(signaling._end_game_locked("host", EndGamePayload())) is None
        end.assert_awaited_once()
