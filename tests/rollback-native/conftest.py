"""Pytest config for the native rollback engine tests.

Builds the engine against the stand-in core (build_native.sh) once per
session, from the C source as it is now."""

from __future__ import annotations

import ctypes
import pathlib
import subprocess

import pytest

_HERE = pathlib.Path(__file__).parent
_LIB_PATH = _HERE / "build" / "libkn_rollback_test.so"


@pytest.fixture(scope="session")
def lib() -> ctypes.CDLL:
    subprocess.run(["bash", str(_HERE / "build_native.sh")], check=True)
    lib = ctypes.CDLL(str(_LIB_PATH))
    lib.kn_get_state_for_frame.restype = ctypes.c_void_p
    return lib
