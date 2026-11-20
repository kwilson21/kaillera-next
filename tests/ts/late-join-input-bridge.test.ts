import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { collectLateJoinInputBridge, decodeLateJoinInputBridge } from '../../web/src/late-join-input-bridge.ts';

const file = new URL('../../web/static/netplay-rollback.js', import.meta.url);
const src =
  process.env.BRIDGE_TEST_BEFORE === '1'
    ? execFileSync('git', ['show', '20142567dbfdf1ea6625422e24a66e3dde798e5b:web/static/netplay-rollback.js'], {
        encoding: 'utf8',
      })
    : readFileSync(file, 'utf8');
const part = (a: string, b: string) => {
  const from = src.indexOf(a);
  assert.ok(from >= 0, a);
  const to = src.indexOf(b, from);
  assert.ok(to > from, b);
  return src.slice(from, to);
};
const funcs = src.includes('  const _snapshotLateJoinBridgeSources =')
  ? part('  const _snapshotLateJoinBridgeSources =', '  async function sendLateJoinState')
  : '';
const real = Object.freeze({ buttons: 0, lx: 0, ly: 70, cx: 0, cy: 0 });
const zero = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });
const H = 1046;
const api = { collectLateJoinInputBridge, decodeLateJoinInputBridge };

async function send(replaceSource: boolean, mode: 'normal' | 'worker' | 'remix' = 'normal', reconnectHost = false) {
  const c = vm.createContext({ H, zero, real, api, mode });
  vm.runInContext(
    `
    const KNShared={ZERO_INPUT:zero};
    const peer={slot:1}, joining={slot:2};
    const _peers={guest:peer,join:joining},_knownPlayers={join:{socketId:'join-current'}},_activeRoster=new Set([0,1,2]);
    const _lateJoinServing=new Map(),_lateJoinStateSent=new Map(),_pendingLateJoinReadySids=new Set();
    let _lateJoinServeSeq=0,_lateJoinPausedAt=0,_runSubstate=0,_syncQueueEpoch=1;
    const _syncQueueGen={},RUN_LATE_JOIN_PAUSE=1,LATE_JOIN_TIMEOUT_MS=15000,_frameNum=H,_playerSlot=0,DELAY_FRAMES=3,_rbTransport='reliable';
    const _useCRollback=true,RB_WORKER_COPROC=mode==='worker',_isSmashRemix=()=>mode==='remix';
    const _localInputs={[H-1]:real},_remoteInputs={1:{[H-1]:real,[H-2]:zero},2:{[H]:real}};
    const _isValidPlayerSlot=(n)=>Number.isInteger(n)&&n>=0&&n<4,_isPeerPendingLateJoin=()=>false;
    const _syncLog=()=>{},_markPendingLateJoinPeer=()=>{},_clearPendingLateJoinPeer=()=>{},_endLateJoinPauseIfNoneServed=()=>{};
    const _captureHiddenStateWords=()=>null,_captureAudioFifoState=()=>null,_captureSaveRam=()=>null;
    const socket={id:'host',emit(_kind,data){globalThis.emitted=data}};
    ${part('  const _currentSid =', '  const _evictPeer =')}
    const performance={now:()=>1},setTimeout=()=>{};
    const window={KNCore:api,EJS_emulator:{gameManager:{getState:()=>new Uint8Array([1]),Module:{}}}};
    let compression; const compressAndEncode=()=>new Promise(resolve=>compression=resolve);
    ${funcs}
    ${part('  async function sendLateJoinState(remoteSid)', '  // Joiner: a full resync')}
    globalThis.send=()=>sendLateJoinState('join');
    globalThis.finish=(replace,reconnect)=>{
      for(let f=H;f<=H+5;f++) _remoteInputs[1][f]=real;
      if(replace) _syncQueueGen.guest=1;
      if(reconnect) socket.id='host-reconnected';
      compression({data:'state',rawSize:1,compressedSize:1});
    };
  `,
    c,
  );
  const pending = c.send();
  c.finish(replaceSource, reconnectHost);
  await pending;
  return c.emitted;
}

type LateJoinStateFixture = { frame: number; inputBridge?: import('../../web/src/wire.ts').WirePayload };

