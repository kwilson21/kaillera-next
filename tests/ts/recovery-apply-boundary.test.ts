import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { reconnectProofSource } from './fixtures/reconnect-proof-source.ts';
const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const between = (a: string, b: string) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const decode = between('  async function _handleDecodedSyncPayload(', '  const handleSyncChunksComplete =');
function decoder() {
  const c = vm.createContext({});
  vm.runInContext(
    `
 let _lastAppliedRecoveryId=0,_lastAppliedSyncHostFrame=99;
 let _pendingResyncState={frame:101,recoveryId:8,answerFor:0,bytes:'new'};
 let _syncApplyDeferredAt = 0;
 const _armGuestRecoveryClock = () => {};
 ${between('  const _stageGuestRecovery =', '  const _serviceGuestRecoveryBoundary =')}
 const _endsResyncRequest=()=>false,_syncLog=()=>{},_keepsAwaitedAnswer=()=>false;
 let _resyncRequestInFlight=false;const _resyncRequestId=0,_lastSyncState={length:1};
 let finishXor;const workerPost=()=>new Promise(r=>finishXor=r);
 ${reconnectProofSource(source)}
 ${decode}
 globalThis.receive=(frame,isFull=true,recoveryId=0)=>_handleDecodedSyncPayload({decompressed:{length:1},frame,isFull,isProactive:false,isRegions:false,wireSize:1,source:'socket',answerFor:0,recoveryId});
 `,
    c,
  );
  return c;
}
for (const frame of [100, 101])
  test(`ordinary frame ${frame} cannot overwrite pending recovery frame101`, async () => {
    const c = decoder();
    await c.receive(frame);
    assert.equal(vm.runInContext('_pendingResyncState.recoveryId', c), 8);
  });
test('ordinary higher frame remains eligible', async () => {
  const c = decoder();
  await c.receive(102);
  assert.equal(vm.runInContext('_pendingResyncState.frame', c), 102);
});
test('legacy XOR finishing after a newer token cannot overwrite it', async () => {
  const c = decoder();
  vm.runInContext('_pendingResyncState=null', c);
  const p = c.receive(100, false);
  vm.runInContext("_pendingResyncState={frame:101,recoveryId:8,answerFor:0};finishXor({data:'old'});", c);
  await p;
  assert.equal(vm.runInContext('_pendingResyncState.recoveryId', c), 8);
});
for (const [label, refuses, warning, guarded] of [
  ['native frame refusal fails closed', true, 'none', false],
  ['native frame success settles once', false, 'none', false],
  ['an exact unverified warning received after buffering blocks the ordinary native write', false, 'current', false],
  ['a previous-match warning does not block an ordinary native write in a new match', false, 'previous', false],
  ['the current protected answer can settle before any published warning', false, 'none', true],
  ['a same-match unverified warning also blocks an earlier buffered protected answer', false, 'current', true],
] as const)
  test(label, () => {
    const c = vm.createContext({ Uint8Array, Error, refuses, warning, guarded });
    vm.runInContext(
      `
 let _frameNum=99,_lastAppliedRecoveryId=0,_resyncCount=0,_consecutiveResyncs=0,_coreFatalError=false,acks=0,_cutRerun=null;
 const _hasKnSync=true, _syncBufPtr=1,_syncBufSize=8,KNState={frameNum:99,matchId:'live'};
 let native=99; const calls=[];
 const _peers={host:{slot:0}}, _syncQueueEpoch=1, _syncQueueGen={host:2};
 const mod={HEAPU8:new Uint8Array(16),_kn_sync_write:()=>{calls.push('write');return 0},_kn_set_frame:f=>{calls.push('frame');if(!refuses)native=f},_kn_get_frame:()=>native};
 const _applyResyncExtras=(m,extras)=>calls.push(extras);
 const window={EJS_emulator:{gameManager:{Module:mod}}},performance={now:()=>0};
 const ensureSyncBuffer=()=>{},_syncLog=()=>{},recaptureManualRunner=()=>{},_setLastSyncState=()=>{};
 const _resetStrictMenuResends=()=>{};
 const _handleCoreFatal=()=>{_coreFatalError=true};
 const _settleInputsAtResync=()=>{acks++;throw Error('settled-test-boundary')};
 ${reconnectProofSource(source)}
 ${between('  const _syncStateCanInstall =', '  // -- Init / Stop API')}
 const queuedState = new Uint8Array([1]); // the last chunk already arrived
 const scope = guarded ? _reconnectAnswerScope('host') : null;
 if(guarded) _reconnectAnswerDebt={id:9,status:'waiting',scope,absolute:200};

 if(warning==='current') _setHostMatchUnverified('live','room recovery unverified');
 if(warning==='previous') {
   KNState.matchId='previous';
   _setHostMatchUnverified('previous','room recovery unverified');
   KNState.matchId='live';
 }
 const recoveryId=(!guarded && warning==='none')?8:0;
 const proof=guarded?9:0;
 try {
   if (_syncStateCanInstall({bytes:queuedState,frame:100,recoveryId,answerFor:proof,answerScope:scope,proofFor:proof}))
     applySyncState(queuedState,100,false,recoveryId,'extras',proof,scope,proof)
 }
 catch(e){if(e.message!=='settled-test-boundary')throw e}
 globalThis.result={fatal:_coreFatalError,acks,frame:_frameNum,knFrame:KNState.frameNum,id:_lastAppliedRecoveryId,calls};
 `,
      c,
    );
    const blocked = warning === 'current';
    const settled = !refuses && !blocked;
    assert.equal(c.result.fatal, refuses);
    assert.equal(c.result.acks, settled ? 1 : 0);
    assert.equal(c.result.frame, settled ? 100 : 99);
    assert.equal(c.result.knFrame, settled ? 100 : 99);
    assert.equal(c.result.id, settled && !guarded && warning === 'none' ? 8 : 0);
    // The hidden words and HLE state go in straight after the state, in the same step.
    assert.deepEqual([...c.result.calls], blocked ? [] : ['write', 'extras', 'frame']);
  });

test('hidden words are restored only as all 18: the native restore reads 18', () => {
  const start = source.indexOf('  const _restoreHiddenStateWords = ');
  const restore = source.slice(start, source.indexOf('\n  };', start) + 5);
  for (const count of [1, 17, 18]) {
    const c = vm.createContext({ Uint32Array });
    vm.runInContext(
      `
 const restored=[], logs=[];
 const mod={HEAPU32:new Uint32Array(64),_malloc:()=>16,_free:()=>{},_kn_restore_hidden_state_impl:(ptr)=>restored.push([...mod.HEAPU32.slice(ptr>>2,(ptr>>2)+18)])};
 const _syncLog=(l)=>logs.push(l);
 ${restore}
 globalThis.result={ok:_restoreHiddenStateWords(mod,[...Array(${count})].map((_,i)=>i+1),'resync'),restored,logs};
 `,
      c,
    );
    assert.equal(c.result.ok, count === 18, `${count} words`);
    assert.equal(c.result.restored.length, count === 18 ? 1 : 0);
    if (count === 18)
      assert.deepEqual(
        [...c.result.restored[0]],
        [...Array(18)].map((_, i) => i + 1),
      );
  }
});
