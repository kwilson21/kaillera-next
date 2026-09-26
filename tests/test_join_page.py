"""Invite page (/join, docs/landing-design.md §7.2 M2, W3): every state with
mocked /health and /room/{code} answers."""

import pytest
from playwright.sync_api import expect


def _room(host="Kaz", players=2, max_players=4, status="lobby", game_id="ssb64", closed=False):
    return {
        "room_code": "KAZ12345",
        "host_name": host,
        "player_count": players,
        "max_players": max_players,
        "spectator_count": 0,
        "status": status,
        "game_id": game_id,
        "closed": closed,
    }


def _mock(page, room=None, health=True):
    page.route("**/health", lambda r: r.fulfill(json={"status": "ok"}) if health else r.abort())
    page.route(
        "**/room/*",
        lambda r: r.fulfill(json=room) if room is not None else r.fulfill(status=404, json={"error": "not found"}),
    )


@pytest.fixture
def invite(page, server_url):
    def go(query="?room=KAZ12345", **kw):
        _mock(page, **kw)
        page.goto(f"{server_url}/join{query}")
        expect(page.locator("#inv-loading")).to_be_hidden()
        return page

    return go


def _visible(page):
    return [
        s for s in ("inv-main", "inv-closed", "inv-unsupported", "inv-waking") if page.locator(f"#{s}").is_visible()
    ]


def test_waiting_room_leads_with_join(invite):
    page = invite(room=_room())
    assert _visible(page) == ["inv-main"]
    expect(page.locator("#inv-kicker")).to_have_text("Kaz invited you to play")
    expect(page.locator("#inv-title")).to_have_text("Super Smash Bros. 64")
    expect(page.locator("#inv-facts")).to_contain_text("2 of 4 in the room · waiting for players")
    join = page.locator("#inv-join")
    expect(join).to_have_text("Join the room")
    expect(join).to_have_class("btn primary big")
    assert join.get_attribute("href").endswith("/play.html?room=KAZ12345")
    watch = page.locator("#inv-watch")
    expect(watch).to_have_text("Watch instead")
    assert watch.get_attribute("href").endswith("/play.html?room=KAZ12345&spectate=1")
    expect(page.locator("#inv-join-hint")).to_have_text("needs your own SSB64 ROM (.z64 / .n64 / .v64 / .zip)")
    expect(page.locator("#inv-watch-hint")).to_have_text("no ROM needed")
    expect(page.locator("#inv-next")).to_contain_text("wait for Kaz to press Start")
    first = page.locator("#inv-stack > *").first
    expect(first).to_have_id("inv-join")
    assert page.title() == "Kaz invited you to play · kaillera-next"


def test_full_room_leads_with_watch(invite):
    page = invite(room=_room(players=4))
    expect(page.locator("#inv-fullline")).to_be_visible()
    expect(page.locator("#inv-facts")).to_contain_text("4 of 4 in the room · full")
    expect(page.locator("#inv-join")).to_have_text("Join when a slot opens")
    expect(page.locator("#inv-watch")).to_have_text("Watch")
    expect(page.locator("#inv-watch")).to_have_class("btn primary big")
    expect(page.locator("#inv-stack > *").first).to_have_id("inv-watch")


def test_match_in_progress_says_you_join_mid_match(invite):
    page = invite(room=_room(status="playing", game_id="smash-remix"))
    expect(page.locator("#inv-title")).to_have_text("Smash Remix")
    expect(page.locator("#inv-facts")).to_contain_text("in game")
    expect(page.locator("#inv-join-hint")).to_contain_text("Smash Remix ROM")
    expect(page.locator("#inv-next")).to_contain_text("you join Kaz's match in progress")


def test_spectator_link(invite):
    page = invite("?room=KAZ12345&spectate=1", room=_room())
    expect(page.locator("#inv-kicker")).to_have_text("Watch Kaz's room")
    expect(page.locator("#inv-stack > *").first).to_have_id("inv-watch")
    expect(page.locator("#inv-join")).to_have_text("Join if a slot opens · needs your ROM")
    expect(page.locator("#inv-fullline")).to_be_hidden()
    expect(page.locator("#inv-next")).to_contain_text("you'll see the game as it plays")


