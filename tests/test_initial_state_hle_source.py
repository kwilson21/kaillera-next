"""Check initial HLE parity using the real startup code and shipped native WASM."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_native_initial_state_carries_the_rsp_hle_sidecar():
    result = subprocess.run(
        ["node", "--test", "tests/fixtures/initial-hle-startup.mjs"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
