"""Test pre-game ROM preloading via WebRTC.

Validates that when the host enables ROM sharing and a guest accepts,
the ROM transfer starts immediately (pre-game) instead of waiting
for the host to click "Start Game".

Run: pytest tests/test_rom_preload.py -v -s
"""

from playwright.sync_api import expect


ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def test_rom_preload_before_game_start(browser, server_url):
    """ROM transfers immediately when guest accepts sharing, before game starts."""
    host = browser.new_page()
    guest = browser.new_page()

    guest_logs = []
    host_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))
    host.on("console", lambda msg: host_logs.append(msg.text))

    try:
        # Host creates room, loads ROM, enables sharing
        host.goto(f"{server_url}/play.html?room=PRELOAD1&host=1&name=Host&mode=lockstep")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        host.wait_for_timeout(500)
        assert host.evaluate("document.getElementById('rom-drop').classList.contains('loaded')")
        rom_share_cb = host.locator("#opt-rom-sharing")
        expect(rom_share_cb).to_be_enabled(timeout=5000)
        rom_share_cb.check()
        host.wait_for_timeout(300)

        # Guest joins, sees sharing prompt, accepts
        guest.goto(f"{server_url}/play.html?room=PRELOAD1&name=Guest")
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        guest.click("#rom-accept-btn")

        # ROM transfer should complete pre-game (drop zone shows loaded)
        expect(guest.locator("#rom-drop.loaded")).to_be_visible(timeout=30000)

        # Still in pre-game — overlay visible, no toolbar
        expect(guest.locator("#overlay")).to_be_visible()
        expect(guest.locator("#toolbar")).to_be_hidden()

        # ROM status shows "from host"
        rom_status = guest.locator("#rom-status").text_content()
        assert "from host" in rom_status

        # Confirm pre-game path was used (not the old post-start path)
        assert any("accepted pre-game" in l for l in guest_logs)
        assert any("pre-game" in l for l in host_logs)

        # Start game — should proceed immediately (ROM already cached)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=5000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

    finally:
        host.close()
        guest.close()
