"""The committed core must export everything the desync detector requires.

kn-desync-detector.js disables itself ("KNDesync disabled: core missing
exports ...") when any name in REQUIRED_EXPORTS is not a function on the
Emscripten module. A core built with KN_ENABLE_HASH_REGISTRY=0 has none of
them, which silently turned cross-peer desync detection off.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DETECTOR = ROOT / "web" / "static" / "kn-desync-detector.js"
CORE_JS = ROOT / "web" / "static" / "ejs" / "cores" / "mupen64plus_next_libretro.js"


def _required_exports() -> list[str]:
    src = DETECTOR.read_text()
    block = re.search(r"const REQUIRED_EXPORTS = \[(.*?)\];", src, re.DOTALL)
    assert block, "REQUIRED_EXPORTS not found in kn-desync-detector.js"
    return re.findall(r"['\"](_kn_\w+)['\"]", block.group(1))


def test_committed_core_exports_what_the_desync_detector_requires():
    required = _required_exports()
    assert len(required) >= 15
    glue = CORE_JS.read_text(errors="replace")
    missing = [
        name for name in required if not re.search(rf"\b{re.escape(name)}\b", glue)
    ]
    assert not missing, f"core is missing desync-detector exports: {missing}"


def test_build_script_enables_the_hash_registry_by_default():
    build = (ROOT / "build" / "build.sh").read_text()
    assert 'KN_ENABLE_HASH_REGISTRY="${KN_ENABLE_HASH_REGISTRY:-1}"' in build
