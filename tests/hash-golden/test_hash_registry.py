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

    base = 0xA4D33  # KN_ADDR_LIVE_PLAYER_STOCKS_BASE
    stride = 0x74   # KN_PLAYER_STRIDE
    # The fixture is a two-player match in progress: P1 and P2 on 3 stocks.
    # The dormant copy at 0xA4F23 reads 0 for everyone.
    assert [rdram_fixture[(base + p * stride) ^ 3] for p in range(4)] == [3, 3, 0, 0]
    for p in range(4):
        off = base + p * stride
        # RDRAM is host-order 32-bit words: N64 byte A is at offset A ^ 3.
        observed = bytes([rdram_fixture[off ^ 3]])
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
    # RDRAM is host-order 32-bit words: N64 byte A is at offset A ^ 3. The
    # fixture is mid-match, so the scene is nSCKindVSBattle (22).
    observed = bytes([rdram_fixture[off ^ 3]])
    assert observed[0] == 22
    expected = fnv1a(observed)
    actual = lib.kn_hash_match_phase(-1)
    assert actual == expected, (
        f"match_phase @ 0x{off:X}: bytes={observed.hex()} "
        f"expected hash=0x{expected:08x} got 0x{actual:08x}"
    )


def test_kn_hash_vs_battle_hdr_matches_fixture_bytes(rdram_fixture):
    """kn_hash_vs_battle_hdr must equal FNV1a of the 32-byte header of the
    live battle state at KN_ADDR_LIVE_BATTLE_HEADER."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_vs_battle_hdr.argtypes = [ctypes.c_int32]
    lib.kn_hash_vs_battle_hdr.restype = ctypes.c_uint32

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))

    off = 0xA4D08  # KN_ADDR_LIVE_BATTLE_HEADER
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


def test_kn_get_scene_curr_reads_the_scene_byte(rdram_fixture):
    """The fixture is mid-match: scene_curr is nSCKindVSBattle (22). Reading
    offset 0xA4AD0 without the ^3 byte swap returned 7, so the detector's
    phase gate never saw a battle or the character select."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_get_scene_curr.restype = ctypes.c_uint8
    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))
    assert lib.kn_get_scene_curr() == 22


