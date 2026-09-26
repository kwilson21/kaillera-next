"""Front page board states and behaviour (docs/landing-design.md §7.2 M1, §7.3).

The server's /health, /list and /api/stats/public are mocked per test with
Playwright routes, so every board state can be reached on demand.

Run: pytest tests/test_landing_page.py -v
"""

import re
import time

import pytest
from playwright.sync_api import expect


def _ago(seconds):
    # Computed per test, not at import: the suite may run long after collection.
    return time.time() - seconds


def _room(
    code,
    host,
    status="lobby",
    players=2,
    max_players=4,
    spectators=0,
    started=None,
    frame=None,
):
    return {
        "room_code": code,
        "game": "Super Smash Bros. 64",
        "host_name": host,
        "player_count": players,
        "max_players": max_players,
        "spectator_count": spectators,
        "max_spectators": 20,
        "status": status,
        "started_at": started,
        "frame_url": frame,
        "frame_age_s": 3 if frame else None,
    }


def _mock(page, rooms=(), stats=None, health=True, list_ok=True):
    page.route(
        "**/health",
        lambda r: r.fulfill(json={"status": "ok"}) if health else r.abort(),
    )
    page.route(
        "**/list",
        lambda r: r.fulfill(json=list(rooms)) if list_ok else r.fulfill(status=500, body="boom"),
    )
    page.route(
        "**/api/stats/public",
        lambda r: r.fulfill(json=stats or {"matches_this_week": None, "people_playing_now": 0}),
    )
    page.route("**/room/*/frame.jpg*", lambda r: r.fulfill(status=404))


def _state(page):
    return page.locator("#board").get_attribute("data-state")


@pytest.fixture
def landing(page, server_url):
    def go(**kw):
        _mock(page, **kw)
        page.goto(server_url)
        expect(page.locator("#board")).not_to_have_attribute("data-state", "loading")
        return page

    return go


def test_empty_state_with_real_week_number(landing):
    page = landing(stats={"matches_this_week": 41, "people_playing_now": 0})
    assert _state(page) == "empty"
    expect(page.locator("#st-empty")).to_contain_text("The floor is quiet.")
    expect(page.locator("#st-empty")).to_contain_text("41 matches were played this week.")
    expect(page.locator("#board-week")).to_have_text("41 matches this week")


def test_empty_state_shows_no_number_until_one_exists(landing):
    page = landing(stats={"matches_this_week": None, "people_playing_now": 0})
    assert _state(page) == "empty"
    expect(page.locator("#board-week")).to_have_text("")
    assert "matches" not in page.locator("#st-empty").inner_text()


def test_live_board_rows_and_links(landing):
    page = landing(
        rooms=[
            _room("KAZ12345", "Kaz"),
            _room("MOOSE123", "Moose", "playing", 3, started=_ago(360)),
        ],
        stats={"matches_this_week": 5, "people_playing_now": 3},
    )
    assert _state(page) == "live"
    expect(page.locator("#board-live")).to_have_text("3 people playing right now")
    expect(page.locator(".room")).to_have_count(2)
    kaz = page.locator(".room").nth(0)
    expect(kaz).to_contain_text("hosted by Kaz")
    expect(kaz).to_contain_text("2/4")
    expect(kaz).to_contain_text("waiting for players")
    assert kaz.get_by_role("link", name="Join Kaz's room, needs your ROM").get_attribute("href") == (
        "/play.html?room=KAZ12345"
    )
    assert kaz.get_by_role("link", name="Watch Kaz's room").get_attribute("href") == (
        "/play.html?room=KAZ12345&spectate=1"
    )
    expect(page.locator(".room").nth(1)).to_contain_text("in game · 6 min")


def test_full_room_offers_watch_only(landing):
    page = landing(rooms=[_room("FULL1234", "Firo", "playing", 4, started=_ago(60))])
    row = page.locator(".room").first
    expect(row.get_by_role("link", name=re.compile("^Watch"))).to_have_count(1)
    expect(row.get_by_role("link", name=re.compile("^Join"))).to_have_count(0)


