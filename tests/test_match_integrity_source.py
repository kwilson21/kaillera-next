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


@pytest.mark.parametrize("scenario", ["expiry", "removal", "reuse", "delivery-only", "stale-match", "remote-marker"])
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
    if (scenario === 'remote-marker') {
      _hostReconnectDebts.clear();
      if (_setHostMatchUnverified('old-match','room') || !_setHostMatchUnverified('match-a','room') ||
          _setHostMatchUnverified('match-a','room')) throw Error('stale or duplicate authority');
    }
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
        if scenario == "remote-marker":
            assert actual["alerts"] == []
        else:
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
    assert event.index("data?.matchId !== _unverifiedMatchId") < event.index("_clearMatchIntegrity();")
    assert "const _hostMatchUnverified = () =>" in runtime
    assert "socket.emit('end-game'" not in runtime


def test_authoritative_old_end_cannot_end_the_selected_current_match():
    play = (ROOT / "web/static/play.js").read_text()
    on_end = _slice(play, "  const onGameEnded =", "  const onRoomClosed =")
    mocks = """
    const KNState={matchId:'match-b'}, events=[];
    const isHost=false;
    let _matchReturn=null, _unverifiedMatchId='match-b', _lastHandledGameEndMatchId=null,
        _lateJoinWaitingForHost='match-b',
        _endGameRequest=null, engine={stop:()=>events.push('stop')};
    const _clearMatchIntegrity=()=>{_unverifiedMatchId=null};
    const _gameStart={endMatchesCurrent:(a,b)=>!a||!b||a===b,
      handlesGameEnd:(match,last)=>match!==last,gameEndedMessage:()=>''};
    const isGameRunning=()=>true, _isLateJoin=()=>false, _isPendingLateJoin=()=>false;
    const console={log:()=>{}}, _romBlob=null, _romBlobUrl=null, window={};
    const _sessionStopLateJoinPoll=()=>{}, _session={send:({type})=>events.push(type)};
    const guardHostNavigation=active=>events.push(active);
    const showToast=()=>{}, hibernateEmulator=()=>{}, document={getElementById:()=>null};
    const dismissGameLoading=()=>{}, hideToolbar=()=>{}, _clearLateJoinRomPrompt=()=>{}, showOverlay=()=>{};
    const lastUsersData=null, resetRomTransfer=()=>{}, cleanupPreGameConnections=()=>{};
    """
    actions = """
    const snapshot = () => ({
      matchId:KNState.matchId, warning:_unverifiedMatchId, waiting:_lateJoinWaitingForHost, events:[...events]
    });
    onGameEnded({matchId:'match-a'});
    onGameEnded({});
    const afterStale = snapshot();
    onGameEnded({matchId:'match-b'});
    onGameEnded({matchId:'match-b'});
    process.stdout.write(JSON.stringify({afterStale,...snapshot()}));
    """
    actual = _run(f"{mocks}\n{on_end}\n{actions}")
    assert actual == {
        "afterStale": {"matchId": "match-b", "warning": "match-b", "waiting": "match-b", "events": []},
        "matchId": None, "warning": None, "waiting": None, "events": ["gameEnded", False, "stop"],
    }


