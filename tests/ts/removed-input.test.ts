// The cut of a removed player's input (web/src/removed-input.ts,
// removed-input-wire.ts; specs/removed_input.qnt), and the engine's use of it,
// run from web/static/netplay-rollback.js itself on a stand-in C ring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { KNCore } from '../../web/src/index.ts';
import {
  NO_INPUT_TAKEN,
  admissionFloor,
  cutTag,
  firstDiffering,
  rerunStep,
  wordSpan,
} from '../../web/src/removed-input.ts';
import {
  ROSTER_CUT_MAX_INPUTS,
  cutInputAt,
  encodeRosterCut,
  packInput,
  parseRosterCut,
} from '../../web/src/removed-input-wire.ts';
import { checkPeerText } from '../../web/src/peer-protocol.ts';

const peerTextOk = (channel: 'lockstep', text: string) => checkPeerText(channel, text).issue === null;

const input = (buttons: number, lx = 0, ly = 0) => ({ buttons, lx, ly, cx: 0, cy: 0 });

test('the cut is at the tag the host roster frame applies', () => {
  assert.equal(cutTag(836, 12), 824);
  assert.equal(cutTag(5, 2), 3);
  assert.equal(wordSpan(22, 12, 20), 54);
});

test('a slot the cut governs takes no input until it is admitted again', () => {
  assert.equal(admissionFloor(-1, -1), 0);
  assert.equal(admissionFloor(-1, 824), NO_INPUT_TAKEN);
  assert.equal(admissionFloor(844, 824), 844);
  assert.equal(admissionFloor(844, -1), 844);
});

test('the first place two runs of inputs differ', () => {
  assert.equal(firstDiffering([], []), -1);
  assert.equal(firstDiffering([1, 2, 3], [1, 2, 3]), -1);
  assert.equal(firstDiffering([1, 2, 3], [1, 0, 3]), 1);
  assert.equal(firstDiffering([1, 2, 3], [0, 0, 0]), 0);
});

test('a page runs again from its ring when it holds the frame, else from the host state', () => {
  assert.equal(rerunStep(-1, 100, 22, true), 'nothing');
  assert.equal(rerunStep(90, 100, 22, true), 'local');
  assert.equal(rerunStep(78, 100, 22, true), 'local');
  assert.equal(rerunStep(77, 100, 22, true), 'host');
  assert.equal(rerunStep(90, 100, 22, false), 'host');
  assert.equal(rerunStep(100, 100, 22, true), 'host');
});

test('roster-cut round-trips, and anything off its form is dropped', () => {
  const cut = { rosterFrame: 836, slot: 3, cut: 824, from: 821, inputs: [input(0), input(1, -50), input(0, 0, -70)] };
  const msg = encodeRosterCut(cut);
  assert.equal(msg, 'roster-cut:836:3:824:821:0,0,0,0,0;1,-50,0,0,0;0,0,-70,0,0');
  assert.deepEqual(parseRosterCut(msg), cut);
  assert.ok(peerTextOk('lockstep', msg), 'the peer grammar takes it');
  assert.ok(peerTextOk('lockstep', 'roster-cut:10:1:8:8:'), 'a cut with no inputs below it');
  assert.deepEqual(parseRosterCut('roster-cut:10:1:8:8:'), { rosterFrame: 10, slot: 1, cut: 8, from: 8, inputs: [] });
  for (const bad of [
    'roster-cut:836:3:824:822:0,0,0,0,0', // two tags, one input
    'roster-cut:836:4:824:824:', // no such slot
    'roster-cut:836:3:824:825:', // first tag past the cut
    'roster-cut:836:3:824:823:0,0,0,0', // four numbers
    'roster-cut:836:3:824:823:0,200,0,0,0', // stick out of range
    'roster-cut:836:3:824:823:x,0,0,0,0',
    'roster-cut:836:3:824',
  ]) {
    assert.equal(parseRosterCut(bad), null, bad);
  }
  const tooMany = {
    rosterFrame: 900,
    slot: 1,
    cut: 900,
    from: 900 - ROSTER_CUT_MAX_INPUTS - 1,
    inputs: Array.from({ length: ROSTER_CUT_MAX_INPUTS + 1 }, () => input(0)),
  };
  assert.equal(parseRosterCut(encodeRosterCut(tooMany)), null);
});