def test_replay_rewrites_the_history_for_its_frames(rdram_fixture):
    """A frame's history entry is the hash from its latest simulation. The
    forward pass of a frame can run on a mispredicted input; the replay that
    corrects it must replace that frame's hash, or two healthy peers report
    different hashes for the same confirmed frame."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_hash_rng.argtypes = [ctypes.c_int32]
    lib.kn_hash_rng.restype = ctypes.c_uint32
    lib.kn_hash_registry_post_tick.argtypes = [ctypes.c_int32, ctypes.c_int]
    lib.kn_hash_on_replay_enter.argtypes = [ctypes.c_int32]
    lib.kn_hash_on_replay_exit.argtypes = [ctypes.c_int32]

    seed = 0x03B940  # KN_ADDR_SY_UTILS_RANDOM_SEED
    frame = 900_001  # a frame no other test in this process has written

    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))
    lib.kn_hash_registry_post_tick(frame, 0)
    mispredicted = lib.kn_hash_rng(frame)
    assert mispredicted == fnv1a(rdram_fixture[seed:seed + 4])

    corrected_rdram = bytearray(rdram_fixture)
    corrected_rdram[seed] ^= 0xFF
    lib.kn_test_set_rdram(bytes(corrected_rdram), len(corrected_rdram))
    lib.kn_hash_on_replay_enter(frame - 1)
    lib.kn_hash_registry_post_tick(frame, 1)
    lib.kn_hash_on_replay_exit(frame)

    corrected = lib.kn_hash_rng(frame)
    assert corrected == fnv1a(bytes(corrected_rdram[seed:seed + 4]))
    assert corrected != mispredicted


MAP_COUNT = 14
SSB64_MAP = [0xA4D33, 0x74, 0xA4AD0, 0xA4D08, 32, 0x03B940, 0x13BA88, 0xBC, 0x48, 0x54, 0x58, 0x130D94, 0x130D84, 4096]


def _map_lib():
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.kn_field_map_set.argtypes = [ctypes.POINTER(ctypes.c_uint32), ctypes.c_uint32]
    lib.kn_field_map_set.restype = ctypes.c_int
    lib.kn_field_map_count.restype = ctypes.c_uint32
    lib.kn_field_map_value.argtypes = [ctypes.c_uint32]
    lib.kn_field_map_value.restype = ctypes.c_uint32
    lib.kn_hash_rng.argtypes = [ctypes.c_int32]
    lib.kn_hash_rng.restype = ctypes.c_uint32
    lib.kn_hash_registry_post_tick.argtypes = [ctypes.c_int32, ctypes.c_int]
    return lib


def _set_map(lib, values):
    return lib.kn_field_map_set((ctypes.c_uint32 * len(values))(*values), len(values))


def test_the_built_in_address_map_is_ssb64_us():
    """web/src/address-maps.ts carries the same numbers for SSB64 US; the
    TypeScript test compares its packed map with this list."""
    lib = _map_lib()
    assert _set_map(lib, SSB64_MAP) == 1
    assert lib.kn_field_map_count() == MAP_COUNT
    assert [lib.kn_field_map_value(i) for i in range(MAP_COUNT)] == SSB64_MAP
    assert lib.kn_field_map_value(MAP_COUNT) == 0xFFFFFFFF


def test_an_installed_map_moves_the_field_and_clears_the_history(rdram_fixture):
    lib = _map_lib()
    lib.kn_test_set_rdram(rdram_fixture, len(rdram_fixture))
    assert _set_map(lib, SSB64_MAP) == 1
    frame = 900_100
    lib.kn_hash_registry_post_tick(frame, 0)
    assert lib.kn_hash_rng(frame) == fnv1a(rdram_fixture[0x03B940:0x03B944])

    moved = list(SSB64_MAP)
    moved[5] = 0x03B944  # KN_MAP_RNG_SEED
    assert _set_map(lib, moved) == 1
    # A hash taken under the old map is of other memory: it is gone.
    assert lib.kn_hash_rng(frame) == 0
    assert lib.kn_hash_rng(-1) == fnv1a(rdram_fixture[0x03B944:0x03B948])
    assert _set_map(lib, SSB64_MAP) == 1


def test_a_map_that_does_not_fit_is_refused():
    lib = _map_lib()
    assert _set_map(lib, SSB64_MAP) == 1
    assert _set_map(lib, SSB64_MAP[:-1]) == 0
    outside_rdram = list(SSB64_MAP)
    outside_rdram[2] = 0x800000
    assert _set_map(lib, outside_rdram) == 0
    huge_stride = list(SSB64_MAP)
    huge_stride[1] = 0x10000
    assert _set_map(lib, huge_stride) == 0
    empty_header = list(SSB64_MAP)
    empty_header[4] = 0
    assert _set_map(lib, empty_header) == 0
    # A refused map changes nothing.
    assert [lib.kn_field_map_value(i) for i in range(MAP_COUNT)] == SSB64_MAP


def test_the_map_names_the_battle_state_the_match_runs_from(rdram_fixture):
    """SSB64 has two copies of the battle state. The game's own pointer
    (gSCManagerBattleState, 0x800A50E8) names the one in use; in this dump of
    a match in progress that is 0x800A4D08, whose status byte (+0x11) reads 1.
    The copy at 0x800A4EF8, which the map used to name, is dormant: status 0."""
    import struct

    def n64_byte(address):
        return rdram_fixture[address ^ 3]

    live = SSB64_MAP[3]
    (pointer,) = struct.unpack("<I", rdram_fixture[0xA50E8:0xA50EC])
    assert pointer == 0x80000000 | live
    assert n64_byte(live + 0x11) == 1
    assert n64_byte(0xA4EF8 + 0x11) == 0
    assert [n64_byte(0xA4F23 + p * 0x74) for p in range(4)] == [0, 0, 0, 0]
