import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

// No ROM, no retro_run, no browser, no server. Separate real native memories;
// the app's asynchronous transport/readiness plumbing is in-process.
const repo = process.cwd();
const core = join(repo, 'web/static/ejs/cores/mupen64plus_next_libretro');
const source = readFileSync(join(repo, 'web/static/netplay-rollback.js'), 'utf8');
const bytes = readFileSync(`${core}.wasm`);
const glue = readFileSync(`${core}.js`, 'utf8');
const wasm = new WebAssembly.Module(bytes);
const imports = {};
for (const { module, name, kind } of WebAssembly.Module.imports(wasm)) {
  assert.equal(kind, 'function');
  if (!imports[module]) imports[module] = {};
  imports[module][name] = () => {
    throw Error(`unexpected cold-core runtime import ${module}.${name}`);
  };
}

function coreModule() {
  const { exports } = new WebAssembly.Instance(wasm, imports);
  const memory = Object.values(exports).find((x) => x instanceof WebAssembly.Memory);
  assert.ok(memory, 'core memory');
  const mod = { HEAPU8: new Uint8Array(memory.buffer), HEAPU32: new Uint32Array(memory.buffer) };
  for (const name of [
    '_malloc',
    '_free',
    '_kn_sync_read',
    '_kn_sync_write',
    '_kn_hle_save_to',
    '_kn_hle_restore_from',
    '_kn_hle_state_size',
    '_kn_pack_hidden_state_impl',
    '_kn_restore_hidden_state_impl',
    '_kn_get_audio_fifo_state',
    '_kn_set_audio_fifo_state',
    '_kn_post_state_load_cleanup',
  ]) {
    const match = glue.match(new RegExp(`Module\\["${name}"\\]=wasmExports\\["([^"]+)"\\]`));
    assert.ok(match, name);
    assert.equal(typeof exports[match[1]], 'function', name);
    mod[name] = exports[match[1]];
  }
  return mod;
}
function slice(from, to) {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, from);
  return source.slice(a, b);
}
function page(slot) {
  const mod = coreModule();
  const capture = slice('  const _captureInitialStateBytes =', '  let _awaitingResyncAt =');
  const send = slice('  async function sendInitialState()', "  // The host's own starting state failed");
  const receive = slice('  const handleSaveStateMsg =', '  // -- Late join ');
  const launch = slice('    const readyMod = gm.Module;', '    // After the state load so nothing');
  const c = vm.createContext({ mod, slot, Uint8Array, Uint32Array, Buffer, console });
  vm.runInContext(
    `
    const gm={Module:mod};
    const window={EJS_emulator:{gameManager:gm}}, REMIX_INITIAL_SYNC_USE_KN_SYNC=true;
    const _isSmashRemix=()=>true,_isSpectator=false, _playerSlot=slot, _config={romHash:null};
    const PHASE_SYNCING=1, PHASE_LOCKSTEP_READY=2, _rttComplete=false;
    let _phase=PHASE_SYNCING, _syncBufPtr=0, _syncBufSize=0;
    let _guestStateBytes=null, _guestStateKind=null, _guestStateCapturedLocally=false;
    let _guestStateHiddenWords=null,_guestStateAudioFifo=null,_guestStateSaveRam=null,_guestStateHle=null;
    let _lockstepStartStateKind=null, message=null;
    const logs=[], errors=[];
    const _syncLog=s=>logs.push(s),setStatus=s=>{if(s.startsWith('Sync failed'))errors.push(s)};
    const _logAudioDump=()=>{},_checkAiInvariant=()=>{},_clearPendingCInputs=()=>{},recaptureManualRunner=()=>{};
    const waitForSmashTitleState=async()=>{},_recordStartCohortIfMissing=()=>{},_clearInputsForNewMatch=()=>{};
    const checkAllLockstepReady=()=>{},_markInitialStateReady=()=>{_phase=PHASE_LOCKSTEP_READY};
    const _retryHostState=()=>{errors.push('unexpected host startup retry')},performance={now:()=>0};
    const _getRuntimeFamily=()=>'diagnostic';
    const _encodeSaveRam=async()=>null,_decodeSaveRam=async()=>null;
    const uint8ToBase64=v=>Buffer.from(v).toString('base64');
    const base64ToUint8=v=>new Uint8Array(Buffer.from(v,'base64'));
    const compressAndEncode=async v=>({rawSize:v.length,compressedSize:v.length,data:uint8ToBase64(v)});
    const decodeAndDecompress=async v=>base64ToUint8(v);
    const _emitSaveStateToPlayers=m=>{message=JSON.parse(JSON.stringify(m))};
    const ensureSyncBuffer=()=>{_syncBufSize=9*1024*1024; _syncBufPtr=mod._malloc(_syncBufSize);};
    ${slice('  const _captureHiddenStateWords =', '  // Cartridge save memory')}
    ${slice('  const _postStateLoadCleanup =', '  const _captureInitialStateBytes =')}
    ${slice('  const loadKnSyncStateAtStartBoundary =', '  let _hasForkedCore =')}
    ${capture}
    ${send}
    ${receive}

    globalThis.capture=async()=>{await sendInitialState();return {message, errors}};
    globalThis.receive=handleSaveStateMsg;
    globalThis.start=()=>{ ${launch} };
    globalThis.hle=()=>_captureHleState(mod);
    globalThis.seed=marker=>{const old=_captureHleState(mod);old[5]=marker;
      if(!_restoreHleState(mod,old,'fixture seed'))throw Error('native seed failed'); };
    globalThis.result=()=>({logs,errors,kind:_lockstepStartStateKind});
  `,
    c,
  );
  return c;
}
const digest = (v) => createHash('sha256').update(v).digest('hex');
async function startWith(message, slot, marker) {
  const guest = page(slot);
  guest.seed(marker);
  await guest.receive(message);
  guest.start();
  assert.deepEqual([...guest.result().errors], []);
  assert.equal(guest.result().kind, 'kn-sync');
  return guest;
}