test('the cut gives the host inputs below it and neutral from it', () => {
  const cut = { rosterFrame: 14, slot: 2, cut: 12, from: 10, inputs: [input(1), input(2)] };
  assert.equal(cutInputAt(cut, 9), null);
  assert.deepEqual(cutInputAt(cut, 10), input(1));
  assert.deepEqual(cutInputAt(cut, 11), input(2));
  assert.deepEqual(cutInputAt(cut, 12), input(0));
  assert.deepEqual(cutInputAt(cut, 500), input(0));
  assert.notEqual(packInput(input(1)), packInput(input(0, 1)));
  assert.equal(packInput(input(0, -70)), packInput({ buttons: 0, lx: -70, ly: 0, cx: 0, cy: 0 }));
});

// ── The engine, from netplay-rollback.js, on a stand-in C ring ─────────────

const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const part = (a: string, b: string) => {
  const from = src.indexOf(a);
  assert.ok(from >= 0, `missing ${a}`);
  const to = src.indexOf(b, from);
  assert.ok(to > from, `missing ${b} after ${a}`);
  return src.slice(from, to);
};

interface Page {
  /** Feed the removed player's input of `tag` as C would hold it (real). */
  hold: (tag: number, i: ReturnType<typeof input>) => void;
  /** C has run every frame below `frame`. */
  at: (frame: number) => void;
  /** The host cuts `slot` at its roster frame `rosterFrame`; returns the message and the late frame. */
  hostCut: (rosterFrame: number) => { msg: string; late: number };
  /** A guest writes the host's cut; returns the first frame it ran otherwise, or -1. */
  guestCut: (msg: string) => number;
  /** What the ring holds for the slot at `tag`. */
  ring: (tag: number) => ReturnType<typeof input> | null;
  floor: () => number;
  rerunFrom: () => number;
}

const DELAY = 2;
const SLOT = 3;

const page = (): Page => {
  const c = vm.createContext({ KNCore, DELAY, SLOT, performance });
  vm.runInContext(
    `
    const window={KNCore,KNDesync:{forgetFrom(){}}};
    const ring=new Map();
    const mod={cFrame:0,
      _kn_get_frame(){return this.cFrame},
      _kn_feed_input(s,t,b,lx,ly,cx,cy){if(s===SLOT)ring.set(t,{buttons:b,lx,ly,cx,cy})},
      _kn_rollback_slot_reset(s){if(s===SLOT)ring.clear()},
    };
    const ZERO={buttons:0,lx:0,ly:0,cx:0,cy:0};
    const _rbGetInput=(m,s,t)=>ring.get(t)??ZERO;
    let DELAY_FRAMES=DELAY,_rbRollbackMax=4,_frameNum=0,_cutRerun=null,_rbCheckBook=null;
    const _lateJoinInputWindows=new Map([[SLOT,{absentSince:0,first:null,connected:false,primed:false,cut:-1}]]);
    const _syncLog=()=>{};
    const _feedWatchedFrame=(m,s,t,feed)=>feed();
    ${part('  // While a cut governs the slot no input of it is taken in;', '  const _observeLateJoinDcOpen')}
    ${part('  const _hostRosterCut = (mod, slot, rosterFrame) => {', '  // A page that ran frames with other inputs than a cut gives runs them')}
    globalThis.hold=(t,i)=>ring.set(t,i);
    globalThis.at=(f)=>{mod.cFrame=f;_frameNum=f};
    globalThis.hostCut=(r)=>{const cut=_hostRosterCut(mod,SLOT,r);const late=_cutRemovedInput(mod,SLOT,cut,'test');return {msg:KNCore.removedInput.encodeRosterCut(cut),late}};
    globalThis.guestCut=(msg)=>_cutRemovedInput(mod,SLOT,KNCore.removedInput.parseRosterCut(msg),'test');
    globalThis.ring=(t)=>ring.get(t)??null;
    globalThis.floor=()=>_admissionInputFloor(SLOT);
    globalThis.rerunFrom=()=>_cutRerun?_cutRerun.from:-1;
    `,
    c,
  );
  // runInContext returns the context's object untyped: these are the hooks it defined above.
  const g: Page = vm.runInContext('globalThis', c);
  // Values made in the context are plain objects of another realm: copied here.
  const plain = <T>(v: T): T => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
  return {
    hold: (tag, i) => g.hold(tag, i),
    at: (frame) => g.at(frame),
    hostCut: (rosterFrame) => plain(g.hostCut(rosterFrame)),
    guestCut: (msg) => g.guestCut(msg),
    ring: (tag) => plain(g.ring(tag)),
    floor: () => g.floor(),
    rerunFrom: () => g.rerunFrom(),
  };
};

