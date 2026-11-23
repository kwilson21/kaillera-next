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
            _between(source, "  // Review-only host fence", "  const _requestIdFrom ="),
            _between(source, "  const _answerDirectSyncRequest =", "  // True when this peer"),
        )
    )
    script = """
    import * as syncFollowUp from './web/src/sync-follow-up.ts';
    const PHASE_RUNNING = 5, _phase = PHASE_RUNNING, _playerSlot = 0;
    const _useCRollback = true, _hasKnSync = true, RB_WORKER_COPROC = false;
    const _activeRoster = new Set([0, 1, 2]), _knownPlayers = {M: {persistentId: 'mover'}};
    const _admissionInputFloor = () => 0, _cutGoverns = () => false, _inputFloor = () => 0;
    const _inputSettledBefore = {}, _pendingCInputs = [], _remoteInputs = {1: {}};
    const _keptSlotFirstInputAt = new Map();
    const _syncQueueEpoch = 1, _syncQueueGen = {M: 1};
    const _directAnswerNewest = new Map(), _followUpWatches = new Map(), _peerPhantom = {};
    const DELAY_FRAMES = 2, SYNC_COORD_TIMEOUT_MS = 100, KN_MAX_VISIBLE_ROLLBACK_DEPTH = 7;
    const RESYNC_MAX_ASKS_AGAIN = 2, RESYNC_REQUEST_TIMEOUT_MS = 8000;
    const RB_INPUT_ASK_EVERY_MS = 500, RB_INPUT_ASK_MAX = 8;
    const KNShared = {ZERO_INPUT: {}};
    const socket = {connected: true}, asks = [];
    const _peers = {M: {slot: 1, dc: {readyState: 'open', send: s => asks.push(s)}, syncDc: {readyState: 'open'}},
      B: {slot: 2}};
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
    const window = {KNCore: {syncFollowUp}, EJS_emulator: {gameManager: {Module: tickMod}}};
    const finishReplay = () => {
      if (replayOwed) nativeButtons = 128;
      replayOwed = false;
    };
    const receive = () => {
      _remoteInputs[1][fixture.tag] = {buttons: 128};
      _pendingCInputs.push({slot: 1, frame: fixture.tag, buttons: 128});
    };
    // Stub physical I/O; run the application's actual native-admission guard.
    const pushSyncState = async (sid, _proactive, options) => {
      await Promise.resolve();
      if (!_admitReconnectNativeCapture(options, tickMod)) return null;
      captures.push({sid, buttons: nativeButtons, transport: options.transport ?? 'dc'});
      if (sid) _settleInputsBefore(_peers[sid].slot, _frameNum);
      return [];
    };
    const ask = () => _answerDirectSyncRequest('M', 9, {transport: fixture.transport});
    const service = async () => {
      _serviceReconnectHostAnswers();
      await Promise.resolve();
      await Promise.resolve();
    };
    """
    scenario = """
    // Native already drained these exact tags except the deliberately missing one.
    for (let f = 91; f <= 97; f++) {
      if (f !== fixture.tag) _remoteInputs[1][f] = {buttons: 0};
    }
    if (fixture.order !== 'ordinary') {
      _armHostReconnectDebt(1, 'reconnect', 'M', false, tickMod);
      _syncQueueGen.M++;
      _remoteInputs[1] = {}; // normal reset clears JS input state
    }
    if (fixture.order === 'inputs-first') {
      receive();
      _drainPendingCInputs(tickMod);
      finishReplay();
    }
    ask();
    await service();
    const capturesBeforeLateInput = captures.length;
    let capturesAfterDrain = null;
    if (['request-first', 'expiry', 'reset', 'overlap', 'window-loss', 'native-failure'].includes(fixture.order)) {
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
    assert "if (!_guestAllowsReconnectState(answerFor, answerScope)) return;" in source
