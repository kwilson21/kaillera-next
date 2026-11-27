"""The host's follow-up to a resync answer it sent unconfirmed (specs/sync_follow_up.qnt).

The engine's own input-feeding helpers are run in Node with a stub core whose
misprediction count moves when a fed input differs from what it predicted.
"""

import json
import re
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _feed(watches, inputs, *, prime_inactive=False):
    """Feed `inputs` ([slot, frame, differs]) through _feedCInput with the
    given watches ({sid: frame}), each taken at a delay of 3 (DELAY_FRAMES);
    return each watch's `changed`."""
    src = LOCKSTEP_JS.read_text()
    start = src.index("const INPUT_PAST_WINDOW_FRAMES =")
    helpers = src[start : src.index("  const _backfillCInputsFromJs =", start)]
    roster_start = src.index("  let _lastInputRoster =")
    roster = src[roster_start : src.index("  // The oldest input", roster_start)]
    script = textwrap.dedent(
        f"""
        const {{ changesWatchedFrame, followUpIsUnneeded }} = await import('./web/src/sync-follow-up.ts');
        globalThis.window = {{ KNCore: {{ syncFollowUp: {{ changesWatchedFrame, followUpIsUnneeded }} }} }};
        const _syncLog = () => {{}};
        const _awaitFirstInputAfterReset = {{1: true}};
        const _playerSlot = 0, _frameNum = 100, _rbRollbackMax = 7, DELAY_FRAMES = 3;
        const RB_WORKER_COPROC = false;
        const native = [], escalations = [];
        const _onPastWindowMismatch = (slot, frame) => escalations.push([slot, frame]);
        const KNShared = {{ ZERO_INPUT: {{ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 }} }};
        const heap = new Int32Array(64);
        let mispredictions = 0;
        let differsNext = false;
        const mod = {{
          HEAP32: heap,
          _malloc: () => 16,
          _kn_get_mispred_breakdown: (ptr) => {{ heap[ptr >> 2] = mispredictions; return 3; }},
          _kn_get_failed_rollbacks: () => mispredictions,
          _kn_feed_input: (...input) => {{
            native.push(input);
            if (differsNext) mispredictions++;
          }},
        }};
        eval({json.dumps(helpers)} + {json.dumps(roster)} + `
          for (const [sid, frame] of Object.entries({json.dumps(watches)}))
            _followUpWatches.set(sid, {{ frame, delay: DELAY_FRAMES, changed: false }});
          for (const [slot, frame, differs] of {json.dumps(inputs)}) {{
            differsNext = differs;
            _feedCInput(mod, slot, frame, KNShared.ZERO_INPUT);
          }}
          if ({json.dumps(prime_inactive)}) {{
            _recordHostInputRoster(97, [0]);
            _recordHostInputRoster(100, [0, 1]);
            differsNext = true;
            _primeLateJoinInactiveInput(mod, 1);
            _primeLateJoinInactiveInput(mod, 1);
          }}
          const watched = Object.fromEntries([..._followUpWatches].map(([sid, w]) => [sid, w.changed]));
          process.stdout.write(JSON.stringify({json.dumps(prime_inactive)}
            ? {{ watched, native, escalations, stillAwaiting: _awaitFirstInputAfterReset[1] }}
            : watched));
        `);
        """
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)


def test_an_input_as_predicted_leaves_the_frame_unchanged():
    assert _feed({"g": 100}, [[1, 95, False], [1, 96, False], [1, 100, False]]) == {
        "g": False
    }


def test_an_input_that_ran_before_the_frame_and_differs_changes_it():
    # At a delay of 3 the state at the start of 100 holds inputs up to 96.
    assert _feed({"g": 100}, [[1, 95, False], [1, 96, True]]) == {"g": True}
    assert _feed({"g": 100}, [[2, 90, True]]) == {"g": True}


def test_an_input_labelled_within_the_delay_of_the_frame_does_not():
    # Labelled 97..100: runs at 100..103, after the state at 100 was taken
    # (specs/sync_follow_up.qnt, differsAtFMinusDelayTest).
    for frame in range(97, 101):
        assert _feed({"g": 100}, [[1, frame, True]]) == {"g": False}


