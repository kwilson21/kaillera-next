from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIO_BACKEND = (
    ROOT
    / "build/src/mupen64plus-libretro-nx/custom/mupen64plus-core/plugin/audio_libretro/audio_backend_libretro.c"
)
AUDIO_PATCH = ROOT / "build/patches/audio-backend-skip-output.patch"


def test_deterministic_audio_captures_before_openal_output():
    """Netplay audio must not depend on RetroArch/OpenAL being writable.

    A local iPhone/Chrome session showed AudioContext + AudioWorklet running
    while _kn_get_audio_samples() stayed at zero for the entire match. Capture
    therefore needs to happen at the AI buffer, before audio_batch_cb/OpenAL.
    """
    src = AUDIO_BACKEND.read_text()

    assert "static void kn_capture_audio_direct" in src
    assert "extern int kn_deterministic_mode;" in src
    assert "extern int16_t kn_audio_buffer[];" in src

    skip_idx = src.index("if (kn_skip_audio_output)")
    capture_idx = src.index("if (kn_deterministic_mode)", skip_idx)
    apple_idx = src.index("#ifdef __APPLE__", capture_idx)
    assert skip_idx < capture_idx < apple_idx

    capture_block = src[capture_idx:apple_idx]
    assert "kn_capture_audio_direct(raw_data, frames);" in capture_block
    assert "return;" in capture_block


def test_audio_backend_patch_contains_direct_capture():
    patch = AUDIO_PATCH.read_text()

    assert "kn_capture_audio_direct" in patch
    assert "kn_deterministic_mode" in patch
    assert "before the libretro/RetroArch/OpenAL output path" in patch
