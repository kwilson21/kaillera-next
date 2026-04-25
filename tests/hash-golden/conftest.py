"""Pytest config for hash-golden tests.

Builds the native test library on first run; decompresses the
gzipped RDRAM fixture once per session into a temp file."""
from __future__ import annotations

import gzip
import pathlib
import subprocess
import tempfile

import pytest

_HERE = pathlib.Path(__file__).parent
_FIXTURE_GZ = _HERE / "fixtures" / "in-game-mid-match.rdram.gz"
_LIB_PATH = _HERE / "build" / "libkn_hash_registry_test.so"


@pytest.fixture(scope="session", autouse=True)
def _build_native_lib():
    if not _LIB_PATH.exists():
        script = _HERE / "build_native.sh"
        subprocess.run(["bash", str(script)], check=True)
    assert _LIB_PATH.exists()


@pytest.fixture(scope="session")
def rdram_fixture() -> bytes:
    """Decompress the gzipped fixture once per session and return the raw bytes."""
    with gzip.open(_FIXTURE_GZ, "rb") as f:
        raw = f.read()
    assert len(raw) == 8 * 1024 * 1024, (
        f"fixture decompressed to {len(raw)} bytes, expected 8MB"
    )
    return raw