def test_an_input_after_the_frame_does_not():
    assert _feed({"g": 100}, [[1, 101, True], [1, 140, True]]) == {"g": False}


def test_each_watch_is_judged_by_its_own_frame():
    assert _feed({"a": 100, "b": 98}, [[1, 95, True]]) == {"a": True, "b": False}


def test_the_skip_is_the_proved_rule_and_the_watch_starts_as_the_state_is_taken():
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    assert "window.KNCore.syncFollowUp.followUpIsUnneeded(" in dispatch
    assert "requeue(r, n, _followUpWatches.get(r.targetSid))" in dispatch
    # A send that did not go out is put back with no watch: sent regardless.
    assert "requeue(r, r.followUp || 0, null)" in dispatch
    push = src[src.index("const pushSyncState = async (") :]
    push = push[: push.index("_kn_sync_read(")]
    # The watch is set before the state is read, not after it is sent.
    # Starts changed when a correction is owed at the take (OWED_AT_TAKE),
    # judged by the proved rule, never for a sealed capture.
    capture = push.index("_captureSentSnapshotInputs(frame, delay)")
    watch = push.index("const watch = { frame, delay, changed: owed, delivered: false, inputs };")
    assert capture < watch
    assert "_followUpWatches.set(sid, watch);" in push
    assert "captureWatches.set(sid, watch);" in push
    assert "window.KNCore.syncFollowUp.correctionOwed(" in push
    assert "!capturedPublication &&" in push
    # With the delay that state ran under, the proved rule's.
    assert (
        "window.KNCore.syncFollowUp.delayOfStateAt(frame, DELAY_FRAMES, _ranBeforeDelayChange)"
        in push
    )
    # A watch superseded by a newer state is marked changed: its follow-up goes out.
    assert re.search(r"w\.changed = true;\s+_followUpWatches\.delete\(sid\);", push)
    # I2: a reset or the match ending drops the watches.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_followUpWatches.delete(opts.sid);" in reset
    assert "_followUpWatches.clear();" in src


def test_confirmed_absence_priming_notifies_the_watch_without_claiming_a_real_input():
    # Primed inputs 97..99 run at 100..102: a state at 101 or later holds them.
    result = _feed({"old": 100, "affected": 101, "later": 103}, [], prime_inactive=True)
    assert result == {
        "watched": {"old": False, "affected": True, "later": True},
        "native": [[1, frame, 0, 0, 0, 0, 0] for frame in range(97, 100)],
        "escalations": [],
        "stillAwaiting": True,
    }


def test_every_input_the_page_feeds_goes_through_the_watch():
    # Live inputs use the full wrapper. Proven inactive priming uses only
    # its underlying watch. Every direct feed must be inside one of the
    # wrappers; changing the number of sites alone cannot bless a bypass.
    src = LOCKSTEP_JS.read_text()
    direct = re.findall(r"\b\w+\._kn_feed_input\(", src)
    watched = re.findall(
        r"_feedWatched(?:Frame)?\([^,]+,\s*[^,]+,\s*[^,]+,\s*\(\) =>\s*(\w+\._kn_feed_input\()",
        src,
    )
    assert direct and direct == watched


def test_a_follow_up_is_skipped_only_for_a_delivered_state_with_no_phantom():
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    assert "!r.watch?.delivered" in dispatch
    assert "snapshotConfirmed(r.watch) || (confirmedFor(r) && readyToSend(r))" in dispatch
    # Delivered: only a transfer that ended `sent` marks the watch.
    chunks = src[src.index("const sendSyncChunks = async (") :]
    chunks = chunks[: chunks.index("\n  };\n")]
    assert (
        "if (outcomes[i] === 'sent' && w && w.frame === frame) w.delivered = true;"
        in chunks
    )


