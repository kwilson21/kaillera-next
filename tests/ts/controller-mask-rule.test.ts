// One controller-mask rule per match, the host's, run from
// web/static/netplay-rollback.js itself: the host's roster broadcast and the
// guest's `roster-mask:` / `roster:` handlers (specs/controller_mask.qnt,
// VERSIONED: oldGuestTest, oldHostTest, oldJoinerTest).
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
const guestHandler = part(
  '        // The host schedules the controller mask of the roster that follows.',
  '          const previousRoster',
);

interface Page {
  /** Step frame `frame`; returns the mask the core had while it ran. */
  step: (frame: number) => number;
  /** Host: broadcast a roster at `frame`; returns the strings sent to the guest. */
  broadcast: (frame: number, slots: number[]) => string[];
  /** Guest: hear a string from the host on its channel. */
  hear: (text: string) => void;
  /** Host: the player in `slot` said it can schedule (or not). */
  capable: (slot: number, can: boolean) => void;
  start: (frame: number) => void;
  scheduled: () => boolean;
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
    let _frameNum=0,_playerSlot=slot,_demoMode=false,_activeRoster=null,_useCRollback=true,rb_numPlayers=4;
    let _lastControllerPresentMask=-1,_lastControllerPresentMaskModule=null,_maskFrameMismatchLogged=false;
    let _maskMatchScheduled=true,_maskAnnouncedFrame=-1,_lastBroadcastRosterFrame=-1;
    const _maskCapablePeers=new Map(),RB_WORKER_COPROC=false;
    const _maskSchedule=KNCore.controllerMask.createMaskSchedule();
    const sent=[];
    const hostDc={readyState:'open',send(m){sent.push(m)}};
    const _peers=slot===0
      ? {g1:{slot:1,dc:hostDc},g2:{slot:2,dc:{readyState:'open',send(){}}}}
      : {h:{slot:0,dc:hostDc}};
    const _knownPlayers={};
    const _isPeerPendingLateJoin=(sid)=>slot===0&&sid==='g2'&&!globalThis.withJoiner;
    const _syncLog=()=>{},KNEvent=()=>{};
    let _resyncRequestInFlight=false,_syncTargetFrame=-1,_syncTargetDeadlineAt=0;
    const _sendResyncRequest=()=>{},_beginResyncRequest=()=>1;
    function _requestSocketFullResync(){}
    function _peerEntryForSlot(s){for(const e of Object.entries(_peers)) if(e[1]?.slot===s) return e; return null}
    const _recordHostInputRoster=()=>true,_admissionInputFloor=()=>0,_awaitFirstInputAfterReset={};
    // The removed player's cut (tests/ts/removed-input.test.ts): this core
    // has no input ring, so no roster here cuts one.
    const _heardRosterCuts=new Map(),_coreSlotsKeptForCut=new Set(),_cutGoverns=()=>false;
    const _isValidPlayerSlot=(s)=>Number.isInteger(s)&&s>=0&&s<4;
    let _lastRosterCuts=[];
    let stepMask=-1,_inDeterministicStep=false;
    const stepOneFrame=()=>{stepMask=mod.mask;return true};
    ${part('  const _controllerPresentMask = () => {', '  // Apply the real player-count mask the *instant*')}
    ${runStep}
    ${part('  const _broadcastRoster = () => {', '  const _snapshotLateJoinBridgeSources')}
    const onText=(e,peer,ch)=>{
      ${guestHandler}
          _activeRoster=new Set(slots);
          _fileRosterControllerMask(rosterFrame,slots,'roster');
        }
    };
    globalThis.step=(f)=>{mod.cFrame=f;_frameNum=f;_runStepOneFrame('test');return stepMask};
    globalThis.broadcast=(f,slots)=>{_frameNum=f;globalThis.withJoiner=slots.includes(2);sent.length=0;_broadcastRoster();return [...sent]};
    globalThis.hear=(text)=>onText({data:text},_peers.h,hostDc);
    globalThis.capable=(s,can)=>_maskCapablePeers.set(_peerEntryForSlot(s)[0],can);
    globalThis.start=(f)=>{_frameNum=f;_maskSchedule.start(_controllerPresentMask(),f)};
    globalThis.scheduled=()=>_maskMatchScheduled&&_maskSchedule.active();
    `,
    c,
  );
  return {
    step: (frame) => c.step(frame),
    broadcast: (frame, slots) => [...c.broadcast(frame, slots)],
    hear: (text) => c.hear(text),
    capable: (s, can) => c.capable(s, can),
    start: (frame) => c.start(frame),
    scheduled: () => c.scheduled(),
  };
};

const LEAD = KNCore.controllerMask.MASK_LEAD;

// Run both pages to frame `to`, the guest hearing what the host sent at
// `heardAt`; returns each page's mask per frame.
const run = (host: Page, guest: Page, sent: string[], broadcastAt: number, heardAt: number, to: number) => {
  const hostMasks: number[] = [];
  const guestMasks: number[] = [];
  for (let f = broadcastAt; f < to; f++) hostMasks.push(host.step(f));
  for (let f = broadcastAt; f < heardAt; f++) guestMasks.push(guest.step(f));
  for (const text of sent) guest.hear(text);
  for (let f = heardAt; f < to; f++) guestMasks.push(guest.step(f));
  return { hostMasks, guestMasks };
};

test('an all-new match is scheduled: the roster is announced and both pages change at the same frame', () => {
  const host = page(0);
  const guest = page(1);
  host.start(0);
  guest.start(0);
  host.capable(1, true);
  for (let f = 0; f < 100; f++) {
    host.step(f);
    guest.step(f);
  }
  host.capable(2, true);
  const sent = host.broadcast(100, [0, 1, 2]);
  assert.deepEqual(sent, ['roster-mask:100', 'roster:100:0,1,2']);
  const { hostMasks, guestMasks } = run(host, guest, sent, 100, 104, 200);
  assert.deepEqual(guestMasks, hostMasks);
  assert.equal(hostMasks[LEAD - 1], 0b0011);
  assert.equal(hostMasks[LEAD], 0b0111);
  assert.equal(host.scheduled(), true);
  assert.equal(guest.scheduled(), true);
});

test('a guest from before the deploy: the host runs the match immediate and announces nothing', () => {
  const host = page(0);
  host.start(0);
  host.capable(1, false); // lockstep-ready without the capability
  for (let f = 0; f < 10; f++) host.step(f);
  const sent = host.broadcast(10, [0, 1]);
  assert.deepEqual(sent, ['roster:10:0,1']);
  assert.equal(host.scheduled(), false);
  // Applied at once, as an old guest does when it hears it.
  assert.equal(host.step(10), 0b0011);
});

test('a host from before the deploy: the guest applies each unannounced roster at once', () => {
  const guest = page(1);
  guest.start(0);
  for (let f = 0; f < 10; f++) guest.step(f);
  guest.hear('roster:5:0,1,2');
  assert.equal(guest.scheduled(), false);
  assert.equal(guest.step(10), 0b0111);
  // Even an announcement afterwards does not put it back on the schedule.
  guest.hear('roster-mask:20');
  guest.hear('roster:20:0,1');
  assert.equal(guest.scheduled(), false);
  assert.equal(guest.step(11), 0b0011);
});

test('an old late joiner: the host falls back for the rest of the match, and the guest with it', () => {
  const host = page(0);
  const guest = page(1);
  host.start(0);
  guest.start(0);
  host.capable(1, true);
  const first = host.broadcast(0, [0, 1]);
  assert.deepEqual(first, ['roster-mask:0', 'roster:0:0,1']);
  for (const text of first) guest.hear(text);
  for (let f = 0; f < 100; f++) {
    host.step(f);
    guest.step(f);
  }
  host.capable(2, false); // request-late-join without the capability
  const sent = host.broadcast(100, [0, 1, 2]);
  assert.deepEqual(sent, ['roster:100:0,1,2']);
  assert.equal(host.scheduled(), false);
  assert.equal(host.step(100), 0b0111);
  for (const text of sent) guest.hear(text);
  assert.equal(guest.scheduled(), false);
  assert.equal(guest.step(100), 0b0111);
  // The joiner is new after all on the next roster: the match stays immediate.
  host.capable(2, true);
  assert.deepEqual(host.broadcast(150, [0, 1, 2]), ['roster:150:0,1,2']);
});

test('an announcement for another roster frame does not schedule a roster', () => {
  const guest = page(1);
  guest.start(0);
  guest.hear('roster-mask:7');
  guest.hear('roster:8:0,1');
  assert.equal(guest.scheduled(), false);
});
