"""Match-local integrity and the existing owner End action."""
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _slice(text, start, end):
    at = text.index(start)
    return text[at : text.index(end, at)]


def _run(script):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=ROOT, text=True,
        capture_output=True, timeout=20, check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("scenario", ["expiry", "removal", "reuse", "delivery-only", "stale-match"])
def test_actual_fence_outlives_only_unverified_history(scenario):
    runtime = (ROOT / "web/static/netplay-rollback.js").read_text()
    block = _slice(runtime, "  // A reconnect receipt", "  const _holdReconnectHostAnswer =")
    script = """
    const KNState = {matchId: 'match-a'}, _activeRoster = new Set([0,1,2]);
    let _syncQueueEpoch = 4, now = 0, _frameNum = 100, failures = 0;
    const DELAY_FRAMES = 2, KN_MAX_VISIBLE_ROLLBACK_DEPTH = 7;
    const _knownPlayers = {M: {persistentId: 'former'}, N: {persistentId: 'new'}};
    const _syncQueueGen = {M: 1, N: 1};
    const _playerSlot = 0, PHASE_RUNNING = 5, _phase = PHASE_RUNNING;
    const _useCRollback = true, _hasKnSync = true, RB_WORKER_COPROC = false;
    const _admissionInputFloor = () => 0, _cutGoverns = () => false, _inputFloor = () => 0;
    const _pendingCInputs = [], _remoteInputs = {1:{}}, _peerPhantom = {};
    const _peers = {M:{slot:1},N:{slot:1}};
    const alerts = [], _config = {onMatchIntegrityUnverified: x => alerts.push(x)};
    const _syncLog = () => {}, performance = {now:()=>now};
    const mod = {_kn_get_failed_rollbacks: () => failures, _kn_get_replay_depth:()=>0,
      _kn_peek_pending_rollback:()=>-1, _kn_get_frame:()=>_frameNum};
    const window = {EJS_emulator: {gameManager: {Module: mod}}};
    """
    test = """
    const debt = {slot:1, owner:'former', sid:'M', gen:1, epoch:4, matchId:'match-a',
      from:96, through:97, failed:0, deadline:100, status:'waiting',
      receipts:new Set([97]), request:{id:9}};
    _hostReconnectDebts.set(1,debt);
    const initialFence = _hostReconnectFenceVersion;
    if (scenario === 'expiry') now = 100;
    if (scenario === 'removal' || scenario === 'delivery-only') _activeRoster.delete(1);
    if (scenario === 'reuse') _armHostReconnectDebt(1, 'reconnect', 'N', false, mod);
    if (scenario === 'delivery-only') debt.historyProven = true;
    if (scenario === 'stale-match') {KNState.matchId='match-b'; now=100;}
    const blockedBefore = _hostReconnectBlocksNativeCapture(mod);
    _activeRoster.delete(1);
    _hostReconnectDebts.clear(); // a local session reset is not a new server match
    _syncQueueEpoch++;
    const blockedAfter = _hostReconnectBlocksNativeCapture(mod);
    KNState.matchId = 'match-b';
    const blockedNew = _hostReconnectBlocksNativeCapture(mod);
    process.stdout.write(JSON.stringify({blockedBefore,blockedAfter,blockedNew,alerts,
      generationChanged: _hostReconnectFenceVersion !== initialFence}));
    """
    actual = _run(f"const scenario = {json.dumps(scenario)};\n{script}\n{block}\n{test}")
    if scenario in ("delivery-only", "stale-match"):
        assert actual == {
            "blockedBefore": False, "blockedAfter": False, "blockedNew": False,
            "alerts": [], "generationChanged": False,
        }
    else:
        assert actual["blockedBefore"] and actual["blockedAfter"] and not actual["blockedNew"]
        assert len(actual["alerts"]) == 1
        assert actual["alerts"][0]["matchId"] == "match-a"
        assert actual["generationChanged"]


