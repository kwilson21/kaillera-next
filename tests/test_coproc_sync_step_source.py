"""#62 changed stepOneFrame() so it can return false — after a no-op runner
that even a recapture+retry couldn't step — instead of always emulating the
frame. The normal tick path (_runStepOneFrame('normal')) and the replay path
(_runStepOneFrame('replay')) already skip _kn_post_tick when that happens.
The worker-coproc "Synchronous paint for frame T" block did not: it called
bare stepOneFrame() directly (manually toggling _inDeterministicStep around
it) and unconditionally ran the post-step RNG sync, feedAudio, and
_kn_post_tick afterward — so a frame stepOneFrame() didn't actually emulate
still got counted (_frameNum advanced). That is exactly the silent one-tick
desync R2 exists to prevent ("a counted frame must have been emulated
exactly once"; docs/netplay-invariants.md §R2).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_JS = ROOT / "web/static/netplay-rollback.js"


def _sync_step_block(src: str) -> str:
    start = src.index("// ── Synchronous paint for frame T")
    end = src.index("worker-coproc sync-step threw")
    return src[start:end]


def test_sync_step_uses_run_step_one_frame_not_bare_step():
    src = ROLLBACK_JS.read_text()
    block = _sync_step_block(src)

    assert "_runStepOneFrame('coproc-sync')" in block, (
        "worker-coproc sync-step must route through _runStepOneFrame so a "
        "non-emulated frame is detected the same way the normal/replay "
        "paths detect it"
    )
    # No bare `stepOneFrame()` call left in this block — only via the
    # _runStepOneFrame wrapper.
    assert not re.search(r"\bstepOneFrame\(\)", block), (
        "sync-step must not call stepOneFrame() directly; it must go "
        "through _runStepOneFrame so a false return skips post_tick"
    )


def test_sync_step_skips_post_tick_and_logs_when_not_emulated():
    src = ROLLBACK_JS.read_text()
    block = _sync_step_block(src)

    call_idx = block.index("_runStepOneFrame('coproc-sync')")
    # The call result must be checked with an `if (` guard before post_tick
    # runs, and _kn_post_tick must appear only once in the block (on the
    # success branch).
    assert "if (_runStepOneFrame('coproc-sync'))" in block, (
        "_runStepOneFrame call must be inside an if-condition"
    )

    post_tick_matches = [m.start() for m in re.finditer(r"_kn_post_tick\(\)", block)]
    assert len(post_tick_matches) == 1, "_kn_post_tick must run on exactly one branch (the success branch)"
    assert post_tick_matches[0] > call_idx, "_kn_post_tick must come after the step call, inside the success branch"

    # Post-step RNG sync and feedAudio must also be after the call, inside
    # the success branch (before post_tick).
    sync_rng_matches = [m.start() for m in re.finditer(r"_syncRNGSeed\(tickMod, _frameNum\)", block)]
    assert len(sync_rng_matches) == 2, "expected pre-step and post-step _syncRNGSeed calls"
    assert sync_rng_matches[1] > call_idx
    assert sync_rng_matches[1] < post_tick_matches[0]

    feed_audio_idx = block.index("feedAudio()")
    assert call_idx < feed_audio_idx < post_tick_matches[0]

    # A not-emulated step must be logged so the next regular tick advancing
    # frame T is diagnosable, not silent.
    assert "step did not emulate" in block
    skip_log_idx = block.index("step did not emulate")
    assert skip_log_idx > call_idx, "the skip log must be on the failure branch, after the step call"
