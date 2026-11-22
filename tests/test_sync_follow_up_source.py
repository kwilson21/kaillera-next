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
    given watches ({sid: frame}); return each watch's `changed`."""
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
            _followUpWatches.set(sid, {{ frame, changed: false }});
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
    assert _feed({"g": 100}, [[1, 98, False], [1, 99, False], [1, 100, False]]) == {
        "g": False
    }


def test_an_input_that_differs_at_or_before_the_frame_changes_it():
    assert _feed({"g": 100}, [[1, 99, False], [1, 100, True]]) == {"g": True}
    assert _feed({"g": 100}, [[2, 90, True]]) == {"g": True}


def test_an_input_after_the_frame_does_not():
    assert _feed({"g": 100}, [[1, 101, True], [1, 140, True]]) == {"g": False}


def test_each_watch_is_judged_by_its_own_frame():
    assert _feed({"a": 100, "b": 90}, [[1, 95, True]]) == {"a": True, "b": False}


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
    assert (
        "_followUpWatches.set(sid, { frame, changed: false, delivered: false });"
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
    result = _feed({"old": 96, "affected": 97, "later": 99}, [], prime_inactive=True)
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
    assert "!!r.watch?.delivered," in dispatch
    assert "confirmedFor(r) && !anyPhantom," in dispatch
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
    socket=None,
    queued=(),
):
    """Run the engine's _answerDirectSyncRequest with a stub push that resolves
    to `result` (the skipped sids, or null when nothing went out); return the
    push options and the follow-ups it scheduled. `socket`: the request came
    over the socket ({reason}); `queued`: requests already scheduled."""
    src = LOCKSTEP_JS.read_text()
    start = src.index("  const _answerDirectSyncRequest = (sid, requestId, socket = null) => {")
    helper = src[start : src.index("\n  };\n", start) + 5]
    script = textwrap.dedent(
        f"""
        globalThis.window = {{ EJS_emulator: {{ gameManager: {{ Module: {{}} }} }} }};
        const _syncLog = () => {{}};
        const _useCRollback = {json.dumps(c_rollback)};
        const _liveStateConfirmed = () => {json.dumps(confirmed)};
        const _peers = {{ g: {{ slot: 1 }} }};
        const _peerPhantom = {{ 1: {json.dumps(phantom)} }};
        let _syncQueueEpoch = 1;
        const _syncQueueGen = {{}};
        let _scheduledSyncRequests = {json.dumps(list(queued))};
        const _followUpWatches = new Map();
        let _frameNum = 1986;
        const SYNC_COORD_TIMEOUT_MS = 3000;
        const pushes = [];
        const pushSyncState = (sid, proactive, options) => {{
          pushes.push({{ sid, proactive, options }});
          for (const w of options.watchFor || []) _followUpWatches.set(w, {{ frame: _frameNum }});
          return Promise.resolve({result});
        }};
        eval({json.dumps(helper)} + `
          _answerDirectSyncRequest('g', 7, {json.dumps(socket)});
          if ({json.dumps(reset)}) _syncQueueEpoch++;
          _frameNum = 1990;
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


def test_a_direct_answer_to_a_phantom_is_unconfirmed_for_it():
    out = _answer_direct(confirmed=True, phantom=True)
    assert out["pushes"][0]["options"]["watchFor"] == ["g"]
    assert len(out["scheduled"]) == 1


def test_a_confirmed_direct_answer_is_final():
    for c_rollback, confirmed in ((True, True), (False, False)):
        out = _answer_direct(confirmed=confirmed, c_rollback=c_rollback)
        assert out["pushes"] == [
            {
                "sid": "g",
                "proactive": False,
                "options": {"waitForResult": False, "requestIds": {"g": 7}},
            }
        ]
        assert out["scheduled"] == []


def test_a_direct_answer_not_sent_or_reset_since_schedules_nothing():
    assert _answer_direct(confirmed=False, result="null")["scheduled"] == []
    assert _answer_direct(confirmed=False, result='["g"]')["scheduled"] == []
    assert _answer_direct(confirmed=False, reset=True)["scheduled"] == []


def test_the_direct_request_goes_through_the_watched_answer():
    src = LOCKSTEP_JS.read_text()
    handler = src[src.index("// Immediate (no -at: suffix): push now") :]
    handler = handler[: handler.index("// JSON messages")]
    assert "_answerDirectSyncRequest(remoteSid, requestId);" in handler
    assert "pushSyncState(" not in handler


def test_a_socket_answer_taken_unconfirmed_is_watched_and_followed_up_over_the_socket():
    out = _answer_direct(confirmed=False, socket={"reason": "visibility"})
    assert out["pushes"] == [
        {
            "sid": "g",
            "proactive": False,
            "options": {
                "transport": "socket",
                "reason": "visibility",
                "requestIds": {"g": 7},
                "watchFor": ["g"],
            },
        }
    ]
    [follow] = out["scheduled"]
    assert follow["transport"] == "socket" and follow["followUp"] == 1
    assert follow["requestId"] == 7 and follow["watch"] == {"frame": 1986}


def test_a_channel_answer_schedules_its_follow_up_on_the_channel():
    [follow] = _answer_direct(confirmed=False)["scheduled"]
    assert follow["transport"] == "channel"


def test_a_confirmed_socket_answer_is_final_and_goes_over_the_socket():
    out = _answer_direct(confirmed=True, socket={"reason": "delta-base-missing"})
    assert out["pushes"][0]["options"] == {
        "transport": "socket",
        "reason": "delta-base-missing",
        "waitForResult": False,
        "requestIds": {"g": 7},
    }
    assert out["scheduled"] == []


def test_a_socket_answer_replaces_the_guests_queued_requests():
    # A request held for the guest's closed channel would stand in for the
    # follow-up ("a newer request replaces it") and never go out.
    held = {"targetSid": "g", "targetFrame": 1990, "transport": "channel"}
    other = {"targetSid": "h", "targetFrame": 1990, "transport": "channel"}
    out = _answer_direct(confirmed=False, socket={"reason": "visibility"}, queued=(held, other))
    assert [r["targetSid"] for r in out["scheduled"]] == ["h", "g"]
    assert out["scheduled"][1]["transport"] == "socket"
    # A request on the channel leaves them be, as before.
    out = _answer_direct(confirmed=False, queued=(held,))
    assert out["scheduled"] == [held]


def test_the_socket_request_goes_through_the_watched_answer():
    src = LOCKSTEP_JS.read_text()
    handler = src[src.index("const handleSocketSyncRequest = (msg) => {") :]
    handler = handler[: handler.index("\n  };\n")]
    assert "_answerDirectSyncRequest(requesterSid, _requestIdFrom(msg.requestId), {" in handler
    assert "transport: 'socket'," in handler
    assert "pushSyncState(" not in handler


def test_a_state_sent_whole_over_the_socket_marks_its_watch_delivered():
    src = LOCKSTEP_JS.read_text()
    push = src[src.index("const pushSyncState = async (") :]
    push = push[push.index("if (options.transport === 'socket') {") :]
    sent = push[: push.index("socket sync too large")]
    assert re.search(
        r"_signalSocket\.emit\('data-message', \{\s+type: 'sync-state-socket'.*"
        r"const w = _followUpWatches\.get\(targetSid\);\s+"
        r"if \(w && w\.frame === frame\) w\.delivered = true;",
        sent,
        re.DOTALL,
    )


def _dispatch(requests, *, confirmed, dc_open, result="[]", watches=None):
    """Run the engine's _dispatchScheduledSyncs once with `requests` queued,
    the peers' channels open or not (`dc_open`: {sid: bool}) and a stub push
    resolving to `result`; return the pushes, what stays queued and the log."""
    src = LOCKSTEP_JS.read_text()
    start = src.index("  const _dispatchScheduledSyncs = (isConfirmed) => {")
    helper = src[start : src.index("\n  };\n", start) + 5]
    script = textwrap.dedent(
        f"""
        const {{ changesWatchedFrame, followUpIsUnneeded }} = await import('./web/src/sync-follow-up.ts');
        globalThis.window = {{ KNCore: {{ syncFollowUp: {{ changesWatchedFrame, followUpIsUnneeded }} }} }};
        const logs = [];
        const _syncLog = (l) => logs.push(l);
        const _playerSlot = 0;
        let _pushingSyncState = false;
        const _frameNum = 2000;
        const _peers = {{}};
        let slot = 1;
        for (const [sid, open] of Object.entries({json.dumps(dc_open)}))
          _peers[sid] = {{ slot: slot++, syncDc: {{ readyState: open ? 'open' : 'closed' }} }};
        const _peerPhantom = {{}};
        const _followUpWatches = new Map(Object.entries({json.dumps(watches or {})}));
        const SYNC_COORD_TIMEOUT_MS = 3000;
        const SYNC_FOLLOW_UP_MAX = 3;
        let _syncQueueEpoch = 1;
        const _syncQueueGen = {{}};
        let _scheduledSyncRequests = {json.dumps(requests)}.map((r) => ({{
          ...r,
          watch: r.watch ? _followUpWatches.get(r.targetSid) ?? null : null,
        }}));
        const pushes = [];
        const pushSyncState = (sid, proactive, options) => {{
          pushes.push({{ sid, options }});
          return Promise.resolve({result});
        }};
        eval({json.dumps(helper)} + `
          _dispatchScheduledSyncs(() => {json.dumps(confirmed)});
          setTimeout(() => process.stdout.write(JSON.stringify({{
            pushes,
            queued: _scheduledSyncRequests.map((r) => ({{ sid: r.targetSid, transport: r.transport, followUp: r.followUp || 0 }})),
            logs,
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


def _req(sid, transport, *, watch=False, overdue=False):
    """A queued follow-up for frame 1990; `overdue`: its deadline has passed."""
    return {
        "targetSid": sid,
        "targetFrame": 1990,
        "followUp": 1,
        "requestId": 7,
        "transport": transport,
        "deadlineAt": 1 if overdue else 10**12,
        "watch": watch,
    }


def test_a_socket_follow_up_goes_out_over_the_socket_with_the_channel_down():
    out = _dispatch([_req("g", "socket")], confirmed=True, dc_open={"g": False})
    assert out["pushes"] == [
        {
            "sid": "g",
            "options": {
                "requestIds": {"g": 7},
                "watchFor": [],
                "transport": "socket",
                "reason": "sync-follow-up",
            },
        }
    ]
    assert out["queued"] == []


def test_a_channel_follow_up_is_held_while_the_channel_is_down():
    out = _dispatch([_req("g", "channel")], confirmed=True, dc_open={"g": False})
    assert out["pushes"] == []
    assert out["queued"] == [{"sid": "g", "transport": "channel", "followUp": 1}]
    # An entry with no transport (from before it was recorded) is the channel's.
    legacy = _req("g", "channel")
    del legacy["transport"]
    assert _dispatch([legacy], confirmed=True, dc_open={"g": False})["pushes"] == []


def test_socket_follow_ups_go_one_target_at_a_time_after_the_channels():
    out = _dispatch(
        [_req("a", "socket"), _req("b", "channel"), _req("c", "socket"), _req("d", "channel")],
        confirmed=True,
        dc_open={"a": True, "b": True, "c": True, "d": True},
    )
    # The channel ones together (a broadcast), the socket ones left queued.
    assert [p["sid"] for p in out["pushes"]] == [None]
    assert sorted(out["pushes"][0]["options"]["requestIds"]) == ["b", "d"]
    assert "transport" not in out["pushes"][0]["options"]
    assert [q["sid"] for q in out["queued"]] == ["a", "c"]
    # With only socket ones due: the first, alone, over the socket.
    out = _dispatch(
        [_req("a", "socket"), _req("c", "socket")],
        confirmed=True,
        dc_open={"a": True, "c": True},
    )
    assert [p["sid"] for p in out["pushes"]] == ["a"]
    assert out["pushes"][0]["options"]["transport"] == "socket"
    assert [q["sid"] for q in out["queued"]] == ["c"]


def test_a_socket_follow_up_sent_unconfirmed_is_requeued_over_the_socket():
    out = _dispatch([_req("g", "socket", overdue=True)], confirmed=False, dc_open={"g": False})
    assert out["pushes"][0]["options"]["watchFor"] == ["g"]
    assert out["queued"] == [{"sid": "g", "transport": "socket", "followUp": 2}]


def test_a_socket_follow_up_that_did_not_go_out_is_not_retried():
    for result in ("null", '["g"]'):
        out = _dispatch(
            [_req("g", "socket", overdue=True)],
            confirmed=False,
            dc_open={"g": False},
            result=result,
        )
        assert out["queued"] == []
        assert any("the guest asks again" in line for line in out["logs"])
    # A channel one is put back as before.
    out = _dispatch([_req("g", "channel")], confirmed=True, dc_open={"g": True}, result="null")
    assert out["queued"] == [{"sid": "g", "transport": "channel", "followUp": 1}]


def test_a_socket_follow_up_of_a_delivered_unchanged_state_is_skipped():
    watch = {"g": {"frame": 1990, "changed": False, "delivered": True}}
    out = _dispatch([_req("g", "socket", watch=True)], confirmed=True, dc_open={"g": False}, watches=watch)
    assert out["pushes"] == [] and out["queued"] == []
    assert any("SYNC-FOLLOW-UP-SKIPPED" in line for line in out["logs"])
    # Not marked delivered (the socket send before this change): it goes out regardless.
    watch["g"]["delivered"] = False
    out = _dispatch([_req("g", "socket", watch=True)], confirmed=True, dc_open={"g": False}, watches=watch)
    assert [p["sid"] for p in out["pushes"]] == ["g"]
