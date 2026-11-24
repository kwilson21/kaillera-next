from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STREAMING_JS = ROOT / "web/static/netplay-streaming.js"
INPUT_WIRE_TS = ROOT / "web/src/input-wire.ts"
# The engine's decisions, which it calls through window.KNCore.streaming.
STREAMING_TS = ROOT / "web/src/streaming"
PLAY_JS = ROOT / "web/static/play.js"
PLAY_CSS = ROOT / "web/static/play.css"
# The touch controls' stylesheet, moved from web/static/virtual-gamepad.js.
VIRTUAL_GAMEPAD_MARKUP = ROOT / "web/src/page/virtual-gamepad/markup.ts"


def test_streaming_host_accepts_current_shared_input_packets():
    streaming = STREAMING_JS.read_text()
    wire = INPUT_WIRE_TS.read_text()

    # The packet KNShared.encodeInput builds: 6 header words, then 4 per repeated frame.
    assert "//@ ensures \\result.length === 6 + 4 * redundant.length" in wire
    rules = (STREAMING_TS / "input.ts").read_text()
    assert "hostPeer.dc.send(_rules.guestPacket(localInput).buffer)" in streaming
    assert "encodeInput(GUEST_PACKET_FRAME, input)" in rules
    assert "export const GUEST_PACKET_FRAME = 0;" in rules

    receive_idx = streaming.find("ch.onmessage = (e) => {")
    assert receive_idx != -1
    receive_window = streaming[receive_idx : receive_idx + 1400]
    assert "_rules.readGuestPacket(_playerSlot, _peers[remoteSid]?.slot, e.data)" in receive_window

    # Any whole number of words from the header up, not only a 16-byte packet.
    assert "byteLength === 16" not in rules
    assert "data.byteLength >= 16 && data.byteLength % Int32Array.BYTES_PER_ELEMENT === 0" in rules
    assert "decodeInput(data)" in rules


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


def test_streaming_host_applies_controller_present_mask_like_lockstep():
    streaming = STREAMING_JS.read_text()

    assert "let _lastControllerPresentMask = -1;" in streaming
    assert "let _lastControllerPresentMaskModule = null;" in streaming
    assert "const _controllerPresentMask = () =>" in streaming
    assert "_rules.controllerPresentMask(_playerSlot, [" in streaming
    assert "...Object.values(_knownPlayers).map((info) => info?.slot)," in streaming
    assert "...Object.values(_peers).map((peer) => peer?.slot)," in streaming
    assert "export const controllerPresentMask = " in (STREAMING_TS / "roster.ts").read_text()
    assert "const _applyControllerPresentMask = (reason = 'tick') => {" in streaming
    assert "if (_playerSlot !== 0) return;" in streaming
    assert "mod._kn_set_controller_present_mask(mask);" in streaming
    assert "`controller present mask (${reason}): 0x${mask.toString(16)}`" in streaming
    assert "const _resetControllerPresentMask = () => {" in streaming
    assert "mod._kn_set_controller_present_mask(0x0f)" in streaming

    users_idx = streaming.find("const onUsersUpdated = (data) => {")
    assert users_idx != -1
    users_window = streaming[users_idx : users_idx + 2200]
    assert "_applyControllerPresentMask('users-updated');" in users_window

    host_idx = streaming.find("const startHost = () => {")
    assert host_idx != -1
    host_window = streaming[host_idx : host_idx + 1400]
    assert "_applyControllerPresentMask('emulator-ready');" in host_window

    stop_idx = streaming.find("const stop = () => {")
    assert stop_idx != -1
    stop_window = streaming[stop_idx : stop_idx + 1200]
    assert "_resetControllerPresentMask();" in stop_window


def test_streaming_late_join_waits_until_guest_listener_is_ready():
    streaming = STREAMING_JS.read_text()
    play = PLAY_JS.read_text()
    session = (ROOT / "web/src/session.ts").read_text()

    assert "socket.on('data-message', onDataMessage);" in streaming
    assert "socket.off('data-message', onDataMessage);" in streaming
    assert "data.type !== 'streaming-late-join-ready'" in streaming
    assert "type: 'streaming-late-join-ready'" in streaming
    assert "senderSid: socket.id" in streaming
    assert "config.lateJoin && (_playerSlot !== 0 || _isSpectator)" in streaming

    users_idx = streaming.find("const onUsersUpdated = (data) => {")
    assert users_idx != -1
    users_window = streaming[users_idx : users_idx + 2800]
    assert "waiting for late-join ready before offer" in users_window
    assert "live: _gameRunning && !!_hostStream," in users_window
    assert "const fresh: RosterStep = input.live ? 'awaitReady' : 'offer';" in (STREAMING_TS / "roster.ts").read_text()

    data_idx = streaming.find("const onDataMessage = (data) => {")
    assert data_idx != -1
    data_window = streaming[data_idx : data_idx + 1800]
    assert "_rules.lateJoinReadyAction({" in data_window
    assert "roster: Object.entries(_knownPlayers)" in data_window
    assert "if (plan.create) peer = createPeer(remoteSid, plan.slot, true);" in data_window
    assert "sendOffer(remoteSid);" in data_window
    assert "resending pending offer" in data_window
    # A page joining a match in play is a late joiner, a spectator of a
    # streamed match included (the session machine, web/src/session.ts), and
    # play.js hands that to the engine, which then says it is listening.
    assert "const target = event.spectator && !event.streaming ? 'running' : 'lateJoinStarting';" in session
    assert "return state === 'lateJoinAwaitingRom' || state === 'lateJoinStarting';" in session
    assert "const lateJoin = _isLateJoin();" in play
    assert "      lateJoin,\n" in play


