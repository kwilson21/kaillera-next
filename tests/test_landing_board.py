"""Server plumbing for the landing page (docs/landing-design.md §7.2 M0):
listed rooms, board frames, the zombie-room rule, public stats, public CORS.

Run: cd server && uv run pytest ../tests/test_landing_board.py -v
"""

import asyncio
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from src import stats  # noqa: E402
from src.api import signaling  # noqa: E402


def _jpeg(size=(320, 240), color=(200, 40, 40)) -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "JPEG", quality=60)
    return out.getvalue()


JPEG = _jpeg()


def _run_async(coro):
    """asyncio.run off the main thread: pytest-playwright holds the main loop."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


@pytest.fixture
def sig(monkeypatch):
    """A room ROOM1 with a connected host 'host' (persistent id 'p-host')."""
    emitted = []

    async def emit(*a, **kw):
        emitted.append((a, kw))

    async def noop(*a, **kw):
        return None

    async def insert_screenshot(*a):
        return 1

    for name in ("rooms", "_sid_to_room", "_sid_host", "_room_frames", "_disconnect_grace_tasks"):
        monkeypatch.setattr(signaling, name, {})
    from src.api import og_card

    monkeypatch.setattr(og_card, "_cache", {})
    room = signaling.Room(owner="host", room_name="r", game_id="ssb64", password=None, max_players=4)
    room.players["p-host"] = {"socketId": "host", "playerName": "Kaz"}
    room.slots[0] = "p-host"
    signaling.rooms["ROOM1"] = room
    signaling._sid_to_room["host"] = ("ROOM1", "p-host", False)
    signaling._sid_host["host"] = "example"
    monkeypatch.setattr(signaling, "check", lambda sid, event: True)
    monkeypatch.setattr(signaling.sio, "emit", emit)
    monkeypatch.setattr(signaling.sio, "enter_room", noop)
    monkeypatch.setattr(signaling.sio, "leave_room", noop)
    monkeypatch.setattr(signaling.state, "save_room", noop)
    monkeypatch.setattr(signaling.db, "insert_screenshot", insert_screenshot)
    monkeypatch.setattr(signaling.db, "insert_client_event", noop)
    monkeypatch.setattr(signaling.db, "set_session_ended", noop)
    monkeypatch.setattr(signaling.state, "delete_room", noop)
    return room, emitted


def _join(sid, pid, spectate=False, token=None):
    payload = {"extra": {"sessionid": "ROOM1", "persistentId": pid, "player_name": "Friend", "spectate": spectate}}
    if token:
        payload["extra"]["reconnectToken"] = token
    signaling._sid_host[sid] = "example"
    return _run_async(signaling.join_room(sid, payload))


# ── Zombie-room rule ─────────────────────────────────────────────────────────


def test_new_player_can_join_a_live_room(sig):
    err, _ = _join("guest", "p-guest")
    assert err is None


def test_new_player_and_spectator_are_refused_by_a_zombie_room(sig):
    room, _ = sig
    del signaling._sid_host["host"]  # host's socket is gone (restart, nap)
    assert _join("guest", "p-guest") == ("Room closed", None)
    assert _join("watcher", "p-watch", spectate=True) == ("Room closed", None)
    assert "p-guest" not in room.players and "p-watch" not in room.spectators


def test_returning_member_may_revive_a_zombie_room(sig):
    room, _ = sig
    del signaling._sid_host["host"]
    token = signaling.make_reconnect_token("p-host")
    err, _ = _join("host-new", "p-host", token=token)
    assert err is None
    assert room.players["p-host"]["socketId"] == "host-new"
    assert signaling.room_is_live(room)
    # ...after which new players may join again.
    assert _join("guest", "p-guest")[0] is None


# ── Listing ──────────────────────────────────────────────────────────────────


def test_host_lists_and_unlists_the_room(sig):
    room, emitted = sig
    assert _run_async(signaling.set_listed("host", {"listed": True})) is None
    assert room.listed
    assert emitted[-1][0][0] == "users-updated" and emitted[-1][0][1]["listed"] is True
    assert _run_async(signaling.set_listed("host", {"listed": False})) is None
    assert not room.listed


def test_only_the_host_can_list(sig):
    room, _ = sig
    _join("guest", "p-guest")
    assert _run_async(signaling.set_listed("guest", {"listed": True})) == "Only the host can list the room"
    assert not room.listed


def test_password_rooms_are_never_listed(sig):
    room, _ = sig
    room.password = "secret"
    assert _run_async(signaling.set_listed("host", {"listed": True})) == "Rooms with a password can't be listed"
    assert not room.listed


def test_listed_flag_survives_redis_roundtrip_but_never_with_a_password():
    import json

    from src import state

    room = signaling.Room(owner="h", room_name="r", game_id="ssb64", password=None, max_players=4, listed=True)
    room.started_at = 123.0
    back = state._deserialize_room(json.loads(state._serialize_room(room)))
    assert back.listed and back.started_at == 123.0
    room.password = "x"
    assert not state._deserialize_room(json.loads(state._serialize_room(room))).listed


# ── Board frames ─────────────────────────────────────────────────────────────


def _screenshot(sid, room, data=JPEG):
    import base64

    msg = {"matchId": room.match_id, "slot": 0, "frame": 300, "data": base64.b64encode(data).decode()}
    _run_async(signaling.game_screenshot(sid, msg))


def _start(room):
    room.status = "playing"
    room.match_id = "m1"


def test_frame_kept_only_for_listed_in_game_host(sig):
    room, _ = sig
    _start(room)
    _screenshot("host", room)
    assert "ROOM1" not in signaling._room_frames  # not listed: nothing stored
    room.listed = True
    _screenshot("host", room)
    assert signaling.room_frame("ROOM1")[0] == JPEG


def test_frames_from_guests_or_non_jpeg_are_ignored(sig):
    room, _ = sig
    _start(room)
    room.listed = True
    _join("guest", "p-guest")
    _screenshot("guest", room)
    _screenshot("host", room, b"\x89PNG" + b"\x00" * 100)
    assert signaling.room_frame("ROOM1") is None


def test_frame_dropped_on_unlist_and_hidden_outside_a_match(sig):
    room, _ = sig
    _start(room)
    room.listed = True
    _screenshot("host", room)
    room.status = "lobby"
    assert signaling.room_frame("ROOM1") is None
    room.status = "playing"
    _run_async(signaling.set_listed("host", {"listed": False}))
    assert "ROOM1" not in signaling._room_frames


# ── REST: /list, /room, /api/stats/public, frames, CORS ──────────────────────


@pytest.fixture
def client(sig, monkeypatch):
    from fastapi.testclient import TestClient

    from src.api import app as appmod

    monkeypatch.setattr(appmod, "rooms", signaling.rooms)
    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://play.example")
    monkeypatch.setenv("PUBLIC_ORIGINS", "https://static.example")
    return TestClient(appmod.create_app())


def test_list_keeps_unlisted_rooms_without_a_code(client):
    rows = client.get("/list").json()
    assert rows == [
        {
            "room_name": "r",
            "host_name": "Kaz",
            "game_id": "ssb64",
            "player_count": 1,
            "max_players": 4,
            "status": "lobby",
            "has_password": False,
        }
    ]


def test_list_gives_listed_rooms_code_and_frame(client, sig):
    room, _ = sig
    room.listed = True
    _start(room)
    room.started_at = 1000.0
    _screenshot("host", room)
    row = client.get("/list").json()[0]
    assert row["room_code"] == "ROOM1"
    assert row["game"] == "Super Smash Bros. 64"
    assert row["host_name"] == "Kaz"
    assert row["status"] == "playing" and row["started_at"] == 1000.0
    assert row["frame_url"].startswith("/room/ROOM1/frame.jpg?t=")
    assert 0 <= row["frame_age_s"] < 5
    frame = client.get(row["frame_url"])
    assert frame.status_code == 200 and frame.content == JPEG
    assert frame.headers["content-type"] == "image/jpeg"
    assert "no-store" in frame.headers["cache-control"]


def test_listed_zombie_room_is_not_on_the_board(client, sig):
    room, _ = sig
    room.listed = True
    del signaling._sid_host["host"]
    assert client.get("/list").json() == []


def test_room_lookup_reports_host_listed_and_closed(client, sig):
    body = client.get("/room/ROOM1").json()
    assert body["host_name"] == "Kaz" and body["listed"] is False and body["closed"] is False
    del signaling._sid_host["host"]
    assert client.get("/room/ROOM1").json()["closed"] is True


def test_missing_frame_is_404(client):
    assert client.get("/room/ROOM1/frame.jpg").status_code == 404
    assert client.get("/room/NOPE/frame.jpg").status_code == 404


def test_public_stats_absent_until_a_full_week_is_recorded(client, sig, monkeypatch):
    import time

    room, _ = sig
    _start(room)
    monkeypatch.setattr(stats, "_local", stats.deque())
    monkeypatch.setattr(stats.state, "_redis", None)
    monkeypatch.setattr(stats, "_process_start", time.time() - 60)  # up for a minute
    body = client.get("/api/stats/public").json()
    assert body == {"matches_this_week": None, "people_playing_now": 1}


def test_matches_this_week_counts_only_the_window(monkeypatch):
    monkeypatch.setattr(stats, "_local", stats.deque())
    monkeypatch.setattr(stats, "_process_start", 0.0)
    monkeypatch.setattr(stats.state, "_redis", None)
    week = stats.WEEK_SECONDS
    for t in (10.0, 20.0, week - 5):
        _run_async(stats.record_match(t))
    # At week + 25 the cutoff is t=25: the matches at 10 and 20 have aged out.
    assert _run_async(stats.matches_this_week(now=week + 25)) == 1
    assert _run_async(stats.matches_this_week(now=week - 1)) is None


@pytest.mark.parametrize("path", ["/health", "/list", "/api/stats/public", "/room/ROOM1", "/room/NOPE"])
def test_public_endpoints_allow_the_static_origin(client, path):
    r = client.get(path, headers={"Origin": "https://static.example"})
    assert r.headers.get("access-control-allow-origin") == "https://static.example"
    assert "Origin" in r.headers.get("vary", "")


def test_public_cors_refuses_other_origins_and_other_paths(client):
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers
    r = client.get("/api/version", headers={"Origin": "https://static.example"})
    assert "access-control-allow-origin" not in r.headers


def test_health_is_fast_and_simple(client):
    body = client.get("/health").json()
    assert body["status"] == "ok" and "rooms" in body


# ── Keepalive flag (off unless KEEPALIVE_SECONDS is set) ─────────────────────


@pytest.mark.parametrize("raw,expected", [(None, 0), ("300", 300), ("junk", 0), ("-5", 0)])
def test_keepalive_is_off_by_default_and_follows_the_env(monkeypatch, raw, expected):
    from src.api import og

    if raw is None:
        monkeypatch.delenv("KEEPALIVE_SECONDS", raising=False)
    else:
        monkeypatch.setenv("KEEPALIVE_SECONDS", raw)
    html = og._inject_kn_config("<head></head>", rom_sharing_enabled=False)
    assert f'"keepaliveSeconds": {expected}' in html


# ── Invite card from the live frame ──────────────────────────────────────────


def _real_jpeg() -> bytes:
    import io

    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (320, 240), (200, 40, 40)).save(out, "JPEG", quality=60)
    return out.getvalue()


def test_card_is_1200x630_and_cached_per_frame():
    import io

    from PIL import Image

    from src.api import og_card

    og_card._cache.clear()
    jpeg = og_card.card_for("C1", (_real_jpeg(), 1.0), "Super Smash Bros. 64", "Kaz")
    assert Image.open(io.BytesIO(jpeg)).size == (1200, 630)
    assert og_card.card_for("C1", (b"not used", 1.0), "x", "y") is jpeg
    og_card.forget("C1")
    assert og_card._cache == {}


def test_play_page_uses_live_card_only_for_listed_room_with_frame(client, sig):
    room, _ = sig
    _start(room)
    html = client.get("/play.html?room=ROOM1").text
    assert "/static/og/cards/ssb64-play.png" in html and "card.jpg" not in html
    room.listed = True
    _screenshot("host", room, _real_jpeg())
    html = client.get("/play.html?room=ROOM1").text
    assert "/room/ROOM1/card.jpg?t=" in html
    card = client.get("/room/ROOM1/card.jpg")
    assert card.status_code == 200 and card.headers["content-type"] == "image/jpeg"
    assert client.get("/room/NOPE/card.jpg").status_code == 404


# ── Review fixes: restart recovery, spectator-only rooms, host transfer ──────


def test_token_key_is_stable_across_restarts_when_salt_is_set():
    assert signaling._token_key("salt") == signaling._token_key("salt")
    assert signaling._token_key("salt") != signaling._token_key("other")
    assert signaling._token_key("") != signaling._token_key("")  # random without a salt


def test_spectator_only_room_is_not_live(sig):
    room, _ = sig
    room.spectators["p-watch"] = {"socketId": "watcher", "playerName": "W"}
    signaling._sid_host["watcher"] = "example"
    del signaling._sid_host["host"]
    assert not signaling.room_is_live(room)
    assert _join("guest", "p-guest") == ("Room closed", None)


def test_host_transfer_takes_the_room_off_the_board(sig):
    room, _ = sig
    _join("guest", "p-guest")
    _start(room)
    room.listed = True
    signaling._room_frames["ROOM1"] = (JPEG, 1.0)
    _run_async(signaling._leave("host", "leave"))
    assert room.owner == "guest"
    assert not room.listed and "ROOM1" not in signaling._room_frames


def test_people_playing_now_counts_only_connected_players(client, sig):
    room, _ = sig
    _join("guest", "p-guest")
    _start(room)
    del signaling._sid_host["guest"]  # in its 30 s grace window
    assert client.get("/api/stats/public").json()["people_playing_now"] == 1


def test_busy_frame_is_shrunk_for_the_board_not_dropped(sig):
    import io
    import os

    from PIL import Image

    room, _ = sig
    _start(room)
    room.listed = True
    out = io.BytesIO()
    Image.frombytes("RGB", (320, 240), os.urandom(320 * 240 * 3)).save(out, "JPEG", quality=60)
    busy = out.getvalue()
    assert 20_000 < len(busy) <= 50_000
    _screenshot("host", room, busy)
    frame = signaling.room_frame("ROOM1")
    assert frame is not None and len(frame[0]) <= 20_000 and frame[0][:2] == b"\xff\xd8"


def test_frame_declaring_huge_dimensions_is_refused_without_decoding(sig):
    room, _ = sig
    _start(room)
    room.listed = True
    # A small file whose frame header claims 1000x1000: over our 640x480
    # bound but under Pillow's own decompression-bomb limit, so only our
    # check can refuse it.
    small = bytearray(_jpeg())
    sof = small.index(b"\xff\xc0")
    small[sof + 5 : sof + 9] = (1000).to_bytes(2, "big") * 2
    big = bytes(small)
    assert len(big) < 20_000
    _screenshot("host", room, big)
    assert signaling.room_frame("ROOM1") is None


# ── Second review round ──────────────────────────────────────────────────────


def test_host_leaving_with_only_spectators_unlists_the_room(sig):
    room, _ = sig
    room.listed = True
    room.spectators["p-watch"] = {"socketId": "watcher", "playerName": "W"}
    signaling._sid_to_room["watcher"] = ("ROOM1", "p-watch", True)
    signaling._sid_host["watcher"] = "example"
    _run_async(signaling._leave("host", "leave"))
    assert "ROOM1" in signaling.rooms and not room.listed


def test_join_allowed_while_the_only_player_is_in_grace(sig):
    room, _ = sig
    del signaling._sid_host["host"]
    signaling._disconnect_grace_tasks["p-host"] = object()  # lobby owner grace running
    assert _join("guest", "p-guest")[0] is None
    assert not signaling.room_frame("ROOM1")  # still nothing public


def test_end_game_drops_the_frame(sig):
    room, _ = sig
    _start(room)
    room.listed = True
    _screenshot("host", room)
    assert "ROOM1" in signaling._room_frames
    assert _run_async(signaling.end_game("host", {})) is None
    assert "ROOM1" not in signaling._room_frames and room.started_at is None


def test_start_game_records_a_match(sig, monkeypatch):
    room, _ = sig
    recorded = []

    async def record(ts):
        recorded.append(ts)

    monkeypatch.setattr(signaling.stats, "record_match", record)
    room.rom_ready.add("host")

    async def go():
        err = await signaling.start_game("host", {"mode": "rollback"})
        await asyncio.sleep(0)  # let the background stats task run
        return err

    assert _run_async(go()) is None
    assert recorded == [room.started_at]


def test_set_listed_is_rate_limited():
    from src import ratelimit

    assert "set-listed" in ratelimit._LIMITS


# ── Fourth Greptile round ────────────────────────────────────────────────────


def test_spectator_not_admitted_while_the_only_player_is_in_grace(sig):
    del signaling._sid_host["host"]
    signaling._disconnect_grace_tasks["p-host"] = object()
    assert _join("watcher", "p-watch", spectate=True) == ("Room closed", None)


def test_frame_not_stored_if_room_unlisted_while_it_was_processed(sig, monkeypatch):
    room, _ = sig
    _start(room)
    room.listed = True

    def unlist_during_processing(jpeg):
        room.listed = False  # set-listed False lands while the thread works
        return jpeg

    monkeypatch.setattr(signaling, "_board_frame", unlist_during_processing)
    _screenshot("host", room)
    assert "ROOM1" not in signaling._room_frames


def test_frame_not_stored_if_match_changed_while_it_was_processed(sig, monkeypatch):
    room, _ = sig
    _start(room)
    room.listed = True

    def new_match_during_processing(jpeg):
        room.match_id = "m2"
        return jpeg

    monkeypatch.setattr(signaling, "_board_frame", new_match_during_processing)
    _screenshot("host", room)
    assert "ROOM1" not in signaling._room_frames
