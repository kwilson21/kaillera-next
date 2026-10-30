from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EMULATOR = ROOT / "web/static/ejs/emulator.min.js"


def test_missing_local_core_does_not_fetch_executable_code_from_a_cdn():
    source = EMULATOR.read_text()

    assert "https://cdn.emulatorjs.org/${t}/data/${o}" not in source
    assert "File not found locally" not in source
    assert '"Error downloading core"' in source
