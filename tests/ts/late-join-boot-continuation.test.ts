import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeLateJoinInputBridge, lateJoinBootProgress } from '../../web/src/late-join-input-bridge.ts';

const source =
  process.env.BOOT_CONTINUATION_TEST_BEFORE === '1'
    ? execFileSync('git', ['show', '340e54e:web/static/netplay-rollback.js'], { encoding: 'utf8' })
    : readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');

const part = (from: string, to: string) => {
  const a = source.indexOf(from);
  assert.ok(a >= 0, from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b > a, to);
  return source.slice(a, b);
};

const H = 1042;
const D = 3;
const first = H - D;
const last = H + D + 7;
const bootAt = H + 121;
type Mode = 'normal' | '2p' | 'worker' | 'remix' | 'legacy' | 'malformed' | 'fresh' | 'kn-sync';

function setup(mode: Mode = 'normal') {
  const c = vm.createContext({ H, D, first, last, bootAt, mode, decodeLateJoinInputBridge, lateJoinBootProgress });
  vm.runInContext(
    `
      const logs=[], sends=[];
      const KNShared={ZERO_INPUT:{buttons:0,lx:0,ly:0,cx:0,cy:0}};
      const _syncLog=(log)=>logs.push(log);
      const host={slot:0,dc:{readyState:'open',send:(msg)=>sends.push(msg)}};
      const other={slot:1};
      const second=mode!=='2p';
      const _playerSlot=second?2:1, DELAY_FRAMES=D, KN_MAX_VISIBLE_ROLLBACK_DEPTH=7;
      const _peers=second?{host,other}:{host}, _syncQueueGen={host:0,other:0};
      let _syncQueueEpoch=1, _frameNum=H, now=1;
      let _activeRoster=new Set(second?[0,1,2]:[0,1]);
      const RB_WORKER_COPROC=mode==='worker', _isSmashRemix=()=>mode==='remix';
      const _isValidPlayerSlot=(n)=>Number.isInteger(n)&&n>=0&&n<4;
      const _useCRollback=true, _isPeerPendingLateJoin=()=>false;
      const _lateJoinInputWindows=new Map(), _lateJoinLostHost=false;
      const _remoteInputs={0:{},1:{}}, LATE_JOIN_TIMEOUT_MS=15000;
      const socket={id:'joiner'};
      const mod={_kn_pre_tick:()=>{},_kn_get_frame:()=>_frameNum};
      const tickMod=mod;
      const window={KNCore:{decodeLateJoinInputBridge,lateJoinBootProgress},EJS_emulator:{gameManager:{Module:mod}}};
      const performance={now:()=>now};
      const _askForMissingInputs=()=>{},setStatus=()=>{},_config={},queueMicrotask=()=>{},stop=()=>{};
      const _syncEnabled=true,_lockstepStartStateKind=mode==='kn-sync'?'kn-sync':'savestate';
      let _resyncRequestInFlight=false,_resyncRequestId=0;
      const _reconnectAnswerDebt=null;
      const _beginResyncRequest=()=>{_resyncRequestInFlight=true;return ++_resyncRequestId};
      ${part('  const _sendResyncRequest =', '  // The resync request rules')}
      ${part('  let _lateJoinOriginalWait = null;', '  async function sendLateJoinState')}

      if(mode!=='fresh'&&mode!=='kn-sync') {
        const manifest=[{slot:0,sid:'host',frames:[]}];
        if(second) manifest.push({slot:1,sid:'other',frames:[]});
        const message={frame:H};
        if(mode!=='legacy') message.inputBridge=mode==='malformed'?[]:manifest;
        _beginLateJoinOriginalWait(message,mod,new Map(Object.entries(_peers).map(([sid,peer])=>[sid,{peer,gen:_syncQueueGen[sid]}])));
      }
      globalThis.fill=(f,placeholder)=> {
        for(const input of Object.values(_remoteInputs)) input[f]=placeholder?KNShared.ZERO_INPUT:{...KNShared.ZERO_INPUT};
      };
      globalThis.at=(f,instant=1)=> {
        _frameNum=f+D;
        now=instant;
        return _waitForLateJoinOriginalInput();
      };
      globalThis.boot=()=> {
        _frameNum=bootAt;
        const _bootDoneForSync=true;
        ${part('        if (_bootDoneForSync && !window._knBootSyncDone) {', '        const rbApplyFrame = _frameNum - DELAY_FRAMES;')}
      };
      globalThis.explicit=()=>_sendResyncRequest(host.dc,_beginResyncRequest(),'sync-request-full');
      globalThis.snapshot=()=>JSON.stringify({logs,sends,_lockstepStartStateKind});
      globalThis.bounce=()=>_syncQueueGen.other++;
      globalThis.newMatch=()=>_syncQueueEpoch++;
      globalThis.catchup=()=>_finishLateJoinOriginalWaitAtSync(H);
      globalThis.dropOriginal=()=>{
        _activeRoster.delete(1);
        _lateJoinInputWindows.set(1,{absentSince:first,first:null});
      };
    `,
    c,
  );
  return {
    fill: (f: number, placeholder = false) => c.fill(f, placeholder),
    at: (f: number, t?: number): boolean => c.at(f, t),
    boot: () => c.boot(),
    explicit: () => c.explicit(),
    bounce: () => c.bounce(),
    newMatch: () => c.newMatch(),
    catchup: () => c.catchup(),
    dropOriginal: () => c.dropOriginal(),
    snapshot: (): { logs: string[]; sends: string[]; _lockstepStartStateKind: string } => JSON.parse(c.snapshot()),
  };
}

