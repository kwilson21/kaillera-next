"""In-retention ordering against the runtime fence, not a substitute guard.

Real runtime reset-ledger, native queue, direct answer and final capture
admission functions run in Node. Byte I/O and WASM are controlled stand-ins.
"""
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "web" / "static" / "netplay-rollback.js"


def _between(source, begin, end):
    start = source.index(begin)
    return source[start : source.index(end, start)]


def _race(*, transport, order, tag):
    source = RUNTIME.read_text()
    runtime = "\n".join(
        (
            _between(source, "  const _settleInputsBefore =", "  let _rbConvergedLogged"),
            _between(source, "  const _drainPendingCInputs =", "  const _formatInputBrief"),
            _between(source, "  // A reconnect receipt", "  const _requestIdFrom ="),
            _between(source, "  const _answerDirectSyncRequest =", "  // True when this peer"),
            _between(source, "  const _setPacingPhantom =", "  const markPeerPhantomForStallTimeout ="),
            _between(source, "  const _liveStateConfirmed =", "  // The earliest consumed remote input"),
        )
    )
    script = """
    import * as syncFollowUp from './web/src/sync-follow-up.ts';
    const PHASE_RUNNING = 5, _phase = PHASE_RUNNING, _playerSlot = 0;
    const KNState = {matchId: 'm'}, _config = {};
    const _useCRollback = true, _hasKnSync = true, RB_WORKER_COPROC = false;
    const _activeRoster = new Set([0, 1, 2]), _knownPlayers = {M: {persistentId: 'mover'}};
    const _admissionInputFloor = () => 0, _cutGoverns = () => false, _inputFloor = () => 0;
    const _inputSettledBefore = {}, _pendingCInputs = [], _remoteInputs = {1: {}};
    const _keptSlotFirstInputAt = new Map();
    const _syncQueueEpoch = 1, _syncQueueGen = {M: 1};
    const _directAnswerNewest = new Map(), _followUpWatches = new Map(), _peerPhantom = {};
    const _corePhantomHistory = new Set();
    const DELAY_FRAMES = 2, SYNC_COORD_TIMEOUT_MS = 100, KN_MAX_VISIBLE_ROLLBACK_DEPTH = 7;
    const RESYNC_MAX_ASKS_AGAIN = 2, RESYNC_REQUEST_TIMEOUT_MS = 8000;
    const RB_INPUT_ASK_EVERY_MS = 500, RB_INPUT_ASK_MAX = 8;
    const KNShared = {ZERO_INPUT: {}}, INPUT_PAST_WINDOW_FRAMES = 600;
    const _reconnectProofStatus = () => fixture.order !== 'mixed';
    const _requestIdFrom = id => Number.isSafeInteger(id) && id > 0 ? id : 0;
    const _inputEq = (a, b) => a.buttons === b.buttons;
    const socket = {connected: true}, asks = [];
    const _peers = {M: {slot: 1, dc: {readyState: 'open', send: s => asks.push(s)}, syncDc: {readyState: 'open'}},
      B: {slot: 2}};
    const getInputPeers = () => Object.values(_peers);
    // This bystander was connected and supplied all inputs in each scenario.
    const _missingConsumedInputs = peers => peers.filter(peer => peer !== _peers.B);
    let _frameNum = 100, _scheduledSyncRequests = [], now = 100, failed = 0;
    const performance = {now: () => now};
    const logs = [], feeds = [], captures = [];
    let nativeButtons = 0, replayOwed = false;
    const _syncLog = line => logs.push(line);
    const _pendingCInputsSortFn = (a, b) => a.frame - b.frame;
    const _primeLateJoinInactiveInput = () => {};
    const _feedWatched = (mod, slot, frame, feed) => feed();
    const tickMod = {
      _kn_get_failed_rollbacks: () => failed,
      _kn_get_frame: () => _frameNum,
      _kn_get_replay_depth: () => 0,
      _kn_peek_pending_rollback: () => replayOwed ? 96 : -1,
      _kn_feed_input(slot, frame, buttons) {
        feeds.push({slot, frame, buttons});
        if (frame < _frameNum - DELAY_FRAMES && buttons !== nativeButtons) replayOwed = true;
      }
    };
    let recoveryWake;
    const startEvery = (run) => {
      recoveryWake = run;
      return () => { recoveryWake = undefined; };
    };
    const window = {KNCore: {syncFollowUp, startEvery}, EJS_emulator: {gameManager: {Module: tickMod}}};
    const finishReplay = () => {
      if (replayOwed) nativeButtons = 128;
      replayOwed = false;
    };
    const receive = () => {
      _remoteInputs[1][fixture.tag] = {buttons: 128};
      _pendingCInputs.push({slot: 1, frame: fixture.tag, buttons: 128,
        author: fixture.order === 'unowned' ? null
          : fixture.order === 'stale-input' ? {_syncQueueEpoch, sid: 'M', peer: _peers.M, gen: 1}
          : _hostInputAuthor('M', _peers.M)});
    };
    // Stub physical I/O; run the application's actual native-admission guard.
    const _armScheduledSyncClock = () => {};
    const pushSyncState = async (sid, _proactive, options) => {
      await Promise.resolve();
      if (!_admitReconnectNativeCapture(options, tickMod)) return null;
      captures.push({sid, buttons: nativeButtons, transport: options.transport ?? 'dc'});
      if (sid) _settleInputsBefore(_peers[sid].slot, _frameNum);
      return [];
    };
    const ask = () => fixture.order === 'ordinary'
      ? _answerDirectSyncRequest('M', 9, {transport: fixture.transport})
      : _receiveReconnectProofRequest('M', 9, fixture.transport);
    const service = async () => {
      if (fixture.order === 'recovery-clock' || fixture.order === 'recovery-expiry' || recoveryWake) recoveryWake?.();
      else _serviceReconnectHostAnswers();
      await Promise.resolve();
      await Promise.resolve();
    };
    """
    scenario = """
    // Native already drained these exact tags except the deliberately missing one.
    for (let f = 91; f <= 97; f++) {
      if (f !== fixture.tag) {
        _remoteInputs[1][f] = {buttons: 0};
        _recordHostReconnectReceipt({slot: 1, frame: f, buttons: 0, author: _hostInputAuthor('M', _peers.M)});
      }
    }
    if (fixture.order !== 'ordinary') {
      _armHostReconnectDebt(1, 'reconnect', 'M', fixture.order === 'phantom', tickMod);
      _syncQueueGen.M++;
      _remoteInputs[1] = {}; // normal reset clears JS input state
    }
    if (['inputs-first', 'pacing-phantom-before-capture', 'pacing-phantom-after-advance', 'bystander-phantom', 'pacing-phantom-retry', 'pacing-phantom-stale-retry'].includes(fixture.order)) {
      receive();
      _drainPendingCInputs(tickMod);
      finishReplay();
    }
    ask();
    if (fixture.order.startsWith('pacing-phantom-')) _setPacingPhantom(1);
    if (fixture.order === 'pacing-phantom-after-advance') _frameNum += 2;
    if (fixture.order === 'bystander-phantom') _setPacingPhantom(2);
    await service();
    const capturesBeforeLateInput = captures.length;
    if (fixture.order.endsWith('phantom-retry') || fixture.order.endsWith('phantom-stale-retry')) {
      if (fixture.order.endsWith('stale-retry')) _syncQueueGen.M++;
      now = 601;
      _receiveReconnectProofRequest('M', 10, fixture.transport);
      await service();
    }
    let capturesAfterDrain = null;
    if (fixture.order === 'recovery-expiry') {
      now = 600;
      await service();
      now = 24100;
      await service();
    }
    if (['request-first', 'expiry', 'reset', 'overlap', 'window-loss', 'native-failure', 'unowned', 'stale-input', 'recovery-clock'].includes(fixture.order)) {
      if (fixture.order === 'expiry') {
        now = 24100;
        await service();
        ask();
      } else if (fixture.order === 'window-loss') {
        _frameNum = 106;
        await service();
      } else if (fixture.order === 'native-failure') {
        failed++;
        await service();
      } else if (fixture.order === 'reset') {
        _armHostReconnectDebt(1, 'reconnect', 'M', false, tickMod);
        _syncQueueGen.M++;
      } else if (fixture.order === 'overlap') {
        await pushSyncState(null, false, {});
        await pushSyncState('B', false, {});
      }
      receive();
      await service();
      _drainPendingCInputs(tickMod);
      await service();
      capturesAfterDrain = captures.length;
      finishReplay();
      await service();
    }
    process.stdout.write(JSON.stringify({captures, feeds, logs, asks, capturesBeforeLateInput,
      capturesAfterDrain, cutoff: _inputSettledBefore[1] ?? null}));
    """
    data = json.dumps({"transport": transport, "order": order, "tag": tag})
    result = subprocess.run(
        ["node", "--input-type=module", "-e", f"const fixture = {data};\n{script}\n{runtime}\n{scenario}"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("transport", ["dc", "socket"])
def test_reconnect_settlement_does_not_skip_an_owner_input_in_the_state(transport):
    actual = _race(transport=transport, order="request-first", tag=96)
    assert [feed["frame"] for feed in actual["feeds"]] == [96], actual
    assert (actual["capturesBeforeLateInput"], actual["capturesAfterDrain"]) == (0, 0), actual
    assert actual["captures"] == [{"sid": "M", "buttons": 128, "transport": transport}], actual
    assert actual["cutoff"] == 98
    assert "resend:96" in actual["asks"]
    assert not any("C-INPUT-SETTLED-SKIP" in line for line in actual["logs"]), actual


def test_input_already_replayed_is_in_immediate_answer():
    actual = _race(transport="dc", order="inputs-first", tag=96)
    assert actual["captures"] == [{"sid": "M", "buttons": 128, "transport": "dc"}]
    assert actual["capturesBeforeLateInput"] == 1


def test_input_exactly_at_settle_floor_is_not_discarded():
    actual = _race(transport="dc", order="request-first", tag=98)
    assert [feed["frame"] for feed in actual["feeds"]] == [98]
    assert actual["cutoff"] == 98


@pytest.mark.parametrize("transport", ["dc", "socket"])
@pytest.mark.parametrize("order", ["expiry", "reset", "window-loss", "native-failure"])
def test_expiry_and_reset_do_not_release_stale_answer(transport, order):
    actual = _race(transport=transport, order=order, tag=96)
    assert not actual["captures"], actual
    assert actual["cutoff"] is None
    if order != "reset":
        assert any("RECONNECT-HOST-UNRESOLVED" in line for line in actual["logs"])


def test_overlapping_room_and_other_guest_pushes_cannot_take_owed_state():
    actual = _race(transport="dc", order="overlap", tag=96)
    assert actual["captures"] == [{"sid": "M", "buttons": 128, "transport": "dc"}]


def test_ordinary_request_still_answers_without_reconnect_ledger():
    actual = _race(transport="dc", order="ordinary", tag=96)
    assert actual["capturesBeforeLateInput"] == 1


def test_real_routing_arms_reset_and_fences_native_capture_before_settlement():
    source = RUNTIME.read_text()
    reset = _between(source, "  const resetPeerState =", "    // Slot-indexed globals.")
    rest = source[source.index(reset) + len(reset) :]
    assert rest.index("_armHostReconnectDebt(") < rest.index("_clearSlotInputState(slot);")
    push = _between(source, "  const pushSyncState =", "  const _syncTargetsFor =")
    assert push.index("_recoveryTransfers.run(") < push.index("_admitReconnectNativeCapture(")
    assert push.index("_admitReconnectNativeCapture(") < push.index("mod._kn_sync_read(")
    assert "!mayDeliver(socketTarget)" in push
    install_guard = _between(source, "  const _syncStateCanInstall =", "  const applySyncState =")
    assert "if (!_guestAllowsReconnectState(answerFor, answerScope, proofFor)) return false;" in install_guard


@pytest.mark.parametrize("transport", ["dc", "socket"])
@pytest.mark.parametrize("order", ["phantom", "mixed", "unowned", "stale-input"])
def test_protected_requests_without_current_authored_proof_never_capture(transport, order):
    result = _race(transport=transport, order=order, tag=96)
    assert result["captures"] == []
    assert result["cutoff"] is None


def test_host_recovery_clock_resends_and_captures_only_after_native_replay_without_ticks():
    actual = _race(transport="dc", order="recovery-clock", tag=96)
    assert actual["asks"] == ["resend:96"]
    assert (actual["capturesBeforeLateInput"], actual["capturesAfterDrain"]) == (0, 0)
    assert actual["captures"] == [{"sid": "M", "buttons": 128, "transport": "dc"}]


def test_host_recovery_clock_expires_missing_proof_without_ticks():
    actual = _race(transport="dc", order="recovery-expiry", tag=96)
    assert actual["asks"] == ["resend:96", "resend:96"]
    assert actual["captures"] == []
    assert sum("reason=reconnect input proof expired" in line for line in actual["logs"]) == 1


def test_pacing_marker_cannot_invalidate_unchanged_confirmed_native_history():
    normal = _race(transport="dc", order="inputs-first", tag=96)
    phantom = _race(transport="dc", order="pacing-phantom-before-capture", tag=96)
    assert normal["feeds"] == phantom["feeds"]
    assert normal["captures"] == [{"sid": "M", "buttons": 128, "transport": "dc"}]
    assert phantom["captures"] == normal["captures"]
    assert phantom["cutoff"] == normal["cutoff"]


def test_pacing_marker_does_not_authorize_newly_consumed_unproved_inputs():
    phantom = _race(transport="dc", order="pacing-phantom-after-advance", tag=96)
    assert phantom["captures"] == []
    assert phantom["cutoff"] is None
    assert "resend:98" in phantom["asks"]


def test_returning_owner_proof_cannot_authorize_a_phantom_bystanders_history():
    phantom = _race(transport="dc", order="bystander-phantom", tag=96)
    assert phantom["captures"] == []
    assert phantom["cutoff"] is None

@pytest.mark.parametrize("transport", ["dc", "socket"])
def test_returning_phantom_can_retry_a_handoff_on_its_current_route(transport):
    result = _race(transport=transport, order="pacing-phantom-retry", tag=96)
    assert result["capturesBeforeLateInput"] == 1
    assert result["captures"] == [{"sid": "M", "buttons": 128, "transport": transport}] * 2


def test_returning_phantom_cannot_retry_the_previous_route():
    result = _race(transport="dc", order="pacing-phantom-stale-retry", tag=96)
    assert len(result["captures"]) == 1