@pytest.mark.parametrize(
    "scenario", ["snapshots", "retry", "owner-loss", "match-change", "authority", "slot-zero", "slot-zero-retained"]
)
def test_client_propagation_ignores_stale_updates_and_never_echoes_remote_warning(scenario):
    play = (ROOT / "web/static/play.js").read_text()
    helpers = _slice(play, "  const _cancelIntegrityNotice =", "  // This page's socket was down")
    real_callback = _slice(play, "      onMatchIntegrityUnverified:", "      onStatus:").strip().rstrip(",")
    mocks = """
    const KNState={matchId:'a'}, RECOVERY_UNVERIFIED='Recovery unverified';
    const toasts=[], sends=[], requests=[], ui={}, marks=[];
    const engine={markMatchRecoveryUnverified: (matchId)=>marks.push(matchId)};
    let _unverifiedMatchId=null, _localUnverifiedMatchId=null, _reportedUnverifiedMatchId=null,
      _integrityNotice=null, _integrityNoticeAttempt=null;
    const _identity={persistentId:'local'};
    let isHost=false, lastUsersData=null, active=true,
      socket={id:'sid-a',connected:true,emit:(...x)=>sends.push(x.slice(0,2))};
    const showToast=s=>toasts.push(s), isGameRunning=()=>active;
    const document={getElementById:id=>ui[id]??=( {textContent:''} )};
    const window={KNCore:{startRejoin(o){
      let finish;
      const r={options:o, outcome:new Promise(resolve=>{finish=resolve}), cancelled:false,
        cancel(){this.cancelled=true}, finish:(kind)=>finish({kind})};
      requests.push(r);
      o.send(()=>{});
      return r;
    }}};
    const snapshot=(matchId, marker, status='playing')=>({matchId,recoveryUnverifiedMatchId:marker,status});
    """
    commands = {
        "snapshots": """
          _acceptRemoteIntegrity(snapshot('b','b'));
          _acceptRemoteIntegrity(snapshot('a','a','lobby'));
          _acceptRemoteIntegrity(snapshot('b','a'));
          const before = _unverifiedMatchId;
          _acceptRemoteIntegrity(snapshot(undefined,'a'));
          _acceptRemoteIntegrity(snapshot('a','a'));
          _acceptRemoteIntegrity(snapshot('a',null));
          _acceptRemoteIntegrity(snapshot('a',undefined));
          _maybeReportMatchIntegrity();
          if (before !== null || _reportedUnverifiedMatchId !== 'a' ||
              _matchIntegrityText('ordinary') !== RECOVERY_UNVERIFIED ||
              Object.values(ui).some(e=>e.textContent!==RECOVERY_UNVERIFIED)) throw Error('snapshot handling');
        """,
        "retry": """
          isHost=true;
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          _maybeReportMatchIntegrity();
          if (requests.length!==1 || requests[0].options.attempts!==3) throw Error('unbounded or duplicate');
          requests[0].finish('noAnswer');
          await Promise.resolve();
          _maybeReportMatchIntegrity();
          if (requests.length!==1) throw Error('retry storm');
          socket.id='sid-b';
          _maybeReportMatchIntegrity();
          requests[1].finish('resumed');
          await Promise.resolve();
          _maybeReportMatchIntegrity();
          if (_reportedUnverifiedMatchId!=='a' || requests.length!==2) throw Error('reconnect did not report');
        """,
        "owner-loss": """
          isHost=true;
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          isHost=false;
          _maybeReportMatchIntegrity();
          requests[0].options.send(()=>{});
          requests[0].finish('resumed');
          await Promise.resolve();
          if (!requests[0].cancelled || _reportedUnverifiedMatchId!==null) throw Error('old owner ack accepted');
        """,
        "match-change": """
          isHost=true;
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          _clearMatchIntegrity();
          KNState.matchId='b';
          requests[0].options.send(()=>{});
          requests[0].finish('resumed');
          _acceptRemoteIntegrity(snapshot('a','a'));
          await Promise.resolve();
          if (!requests[0].cancelled || _reportedUnverifiedMatchId!==null || _unverifiedMatchId!==null)
            throw Error('old match notice applied to replacement');
        """,
        "authority": """
          isHost=true;
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          _acceptRemoteIntegrity(snapshot('a','a'));
          _maybeReportMatchIntegrity();
          requests[0].options.send(()=>{});
          if (!requests[0].cancelled || _reportedUnverifiedMatchId!=='a') throw Error('lost authority');
        """,
        "slot-zero": """
          const roster = (sid, slot, matchId) => ({
            status:'playing', matchId, players:{local:{socketId:sid,slot}}
          });
          lastUsersData=roster('sid-old',0);
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          lastUsersData=roster('sid-a',1);
          _maybeReportMatchIntegrity();
          lastUsersData=roster('sid-a',0,'old-match');
          _maybeReportMatchIntegrity();
          if (requests.length) throw Error('bad roster allowed warning publication');
          lastUsersData=roster('sid-a',0);
          _maybeReportMatchIntegrity();
          if (requests.length!==1) throw Error('active slot zero denied');
          socket.id='sid-b';
          requests[0].options.send(()=>{});
          requests[0].finish('resumed');
          await Promise.resolve();
          _maybeReportMatchIntegrity();
          if (_reportedUnverifiedMatchId || requests.length!==1) throw Error('old socket allowed report');
          lastUsersData=roster('sid-b',0);
          _maybeReportMatchIntegrity();
          requests[1].finish('resumed');
          await Promise.resolve();
          if (_reportedUnverifiedMatchId!=='a') throw Error('new current slot-zero report lost');
        """,
        "slot-zero-retained": """
          isHost=true;
          callbacks.onMatchIntegrityUnverified({matchId:'a'});
          isHost=false;
          lastUsersData={status:'playing',players:{local:{socketId:'sid-a',slot:0}}};
          _maybeReportMatchIntegrity();
          if (requests.length!==1 || requests[0].cancelled) throw Error('retained authority lost');
          lastUsersData.players.local.slot=1;
          _maybeReportMatchIntegrity();
          requests[0].options.send(()=>{});
          requests[0].finish('resumed');
          await Promise.resolve();
          if (!requests[0].cancelled || _reportedUnverifiedMatchId) throw Error('lost slot-zero authority accepted');
        """,
    }
    actions = f"""
    const callbacks={{{real_callback}}};
    {commands[scenario]}
    process.stdout.write(JSON.stringify({{sends,toasts,marks,warning:_unverifiedMatchId}}));
    """
    expected_sends = {
        "snapshots": [], "retry": ["a", "a"], "owner-loss": ["a"], "match-change": ["a"], "authority": ["a"],
        "slot-zero": ["a", "a"], "slot-zero-retained": ["a"],
    }
    assert _run(f"{mocks}\n{helpers}\n{actions}") == {
        "sends": [["match-recovery-unverified", {"matchId": match}] for match in expected_sends[scenario]],
        "toasts": ["Recovery unverified"],
        "marks": {"snapshots": ["a"], "authority": ["a"]}.get(scenario, []),
        "warning": None if scenario == "match-change" else "a",
    }


def test_both_authoritative_client_paths_feed_the_sticky_warning():
    play = (ROOT / "web/static/play.js").read_text()
    assert "_acceptRemoteIntegrity(data)" in _slice(play, "  const onUsersUpdated =", "  const onGameStarted =")
    assert "_acceptRemoteIntegrity(joinData)" in play
    assert "engine.markMatchRecoveryUnverified?.(_reportedUnverifiedMatchId)" in play
    assert "_acceptRemoteIntegrity(room)" in _slice(play, "  const _reconcileAfterRejoin =", "  const _leaveDroppedGame")
    assert "end-game" not in _slice(play, "  const _cancelIntegrityNotice =", "  // This page's socket was down")
