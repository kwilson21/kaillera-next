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
    tick_idx = src.index("_rbBootConverged && rbApplyFrame >= 0")
    assert "const stallThreshold = _rbInputStallThreshold();" in src[tick_idx:]


def test_background_return_skips_resync_only_while_c_rollback_is_active():
    # #64/#69: fast-forwarding and wiping inputs creates holes neither peer can
    # refill, causing both to stall and phantom each other; stale freeze data
    # at visibilitychange must not send C rollback through that path.
    src = ROLLBACK_JS.read_text()
    fn_start = src.index("const _requestLifecycleFullResync = (reason) => {")
    fn_end = src.index("_visChangeHandler = () => {", fn_start)
    fn = src[fn_start:fn_end]
    fn = fn[: fn.rfind("};") + 2]
    script = f"""
const calls = {{ setLastSyncState: [], guards: [], socket: [], logs: [] }};
let _useCRollback = true;
let _frameNum = 100;
let _lastRemoteFrame = 400;
let _playerSlot = 1;
let _remoteInputs = {{ 0: {{ 100: {{ buttons: 1 }} }} }};
let _localInputs = {{ 100: {{ buttons: 2 }} }};
let _consecutiveResyncs = 0;
let _syncCheckInterval = 10;
let _resyncRequestInFlight = false;
let _syncTargetFrame = 0;
let _syncTargetDeadlineAt = 1;
const _syncBaseInterval = 20;
const DELAY_FRAMES = 2;
const KNState = {{ frameNum: 100 }};
const KNShared = {{ ZERO_INPUT: {{ buttons: 0 }} }};
const _peers = {{}};
const _setLastSyncState = (...args) => calls.setLastSyncState.push(args);
const _beginLifecycleResyncGuard = (...args) => calls.guards.push(args);
const _requestSocketFullResync = (...args) => {{ calls.socket.push(args); return true; }};
const _syncLog = (message) => calls.logs.push(message);
eval({json.dumps(fn)} + "\\n_requestLifecycleFullResync('bg-return');");
const rollback = {{ frame: _frameNum, inputs: _remoteInputs, localInputs: _localInputs, calls: JSON.parse(JSON.stringify(calls)) }};

_useCRollback = false;
_frameNum = 100;
_lastRemoteFrame = 104;
_remoteInputs = {{ 0: {{ 100: {{ buttons: 1 }} }} }};
_localInputs = {{ 100: {{ buttons: 2 }} }};
calls.setLastSyncState.length = calls.guards.length = calls.socket.length = calls.logs.length = 0;
eval({json.dumps(fn)} + "\\n_requestLifecycleFullResync('bg-return');");
process.stdout.write(JSON.stringify({{ rollback, lockstep: {{ frame: _frameNum, inputs: _remoteInputs, localInputs: _localInputs, calls }} }}));
"""
    result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr + result.stdout
    output = json.loads(result.stdout)

    rollback = output["rollback"]
    assert rollback["frame"] == 100
    assert rollback["inputs"] == {"0": {"100": {"buttons": 1}}}
    assert rollback["localInputs"] == {"100": {"buttons": 2}}
    assert rollback["calls"]["setLastSyncState"] == []
    assert rollback["calls"]["guards"] == []
    assert rollback["calls"]["socket"] == []
    assert "bg-return: rollback mode — no fast-forward/resync (behind=300)" in rollback["calls"]["logs"]

    lockstep = output["lockstep"]
    assert lockstep["frame"] == 104
    assert lockstep["inputs"] == {}
    assert lockstep["calls"]["setLastSyncState"] == [[None, "bg-return"]]
    assert lockstep["localInputs"] == {"104": {"buttons": 0}, "105": {"buttons": 0}}
    assert lockstep["calls"]["guards"] == [["bg-return"]]
    assert lockstep["calls"]["socket"] == [["bg-return"]]
