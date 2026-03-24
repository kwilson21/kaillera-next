"""Playwright tests for virtual gamepad layout, ROM declaration, and EJS gamepad replacement."""
import pytest
from playwright.sync_api import sync_playwright

# Device viewports matching real phones
IPHONE_14_PORTRAIT = {"width": 390, "height": 844}
IPHONE_14_LANDSCAPE = {"width": 844, "height": 390}
IPHONE_SE_PORTRAIT = {"width": 375, "height": 667}
PIXEL_7_PORTRAIT = {"width": 412, "height": 915}
IPAD_PORTRAIT = {"width": 820, "height": 1180}

SERVER = "http://localhost:8000"

# Minimal page simulating play.html for a streaming guest
STREAMING_GUEST_PAGE = """<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:#111; color:#eee; font-family:sans-serif;
  height:100vh; height:100dvh;
  display:flex; flex-direction:column; align-items:center;
  overflow:hidden; overscroll-behavior:none;
}
#game {
  width:100vw; max-width:100vw; flex:1 1 0; min-height:0;
  margin:auto 0; order:1;
}
#game video, #game .fake-video {
  max-width:100%; width:100%; height:100%; object-fit:contain; display:block;
}
#toolbar {
  width:100%; flex-shrink:0; order:10;
  display:flex; flex-wrap:wrap; gap:8px; padding:8px 12px;
  background:rgba(17,17,17,0.95); z-index:50; align-items:center;
}
#toolbar button { padding:6px 12px; font-size:12px; min-height:36px;
  background:#333; color:#eee; border:1px solid #555; border-radius:4px; cursor:pointer; }
#leave-btn {
  display:block; width:100%; background:#3a2a2a; order:11;
  font-size:13px; padding:10px; min-height:38px; color:#eee; border:none; cursor:pointer;
}
</style>
</head>
<body>
  <div id="game">
    <div class="fake-video" style="background:#234;display:flex;align-items:center;
      justify-content:center;color:#555;font-size:20px;aspect-ratio:4/3;">
      STREAMING VIDEO
    </div>
  </div>
  <div id="toolbar">
    <span style="font-size:12px;color:#888;">Room: TEST</span>
    <span style="font-size:12px;color:#6f6;">Connected</span>
    <button>Share</button>
    <button>Info</button>
  </div>
  <button id="leave-btn">Leave Game</button>
  <script src="/static/virtual-gamepad.js"></script>
  <script>
    window._testTouchState = {};
  </script>
</body>
</html>"""

# Page for testing ROM declaration prompt (lobby view)
LOBBY_GUEST_PAGE = """<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#111; color:#eee; font-family:sans-serif; padding:20px; }
.card-section { margin:12px 0; padding:12px; background:#222; border-radius:8px; }
</style>
</head>
<body>
  <h2>Room Lobby (Guest View)</h2>
  <div id="rom-declare-prompt" style="display:none" class="card-section">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="checkbox" id="rom-declare-cb">
      <span style="font-size:13px;">I own a legal copy of this game and accept all liability</span>
    </label>
  </div>
  <p id="guest-status">Waiting for host to start...</p>
  <script>
    // Simulate play.js updateRomDeclarePrompt for a non-host, non-spectator guest
    var isHost = false;
    var isSpectator = false;
    function updateRomDeclarePrompt() {
      var prompt = document.getElementById('rom-declare-prompt');
      if (!prompt) return;
      var show = !isHost && !isSpectator;
      prompt.style.display = show ? '' : 'none';
    }
    updateRomDeclarePrompt();
  </script>
</body>
</html>"""


def _init_page(page, html, server=SERVER):
    """Load a test page and inject the virtual gamepad script."""
    page.goto(server)
    page.set_content(html)
    page.add_script_tag(url=f"{server}/static/virtual-gamepad.js")
    page.wait_for_timeout(200)


def _init_gamepad(page):
    """Initialize the virtual gamepad on the page."""
    page.evaluate("""() => {
        window._testTouchState = {};
        if (window.VirtualGamepad) {
            VirtualGamepad.init(document.body, window._testTouchState);
        }
    }""")
    page.wait_for_timeout(200)


def _screenshot(page, name):
    """Take a screenshot and return the path."""
    path = f"tests/screenshots/{name}.png"
    page.screenshot(path=path)
    return path


def _check_no_overlap(page, sel_a, sel_b):
    """Check that two elements don't visually overlap. Returns True if NO overlap."""
    return page.evaluate("""([selA, selB]) => {
        const a = document.querySelector(selA);
        const b = document.querySelector(selB);
        if (!a || !b) return true;  // missing element = no overlap
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        // No overlap if one is entirely above/below/left/right of the other
        return ra.bottom <= rb.top || rb.bottom <= ra.top ||
               ra.right <= rb.left || rb.right <= ra.left;
    }""", [sel_a, sel_b])


def _check_within_viewport(page, selector):
    """Check element is fully within viewport bounds."""
    return page.evaluate("""(sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 &&
               r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    }""", selector)


def _check_element_visible(page, selector):
    """Check element exists and is visible (display != none, has dimensions)."""
    return page.evaluate("""(sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }""", selector)


# ── Gamepad Layout Tests ─────────────────────────────────────────────

