"""Room 5AB4NK8U: peers started from the host's RDRAM but kept their own save
RAM, and Smash Remix picked different stages from the same inputs. The host now
sends its save RAM with every initial save-state, and a guest whose own cache
had the starting state waits (bounded) for that message instead of starting
without it.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = (ROOT / "web/static/netplay-rollback.js").read_text()


def _body(name: str) -> str:
    start = SRC.index(f"const {name} = async (")
    return SRC[start : SRC.index("\n  };\n", start)]


def test_every_initial_save_state_carries_save_ram():
    for start in [i for i in range(len(SRC)) if SRC.startswith("_emitSaveStateToPlayers({", i)]:
        message = SRC[start : SRC.index("});", start)]
        assert "saveRam," in message
    assert "_emitSaveStateToPlayers = (msg) => {\n    socket.emit('data-message', { ...msg, toPlayers: true });" in SRC


def test_cached_guest_waits_for_the_host_save_state():
    fetch = _body("fetchCachedState")
    assert "_cachedInitialStateReady('IndexedDB');" in fetch
    assert "_cachedInitialStateReady('server cache');" in fetch
    assert "_phase = PHASE_LOCKSTEP_READY;" not in fetch
    # The host's message may land first; the cached copy must not replace it.
    assert fetch.count("if (_playerSlot !== 0 && _phase >= PHASE_LOCKSTEP_READY) return;") == 2

    assert "const HOST_INITIAL_STATE_WAIT_MS = 10000;" in SRC
    assert "HOST-STATE-WAIT-TIMEOUT" in SRC
    handler = _body("handleSaveStateMsg")
    assert "if (_phase >= PHASE_LOCKSTEP_READY) return; // HOST-STATE-WAIT-TIMEOUT fired meanwhile" in handler
    assert "_markInitialStateReady();" in handler


def test_guest_writes_host_save_ram_at_start_and_restores_its_own_at_stop():
    assert "_writeSaveRam(readyMod, _guestStateSaveRam, 'initial-sync-load')" in SRC
    assert "_clearHostInitialStateWait();\n    _restoreLocalSaveFile();" in SRC
