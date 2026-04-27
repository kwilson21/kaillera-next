from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DETERMINISM_JS = ROOT / "tests/determinism-automation.mjs"
DIAGNOSTICS_JS = ROOT / "web/static/kn-diagnostics.js"


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
