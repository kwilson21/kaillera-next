"""Visual RDRAM scanner — uses screenshots to navigate SSB64 game states.

Run step by step: each step takes a screenshot, scans RDRAM, and waits.
The caller (Claude) reads screenshots to decide navigation.

Usage:
  from scan_rdram_visual import Scanner
  s = Scanner()
  s.boot()          # Boot emulator, return screenshot path
  s.screenshot()    # Take screenshot
  s.press('A')      # Press button
  s.scan('label')   # Scan RDRAM, return hashes
  s.close()
"""

import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"
SERVER = "http://localhost:8000"
SCREENSHOT_DIR = Path("/Users/kazon/kaillera-next/logs/screenshots")

KEYS = {
    'A': 'c', 'B': 'x', 'Start': 'v',
    'Up': 'ArrowUp', 'Down': 'ArrowDown',
    'Left': 'ArrowLeft', 'Right': 'ArrowRight',
    'L': 't', 'R': 'y', 'Z': 'z',
    'StickUp': 'w', 'StickDown': 's',
    'StickLeft': 'a', 'StickRight': 'd',
    'CUp': 'i', 'CDown': 'k', 'CLeft': 'j', 'CRight': 'l',
}


class Scanner:
    def __init__(self):
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._page = self._browser.new_page(viewport={'width': 640, 'height': 480})
        self._step = 0
        self._scans = {}

    def boot(self):
        """Boot EmulatorJS with SSB64 ROM. Returns screenshot path."""
        page = self._page
        page.goto(f"{SERVER}/play.html?room=SCAN99&host=1&name=Scanner",
                  wait_until="networkidle")

        # Load ROM via hidden file input
        page.evaluate("""
            var input = document.createElement('input');
            input.type = 'file'; input.style.display = 'none';
            document.body.appendChild(input);
            window._scanInput = input;
        """)
        with page.expect_file_chooser() as fc:
            page.evaluate("window._scanInput.click()")
        fc.value.set_files(ROM_PATH)

        # Boot emulator directly
        page.evaluate("""
            (async function() {
                var input = window._scanInput;
                var file = input.files[0];
                if (!file) return;
                var url = URL.createObjectURL(file);
                window.EJS_gameUrl = url;
                var overlay = document.getElementById('overlay');
                if (overlay) overlay.classList.add('hidden');
                if (typeof EmulatorJS === 'function') {
                    window.EJS_emulator = new EmulatorJS('#game', {
                        gameUrl: url, core: 'n64',
                        pathtodata: window.EJS_pathtodata,
                        startOnLoaded: true
                    });
                } else {
                    var script = document.createElement('script');
                    script.src = window.EJS_pathtodata + 'loader.js';
                    document.body.appendChild(script);
                }
            })()
        """)

        # Wait for emulator
        page.wait_for_function(
            "window.EJS_emulator && window.EJS_emulator.gameManager && "
            "window.EJS_emulator.gameManager.Module && "
            "window.EJS_emulator.gameManager.Module.HEAPU8",
            timeout=60000,
        )
        time.sleep(8)  # Let game reach title screen
        return self.screenshot("boot")

    def screenshot(self, label="step"):
        """Take a screenshot, return the file path."""
        self._step += 1
        path = SCREENSHOT_DIR / f"{self._step:02d}_{label}.png"
        self._page.screenshot(path=str(path))
        return str(path)

    def press(self, button, hold_ms=100, wait_after=0.3):
        """Press an N64 button."""
        k = KEYS.get(button, button)
        self._page.keyboard.down(k)
        time.sleep(hold_ms / 1000)
        self._page.keyboard.up(k)
        time.sleep(wait_after)

    def press_repeat(self, button, times, hold_ms=100, gap=0.2):
        """Press a button multiple times."""
        for _ in range(times):
            self.press(button, hold_ms, gap)

    def wait(self, seconds):
        """Wait for a number of seconds."""
        time.sleep(seconds)

    def scan(self, label):
        """Scan RDRAM in 4KB chunks. Returns dict of offset -> hash."""
        result = self._page.evaluate("""
            (function() {
                var mod = window.EJS_emulator.gameManager.Module;
                if (!mod || !mod.HEAPU8) return { error: 'no module' };
                var ptr = 0, size = 0;
                try {
                    var gmd = mod.cwrap('get_memory_data', 'string', ['string']);
                    var r = gmd('RETRO_MEMORY_SYSTEM_RAM');
                    if (r) { var p = r.split('|'); size = parseInt(p[0]); ptr = parseInt(p[1]); }
                } catch(e) { return { error: e.message }; }
                if (!ptr) return { error: 'no ptr' };
                var buf = mod.HEAPU8.buffer;
                if (!buf || buf.byteLength === 0) return { error: 'detached' };
                var live = new Uint8Array(buf);
                var cs = 4096, nc = Math.floor(size / cs);
                var h = {};
                for (var i = 0; i < nc; i++) {
                    var off = ptr + i * cs, hv = 0x811c9dc5;
                    for (var j = 0; j < cs; j++) { hv ^= live[off+j]; hv = Math.imul(hv, 0x01000193); }
                    h[i * cs] = hv | 0;
                }
                return { ptr: ptr, size: size, hashes: h };
            })()
        """)
        if 'error' in result:
            print(f"[{label}] Error: {result['error']}")
            return None
        self._scans[label] = result['hashes']
        print(f"[{label}] Scanned {result['chunks'] if 'chunks' in result else len(result['hashes'])} chunks")
        return result['hashes']

    def compare(self, label1, label2):
        """Compare two scans, return changed offsets."""
        s1, s2 = self._scans.get(label1), self._scans.get(label2)
        if not s1 or not s2:
            return []
        changed = [int(k) for k in s1 if s1.get(k) != s2.get(k)]
        return sorted(changed)

    def multi_scan(self, label, count=3, gap=0.5):
        """Take multiple scans and find volatile regions."""
        scans = []
        for i in range(count):
            scans.append(self.scan(f"{label}_{i}"))
            time.sleep(gap)
        # Find chunks that changed between any consecutive pair
        volatile = set()
        for i in range(1, len(scans)):
            if scans[i-1] and scans[i]:
                for k in scans[i-1]:
                    if scans[i-1].get(k) != scans[i].get(k):
                        volatile.add(int(k))
        return sorted(volatile)

    def read_bytes(self, rdram_offset, count=32):
        """Read raw bytes from RDRAM at given offset."""
        return self._page.evaluate(f"""
            (function() {{
                var mod = window.EJS_emulator.gameManager.Module;
                var gmd = mod.cwrap('get_memory_data', 'string', ['string']);
                var r = gmd('RETRO_MEMORY_SYSTEM_RAM');
                var ptr = parseInt(r.split('|')[1]);
                var buf = mod.HEAPU8.buffer;
                var live = new Uint8Array(buf);
                var off = ptr + {rdram_offset};
                var bytes = [];
                for (var i = 0; i < {count}; i++) bytes.push(live[off+i]);
                return bytes;
            }})()
        """)

    def save_results(self, data, filename="rdram_scan_visual.json"):
        """Save scan results to file."""
        path = Path("/Users/kazon/kaillera-next/logs") / filename
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"Results saved to {path}")

    def close(self):
        self._browser.close()
        self._pw.stop()
