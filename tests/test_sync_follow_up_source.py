"""The host's follow-up to a resync answer it sent unconfirmed (specs/sync_follow_up.qnt).

The engine's own input-feeding helpers are run in Node with a stub core whose
misprediction count moves when a fed input differs from what it predicted.
"""

import json
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKSTEP_JS = ROOT / "web" / "static" / "netplay-rollback.js"


def _feed(watches, inputs):
    """Feed `inputs` ([slot, frame, differs]) through _feedCInput with the
    given watches ({sid: frame}); return each watch's `changed`."""
    src = LOCKSTEP_JS.read_text()
    start = src.index("const INPUT_PAST_WINDOW_FRAMES =")
    helpers = src[start : src.index("// -- Audio (delegated", start)]
    script = textwrap.dedent(
        f"""
        const {{ changesWatchedFrame, followUpIsUnneeded }} = await import('./web/src/sync-follow-up.ts');
        globalThis.window = {{ KNCore: {{ syncFollowUp: {{ changesWatchedFrame, followUpIsUnneeded }} }} }};
        const _syncLog = () => {{}};
        const KNShared = {{ ZERO_INPUT: {{ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 }} }};
        const heap = new Int32Array(64);
        let mispredictions = 0;
        let differsNext = false;
        const mod = {{
          HEAP32: heap,
          _malloc: () => 16,
          _kn_get_mispred_breakdown: (ptr) => {{ heap[ptr >> 2] = mispredictions; return 3; }},
          _kn_feed_input: () => {{ if (differsNext) mispredictions++; }},
        }};
        eval({json.dumps(helpers)} + `
          for (const [sid, frame] of Object.entries({json.dumps(watches)}))
            _followUpWatches.set(sid, {{ frame, changed: false }});
          for (const [slot, frame, differs] of {json.dumps(inputs)}) {{
            differsNext = differs;
            _feedCInput(mod, slot, frame, KNShared.ZERO_INPUT);
          }}
          process.stdout.write(JSON.stringify(Object.fromEntries(
            [..._followUpWatches].map(([sid, w]) => [sid, w.changed]))));
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
    assert "_followUpWatches.set(sid, { frame, changed: false });" in push
    # I2: a reset or the match ending drops the watches.
    reset = src[src.index("const resetPeerState = (slot, reason, opts = {}) => {") :]
    reset = reset[: reset.index("\n  };\n")]
    assert "_followUpWatches.delete(opts.sid);" in reset
    assert "_followUpWatches.clear();" in src


def test_every_input_the_page_feeds_goes_through_the_watch():
    # The harness above drives _feedCInput; the drain of queued inputs is the
    # other live site. Both must go through the same wrapper, so no input
    # reaches C unseen by the watch.
    src = LOCKSTEP_JS.read_text()
    calls = [i for i in range(len(src)) if src.startswith("._kn_feed_input(", i)]
    assert len(calls) == 2, calls
    for i in calls:
        before = src[max(0, i - 200) : i]
        assert "_feedWatched(" in before, src[max(0, i - 200) : i + 40]
