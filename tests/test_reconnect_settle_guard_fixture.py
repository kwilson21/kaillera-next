"""Guarded proof fixture, not a runtime patch for netplay-rollback.js.

The guard executes immediately before the model's asynchronous capture seam.
The direct request and settlement/queue-drain bodies come from production JS.
"""

import json
import subprocess

import pytest

from test_reconnect_settle_source import ROOT, RUNTIME, _between


def _run_guard(transport, scenario):
    source = RUNTIME.read_text()
    runtime = "\n".join(
        (
            _between(source, "  const _settleInputsBefore =", "  let _rbConvergedLogged"),
            _between(source, "  const _drainPendingCInputs =", "  const _formatInputBrief"),
            _between(source, "  const _answerDirectSyncRequest =", "  // True when this peer"),
        )
    )
    script = """
    import * as syncFollowUp from './web/src/sync-follow-up.ts';
    import {makeReconnectSettleGuard} from './tests/fixtures/reconnect-settle-guard.mjs';
    const window = {KNCore: {syncFollowUp}};
    const _peers = {M: {slot: 1}, B: {slot: 2}};
    const _syncQueueEpoch = 1, _syncQueueGen = {M: 2};
    const _directAnswerNewest = new Map(), _followUpWatches = new Map(), _peerPhantom = {};
    const _inputSettledBefore = {}, _pendingCInputs = [];
    const _keptSlotFirstInputAt = new Map();
    const DELAY_FRAMES = 2, SYNC_COORD_TIMEOUT_MS = 100;
    let _frameNum = 100, _scheduledSyncRequests = [];
    let replayOwed = false, nativeButtons = 0;
    const stages = [], captures = [], logs = [];
    const _syncLog = line => logs.push(line);
    const _admissionInputFloor = () => 0;
    const _pendingCInputsSortFn = (a, b) => a.frame - b.frame;
    const _primeLateJoinInactiveInput = () => {};
    const _recordHostReconnectReceipt = () => {};
    const _holdReconnectHostAnswer = () => false;
    const _feedWatched = (mod, slot, frame, feed) => feed();
    const scope = {epoch: _syncQueueEpoch, sid: 'M', generation: _syncQueueGen.M};
    const guard = makeReconnectSettleGuard({
      scope, firstTag: 95, drainedBeforeReset: [95, 97], deadlineAt: 8000, failures: 0,
    });
    const current = { ...scope, frame: 100, nativeFrame: 100, delay: 2, nativeEdge: 93,
      now: 0, pendingRollback: false, replayDepth: 0, failedRollbacks: 0 };
    const tickMod = {_kn_feed_input(_slot, frame, buttons) {
      guard.authoredDrained(frame, current);
      if (frame < _frameNum - DELAY_FRAMES && buttons !== nativeButtons) replayOwed = true;
    }};
    let pending = [];
    const pushSyncState = (sid, _proactive, options) => {
      const id = options.requestIds[sid], transport = options.transport ?? 'dc';
      if (!guard.request({id, transport}, current)) return null;
      return new Promise(resolve => pending.push(resolve));
    };
    // Controlled async admission plus native read/delivery stand-in.
    const admit = async (name) => {
      await Promise.resolve();
      current.pendingRollback = replayOwed;
      const decision = guard.atCapture(current);
      if (decision.kind === 'capture') {
        captures.push({buttons: nativeButtons, ...decision.request});
        _settleInputsBefore(_peers.M.slot, _frameNum);
      }
      if (decision.kind !== 'wait') {
        for (const finish of pending) finish(decision.kind === 'capture' ? [] : null);
        pending = [];
      }
      stages.push({name, kind: decision.kind, cutoff: _inputSettledBefore[1] ?? null, pending: pending.length});
    };
    const ask = id => _answerDirectSyncRequest('M', id, {transport: fixture.transport});
    """
    cases = """
    ask(9);
    await admit('request first');
    if (fixture.scenario === 'expiry') {
      current.now = 8000;
      await admit('proof expired');
      ask(10);
      await admit('retry after expiration');
    } else if (fixture.scenario === 'outside-window') {
      current.now = 500;
      _frameNum = current.frame = current.nativeFrame = 106;
      current.nativeEdge = 97;
      await admit('debt fell outside the retained window');
    } else {
      _pendingCInputs.push({slot: 1, frame: 96, buttons: 128});
      await admit('received, not drained');
      _drainPendingCInputs(tickMod);
      await admit('drained, replay owed');
      if (fixture.scenario === 'reset') {
        current.generation = ++_syncQueueGen.M;
        _directAnswerNewest.clear();
        await admit('old-generation capture cancelled');
      } else {
        ask(10);
        if (fixture.scenario === 'native-failure') current.failedRollbacks++;
        replayOwed = false;
        nativeButtons = 128;
        await admit('native replay complete');
        if (fixture.scenario === 'replay') {
          ask(9);
          await admit('older retry cannot capture again');
        }
      }
    }
    await Promise.resolve();
    process.stdout.write(JSON.stringify({stages, captures, logs}));
    """
    data = json.dumps({"transport": transport, "scenario": scenario})
    result = subprocess.run(
        ["node", "--input-type=module", "-e", f"const fixture = {data};\n{script}\n{runtime}\n{cases}"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("transport", ["dc", "socket"])
def test_in_retention_capture_waits_for_native_correction(transport):
    actual = _run_guard(transport, "replay")
    assert [s["kind"] for s in actual["stages"]] == ["wait", "wait", "wait", "capture", "none"]
    assert [s["cutoff"] for s in actual["stages"]] == [None, None, None, 98, 98]
    assert actual["captures"] == [{"buttons": 128, "id": 10, "transport": transport}]
    assert not any("C-INPUT-SETTLED-SKIP" in line for line in actual["logs"])


@pytest.mark.parametrize("transport", ["dc", "socket"])
@pytest.mark.parametrize("scenario", ["expiry", "outside-window", "native-failure", "reset"])
def test_guard_never_releases_an_unproven_answer(transport, scenario):
    actual = _run_guard(transport, scenario)
    assert actual["stages"][-1]["kind"] == ("cancel" if scenario == "reset" else "unresolved"), actual
    assert actual["stages"][-1]["pending"] == 0, actual
    assert not actual["captures"], actual
    assert all(s["cutoff"] is None for s in actual["stages"]), actual