def test_featured_prefers_newest_match_with_an_open_slot(landing):
    page = landing(
        rooms=[
            _room("OLDOPEN1", "Old", "playing", 2, started=_ago(900)),
            _room("NEWFULL1", "Full", "playing", 4, started=_ago(60)),
            _room("NEWOPEN1", "New", "playing", 3, started=_ago(120)),
            _room("WAITING1", "Wait", "lobby", 1),
        ]
    )
    featured = page.locator("#featured")
    expect(featured).to_be_visible()
    expect(featured).to_contain_text("hosted by New")
    expect(featured.get_by_role("link", name=re.compile("^Join"))).to_have_text("Join · 1 slot open")


def test_no_featured_without_a_match_in_progress(landing):
    page = landing(rooms=[_room("WAITING1", "Wait")])
    assert _state(page) == "live"
    expect(page.locator("#featured")).to_be_hidden()


def test_server_strings_are_text_not_html(landing):
    page = landing(rooms=[_room("XSS12345", '<img src=x onerror="window.__pwned=1">')])
    expect(page.locator(".room .h")).to_contain_text("<img src=x")
    assert page.evaluate("window.__pwned") is None
    assert page.locator(".room img").count() == 0


def test_waking_state_disables_actions_and_recovers(page, server_url):
    alive = {"up": False}
    _mock(page)
    page.unroute("**/health")
    page.route(
        "**/health",
        lambda r: r.fulfill(json={"status": "ok"}) if alive["up"] else r.abort(),
    )
    page.goto(server_url)
    expect(page.locator("#board")).to_have_attribute("data-state", "waking")
    expect(page.locator("#st-waking")).to_have_attribute("role", "status")
    expect(page.locator("#create-btn")).to_be_disabled()
    expect(page.locator("#create-btn")).to_have_text("Create a room · ready in a moment")
    # The visualizer answers SPACE while waking.
    page.keyboard.press("Space")
    expect(page.locator("#v-in")).to_have_text("0 ms")
    # ...and its Send button. The controls sit beside a real button, not
    # inside a role="button" wrapper (axe: nested-interactive).
    assert page.locator("#viz").get_attribute("role") is None
    page.evaluate("document.getElementById('v-in').textContent = '--'")
    page.locator("#viz-send").focus()
    page.keyboard.press("Enter")
    expect(page.locator("#v-in")).to_have_text("0 ms")
    alive["up"] = True
    expect(page.locator("#board")).to_have_attribute("data-state", "empty", timeout=10000)
    expect(page.locator("#create-btn")).to_be_enabled()


def test_list_failure_shows_error_and_keeps_create(landing):
    page = landing(list_ok=False)
    assert _state(page) == "error"
    expect(page.locator("#st-error")).to_contain_text("Couldn't load rooms.")
    expect(page.locator("#create-btn")).to_be_enabled()


def test_code_field_accepts_a_pasted_invite_link(landing):
    page = landing()
    page.fill("#room-code", "https://example.com/play.html?room=abc123&spectate=1")
    page.click("#watch-btn")
    expect(page).to_have_url(re.compile(r"/play\.html\?room=ABC123&spectate=1$"))


def test_poll_does_not_steal_keyboard_focus(landing):
    page = landing(rooms=[_room("KAZ12345", "Kaz")])
    link = page.get_by_role("link", name="Join Kaz's room, needs your ROM")
    link.focus()
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")  # triggers a refresh
    page.wait_for_timeout(500)
    assert page.evaluate("document.activeElement.getAttribute('aria-label')") == ("Join Kaz's room, needs your ROM")


def test_header_mark_is_stable_for_a_visitor_and_advances_on_click(landing):
    page = landing()
    first = page.evaluate("document.getElementById('hdr-mark').innerHTML")
    page.reload()
    expect(page.locator("#board")).not_to_have_attribute("data-state", "loading")
    assert page.evaluate("document.getElementById('hdr-mark').innerHTML") == first
    page.click("#name")
    page.wait_for_timeout(400)
    assert page.evaluate("document.getElementById('hdr-mark').innerHTML") != first


