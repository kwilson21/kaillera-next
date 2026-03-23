"""RDRAM scanner — maps which memory regions change in each SSB64 game state.

Boots EmulatorJS with SSB64 ROM, navigates through game states via
simulated input, and scans RDRAM at each state to find stable vs
volatile regions. Results used to build state-aware desync detection.

Run: python tests/scan_rdram.py
Requires: dev server running at localhost:8000, ROM file available.
"""

import json
import time
from playwright.sync_api import sync_playwright

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"
SERVER = "http://localhost:8000"

# SSB64 key mappings from shared.js DEFAULT_N64_KEYMAP
KEYS = {
    'A': 'c',       # C key → A button
    'B': 'x',       # X key → B button
    'Start': 'v',   # V key → Start
    'Up': 'ArrowUp',
    'Down': 'ArrowDown',
    'Left': 'ArrowLeft',
    'Right': 'ArrowRight',
    'L': 't',
    'R': 'y',
    'Z': 'z',
    'StickUp': 'w',
    'StickDown': 's',
    'StickLeft': 'a',
    'StickRight': 'd',
}


def press(page, key, hold_ms=100):
    """Press an N64 button via keyboard."""
    k = KEYS.get(key, key)
    page.keyboard.down(k)
    time.sleep(hold_ms / 1000)
    page.keyboard.up(k)
    time.sleep(0.05)


def press_repeat(page, key, times, hold_ms=100, gap_ms=200):
    """Press a button multiple times."""
    for _ in range(times):
        press(page, key, hold_ms)
        time.sleep(gap_ms / 1000)


def wait_frames(page, n=60):
    """Wait for approximately n frames (~n/60 seconds)."""
    time.sleep(n / 60)


def scan_rdram(page, label):
    """Scan RDRAM in 64KB chunks, return dict of chunk_offset -> hash."""
    result = page.evaluate("""
        (function() {
            var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                      window.EJS_emulator.gameManager.Module;
            if (!mod || !mod.HEAPU8) return { error: 'no module' };

            // Get RDRAM pointer
            var ptr = 0, size = 0;
            if (mod.cwrap) {
                try {
                    var getMemData = mod.cwrap('get_memory_data', 'string', ['string']);
                    var result = getMemData('RETRO_MEMORY_SYSTEM_RAM');
                    if (result) {
                        var parts = result.split('|');
                        size = parseInt(parts[0], 10);
                        ptr = parseInt(parts[1], 10);
                    }
                } catch(e) { return { error: 'cwrap failed: ' + e.message }; }
            }
            if (!ptr || !size) return { error: 'no RDRAM pointer' };

            // Read via fresh buffer view
            var buf = mod.HEAPU8.buffer;
            if (!buf || buf.byteLength === 0) return { error: 'buffer detached' };
            var live = new Uint8Array(buf);

            // FNV-1a hash each 4KB chunk across the 8MB RDRAM (2048 chunks)
            var chunkSize = 4096;
            var numChunks = Math.floor(size / chunkSize);
            var hashes = {};
            for (var i = 0; i < numChunks; i++) {
                var off = ptr + i * chunkSize;
                var h = 0x811c9dc5;
                for (var j = 0; j < chunkSize; j++) {
                    h ^= live[off + j];
                    h = Math.imul(h, 0x01000193);
                }
                hashes[i * chunkSize] = h | 0;
            }
            return { ptr: ptr, size: size, chunks: numChunks, hashes: hashes };
        })()
    """)
    if 'error' in result:
        print(f"  [{label}] RDRAM scan error: {result['error']}")
        return None
    print(f"  [{label}] RDRAM: ptr={result['ptr']}, size={result['size']}, chunks={result['chunks']}")
    return result['hashes']


def compare_scans(scan1, scan2):
    """Return list of chunk offsets that differ between two scans."""
    if not scan1 or not scan2:
        return []
    changed = []
    for key in scan1:
        if scan1.get(key) != scan2.get(key):
            changed.append(int(key))
    return sorted(changed)