def test_the_misprediction_buffer_does_not_outlive_its_module():
    src = LOCKSTEP_JS.read_text()
    total = src[src.index("const _mispredTotal = (mod) => {") :]
    total = total[: total.index("\n  };\n")]
    assert "if (_mispredBufMod !== mod) {" in total
    stop = src[
        src.index(
            "// Free auxiliary WASM scratch buffers regardless of _useCRollback"
        ) :
    ]
    stop = stop[: stop.index("window._rbMispredBuf = 0;\n      _mispredBufPtr = 0;")]
    assert (
        "if (_mispredBufPtr && _mispredBufMod === stopMod) stopMod._free(_mispredBufPtr);"
        in stop
    )


def _answer_direct(
    *,
    confirmed,
    phantom=False,
    result="[]",
    c_rollback=True,
    reset=False,
    via=None,
    queued=None,
):
    """Run the engine's _answerDirectSyncRequest with a stub push that resolves
    to `result` (the skipped sids, or null when nothing went out); return the
    push options and the follow-ups it scheduled."""
    src = LOCKSTEP_JS.read_text()
    start = src.index(
        "  const _answerDirectSyncRequest = (sid, requestId, via = {}) => {"
    )
    helper = src[start : src.index("\n  };\n", start) + 5]
    script = textwrap.dedent(
        f"""
        const {{ directFollowUpDue, directWatchIsStale }} = await import('./web/src/sync-follow-up.ts');
        const _holdReconnectHostAnswer = () => false; // ordinary path; the guarded path has its own fixture
        globalThis.window = {{
          EJS_emulator: {{ gameManager: {{ Module: {{}} }} }},
          KNCore: {{ syncFollowUp: {{ directFollowUpDue, directWatchIsStale }} }},
        }};
        const _syncLog = () => {{}};
        const _useCRollback = {json.dumps(c_rollback)};
        const _liveStateConfirmed = () => {json.dumps(confirmed)};
        const _peers = {{ g: {{ slot: 1 }} }};
        const _peerPhantom = {{ 1: {json.dumps(phantom)} }};
        let _syncQueueEpoch = 1;
        const _syncQueueGen = {{}};
        const _armScheduledSyncClock = () => {{}};
        let _scheduledSyncRequests = {json.dumps(queued or [])};
        const _followUpWatches = new Map();
        const _directAnswerNewest = new Map();
        let _frameNum = 1986;
        const SYNC_COORD_TIMEOUT_MS = 3000;
        const pushes = [];
        const pushSyncState = (sid, proactive, options) => {{
          pushes.push({{ sid, proactive, options }});
          for (const w of options.watchFor || []) _followUpWatches.set(w, {{ frame: _frameNum }});
          return Promise.resolve({result});
        }};
        eval({json.dumps(helper)} + `
          _answerDirectSyncRequest('g', 7, {json.dumps(via or {})});
          if ({json.dumps(reset)}) _syncQueueEpoch++;
          _frameNum = 1990;
          setTimeout(() => process.stdout.write(JSON.stringify({{
            pushes, scheduled: _scheduledSyncRequests, watches: [..._followUpWatches.keys()],
          }})), 0);
        `);
        """
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)


def test_a_direct_answer_taken_unconfirmed_is_watched_and_followed_up():
    out = _answer_direct(confirmed=False)
    assert out["pushes"] == [
        {
            "sid": "g",
            "proactive": False,
            "options": {"requestIds": {"g": 7}, "watchFor": ["g"]},
        }
    ]
    [follow] = out["scheduled"]
    assert (
        follow["targetSid"] == "g"
        and follow["followUp"] == 1
        and follow["requestId"] == 7
    )
    # Due at the frame reached when the answer went out, with its watch.
    assert follow["targetFrame"] == 1990 and follow["watch"] == {"frame": 1986}


def test_a_direct_answer_to_a_phantom_is_left_to_its_recovery():
    # A phantom's recovery replaces any request queued for it with its own
    # resync; followed up meanwhile it would get a full state every deadline.
    out = _answer_direct(confirmed=True, phantom=True)
    assert out["pushes"][0]["options"]["watchFor"] == ["g"]
    assert out["scheduled"] == []


