import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { reconnectProofSource } from './fixtures/reconnect-proof-source.ts';
import { createRecoveryManager } from '../../web/src/recovery-delivery.ts';
import { createRecoveryTransferPool } from '../../web/src/recovery-transfer.ts';
import { createOwnerProofRelay } from '../../web/src/owner-proof-relay.ts';
import {
  openProof as openOwnerInputProof,
  captureAllowed as ownerInputCaptureAllowed,
} from '../../web/src/owner-proof.ts';
import { CHECKPOINT_MESSAGE } from '../../web/src/checkpoint-wire.ts';
import { checkRelayed } from '../../web/src/relay.ts';
import * as syncSend from '../../web/src/sync-send.ts';
import * as syncFollowUp from '../../web/src/sync-follow-up.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
function part(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
}
function fn(name: string) {
  const start = source.indexOf(`  const ${name} = `);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  };', start) + 5);
}

function room(realTransfer = false) {
  const context = vm.createContext({
    _hostReconnectBlocksNativeCapture: () => false,
    _hostReconnectFenceVersion: 0,
    createRecoveryManager,
    createRecoveryTransferPool,
    createOwnerProofRelay,
    syncSend,
    syncFollowUp,
    openOwnerInputProof,
    ownerInputCaptureAllowed,
    checkRelayed,
    CHECKPOINT_MESSAGE,
    Uint8Array,
    queueMicrotask,
    crypto: { randomUUID: () => 'long-enough-opaque-token' },
  });
  vm.runInContext(
    `
    let now=1, _frameNum=1076, nativeFrame=1076, depth=0, pending=-1, failures=0;
    let _syncQueueEpoch=9, _pushingSyncState=false, _proactivePushInFlight=false;
    const _armEscalationClock = () => {};
    const PHASE_RUNNING=5, RUN_LATE_JOIN_PAUSE=1, _phase=5, _runSubstate=0; let _playerSlot=0;
    const _useCRollback=true, _hasKnSync=true, _isSpectator=false, _demoMode=false, _catchUpTo=-1;
    let RB_WORKER_COPROC=false;
    let remix=false, gameStatus=0, sceneCurr=16;
    const _isSmashRemix=()=>remix, _readGameStatus=()=>gameStatus, _readSceneCurr=()=>sceneCurr;
    ${fn('_readMenuPhase')}
    const _activeRoster=new Set([0,1,2,3]), KNState={matchId:'running-match'};
    const _isPeerPendingLateJoin=()=>false, _peerConnectionLive=()=>true, INPUT_PAST_WINDOW_FRAMES=240;
    const KN_MAX_VISIBLE_ROLLBACK_DEPTH=7, OVERDUE_PUSH_QUIET_MS=20000;
    const _syncEnabled=true, _coreFatalError=false, DELAY_FRAMES=3, SYNC_COORD_TIMEOUT_MS=3000;
    const _lateJoinServing=new Map(), _queuedSyncPushes=new Map(), _followUpWatches=new Map(), _directAnswerNewest=new Map();
    const _syncSendChains={}, _syncChainMovedAt={}, _peerPhantom={};
    const _corePhantomHistory=new Set(), _pendingCInputs=[], _ranBeforeDelayChange=null, _workerCoprocPending=null;
    const _reconnectProofStatus=()=>true, _requestIdFrom=n=>Number.isSafeInteger(n)&&n>0?n:0;
    const RB_INPUT_ASK_EVERY_MS=100, RB_INPUT_ASK_MAX=8;
    let bystanderHole=false;
    ${reconnectProofSource(source)}
    const _knownPlayers={a:{socketId:'actual-p2'},b:{socketId:'actual-p3'},c:{socketId:'actual-p4'}};
    const _peers={a:{slot:1},b:{slot:2},c:{slot:3}}, _syncQueueGen={a:3,b:4,c:5};
    const proofLogs=[], performance={now:()=>now}, _syncLog=log=>proofLogs.push(log);
    const _syncBufPtr=1, _syncBufSize=8, reads=[], shipments=[], outcomes=[], bootEmits=[];
    const socket={connected:true,id:'actual-host',emit:(event, data)=>bootEmits.push({event,data})};
    let compressGate=Promise.resolve(), allowCompression;
    const waitForSmashTitleState=()=>new Promise(()=>{});
    const compressState=async (bytes)=>{ await compressGate; return bytes };
    const mod={
      HEAPU8:new Uint8Array(16),
      _kn_get_frame:()=>nativeFrame,
      _kn_get_replay_depth:()=>depth,
      _kn_peek_pending_rollback:()=>pending,
      _kn_get_failed_rollbacks:()=>failures,
      _kn_sync_read(){ reads.push(nativeFrame); this.HEAPU8[1]=nativeFrame%256; this.HEAPU8[2]=99; return 2; },
    };
    const window={
      KNCore:{checkpoint:{CHECKPOINT_MESSAGE},checkRelayed,syncSend,syncFollowUp,recovery:{createOwnerProofRelay,openOwnerInputProof,ownerInputCaptureAllowed}},
      EJS_emulator:{gameManager:{Module:mod,getState(){throw Error('late or raw state escaped');}}},
    };
    const _localInputs={}, _remoteInputs={1:{},2:{},3:{}}, nativeFed=[], _inputFloor=()=>1066;
    const _maskSchedule={active:()=>false};
    const KNShared={ZERO_INPUT:{},encodeInput:(f,input)=>({buffer:{f,input}})};
    const _missingConsumedInputs=(peers=getInputPeers())=>[
      ...[...Array(7)].map((_,i)=>i+1066).filter(f=>!_remoteInputs[1][f]).slice(0,1)
        .map(frame=>({peer:_peers.a,frame})),
      ...(bystanderHole?[{peer:_peers.b,frame:1072}]:[]),
    ].filter(hole=>peers.includes(hole.peer));
    const getInputPeers=()=>Object.values(_peers);
    for (const f of [1067,1068,1069,1070,1071,1072]) _remoteInputs[1][f]={buttons:0,lx:0,ly:0,cx:0,cy:0};
    const _processInputPacket=(sid,peer,{f,input})=>{_remoteInputs[peer.slot][f]=input; nativeFed.push(f); return true};
    const _drainPendingCInputs=()=>{if(nativeFed.length && pending<0 && !drained){ pending=1069; drained=true; }};
    let drained=false;
    ${fn('_liveStateConfirmed')}
    const ensureSyncBuffer=()=>{};
    const _recovery=createRecoveryManager({timeoutMs:5000,quietMs:20000,maxPushes:3},()=>{});
    const _recoveryTransfers=createRecoveryTransferPool();
    const headerWrites=[], settled=[];
    const stateChannel=(name)=>({readyState:'open', bufferedAmount:0, send(msg){
      headerWrites.push([name, typeof msg==='string' ? msg : [...msg]]);
    }});
    const _settleInputsBefore=(slot,frame)=>settled.push([slot,frame]);
    const SYNC_SEND_LOW_WATER=64000, SYNC_SEND_POLL_MS=1, SYNC_SEND_STALL_MS=1000;
    const getActivePeers=()=>Object.values(_peers);
    ${
      realTransfer
        ? part('  const _syncTargetsFor =', '  // One state transfer at a time') + fn('_sendSyncChunksTo')
        : `
    const _syncTargetsFor=(sid)=>Object.entries(_peers).filter(([id])=>!sid||id===sid)
      .map(([id,peer])=>({sid:id,peer,epoch:_syncQueueEpoch,gen:_syncQueueGen[id]}));
    const _syncTargetCurrent=(t)=>t.epoch===_syncQueueEpoch && t.peer===_peers[t.sid] && t.gen===_syncQueueGen[t.sid];
    const _sendSyncChunksTo=async (t,bytes,frame)=>{shipments.push({sid:t.sid,frame,bytes:[...bytes]}); return 'sent'};
    `
    }
    const _onEscalationTransfer=(attempts,sid,sent,frame)=>outcomes.push([attempts.length,sid,sent,frame]);
    const _getTop=()=>_syncTargetsFor(null).map(t=>({id:t.sid,slot:t.peer.slot,generation:t.gen}));
    const observe=()=>({activeOwners:_getTop(),allRequiredInputsConfirmed:true,initialFailedRollbacks:0});
    let _scheduledSyncRequests=[{targetSid:'a',targetFrame:1000,deadlineAt:1,requestId:4}];
    ${fn('_emitSaveStateToPlayers')}
    ${fn('_runQueuedSyncPush')}
    ${fn('_openCapturePublication')}
    ${fn('_deferMatchCapture')}
    ${fn('_captureHiddenStateWords')}
    ${fn('_captureHleState')}
    ${fn('_captureResyncExtras')}
    ${fn('_resyncExtrasText')}
    ${fn('_resyncExtrasFields')}
    ${part('  const _ownedCaptureScope =', '  const _sealAndPublishCapture =')}
    ${fn('_sealAndPublishCapture')}
    ${part('  // Experimental fault-only owner path.', '  const _ownedCaptureScope =')}
    ${fn('onDataMessage')}
    ${fn('_escalateLostInput')}
    ${fn('pushSyncState')}
    ${fn('_answerDirectSyncRequest')}
    ${fn('sendSyncChunks')}
    ${fn('_checkOverduePushes')}
    ${fn('_dispatchScheduledSyncs')}
    ${part('  async function sendInitialState()', "  // The host's own starting state failed")}
    ${part('  async function sendLateJoinState(remoteSid)', '  // Joiner: a full resync')}
    let token, attempts;
    const open=(ownerIndex=0)=>{
      const topology=_getTop();
      attempts=_recovery.begin(1,1066,topology.map(t=>({slot:t.slot,sid:t.id})),_frameNum,now,true);
      token=_openCapturePublication({
        capture:{epoch:_syncQueueEpoch,frame:_frameNum,deadline:50,deliveryDeadline:150,maxBytes:8,owner:topology[ownerIndex],recipients:topology},
        topology,owners:[topology[ownerIndex]],
      },attempts,now);
      return token;
    };
    const receive=()=>_recovery.publication.owner(token,{epoch:_syncQueueEpoch,complete:true,currentOwner:_getTop()[0]},now);
    const summary=()=>JSON.stringify({reads,shipments,outcomes});
  `,
    context,
  );
  return (code: string) => vm.runInContext(code, context);
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('normal push does not enter a publication hold or change the captured frame', async () => {
  const run = room();
  await run("pushSyncState('a')");
  const out = JSON.parse(run('summary()'));
  assert.deepEqual(out.reads, [1076]);
  assert.deepEqual(out.shipments, [{ sid: 'a', frame: 1076, bytes: [52, 99] }]);
});

test('ordinary state snapshots keep the frame and old recipient identity across both async queues', async () => {
  for (const wait of ['compression', 'channel-chain'] as const) {
    const run = room(true);
    run(`
      let resumeChain;
      _knownPlayers.a.socketId='old-socket';
      _peers.a.syncDc=stateChannel('old');
      _peers.b.syncDc=stateChannel('healthy');
      ${
        wait === 'compression'
          ? 'compressGate=new Promise(resolve=>{allowCompression=resolve});'
          : '_syncSendChains.a=new Promise(resolve=>{resumeChain=resolve});'
      }
      const pendingBroadcast=pushSyncState(null,false,{requestIds:{a:71,b:72}});
    `);
    // The frame and the capture are from before we can enter either await.
    assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
    await flush();
    run(`
      _frameNum=1077; nativeFrame=1077; _syncQueueGen.a++;
      _peers.a={slot:1,syncDc:stateChannel('replacement')};
      _knownPlayers.a.socketId='new-socket';
      mod.HEAPU8[1]=222;
      ${wait === 'compression' ? 'allowCompression();' : 'resumeChain();'}
    `);
    await run('pendingBroadcast');
    assert.deepEqual(
      JSON.parse(run('JSON.stringify(headerWrites)')),
      [
        ['healthy', 'sync-answer-id:72'],
        ['healthy', 'sync-recovery-id:0'],
        ['healthy', 'sync-start:1076:1:1:0'],
        ['healthy', [52, 99]],
      ],
      wait,
    );
    assert.deepEqual(JSON.parse(run('JSON.stringify(settled)')), [[2, 1076]], wait);
  }
});

test('armed incident blocks direct, deadline-driven and separate late-join reads; expiry releases eligible work', async () => {
  const run = room();
  assert.ok(run('open()'));
  run(
    "const request = pushSyncState('a'); const late = sendLateJoinState('c'); _dispatchScheduledSyncs(()=>{throw Error('confirmation while fenced')});",
  );
  await flush();
  assert.deepEqual(JSON.parse(run('summary()')).reads, []);
  assert.equal(run('_scheduledSyncRequests.length'), 1);
  assert.equal(run('_lateJoinServing.size'), 0);
  // Invalidate the pending joiner before release; an old route cannot capture.
  run('_syncQueueGen.c++; now=50; _checkOverduePushes();');
  await run('Promise.all([request, late])');
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  assert.equal(run('_recovery.publication.holding()'), false);
});

test('a verified same-frame capture travels through the real Effect transfer pool; stale target is skipped', async () => {
  const run = room();
  assert.ok(run('open()'));
  run('receive(); depth=1;');
  assert.equal(run('_sealAndPublishCapture(token, observe, attempts)'), null);
  assert.deepEqual(JSON.parse(run('summary()')).reads, []);
  run(
    'depth=0; compressGate=new Promise(resolve=>{allowCompression=resolve}); const shipped=_sealAndPublishCapture(token, observe, attempts);',
  );
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  await flush();
  run('mod.HEAPU8[1]=222; _frameNum=1077; nativeFrame=1077; _syncQueueGen.c++; allowCompression();');
  await run('shipped');
  const out = JSON.parse(run('summary()'));
  assert.deepEqual(out.reads, [1076]);
  assert.deepEqual(out.shipments, [
    { sid: 'a', frame: 1076, bytes: [52, 99] },
    { sid: 'b', frame: 1076, bytes: [52, 99] },
  ]);
  assert.ok(out.outcomes.some((e: [number, string, boolean]) => e[1] === 'c' && e[2] === false));
});

test('match stop settles deferred callers without stale publication; attempted receipt alone cannot seal', async () => {
  const run = room();
  assert.ok(run('open()'));
  run("const queued=pushSyncState('b'); receive(); failures=1;");
  assert.equal(run('_sealAndPublishCapture(token, observe, attempts)'), null);
  run('_syncQueueEpoch++; _recovery.resetAll();');
  assert.equal(await run('queued'), null);
  assert.equal(run('_recovery.publication.holding()'), false);
  assert.deepEqual(JSON.parse(run('summary()')).reads, []);
});

test('matching metadata cannot substitute different recovery attempt objects', () => {
  const run = room();
  assert.ok(run('open()'));
  run('receive();');
  assert.equal(run('_sealAndPublishCapture(token, observe, attempts.map(a=>({...a})))'), null);
  assert.deepEqual(JSON.parse(run('summary()')).reads, []);
});

test('existing boot publisher prevents incident open; a running incident cannot start a boot read', async () => {
  const boot = room();
  void boot('sendInitialState()');
  assert.equal(boot('open()'), undefined);
  assert.deepEqual(JSON.parse(boot('summary()')).reads, []);

  const running = room();
  assert.ok(running('open()'));
  await running('sendInitialState()');
  assert.equal(running('_recovery.publication.holding()'), true);
  assert.deepEqual(JSON.parse(running('summary()')).reads, []);
});

test('expiry between frozen compression and transport keeps bytes off all recipient channels', async () => {
  const run = room();
  assert.ok(run('open()'));
  run(
    'receive(); compressGate=new Promise(resolve=>{allowCompression=resolve}); const shipped=_sealAndPublishCapture(token, observe, attempts);',
  );
  await flush();
  run('now=150; allowCompression();');
  await run('shipped');
  const out = JSON.parse(run('summary()'));
  assert.deepEqual(out.reads, [1076]);
  assert.deepEqual(out.shipments, []);
});

test('another current recipient cannot stand in as the genuine incident input owner', () => {
  const run = room();
  assert.equal(run('open(1)'), undefined);
  assert.equal(run('_recovery.publication.holding()'), false);
});

test('cached frame-zero sender cannot publish during a running capture incident', () => {
  const run = room();
  run("_emitSaveStateToPlayers({type:'save-state',frame:0})");
  assert.equal(run('bootEmits.length'), 1);
  assert.ok(run('open()'));
  run("_emitSaveStateToPlayers({type:'save-state',frame:0})");
  assert.equal(run('bootEmits.length'), 1);
});

for (const [game, remix] of [
  ['stock', false],
  ['Smash Remix battle', true],
] as const)
  test(`${game}: genuine overdue emits to current stamped owner; partial proof neither feeds nor seals until idle at F`, async () => {
    const run = room();
    if (remix) run('remix=true; gameStatus=1; sceneCurr=22');
    run("_escalateLostInput(_peers.a, 'push', now, 1066, true);");
    assert.equal(run("bootEmits.filter(x=>x.data.type==='recovery-input-proof-request').length"), 1);
    const request = JSON.parse(run('JSON.stringify(bootEmits.at(-1).data)'));
    assert.equal(request.targetSid, 'actual-p2');
    assert.deepEqual(request.ids, [1066, 1073]);
    const send = (samples: readonly [number, readonly number[]][], sid = 'actual-p2') =>
      run(
        `onDataMessage(${JSON.stringify({
          type: 'recovery-input-proof-reply',
          token: request.token,
          targetSid: 'actual-host',
          samples,
          knFrom: { sid, slot: 1, owner: false },
        })})`,
      );
    send(
      [
        [1066, [0, 0, 0, 0, 0]],
        [1073, [2, 0, 0, 0, 0]],
      ],
      'a',
    );
    assert.equal(run('_ownerRepair.proof.accepted.size'), 0);
    send([[1066, [0, 0, 0, 0, 0]]]);
    assert.equal(run('_serviceOwnerRepair(mod)'), 'hold');
    assert.equal(run('nativeFed.length'), 0);
    send([[1073, [2, 0, 0, 0, 0]]]);
    assert.equal(run('_serviceOwnerRepair(mod)'), 'replay');
    assert.equal(run('nativeFed.length'), 2);
    assert.deepEqual(JSON.parse(run('summary()')).reads, []);
    run('depth=1; nativeFrame=1069; _frameNum=1069;');
    assert.equal(run('_serviceOwnerRepair(mod)'), 'replay');
    run('depth=0; pending=-1; nativeFrame=1076; _frameNum=1076;');
    assert.equal(run('_serviceOwnerRepair(mod)'), 'hold');
    await flush();
    const out = JSON.parse(run('summary()'));
    assert.deepEqual(out.reads, [1076]);
    assert.equal(out.shipments.length, 3);
    assert.ok(out.shipments.every((x: { frame: number }) => x.frame === 1076));
  });

test('Smash Remix menus and inactive battles do not start an owner-proof incident', async () => {
  for (const phase of ['sceneCurr=16; gameStatus=1', 'sceneCurr=22; gameStatus=0']) {
    const run = room();
    run(`remix=true; ${phase}; _escalateLostInput(_peers.a, 'push', now, 1066, true)`);
    await flush();
    assert.equal(run('_ownerRepair'), null);
    assert.equal(run('bootEmits.length'), 0);
    assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  }
});

test('absent owner reply expires into the legacy attempt without sealing; 2p/worker never request proof', async () => {
  const expired = room();
  expired(
    "_escalateLostInput(_peers.a, 'push', now, 1066, true); now=1001; _checkOverduePushes(); _serviceOwnerRepair(mod)",
  );
  await flush();
  assert.equal(expired('_ownerRepair'), null);
  assert.deepEqual(JSON.parse(expired('summary()')).reads, [1076]); // legacy capture
  for (const setup of ['RB_WORKER_COPROC=true', '_activeRoster.delete(2); _activeRoster.delete(3)']) {
    const run = room();
    run(`${setup}; _escalateLostInput(_peers.a, 'push', now, 1066, true)`);
    await flush();
    assert.equal(run('bootEmits.length'), 0);
    assert.equal(run('_ownerRepair'), null);
    assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  }
});

for (const [game, remix] of [
  ['stock', false],
  ['Smash Remix battle', true],
] as const)
  test(`${game}: guest replies only with inputs recorded at their exact frame/current SID, not placeholder or reused identity`, () => {
    const run = room();
    if (remix) run('remix=true; gameStatus=1; sceneCurr=22');
    run(`
    _playerSlot=1; _peers.a.slot=0; _knownPlayers.a.socketId='actual-host'; socket.id='actual-p2';
    const authored={buttons:2,lx:0,ly:0,cx:0,cy:0};
    _localInputs[1066]=authored; _recordAuthoredOwnerInput(1066,authored);
    _localInputs[1067]=authored; _localInputs[1068]=KNShared.ZERO_INPUT;
    const request={type:'recovery-input-proof-request',targetSid:'actual-p2',token:'long-enough-opaque-token',
      ids:[1066,1067,1068],knFrom:{sid:'actual-host',slot:0,owner:true}};
    onDataMessage(request);
  `);
    const sent = JSON.parse(run('JSON.stringify(bootEmits.at(-1).data)'));
    assert.deepEqual(sent.samples, [[1066, [2, 0, 0, 0, 0]]]);
    run("socket.id='rotated-p2'; onDataMessage({...request,targetSid:socket.id});");
    assert.equal(run('bootEmits.length'), 1);
  });

test('the protected read requires every active owner, at actual capture rather than dispatch', async () => {
  const run = room(true);
  run(`
    _peers.a.syncDc=stateChannel('returning');
    const debt={
      slot:1,sid:'a',gen:3,epoch:9,matchId:KNState.matchId,deadline:1500,status:'waiting',failed:0,
      from:1073,through:1072,receipts:new Set(),lastHandoffId:0,request:null,
    };
    _hostReconnectDebts.set(1,debt);
    _receiveReconnectProofRequest('a',27,'dc');
    bystanderHole=true;
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.deepEqual(JSON.parse(run('summary()')).reads, []);
  assert.equal(run('headerWrites.length'), 0);
  run(`
    bystanderHole=false; now=150;
    _corePhantomHistory.add(2);
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.equal(run('headerWrites.length'), 0);
  run(`
    _corePhantomHistory.delete(2); now=300;
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076], run('JSON.stringify({proofLogs,debt})'));
  assert.equal(run("headerWrites.filter(([,msg])=>msg==='sync-start:1076:1:1:0:27').length"), 1);
});

test('successful wire handoff does not retire protected retry after an unsuccessful guest apply', async () => {
  const run = room(true);
  run(`
    _peers.a.syncDc=stateChannel('returning');
    const debt={
      slot:1,sid:'a',gen:3,epoch:9,matchId:KNState.matchId,deadline:1500,status:'waiting',failed:0,
      from:1073,through:1072,receipts:new Set(),lastHandoffId:0,request:null,
    };
    _hostReconnectDebts.set(1,debt);
    _receiveReconnectProofRequest('a',27,'dc');
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.equal(
    run('_hostReconnectDebts.get(1) === debt && debt.lastHandoffId === 27'),
    true,
    run('JSON.stringify({proofLogs,debt})'),
  );
  assert.equal(run('debt.request'), null);
  assert.equal(run('_scheduledSyncRequests.some(q=>q.followUp)'), false);
  run(`
    now=300;
    _receiveReconnectProofRequest('a',26,'dc');
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.equal(run('reads.length'), 1, 'no automatic or stale retransmission');
  // Guest failed to apply the first handed-off state and sends its next
  // bounded proof request. Identical wire duplicates share the in-flight work.
  run(`
    _receiveReconnectProofRequest('a',28,'dc');
    _serviceReconnectHostAnswers();
    _receiveReconnectProofRequest('a',28,'dc');
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.equal(run("headerWrites.filter(([,msg])=>msg==='sync-start:1076:1:1:0:28').length"), 1);
  assert.equal(run('reads.length'), 2);
  run(`
    now=1500;
    _receiveReconnectProofRequest('a',29,'dc');
    _serviceReconnectHostAnswers();
  `);
  assert.equal(run('_hostReconnectBlocksNativeCapture(mod)'), false);
  assert.equal(run('_hostReconnectDebts.size'), 0);
  assert.equal(run('reads.length'), 2, 'expired proof cannot be requested');
});

test('a protected native capture proves host history even when every delivery attempt fails', async () => {
  const run = room(true);
  run(`
    _peers.a.syncDc={ ...stateChannel('returning'), send:() => { throw new Error('closed during send'); } };
    const debt={
      slot:1,sid:'a',gen:3,epoch:9,matchId:KNState.matchId,deadline:1500,status:'waiting',failed:0,
      from:1073,through:1072,receipts:new Set(),lastHandoffId:0,request:null,
    };
    _hostReconnectDebts.set(1,debt);
    _receiveReconnectProofRequest('a',27,'dc');
    _serviceReconnectHostAnswers();
  `);
  await flush();
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  assert.equal(run('debt.historyProven'), true);
  assert.equal(run('debt.lastHandoffId'), 0);
  run('now=1500; _serviceReconnectHostAnswers();');
  assert.equal(run('_hostReconnectDebts.size'), 0);
  assert.equal(run('_hostReconnectBlocksNativeCapture(mod)'), false);
});

test('the current room marker invalidates queued captures and fences a later slot-zero authority', async () => {
  const run = room();
  run(`
    compressGate=new Promise(resolve=>{allowCompression=resolve});
    const queued=pushSyncState('a');
  `);
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  assert.equal(run("_setHostMatchUnverified('old-match', 'room recovery unverified')"), false);
  run(`
    let _lateJoinServeSeq=0;
    const _markPendingLateJoinPeer=()=>{};
    _playerSlot=1;
    _setHostMatchUnverified(KNState.matchId, 'room recovery unverified');
    allowCompression();
  `);
  await run('queued');
  assert.deepEqual(JSON.parse(run('summary()')).shipments, []);

  run('_playerSlot=0');
  await run("Promise.all([pushSyncState('a'), sendLateJoinState('b')])");
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076]);
  assert.deepEqual(JSON.parse(run('summary()')).shipments, []);

  run("KNState.matchId='next-match'");
  await run("pushSyncState('a')");
  assert.deepEqual(JSON.parse(run('summary()')).reads, [1076, 1076]);
  assert.equal(JSON.parse(run('summary()')).shipments.length, 1);
});