def find_stable_regions(scans):
    """Given multiple scans, find chunks that NEVER changed."""
    if len(scans) < 2:
        return []
    all_keys = set(scans[0].keys())
    changed_ever = set()
    for i in range(1, len(scans)):
        for key in all_keys:
            if scans[0].get(key) != scans[i].get(key):
                changed_ever.add(key)
    stable = sorted([int(k) for k in all_keys - changed_ever])
    return stable


def find_volatile_regions(scans):
    """Given multiple scans, find chunks that changed between ANY consecutive pair."""
    if len(scans) < 2:
        return []
    changed_ever = set()
    for i in range(1, len(scans)):
        diff = compare_scans(scans[i-1], scans[i])
        for d in diff:
            changed_ever.add(d)
    return sorted(changed_ever)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)  # headed so we can see what's happening
        page = browser.new_page()

        # Load the game
        print("=== Loading game ===")
        page.goto(f"{SERVER}/play.html?room=SCAN01&host=1&name=Scanner")
        page.wait_for_selector('#overlay', state='visible', timeout=15000)

        # Load ROM and boot emulator directly (bypass multiplayer flow)
        page.evaluate("""
            (function() {
                // Create a file input, load the ROM, and boot EmulatorJS
                var input = document.createElement('input');
                input.type = 'file';
                input.style.display = 'none';
                document.body.appendChild(input);
                window._scanFileInput = input;
            })()
        """)

        # Set ROM via file chooser on our hidden input, then boot
        with page.expect_file_chooser() as fc:
            page.evaluate("window._scanFileInput.click()")
        fc.value.set_files(ROM_PATH)

        # Read the file and boot EmulatorJS directly
        page.evaluate("""
            (async function() {
                var input = window._scanFileInput;
                var file = input.files[0];
                if (!file) return;
                var url = URL.createObjectURL(file);
                window.EJS_gameUrl = url;

                // Hide the overlay so emulator can render
                var overlay = document.getElementById('overlay');
                if (overlay) overlay.classList.add('hidden');

                // Boot EmulatorJS
                if (typeof EmulatorJS === 'function') {
                    window.EJS_emulator = new EmulatorJS(
                        window.EJS_player || '#game',
                        { gameUrl: url, core: 'n64',
                          pathtodata: window.EJS_pathtodata || 'https://cdn.emulatorjs.org/stable/data/',
                          startOnLoaded: true }
                    );
                } else {
                    // Inject the loader script
                    var script = document.createElement('script');
                    script.src = window.EJS_pathtodata + 'loader.js';
                    document.body.appendChild(script);
                }
            })()
        """)

        # Wait for emulator to boot
        print("Waiting for emulator to boot...")
        page.wait_for_function(
            "window.EJS_emulator && window.EJS_emulator.gameManager && "
            "window.EJS_emulator.gameManager.Module && "
            "window.EJS_emulator.gameManager.Module.HEAPU8",
            timeout=60000,
        )
        # Give the game time to reach the title screen
        print("Emulator booted, waiting for title screen...")
        time.sleep(8)

        # ── STATE 1: Title Screen ──────────────────────────────────
        print("\n=== STATE: Title Screen ===")
        title_scans = []
        for i in range(3):
            title_scans.append(scan_rdram(page, f"title-{i}"))
            wait_frames(page, 30)

        title_volatile = find_volatile_regions(title_scans)
        title_stable = find_stable_regions(title_scans)
        print(f"  Volatile chunks: {len(title_volatile)} ({len(title_volatile)*4}KB)")
        print(f"  Stable chunks: {len(title_stable)} ({len(title_stable)*4}KB)")
        if title_volatile:
            print(f"  Volatile offsets (first 20): {[hex(x) for x in title_volatile[:20]]}")

        # ── Navigate: Title → Main Menu (press Start) ─────────────
        print("\n=== Navigating: Title → Main Menu ===")
        press(page, 'Start')
        time.sleep(1)

        # ── STATE 2: Main Menu ─────────────────────────────────────
        print("\n=== STATE: Main Menu ===")
        menu_scans = []
        for i in range(3):
            menu_scans.append(scan_rdram(page, f"menu-{i}"))
            wait_frames(page, 30)

        menu_volatile = find_volatile_regions(menu_scans)
        menu_stable = find_stable_regions(menu_scans)
        print(f"  Volatile chunks: {len(menu_volatile)} ({len(menu_volatile)*4}KB)")
        print(f"  Stable chunks: {len(menu_stable)} ({len(menu_stable)*4}KB)")

        # ── Navigate: Main Menu → VS Mode (Down, Down, A) ─────────
        print("\n=== Navigating: Main Menu → VS Mode ===")
        press(page, 'StickDown')
        time.sleep(0.3)
        press(page, 'A')
        time.sleep(1)

        # ── STATE 3: Character Select ──────────────────────────────
        print("\n=== STATE: Character Select ===")
        charsel_scans = []
        for i in range(3):
            charsel_scans.append(scan_rdram(page, f"charsel-{i}"))
            wait_frames(page, 30)

        charsel_volatile = find_volatile_regions(charsel_scans)
        charsel_stable = find_stable_regions(charsel_scans)
        print(f"  Volatile chunks: {len(charsel_volatile)} ({len(charsel_volatile)*4}KB)")
        print(f"  Stable chunks: {len(charsel_stable)} ({len(charsel_stable)*4}KB)")

        # ── Navigate: Select a character (A) and start ─────────────
        print("\n=== Navigating: Character Select → Stage Select ===")
        press(page, 'A')  # Pick default character
        time.sleep(0.5)
        press(page, 'Start')  # Confirm / go to stage select
        time.sleep(1)

        # ── STATE 4: Stage Select ──────────────────────────────────
        print("\n=== STATE: Stage Select ===")
        stagesel_scans = []
        for i in range(3):
            stagesel_scans.append(scan_rdram(page, f"stagesel-{i}"))
            wait_frames(page, 30)

        stagesel_volatile = find_volatile_regions(stagesel_scans)
        stagesel_stable = find_stable_regions(stagesel_scans)
        print(f"  Volatile chunks: {len(stagesel_volatile)} ({len(stagesel_volatile)*4}KB)")
        print(f"  Stable chunks: {len(stagesel_stable)} ({len(stagesel_stable)*4}KB)")

        # ── Navigate: Select a stage (A) ───────────────────────────
        print("\n=== Navigating: Stage Select → In Match ===")
        press(page, 'A')  # Pick default stage
        time.sleep(3)  # Wait for stage to load

        # ── STATE 5: In Match ──────────────────────────────────────
        print("\n=== STATE: In Match ===")
        match_scans = []
        for i in range(5):
            match_scans.append(scan_rdram(page, f"match-{i}"))
            wait_frames(page, 60)  # 1 second between scans

        match_volatile = find_volatile_regions(match_scans)
        match_stable = find_stable_regions(match_scans)
        print(f"  Volatile chunks: {len(match_volatile)} ({len(match_volatile)*4}KB)")
        print(f"  Stable chunks: {len(match_stable)} ({len(match_stable)*4}KB)")
        if match_volatile:
            print(f"  Volatile offsets (first 30): {[hex(x) for x in match_volatile[:30]]}")

        # ── Find the "game state indicator" ────────────────────────
        # Compare title scan vs menu scan vs match scan to find bytes
        # that are DIFFERENT between states but STABLE within a state.
        print("\n=== Finding Game State Indicator ===")
        if title_scans[0] and menu_scans[0] and match_scans[0]:
            # Chunks that differ between title and menu
            title_to_menu = compare_scans(title_scans[0], menu_scans[0])
            # Chunks that differ between menu and match
            menu_to_match = compare_scans(menu_scans[0], match_scans[0])
            # Chunks that change on state transitions but are stable WITHIN a state
            transition_chunks = set(title_to_menu) & set(menu_to_match)
            # Filter: must be stable within both title AND menu AND match
            state_indicator_candidates = []
            for chunk_off in transition_chunks:
                key = str(chunk_off)
                # Check stable within each state
                title_ok = all(s.get(key) == title_scans[0].get(key) for s in title_scans if s)
                menu_ok = all(s.get(key) == menu_scans[0].get(key) for s in menu_scans if s)
                match_ok = all(s.get(key) == match_scans[0].get(key) for s in match_scans if s)
                if title_ok and menu_ok and match_ok:
                    state_indicator_candidates.append(chunk_off)

            state_indicator_candidates.sort()
            print(f"  Chunks that change between states but stable within: {len(state_indicator_candidates)}")
            print(f"  Candidates: {[hex(x) for x in state_indicator_candidates[:30]]}")

            # For each candidate, read the actual byte values in each state
            # to find the one that has distinct values per state
            if state_indicator_candidates:
                print("\n=== Sampling state indicator candidates ===")
                for chunk_off in state_indicator_candidates[:10]:
                    values = page.evaluate(f"""
                        (function() {{
                            // We can only read current state, but we stored hashes
                            return {{ offset: '0x' + ({chunk_off}).toString(16) }};
                        }})()
                    """)
                    # Read actual bytes at this offset
                    bytes_hex = page.evaluate(f"""
                        (function() {{
                            var mod = window.EJS_emulator.gameManager.Module;
                            var buf = mod.HEAPU8.buffer;
                            var live = new Uint8Array(buf);
                            var getMemData = mod.cwrap('get_memory_data', 'string', ['string']);
                            var result = getMemData('RETRO_MEMORY_SYSTEM_RAM');
                            var parts = result.split('|');
                            var ptr = parseInt(parts[1], 10);
                            var off = ptr + {chunk_off};
                            var bytes = [];
                            for (var i = 0; i < 32; i++) bytes.push(live[off + i].toString(16).padStart(2, '0'));
                            return bytes.join(' ');
                        }})()
                    """)
                    print(f"  {hex(chunk_off)}: {bytes_hex}")

        # ── Summary ────────────────────────────────────────────────
        print("\n" + "=" * 60)
        print("=== RDRAM REGION SUMMARY ===")
        print("=" * 60)

        all_states = {
            'title': (title_volatile, title_stable),
            'menu': (menu_volatile, menu_stable),
            'charsel': (charsel_volatile, charsel_stable),
            'stagesel': (stagesel_volatile, stagesel_stable),
            'match': (match_volatile, match_stable),
        }

        # Find regions stable across ALL states
        all_stable = None
        for name, (vol, stab) in all_states.items():
            s = set(str(x) for x in stab)
            if all_stable is None:
                all_stable = s
            else:
                all_stable &= s
        print(f"\nStable across ALL states: {len(all_stable)} chunks ({len(all_stable)*4}KB)")

        # Find regions volatile in match but stable in menus (gameplay data)
        match_only_volatile = set(match_volatile) - set(menu_volatile) - set(title_volatile)
        print(f"Volatile ONLY during match: {len(match_only_volatile)} chunks ({len(match_only_volatile)*4}KB)")
        if match_only_volatile:
            sorted_mov = sorted(match_only_volatile)
            print(f"  Offsets: {[hex(x) for x in sorted_mov[:30]]}")

        # Save full results to file
        output = {
            'states': {},
            'state_indicators': [hex(x) for x in state_indicator_candidates] if 'state_indicator_candidates' in dir() else [],
        }
        for name, (vol, stab) in all_states.items():
            output['states'][name] = {
                'volatile': [hex(x) for x in vol],
                'stable_count': len(stab),
            }
        with open('logs/rdram_scan.json', 'w') as f:
            json.dump(output, f, indent=2)
        print(f"\nFull results saved to logs/rdram_scan.json")

        browser.close()


if __name__ == '__main__':
    main()
