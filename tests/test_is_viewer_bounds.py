"""ROM-free native and build-wiring regression; no downloads or source-tree edits.

Run directly: python3 tests/test_is_viewer_bounds.py
Requires git, a sanitizer-capable C compiler (CC, default gcc), and the pinned
build source checkout (KN_MUPEN_SOURCE overrides build/src/mupen64plus-libretro-nx).
The tested C and headers come from git objects, not a possibly patched worktree.
"""

import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = (ROOT / "build/build.sh").read_text()
PIN = re.search(r'^MUPEN_SHA="([0-9a-f]{40})"', BUILD, re.M).group(1)
SOURCE = Path(os.environ.get("KN_MUPEN_SOURCE", ROOT / "build/src/mupen64plus-libretro-nx"))
PATCH = ROOT / "build/patches/mupen64plus-is-viewer-bounds.patch"
PREFIX = "mupen64plus-core/src/"
FILES = [
    "device/cart/is_viewer.c", "device/cart/is_viewer.h", "api/callbacks.h",
    "api/m64p_frontend.h", "api/m64p_types.h", "main/util.h", "osal/preproc.h",
]


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise AssertionError(f"{args!r} failed ({result.returncode}):\n{result.stdout}{result.stderr}")
    return result


@unittest.skipUnless(SOURCE.is_dir(), "requires pinned build source; see module docstring")
class IsViewerBounds(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kn-is-viewer-")
        self.addCleanup(self.temp.cleanup)
        self.tree = Path(self.temp.name)
        run(["git", "init", "-q", str(self.tree)])
        for name in FILES:
            dest = self.tree / PREFIX / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(run(["git", "-C", str(SOURCE), "show", f"{PIN}:{PREFIX}{name}"]).stdout)

    def apply_build_block(self, patch=PATCH, reset=False):
        # Exercise the exact fail-closed block the production build executes.
        start = BUILD.index('    git apply --check "${IS_VIEWER_PATCH}"')
        if reset:
            start = BUILD.rindex('    git checkout -- .', 0, start)
        end = BUILD.index('    echo "    Applied IS Viewer', start)
        return subprocess.run(
            ["bash", "-c", "set -euo pipefail\n" + BUILD[start:end]],
            cwd=self.tree, text=True, capture_output=True,
            env={**os.environ, "IS_VIEWER_PATCH": str(patch)},
        )

    def test_native_bounds(self):
        result = self.apply_build_block()
        self.assertEqual(result.returncode, 0, result.stderr)
        src = self.tree / PREFIX
        binary = self.tree / "bounds"
        command = shlex.split(os.environ.get("CC", "gcc")) + [
            "-std=c99", "-Wall", "-Wextra", "-Werror", "-g", "-O1",
            "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
            "-I", str(src), str(src / "device/cart/is_viewer.c"),
            str(ROOT / "tests/native/is_viewer_bounds.c"), "-o", str(binary),
        ]
        run(command)
        # No heap allocations in the harness; LSan cannot run under container ptrace.
        result = run([str(binary)], env={**os.environ, "ASAN_OPTIONS": "detect_leaks=0:halt_on_error=1", "UBSAN_OPTIONS": "halt_on_error=1"})
        print(result.stdout.strip())

    def test_missing_patch_fails_before_clone(self):
        # Copy only build.sh: it must fail before creating sources or using network.
        script = self.tree / "build.sh"
        script.write_text(BUILD)
        result = subprocess.run(["bash", str(script)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FATAL: missing required IS Viewer bounds patch", result.stderr)
        self.assertFalse((self.tree / "src").exists())

    def test_patch_drift_fails_closed(self):
        target = self.tree / PREFIX / "device/cart/is_viewer.c"
        target.write_text(target.read_text().replace("if (is_viewer->buffer_pos + word > IS_BUFFER_SIZE)", "if (0)"))
        before = target.read_bytes()
        result = self.apply_build_block()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FATAL: IS Viewer bounds patch failed", result.stderr)
        self.assertEqual(target.read_bytes(), before)

    def test_clean_rebuild_reapplies_patch(self):
        target = self.tree / PREFIX / "device/cart/is_viewer.c"
        run(["git", "add", "."], cwd=self.tree)
        run(["git", "-c", "user.name=Regression Test", "-c",
             "user.email=test@example.invalid", "commit", "-qm", "pinned source"], cwd=self.tree)
        self.assertEqual(self.apply_build_block(reset=True).returncode, 0)
        patched = target.read_bytes()
        run(["git", "apply", "--reverse", "--check", str(PATCH)], cwd=self.tree)
        # Execute the actual reset-and-apply sequence again on already-patched source.
        self.assertEqual(self.apply_build_block(reset=True).returncode, 0)
        self.assertEqual(target.read_bytes(), patched)
        reset = BUILD.index('    cd "${SRC_DIR}/mupen64plus-libretro-nx"')
        apply = BUILD.index('    git apply --check "${IS_VIEWER_PATCH}"')
        self.assertIn("git checkout -- .", BUILD[reset:apply])


if __name__ == "__main__":
    unittest.main(verbosity=2)
