import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRecoveryTransferPool } from '../../web/src/recovery-transfer.ts';
const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const between = (a: string, b: string) => {
  const start = source.indexOf(a);
  assert.ok(start >= 0);
  const end = source.indexOf(b, start);
  assert.ok(end > start);
  return source.slice(start, end);
};

test('stopping a worker rejects captured work and suppresses compression fallback', async () => {
  const context = vm.createContext({
    _hostReconnectBlocksNativeCapture: () => false,
    _hostReconnectFenceVersion: 0,
    DOMException,
    createRecoveryTransferPool,
  });
  vm.runInContext(
    `
    let _syncWorkerCallbacks = {}, _syncWorkerNextId = 0, fallbackCalls = 0;
    const getSyncWorker = () => ({ postMessage() {} });
    ${between('  const workerPost =', '  // -- Compression helpers')}
    const compressStateFallback = async () => { fallbackCalls++; };
    ${between('  async function compressState(bytes)', '  async function compressStateFallback')}
    const pool = createRecoveryTransferPool();
    const attempt = {slot:1,sid:'guest',hole:9,id:1};
    globalThis.pending = pool.run([attempt], () => compressState(new Uint8Array([1,2])), () => null);
  `,
    context,
  );
  const result = context.pending.catch(() => 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('pool.size()', context), 1);
  vm.runInContext(between('    const cancelledWork = _syncWorkerCallbacks;', '    _syncLogRing.clear();'), context);
  assert.equal(await result, 'cancelled');
  assert.equal(vm.runInContext('pool.size()', context), 0);
  assert.equal(await vm.runInContext('pool.run([attempt], async () => 42, () => -1)', context), 42);
  assert.equal(vm.runInContext('fallbackCalls', context), 0);
  assert.equal(vm.runInContext('Object.keys(_syncWorkerCallbacks).length', context), 0);
});

test('coordinated requests wait for dedicated state transport, not input channel', () => {
  const context = vm.createContext({ _hostReconnectBlocksNativeCapture: () => false, _hostReconnectFenceVersion: 0 });
  vm.runInContext(
    `const _peers = {a:{dc:{readyState:'open'},syncDc:{readyState:'connecting'}}};
    const _syncLog=()=>{};
    ${between('    const reachable = (r) => {', '    // Confirmation skips phantom peers')}
    globalThis.result = reachable({targetSid:'a'});`,
    context,
  );
  assert.equal(context.result, false);
  assert.equal(vm.runInContext("_peers.a.syncDc.readyState='open'; reachable({targetSid:'a'})", context), true);
});

test('failed late-join preparation retains a dropped guest gate', async () => {
  for (const captureThrows of [false, true]) {
    const context = vm.createContext({
      _hostReconnectBlocksNativeCapture: () => false,
      _hostReconnectFenceVersion: 0,
      Uint8Array,
      captureThrows,
    });
    vm.runInContext(
      `
      const _peers={a:{slot:1}}, _knownPlayers={}, _droppedThisMatch=new Set(['a']);
      const _lateJoinServing=new Map(); let _lateJoinServeSeq=0, _lateJoinPausedAt=0, _runSubstate=0;
      const RUN_LATE_JOIN_PAUSE=1,LATE_JOIN_TIMEOUT_MS=5000,_frameNum=100;
      const performance={now:()=>1},setTimeout=()=>{};
      const _markPendingLateJoinPeer=()=>{},_clearPendingLateJoinPeer=()=>{},_syncLog=()=>{};
      const _endLateJoinPauseIfNoneServed=()=>{};
      const window={EJS_emulator:{gameManager:captureThrows?{getState(){throw Error('capture');}}:null}};
      ${between('  async function sendLateJoinState(remoteSid)', '  // Joiner: a full resync')}
      globalThis.pending=sendLateJoinState('a');
    `,
      context,
    );
    await context.pending;
    assert.equal(vm.runInContext("_droppedThisMatch.has('a')", context), true);
    assert.equal(vm.runInContext('_lateJoinServing.size', context), 0);
  }
});
