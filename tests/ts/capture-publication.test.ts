import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRecoveryManager } from '../../web/src/recovery-delivery.ts';
import { createRecoveryTransferPool } from '../../web/src/recovery-transfer.ts';

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

function room() {
  const context = vm.createContext({ createRecoveryManager, createRecoveryTransferPool, Uint8Array, queueMicrotask });
  vm.runInContext(
    `
    let now=1, _frameNum=1076, nativeFrame=1076, depth=0, pending=-1, failures=0;
    let _syncQueueEpoch=9, _pushingSyncState=false, _proactivePushInFlight=false;
    const PHASE_RUNNING=5, RUN_LATE_JOIN_PAUSE=1, _phase=5, _runSubstate=0, _playerSlot=0;
    const _useCRollback=true, _hasKnSync=true, RB_WORKER_COPROC=false, _isSmashRemix=()=>false;
    const _syncEnabled=true, _coreFatalError=false, DELAY_FRAMES=3, SYNC_COORD_TIMEOUT_MS=3000;
    const _lateJoinServing=new Map(), _queuedSyncPushes=new Map(), _followUpWatches=new Map();
    const _syncSendChains={}, _syncChainMovedAt={}, _peerPhantom={}, _knownPlayers={};
    const _peers={a:{slot:1},b:{slot:2},c:{slot:3}}, _syncQueueGen={a:3,b:4,c:5};
    const performance={now:()=>now}, _syncLog=()=>{};
    const _syncBufPtr=1, _syncBufSize=8, reads=[], shipments=[], outcomes=[], bootEmits=[];
    const socket={emit:(event, data)=>bootEmits.push({event,data})};
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
    const window={EJS_emulator:{gameManager:{Module:mod,getState(){throw Error('late or raw state escaped');}}}};
    const ensureSyncBuffer=()=>{};
    const _recovery=createRecoveryManager({timeoutMs:5000,quietMs:20000,maxPushes:3},()=>{});
    const _recoveryTransfers=createRecoveryTransferPool();
    const _syncTargetsFor=(sid)=>Object.entries(_peers).filter(([id])=>!sid||id===sid)
      .map(([id,peer])=>({sid:id,peer,epoch:_syncQueueEpoch,gen:_syncQueueGen[id]}));
    const _syncTargetCurrent=(t)=>t.epoch===_syncQueueEpoch && t.peer===_peers[t.sid] && t.gen===_syncQueueGen[t.sid];
    const _sendSyncChunksTo=async (t,bytes,frame)=>{shipments.push({sid:t.sid,frame,bytes:[...bytes]}); return 'sent'};
    const _onEscalationTransfer=(attempts,sid,sent,frame)=>outcomes.push([attempts.length,sid,sent,frame]);
    const _getTop=()=>_syncTargetsFor(null).map(t=>({id:t.sid,slot:t.peer.slot,generation:t.gen}));
    const observe=()=>({activeOwners:_getTop(),allRequiredInputsConfirmed:true,initialFailedRollbacks:0});
    const _scheduledSyncRequests=[{targetSid:'a',targetFrame:1000,deadlineAt:1,requestId:4}];
    ${fn('_emitSaveStateToPlayers')}
    ${fn('_runQueuedSyncPush')}
    ${fn('_openCapturePublication')}
    ${fn('_deferMatchCapture')}
    ${part('  const _ownedCaptureScope =', '  const _sealAndPublishCapture =')}
    ${fn('_sealAndPublishCapture')}
    ${fn('pushSyncState')}
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
