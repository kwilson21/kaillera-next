"""The standard SSB64 cheats hold on both pages of a game, and setting them
never traps.

The cheats (KNShared.SSB64_ONLINE_CHEATS: stock mode, 5 stocks, items off and
so on) are GameShark codes the core writes into RDRAM at every VI. A page
that set them before its core had opened the ROM trapped ("cheat application
failed: memory access out of bounds"), because the core sets up its cheat
list only then. Each page sets them again after the state load that starts
the game, so both run the same cheats from the first synced frame; this reads
every cheat's address on both pages to show it.

The core writes an 80 code as one byte at `address ^ 3` of its RDRAM and an 81
code as a little-endian halfword at `address ^ 2` (mupen64plus-core
src/main/cheat.c, update_address_8bit/16bit); the reads below do the same.

Needs the SSB64 (USA) ROM: KN_ROM=/path/ssb64-us.z64 pytest tests/test_standard_cheats.py
"""

import pytest
from netplay_steps import wait_past_frame

_READ_CHEATS = """() => {
    const mod = window.EJS_emulator.gameManager.Module;
    const dram = mod._kn_get_rdram_ptr();
    const read = [];
    for (const cheat of window.KNShared.SSB64_ONLINE_CHEATS) {
        for (const part of cheat.code.split('+')) {
            const [where, value] = part.trim().split(/\\s+/);
            const type = where.slice(0, 2);
            const address = parseInt(where.slice(2), 16);
            const want = parseInt(value, 16);
            if (type === '80') {
                read.push({ code: part, want: want & 0xff, got: mod.HEAPU8[dram + (address ^ 3)] });
            } else if (type === '81') {
                const at = dram + (address ^ 2);
                read.push({ code: part, want, got: mod.HEAPU8[at] | (mod.HEAPU8[at + 1] << 8) });
            } else {
                read.push({ code: part, want: null, got: null });
            }
        }
    }
    return read;
}"""


def test_standard_cheats_hold_on_both_pages(browser, server_url, rom_path, start_game, room):
    host = browser.new_page()
    guest = browser.new_page()
    errors = []
    for name, page in (("host", host), ("guest", guest)):
        page.on(
            "console",
            lambda msg, name=name: errors.append(f"{name}: {msg.text}")
            if msg.type == "error" and "cheat" in msg.text
            else None,
        )

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        host.wait_for_selector("#overlay", timeout=10000)
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)
        for page in (host, guest):
            page.set_input_files("#rom-drop input[type=file]", rom_path)

        start_game(host, guest)
        if host.evaluate("window.KNState.romHash") != host.evaluate("window.KNShared.SSB64_HASH"):
            pytest.skip("KN_ROM is not the SSB64 (USA) ROM, the one the standard cheats are for")
        wait_past_frame(host, 90)
        wait_past_frame(guest, 90)

        host_read = host.evaluate(_READ_CHEATS)
        guest_read = guest.evaluate(_READ_CHEATS)
        for name, read in (("host", host_read), ("guest", guest_read)):
            print(f"\n  {name}: " + ", ".join(f"{r['code']}={r['got']:#x}" for r in read))
            wrong = [r for r in read if r["got"] != r["want"]]
            assert not wrong, f"{name}: cheats not in force: {wrong}"
        assert [r["got"] for r in host_read] == [r["got"] for r in guest_read]
        assert not errors, f"setting or clearing the cheats failed: {errors}"
    finally:
        host.close()
        guest.close()
