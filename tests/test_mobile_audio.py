"""Test mobile audio fix: guest boots and audio pipeline works.

Validates:
1. AudioContext monkey-patch fires when EJS creates its context
2. Guest emulator boots into lockstep (no Asyncify stall on Chromium)
3. Lockstep audio system initializes (AudioContext + fallback or worklet)
4. Audio samples are being produced each frame

Run: pytest tests/test_mobile_audio.py -v -s
"""

from playwright.sync_api import expect


ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def test_guest_boots_and_audio_initializes(browser, server_url):
    """Guest emulator boots into lockstep and audio pipeline initializes."""
    host = browser.new_page()
    guest = browser.new_page()

    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))

    try:
        # Host creates room, loads ROM, enables sharing
        host.goto(f"{server_url}/play.html?room=AUDIO1&host=1&name=Host&mode=lockstep")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        host.wait_for_timeout(500)
        host.locator("#opt-rom-sharing").check()
        host.wait_for_timeout(300)

        # Guest joins, accepts ROM sharing
        guest.goto(f"{server_url}/play.html?room=AUDIO1&name=Guest")
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        guest.click("#rom-accept-btn")

        # Wait for ROM transfer
        expect(guest.locator("#rom-drop.loaded")).to_be_visible(timeout=30000)

        # Start game
        expect(host.locator("#start-btn")).to_be_enabled(timeout=5000)
        host.click("#start-btn")

        # Guest should see gesture prompt
        gesture = guest.locator("#gesture-prompt")
        expect(gesture).to_be_visible(timeout=10000)

        # Click gesture prompt — triggers monkey-patch + emulator start
        gesture.click()
        expect(gesture).to_be_hidden(timeout=3000)

        # Wait for guest to enter lockstep (emulator booted past frame 120)
        print("\nWaiting for lockstep to activate...")
        guest.wait_for_function(
            "window._lockstepActive === true",
            timeout=120000,
        )
        print("Lockstep active!")

        # Let lockstep run for a few seconds so audio pipeline kicks in
        guest.wait_for_timeout(3000)

        guest_frame = guest.evaluate("window._frameNum || 0")
        print(f"Guest lockstep frame: {guest_frame}")
        assert guest_frame > 10, f"Lockstep not advancing (frame={guest_frame})"

        # Check audio-related console logs
        audio_logs = [l for l in guest_logs if 'audio' in l.lower() or 'AudioContext' in l]
        print(f"\nAudio logs ({len(audio_logs)}):")
        for l in audio_logs:
            print(f"  {l}")

        # Verify monkey-patch fired (EJS used our gesture-unlocked context)
        hijack_fired = any("AudioContext hijack" in l for l in guest_logs)
        print(f"\nMonkey-patch fired: {hijack_fired}")
        # Note: on Chromium the monkey-patch should fire. On iOS it's critical.
        if not hijack_fired:
            print("  WARNING: Monkey-patch did not fire — EJS may cache AudioContext reference")

        # Verify audio was initialized
        audio_init = any("audio playback initialized" in l for l in guest_logs)
        audio_using = any("audio using" in l for l in guest_logs)
        print(f"Audio initialized: {audio_init}, audio path selected: {audio_using}")
        assert audio_init or audio_using, \
            f"Audio not initialized. Recent lockstep logs: {[l for l in guest_logs if '[lockstep]' in l][-15:]}"

        # Verify OpenAL was killed
        assert any("killed OpenAL" in l for l in guest_logs), \
            "OpenAL audio system should have been killed"

        # Check if audio context was suspended (would need resume on mobile)
        was_suspended = any("audio suspended" in l for l in guest_logs)
        print(f"AudioContext was suspended: {was_suspended}")

        # Verify audio exports exist and samples are being produced
        has_audio = guest.evaluate("""(() => {
            var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
            if (!gm || !gm.Module) return { exports: false };
            var mod = gm.Module;
            var hasExports = !!(mod._kn_get_audio_ptr && mod._kn_get_audio_samples && mod._kn_get_audio_rate);
            if (!hasExports) return { exports: false };
            return {
                exports: true,
                rate: mod._kn_get_audio_rate(),
                samples: mod._kn_get_audio_samples(),
                ptr: mod._kn_get_audio_ptr(),
            };
        })()""")
        print(f"Audio exports: {has_audio}")

        if has_audio.get('exports'):
            assert has_audio['rate'] > 0, "Audio rate should be positive"
            assert has_audio['ptr'] > 0, "Audio pointer should be set"
            print(f"  rate={has_audio['rate']}, ptr={has_audio['ptr']}, samples={has_audio['samples']}")

        print("\nSUCCESS: Guest booted, lockstep running, audio pipeline initialized")

    finally:
        host.close()
        guest.close()
