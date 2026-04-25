"""Golden tests for kn_hash_registry exports.

Each test loads the shared RDRAM fixture and asserts that the hash
registry returns the FNV-1a of the actual bytes at the field's offset.
A wrong address regresses the test immediately — long before a real
match ever runs against the new code.

Test runner: pytest tests/hash-golden/

The test exercises the registry through a minimal C harness compiled
to a native shared library (see build_native.sh)."""
from __future__ import annotations

import ctypes
import pathlib

LIB_PATH = pathlib.Path(__file__).parent / "build" / "libkn_hash_registry_test.so"


def fnv1a(data: bytes) -> int:
    """FNV-1a 32-bit. Mirrors kn_hash_fnv1a in C — used to compute
    expected hash values from fixture bytes in goldens."""
    h = 0x811c9dc5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _load_lib():
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_stocks.argtypes = [ctypes.c_uint8, ctypes.c_int32]
    lib.kn_hash_stocks.restype = ctypes.c_uint32
    return lib


def test_kn_hash_stocks_matches_fixture_bytes(rdram_fixture):
    """For each player, kn_hash_stocks must equal FNV1a(byte at that
    player's stock_count offset). The actual byte values come from the
    fixture; the test asserts the C export reads from the right address."""
    lib = _load_lib()
    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    base = 0xA4F23  # KN_ADDR_PLAYER_STOCKS_BASE
    stride = 0x74   # KN_PLAYER_STRIDE
    for p in range(4):
        off = base + p * stride
        observed = bytes([rdram_fixture[off]])
        expected = fnv1a(observed)
        actual = lib.kn_hash_stocks(p, -1)
        assert actual == expected, (
            f"P{p+1} stocks @ 0x{off:X}: byte=0x{observed[0]:02x} "
            f"expected hash=0x{expected:08x} got 0x{actual:08x}"
        )


def test_kn_hash_stocks_invalid_player_returns_zero(rdram_fixture):
    """player_idx >= 4 must return 0 (defined behavior, not UB)."""
    lib = _load_lib()
    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))
    assert lib.kn_hash_stocks(4, -1) == 0
    assert lib.kn_hash_stocks(255, -1) == 0


def test_kn_hash_stocks_no_rdram_returns_zero():
    """When kn_get_rdram_ptr() returns NULL, hash must return 0."""
    lib = _load_lib()
    # Don't set RDRAM — accessor returns NULL.
    # (Reset by setting empty RDRAM for clean state.)
    lib.kn_test_set_rdram(b"", 0)
    assert lib.kn_hash_stocks(0, -1) == 0


def test_kn_hash_character_id_matches_fixture_bytes(rdram_fixture):
    """For each player, kn_hash_character_id must equal FNV1a of the
    4-byte char_id at the player's CSS struct offset."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_character_id.argtypes = [ctypes.c_uint8, ctypes.c_int32]
    lib.kn_hash_character_id.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    base = 0x13BA88     # KN_ADDR_P1_CSS_BASE
    stride = 0xBC       # KN_CSS_STRIDE
    field_off = 0x48    # KN_CSS_OFF_CHAR_ID
    size = 4

    for p in range(4):
        off = base + p * stride + field_off
        observed = bytes(rdram_fixture[off:off + size])
        expected = fnv1a(observed)
        actual = lib.kn_hash_character_id(p, -1)
        assert actual == expected, (
            f"P{p+1} character_id @ 0x{off:X}: bytes={observed.hex()} "
            f"expected hash=0x{expected:08x} got 0x{actual:08x}"
        )


def test_kn_hash_css_cursor_matches_fixture_bytes(rdram_fixture):
    """For each player, kn_hash_css_cursor must equal FNV1a of the
    4-byte cursor_state at the player's CSS struct offset."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_css_cursor.argtypes = [ctypes.c_uint8, ctypes.c_int32]
    lib.kn_hash_css_cursor.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    base = 0x13BA88     # KN_ADDR_P1_CSS_BASE
    stride = 0xBC       # KN_CSS_STRIDE
    field_off = 0x54    # KN_CSS_OFF_CURSOR_STATE
    size = 4

    for p in range(4):
        off = base + p * stride + field_off
        observed = bytes(rdram_fixture[off:off + size])
        expected = fnv1a(observed)
        actual = lib.kn_hash_css_cursor(p, -1)
        assert actual == expected, (
            f"P{p+1} css_cursor @ 0x{off:X}: bytes={observed.hex()} "
            f"expected hash=0x{expected:08x} got 0x{actual:08x}"
        )