def test_a_direct_answer_is_watched_however_confirmed_it_looks_when_asked():
    # Confirmation is the dispatcher's to judge once the state was taken (a
    # push queued behind another is taken later), with any phantom peer making
    # it unconfirmed; the answer is always watched and its follow-up queued.
    for c_rollback, confirmed in ((True, True), (False, False)):
        out = _answer_direct(confirmed=confirmed, c_rollback=c_rollback)
        assert out["pushes"] == [
            {
                "sid": "g",
                "proactive": False,
                "options": {"requestIds": {"g": 7}, "watchFor": ["g"]},
            }
        ]
        assert len(out["scheduled"]) == 1


def test_the_dispatcher_skips_a_follow_up_only_with_no_phantom_peer():
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    assert "const anyPhantom = Object.values(_peerPhantom).some(Boolean);" in dispatch
    guard = dispatch.index("if (anyPhantom || !r.followUp || !r.watch?.delivered || r.watch.changed)")
    assert guard < dispatch.index("window.KNCore.syncFollowUp.followUpIsUnneeded(")


def test_a_direct_answer_not_sent_or_reset_since_schedules_nothing():
    for result in ("null", '["g"]'):
        out = _answer_direct(confirmed=False, result=result)
        # Not sent: its watch follows nothing and is dropped.
        assert out["scheduled"] == [] and out["watches"] == []
    out = _answer_direct(confirmed=False, reset=True)
    # Reset since: the watch is resetPeerState's to drop, not this answer's.
    assert out["scheduled"] == [] and out["watches"] == ["g"]


def test_the_direct_request_goes_through_the_watched_answer():
    src = LOCKSTEP_JS.read_text()
    handler = src[src.index("// Immediate (no -at: suffix): push now") :]
    handler = handler[: handler.index("// JSON messages")]
    assert "_answerDirectSyncRequest(remoteSid, requestId);" in handler
    assert "pushSyncState(" not in handler


def test_a_socket_request_is_answered_and_followed_up_over_the_socket():
    out = _answer_direct(
        confirmed=False, via={"transport": "socket", "reason": "bg-return"}
    )
    assert out["pushes"] == [
        {
            "sid": "g",
            "proactive": False,
            "options": {
                "requestIds": {"g": 7},
                "watchFor": ["g"],
                "transport": "socket",
                "reason": "bg-return",
            },
        }
    ]
    [follow] = out["scheduled"]
    assert follow["transport"] == "socket" and follow["followUp"] == 1


def test_a_socket_follow_up_is_dispatched_over_the_socket_and_a_socket_send_is_delivered():
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    # Reachable over the socket while the guest is known and the socket is
    # connected (an emit while it is down is buffered and sent on reconnect,
    # to an old socket id); one push each.
    assert "r.transport === 'socket' ? !!p && !!socket?.connected" in dispatch
    assert (
        "for (const r of viaSocket) push([r], r.targetSid, { transport: 'socket', reason: 'socket-follow-up' });"
        in dispatch
    )
    assert "...(r.transport ? { transport: r.transport } : {})," in dispatch
    # A socket send records the state delivered, so an unchanged follow-up is skipped.
    push = src[src.index("const pushSyncState = async (") :]
    push = push[: push.index("socket sync too large")]
    assert "if (watch && watch.frame === frame) watch.delivered = true;" in push
    # Checked again before the emit: the socket can drop while the state is
    # compressed. Reported as skipped, so a follow-up's retry is counted.
    guard = push.index("if (!socket?.connected) {")
    assert guard < push.index("_signalSocket.emit('data-message', {")
    assert "return [targetSid];" in push[guard : guard + 300]


def test_a_new_direct_answer_supersedes_a_queued_follow_up_to_the_same_guest():
    # Asked again over the socket after its data-channel answer stalled: the
    # earlier follow-up is dropped and this answer gets its own, over the socket.
    old = {"targetFrame": 1980, "targetSid": "g", "followUp": 1, "requestId": 6}
    other = {"targetFrame": 1980, "targetSid": "h", "followUp": 1, "requestId": 2}
    out = _answer_direct(
        confirmed=False, via={"transport": "socket"}, queued=[old, other]
    )
    assert out["scheduled"][0] == other
    [new] = out["scheduled"][1:]
    assert (
        new["targetSid"] == "g"
        and new["followUp"] == 1
        and new["transport"] == "socket"
    )
    # A coordinated request from it still queued answers it: no follow-up added.
    coord = {"targetFrame": 1990, "targetSid": "g", "requestId": 5}
    out = _answer_direct(
        confirmed=False, via={"transport": "socket"}, queued=[old, coord]
    )
    assert out["scheduled"] == [coord]


