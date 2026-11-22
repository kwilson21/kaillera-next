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
