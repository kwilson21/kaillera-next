import json
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHARED_JS = ROOT / "web/static/shared.js"
VIRTUAL_GAMEPAD_JS = ROOT / "web/static/virtual-gamepad.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"
SIGNALING_PY = ROOT / "server/src/api/signaling.py"


def _run_node(script: str) -> None:
    result = subprocess.run(
        ["node", "-e", textwrap.dedent(script)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_virtual_gamepad_axis_math_uses_clamped_distance():
    source = VIRTUAL_GAMEPAD_JS.read_text()

    assert "const rawDist = Math.sqrt(dx * dx + dy * dy);" in source
    assert "const clampedDist = Math.min(rawDist, STICK_RADIUS);" in source
    assert "const mag = clampedDist / STICK_RADIUS;" in source
    assert "const ax = (dx / clampedDist) * output * MAX_AXIS;" in source
    assert "const ay = (dy / clampedDist) * output * MAX_AXIS;" in source


def test_shared_writer_clamps_axes_for_native_controller_writer():
    script = r"""
      const fs = require('fs');
      global.performance = { now: () => 0 };
      global.document = { hasFocus: () => true };
      global.window = {
        document: global.document,
        KNState: { remapActive: false, touchInput: {} },
      };
      global.KNState = window.KNState;
      global.navigator = {};
      eval(fs.readFileSync('web/static/shared.js', 'utf8'));

      const writes = [];
      window.EJS_emulator = {
        gameManager: {
          Module: {
            _kn_write_controller: (...args) => writes.push(args),
          },
        },
      };
      const prevInputs = {};
      window.KNShared.applyInputToWasm(
        2,
        { buttons: 7, lx: 96, ly: -100, cx: 123, cy: -200 },
        prevInputs,
      );

      const expected = [2, 7, 83, -83, 83, -83];
      if (JSON.stringify(writes[0]) !== JSON.stringify(expected)) {
        throw new Error(`unexpected write ${JSON.stringify(writes[0])}`);
      }
      if (JSON.stringify(prevInputs[2]) !== JSON.stringify({ buttons: 7, lx: 83, ly: -83, cx: 83, cy: -83 })) {
        throw new Error(`prevInputs was not normalized: ${JSON.stringify(prevInputs[2])}`);
      }
    """
    _run_node(script)


def test_shared_touch_reader_clamps_oversized_touch_axes():
    script = r"""
      const fs = require('fs');
      global.performance = { now: () => 0 };
      global.document = { hasFocus: () => true };
      global.window = {
        document: global.document,
        KNState: {
          remapActive: false,
          touchInput: { 16: 50000, 17: 0, 18: 0, 19: 50000 },
        },
      };
      global.KNState = window.KNState;
      global.navigator = {};
      eval(fs.readFileSync('web/static/shared.js', 'utf8'));

      const input = window.KNShared.readLocalInput(0, null, new Set());
      if (input.lx !== 83 || input.ly !== -83) {
        throw new Error(`oversized touch axes were not clamped: ${JSON.stringify(input)}`);
      }
    """
    _run_node(script)


def test_socket_session_log_accepts_and_persists_input_audit():
    from src.api.payloads import SessionLogPayload

    payload = SessionLogPayload(
        matchId="m1",
        inputAudit={
            "localCount": 1,
            "remoteCount": {"1": 1},
            "local": [{"f": 1, "b": 0, "lx": 83, "ly": 0, "cx": 0, "cy": 0}],
            "remote": {"1": [{"f": 1, "b": 0, "lx": 0, "ly": 0, "cx": 0, "cy": 0}]},
        },
    )
    assert payload.inputAudit["localCount"] == 1

    source = SIGNALING_PY.read_text()
    assert 'context["inputAudit"] = payload.inputAudit' in source
    assert 'context.pop("inputAudit", None)' in source
    json.dumps(payload.inputAudit)


def test_lockstep_input_audit_resets_between_matches_and_flush_clones_payload():
    source = LOCKSTEP_JS.read_text()

    assert "const _resetInputAudit = () => {" in source
    assert "_auditLocalInputs.length = 0;" in source
    assert "for (const slot of Object.keys(_auditRemoteInputs)) delete _auditRemoteInputs[slot];" in source
    assert "for (const slot of Object.keys(_auditLastRemote)) delete _auditLastRemote[slot];" in source
    assert "const _buildInputAuditPayload = () => {" in source
    assert "local: _cloneAuditEntries(_auditLocalInputs)" in source
    assert "inputAudit: _buildInputAuditPayload()" in source

    init_idx = source.find("const init = (config) => {")
    assert init_idx != -1
    init_window = source[init_idx : init_idx + 500]
    reset_idx = init_window.find("_resetInputAudit();")
    config_idx = init_window.find("_config = config;")
    assert reset_idx != -1
    assert reset_idx < config_idx

    stop_idx = source.find("const stop = () => {")
    assert stop_idx != -1
    stop_window = source[stop_idx : stop_idx + 300]
    flush_idx = stop_window.find("_flushSyncLog();")
    stop_reset_idx = stop_window.find("_resetInputAudit();")
    assert flush_idx != -1
    assert stop_reset_idx != -1
    assert flush_idx < stop_reset_idx


def test_lockstep_input_discovery_uses_raw_simulate_export_after_guarding():
    source = LOCKSTEP_JS.read_text()

    wait_idx = source.find("const waitForEmu = () => {")
    assert wait_idx != -1
    wait_window = source[wait_idx : wait_idx + 6500]

    assert "const rawSimulateInputForDiscovery = mod?._kn_netplay_simulate_input || mod?._simulate_input;" in wait_window
    assert "const simulateInputForDiscovery = rawSimulateInputForDiscovery?.bind(mod);" in wait_window
    assert "if (!simulateInputForDiscovery)" in wait_window
    assert "simulateInputForDiscovery(0, 0, 1)" in wait_window
    assert "simulateInputForDiscovery(pi, 0, 1)" in wait_window
