"""The packaged core replays interrupted slices through the page's original live frame."""

from pathlib import Path

import pytest
from netplay_steps import wait_past_frame


@pytest.mark.parametrize("delay", [1, 2], ids=["fixed-delay", "retuned-delay"])
def test_preempted_replay_keeps_the_controller_timeline(
    page, server_url, rom_path, room, start_game, delay
):
    # Expose the existing tick to the test page. The ROM, browser frame runner,
    # controller writers, prediction and replay branches run unchanged.
    def expose_tick(route):
        response = route.fetch()
        source = response.text()
        export = "window.NetplayRollback = NetplayRollbackApi;"
        assert source.count(export) == 1
        driver = """
          window.__replayTest = {
            reset() {
              _frameNum = KNState.frameNum = 0;
              DELAY_FRAMES = 1;
              rb_numPlayers = 3;
              _maskSchedule.start(7, 0);
              _localInputs = {};
            },
            setDelay(delay) { DELAY_FRAMES = delay; },
            tick(buttons) {
              _localInputs[_frameNum] = { buttons, lx: 0, ly: 0, cx: 0, cy: 0 };
              tick();
            },
          };
        """
        route.fulfill(response=response, body=source.replace(export, driver + export))

    page.route("**/static/netplay-rollback.js*", expose_tick)
    page.goto(
        f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback&replayBurst=1"
    )
    page.set_input_files("#rom-drop input[type=file]", rom_path)
    start_game(page)
    wait_past_frame(page, 15)

    fixture = Path(__file__).with_name("fixtures") / "replay-preemption.js"
    page.add_script_tag(content=fixture.read_text())
    case = page.evaluate("(delay) => window.__replayTest.run(delay)", delay)
    reference, delayed = case["reference"], case["delayed"]
    assert reference["pads"][6] == [1, 1, 1], case
    assert reference["pads"][7] == [0, 1, 1], case
    assert delayed["corrections"] == [1, 1], case
    assert delayed["replay"] == [5, 3, 4, 5, 6, 7], case
    assert delayed["firstLive"] == reference["firstLive"] == 8, case
    assert delayed["pads"] == reference["pads"], case
    assert delayed["failed"] == 0, case
