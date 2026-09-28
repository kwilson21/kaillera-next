"""Demo page restyle (docs/landing-design.md §7.2 M3, §7.5 tokens, §7.6 a11y).

Covers the parts that don't need a real emulator run: tokens/fonts/layout,
the "Play with friends" CTA, and the Rollback timeline (§5.7f #3) — its
initial (pre-match) state, its reduced-motion still frame, and that it's
wired up as window.KNRollbackTimeline with the expected element ids. The
timeline's live rewind/lockstep-wait behaviour is covered without a browser
in tests/rollback-timeline.test.mjs (`node --test`).

Run: pytest tests/test_demo_page.py -v
"""

import pytest
from playwright.sync_api import expect


@pytest.fixture
def demo_page(page, server_url):
    page.goto(f"{server_url}/demo.html")
    expect(page.locator("h1")).to_have_text("Rollback demo")
    return page


def test_title_and_heading(demo_page):
    expect(demo_page).to_have_title("Rollback demo | kaillera-next")
    expect(demo_page.locator("h1")).to_have_text("Rollback demo")
    expect(demo_page.locator(".lede")).to_contain_text("Drop a ROM. Crank the lag.")


def test_direction_a_tokens_applied(demo_page):
    bg = demo_page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()")
    accent = demo_page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
    body_bg = demo_page.evaluate("getComputedStyle(document.body).backgroundColor")
    assert bg == "#0e1218"
    assert accent == "#5aa8ff"
    # rgb(14, 18, 24) == #0e1218
    assert body_bg == "rgb(14, 18, 24)"


def test_self_hosted_fonts_declared(demo_page):
    css = demo_page.content()
    assert "/static/fonts/barlow-condensed-600-latin.woff2" in css
    assert "/static/fonts/barlow-condensed-700-latin.woff2" in css
    assert "/static/fonts/ibm-plex-sans-var-latin.woff2" in css
    # No third-party font CDN.
    assert "fonts.googleapis.com" not in css
    assert "fonts.gstatic.com" not in css


def test_play_with_friends_points_to_front_page(demo_page):
    cta = demo_page.locator("#play-cta")
    expect(cta).to_have_attribute("href", "/")
    expect(demo_page.locator("#play-cta-headline")).to_have_text("Play with friends")


def test_rollback_timeline_present_with_eleven_ticks(demo_page):
    svg = demo_page.locator("#rb-timeline")
    expect(svg).to_be_visible()
    assert svg.locator(".t").count() == 11
    expect(demo_page.locator("#rb-head")).to_be_visible()


def test_rollback_timeline_idle_before_a_match(demo_page):
    # No ROM has been dropped, so no match is active — the timeline should
    # say so rather than animate.
    expect(demo_page.locator("#rb-caption")).to_have_text("Waiting for a match to start.")
    bad_ticks = demo_page.locator("#rb-timeline .t.is-bad")
    replay_ticks = demo_page.locator("#rb-timeline .t.is-replay")
    assert bad_ticks.count() == 0
    assert replay_ticks.count() == 0


def test_rollback_timeline_module_exposes_pure_api(demo_page):
    # The live-driving contract demo.js relies on; see
    # tests/rollback-timeline.test.mjs for the state machine's behaviour.
    has_api = demo_page.evaluate(
        "() => !!(window.KNRollbackTimeline && window.KNRollbackTimeline.createState "
        "&& window.KNRollbackTimeline.reduce && window.KNRollbackTimeline.render)"
    )
    assert has_api


def test_reduced_motion_renders_static_still_frame(page, server_url):
    page.emulate_media(reduced_motion="reduce")
    page.goto(f"{server_url}/demo.html")
    expect(page.locator("h1")).to_have_text("Rollback demo")
    # render(..., {still: true}) marks tick 6 bad and ticks 4/5 replay,
    # matching the landing page's still frame (web/static/landing.css).
    page.wait_for_timeout(300)
    assert page.locator('#rb-timeline .t[data-i="6"].is-bad').count() == 1
    assert page.locator('#rb-timeline .t[data-i="4"].is-replay').count() == 1
    assert page.locator('#rb-timeline .t[data-i="5"].is-replay').count() == 1
    caption = page.locator("#rb-caption").text_content()
    assert "wrong guess" in caption.lower() or "rewind" in caption.lower()


def test_no_horizontal_scroll_on_phone(demo_page, page):
    page.set_viewport_size({"width": 390, "height": 844})
    scroll_width = page.evaluate("document.documentElement.scrollWidth")
    client_width = page.evaluate("document.documentElement.clientWidth")
    assert scroll_width <= client_width + 1  # allow 1px rounding


def test_tap_targets_are_44px_on_phone(demo_page, page):
    page.set_viewport_size({"width": 390, "height": 844})
    for sel in ["#rollback-toggle", "#auto-compare-btn", "#emu-controls", "#emu-reset", "#emu-pause", "#emu-stop"]:
        box = page.locator(sel).bounding_box()
        assert box is not None, f"{sel} not found"
        assert box["height"] >= 44, f"{sel} height {box['height']} < 44px"
