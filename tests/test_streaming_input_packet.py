from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STREAMING_JS = ROOT / "web/static/netplay-streaming.js"
SHARED_JS = ROOT / "web/static/shared.js"
PLAY_CSS = ROOT / "web/static/play.css"
VIRTUAL_GAMEPAD_JS = ROOT / "web/static/virtual-gamepad.js"


def test_streaming_host_accepts_current_shared_input_packets():
    streaming = STREAMING_JS.read_text()
    shared = SHARED_JS.read_text()

    assert "const arr = new Int32Array(6 + redCount * 4);" in shared
    assert "hostPeer.dc.send(KNShared.encodeInput(0, localInput).buffer)" in streaming

    receive_idx = streaming.find("ch.onmessage = (e) => {")
    assert receive_idx != -1
    receive_window = streaming[receive_idx : receive_idx + 1400]

    assert "e.data.byteLength === 16" not in receive_window
    assert "e.data.byteLength >= 16" in receive_window
    assert "e.data.byteLength % Int32Array.BYTES_PER_ELEMENT === 0" in receive_window
    assert "KNShared.decodeInput(e.data)" in receive_window


def test_streaming_guest_repeats_input_at_60hz_and_sends_immediately():
    streaming = STREAMING_JS.read_text()

    loop_idx = streaming.find("const startGuestInputLoop = () => {")
    assert loop_idx != -1
    loop_window = streaming[loop_idx : loop_idx + 3200]

    assert "const GUEST_INPUT_SEND_MS = 1000 / 60;" in streaming
    assert "const sendGuestInput = (force = false) => {" in loop_window
    assert "sendGuestInput(true)" in loop_window
    assert "setInterval(tick, GUEST_INPUT_SEND_MS)" in loop_window
    assert "requestAnimationFrame(tick)" not in loop_window

    assert "const queueImmediateSend = () => {" in loop_window
    assert "queueMicrotask(() => {" in loop_window
    assert "document.addEventListener('keydown', queueImmediateSend" in loop_window
    assert "document.addEventListener('keyup', queueImmediateSend" in loop_window
    assert "document.addEventListener('touchstart', queueImmediateSend" in loop_window
    assert "document.addEventListener('touchmove', queueImmediateSend" in loop_window
    assert "window.addEventListener('gamepadconnected', queueImmediateSend" in loop_window
    assert "_guestInputAbort.abort()" in streaming


def test_streaming_host_applies_local_input_immediately_too():
    streaming = STREAMING_JS.read_text()

    loop_idx = streaming.find("const startHostInputLoop = () => {")
    assert loop_idx != -1
    loop_window = streaming[loop_idx : loop_idx + 2600]

    assert "const applyHostInput = () => {" in loop_window
    assert "queueMicrotask(() => {" in loop_window
    assert "document.addEventListener('keydown', queueImmediateHostInput" in loop_window
    assert "document.addEventListener('keyup', queueImmediateHostInput" in loop_window
    assert "document.addEventListener('touchstart', queueImmediateHostInput" in loop_window
    assert "window.addEventListener('gamepadconnected', queueImmediateHostInput" in loop_window
    assert "_hostInputAbort.abort()" in streaming


def test_streaming_direct_capture_is_default_with_blit_escape_hatch():
    streaming = STREAMING_JS.read_text()

    assert "raw = params.get('streamCapture') || params.get('captureMode')" in streaming
    assert "if (raw === 'blit') return 'blit';" in streaming
    assert "return 'direct';" in streaming

    assert "const startDirectCanvasCapture = (srcCanvas) => {" in streaming
    assert "_hostStream = srcCanvas.captureStream(60)" in streaming
    assert "const STREAM_CAPTURE_TARGET_WIDTH = 640;" in streaming
    assert "const STREAM_CAPTURE_TARGET_HEIGHT = 480;" in streaming
    assert "return Math.max(1, sh / STREAM_CAPTURE_TARGET_HEIGHT);" in streaming
    assert "return Math.max(1, sw / STREAM_CAPTURE_TARGET_WIDTH);" in streaming
    assert "const startBlitCanvasCapture = (srcCanvas, isSafari) => {" in streaming
    assert "direct canvas capture failed, falling back to blit" in streaming
    assert "direct canvas capture disabled on Safari" in streaming

    assert "params.encodings[0].scaleResolutionDownBy = _captureScaleDownBy;" in streaming
    assert "capture=${_captureMode}" in streaming


def test_stream_overlay_uses_game_sized_flex_slot():
    css = PLAY_CSS.read_text()
    streaming = STREAMING_JS.read_text()
    vgp = VIRTUAL_GAMEPAD_JS.read_text()

    assert "#stream-overlay {" in css
    assert "max-height: calc(100vw * 3 / 4);" in css
    assert "aspect-ratio: 4 / 3;" in css
    assert "display: flex;" in css
    assert "align-items: center;" in css
    assert "justify-content: center;" in css
    assert "#game,\n  #stream-overlay {" in css
    assert "#stream-overlay video {" in css
    assert "object-fit: cover;" in css
    assert "min-height:0;overflow:hidden;order:1;display:flex" in streaming
    assert "'  #game, #stream-overlay {'" in vgp