def _socket_request(src_text):
    """Run the engine's own handleSocketSyncRequest (and the helpers it calls)
    on a socket request from guest g, with a push stub that sends; return the
    push options and the follow-ups queued (sync_follow_up.qnt,
    socketUnconfirmedAnswerTest)."""
    start = src_text.index("  const handleSocketSyncRequest = (msg) => {")
    handler = src_text[start : src_text.index("\n  };\n", start) + 5]
    start = src_text.index("  const _answerDirectSyncRequest = (")
    helper = src_text[start : src_text.index("\n  };\n", start) + 5]
    script = textwrap.dedent(
        f"""
        const {{ directFollowUpDue, directWatchIsStale }} = await import('./web/src/sync-follow-up.ts');
        const _holdReconnectHostAnswer = () => false; // ordinary path; the guarded path has its own fixture
        globalThis.window = {{ KNCore: {{ syncFollowUp: {{ directFollowUpDue, directWatchIsStale }} }} }};
        const _syncLog = () => {{}};
        const _playerSlot = 0, PHASE_RUNNING = 'running', _phase = 'running';
        const _peers = {{ g: {{ slot: 1 }} }};
        const _peerKey = (s) => s;
        const _requestIdFrom = (n) => Number(n) || 0;
        const _peerPhantom = {{}};
        let _syncQueueEpoch = 1;
        const _syncQueueGen = {{}};
        const _armScheduledSyncClock = () => {{}};
        let _scheduledSyncRequests = [];
        const _followUpWatches = new Map();
        const _directAnswerNewest = new Map();
        let _frameNum = 1986;
        const SYNC_COORD_TIMEOUT_MS = 3000;
        const pushes = [];
        const pushSyncState = (sid, proactive, options) => {{
          pushes.push(options);
          for (const w of options.watchFor || []) _followUpWatches.set(w, {{ frame: _frameNum }});
          return Promise.resolve([]);
        }};
        eval({json.dumps(helper)} + {json.dumps(handler)} + `
          handleSocketSyncRequest({{ requesterSid: 'g', requestId: 4, reason: 'sync-chunk-timeout' }});
          setTimeout(() => process.stdout.write(JSON.stringify({{ pushes, scheduled: _scheduledSyncRequests }})), 0);
        `);
        """
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)


def test_a_socket_request_answered_unconfirmed_is_followed_up_over_the_socket():
    # Today's handler pushed with no watch and queued nothing: the guest kept
    # whatever state was taken, however unconfirmed.
    out = _socket_request(LOCKSTEP_JS.read_text())
    [push] = out["pushes"]
    assert push["watchFor"] == ["g"] and push["transport"] == "socket"
    assert push["requestIds"] == {"g": 4}
    [follow] = out["scheduled"]
    assert follow["targetSid"] == "g" and follow["followUp"] == 1
    assert follow["transport"] == "socket" and follow["requestId"] == 4