function install(msg: LateJoinStateFixture, replaceSource = false, direct = false) {
  const c = vm.createContext({ msg, zero, real, H, api, replaceSource, direct });
  vm.runInContext(
    `
    const KNShared={ZERO_INPUT:zero},window={KNCore:api};
    const original={slot:1}, _peers={guest:original},_syncQueueGen={guest:0};
    const bridgePeers=new Map([['guest',{peer:original,gen:0}]]);
    const _syncQueueEpoch=0,bridgeEpoch=0,DELAY_FRAMES=3,_playerSlot=2, _rbRollbackMax=22;
    const _remoteInputs={1:direct?{[H]:{...real,ly:-70}}:{}},_localInputs={};
    let _frameNum=-1;
    if(replaceSource) _syncQueueGen.guest++;
    const fed=[],_syncLog=()=>{},_consumeLateJoinSeededInput=()=>false;
    const _admissionInputFloor=()=>0,_primeLateJoinInactiveInput=()=>{};
    const INPUT_PAST_WINDOW_FRAMES=240,INPUT_FUTURE_MARGIN_FRAMES=16;
    const mod={_kn_feed_input(){},_kn_pre_tick(){}};
    const _feedCInput=(module,slot,f,input)=>{
      if(!input) return false;
      if(slot===1&&f>=H&&f<=H+5) fed.push([f,input.ly]);
      return true;
    };
    ${funcs}
    ${part("      // Start at host's current frame", '      _syncLog(`late-join loaded at frame')}
    ${part('  const _backfillCInputsFromJs =', '  // Guest: a resync has')}
    _backfillCInputsFromJs(mod,'rollback-init');
    globalThis.result=JSON.stringify(fed);
  `,
    c,
  );
  return JSON.parse(c.result);
}

test('late join feeds the original guest’s real H..H+5 after confirmed packets arrive during compression', async () => {
  const msg = await send(false);
  assert.deepEqual(
    install(msg),
    Array.from({ length: 6 }, (_, i) => [H + i, 70]),
  );
  assert.equal(msg.targetSid, 'join-current');
  assert.ok(msg.inputBridge.some(({ slot, sid }: { slot: number; sid: string }) => slot === 0 && sid === 'host'));
  const guest = msg.inputBridge.find(({ slot }: { slot: number }) => slot === 1);
  assert.equal(
    guest.frames.some(([frame]: [number]) => frame === H - 2),
    false,
  );
  assert.equal(
    msg.inputBridge.some(({ slot }: { slot: number }) => slot === 2),
    false,
  );
});

test('do not use replaced source generations or override a direct real input', async () => {
  const valid = await send(false);
  assert.equal(
    install(valid, true).some(([, value]: [number, number]) => value === 70),
    false,
  );
  assert.equal(install(valid, false, true)[0][1], -70);
  const changedWhileCapturing = await send(true);
  assert.equal(
    install(changedWhileCapturing).some(([, value]: [number, number]) => value === 70),
    false,
  );
});

test('a host Socket.IO id change during capture omits only that local source', async () => {
  const msg = await send(false, 'normal', true);
  assert.deepEqual(
    Array.from(msg.inputBridge, ({ sid }: { sid: string }) => sid),
    ['guest'],
  );
});

test('old and malformed bridge fields preserve addressable savestate handling without trusting a bad sample', async () => {
  assert.deepEqual(decodeLateJoinInputBridge(undefined, H, 3, 2), []);
  assert.deepEqual(decodeLateJoinInputBridge([{ slot: 1, sid: 'guest', frames: [[H, 0, 500, 0, 0, 0]] }], H, 3, 2), []);
  assert.deepEqual(decodeLateJoinInputBridge([{ slot: 2, sid: 'join', frames: [[H, 0, 70, 0, 0, 0]] }], H, 3, 2), []);
  const msg = await send(false);
  const malformed = { ...msg, inputBridge: [{ slot: 1, sid: 'guest', frames: [[H, 0, 500, 0, 0, 0]] }] };
  assert.equal(
    install(malformed).some(([, value]: [number, number]) => value === 70),
    false,
  );
});

test('worker and Remix late-joins send the same savestate shape as before', async () => {
  const worker = await send(false, 'worker');
  const remix = await send(false, 'remix');
  assert.equal(worker.inputBridge, undefined);
  assert.equal(remix.inputBridge, undefined);
});
