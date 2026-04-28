"""Streaming-mode late join regression tests."""

import secrets

from playwright.sync_api import expect


def _wait_for_socket(page, timeout=10000):
    page.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=timeout,
    )


def _install_fake_streaming_host(page):
    """Provide enough host-side emulator surface for streaming without a ROM."""
    page.evaluate(
        """
        (() => {
          window.__test_setRomLoaded();
          window.__test_controller_masks = [];
          window.__test_input_writes = [];

          const game = document.getElementById('game');
          game.innerHTML = '';
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          canvas.style.width = '640px';
          canvas.style.height = '480px';
          game.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          let frame = 20;
          const paint = () => {
            frame += 1;
            ctx.fillStyle = frame % 2 ? '#10253f' : '#274f35';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ffffff';
            ctx.font = '28px sans-serif';
            ctx.fillText(`stream test ${frame}`, 32, 64);
            window.__test_paint_raf = requestAnimationFrame(paint);
          };
          paint();

          const mod = {
            AL: { contexts: {} },
            _get_current_frame_count: () => frame,
            _reset_cheat: () => {},
            _simulate_input: (slot, index, value) => {
              window.__test_input_writes.push({ slot, index, value });
            },
            _kn_set_controller_present_mask: (mask) => {
              window.__test_controller_masks.push(mask);
            },
          };

          window.EJS_emulator = {
            controls: [{}],
            elements: { parent: game, menu: document.createElement('div') },
            gamepad: {
              timeout: null,
              loop: () => {},
              getGamepads: () => [],
              updateGamepadState: () => {},
            },
            gameManager: {
              Module: mod,
              setKeyboardEnabled: () => {},
              resetCheat: () => {},
              setCheat: () => {},
            },
          };
        })()
        """
    )


def test_streaming_third_player_late_join_gets_video_port_and_input(context, server_url):
    """P3 can late-join a streaming match and drive controller port 3."""
    room = f"STR{secrets.token_hex(3).upper()}"
    pages = []

    try:
        host = context.new_page()
        guest = context.new_page()
        pages = [host, guest]

        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=streaming")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_for_socket(host)
        _install_fake_streaming_host(host)

        guest.goto(f"{server_url}/play.html?room={room}&name=P2")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_for_socket(guest)

        expect(guest.locator("#rom-declare-cb")).to_be_visible(timeout=10000)
        guest.locator("#rom-declare-cb").check()
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        host.click("#start-btn")
        host.wait_for_function(
            "document.querySelector('#toolbar-status')?.textContent.includes('Hosting')",
            timeout=30000,
        )
        guest.wait_for_function(
            """
            (() => {
              const v = document.querySelector('#guest-video');
              return !!(v && v.srcObject && v.srcObject.getVideoTracks().length >= 1);
            })()
            """,
            timeout=30000,
        )

        late = context.new_page()
        pages.append(late)
        late.goto(f"{server_url}/play.html?room={room}&name=P3")
        _wait_for_socket(late)
        late.wait_for_function("window._playerSlot === 2", timeout=10000)
        late.wait_for_function(
            """
            (() => {
              const v = document.querySelector('#guest-video');
              return !!(v && v.srcObject && v.srcObject.getVideoTracks().length >= 1);
            })()
            """,
            timeout=30000,
        )

        host.wait_for_function(
            """
            Object.values(window.KNState?.peers || {}).some((p) =>
              p.slot === 2 &&
              p.dc?.readyState === 'open' &&
              p.pc?.getSenders?.().some((s) => s.track?.kind === 'video')
            )
            """,
            timeout=10000,
        )
        host.wait_for_function("window.__test_controller_masks?.includes(0x7)", timeout=10000)

        late.bring_to_front()
        late.keyboard.down("c")
        host.wait_for_function(
            "window.__test_input_writes?.some((w) => w.slot === 2 && w.index === 0 && w.value === 1)",
            timeout=5000,
        )
        late.keyboard.up("c")
        host.wait_for_function(
            "window.__test_input_writes?.some((w) => w.slot === 2 && w.index === 0 && w.value === 0)",
            timeout=5000,
        )
    finally:
        for page in pages:
            try:
                page.evaluate("window.__test_socket && window.__test_socket.disconnect()")
            except Exception:
                pass
            if not page.is_closed():
                page.close()
