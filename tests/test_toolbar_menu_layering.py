from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLAY_JS = ROOT / "web/static/play.js"
PLAY_CSS = ROOT / "web/static/play.css"
FEEDBACK_JS = ROOT / "web/static/feedback.js"


def test_more_dropdown_uses_top_layer_popover_to_escape_canvas_stacking():
    play = PLAY_JS.read_text()
    css = PLAY_CSS.read_text()
    feedback = FEEDBACK_JS.read_text()

    assert "dd.setAttribute('popover', 'manual')" in play
    assert "dd.showPopover()" in play
    assert "dd.hidePopover()" in play
    assert "window.KNCloseMoreDropdown = closeMoreDropdown" in play

    assert ".more-dropdown[popover]" in css
    assert ".more-dropdown:popover-open" in css
    assert "z-index: 2147483647;" in css

    assert "window.KNCloseMoreDropdown" in feedback
