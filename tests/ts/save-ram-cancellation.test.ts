import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const between = (a: string, b: string) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const helpers = between('  const _encodeSaveRam =', '  // 2026-04-29 audio-diag');

// Execute the real initial-state continuation: cancellation during the second
// worker operation (save RAM) must not resurrect a stopped match or emit state.
async function initialStateStoppedDuringSidecar(helperSource: string) {
  const context = vm.createContext({ Uint8Array, DOMException });
  vm.runInContext(
    `
    let _phase=1, emitted=0, retryCalls=0, compressCalls=0;
    const PHASE_LOCKSTEP_READY=2, _playerSlot=0, _rttComplete=false, _config=null;
    let _guestStateBytes=null, _guestStateKind=null, _guestStateHiddenWords=null;
    let _guestStateAudioFifo=null, _guestStateCapturedLocally=false;
    const window={EJS_emulator:{gameManager:{Module:{}}}};
    const waitForSmashTitleState=async()=>{};
    const _captureInitialStateBytes=()=>({bytes:new Uint8Array([1]),kind:'kn-sync'});
    const _captureSaveRam=()=>new Uint8Array([2]);
    const _syncLog=()=>{}, _clearInputsForNewMatch=()=>{}, _recordStartCohortIfMissing=()=>{};
    const checkAllLockstepReady=()=>{}, _getRuntimeFamily=()=> 'test';
    const _emitSaveStateToPlayers=()=>{emitted++};
    const _retryHostState=()=>{retryCalls++};
    const compressAndEncode=async()=>{
      if (++compressCalls===1) return {data:'state',rawSize:1,compressedSize:1};
      _phase=0; // stop() clears match state before rejecting worker waiters
      throw new DOMException('Match stopped','AbortError');
    };
    ${helperSource}
    ${between('  async function sendInitialState()', "  // The host's own starting state failed")}
    globalThis.pending=sendInitialState();
  `,
    context,
  );
  await context.pending;
  return vm.runInContext('({phase:_phase,emitted,retryCalls})', context);
}

test('before: swallowed sidecar abort resurrects the stopped initial state', async () => {
  const oldHelpers = helpers.replaceAll("      if (e?.name === 'AbortError') throw e;\n", '');
  const result = await initialStateStoppedDuringSidecar(oldHelpers);
  assert.equal(result.phase, 2);
  assert.equal(result.emitted, 1);
});

test('fixed: sidecar abort keeps initial state stopped without emitting', async () => {
  const result = await initialStateStoppedDuringSidecar(helpers);
  assert.equal(result.phase, 0);
  assert.equal(result.emitted, 0);
  assert.equal(result.retryCalls, 0);
});

test('decode cancellation propagates but ordinary optional sidecar failure remains recoverable', async () => {
  for (const cancelled of [false, true]) {
    const context = vm.createContext({ DOMException, cancelled });
    vm.runInContext(
      `
      const _syncLog=()=>{};
      const decodeAndDecompress=async()=>{throw cancelled ? new DOMException('Match stopped','AbortError') : new Error('bad gzip')};
      ${helpers}
      globalThis.pending=_decodeSaveRam({saveRam:'bytes'});
    `,
      context,
    );
    if (cancelled) await assert.rejects(context.pending, { name: 'AbortError' });
    else assert.equal(await context.pending, null);
  }
});