def test_front_page_headers(server_url):
    import requests

    r = requests.get(server_url + "/", timeout=5)
    csp = r.headers["content-security-policy"]
    assert "script-src 'self';" in csp  # still no inline script or eval
    assert "frame-src https://www.youtube-nocookie.com" in csp
    assert "cross-origin-embedder-policy" not in r.headers  # only the game needs isolation
    play = requests.get(server_url + "/play.html", timeout=5)
    assert play.headers["cross-origin-embedder-policy"] == "require-corp"


# ── Greptile round on #29 ────────────────────────────────────────────────────


def test_live_header_count_survives_empty_and_back(page, server_url):
    rooms = {"list": [_room("KAZ12345", "Kaz")]}
    _mock(page, stats={"matches_this_week": None, "people_playing_now": 2})
    page.unroute("**/list")
    page.route("**/list", lambda r: r.fulfill(json=rooms["list"]))
    page.goto(server_url)
    expect(page.locator("#board-live")).to_have_text("2 people playing right now")
    refresh = "document.dispatchEvent(new Event('visibilitychange'))"
    rooms["list"] = []
    page.evaluate(refresh)
    expect(page.locator("#board")).to_have_attribute("data-state", "empty")
    rooms["list"] = [_room("KAZ12345", "Kaz")]
    page.evaluate(refresh)
    expect(page.locator("#board")).to_have_attribute("data-state", "live")
    expect(page.locator("#board-live")).to_have_text("2 people playing right now")


def test_focus_follows_the_same_action_when_a_row_changes(page, server_url):
    rooms = {"list": [_room("KAZ12345", "Kaz", players=2)]}
    _mock(page)
    page.unroute("**/list")
    page.route("**/list", lambda r: r.fulfill(json=rooms["list"]))
    page.goto(server_url)
    page.get_by_role("link", name="Join Kaz's room, needs your ROM").focus()
    rooms["list"] = [_room("KAZ12345", "Kaz", players=3)]  # someone joined: the row rebuilds
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.locator(".room .cnt")).to_have_text("3/4")
    assert page.evaluate("document.activeElement.dataset.act") == "join"


def test_stats_are_polled_less_often_than_the_list(page, server_url):
    calls = {"list": 0, "stats": 0}
    _mock(page)
    page.unroute("**/list")
    page.unroute("**/api/stats/public")

    def lst(r):
        calls["list"] += 1
        r.fulfill(json=[])

    def st(r):
        calls["stats"] += 1
        r.fulfill(json={"matches_this_week": None, "people_playing_now": 0})

    page.route("**/list", lst)
    page.route("**/api/stats/public", st)
    page.clock.install()
    page.goto(server_url)
    expect(page.locator("#board")).to_have_attribute("data-state", "empty")
    for _ in range(4):  # four regular 10 s polls
        page.clock.run_for(10_000)
        page.wait_for_timeout(100)
    assert calls["list"] >= 5 and calls["stats"] == 1


def test_index_html_gets_the_front_page_headers(server_url):
    import requests

    r = requests.get(server_url + "/index.html", timeout=5)
    assert "frame-src https://www.youtube-nocookie.com" in r.headers["content-security-policy"]
    assert "cross-origin-embedder-policy" not in r.headers


def test_stats_refetched_when_the_tab_comes_back_and_after_a_failure(page, server_url):
    calls = {"stats": 0}
    fail = {"on": True}
    _mock(page)
    page.unroute("**/api/stats/public")

    def st(r):
        calls["stats"] += 1
        if fail["on"]:
            r.fulfill(status=500)
        else:
            r.fulfill(json={"matches_this_week": None, "people_playing_now": 4})

    page.route("**/api/stats/public", st)
    page.goto(server_url)
    expect(page.locator("#board")).to_have_attribute("data-state", "empty")
    assert calls["stats"] == 1  # first poll, failed
    expect(page.locator("#board-week")).to_have_text("")  # absent, not stale
    fail["on"] = False
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")  # resumed: refetch
    page.wait_for_timeout(400)
    assert calls["stats"] == 2


