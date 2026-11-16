"""The ROM library against a real browser's IndexedDB.

web/src/play/rom-library.ts keeps loaded ROMs in IndexedDB. Node has none, so
its unit tests cover only the markup and the no-database path; these run the
storage itself in Chromium, including the upgrade from the version-1 layout
(a single ROM under the key `current`).

Run: pytest tests/test_rom_library_e2e.py -v   (needs the server running)
"""

HASH_A = "S" + "ab" * 32
HASH_B = "S" + "cd" * 32


def _page_with_core(browser, server_url):
    """A same-origin page that is not the play page (which opens the library itself)."""
    page = browser.new_page()
    page.goto(f"{server_url}/privacy.html")
    page.add_script_tag(url="/static/dist/kn-core.js")
    page.wait_for_function("window.KNCore && window.KNCore.play")
    return page


def test_store_list_touch_verify_and_remove(browser, server_url):
    page = _page_with_core(browser, server_url)
    try:
        result = page.evaluate(
            """async ([a, b]) => {
                const { openRomLibrary, newStoredRom } = window.KNCore.play;
                const library = openRomLibrary({ name: null, hash: null });
                const known = { [a]: { game: 'Super Smash Bros.' } };
                const bytes = (n) => new Uint8Array(n).fill(7).buffer;
                await library.put(a, newStoredRom(bytes(4096), a, 'smash.z64', 'local', {}, 100));
                await library.put(b, newStoredRom(bytes(2048), b, 'other.z64', 'p2p', {}, 200));
                const first = await library.list();
                const got = await library.get(a);
                await library.touch(a, 300);
                const afterTouch = await library.list();
                const changed = await library.verifyAgainst(known);
                const changedAgain = await library.verifyAgainst(known);
                const afterVerify = await library.list();
                await library.remove(b);
                const afterRemove = await library.list();
                return {
                    first: first.map((e) => [e.hash, e.name, e.size, e.source, e.verified]),
                    hasBlobInList: first.some((e) => 'blob' in e),
                    gotBytes: got && got.blob.byteLength,
                    gotFirstByte: got && new Uint8Array(got.blob)[0],
                    missing: await library.get('S' + 'ef'.repeat(32)),
                    afterTouch: afterTouch.map((e) => e.hash),
                    changed, changedAgain,
                    verified: afterVerify.find((e) => e.hash === a),
                    afterRemove: afterRemove.map((e) => e.hash),
                };
            }""",
            [HASH_A, HASH_B],
        )
        # Most recently used first; rows carry no bytes.
        assert result["first"] == [
            [HASH_B, "other.z64", 2048, "p2p", False],
            [HASH_A, "smash.z64", 4096, "local", False],
        ]
        assert result["hasBlobInList"] is False
        assert result["gotBytes"] == 4096 and result["gotFirstByte"] == 7
        assert result["missing"] is None
        assert result["afterTouch"] == [HASH_A, HASH_B]
        # Verifying renames the ROM to the game and reports a change once.
        assert result["changed"] is True and result["changedAgain"] is False
        assert result["verified"]["verified"] is True
        assert result["verified"]["name"] == "Super Smash Bros."
        assert result["verified"]["gameName"] == "Super Smash Bros."
        assert result["afterRemove"] == [HASH_A]
    finally:
        page.close()


_MAKE_V1 = """(bytes) => new Promise((resolve, reject) => {
    const open = indexedDB.open('kaillera-rom-cache', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('roms');
    open.onsuccess = () => {
        const tx = open.result.transaction('roms', 'readwrite');
        tx.objectStore('roms').put(new Uint8Array(bytes).fill(9).buffer, 'current');
        tx.oncomplete = () => { open.result.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
})"""


def test_a_version_1_library_is_carried_over_under_its_hash(browser, server_url):
    page = _page_with_core(browser, server_url)
    try:
        page.evaluate(_MAKE_V1, 1024)
        result = page.evaluate(
            """async (hash) => {
                const library = window.KNCore.play.openRomLibrary({ name: 'Old ROM.z64', hash });
                const entries = await library.list();
                const got = await library.get(hash);
                return { entries, bytes: got && got.blob.byteLength, current: await library.get('current') };
            }""",
            HASH_A,
        )
        assert [(e["hash"], e["name"], e["size"], e["source"], e["verified"]) for e in result["entries"]] == [
            (HASH_A, "Old ROM.z64", 1024, "local", False)
        ]
        assert result["bytes"] == 1024
        assert result["current"] is None
    finally:
        page.close()


def test_a_version_1_rom_with_no_remembered_hash_is_dropped(browser, server_url):
    page = _page_with_core(browser, server_url)
    try:
        page.evaluate(_MAKE_V1, 512)
        entries = page.evaluate("() => window.KNCore.play.openRomLibrary({ name: null, hash: null }).list()")
        assert entries == []
    finally:
        page.close()