def test_kn_hash_css_selected_matches_fixture_bytes(rdram_fixture):
    """For each player, kn_hash_css_selected must equal FNV1a of the
    4-byte selected_flag at the player's CSS struct offset."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_css_selected.argtypes = [ctypes.c_uint8, ctypes.c_int32]
    lib.kn_hash_css_selected.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    base = 0x13BA88     # KN_ADDR_P1_CSS_BASE
    stride = 0xBC       # KN_CSS_STRIDE
    field_off = 0x58    # KN_CSS_OFF_SELECTED_FLAG
    size = 4

    for p in range(4):
        off = base + p * stride + field_off
        observed = bytes(rdram_fixture[off:off + size])
        expected = fnv1a(observed)
        actual = lib.kn_hash_css_selected(p, -1)
        assert actual == expected, (
            f"P{p+1} css_selected @ 0x{off:X}: bytes={observed.hex()} "
            f"expected hash=0x{expected:08x} got 0x{actual:08x}"
        )


def test_kn_hash_rng_matches_fixture_bytes(rdram_fixture):
    """kn_hash_rng must equal FNV1a of the 4-byte sSYUtilsRandomSeed."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_rng.argtypes = [ctypes.c_int32]
    lib.kn_hash_rng.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    off = 0x03B940  # KN_ADDR_SY_UTILS_RANDOM_SEED
    size = 4
    observed = bytes(rdram_fixture[off:off + size])
    expected = fnv1a(observed)
    actual = lib.kn_hash_rng(-1)
    assert actual == expected, (
        f"rng @ 0x{off:X}: bytes={observed.hex()} "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )


def test_kn_hash_match_phase_matches_fixture_bytes(rdram_fixture):
    """kn_hash_match_phase must equal FNV1a of the 1-byte scene_curr."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_match_phase.argtypes = [ctypes.c_int32]
    lib.kn_hash_match_phase.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    off = 0xA4AD0  # KN_ADDR_SCENE_CURR
    size = 1
    observed = bytes(rdram_fixture[off:off + size])
    expected = fnv1a(observed)
    actual = lib.kn_hash_match_phase(-1)
    assert actual == expected, (
        f"match_phase @ 0x{off:X}: bytes={observed.hex()} "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )


def test_kn_hash_vs_battle_hdr_matches_fixture_bytes(rdram_fixture):
    """kn_hash_vs_battle_hdr must equal FNV1a of the 32-byte
    SCManagerVSBattleState header at KN_ADDR_VS_BATTLE_HEADER."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_vs_battle_hdr.argtypes = [ctypes.c_int32]
    lib.kn_hash_vs_battle_hdr.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    off = 0xA4EF8  # KN_ADDR_VS_BATTLE_HEADER
    size = 32      # KN_SIZE_VS_BATTLE_HEADER
    observed = bytes(rdram_fixture[off:off + size])
    expected = fnv1a(observed)
    actual = lib.kn_hash_vs_battle_hdr(-1)
    assert actual == expected, (
        f"vs_battle_hdr @ 0x{off:X}: bytes={observed.hex()} "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )


def test_kn_hash_physics_motion_matches_fixture_bytes(rdram_fixture):
    """kn_hash_physics_motion must equal FNV1a of the 4 bytes at
    KN_ADDR_FT_MOTION_COUNT (gFTManagerMotionCount + StatUpdateCount)."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_physics_motion.argtypes = [ctypes.c_int32]
    lib.kn_hash_physics_motion.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    off = 0x130D94  # KN_ADDR_FT_MOTION_COUNT
    size = 4
    observed = bytes(rdram_fixture[off:off + size])
    expected = fnv1a(observed)
    actual = lib.kn_hash_physics_motion(-1)
    assert actual == expected, (
        f"physics_motion @ 0x{off:X}: bytes={observed.hex()} "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )


def test_kn_hash_ft_buffer_matches_fixture_bytes(rdram_fixture):
    """ft_buffer reads the FT alloc buffer via pointer indirection at 0x130D84,
    masks segment bits, and hashes KN_FT_BUFFER_SIZE bytes. Test extracts
    the same bytes the C export should read and asserts FNV-1a equality."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_ft_buffer.argtypes = [ctypes.c_int32]
    lib.kn_hash_ft_buffer.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    # Read the N64 virt addr at 0x130D84 (little-endian) and mask to RDRAM offset.
    ptr_bytes = rdram_fixture[0x130D84:0x130D84 + 4]
    n64_ptr = int.from_bytes(ptr_bytes, "little")
    assert n64_ptr != 0, "fixture FT alloc pointer is null"
    rdram_off = n64_ptr & 0x00FFFFFF
    assert rdram_off + 4096 <= len(rdram_fixture), "FT buffer overruns fixture"

    expected = fnv1a(rdram_fixture[rdram_off:rdram_off + 4096])
    actual = lib.kn_hash_ft_buffer(-1)
    assert actual == expected, (
        f"ft_buffer @ rdram_off=0x{rdram_off:X}: "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )
