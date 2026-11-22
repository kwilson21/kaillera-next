"""Issue #69: background return while C rollback is active must preserve inputs."""

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROLLBACK_JS = ROOT / "web/static/netplay-rollback.js"


def test_stall_threshold_formula_is_not_duplicated():
    # The tick loop's RB-INPUT-STALL gameplay stall uses the shared threshold
    # formula so it cannot drift from the rollback budget.
    src = ROLLBACK_JS.read_text()
    collapsed = re.sub(r"\s+", " ", src)

    formula = "RB_TRUE_ROLLBACK ? DELAY_FRAMES + KN_MAX_VISIBLE_ROLLBACK_DEPTH + 1 : DELAY_FRAMES + 4"
    assert collapsed.count(formula) == 1, "stall threshold formula must be defined exactly once"
    assert "const _rbInputStallThreshold = () =>" in src

    # The tick loop's gameplay stall must call the shared helper, not inline
    # its own copy of the formula.
    tick_idx = src.index("// Stall only when too far ahead for rollback to help")
    assert "const stallThreshold = _rbInputStallThreshold();" in src[tick_idx:]


def test_background_return_never_fast_forwards_or_resyncs():
    # #64/#69: fast-forwarding and wiping inputs creates holes neither peer can
    # refill, causing both to stall and phantom each other. Every frame runs
    # on the C engine now (specs/engine_start.qnt), so a return only logs; the
    # old path's fast-forward and full resync are gone.
    src = ROLLBACK_JS.read_text()
    assert "_requestLifecycleFullResync" not in src
    fn_start = src.index("const _noteLifecycleReturn = (reason) => {")
    fn_end = src.index("_visChangeHandler = () => {", fn_start)
    fn = src[fn_start:fn_end]
    fn = fn[: fn.rfind("};") + 2]
    assert "_useCRollback" not in fn
    script = f"""
const logs = [];
let _frameNum = 100;
let _lastRemoteFrame = 400;
let _remoteInputs = {{ 0: {{ 100: {{ buttons: 1 }} }} }};
let _localInputs = {{ 100: {{ buttons: 2 }} }};
const KNState = {{ frameNum: 100 }};
const _syncLog = (message) => logs.push(message);
eval({json.dumps(fn)} + "\\n_noteLifecycleReturn('bg-return');");
process.stdout.write(JSON.stringify({{ frame: _frameNum, knFrame: KNState.frameNum, inputs: _remoteInputs, localInputs: _localInputs, logs }}));
"""
    result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr + result.stdout
    output = json.loads(result.stdout)

    assert output["frame"] == 100
    assert output["knFrame"] == 100
    assert output["inputs"] == {"0": {"100": {"buttons": 1}}}
    assert output["localInputs"] == {"100": {"buttons": 2}}
    assert output["logs"] == ["bg-return: rollback mode — no fast-forward/resync (behind=300)"]