// The removed player moves on every tag it sent.
const moving = (p: Page, upTo: number) => {
  for (let t = 0; t <= upTo; t++) p.hold(t, input(1, -50));
};

test('the host freezes what it applied below its roster frame and is never late (hostRunsItsWord)', () => {
  const host = page();
  moving(host, 20); // it holds the player's inputs past its frame
  host.at(14); // frames 0..13 ran: tags up to 11
  const { msg, late } = host.hostCut(14);
  assert.equal(late, -1);
  const cut = parseRosterCut(msg)!;
  assert.equal(cut.cut, 12);
  assert.equal(cut.inputs.length, 12); // tags 0..11, the span reaching back past 0
  assert.ok(cut.inputs.every((i) => i.buttons === 1 && i.lx === -50));
  assert.deepEqual(host.ring(11), input(1, -50), 'below the cut: what it ran');
  assert.deepEqual(host.ring(12), input(0), 'from the cut: neutral');
  assert.deepEqual(host.ring(13), input(0));
  assert.equal(host.ring(14), null, 'later tags are predicted from the neutral ones');
  assert.equal(host.floor(), NO_INPUT_TAKEN, 'it takes no more input of the player');
});

test('a guest ahead of the host runs again from the cut (guestAheadTest)', () => {
  const host = page();
  moving(host, 13);
  host.at(14);
  const { msg } = host.hostCut(14);
  const guest = page();
  moving(guest, 20);
  guest.at(17); // ran frames 14..16 (tags 12..14) with the real inputs
  assert.equal(guest.guestCut(msg), 14);
  assert.equal(guest.rerunFrom(), 14);
  assert.deepEqual(guest.ring(12), input(0));
  assert.deepEqual(guest.ring(11), input(1, -50));
});

test('a guest behind the cut keeps the real inputs up to it, with nothing to run again (guestBehindTest)', () => {
  const host = page();
  moving(host, 13);
  host.at(14);
  const { msg } = host.hostCut(14);
  const guest = page();
  moving(guest, 6); // it has the player's inputs only up to tag 6
  guest.at(9); // ran frames up to 8 (tags up to 6)
  assert.equal(guest.guestCut(msg), -1);
  assert.equal(guest.rerunFrom(), -1);
  for (let t = 7; t < 12; t++) assert.deepEqual(guest.ring(t), input(1, -50), `tag ${t}: the host's input`);
  assert.deepEqual(guest.ring(12), input(0));
});

test('a guest that held a real input the host only predicted takes the host one (hostPredictedTest)', () => {
  const host = page();
  moving(host, 9);
  host.hold(10, input(1, -50)); // the host's prediction of tag 10, held as its ring holds it
  host.at(14);
  const { msg } = host.hostCut(14);
  const guest = page();
  moving(guest, 9);
  guest.hold(10, input(0)); // the real one, which the host never got
  guest.at(14);
  assert.equal(guest.guestCut(msg), 12, 'tag 10 ran on frame 12');
  assert.deepEqual(guest.ring(10), input(1, -50));
});
