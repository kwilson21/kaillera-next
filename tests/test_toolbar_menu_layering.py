from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLAY_JS = ROOT / "web/static/play.js"
MENUS_TS = ROOT / "web/src/play/menus.ts"
PLAY_CSS = ROOT / "web/static/play.css"
FEEDBACK_JS = ROOT / "web/static/feedback.js"


def test_more_dropdown_uses_top_layer_popover_to_escape_canvas_stacking():
    play = PLAY_JS.read_text()
    css = PLAY_CSS.read_text()
    feedback = FEEDBACK_JS.read_text()

    menus = MENUS_TS.read_text()
    assert "menu.setAttribute('popover', 'manual')" in menus
    assert "menu.showPopover()" in menus
    assert "menu.hidePopover()" in menus
    assert "window.KNCloseMoreDropdown = closeMoreDropdown" in play

    assert ".more-dropdown[popover]" in css
    assert ".more-dropdown:popover-open" in css
    assert "z-index: 2147483647;" in css

    assert "window.KNCloseMoreDropdown" in feedback
