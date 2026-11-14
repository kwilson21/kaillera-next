from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# The logic of the pipeline; web/static/kn-audio.js only starts it on the page.
AUDIO_TS = ROOT / "web/src/page/audio.ts"
AUDIO_JS = ROOT / "web/static/kn-audio.js"
LOCKSTEP_JS = ROOT / "web/static/netplay-rollback.js"


def test_lockstep_audio_retries_resume_and_keeps_gesture_listener_armed():
    source = AUDIO_TS.read_text()
    lockstep = LOCKSTEP_JS.read_text()

    # The engine's window.KNAudio is the TypeScript pipeline, started on the page.
    assert "window.KNAudio = window.KNCore.page.startAudio(window);" in AUDIO_JS.read_text()

    assert "function ensureRunning(reason = 'manual')" in source
    assert "host.document.addEventListener('pointerdown', resumeAudioHandler, true)" in source
    assert "AudioContext resume failed" in source
    assert "audio resume attempt (${reason})" in source
    assert "host.knShowToast?.('Audio blocked" in source
    assert "ensureRunning," in source

    assert "_audio.ensureRunning?.('visibility-return')" in lockstep


def test_script_processor_fallback_drops_oldest_samples_on_overflow():
    source = AUDIO_TS.read_text()

    # `page` is the window: feed() calls pushPcm(host, ...), and the ring stays
    # in the window's _kn_audioRing* fields.
    assert "pushPcm(host, pcm, n);" in source
    assert "page._kn_audioRingCount + 2 > rSize" in source
    assert "page._kn_audioRingRead = (page._kn_audioRingRead + 2) % rSize" in source
    assert "Drop the oldest stereo sample on overflow" in source
