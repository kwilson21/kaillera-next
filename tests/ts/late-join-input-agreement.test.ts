// Around a join every page applies the same input for every slot
// (specs/late_join_input_agreement.qnt; web/src/late-join-input-rule.ts),
// run from web/static/netplay-rollback.js itself: the old Remix bootstrap
// only on the immediate rule, the joiner's own hold, and a guest that hears
// the admitting roster too late taking the host's state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { MASK_LEAD, matchScheduled } from '../../web/src/controller-mask.ts';
import {
  admittedLate,
  bridgeOffered,
  joinerHoldsOwnInput,
  legacyBootstrap,
} from '../../web/src/late-join-input-rule.ts';

const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const part = (a: string, b: string) => {
  const from = src.indexOf(a);
  assert.ok(from >= 0, a);
  const to = src.indexOf(b, from);
  assert.ok(to > from, b);
  return src.slice(from, to);
};
const api = {
  controllerMask: { MASK_LEAD, matchScheduled },
  lateJoinInput: {
    admittedLate,
    bridgeOffered,
    joinerHoldsOwnInput,
    legacyBootstrap,
  },
};
const ZERO = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

type Page = {
  bootstrap: (reason: string, slots: number[]) => void;
  roster: (rosterFrame: number, slots: number[], added: number[], scheduled: boolean) => void;
  loadState: (frame: number) => void;
  // The input this page made for `frame`, as JSON.
  tick: (frame: number, input: { buttons: number; lx: number; ly: number }) => string;
  read: () => string;
};

function page(opts: { slot: number; remix: boolean; scheduled: boolean; frame: number; frontier?: number }): Page {
  const c = vm.createContext({ api, ZERO, opts });
  vm.runInContext(
    `
    const window={KNCore:api};
    const KNShared={ZERO_INPUT:ZERO};
    const logs=[],asks=[],events=[],_pendingCInputs=[];
    const _syncLog=(m)=>logs.push(m),KNEvent=(...a)=>events.push(a);
    const _askHostStateForLateRoster=(tag)=>asks.push(tag);
    const _isSmashRemix=()=>opts.remix,RB_WORKER_COPROC=false,_useCRollback=true;
    let _playerSlot=opts.slot,_frameNum=opts.frame,DELAY_FRAMES=3,_activeRoster=new Set([0,1,2,3]);
    let _maskMatchScheduled=opts.scheduled;
    const _maskSchedule={active:()=>opts.scheduled,frontier:()=>opts.frontier??_frameNum};
    const _peers={a:{slot:1},b:{slot:2},c:{slot:3}},_knownPlayers={},_remoteInputs={};
    const _isPeerPendingLateJoin=()=>false,_maskSlotCapable=()=>true,_resetStrictMenuResends=()=>{};
    const _isValidPlayerSlot=(s)=>Number.isInteger(s)&&s>=0&&s<4;
    const _cloneInput=(i)=>({...i}),LATE_JOIN_INPUT_BOOTSTRAP_FRAMES=24;
    let _lateJoinInputBootstrapUntilFrame=-1,_lateJoinSeededInputFrames={};
    ${part('  let _joinHold = null;', '  // Smash Remix ROM hashes')}
    ${part('  const _seedLateJoinZeroInput =', '  const _isPeerPendingLateJoin =')}
    ${part('  // Host: the slots its next roster lists', '  const _broadcastRoster =')}
    ${part('  const _noteJoinRoster =', '  // The inputs \`slot\` ran with')}
    const _localInputs={};
    globalThis.bootstrap=(reason,slots)=>_startLateJoinInputBootstrap(reason,slots);
    globalThis.roster=(f,slots,added,scheduled)=>_noteJoinRoster(f,slots,added,scheduled);
    globalThis.loadState=(frame)=>{
      _joinHold = _joinRuleScheduled() ? { stateFrame: frame, rosterFrame: -1 } : null;
    };
    globalThis.tick=(frame,made)=>{
      _frameNum=frame;
      ${part('    // A joiner on the scheduled rule holds its own input neutral until the', '    const hadLocalInputForFrame')}
      const localInput = joinHoldsOwnInput ? _cloneInput(KNShared.ZERO_INPUT) : made;
      _localInputs[frame]=localInput;
      return JSON.stringify({buttons:0,lx:0,ly:0,cx:0,cy:0,...localInput});
    };
    globalThis.read=()=>JSON.stringify({logs,asks,events:events.length,seeded:Object.keys(_lateJoinSeededInputFrames).length,
      suppressUntil:_lateJoinInputBootstrapUntilFrame,pending:_pendingCInputs.length,hold:_joinHold});
  `,
    c,
  );
  return {
    bootstrap: (reason, slots) => c.bootstrap(reason, slots),
    roster: (rosterFrame, slots, added, scheduled) => c.roster(rosterFrame, slots, added, scheduled),
    loadState: (frame) => c.loadState(frame),
    tick: (frame, input) => String(c.tick(frame, input)),
    read: () => String(c.read()),
  };
}