@pytest.mark.parametrize("scenario", ["plain", "ack", "no-ack", "cancel", "stale"])
def test_actual_owner_action_never_confuses_ack_with_verified_lobby(scenario):
    play = (ROOT / "web/static/play.js").read_text()
    end = _slice(play, "  const endGame = () =>", "  const leaveGame =")
    script = """
    const KNState={matchId:'match-a'}, ended=[], notices=[], events=[];
    let _unverifiedMatchId = scenario === 'plain' ? null : 'match-a', _endGameRequest=null, decide;
    const socket = {connected:true,emit:(event,data)=>events.push({event,data})};
    const _gameStart = {endMatchesCurrent:(a,b)=>a===b};
    const showToast = s => notices.push(s), onGameEnded = v => ended.push(v);
    const window = { KNCore: {startRejoin: ({send}) => {
      send(()=>{});
      return {outcome:new Promise(r=>{decide=r}),cancel:()=>{}};
    }}};
    """
    test = """
    endGame();
    if (scenario === 'cancel') {_endGameRequest.cancel(); _endGameRequest=null;}
    if (scenario === 'stale') KNState.matchId='match-b';
    decide({kind:scenario === 'no-ack' ? 'noAnswer' : 'resumed'});
    await Promise.resolve();
    process.stdout.write(JSON.stringify({ended,notices,events,unverified:_unverifiedMatchId}));
    """
    actual = _run(f"const scenario = {json.dumps(scenario)};\n{script}\n{end}\n{test}")
    assert actual["events"] == [{"event": "end-game", "data": {"matchId": "match-a"}}]
    if scenario == "plain":
        assert actual["ended"] == [{"matchId": "match-a", "localAck": True}]
    else:
        assert actual["unverified"] == "match-a" and actual["ended"] == []
        if scenario == "ack":
            assert "The lobby is not yet confirmed" in actual["notices"][-1]
        if scenario == "no-ack":
            assert "Could not confirm" in actual["notices"][-1]


def test_live_routes_keep_the_latch_separate_from_handoff_and_local_cleanup():
    runtime = (ROOT / "web/static/netplay-rollback.js").read_text()
    play = (ROOT / "web/static/play.js").read_text()
    push = _slice(runtime, "  const pushSyncState =", "  const _syncTargetsFor =")
    assert push.index("_admitReconnectNativeCapture") < push.index("mod._kn_sync_read(")
    assert push.index("mod._kn_sync_read(") < push.index("options.reconnectDebt.historyProven = true")
    assert push.index("options.reconnectDebt.historyProven = true") < push.index("await compressAndEncode(toCompress)")
    stop = _slice(runtime, "  const stopSync =", "  const _dispatchScheduledSyncs")
    assert "_unverifiedHostMatch = null" not in stop
    event = _slice(play, "  const onGameEnded =", "    _endGameRequest?.cancel();")
    assert event.index("data?.matchId !== _unverifiedMatchId") < event.index("_unverifiedMatchId = null;")
    assert "const _hostMatchUnverified = () =>" in runtime
    assert "socket.emit('end-game'" not in runtime


def test_authoritative_old_end_cannot_end_the_selected_current_match():
    play = (ROOT / "web/static/play.js").read_text()
    on_end = _slice(play, "  const onGameEnded =", "  const onRoomClosed =")
    mocks = """
    const KNState={matchId:'match-b'}, events=[];
    let _unverifiedMatchId='match-b', _lastHandledGameEndMatchId=null,
        _endGameRequest=null, engine={stop:()=>events.push('stop')};
    const _gameStart={endMatchesCurrent:(a,b)=>!a||!b||a===b,
      handlesGameEnd:(match,last)=>match!==last,gameEndedMessage:()=>''};
    const isGameRunning=()=>true, _isLateJoin=()=>false, _isPendingLateJoin=()=>false;
    const console={log:()=>{}}, _romBlob=null, _romBlobUrl=null, window={};
    const _sessionStopLateJoinPoll=()=>{}, _session={send:({type})=>events.push(type)};
    const showToast=()=>{}, hibernateEmulator=()=>{}, document={getElementById:()=>null};
    const dismissGameLoading=()=>{}, hideToolbar=()=>{}, _clearLateJoinRomPrompt=()=>{}, showOverlay=()=>{};
    const lastUsersData=null, resetRomTransfer=()=>{}, cleanupPreGameConnections=()=>{};
    """
    actions = """
    onGameEnded({matchId:'match-a'});
    onGameEnded({});
    const afterStale = {matchId:KNState.matchId,warning:_unverifiedMatchId,events:[...events]};
    onGameEnded({matchId:'match-b'});
    onGameEnded({matchId:'match-b'});
    process.stdout.write(JSON.stringify({afterStale,matchId:KNState.matchId,warning:_unverifiedMatchId,events}));
    """
    actual = _run(f"{mocks}\n{on_end}\n{actions}")
    assert actual == {
        "afterStale": {"matchId": "match-b", "warning": "match-b", "events": []},
        "matchId": None, "warning": None, "events": ["gameEnded", "stop"],
    }
