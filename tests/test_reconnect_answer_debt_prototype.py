"""Review-only numbered guest obligation, with real JS routing excerpts."""
import json
import subprocess

import pytest

from test_reconnect_settle_source import ROOT, RUNTIME, _between


def _run(scenario):
    source = RUNTIME.read_text()
    excerpts = "\n".join(
        (
            _between(source, "  // Local reconnect-debt prototype:", "  const _requestIdFrom ="),
            _between(source, "  const handleSocketSyncState =", "  // Per-requester cooldown"),
            _between(source, "  async function _handleDecodedSyncPayload(", "  const handleSyncChunksComplete ="),
        )
    )
    mocks = """
    import {makeReconnectSettleGuard} from './tests/fixtures/reconnect-settle-guard.mjs';
    const PHASE_RUNNING = 5, _phase = PHASE_RUNNING, _playerSlot = 1, _isSpectator = false;
    const _peers = {H: {slot: 0}, M: {slot: 1}};
    const _syncQueueGen = {H: 2}, KNState = {matchId: 'first-match'};
    const RESYNC_MAX_ASKS_AGAIN = 2, RESYNC_REQUEST_TIMEOUT_MS = 8000, SYNC_DECODE_GRACE_MS = 10000;
    let _syncQueueEpoch = 1, _frameNum = 100, now = 100, _lastAppliedRecoveryId = 0;
    let _lastAppliedSyncHostFrame = -1, _pendingResyncState = null, _hostNumbersAnswers = true;
    let _resyncRequestInFlight = true, _resyncRequestId = 9;
    const logs = [], toasts = [], events = [];
    const _config = {onToast: s => toasts.push(s)};
    const performance = {now: () => now}, _syncLog = s => logs.push(s);
    const KNEvent = (...args) => events.push(args);
    const _isOwnSid = sid => sid === 'M', _peerKey = sid => sid;
    const _requestIdFrom = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
    const _resyncExtrasFromFields = () => null, _decodingSyncAnswer = fn => fn();
    const _keepsAwaitedAnswer = () => false, _endsResyncRequest = id => id === _resyncRequestId;
    let release;
    const decodeAndDecompress = () => new Promise(resolve => (release = () => resolve(new Uint8Array([1]))));
    """
    cases = """
    _startsReconnectAnswerDebt('H', _peers.H, 9);
    const expected = _reconnectAnswerScope('H');
    const send = (id) => handleSocketSyncState({
      senderSid: 'H', targetSid: 'M', requestId: id, data: 'x', frame: 100, full: true,
    });
    const deliver = async (id) => {
      const pending = send(id);
      release();
      await pending;
    };
    const observed = {};
    if (scenario === 'old-socket') {
      const pending = send(9);
      _syncQueueGen.H++;
      _peers.H = {slot: 0};
      _startsReconnectAnswerDebt('H', _peers.H, 10);
      release();
      await pending;
      observed.buffer = _pendingResyncState?.answerFor ?? null;
      _finishReconnectAnswer(10, expected, true);
    } else if (scenario === 'expiry') {
      await deliver(0);
      _finishReconnectAnswer(0, _pendingResyncState.answerScope, true);
      now = 34100;
      _checkReconnectAnswerDebt();
      _checkReconnectAnswerDebt();
      _finishReconnectAnswer(9, expected, true);
    } else if (scenario === 'old-match') {
      const pending = send(9);
      _syncQueueEpoch++;
      KNState.matchId = 'rematch';
      _startsReconnectAnswerDebt('H', _peers.H, 10);
      release();
      await pending;
      observed.buffer = _pendingResyncState?.answerFor ?? null;
      _finishReconnectAnswer(10, expected, true);
    } else {
      await deliver(0);
      let settlements = 0;
      const apply = (pending, aligned) => {
        if (!_guestAllowsReconnectState(pending.answerFor, pending.answerScope)) return;
        if (aligned) settlements++;
        _finishReconnectAnswer(pending.answerFor, pending.answerScope, aligned);
      };
      apply(_pendingResyncState, true);
      observed.opaqueBlockedBeforeSettlement = settlements === 0;
      observed.ordinaryRetainsDebt = _reconnectAnswerDebt?.id === 9;
      const hostScope = {epoch: 1, sid: 'M', generation: 2};
      const guard = makeReconnectSettleGuard({
        scope: hostScope, firstTag: 96, drainedBeforeReset: [97], failures: 0, deadlineAt: 8000,
      });
      const hostCurrent = {...hostScope, frame: 100, delay: 2, nativeFrame: 100,
        now: 100, nativeEdge: 93, replayDepth: 0, pendingRollback: false, failedRollbacks: 0};
      guard.request({id: 9, transport: 'socket'}, hostCurrent);
      observed.hostBeforeInput = guard.atCapture(hostCurrent).kind;
      guard.authoredDrained(96, hostCurrent);
      hostCurrent.pendingRollback = true;
      observed.hostBeforeReplay = guard.atCapture(hostCurrent).kind;
      hostCurrent.pendingRollback = false;
      const result = guard.atCapture(hostCurrent);
      if (result.kind === 'capture') await deliver(result.request.id);
      observed.decodeOnlyRetainsDebt = _reconnectAnswerDebt?.id === 9;
      await deliver(0);
      observed.retainsMatchedBuffer = _pendingResyncState.answerFor === 9;
      apply(_pendingResyncState, false);
      observed.failedLoadRetainsDebt = _reconnectAnswerDebt?.id === 9;
      apply(_pendingResyncState, true);
      observed.correctedOnce = settlements === 1;
      observed.ordinaryAllowedAfterFinish = _guestAllowsReconnectState(0, expected);
    }
    process.stdout.write(JSON.stringify({observed, status: _reconnectAnswerDebt?.status ?? null,
      id: _reconnectAnswerDebt?.id ?? null, toasts, events, logs}));
    """
    run = subprocess.run(
        ["node", "--input-type=module", "-e", f"const scenario={json.dumps(scenario)};\n{mocks}\n{excerpts}\n{cases}"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )
    return json.loads(run.stdout)


def test_actual_socket_routing_preserves_id_through_only_aligned_protected_apply():
    actual = _run("case")
    assert actual["observed"] == {
        "opaqueBlockedBeforeSettlement": True,
        "ordinaryRetainsDebt": True,
        "hostBeforeInput": "wait",
        "hostBeforeReplay": "wait",
        "decodeOnlyRetainsDebt": True,
        "retainsMatchedBuffer": True,
        "failedLoadRetainsDebt": True,
        "correctedOnce": True,
        "ordinaryAllowedAfterFinish": True,
    }
    assert actual["status"] is None
    assert sum(line.startswith("RECONNECT-ANSWER-APPLIED") for line in actual["logs"]) == 1


@pytest.mark.parametrize("case", ["old-match", "old-socket"])
def test_delayed_socket_from_old_epoch_or_replaced_host_cannot_answer(case):
    actual = _run(case)
    assert actual["observed"]["buffer"] is None
    assert (actual["status"], actual["id"], actual["toasts"]) == ("waiting", 10, [])


def test_timeout_is_explicit_once_and_late_answer_cannot_clear_it():
    actual = _run("expiry")
    assert (actual["status"], actual["id"]) == ("unresolved", 9)
    assert actual["toasts"] == ["Could not confirm game recovery after reconnecting."]
    assert len(actual["events"]) == 1


def test_prototype_arms_only_on_actual_host_reopen_and_routes_both_native_applies():
    source = RUNTIME.read_text()
    reconnect = _between(source, "        // Force resync", "          // Sync-state DC onopen handler")
    assert reconnect.count("_startsReconnectAnswerDebt(") == 1
    assert "peer.slot === 0 && _phase === PHASE_RUNNING && _useCRollback" in " ".join(reconnect.split())
    assert "handleSyncChunksComplete(ownsAssembly, _reconnectAnswerScope(_remoteSid))" in source
    assert " ".join(source.split()).count("pending.answerFor, pending.answerScope,") == 2
