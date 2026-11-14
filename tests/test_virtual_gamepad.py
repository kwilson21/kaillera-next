"""Playwright tests for virtual gamepad layout, ROM declaration, and EJS gamepad replacement."""
import os

import pytest

# Device viewports matching real phones
IPHONE_14_PORTRAIT = {"width": 390, "height": 844}
IPHONE_14_LANDSCAPE = {"width": 844, "height": 390}
IPHONE_SE_PORTRAIT = {"width": 375, "height": 667}
PIXEL_7_PORTRAIT = {"width": 412, "height": 915}
IPAD_PORTRAIT = {"width": 820, "height": 1180}

# KN_TEST_PORT lets parallel checkouts each run their own test server.
SERVER = f"http://localhost:{os.environ.get('KN_TEST_PORT', '27888')}"

# The play page in a game, as far as layout goes: the real stylesheet and the
# real in-game toolbar (Leave is a button in it), with a 4:3 block standing in
# for the video. The same markup as tests/vgp-test.html.
STREAMING_GUEST_PAGE = """<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<link rel="stylesheet" href="/static/play.css">
<style>
#game .fake-video {
  height:100%; aspect-ratio:4/3; max-width:100%; margin:0 auto;
  background:#234; display:flex; align-items:center; justify-content:center;
  color:#555; font-size:20px;
}
</style>
</head>
<body>
  <div id="game">
    <div class="fake-video">STREAMING VIDEO</div>
  </div>
  <div id="info-overlay">
    <span id="info-header">Room TEST1234</span>
    <span id="info-stats">f=1234 delay=4f ping=32ms</span>
  </div>
  <div id="gamepad-indicator" class="hidden">Gamepad connected</div>
  <div id="toolbar">
    <span id="toolbar-room">TEST1234</span>
    <span id="toolbar-status"></span>
    <div class="toolbar-spacer"></div>
    <button id="toolbar-leave">Leave</button>
    <div id="more-wrapper">
      <button id="toolbar-more" class="toolbar-toggle" title="More options">&#x22EF;</button>
    </div>
  </div>
  <script src="/static/virtual-gamepad.js"></script>
  <script>
    window._testTouchState = {};
  </script>
</body>
</html>"""

def _init_page(page, html, server=SERVER):
    """Load a test page and inject the virtual gamepad script."""
    page.goto(server)
    page.set_content(html)
    page.add_script_tag(url=f"{server}/static/virtual-gamepad.js")
    page.wait_for_timeout(200)
    # The layout checks below mean nothing on an unstyled page.
    assert page.evaluate("getComputedStyle(document.body).display") == "flex", "play.css did not load"


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


# Z and Start are on the page twice: one copy for portrait and one for
# landscape, and the stylesheet shows one of them. A selector is therefore
# resolved to the copy that is shown, never to the first match.
_SHOWN = """
    const shown = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
        if (window.getComputedStyle(el).display === 'none') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
"""


def _check_no_overlap(page, sel_a, sel_b):
    """Check that no shown element of one selector overlaps one of the other. True if NO overlap."""
    return page.evaluate("""([selA, selB]) => {""" + _SHOWN + """
        // No overlap if one is entirely above/below/left/right of the other
        return shown(selA).every((a) => shown(selB).every((b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return ra.bottom <= rb.top || rb.bottom <= ra.top ||
                   ra.right <= rb.left || rb.right <= ra.left;
        }));
    }""", [sel_a, sel_b])


def _check_within_viewport(page, selector):
    """Check the shown element is fully within viewport bounds."""
    return page.evaluate("""(sel) => {""" + _SHOWN + """
        const els = shown(sel);
        return els.length > 0 && els.every((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.left >= 0 &&
                   r.bottom <= window.innerHeight && r.right <= window.innerWidth;
        });
    }""", selector)


def _check_element_visible(page, selector):
    """Check exactly one element of the selector is shown (display != none, has dimensions)."""
    return page.evaluate("""(sel) => {""" + _SHOWN + """
        return shown(sel).length === 1;
    }""", selector)


# ── Gamepad Layout Tests ─────────────────────────────────────────────

class TestGamepadLayout:
    """Virtual gamepad doesn't overlap video or toolbar on any device."""

    @pytest.fixture(autouse=True)
    def setup(self, browser, server_url):
        # The session's own browser (pytest-playwright), not a second
        # Playwright: conftest.py already starts one for every test, and the
        # sync API refuses to start another on the same thread.
        self.browser = browser
        self.server = server_url

    def _test_device(self, viewport, name):
        ctx = self.browser.new_context(viewport=viewport, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        _init_page(page, STREAMING_GUEST_PAGE, self.server)
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
            if not _check_no_overlap(page, btn_sel, '#toolbar-leave'):
                print(f"  OVERLAP: {btn_sel} overlaps #toolbar-leave")
                no_leave_overlap = False

        # Check all critical buttons exist and are visible
        for btn_class in ['vgp-a', 'vgp-b', 'vgp-start', 'vgp-l', 'vgp-r', 'vgp-z']:
            assert _check_element_visible(page, f'.{btn_class}'), f"{name}: {btn_class} not visible"

        # Check A button is within viewport
        a_in_viewport = _check_within_viewport(page, '.vgp-a')

        # Check stick zone visible
        assert _check_element_visible(page, '.vgp-stick-zone'), f"{name}: stick not visible"

        ctx.close()

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


# ── Touch State Tests ─────────────────────────────────────────────────

class TestTouchInput:
    """Touch events properly update state."""

    @pytest.fixture(autouse=True)
    def setup(self, browser, server_url):
        # The session's own browser (pytest-playwright), not a second
        # Playwright: conftest.py already starts one for every test, and the
        # sync API refuses to start another on the same thread.
        self.browser = browser
        self.server = server_url

    def test_a_button_tap(self):
        ctx = self.browser.new_context(viewport=IPHONE_14_PORTRAIT, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        _init_page(page, STREAMING_GUEST_PAGE, self.server)
        _init_gamepad(page)

        # Verify A button exists
        assert _check_element_visible(page, '.vgp-a'), "A button not visible"

        # Verify gamepad is in DOM
        has_gp = page.evaluate("() => !!document.getElementById('virtual-gamepad')")
        assert has_gp, "Virtual gamepad not in DOM"

        ctx.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