def test_only_the_newest_direct_answer_schedules_the_follow_up():
    # Two answers to one guest: the second's push is queued behind the first
    # and takes its state later. The first finishing must not schedule a
    # follow-up for its own (older) state: the second's, the state the guest
    # ends on, is the one followed up, with its request number (from #307).
    src = LOCKSTEP_JS.read_text()
    start = src.index(
        "  const _answerDirectSyncRequest = (sid, requestId, via = {}) => {"
    )
    helper = src[start : src.index("\n  };\n", start) + 5]
    script = textwrap.dedent(
        f"""
        const {{ directFollowUpDue, directWatchIsStale }} = await import('./web/src/sync-follow-up.ts');
        const _holdReconnectHostAnswer = () => false; // ordinary path; the guarded path has its own fixture
        globalThis.window = {{ KNCore: {{ syncFollowUp: {{ directFollowUpDue, directWatchIsStale }} }} }};
        const _syncLog = () => {{}};
        const _peers = {{ g: {{ slot: 1 }} }};
        const _peerPhantom = {{}};
        let _syncQueueEpoch = 1;
        const _syncQueueGen = {{}};
        const _armScheduledSyncClock = () => {{}};
        let _scheduledSyncRequests = [];
        const _followUpWatches = new Map();
        const _directAnswerNewest = new Map();
        let _frameNum = 1986;
        const SYNC_COORD_TIMEOUT_MS = 3000;
        const pending = [];
        // Each push takes its state (sets the watch) and finishes when told.
        const pushSyncState = (sid, proactive, options) => new Promise((resolve) => {{
          pending.push({{
            take: (frame) => _followUpWatches.set(sid, {{ frame }}),
            finish: () => resolve([]),
          }});
        }});
        const tick = () => new Promise((r) => setTimeout(r, 0));
        eval({json.dumps(helper)} + `
          (async () => {{
            _answerDirectSyncRequest('g', 7, {{ transport: 'socket', reason: 'r' }});
            _answerDirectSyncRequest('g', 8, {{ transport: 'socket', reason: 'r' }});
            pending[0].take(1986);
            pending[0].finish();
            await tick();
            const afterFirst = _scheduledSyncRequests.length;
            pending[1].take(1990);
            pending[1].finish();
            await tick();
            process.stdout.write(JSON.stringify({{ afterFirst, scheduled: _scheduledSyncRequests }}));
          }})();
        `);
        """
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    out = json.loads(result.stdout)
    assert out["afterFirst"] == 0
    [follow] = out["scheduled"]
    assert follow["requestId"] == 8 and follow["watch"] == {"frame": 1990}
    assert follow["transport"] == "socket"


def test_the_newest_answer_token_is_per_peer_state():
    # I2: resetPeerState and the stop clear it with the other per-guest state.
    src = LOCKSTEP_JS.read_text()
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_directAnswerNewest.delete(opts.sid);" in reset
    assert "_directAnswerNewest.clear();" in src


def test_unsent_follow_ups_count_against_the_bound_on_reachable_routes():
    # A rejected capture on a reachable route could be taken again every tick.
    # A closed route instead waits for reachability before trying again.
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    reachable = dispatch.index(
        "if ((skipped == null || skipped.includes(r.targetSid)) && reachable(r)) {"
    )
    closed = dispatch.index(
        "} else if (skipped === null || skipped?.includes(r.targetSid)) {"
    )
    assert reachable < closed
    branch = dispatch[reachable:closed]
    assert "const n = (r.followUp || 0) + 1;" in branch
    assert "if (n <= SYNC_FOLLOW_UP_MAX) {" in branch
    assert "requeue(r, n, null);" in branch


def test_an_in_flight_follow_up_yields_to_a_pending_direct_answer():
    # A follow-up already handed to pushSyncState when the guest asks again:
    # the new answer queues behind it. Requeued on completion, the old one
    # would stand as `replaced` for the new answer, which would then schedule
    # nothing for the state the guest ends on (#315 review).
    src = LOCKSTEP_JS.read_text()
    dispatch = src[src.index("const _dispatchScheduledSyncs = (isConfirmed) => {") :]
    dispatch = dispatch[: dispatch.index("\n  };\n")]
    after = dispatch[
        dispatch.index("const afterPush = (group, gens) => (skipped) => {") :
    ]
    replaced = after.index(
        "if (_scheduledSyncRequests.some((q) => q.targetSid === r.targetSid)) return;"
    )
    pending = after.index("if (_directAnswerNewest.has(r.targetSid)) {")
    assert replaced < pending
    assert pending < after.index("if ((skipped == null || skipped.includes(r.targetSid)) && reachable(r))")
    assert pending < after.index("requeue(r, r.followUp || 0, null);")
    assert pending < after.index("requeue(r, n, _followUpWatches.get(r.targetSid))")