test('the initial native KNS4 wire state restores HLE before hidden words and FIFO', async () => {
  const host = page(0);
  host.seed(19);
  const { message, errors } = await host.capture();
  assert.deepEqual([...errors], [], JSON.stringify(host.result()));
  assert.equal(message.stateFormat, 'kn-sync');
  const snapshot = Buffer.from(message.data, 'base64');
  assert.equal(snapshot.readUInt32LE(0), 0x4b4e5334);
  assert.equal(snapshot.readUInt32LE(4), 4);
  host.start();
  assert.deepEqual([...host.result().errors], []);
  const guest = await startWith(message, 3, 201);
  assert.equal(digest(guest.hle()), digest(host.hle()), 'full native plugin bytes are the same');
  const hleSize = host.hle().length;
  assert.equal(Buffer.from(message.hle, 'base64').length, hleSize);
  for (const peer of [host, guest]) {
    const { logs } = peer.result();
    const boundaries = [
      'initial-sync-load: kn_sync_write result=0',
      'initial-sync-load: restored HLE',
      'initial-sync-load: restored hidden state',
      'initial-sync-load: restored audio FIFO',
      'initial-sync-load: post-state cleanup applied',
    ].map((prefix) => logs.findIndex((x) => x.startsWith(prefix)));
    assert.ok(boundaries.every((i, k) => i >= 0 && (k === 0 || i > boundaries[k - 1])));
  }

  // A rolling deployment has valid KNS4 without the optional field. A
  // differently sized sidecar must never overwrite this core's plugin.
  const old = { ...message };
  delete old.hle;
  assert.equal((await startWith(old, 1, 97)).hle()[5], 97);
  const wrongSize = { ...message, hle: Buffer.from([99]).toString('base64') };
  assert.equal((await startWith(wrongSize, 2, 147)).hle()[5], 147);
});
