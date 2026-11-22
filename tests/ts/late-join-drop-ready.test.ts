import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const part = (a: string, b: string) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
function room(peerPresent = false) {
  const c = vm.createContext({ Uint8Array, peerPresent });
  vm.runInContext(
    `
 const peer={slot:1,dc:{readyState:'open',send(){}}};
 const _peers=peerPresent?{a:peer}:{},_knownPlayers={a:{slot:1}},_droppedThisMatch=new Set(['a']);
 const _lateJoinServing=new Map(),_lateJoinStateSent=new Map(),_pendingLateJoinReadySids=new Set(),_lateJoinReadyHandled=new Set(),_lateJoinOfferedDelay=new Map();
 let _lateJoinServeSeq=0,_lateJoinPausedAt=0,_runSubstate=0,_syncQueueEpoch=1;
 const _syncQueueGen={},RUN_LATE_JOIN_PAUSE=1,LATE_JOIN_TIMEOUT_MS=15000,_frameNum=100,_playerSlot=0,DELAY_FRAMES=12,_rbTransport='reliable';
 let pending=false,activated=0,emits=0,resumes=0; const timers=[];
 const performance={now:()=>1},setTimeout=f=>timers.push(f);
 const _markPendingLateJoinPeer=()=>{pending=true},_clearPendingLateJoinPeer=(sid,slot,why,opts)=>{pending=false;if(opts?.activate)activated++};
 const _syncLog=()=>{},_endLateJoinPauseIfNoneServed=()=>{},_captureHiddenStateWords=()=>null,_captureAudioFifoState=()=>null,_captureSaveRam=()=>null;
 const _resetPacingAfterLateJoin=()=>{},_broadcastRoster=()=>{},_config=null,resumeLateJoinPause=()=>{resumes++};
 const _signalSocket={emit(){emits++}};
 const window={EJS_emulator:{gameManager:{getState:()=>new Uint8Array([1]),Module:{}}}};
 let compression;const compressAndEncode=()=>new Promise(r=>compression=r);
 const hardDisconnectPeer=()=>{delete _peers.a;pending=false};
 ${part('  async function sendLateJoinState(remoteSid)', '  // Joiner: a full resync')}
 ${part('  const finishLateJoinReady =', '  const _syntheticSidForSlot')}
 const _peerDriver=()=>null,_startSteps=new Map(),_endKeptOpen=()=>{},queueMicrotask=()=>{};
 const _lateJoinInputWindows=new Map();
 const _clearSlotInputState=()=>{},_peerLastAdvanceTime={},_peerPhantom={},_consecutiveFabrications={},_inputLateLogTime={},_auditLastRemote={};
 const _pendingCInputs=[],_followUpWatches=new Map(),_queuedSyncPushes=new Map(),_syncSendChains={},_syncChainMovedAt={};
 let _scheduledSyncRequests=[];const clearPeerStallTimers=()=>{},_useCRollback=false,_awaitFirstInputAfterReset={};
 ${part('  const resetPeerState =', '  // -- Peer disconnect')}
 globalThis.reset=()=>resetPeerState(1,'drop',{sid:'a',peer});
 globalThis.send=()=>sendLateJoinState('a');globalThis.ready=()=>finishLateJoinReady('Socket.IO','a');
 globalThis.finish=()=>compression({data:'x',rawSize:1,compressedSize:1});
 `,
    c,
  );
  return c;
}
test('silent relay loss and no-peer timeout cannot allow mesh admission; fresh ready can', async () => {
  const c = room();
  let p = c.send();
  c.finish();
  await p;
  assert.equal(vm.runInContext('emits', c), 1);
  vm.runInContext('timers[0]()', c);
  assert.equal(vm.runInContext("!pending && _droppedThisMatch.has('a')", c), true);
  // An unsolicited ready after the expired serve cannot clear the gate.
  c.ready();
  assert.equal(vm.runInContext("_droppedThisMatch.has('a')", c), true);
  vm.runInContext('_peers.a=peer', c);
  p = c.send();
  c.finish();
  await p;
  c.ready();
  assert.equal(vm.runInContext("_droppedThisMatch.has('a')", c), false);
  assert.equal(vm.runInContext('activated', c), 1);
});
test('disconnect during compression keeps gate and suppresses obsolete emission', async () => {
  const c = room(true);
  const p = c.send();
  vm.runInContext('delete _peers.a', c);
  c.finish();
  await p;
  assert.equal(vm.runInContext('emits', c), 0);
  vm.runInContext('timers[0]()', c);
  assert.equal(vm.runInContext("!pending && _droppedThisMatch.has('a')", c), true);
});
test('premature ready and a replaced peer cannot release dropped admission', async () => {
  const c = room(true);
  const p = c.send();
  c.ready();
  assert.equal(vm.runInContext('activated', c), 0);
  c.finish();
  await p;
  vm.runInContext("_peers.a={slot:1,dc:{readyState:'open'}}", c);
  c.ready();
  assert.equal(vm.runInContext("_droppedThisMatch.has('a')", c), true);
});
test('deferred ready retains gate until current DC opens and rejects old match evidence', async () => {
  const c = room(true);
  vm.runInContext("peer.dc.readyState='connecting'", c);
  const p = c.send();
  c.finish();
  await p;
  c.ready();
  assert.equal(vm.runInContext("_droppedThisMatch.has('a') && _pendingLateJoinReadySids.has('a')", c), true);
  vm.runInContext("peer.dc.readyState='open';_syncQueueEpoch++", c);
  c.ready();
  assert.equal(vm.runInContext('activated', c), 0);
  vm.runInContext('_syncQueueEpoch--', c);
  c.ready();
  assert.equal(vm.runInContext('activated', c), 1);
});