function complete(r: ReturnType<typeof setup>) {
  for (let f = first; f <= last; f++) {
    r.fill(f);
    assert.equal(r.at(f), false);
  }
  assert.equal(r.at(last + 1), false);
}

test('a validated live late join does not send the generic boot request which rewinds healthy play', () => {
  const r = setup();
  complete(r);
  r.boot();
  assert.deepEqual(r.snapshot().sends, []);
  assert.match(r.snapshot().logs.at(-1) ?? '', /verified live late-join handoff/);
  assert.equal(r.snapshot()._lockstepStartStateKind, 'savestate');
  r.explicit();
  assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full']);
});

test('first host-input hole remains a hold; a real neutral, not a placeholder, can later validate', () => {
  const r = setup();
  r.fill(first, true);
  assert.equal(r.at(first), true);
  complete(r);
  r.boot();
  assert.deepEqual(r.snapshot().sends, []);
});

test('unverified, unsupported, and independent legacy boot still use existing safety behavior', () => {
  for (const mode of ['worker', 'remix', 'legacy', 'malformed', 'fresh', '2p'] as const) {
    const r = setup(mode);
    if (mode === '2p') complete(r);
    r.boot();
    assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full'], mode);
  }
  const kn = setup('kn-sync');
  kn.boot();
  assert.deepEqual(kn.snapshot().sends, []);
});

test('the one-shot automatic gate cannot use incomplete or later evidence', () => {
  const r = setup();
  r.boot();
  complete(r);
  r.boot();
  assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full']);
});

test('source replacement before or after completion, match reset, resync, and roster break invalidate provenance', () => {
  for (const invalidate of ['bounce', 'newMatch', 'catchup', 'dropOriginal'] as const) {
    for (const after of [false, true]) {
      const r = setup();
      if (!after) r[invalidate]();
      complete(r);
      if (after) r[invalidate]();
      r.boot();
      assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full'], `${invalidate}: after=${after}`);
    }
  }
});

test('skipped input IDs and native cursor jumps cannot validate', () => {
  const r = setup();
  for (let f = first + 1; f <= last; f++) {
    r.fill(f);
    assert.equal(r.at(f), false);
  }
  r.at(last + 1);
  r.boot();
  assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full']);
});

test('expiry cannot turn an abandoned bootstrap into successful evidence', () => {
  const r = setup();
  assert.equal(r.at(first, 15002), true);
  r.at(last + 1);
  r.boot();
  assert.deepEqual(r.snapshot().sends, ['sync-request-id:1', 'sync-request-full']);
});
