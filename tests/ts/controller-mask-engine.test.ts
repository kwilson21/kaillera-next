// The engine's controller-mask wiring, run from web/static/netplay-rollback.js
// itself: the schedule decides the mask of every frame stepped, whenever the
// roster reached the page (specs/controller_mask.qnt: arrivalOrderTest,
// rollbackAcrossTheChangeTest, lateArrivalTest).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { KNCore } from '../../web/src/index.ts';

const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const part = (a: string, b: string) => {
  const from = src.indexOf(a);
  assert.ok(from >= 0, `missing ${a}`);
  const to = src.indexOf(b, from);
  assert.ok(to > from, `missing ${b} after ${a}`);
  return src.slice(from, to);
};
const runStep = (() => {
  const from = src.indexOf('  const _runStepOneFrame = (branch) => {');
  return src.slice(from, src.indexOf('\n  };\n', from) + 5);
})();

interface Page {
  /** Step frame `frame` (C has picked it); returns the mask the core had while it ran. */
  step: (frame: number) => number;
  /** The host broadcast (or this page heard) the roster of `rosterFrame`. */
  roster: (rosterFrame: number, slots: number[]) => void;
  start: (frame: number) => void;
  resyncAsks: () => number;
}

const page = (slot: number): Page => {
  const c = vm.createContext({ KNCore, slot });
  vm.runInContext(
    `
    const window={KNCore,EJS_emulator:{gameManager:{Module:{
      mask:15, cFrame:0,
      _kn_set_controller_present_mask(m){this.mask=m},
      _kn_get_frame(){return this.cFrame},
    }}}};
    const mod=window.EJS_emulator.gameManager.Module;
    let _frameNum=0,_playerSlot=slot,_demoMode=false,_activeRoster=null,_useCRollback=true;
    let _lastControllerPresentMask=-1,_lastControllerPresentMaskModule=null,_maskFrameMismatchLogged=false;
    const _maskSchedule=KNCore.controllerMask.createMaskSchedule();
    const _knownPlayers={a:{slot:0},b:{slot:1}},_peers={};
    const _isPeerPendingLateJoin=()=>false,_syncLog=()=>{},KNEvent=()=>{};
    let asks=0,_resyncRequestInFlight=false;
    const _clearSyncTarget=()=>{};
    const _sendResyncRequest=()=>{asks++},_beginResyncRequest=()=>{_resyncRequestInFlight=true;return 1};
    function _requestSocketFullResync(){asks++}
    let stepMask=-1,_inDeterministicStep=false;
    const stepOneFrame=()=>{stepMask=mod.mask;return true};
    ${part('  const _controllerPresentMask = () => {', '  // Apply the real player-count mask the *instant*')}
    ${runStep}
    globalThis.step=(f)=>{mod.cFrame=f;_frameNum=f;_runStepOneFrame('test');return stepMask};
    globalThis.roster=(r,slots)=>{_activeRoster=new Set(slots);_fileRosterControllerMask(r,slots,'test')};
    globalThis.start=(f)=>{_frameNum=f;_maskSchedule.start(_controllerPresentMask(),f)};
    globalThis.resyncAsks=()=>asks;
    `,
    c,
  );
  return {
    step: (frame) => c.step(frame),
    roster: (rosterFrame, slots) => c.roster(rosterFrame, slots),
    start: (frame) => c.start(frame),
    resyncAsks: () => c.resyncAsks(),
  };
};

const LEAD = KNCore.controllerMask.MASK_LEAD;

test('two pages hearing a roster at different frames run every frame with the same mask', () => {
  const host = page(0);
  const guest = page(1);
  host.start(0);
  guest.start(0);
  const hostMasks: number[] = [];
  const guestMasks: number[] = [];
  // The host broadcasts at 100 (a third player in slot 2); the guest hears
  // it at 104, its frames already 4 ahead of the host's at the broadcast.
  for (let f = 0; f < 100; f++) hostMasks.push(host.step(f));
  host.roster(100, [0, 1, 2]);
  for (let f = 100; f < 300; f++) hostMasks.push(host.step(f));
  for (let f = 0; f < 104; f++) guestMasks.push(guest.step(f));
  guest.roster(100, [0, 1, 2]);
  for (let f = 104; f < 300; f++) guestMasks.push(guest.step(f));
  assert.deepEqual(guestMasks, hostMasks);
  assert.equal(hostMasks[100 + LEAD - 1], 0b0011);
  assert.equal(hostMasks[100 + LEAD], 0b0111);
});

test('a replay across the change runs each frame with the mask it first ran with', () => {
  const guest = page(1);
  guest.start(0);
  const first: number[] = [];
  for (let f = 0; f < 200; f++) first.push(guest.step(f));
  guest.roster(150, [0, 1, 2]);
  // A rollback of 7 frames, twice: across the roster's arrival, and later
  // across the frame it takes effect at.
  for (let f = 193; f < 200; f++) assert.equal(guest.step(f), first[f]);
  for (let f = 200; f < 260; f++) first.push(guest.step(f));
  for (let f = 150 + LEAD - 3; f < 260; f++) assert.equal(guest.step(f), first[f], `frame ${f}`);
  assert.equal(first[150 + LEAD - 1], 0b0011);
  assert.equal(first[150 + LEAD], 0b0111);
  assert.equal(guest.resyncAsks(), 0);
});

test('a guest that ran past the change before hearing it asks the host for its state', () => {
  const guest = page(1);
  guest.start(0);
  for (let f = 0; f < 200; f++) guest.step(f);
  guest.roster(100, [0, 1, 2]);
  assert.equal(guest.resyncAsks(), 1);
  // The same roster again (the host's resend on a channel open): no second ask.
  guest.roster(100, [0, 1, 2]);
  assert.equal(guest.resyncAsks(), 1);
  // The frames the host's state brings it back over run with the agreed mask.
  assert.equal(guest.step(100 + LEAD), 0b0111);
  assert.equal(guest.step(100 + LEAD - 1), 0b0011);
});
