// What a peer's reset does to the C engine's slot (web/src/peer-reset.ts,
// _resetCoreSlot in web/static/netplay-rollback.js; specs/reconnect_inputs.qnt,
// reconnect_history). Old against new: the engine's C side of resetPeerState
// as it was before the rule (copied below) and as it is now (read from the
// engine), run on the same stand-in C slot. They differ exactly where the
// spec's fix says they should (predictionPutBackAsRealTest): a reconnect of
// the same player in a slot the roster lists keeps the slot's predictions,
// so a real input that differs from one is checked, unless this page held
// the peer as a phantom (its frames past the window, recovered by the
// resync). Everywhere else they
// leave the slot the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { reconnectProofSource } from './fixtures/reconnect-proof-source.ts';

import { KNCore } from '../../web/src/index.ts';
import { keepsCoreSlot } from '../../web/src/peer-reset.ts';

const KEPT = ['reconnect', 'mesh-heal', 'hard-disconnect-non-host'];
// Every other reason resetPeerState is called with in the engine.
const EMPTIED = [
  'hard-disconnect',
  'host roster removed',
  'late-join-reconnect-replace',
  'zombie-eviction',
  'replaced-by-new-page',
];

test('the same player in a listed slot, not held as a phantom, keeps the C slot; nothing else does', () => {
  for (const reason of KEPT) {
    assert.equal(keepsCoreSlot(reason, true, false), true, reason);
    assert.equal(keepsCoreSlot(reason, false, false), false, `${reason}, slot not listed`);
    assert.equal(keepsCoreSlot(reason, true, true), false, `${reason}, held as a phantom`);
  }
  for (const reason of EMPTIED) {
    for (const listed of [true, false]) {
      for (const phantom of [true, false]) assert.equal(keepsCoreSlot(reason, listed, phantom), false, reason);
    }
  }
  assert.equal(KNCore.peerReset.keepsCoreSlot, keepsCoreSlot);
});

const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const part = (a: string, b: string) => {
  const from = src.indexOf(a);
  assert.ok(from >= 0, `missing ${a}`);
  const to = src.indexOf(b, from);
  assert.ok(to > from, `missing ${b} after ${a}`);
  return src.slice(from, to);
};