def test_streaming_direct_capture_is_default_with_blit_escape_hatch():
    streaming = STREAMING_JS.read_text()

    assert "const STREAM_CAPTURE_FPS = 60;" in streaming
    assert "const STREAM_CAPTURE_FRAME_MS = 1000 / STREAM_CAPTURE_FPS;" in streaming
    video = (STREAMING_TS / "video.ts").read_text()

    assert "const plan = _rules.capturePlan({" in streaming
    assert "const raw = params.get('streamCapture') || params.get('captureMode') || stored;" in video
    assert "return String(raw || '').toLowerCase() === 'blit' ? 'blit' : 'direct';" in video

    assert "const startDirectCanvasCapture = (srcCanvas, scaleDownBy) => {" in streaming
    assert "startDirectCanvasCapture(srcCanvas, plan.scale);" in streaming
    assert "_hostStream = srcCanvas.captureStream(STREAM_CAPTURE_FPS)" in streaming
    assert "export const TARGET_WIDTH = 640;" in video
    assert "export const TARGET_HEIGHT = 480;" in video
    assert "return Math.max(1, sh / TARGET_HEIGHT);" in video
    assert "return Math.max(1, sw / TARGET_WIDTH);" in video
    assert "const startBlitCanvasCapture = (srcCanvas, isSafari) => {" in streaming
    assert "captureCanvas.captureStream(isSafari ? STREAM_CAPTURE_FPS : 0)" in streaming
    assert "now - _lastCaptureAt < STREAM_CAPTURE_FRAME_MS - 0.5" in streaming
    assert "direct canvas capture failed, falling back to blit" in streaming
    assert "direct canvas capture disabled on Safari" in streaming

    assert "_rules.tuneEncoding(sender.getParameters(), _captureMode, _captureScaleDownBy)" in streaming
    assert "mode === 'direct' && scale > 1.001 ? { ...limits, scaleResolutionDownBy: scale } : limits" in video
    assert "capture=${_captureMode}" in streaming


def test_streaming_host_normalizes_timing_after_lockstep_resume():
    streaming = STREAMING_JS.read_text()

    video = (STREAMING_TS / "video.ts").read_text()
    assert "export const CORE_FPS_RESET_THRESHOLD = 70;" in video
    assert "_rules.coreFpsReset(elapsed, delta, now, _hostFrameRateResetCooldownUntil)" in streaming
    assert "const _normalizeStreamingTiming = (reason = 'start') => {" in streaming
    assert "window._kn_inStep = false;" in streaming
    assert "window._kn_frameTime = 0;" in streaming
    assert "window._kn_useRelativeCycles = false;" in streaming
    assert "mod._kn_set_deterministic?.(0);" in streaming
    assert "mod._kn_set_normalize_events?.(0);" in streaming
    assert "mod._toggle_fastforward?.(0);" in streaming
    assert "mod._toggle_slow_motion?.(0);" in streaming
    assert "mod._set_ff_ratio?.(1);" in streaming
    assert "mod._set_sm_ratio?.(1);" in streaming
    assert "mod._set_vsync?.(1);" in streaming
    assert "const _resetStreamingMainLoop = (reason) => {" in streaming
    assert "mod.pauseMainLoop?.();" in streaming
    assert "window.APISandbox?.nativeRAF" in streaming
    assert "mod.resumeMainLoop();" in streaming
    assert "const startHostFrameRateWatchdog = () => {" in streaming
    assert "streaming core fps high" in streaming
    assert "_normalizeStreamingTiming('fps-watchdog')" in streaming
    assert "_resetStreamingMainLoop('fps-watchdog')" in streaming
    assert "stopHostFrameRateWatchdog();" in streaming

    host_idx = streaming.find("const startHost = () => {")
    assert host_idx != -1
    host_window = streaming[host_idx : streaming.index('const renegotiate =', host_idx)]
    normalize_idx = host_window.find("_normalizeStreamingTiming('host-start')")
    frame_idx = host_window.find("const frames = gm.Module?._get_current_frame_count")
    watchdog_idx = host_window.find("startHostFrameRateWatchdog();")
    assert normalize_idx != -1
    assert frame_idx > normalize_idx
    assert watchdog_idx > frame_idx


def test_stream_overlay_uses_game_sized_flex_slot():
    css = PLAY_CSS.read_text()
    streaming = STREAMING_JS.read_text()
    vgp = VIRTUAL_GAMEPAD_MARKUP.read_text()

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
