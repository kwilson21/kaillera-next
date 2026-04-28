from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DETERMINISM_JS = ROOT / "tests/determinism-automation.mjs"
DIAGNOSTICS_JS = ROOT / "web/static/kn-diagnostics.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
PLAY_JS = ROOT / "web/static/play.js"
STREAMING_JS = ROOT / "web/static/netplay-streaming.js"
PLAY_HTML = ROOT / "web/play.html"


def test_determinism_harness_checks_rendered_canvas_screenshots_for_yellow_screen():
    source = DETERMINISM_JS.read_text()

    assert "async function sampleRenderedCanvasScreenshot(page)" in source
    assert "canvas.screenshot({ timeout: 5000 })" in source
    assert "hostRendered: lastHostRendered" in source
    assert "guestRendered: lastGuestRendered" in source
    assert "solidPale" in source
    assert "title-start-failed" in source
    assert "async function writeBootTimeoutReport(host, guest, label, err)" in source
    assert "verdict: 'BOOT_TICK_TIMEOUT'" in source
    assert "await writeBootTimeoutReport(host, guest, 'boot-timeout', err)" in source


def test_runtime_canvas_health_logs_yellow_pixel_ratios_and_screenshot():
    source = DIAGNOSTICS_JS.read_text()

    assert "let palePixels = 0" in source
    assert "let yellowGreenPixels = 0" in source
    assert "paleRatio=" in source
    assert "yellowGreenRatio=" in source
    assert "window.KNEvent?.('canvas_solid_pale'" in source
    assert "captureAndSendScreenshot()" in source
    assert "new CustomEvent('kn-canvas-solid-pale'" in source
    assert "sampleCanvasHealth," in source


def test_runtime_blocks_solid_yellow_boot_and_retries_safer_graphics_profile():
    lockstep = LOCKSTEP_JS.read_text()
    play = PLAY_JS.read_text()
    streaming = STREAMING_JS.read_text()
    html = PLAY_HTML.read_text()

    assert "CANVAS-BOOT-BLOCK solid pale/yellow before sync" in lockstep
    assert "window.KNRecoverSolidCanvas?.({" in lockstep
    assert "_bootGestureReceived = false" in lockstep
    assert "Renderer retry (${recovery.profile}) — tap to continue" in lockstep

    assert "const _GFX_RECOVERY_PROFILES = ['texrect', 'texrect-unopt', 'webgl1', 'angrylion'];" in play
    assert "const recoverSolidCanvas = ({ reason = 'solid-pale-canvas', health = null } = {}) =>" in play
    assert "window.KNRecoverSolidCanvas = recoverSolidCanvas" in play
    assert "kn-gfx-recovery-profile" in play
    assert "Renderer returned a solid pale/yellow frame; retrying with safer graphics profile" in play

    assert "streaming CANVAS-BOOT-BLOCK solid pale/yellow" in streaming
    assert "window.KNStartEmulatorBoot?.({ forceStartOnLoad: true });" in streaming
    assert "window.KNRecoverSolidCanvas?.({" in streaming

    assert "window.__knInstallUnpackAlignmentShim = function ()" in html
    assert "window.__knInstallUnpackAlignmentShim();" in html
    assert "window.__knInstallUnpackAlignmentShim();\n        var params = new URLSearchParams" not in html