test('old compression cannot grant evidence to a replacement serve', async () => {
  const c = room(true);
  const old = c.send();
  vm.runInContext("globalThis.oldCompression=compression;_lateJoinServing.delete('a')", c);
  const fresh = c.send();
  c.oldCompression({ data: 'old', rawSize: 1, compressedSize: 1 });
  await old;
  assert.equal(vm.runInContext("_lateJoinStateSent.has('a')", c), false);
  c.ready();
  assert.equal(vm.runInContext('activated', c), 0);
  c.finish();
  await fresh;
  c.ready();
  assert.equal(vm.runInContext('activated', c), 1);
});

test('second late join on the same socket accepts fresh readiness after peer reset', async () => {
  const c = room(true);
  for (let join = 0; join < 2; join++) {
    const p = c.send();
    c.finish();
    await p;
    c.ready();
    assert.equal(vm.runInContext('activated', c), join + 1);
    c.reset();
    vm.runInContext("_droppedThisMatch.add('a')", c);
  }
});

test('deferred ready with a DC that never opens is cleaned up by its serve deadline', async () => {
  for (const peerRemains of [true, false]) {
    const c = room(true);
    vm.runInContext("peer.dc.readyState='connecting'", c);
    const p = c.send();
    c.finish();
    await p;
    c.ready();
    if (!peerRemains) vm.runInContext('delete _peers.a', c);
    vm.runInContext('timers[0]()', c);
    assert.equal(
      vm.runInContext(
        "pending || _pendingLateJoinReadySids.has('a') || _lateJoinStateSent.has('a') || _lateJoinServing.has('a')",
        c,
      ),
      false,
    );
    assert.equal(vm.runInContext("_droppedThisMatch.has('a')", c), true);
    vm.runInContext("_peers.a=peer;peer.dc.readyState='open'", c);
    c.ready();
    assert.equal(vm.runInContext('activated', c), 0);
  }
});

test('deferred readiness resumes existing players while keeping only its own deadline', async () => {
  const c = room(true);
  vm.runInContext("peer.dc.readyState='connecting'", c);
  const p = c.send();
  c.finish();
  await p;
  c.ready();
  assert.equal(vm.runInContext('resumes', c), 1);
  assert.equal(vm.runInContext("_lateJoinServing.has('a')", c), true);
  vm.runInContext("peer.dc.readyState='open'", c);
  c.ready();
  vm.runInContext('timers[0]()', c);
  assert.equal(vm.runInContext('activated', c), 1);
  assert.equal(vm.runInContext('!!_peers.a', c), true);
});

test('old serve deadline cannot cancel a second serve on the same socket', async () => {
  const c = room(true);
  let p = c.send();
  c.finish();
  await p;
  c.ready();
  c.reset();
  vm.runInContext("_droppedThisMatch.add('a');peer.dc.readyState='connecting'", c);
  p = c.send();
  c.finish();
  await p;
  c.ready();
  vm.runInContext('timers[0]()', c);
  assert.equal(vm.runInContext("pending && _lateJoinServing.has('a')", c), true);
  vm.runInContext('timers[1]()', c);
  assert.equal(vm.runInContext('pending', c), false);
});

test('a deferred joiner does not keep the room paused after another joiner finishes loading', async () => {
  const c = room(true);
  vm.runInContext("peer.dc.readyState='connecting';_lateJoinServing.set('b',99)", c);
  const p = c.send();
  c.finish();
  await p;
  c.ready();
  assert.equal(vm.runInContext('resumes', c), 0);
  vm.runInContext("_peers.b={slot:2,dc:{readyState:'open',send(){}}};finishLateJoinReady('Socket.IO','b')", c);
  assert.equal(vm.runInContext('resumes', c), 1);
  assert.equal(vm.runInContext("_lateJoinServing.has('a')", c), true);
  vm.runInContext('timers[0]()', c);
  assert.equal(vm.runInContext('!!_peers.b', c), true);
});