def test_an_older_stats_answer_never_replaces_a_newer_count(page, server_url):
    held = []
    answers = iter([2, None, 5])  # None: hold this one and answer it last
    _mock(page, rooms=[_room("KAZ12345", "Kaz")])
    page.unroute("**/api/stats/public")

    def st(r):
        n = next(answers)
        if n is None:
            held.append(r)
        else:
            r.fulfill(json={"matches_this_week": None, "people_playing_now": n})

    page.route("**/api/stats/public", st)
    page.goto(server_url)
    expect(page.locator("#board-live")).to_have_text("2 people playing right now")
    refresh = "document.dispatchEvent(new Event('visibilitychange'))"
    page.evaluate(refresh)  # its stats request hangs
    page.wait_for_timeout(300)
    assert len(held) == 1
    page.evaluate(refresh)  # a newer refresh answers first
    expect(page.locator("#board-live")).to_have_text("5 people playing right now")
    held[0].fulfill(json={"matches_this_week": None, "people_playing_now": 9})
    page.wait_for_timeout(300)
    expect(page.locator("#board-live")).to_have_text("5 people playing right now")


# ── Review round 2 (Astra, Fable) ───────────────────────────────────────────

REFRESH = "document.dispatchEvent(new Event('visibilitychange'))"


def _live_list(page, server_url, rooms, stats=None):
    """Board whose /list answer the test can change between refreshes."""
    _mock(page, stats=stats)
    page.unroute("**/list")
    page.route("**/list", lambda r: r.fulfill(json=rooms["list"]))
    page.goto(server_url)
    expect(page.locator("#board")).not_to_have_attribute("data-state", "loading")