def test_closed_room_names_the_host(invite):
    page = invite(room=_room(closed=True))
    assert _visible(page) == ["inv-closed"]
    expect(page.locator("#closed-title")).to_have_text("Kaz's room has closed.")
    expect(page.locator("#closed-line")).to_contain_text("Ask Kaz for a new link")
    page.locator("#open-own").click()
    page.wait_for_url("**/play.html?room=*&host=1&mode=rollback")


def test_unknown_room_is_closed_without_a_name(invite):
    page = invite(room=None)
    expect(page.locator("#closed-title")).to_have_text("This room has closed.")


def test_missing_code_is_closed_without_asking_the_server(page, server_url):
    calls = []
    page.route("**/room/*", lambda r: (calls.append(r.request.url), r.fulfill(status=404)))
    page.goto(f"{server_url}/join")
    expect(page.locator("#closed-title")).to_have_text("This room has closed.")
    assert calls == []


def test_host_name_is_text_not_html(invite):
    page = invite(room=_room(host='<img src=x onerror="window.pwned=1">'))
    expect(page.locator("#inv-kicker")).to_contain_text("<img")
    assert page.locator("#inv-main img").count() == 0


def test_waking_then_the_room(page, server_url):
    up = {"on": False}
    page.route("**/health", lambda r: r.fulfill(json={"status": "ok"}) if up["on"] else r.abort())
    page.route("**/room/*", lambda r: r.fulfill(json=_room()))
    page.goto(f"{server_url}/join?room=KAZ12345")
    expect(page.locator("#inv-waking")).to_be_visible()
    expect(page.locator("#inv-waking")).to_have_attribute("role", "status")
    page.locator("#viz").focus()
    page.keyboard.press("Space")
    expect(page.locator("#v-in")).not_to_have_text("--")
    up["on"] = True
    expect(page.locator("#inv-main")).to_be_visible(timeout=10000)
    expect(page.locator("#inv-waking")).to_be_hidden()


def test_in_app_browser_banner(browser, server_url):
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Discord/231.0"
    )
    page = ctx.new_page()
    _mock(page, room=_room())
    page.goto(f"{server_url}/join?room=KAZ12345")
    expect(page.locator("#inapp")).to_be_visible()
    expect(page.locator("#inapp-text")).to_contain_text("Discord's built-in browser")
    expect(page.locator("#inv-main")).to_be_visible()  # the invite still works underneath
    ctx.close()


def test_no_banner_in_a_normal_browser(invite):
    page = invite(room=_room())
    expect(page.locator("#inapp")).to_be_hidden()


def test_room_updates_while_open(page, server_url):
    room = _room()
    page.route("**/health", lambda r: r.fulfill(json={"status": "ok"}))
    page.route("**/room/*", lambda r: r.fulfill(json=room))
    page.clock.install()
    page.goto(f"{server_url}/join?room=KAZ12345")
    expect(page.locator("#inv-facts")).to_contain_text("2 of 4")
    room["player_count"] = 4
    page.clock.run_for(16000)
    expect(page.locator("#inv-facts")).to_contain_text("4 of 4 in the room · full")
    expect(page.locator("#inv-stack > *").first).to_have_id("inv-watch")


def test_room_invite_links_point_at_the_invite_page(browser, server_url, room):
    ctx = browser.new_context()
    ctx.add_init_script(
        "window.__copied = [];"
        "Object.defineProperty(navigator, 'share', { value: undefined });"
        "Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => window.__copied.push(t) } });"
    )
    host = ctx.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
    host.locator("#copy-link").click()
    host.locator("#kn-invite-dropdown .share-option", has_text="Play").click()
    host.locator("#copy-link").click()
    host.locator("#kn-invite-dropdown .share-option", has_text="Watch").click()
    host.wait_for_timeout(300)
    assert host.evaluate("window.__copied") == [
        f"{server_url}/join?room={room}",
        f"{server_url}/join?room={room}&spectate=1",
    ]
    ctx.close()
