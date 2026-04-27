import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLAY_HTML = ROOT / "web/play.html"
PLAY_JS = ROOT / "web/static/play.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
PAYLOADS_PY = ROOT / "server/src/api/payloads.py"


def test_resync_host_option_is_on_by_default_with_hover_tooltip():
    source = PLAY_HTML.read_text()

    assert re.search(r'<input type="checkbox" id="opt-resync" checked\b', source)
    assert "Keeps players in sync" in source
    assert "mobile app switches" in source
    assert "network changes" in source
    assert "long input dropouts" in source
    assert "detected mismatch" not in source


def test_resync_defaults_enabled_across_client_and_server_fallbacks():
    play_js = PLAY_JS.read_text()
    lockstep_js = LOCKSTEP_JS.read_text()
    payloads_py = PAYLOADS_PY.read_text()

    assert "let _gameResyncEnabled = true" in play_js
    assert "_gameResyncEnabled = data.resyncEnabled !== false" in play_js
    assert "resyncEnabled: optResync ? optResync.checked : true" in play_js
    assert "_syncEnabled = config.resyncEnabled !== false" in lockstep_js
    assert "resyncEnabled: bool = True" in payloads_py