@pytest.mark.parametrize("width", [320, 390])
def test_long_host_name_keeps_actions_on_screen(browser, server_url, width):
    ctx = browser.new_context(viewport={"width": width, "height": 800})
    page = ctx.new_page()
    _mock(page, rooms=[_room("LONG1234", "A" * 24)])
    page.goto(server_url)
    expect(page.locator(".room")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth") <= width
    for act in ("join", "watch"):
        box = page.locator(f'.room [data-act="{act}"]').bounding_box()
        assert box["x"] >= 0 and box["x"] + box["width"] <= width, (act, box)
    ctx.close()


def test_focus_stays_with_the_room_when_the_featured_room_changes(page, server_url):
    rooms = {"list": [_room("ALICE123", "Alice", "playing", 2, started=_ago(300))]}
    _live_list(page, server_url, rooms)
    page.locator('#featured [data-act="join"]').focus()
    rooms["list"] = [
        _room("BOB12345", "Bob", "playing", 2, started=_ago(30)),  # newer, open slot: now featured
        _room("ALICE123", "Alice", "playing", 2, started=_ago(300)),
    ]
    page.evaluate(REFRESH)
    expect(page.locator("#featured h3")).to_be_visible()
    expect(page.locator("#featured .meta")).to_contain_text("Bob")
    assert page.evaluate("document.activeElement.dataset.act") == "join"
    assert page.evaluate("document.activeElement.closest('.room')?.dataset.code") == "ALICE123"


def test_focus_survives_a_room_above_it_leaving(page, server_url):
    rooms = {"list": [_room("FIRST123", "First"), _room("SECOND12", "Second"), _room("THIRD123", "Third")]}
    _live_list(page, server_url, rooms)
    page.get_by_role("link", name="Join Third's room, needs your ROM").focus()
    rooms["list"] = [_room("SECOND12", "Second"), _room("THIRD123", "Third")]
    page.evaluate(REFRESH)
    expect(page.locator(".room")).to_have_count(2)
    assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Join Third's room, needs your ROM"


def test_rollback_checkbox_toggles_from_the_keyboard(page, server_url):
    _mock(page, health=False)
    page.goto(server_url)
    expect(page.locator("#board")).to_have_attribute("data-state", "waking")
    page.locator("#rb").focus()
    page.keyboard.press("Space")
    expect(page.locator("#rb")).not_to_be_checked()
    expect(page.locator("#verdict")).to_have_text("240 ms wait per input")
    expect(page.locator("#v-in")).to_have_text("--")  # the checkbox got the key, not the visualizer


def test_empty_board_keeps_a_real_player_count(page, server_url):
    unlisted = {k: v for k, v in _room("HIDDEN12", "Hidden", "playing").items() if k != "room_code"}
    _mock(page, rooms=[unlisted], stats={"matches_this_week": None, "people_playing_now": 2})
    page.goto(server_url)
    expect(page.locator("#board")).to_have_attribute("data-state", "empty")
    expect(page.locator("#board-live")).to_have_text("2 people playing right now")


def test_empty_board_without_players_says_no_open_rooms(landing):
    page = landing()
    expect(page.locator("#board-live")).to_have_text("no open rooms right now")


def test_pressing_the_stick_mark_does_not_advance_it(landing):
    page = landing()
    for _ in range(8):
        if page.locator('#hdr-mark [data-mark="stick"]').count():
            break
        page.click("#name")
        page.wait_for_timeout(350)
    stick = page.locator('#hdr-mark [data-mark="stick"]')
    expect(stick).to_have_count(1)
    stick.click()
    page.wait_for_timeout(400)
    expect(page.locator('#hdr-mark [data-mark="stick"]')).to_have_count(1)


def test_offscreen_frames_are_replaced_not_stacked(browser, server_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 500})
    page = ctx.new_page()
    t = {"n": 1}

    def rooms():
        return [
            _room(
                f"ROOM{i:04d}", f"H{i}", "playing", 2, started=_ago(60), frame=f"/room/ROOM{i:04d}/frame.jpg?t={t['n']}"
            )
            for i in range(6)
        ]

    _mock(page)
    page.unroute("**/list")
    page.route("**/list", lambda r: r.fulfill(json=rooms()))
    held = []  # frames that never answer, like a lazy image that never loads
    page.unroute("**/room/*/frame.jpg*")
    page.route("**/room/*/frame.jpg*", lambda r: held.append(r))
    page.goto(server_url)
    expect(page.locator(".room")).to_have_count(6)
    for n in range(2, 8):
        t["n"] = n
        page.evaluate(REFRESH)
        page.wait_for_timeout(150)
    counts = page.evaluate("[...document.querySelectorAll('.room .thumb')].map(b => b.querySelectorAll('img').length)")
    assert max(counts) <= 1, counts  # the pending frame is replaced each poll, never stacked
    ctx.close()


def test_no_live_badge_without_a_frame(landing):
    page = landing(
        rooms=[_room("KAZ12345", "Kaz", "playing", 2, started=_ago(60), frame="/room/KAZ12345/frame.jpg?t=1")]
    )
    page.wait_for_timeout(300)  # the frame 404s
    assert page.locator(".thumb.live, .screen-box.live").count() == 0


def test_a_bad_list_answer_does_not_stop_the_board(page, server_url):
    rooms = {"list": {"unexpected": "shape"}}
    _live_list(page, server_url, rooms)
    assert _state(page) == "empty"
    rooms["list"] = [_room("KAZ12345", "Kaz")]
    page.evaluate(REFRESH)
    expect(page.locator("#board")).to_have_attribute("data-state", "live")


def test_back_navigation_re_enables_create(landing):
    page = landing()
    page.evaluate("document.getElementById('create-btn').disabled = true")  # as go() leaves it
    page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))")
    expect(page.locator("#create-btn")).to_be_enabled()
