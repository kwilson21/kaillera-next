"""Steps the browser tests that play a real game share: reading the rollback
engine's sync log, waiting for a page's game to get past a frame, and cutting
a page's input packets off from its peers for a while."""

import re
import time

_SYNC_APPLIED = re.compile(r"sync #\d+ applied")


def sync_log(page):
    """The engine's sync log. The console shows most of it only with ?debug."""
    return page.evaluate("window.NetplayRollback.exportSyncLog()")


def sync_log_lines(page, text):
    """The sync log lines that contain `text`."""
    return [line for line in sync_log(page).splitlines() if text in line]


def syncs_applied(page):
    """How many resync states this page has applied (`sync #N applied`)."""
    return len(_SYNC_APPLIED.findall(sync_log(page)))


def frame(page):
    return page.evaluate("window.KNState.frameNum")


def wait_past_frame(page, past, timeout_s=60):
    """Wait until the page's game is past frame `past`. A game that stops
    first fails with the last lines of its sync log, which say why."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if frame(page) > past:
            return
        time.sleep(0.25)
    tail = "\n".join(sync_log(page).splitlines()[-40:])
    raise AssertionError(f"game stuck at frame {frame(page)}, not past {past} after {timeout_s}s:\n{tail}")


def silence_inputs(page, ms, channels=("dc", "rbDc")):
    """For `ms` milliseconds, drop every input packet the page sends.

    Inputs are binary messages on a peer's `dc` (the reliable channel, which
    the host picks by default) or its `rbDc` (the unreliable one, picked with
    knDiag.setTransport('unreliable')); everything else the page sends is a
    string and still goes through. Both are silenced unless `channels` names
    one: dropping packets on `dc` is a page gone quiet, since that channel
    loses nothing on its own; on `rbDc` it is packet loss. Returns at once:
    the silence ends by itself. `window._knTestDropped` counts the packets
    dropped.
    """
    page.evaluate(
        """([ms, channels]) => {
            window._knTestDropped = window._knTestDropped || 0;
            window._knTestSilentUntil = performance.now() + ms;
            const binary = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d) || d instanceof Blob;
            for (const p of Object.values(window.KNState.peers || {})) {
                for (const ch of channels.map((name) => p[name])) {
                    if (!ch || ch._knTestWrapped) continue;
                    const send = ch.send.bind(ch);
                    ch.send = (data) => {
                        if (binary(data) && performance.now() < window._knTestSilentUntil) {
                            window._knTestDropped++;
                            return;
                        }
                        return send(data);
                    };
                    ch._knTestWrapped = true;
                }
            }
        }""",
        [ms, list(channels)],
    )
