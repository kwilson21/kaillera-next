import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { framesToAskFor } from '../../web/src/input-ask.ts';
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
const api = { collectLateJoinInputBridge, decodeLateJoinInputBridge, framesToAskFor };

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
    const _maskSchedule={active:()=>false};
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

function setupJoin(msg: LateJoinStateFixture, replaceSource = false, direct = false, ownSlot = 2, delay = 3) {
  const c = vm.createContext({ msg, zero, real, H, api, replaceSource, direct, ownSlot, delay });
  vm.runInContext(
    `
    const KNShared={ZERO_INPUT:zero},window={KNCore:api};
    const resends=[], statuses=[], queued=[], ticks=[];
    const host={slot:0,dc:{readyState:'open',send(){}}};
    const original={slot:1,dc:{readyState:'open',send(msg){resends.push(msg)}}};
    const _peers={host,guest:original,extra:{slot:2}},_syncQueueGen={guest:0};
    const bridgePeers=new Map([['host',{peer:host,gen:0}],['guest',{peer:original,gen:0}]]);
    const _syncQueueEpoch=0,bridgeEpoch=0,DELAY_FRAMES=delay,_playerSlot=ownSlot,_rbRollbackMax=22;
    const _remoteInputs={0:{[H]:{...zero}},1:direct?{[H]:{...real,ly:-70}}:{}},_localInputs={};
    const RB_WORKER_COPROC=false,_isSmashRemix=()=>false,LATE_JOIN_TIMEOUT_MS=15000,KN_MAX_VISIBLE_ROLLBACK_DEPTH=7;
    const _lateJoinInputWindows=new Map();
    const _lastRemoteFramePerSlot={1:H+1},_inputDroppedAheadUpTo={},_inputAskedAt={};
    let now=1; const socket={id:'joiner'};
    const performance={now:()=>now},_inputFloor=()=>0,_countOverdueAsk=()=>{};
    const setStatus=(status)=>statuses.push(status),_config={};
    const queueMicrotask=(fn)=>queued.push(fn),stop=()=>{};
    const _markTickReturn=(reason)=>ticks.push(reason);
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
    ${part('  const RB_INPUT_ASK_EVERY_MS =', '  // One more ask for the oldest frame')}
    const _ownerRepair=null;
    const runOne = () => {
      ticks.push('local send');
      ${src.includes('    if (_waitForLateJoinOriginalInput())') ? part('    if (_waitForLateJoinOriginalInput())', '    // ── Pacing gate') : ''}
      ticks.push('native step');
    };
    globalThis.read=()=>JSON.stringify({fed, resends, ticks, statuses, stopCount:queued.length, waiting:!!_lateJoinOriginalWait});
    globalThis.sync=(frame)=>_finishLateJoinOriginalWaitAtSync(frame);
    globalThis.at=(actualNow, apply, realNeutral)=> {
      _frameNum=apply+DELAY_FRAMES;
      now=actualNow;
      if(realNeutral) _remoteInputs[1][apply]={...zero};
      runOne();
    };
  `,
    c,
  );
  return {
    read: () => JSON.parse(c.read()),
    sync: (frame: number) => c.sync(frame),
    tick: (now: number, apply: number, realNeutral = false) => c.at(now, apply, realNeutral),
  };
}

function install(msg: LateJoinStateFixture, replaceSource = false, direct = false) {
  return setupJoin(msg, replaceSource, direct).read().fed;
}

test('an existing player’s absent input H is not backfilled as confirmed neutral', async () => {
  const msg = await send(false);
  const withHole = {
    ...msg,
    inputBridge: msg.inputBridge.map((source: { slot: number; frames: [number][] }) =>
      source.slot === 1 ? { ...source, frames: source.frames.filter(([frame]) => frame !== H) } : source,
    ),
  };
  const join = setupJoin(withHole, false, false, 3);
  assert.deepEqual(
    join.read().fed.filter(([f]: [number]) => f === H),
    [],
  );
  join.tick(50, H);
  assert.deepEqual(join.read().resends, [`resend:${H}`]);
  assert.deepEqual(join.read().ticks, ['local send', 'skip:late-join-original-input']);
  join.tick(80, H);
  assert.deepEqual(join.read().resends, [`resend:${H}`]);
  join.tick(100, H, true);
  assert.deepEqual(join.read().ticks.slice(-2), ['local send', 'native step']);
});

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

