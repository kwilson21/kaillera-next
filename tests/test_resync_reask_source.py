"""The deadline of a "now" resync request asks again (specs/resync_reask.qnt).

A "now" request (a reconnect, a network change, a tab shown again, a missing
delta base, the socket fallback) is sent because the guest's state is known
to be wrong. The host drops a request inside its rate limit, a channel can
lose one, and the guest drops an older request's answer that would take it
back, so the request can go unanswered. Its deadline used to let it go and
ask nothing. These tests pin the shape of the fix in netplay-rollback.js;
tests/rb-two-player.mjs with DOUBLE_RESYNC_ASK=1 drives it in a real match.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _body(src: str, start: str, end: str = "\n  };\n") -> str:
    i = src.index(start)
    return src[i : src.index(end, i)]


def test_a_now_request_marks_the_resync_owed_and_an_ask_again_does_not_reset_the_count():
    src = LOCKSTEP_JS.read_text()
    begin = _body(src, "const _beginResyncRequest = (at = -1, again = false) => {")
    # Every request but an ask again marks the resync owed, one at a frame
    # (peer recovery) too (specs/resync_reask.qnt, COORDINATED_OWES).
    assert "if (!again) {\n      _owedResync = true;\n      _owedResyncAsksAgain = 0;\n    }" in begin
    assert src.count("_owedResync = true;") == 1
    assert "let _owedResync = false;" in src
    assert "const RESYNC_MAX_ASKS_AGAIN = 2;" in src


def test_the_deadline_asks_again_bounded_and_the_lost_host_resync_goes_first():
    src = LOCKSTEP_JS.read_text()
    deadline = _body(src, "const _checkResyncRequestDeadline = () => {")
    # The step is the proved resyncDeadlineStep (web/src/resync-request.ts):
    # the lost-host resync first, then nothing owed, the bound, the ask again
    # (tests/ts/resync-request.test.ts).
    step = deadline.index("const step = window.KNCore.resyncRequest.resyncDeadlineStep(")
    for arg in ("_lateJoinLostHost,", "_owedResync,", "_owedResyncAsksAgain,", "RESYNC_MAX_ASKS_AGAIN,"):
        assert arg in deadline[step:]
    waits = deadline.index("if (step === 'noRequest' || step === 'wait') return;")
    # The request is let go before any step acts.
    let_go = deadline.index("_resyncRequestInFlight = false;")
    assert step < waits < let_go
    for call in (
        "if (step === 'lostHost') _resyncAfterLostHost('resync request timed out');",
        "else if (step === 'askAgain') _askAgainForOwedResync();",
        "else if (step === 'stopAsking') _stopAskingForOwedResync('its asks again went unanswered');",
    ):
        assert let_go < deadline.index(call)


def test_the_ask_again_counts_goes_on_the_channel_or_the_socket_and_otherwise_stops_visibly():
    src = LOCKSTEP_JS.read_text()
    ask = _body(src, "const _askAgainForOwedResync = () => {")
    assert "if (!_owedResync || _playerSlot === 0 || _phase !== PHASE_RUNNING) return;" in ask
    assert ask.index("_owedResyncAsksAgain++;") < ask.index("_beginResyncRequest(-1, true)")
    assert "_sendResyncRequest(hostDc, requestId, 'sync-request-full');" in ask
    assert "_requestSocketFullResync('resync-reask', true)" in ask
    # With no request out no deadline comes back: it must stop, not wait.
    assert ask.rstrip().endswith("_stopAskingForOwedResync('no channel to the host could carry the ask');")
    stop = _body(src, "const _stopAskingForOwedResync = (why) => {")
    assert "_owedResync = false;" in stop
    assert "RESYNC-REASK-GIVEUP" in stop
    assert "KNEvent('resync-reask-giveup'" in stop
    app = (ROOT / "server" / "src" / "api" / "app.py").read_text()
    assert '"resync-reask-giveup",' in app


def test_an_answer_being_decoded_holds_the_deadline_off_for_a_bounded_time():
    src = LOCKSTEP_JS.read_text()
    assert "const SYNC_DECODE_GRACE_MS = 10000;" in src
    wrap = _body(src, "const _decodingSyncAnswer = async (decode) => {")
    assert wrap.index("_syncDecodes++;") < wrap.index("return await decode();")
    assert "} finally {\n      _syncDecodes--;" in wrap
    # Both ways an answer arrives decode inside it.
    chunks = _body(src, "const handleSyncChunksComplete = async () => {")
    assert (
        "await _decodingSyncAnswer(async () => {\n        const decompressed = await decompressState(assembled);"
        in chunks
    )
    socket = _body(src, "const handleSocketSyncState = async (msg) => {")
    assert (
        "await _decodingSyncAnswer(async () => {\n        const decompressed = await decodeAndDecompress(msg.data);"
        in socket
    )
    assert src.count("await _decodingSyncAnswer(") == 2


def test_the_lifecycle_guard_timeout_gives_the_input_back_and_leaves_the_request_to_its_deadline():
    # specs/resync_reask.qnt, GUARD_LETS_GO: letting the request go there cut
    # short the deadline's ask again, sent with the guard still armed.
    src = LOCKSTEP_JS.read_text()
    at = src.index("const lifecycleGuardTimedOut =")
    block = src[at : src.index("const suppressResumeGuardInput", at)]
    assert "if (lifecycleGuardTimedOut) _clearLifecycleResyncGuard('lifecycle resync guard timeout');" in block
    assert "_resyncRequestInFlight" not in block.split("\n", 2)[2]


def test_the_owed_resync_ends_when_a_host_state_is_applied_or_the_match_ends():
    src = LOCKSTEP_JS.read_text()
    apply = _body(src, "const applySyncState = (bytes, frame, fromProactive = false) => {")
    assert apply.index("_lastAppliedSyncHostFrame = frame;") < apply.index("_owedResync = false;")
    stop_sync = _body(src, "const stopSync = () => {")
    assert "_owedResync = false;\n    _owedResyncAsksAgain = 0;" in stop_sync
    # The lost-host give-up ends the owed resync its asks marked.
    at = src.index("`LATE-JOIN-LOST-HOST-GIVEUP")
    give_up = src[at - 400 : at]
    assert "_owedResync = false;" in give_up
    # Every page reset that clears the lost-host marker clears this one too.
    assert src.count("_owedResync = false;") == 6
