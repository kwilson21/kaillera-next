import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { mayReceiveState } from '../../web/src/sync-chunk-room.ts';
const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const start = source.indexOf('  const setupSyncDataChannel = ');
const handler = source.slice(start, source.indexOf('\n  };', start) + 5);
function room() {
  const context = vm.createContext({ mayReceiveState, ArrayBuffer, Uint8Array });
  vm.runInContext(
    `
    const window = { KNCore: { syncSend: { mayReceiveState } } };
    const _peers = { host: { slot: 0 }, guest: { slot: 2 } };
    let _syncRecoveryId=0, _syncExpected=0, _syncChunks=[], _syncFrame=0, _syncIsFull=false,
      _syncIsProactive=false, _syncIsRegions=false, _syncAnswerFor=0,
      _syncLastChunkProgressLogAt=0, _syncChunkSessionId=0,
      _syncChunkTimeoutTimer=null, _rearmSyncChunkDeadline=null,
      _hostNumbersAnswers=false, complete=0;
    const _peerBoundary=()=>({peerText:()=>true}), _requestIdFrom=n=>n,
      _syncLog=()=>{}, performance={now:()=>1000},
      clearTimeout=()=>{}, setTimeout=()=>1, SYNC_CHUNK_TIMEOUT_MS=5000;
    const handleSyncChunksComplete=()=>{complete++};
    ${handler}
    const host={},guest={};
    _peers.host.syncDc=host; setupSyncDataChannel('host',host);
    host.onmessage({data:'sync-start:100:2:1:0'});
    host.onmessage({data:new Uint8Array([7]).buffer});
  `,
    context,
  );
  return (code: string) => vm.runInContext(code, context);
}
test('other channel setup, answer ids, headers and chunks cannot corrupt host assembly', () => {
  const run = room();
  run(`_peers.guest.syncDc=guest; setupSyncDataChannel('guest',guest);
    guest.onmessage({data:'sync-answer-id:9'});
    guest.onmessage({data:'sync-start:999:1:1:0'});
    guest.onmessage({data:new Uint8Array([99]).buffer});`);
  assert.equal(run('_syncExpected'), 2);
  assert.equal(run('_syncChunks.length'), 1);
  assert.equal(run('_syncChunks[0][0]'), 7);
  assert.equal(run('complete'), 0);
  run(`host.onmessage({data:new Uint8Array([8]).buffer})`);
  assert.equal(run('complete'), 1);
  assert.equal(run('_syncChunks[1][0]'), 8);
});
test('stale host channel cannot supply chunks after replacement or removal', () => {
  const run = room();
  run(`const replacement={}; _peers.host.syncDc=replacement;
    setupSyncDataChannel('host',replacement);
    replacement.onmessage({data:'sync-start:200:1:1:0'});
    host.onmessage({data:new Uint8Array([99]).buffer});`);
  assert.equal(run('_syncChunks.length'), 0);
  run(`replacement.onmessage({data:new Uint8Array([8]).buffer})`);
  assert.equal(run('complete'), 1);
  run(`delete _peers.host; replacement.onmessage({data:new Uint8Array([99]).buffer})`);
  assert.equal(run('complete'), 1);
});
test('only slot zero and the current channel are accepted', () => {
  for (const slot of [-1, 0, 1, 2, 3])
    for (const current of [false, true]) assert.equal(mayReceiveState(slot, current), slot === 0 && current);
});

test('recovery IDs from another or replaced host channel cannot enter the current header', () => {
  const run = room();
  run(`_peers.guest.syncDc=guest; setupSyncDataChannel('guest',guest);
    guest.onmessage({data:'sync-recovery-id:999'});
    host.onmessage({data:'sync-recovery-id:17'});
    host.onmessage({data:'sync-start:101:2:1:0'});`);
  assert.equal(run('_syncRecoveryId'), 17);
  run(`const replacement={}; _peers.host.syncDc=replacement;
    setupSyncDataChannel('host',replacement);
    host.onmessage({data:'sync-recovery-id:999'});
    replacement.onmessage({data:'sync-start:102:2:1:0'});`);
  assert.equal(run('_syncRecoveryId'), 0);
});

test('actual decoder discards an old channel or match result even when fallback cannot cancel', async () => {
  const start = source.indexOf('  const handleSyncChunksComplete = ');
  const decoder = source.slice(start, source.indexOf('\n  };', start) + 5);
  for (const change of ['_syncQueueEpoch++', 'owns=false', '']) {
    const context = vm.createContext({ Uint8Array });
    vm.runInContext(
      `
      let _syncQueueEpoch=1, owns=true, resolveDecode, applied=0;
      let _syncChunks=[new Uint8Array([1])], _syncExpected=1,
        _syncRecoveryId=17, _syncFrame=1000, _syncIsFull=true,
        _syncIsProactive=false, _syncIsRegions=false, _syncAnswerFor=0;
      const _syncLog=()=>{}, _decodingSyncAnswer=fn=>fn();
      const decompressState=()=>new Promise(resolve=>{resolveDecode=resolve});
      const _handleDecodedSyncPayload=()=>{applied++};
      ${decoder}
      const pending=handleSyncChunksComplete(()=>owns);
    `,
      context,
    );
    vm.runInContext(`${change}; resolveDecode(new Uint8Array([1]));`, context);
    await vm.runInContext('pending', context);
    assert.equal(vm.runInContext('applied', context), change ? 0 : 1);
  }
});