test('a host Socket.IO id change during capture keeps ownership but omits that source’s samples', async () => {
  const msg = await send(false, 'normal', true);
  assert.deepEqual(
    Array.from(msg.inputBridge, ({ sid, frames }: { sid: string; frames: unknown[] }) => [sid, frames.length]),
    [
      ['host', 0],
      ['guest', 7],
    ],
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

test('missing legacy bridge keeps old behavior; malformed new bridge blocks and ends only once', async () => {
  const legacy = setupJoin({ frame: H });
  legacy.tick(1, H);
  assert.deepEqual(legacy.read().ticks, ['local send', 'native step']);
  const malformed = setupJoin({ frame: H, inputBridge: [] });
  malformed.tick(1, H);
  malformed.tick(1000, H);
  assert.equal(malformed.read().ticks.includes('native step'), false);
  assert.equal(malformed.read().stopCount, 1);
  assert.equal(malformed.read().statuses.length, 1);
});

// specs/engine_start.qnt, lateJoinIntoSoloTest (engine_start_no_zero_bridge
// against engine_start_current): alone in a room the match runs on the C
// engine at a delay of 0, and a friend who joins it joins at 0. The window was
// defined only for a delay of 1 or more, so a solo host sent no source and
// the joiner, with none to wait for, failed its input wait as it arrived.
test('a delay of 0 has a bridge window: a friend joining a solo match waits for the host', () => {
  const host = { slot: 0, sid: 'host', confirmed: (f: number) => (f === H + 2 ? real : undefined) };
  const bridge = collectLateJoinInputBridge(H, 0, [host]);
  assert.deepEqual(bridge, [{ slot: 0, sid: 'host', frames: [[H + 2, 0, 0, 70, 0, 0]] }]);
  // The window at 0 is H..H+7: nothing before the state's frame.
  const every = collectLateJoinInputBridge(H, 0, [{ slot: 0, sid: 'host', confirmed: () => real }]);
  assert.deepEqual(
    every.flatMap(({ frames }) => frames.map(([f]) => f)),
    [0, 1, 2, 3, 4, 5, 6, 7].map((d) => H + d),
  );
  assert.deepEqual(decodeLateJoinInputBridge(bridge, H, 0, 2), bridge);
  assert.deepEqual(
    decodeLateJoinInputBridge([{ slot: 0, sid: 'host', frames: [[H - 1, 0, 0, 0, 0, 0]] }], H, 0, 2),
    [],
  );
  // Still no window below 0.
  assert.deepEqual(collectLateJoinInputBridge(H, -1, [host]), []);
  // The joiner waits for the host's live inputs from H on and steps once it has them.
  const join = setupJoin({ frame: H, inputBridge: [{ slot: 0, sid: 'host', frames: [] }] }, false, false, 2, 0);
  join.tick(1, H);
  assert.deepEqual(join.read().ticks, ['local send', 'native step']);
  assert.equal(join.read().stopCount, 0);
  // What the solo host sent before (no source) still blocks and ends once.
  const before = setupJoin({ frame: H, inputBridge: [] }, false, false, 2, 0);
  before.tick(1, H);
  assert.equal(before.read().ticks.includes('native step'), false);
  assert.equal(before.read().stopCount, 1);
});

test('an unanswered original-input resend ends the local hold without stepping', () => {
  const join = setupJoin({
    frame: H,
    inputBridge: [
      { slot: 0, sid: 'host', frames: [] },
      { slot: 1, sid: 'guest', frames: [] },
    ],
  });
  join.tick(100, H);
  join.tick(15002, H);
  join.tick(15003, H);
  assert.equal(join.read().ticks.includes('native step'), false);
  assert.equal(join.read().stopCount, 1);
});

test('authoritative state clears the bootstrap only once it contains the final guarded input', () => {
  const sidecar = [{ slot: 0, sid: 'host', frames: [] }];
  const join = setupJoin({ frame: H, inputBridge: sidecar });
  join.sync(H + 13);
  assert.equal(join.read().waiting, true);
  join.sync(H + 14);
  assert.equal(join.read().waiting, false);
});

type LeaveRoomPayload = Record<string, never>;

test('a bootstrap failure leaves only this player’s signaling slot, without reconnecting', () => {
  const play = readFileSync(new URL('../../web/static/play.js', import.meta.url), 'utf8');
  const from = play.indexOf('      onLateJoinInputFailed:');
  const to = play.indexOf('      onSyncStatus:', from);
  assert.ok(from >= 0 && to > from);
  const events: string[] = [];
  let ack: (() => void) | undefined;
  const c = vm.createContext({
    events,
    _sessionStopLateJoinPoll: () => events.push('stop poll'),
    showError: (msg: string) => events.push(msg),
    socket: {
      connected: true,
      io: { reconnection: (enabled: boolean) => events.push(`reconnect:${enabled}`) },
      timeout: (ms: number) => ({
        emit: (event: 'leave-room', data: LeaveRoomPayload, cb: () => void) => {
          assert.equal(Object.keys(data).length, 0);
          events.push(`${event}:${ms}`);
          ack = cb;
        },
      }),
      disconnect: () => events.push('disconnect'),
    },
  });
  vm.runInContext(
    `
    let coreFatal=false,engine={stop(){events.push('stop local engine')}};
    ({${play.slice(from, to)}}).onLateJoinInputFailed('reload to rejoin');
    if (!coreFatal || engine !== null) throw Error('local failure did not stop the engine');
  `,
    c,
  );
  assert.deepEqual(events, [
    'stop poll',
    'reconnect:false',
    'leave-room:2000',
    'stop local engine',
    'reload to rejoin',
  ]);
  assert.ok(ack);
  ack();
  assert.equal(events.at(-1), 'disconnect');
});

test('worker and Remix late-joins send the same savestate shape as before', async () => {
  const worker = await send(false, 'worker');
  const remix = await send(false, 'remix');
  assert.equal(worker.inputBridge, undefined);
  assert.equal(remix.inputBridge, undefined);
});