const read = (p: Page) => JSON.parse(p.read());
const NEUTRAL = JSON.stringify(ZERO);
const lx = (made: string): number => JSON.parse(made).lx;

// pagesHearAtDifferentFramesTest: two pages that hear of the join at
// different frames no longer hold or seed over windows of their own.
test('on the scheduled rule no page runs the Remix bootstrap for a join', () => {
  for (const slot of [0, 1]) {
    const p = page({ slot, remix: true, scheduled: true, frame: 1121 });
    p.bootstrap('roster added slot', [3]);
    const r = read(p);
    assert.equal(r.seeded, 0);
    assert.equal(r.pending, 0);
    assert.equal(r.suppressUntil, -1);
  }
});

test('a Remix match on the immediate rule keeps the old bootstrap, and stock SSB64 never ran it', () => {
  const old = page({ slot: 1, remix: true, scheduled: false, frame: 1121 });
  old.bootstrap('roster added slot', [3]);
  const r = read(old);
  assert.ok(r.seeded > 0);
  assert.equal(r.suppressUntil, 1121 + 24 + 1);
  const stock = page({ slot: 1, remix: false, scheduled: false, frame: 1121 });
  stock.bootstrap('roster added slot', [3]);
  assert.equal(read(stock).seeded, 0);
});

// rosterAfterTheStateTest, joinerNeutralBelowAdmission.
test('the joiner holds its own input until it hears the roster, then below its frame + MASK_LEAD', () => {
  const j = page({ slot: 3, remix: true, scheduled: true, frame: 1118 });
  j.loadState(1118);
  const move = { buttons: 0, lx: -70, ly: 0 };
  for (let f = 1118; f < 1125; f++) assert.equal(j.tick(f, move), NEUTRAL);
  // A roster from before the state does not admit it.
  j.roster(1079, [0, 1, 2], [], true);
  assert.equal(j.tick(1125, move), NEUTRAL);
  j.roster(1120, [0, 1, 2, 3], [], true);
  for (let f = 1126; f < 1120 + MASK_LEAD; f++) assert.equal(j.tick(f, move), NEUTRAL);
  assert.equal(lx(j.tick(1120 + MASK_LEAD, move)), -70);
  assert.equal(read(j).hold, null);
  // On the immediate rule the joiner does not hold.
  const old = page({ slot: 3, remix: false, scheduled: false, frame: 1118 });
  old.loadState(1118);
  assert.equal(lx(old.tick(1118, move)), -70);
});

// aPageThatHearsLateTakesTheHostsStateTest.
test('a guest that ran a joiner tag past the hold as absent takes the host state', () => {
  const onTime = page({
    slot: 1,
    remix: true,
    scheduled: true,
    frame: 1150,
    frontier: 1150,
  });
  onTime.roster(1118, [0, 1, 2, 3], [3], true);
  assert.deepEqual(read(onTime).asks, []);
  // Highest tag run: frontier - 1 - delay = 1178 = 1118 + MASK_LEAD.
  const late = page({
    slot: 1,
    remix: false,
    scheduled: true,
    frame: 1182,
    frontier: 1182,
  });
  late.roster(1118, [0, 1, 2, 3], [3], true);
  assert.deepEqual(read(late).asks, ['ROSTER-ADMIT-LATE']);
  // The host is never late; on the immediate rule nothing changes.
  const host = page({
    slot: 0,
    remix: false,
    scheduled: true,
    frame: 1300,
    frontier: 1300,
  });
  host.roster(1118, [0, 1, 2, 3], [3], true);
  assert.deepEqual(read(host).asks, []);
  const immediate = page({
    slot: 1,
    remix: false,
    scheduled: false,
    frame: 1300,
    frontier: 1300,
  });
  immediate.roster(1118, [0, 1, 2, 3], [3], false);
  assert.deepEqual(read(immediate).asks, []);
});
