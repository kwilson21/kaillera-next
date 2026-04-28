from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIO_JS = ROOT / "web/static/kn-audio.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-lockstep.js"


def test_lockstep_audio_retries_resume_and_keeps_gesture_listener_armed():
    source = AUDIO_JS.read_text()
    lockstep = LOCKSTEP_JS.read_text()

    assert "function ensureRunning(reason = 'manual')" in source
    assert "document.addEventListener('pointerdown', _resumeAudioHandler, true)" in source
    assert "AudioContext resume failed" in source
    assert "audio resume attempt (${reason})" in source
    assert "window.knShowToast?.('Audio blocked" in source
    assert "ensureRunning," in source

    assert "_audio.ensureRunning?.('visibility-return')" in lockstep


def test_script_processor_fallback_drops_oldest_samples_on_overflow():
    source = AUDIO_JS.read_text()

    assert "window._kn_audioRingCount + 2 > rSize" in source
    assert "window._kn_audioRingRead = (window._kn_audioRingRead + 2) % rSize" in source
    assert "Drop the oldest stereo sample on overflow" in source