// Every reason resetPeerState is called with is one of the two lists.
test('every reset reason in the engine is judged here', () => {
  const reasons = new Set<string>();
  for (const m of src.matchAll(/resetPeerState\([^,]+, '([^']+)'/g)) reasons.add(m[1] ?? '');
  for (const m of src.matchAll(/_evictPeer\([^,]+, '([^']+)'\)/g)) reasons.add(m[1] ?? '');
  assert.ok(reasons.size > 0);
  for (const reason of reasons) assert.ok(KEPT.includes(reason) || EMPTIED.includes(reason), reason);
});

// The C side of resetPeerState before peer-reset.ts, verbatim but for the
// function around it (it read `opts.keepCoreSlot`).
const OLD = `
  const oldResetCoreSlot = (slot, reason, keepCoreSlot) => {
    const opts = { keepCoreSlot };
    if (_useCRollback && !opts.keepCoreSlot && !_cutGoverns(slot)) {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (mod?._kn_rollback_slot_reset) {
        const ran = _maskMatchScheduled && _maskSchedule.active() ? _ringInputsRan(mod, slot) : [];
        mod._kn_rollback_slot_reset(slot);
        for (const { tag, i } of ran) {
          _feedWatchedFrame(mod, slot, tag, () => mod._kn_feed_input(slot, tag, i.buttons, i.lx, i.ly, i.cx, i.cy));
        }
        if (ran.length) _syncLog(\`PEER-RESET-KEEPS slot=\${slot} inputs \${ran[0].tag}..\${ran.at(-1).tag}\`);
      }
    }
  };
`;

const SLOT = 1;
const DELAY = 2;

interface Entry {
  buttons: number;
  pred: boolean;
}
interface Slot {
  /** C: the slot's ring by tag (value and whether it is a recorded prediction). */
  ring: Record<string, Entry>;
  active: boolean;
  /** Feed a real input; true when it corrected a recorded prediction that differed. */
  feed: (tag: number, buttons: number) => boolean;
  reset: (reason: string) => void;
}

const slotWith = (which: 'old' | 'new', scheduled: boolean, listed: boolean, phantom = false): Slot => {
  const c = vm.createContext({ KNCore, SLOT, DELAY, scheduled, listed, phantom });
  vm.runInContext(
    `
    const ZERO={buttons:0,lx:0,ly:0,cx:0,cy:0};
    const KNShared={ZERO_INPUT:ZERO};
    const ring={};
    const slot={active:false,last:0};
    const mod={
      _kn_get_frame(){return 10},
      _kn_get_input(){},
      _kn_feed_input(s,t,b){
        if(s!==SLOT)return 0;
        const e=ring[t];
        const mis=!!(e&&e.pred&&e.buttons!==b);
        ring[t]={buttons:b,pred:false};
        if(!slot.active||t>=slot.lastTag){slot.lastTag=t;slot.last=b}
        slot.active=true;
        return mis?1:0;
      },
      _kn_rollback_slot_reset(s){if(s!==SLOT)return;for(const k in ring)delete ring[k];slot.active=false;slot.last=0},
    };
    const window={KNCore,EJS_emulator:{gameManager:{Module:mod}}};
    const _rbGetInput=(m,s,t)=>ring[t]?{...ZERO,buttons:ring[t].buttons}:ZERO;
    let DELAY_FRAMES=DELAY,_rbRollbackMax=6,_frameNum=10,_rbInputPtr=1;
    const _useCRollback=true,_maskMatchScheduled=scheduled;
    const _maskSchedule={active:()=>scheduled};
    const _activeRoster=new Set(listed?[0,SLOT]:[0]);
    const _corePhantomHistory=new Set();
    const _cutGoverns=()=>false;
    const _syncLog=()=>{};
    const _feedWatchedFrame=(m,s,t,feed)=>feed();
    ${part('  const _ringInputsRan = (mod, slot) => {', '  // The cut of a removed player')}
    ${part('  const _resetCoreSlot = (slot, reason, keepCoreSlot, unsafeHistory) => {', '  /**')}
    ${OLD}
    globalThis.ring=ring;
    globalThis.slot=slot;
    globalThis.feed=(t,b)=>mod._kn_feed_input(SLOT,t,b,0,0,0,0)===1;
    // C runs a frame on a missing input: a recorded prediction, repeat-last.
    globalThis.predict=(t)=>{if(slot.active&&!(ring[t]&&!ring[t].pred))ring[t]={buttons:slot.last,pred:true}};
    globalThis.reset=(reason)=>${which === 'old' ? 'oldResetCoreSlot' : '_resetCoreSlot'}(SLOT,reason,false,phantom);
    `,
    c,
  );
  // runInContext returns the context's object untyped: these are the hooks it defined above.
  const g: {
    ring: Record<string, Entry>;
    slot: { active: boolean };
    feed: (t: number, b: number) => boolean;
    predict: (t: number) => void;
    reset: (reason: string) => void;
  } = vm.runInContext('globalThis', c);
  // The peer held A (1) on tags 0..4; frames ran tags 5..7 on predictions of it.
  for (let t = 0; t < 5; t++) g.feed(t, 1);
  for (let t = 5; t < 8; t++) g.predict(t);
  return {
    // Values made in the context are plain objects of another realm: copied here.
    get ring() {
      const copy: Record<string, Entry> = JSON.parse(JSON.stringify(g.ring));
      return copy;
    },
    get active() {
      return g.slot.active;
    },
    feed: (tag, buttons) => g.feed(tag, buttons),
    reset: (reason) => g.reset(reason),
  };
};

test('a reconnect keeps the predictions, so the real input that differs is checked (reconnect_history)', () => {
  for (const scheduled of [true, false]) {
    for (const reason of KEPT) {
      const before = slotWith('old', scheduled, true);
      const now = slotWith('new', scheduled, true);
      assert.equal(now.ring['6']?.pred, true);
      before.reset(reason);
      now.reset(reason);
      // The peer released A on tag 6, which this page ran on a prediction of A.
      assert.equal(now.feed(6, 0), true, `${reason}: checked, a rollback (scheduled=${scheduled})`);
      assert.equal(before.feed(6, 0), false, `${reason}: stored unchecked before (scheduled=${scheduled})`);
      assert.equal(now.active, true);
    }
  }
});

test('the old reset lost the prediction both ways: emptied, or put back as a real input', () => {
  const emptied = slotWith('old', false, true);
  emptied.reset('reconnect');
  assert.deepEqual(emptied.ring, {});
  assert.equal(emptied.active, false);
  const asReal = slotWith('old', true, true);
  asReal.reset('reconnect');
  assert.deepEqual(asReal.ring['6'], { buttons: 1, pred: false });
});

test('every other reset, a reconnect into a slot the roster no longer lists, and one of a phantom empty the slot as before', () => {
  for (const scheduled of [true, false]) {
    for (const [reason, listed, phantom] of [
      ...EMPTIED.map((r) => [r, true, false] as const),
      ...EMPTIED.map((r) => [r, true, true] as const),
      ...KEPT.map((r) => [r, false, false] as const),
      ...KEPT.map((r) => [r, true, true] as const),
    ]) {
      const before = slotWith('old', scheduled, listed, phantom);
      const now = slotWith('new', scheduled, listed, phantom);
      before.reset(reason);
      now.reset(reason);
      assert.deepEqual(now.ring, before.ring, `${reason} listed=${listed} phantom=${phantom} scheduled=${scheduled}`);
      assert.equal(now.active, before.active);
      assert.equal(now.feed(6, 0), before.feed(6, 0));
      assert.deepEqual(now.ring, before.ring);
    }
  }
});

const keptRuntime = () => {
  const context = vm.createContext({ KNCore, SLOT });
  vm.runInContext(
    `
    let now=100;
    const performance={now:()=>now};
    const _peerDriver=()=>null, _startSteps=new Map(), _endKeptOpen=()=>{};
    const _lateJoinInputWindows=new Map(), _lateJoinReadyHandled=new Set(), _lateJoinStateSent=new Map();
    const _pendingLateJoinReadySids=new Set(), _lateJoinOfferedDelay=new Map(), _lateJoinServing=new Map();
    const _clearPendingLateJoinPeer=()=>{},_rbCheckBook=null,_rbLegacyCheckSlots=new Set(),_pendingCInputs=[];
    const _peerLastAdvanceTime={},_peerPhantom={},_inputLateLogTime={},_auditLastRemote={};
    const _followUpWatches=new Map(),_directAnswerNewest=new Map(),_queuedSyncPushes=new Map();
    const _syncQueueGen={},_syncSendChains={},_syncChainMovedAt={};let _scheduledSyncRequests=[];
    const _remoteInputs={},_awaitFirstInputAfterReset={},_keptSlotFirstInputAt=new Map(),_corePhantomHistory=new Set();
    const _clearSlotInputState=(s)=>{delete _remoteInputs[s];delete _awaitFirstInputAfterReset[s];_keptSlotFirstInputAt.delete(s)};
    const _useCRollback=true,_cutGoverns=()=>false;
    let _activeRoster=new Set([0,SLOT]);
    const _knownPlayers={},_playerSlot=0,PHASE_RUNNING=5,_phase=PHASE_RUNNING,_hasKnSync=true;
    const RB_WORKER_COPROC=false,_syncQueueEpoch=1;
    ${reconnectProofSource(src)}
    const _maskMatchScheduled=false,_inputSettledBefore={},_admissionInputFloor=()=>0,_inputFloor=()=>30;
    let resets=0,sent=0,present=true;
    const mod={_kn_rollback_slot_reset(){resets++},_kn_feed_input(){sent++}};
    const window={KNCore,EJS_emulator:{gameManager:{Module:mod}},dispatchEvent(){}};
    const CustomEvent=class {};
    const _syncLog=()=>{},_testRunPastEdgeFrame=()=>-1,_pushTickProfile=()=>{},_markTickReturn=()=>{};
    let _rbInputStallKey='',_rbInputStallStartTime=0,_rbStallLogged=0,_predictedKnownCount=0;
    const clearPeerStallTimers=()=>{_rbInputStallKey='';_rbInputStallStartTime=0};
    const _lastRemoteFramePerSlot={},_inputDroppedAheadUpTo={},_rbInputStallThreshold=()=>8;
    const _frameNum=52,DELAY_FRAMES=2,KN_MAX_VISIBLE_ROLLBACK_DEPTH=7,RB_TRUE_ROLLBACK=true;
    const MAX_STALL_MS=3000,RESEND_TIMEOUT_MS=2000,_askForMissingInputs=()=>{};
    const getInputPeers=()=>present?[{slot:SLOT}]:[];
    const _pendingCInputsSortFn=(a,b)=>a.frame-b.frame;
    const _primeLateJoinInactiveInput=()=>{};
    const _feedWatched=(m,s,t,feed)=>feed();
    ${part('  const _awaitingFirstInput =', '  const _settleInputsBefore =')}
    ${part('  const _drainPendingCInputs =', '  const _formatInputBrief =')}
    ${part('  const _resetCoreSlot =', '  /**')}
    ${part('  const resetPeerState =', '  // -- Peer disconnect')}
    ${part('  const _keptSlotStallPeers =', '  // Every AudioContext')}
    globalThis.tick=()=>{
      const rbApplyFrame=50,ownerGate='open';
      ${part("        if (rbApplyFrame >= 0 && ownerGate !== 'replay') {", "        if (ownerGate !== 'replay' && _delayRetunePending")}
      _drainPendingCInputs(mod);
      return true;
    };
    globalThis.setNow=(ms)=>{now=ms};
    globalThis.setPresent=(v)=>{present=v};
    globalThis.legacy=()=>{_activeRoster=null};
    globalThis.reset=(r)=>resetPeerState(SLOT,r);
    globalThis.phantom=(v)=>{if(v)_setPacingPhantom(SLOT);else _peerPhantom[SLOT]=false};
    globalThis.queue=(frame,seeded)=>_pendingCInputs.push({slot:SLOT,frame,seeded,buttons:0,lx:0,ly:0,cx:0,cy:0});
    globalThis.isPhantom=()=>!!_peerPhantom[SLOT];
    globalThis.unsafe=()=>_corePhantomHistory.has(SLOT);
    globalThis.nativeResets=()=>resets;
    globalThis.nativeFeeds=()=>sent;
    globalThis.waitStart=()=>_keptSlotFirstInputAt.get(SLOT);
    `,
    context,
  );
  const runtime: {
    tick: () => true | undefined;
    setNow: (ms: number) => void;
    setPresent: (present: boolean) => void;
    legacy: () => void;
    reset: (reason: string) => void;
    phantom: (active: boolean) => void;
    queue: (frame: number, seeded: boolean) => void;
    isPhantom: () => boolean;
    unsafe: () => boolean;
    nativeResets: () => number;
    nativeFeeds: () => number;
    waitStart: () => number | null | undefined;
  } = vm.runInContext('globalThis', context);
  return runtime;
};

test('all kept-slot reset reasons wait for an at-floor live input, not a seeded or stale entry', () => {
  for (const reason of KEPT) {
    const r = keptRuntime();
    r.reset(reason);
    assert.equal(r.waitStart(), null, reason);
    assert.equal(r.tick(), undefined, reason);
    assert.equal(r.waitStart(), 100, reason);
    r.queue(40, true);
    r.queue(29, false);
    assert.equal(r.tick(), undefined, reason);
    r.queue(45, false); // a real neutral sample from this peer
    assert.equal(r.tick(), true, reason);
    assert.equal(r.waitStart(), undefined, reason);
    assert.ok(r.nativeFeeds() > 0, reason);
    assert.equal(r.nativeResets(), 0, reason);
  }
});

test('a listed but transport-less slot stalls and repeated mesh heal cannot extend its deadline', () => {
  const r = keptRuntime();
  r.reset('hard-disconnect-non-host');
  r.setPresent(false);
  assert.equal(r.tick(), undefined);
  r.setNow(4900);
  assert.equal(r.tick(), undefined);
  r.reset('mesh-heal');
  assert.equal(r.waitStart(), 100);
  r.setNow(5099);
  assert.equal(r.tick(), undefined);
  r.setNow(5100);
  assert.equal(r.tick(), true);
  assert.equal(r.isPhantom(), true);
  assert.equal(r.unsafe(), true);
});

test('time spent paused before the first active stall does not consume the wait', () => {
  const r = keptRuntime();
  r.reset('mesh-heal');
  r.setNow(30000);
  assert.equal(r.tick(), undefined);
  assert.equal(r.waitStart(), 30000);
  assert.equal(r.isPhantom(), false);
});

test('a rosterless legacy mesh-heal still gates an excluded peer', () => {
  const r = keptRuntime();
  r.legacy();
  r.setPresent(false);
  r.reset('mesh-heal');
  assert.equal(r.tick(), undefined);
});

test('a pacing recovery does not clear native phantom history on the second outage', () => {
  const r = keptRuntime();
  r.phantom(true);
  r.phantom(false); // the packet receiver restores pacing, not native history
  assert.equal(r.unsafe(), true);
  r.reset('reconnect');
  assert.equal(r.nativeResets(), 1);
  assert.equal(r.unsafe(), false);
  assert.equal(r.waitStart(), undefined); // reset (not kept) follows existing reconnect wait
  r.reset('mesh-heal');
  assert.equal(r.nativeResets(), 1);
  assert.equal(r.waitStart(), null);
});