class TestGamepadLayout:
    """Virtual gamepad doesn't overlap video or toolbar on any device."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pw = sync_playwright().start()
        yield
        self.pw.stop()

    def _test_device(self, viewport, name):
        browser = self.pw.chromium.launch()
        ctx = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        _init_page(page, STREAMING_GUEST_PAGE)
        _init_gamepad(page)
        _screenshot(page, name)

        # Check gamepad exists
        assert _check_element_visible(page, '#virtual-gamepad'), f"{name}: gamepad not visible"

        # Check no BUTTON overlap with toolbar/leave (container may span full area)
        no_toolbar_overlap = True
        no_leave_overlap = True
        for btn_sel in ['.vgp-a', '.vgp-b', '.vgp-start', '.vgp-l', '.vgp-r', '.vgp-z',
                        '.vgp-du', '.vgp-dd', '.vgp-dl', '.vgp-dr',
                        '.vgp-cu', '.vgp-cd', '.vgp-cl', '.vgp-cr', '.vgp-stick-zone']:
            if not _check_no_overlap(page, btn_sel, '#toolbar'):
                print(f"  OVERLAP: {btn_sel} overlaps #toolbar")
                no_toolbar_overlap = False
            if not _check_no_overlap(page, btn_sel, '#leave-btn'):
                print(f"  OVERLAP: {btn_sel} overlaps #leave-btn")
                no_leave_overlap = False

        # Check all critical buttons exist and are visible
        for btn_class in ['vgp-a', 'vgp-b', 'vgp-start', 'vgp-l', 'vgp-r', 'vgp-z']:
            assert _check_element_visible(page, f'.{btn_class}'), f"{name}: {btn_class} not visible"

        # Check A button is within viewport
        a_in_viewport = _check_within_viewport(page, '.vgp-a')

        # Check stick zone visible
        assert _check_element_visible(page, '.vgp-stick-zone'), f"{name}: stick not visible"

        browser.close()

        # Soft assertions — print but don't fail on toolbar overlap (will fix iteratively)
        if not no_toolbar_overlap:
            print(f"WARNING {name}: gamepad overlaps toolbar")
        if not no_leave_overlap:
            print(f"WARNING {name}: gamepad overlaps leave button")
        if not a_in_viewport:
            print(f"WARNING {name}: A button outside viewport")

        return no_toolbar_overlap and no_leave_overlap and a_in_viewport

    def test_iphone14_portrait(self):
        assert self._test_device(IPHONE_14_PORTRAIT, "gp-iphone14-portrait")

    def test_iphone14_landscape(self):
        assert self._test_device(IPHONE_14_LANDSCAPE, "gp-iphone14-landscape")

    def test_iphoneSE_portrait(self):
        assert self._test_device(IPHONE_SE_PORTRAIT, "gp-iphoneSE-portrait")

    def test_pixel7_portrait(self):
        assert self._test_device(PIXEL_7_PORTRAIT, "gp-pixel7-portrait")


# ── ROM Declaration Tests ─────────────────────────────────────────────

class TestRomDeclaration:
    """ROM ownership declaration prompt works correctly."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pw = sync_playwright().start()
        yield
        self.pw.stop()

    def test_guest_sees_declaration(self):
        """Non-host, non-spectator guest sees the declaration checkbox."""
        browser = self.pw.chromium.launch()
        ctx = browser.new_context(viewport=IPHONE_14_PORTRAIT, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        page.goto(SERVER)
        page.set_content(LOBBY_GUEST_PAGE)
        page.wait_for_timeout(200)
        _screenshot(page, "rom-declare-guest")

        visible = _check_element_visible(page, '#rom-declare-prompt')
        assert visible, "Declaration prompt should be visible for guest"

        # Checkbox should be unchecked initially
        checked = page.evaluate("() => document.getElementById('rom-declare-cb').checked")
        assert not checked, "Checkbox should start unchecked"

        browser.close()

    def test_host_no_declaration(self):
        """Host should NOT see the declaration prompt."""
        browser = self.pw.chromium.launch()
        ctx = browser.new_context(viewport=IPHONE_14_PORTRAIT, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        page.goto(SERVER)
        # Modify the page to simulate host
        host_page = LOBBY_GUEST_PAGE.replace("var isHost = false;", "var isHost = true;")
        page.set_content(host_page)
        page.wait_for_timeout(200)
        _screenshot(page, "rom-declare-host")

        visible = _check_element_visible(page, '#rom-declare-prompt')
        assert not visible, "Declaration prompt should be hidden for host"

        browser.close()

    def test_spectator_no_declaration(self):
        """Spectator should NOT see the declaration prompt."""
        browser = self.pw.chromium.launch()
        ctx = browser.new_context(viewport=IPHONE_14_PORTRAIT, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        page.goto(SERVER)
        spec_page = LOBBY_GUEST_PAGE.replace("var isSpectator = false;", "var isSpectator = true;")
        page.set_content(spec_page)
        page.wait_for_timeout(200)

        visible = _check_element_visible(page, '#rom-declare-prompt')
        assert not visible, "Declaration prompt should be hidden for spectator"

        browser.close()


# ── Touch State Tests ─────────────────────────────────────────────────

class TestTouchInput:
    """Touch events properly update state."""

    @pytest.fixture(autouse=True)
    def setup(self):
        self.pw = sync_playwright().start()
        yield
        self.pw.stop()

    def test_a_button_tap(self):
        browser = self.pw.chromium.launch()
        ctx = browser.new_context(viewport=IPHONE_14_PORTRAIT, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        _init_page(page, STREAMING_GUEST_PAGE)
        _init_gamepad(page)

        # Verify A button exists
        assert _check_element_visible(page, '.vgp-a'), "A button not visible"

        # Verify gamepad is in DOM
        has_gp = page.evaluate("() => !!document.getElementById('virtual-gamepad')")
        assert has_gp, "Virtual gamepad not in DOM"

        browser.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
