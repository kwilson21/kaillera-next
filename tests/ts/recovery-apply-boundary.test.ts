import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const between = (a: string, b: string) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const decode = between('  async function _handleDecodedSyncPayload(', '  const handleSyncChunksComplete =');
function decoder() {
  const c = vm.createContext({});
  vm.runInContext(
    `
 let _lastAppliedRecoveryId=0,_lastAppliedSyncHostFrame=99;
 let _pendingResyncState={frame:101,recoveryId:8,answerFor:0,bytes:'new'};
 const _endsResyncRequest=()=>false,_syncLog=()=>{},_keepsAwaitedAnswer=()=>false;
 let _resyncRequestInFlight=false;const _resyncRequestId=0,_lastSyncState={length:1};
 let finishXor;const workerPost=()=>new Promise(r=>finishXor=r);
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
for (const refuses of [true, false])
  test(`native frame ${refuses ? 'refusal fails closed' : 'success settles once'}`, () => {
    const c = vm.createContext({ Uint8Array, Error, refuses });
    vm.runInContext(
      `
 let _frameNum=99,_lastAppliedRecoveryId=0,_resyncCount=0,_consecutiveResyncs=0,_coreFatalError=false,acks=0;
 const _hasKnSync=true, _syncBufPtr=1,_syncBufSize=8,KNState={frameNum:99};
 let native=99;
 const mod={HEAPU8:new Uint8Array(16),_kn_sync_write:()=>0,_kn_set_frame:f=>{if(!refuses)native=f},_kn_get_frame:()=>native};
 const window={EJS_emulator:{gameManager:{Module:mod}}},performance={now:()=>0};
 const ensureSyncBuffer=()=>{},_syncLog=()=>{},recaptureManualRunner=()=>{},_setLastSyncState=()=>{};
 const _resetStrictMenuResends=()=>{};
 const _handleCoreFatal=()=>{_coreFatalError=true};
 const _settleInputsAtResync=()=>{acks++;throw Error('settled-test-boundary')};
 ${between('  const applySyncState =', '  // -- Init / Stop API')}
 try {applySyncState(new Uint8Array([1]),100,false,8)}catch(e){if(e.message!=='settled-test-boundary')throw e}
 globalThis.result={fatal:_coreFatalError,acks,frame:_frameNum,knFrame:KNState.frameNum,id:_lastAppliedRecoveryId};
 `,
      c,
    );
    assert.equal(c.result.fatal, refuses);
    assert.equal(c.result.acks, refuses ? 0 : 1);
    assert.equal(c.result.frame, refuses ? 99 : 100);
    assert.equal(c.result.knFrame, refuses ? 99 : 100);
    assert.equal(c.result.id, refuses ? 0 : 8);
  });
