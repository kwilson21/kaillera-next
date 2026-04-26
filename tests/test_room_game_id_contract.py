"""Regression checks for room game_id propagation.

Direct room joins call GET /room/{id} before the Socket.IO join ack. Both
surfaces must expose the room game id so a fresh browser can initialize game-
specific netplay behavior before booting a mid-game join.
"""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_rest_room_payload_includes_game_id_aliases():
    source = (REPO_ROOT / "server/src/api/app.py").read_text()
    handler_idx = source.find('@app.get("/room/{room_id}")')
    assert handler_idx != -1
    window = source[handler_idx : handler_idx + 900]

    assert '"game_id": room.game_id' in window
    assert '"gameId": room.game_id' in window


def test_play_join_adopts_room_game_id_before_mid_game_init():
    source = (REPO_ROOT / "web/static/play.js").read_text()
    room_fetch_idx = source.find("const response = await fetch(`/room/${encodeURIComponent(roomCode)}`);")
    assert room_fetch_idx != -1
    mid_game_idx = source.find("if (roomData.status === 'playing')", room_fetch_idx)
    assert mid_game_idx != -1
    window = source[room_fetch_idx:mid_game_idx]

    assert "const roomGameId = roomData.gameId || roomData.game_id" in window
    assert "KNState.gameId = _gameId" in window


def test_join_ack_payload_includes_game_id_aliases():
    source = (REPO_ROOT / "server/src/api/signaling.py").read_text()
    payload_idx = source.find("def _players_payload(room: Room) -> dict:")
    assert payload_idx != -1
    window = source[payload_idx : payload_idx + 2500]

    assert '"gameId": room.game_id' in window
    assert '"game_id": room.game_id' in window
