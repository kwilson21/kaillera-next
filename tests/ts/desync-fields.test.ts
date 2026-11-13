import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  FIELD_COUNT,
  MATCH_PHASE_FIELD,
  SCENE_CSS_VS,
  SCENE_IN_GAME_VS,
  fieldEligibleInPhase,
  fieldName,
  fieldsToFlag,
  slotForField,
} from '../../web/src/desync-fields.ts';
import { lcg } from './load-shared.ts';

const never = (): number[] => Array.from({ length: FIELD_COUNT }, () => -1);
const hashes = (seed: number): number[] => Array.from({ length: FIELD_COUNT }, (_, fid) => seed * 100 + fid);

test('field names and slots follow the registry layout', () => {
  const names = Array.from({ length: FIELD_COUNT }, (_, fid) => fieldName(fid));
  assert.deepEqual(names, [
    ...Array.from({ length: 4 }, () => 'stocks'),
    ...Array.from({ length: 4 }, () => 'character_id'),
    ...Array.from({ length: 4 }, () => 'css_cursor'),
    ...Array.from({ length: 4 }, () => 'css_selected'),
    'rng',
    'match_phase',
    'vs_battle_hdr',
    'physics_motion',
    'ft_buffer',
  ]);
  const slots = Array.from({ length: FIELD_COUNT }, (_, fid) => slotForField(fid));
  assert.deepEqual(slots, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, null, null, null, null, null]);
});

test('a phase mismatch is the only thing flagged for the frame', () => {
  const a = hashes(1);
  const b = hashes(2);
  assert.deepEqual(fieldsToFlag(a, b, SCENE_IN_GAME_VS, 100, never(), 60), [MATCH_PHASE_FIELD]);
});

test('equal digests flag nothing, in any scene', () => {
  for (const phase of [0, SCENE_CSS_VS, SCENE_IN_GAME_VS]) {
    assert.deepEqual(fieldsToFlag(hashes(1), hashes(1), phase, 100, never(), 60), []);
  }
});

test('battle fields are flagged only in a battle, select-screen fields only there', () => {
  const a = hashes(1);
  const b = hashes(2);
  b[MATCH_PHASE_FIELD] = a[MATCH_PHASE_FIELD]!;
  assert.deepEqual(fieldsToFlag(a, b, SCENE_IN_GAME_VS, 100, never(), 60), [0, 1, 2, 3, 4, 5, 6, 7, 16, 18, 19, 20]);
  assert.deepEqual(fieldsToFlag(a, b, SCENE_CSS_VS, 100, never(), 60), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(fieldsToFlag(a, b, 21, 100, never(), 60), [4, 5, 6, 7, 16]);
});

test('a field flagged within the dedup window stays quiet until it has passed', () => {
  const a = hashes(1);
  const b = hashes(1);
  b[16] = 7;
  const last = never();
  last[16] = 100;
  assert.deepEqual(fieldsToFlag(a, b, 0, 159, last, 60), []);
  assert.deepEqual(fieldsToFlag(a, b, 0, 160, last, 60), [16]);
});

test('fieldsToFlag keeps its contract on random digests', () => {
  const next = lcg(21);
  for (let n = 0; n < 20000; n++) {
    const a = Array.from({ length: FIELD_COUNT }, () => next() % 3);
    const b = Array.from({ length: FIELD_COUNT }, () => next() % 3);
    const last = Array.from({ length: FIELD_COUNT }, () => (next() % 200) - 1);
    const phase = [0, SCENE_CSS_VS, SCENE_IN_GAME_VS][next() % 3]!;
    const frame = next() % 260;
    const flagged = fieldsToFlag(a, b, phase, frame, last, 60);
    if (a[MATCH_PHASE_FIELD] !== b[MATCH_PHASE_FIELD]) {
      assert.deepEqual(flagged, [MATCH_PHASE_FIELD]);
      continue;
    }
    // Exactly the fields that differ, mean something here and are not muted.
    const expected: number[] = [];
    for (let fid = 0; fid < FIELD_COUNT; fid++) {
      if (a[fid] !== b[fid] && fieldEligibleInPhase(fid, phase) && frame - last[fid]! >= 60) expected.push(fid);
    }
    assert.deepEqual(flagged, expected);
  }
});

// ── The detector itself ───────────────────────────────────────────────────

interface Suspect {
  frame: number;
  field: string;
  trigger: string;
}
/** The core exports the detector reads; each returns a hash or a counter. */
type CoreExports = Record<string, (a: number, b: number) => number>;
interface DetectorState {
  isLocalHost: boolean;
  matchId: string;
  peers: Record<string, { slot: number }>;
}
interface DetectorWindow {
  KNDesync?: Detector;
  KNCore?: DetectorCore;
  KNState: DetectorState;
  _peers: Record<string, { slot: number; dc: { readyState: string; send: () => void } }>;
}
interface Detector {
  init: (module: CoreExports, mode: string) => void;
  tick: (frame: number) => void;
  onPeerDigest: (peerId: string, payload: { frame: number; hashes: number[] }) => void;
  events: EventTarget;
}
interface DetectorCore {
  desyncFieldsToFlag: typeof fieldsToFlag;
}

/**
 * Run web/static/kn-desync-detector.js through a scripted match against one
 * peer whose digests now and then differ, and return every suspect it emits.
 */
const runDetector = (mode: string, isLocalHost: boolean, core?: DetectorCore): Suspect[] => {
  const source = readFileSync(new URL('../../web/static/kn-desync-detector.js', import.meta.url), 'utf8');
  const slot = isLocalHost ? 1 : 0;
  const state: DetectorState = { isLocalHost, matchId: 'm1', peers: { peerA: { slot } } };
  const window: DetectorWindow = {
    KNState: state,
    _peers: { peerA: { slot, dc: { readyState: 'open', send: () => undefined } } },
  };
  if (core) window.KNCore = core;
  const context = vm.createContext({
    window,
    KNState: state,
    console: { log: () => undefined, warn: () => undefined },
    EventTarget,
    CustomEvent,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  vm.runInContext(source, context);
  const detector = window.KNDesync;
  assert.ok(detector, 'kn-desync-detector.js did not define window.KNDesync');

  let scene = 0;
  const local = (fid: number, frame: number): number => fid * 1000 + (frame % 7) + 1;
  const perSlot = (base: number) => (slot: number, frame: number) => local(base + slot, frame);
  const module = {
    _kn_hash_stocks: perSlot(0),
    _kn_hash_character_id: perSlot(4),
    _kn_hash_css_cursor: perSlot(8),
    _kn_hash_css_selected: perSlot(12),
    _kn_hash_rng: (frame: number) => local(16, frame),
    _kn_hash_match_phase: (frame: number) => local(17, frame),
    _kn_hash_vs_battle_hdr: (frame: number) => local(18, frame),
    _kn_hash_physics_motion: (frame: number) => local(19, frame),
    _kn_hash_ft_buffer: (frame: number) => local(20, frame),
    _kn_get_pre_replay_hash: () => 0,
    _kn_get_post_replay_hash: () => 0,
    _kn_get_last_replay_target_frame: () => -1,
    _kn_get_last_replay_final_frame: () => -1,
    _kn_get_replay_frame_hash: () => 0,
    _kn_get_last_replay_length: () => 0,
    _kn_get_scene_curr: () => scene,
  } satisfies CoreExports;

  const suspects: Suspect[] = [];
  detector.events.addEventListener('desync-suspect', (event) => {
    if (event instanceof CustomEvent) suspects.push(structuredClone(event.detail));
  });
  detector.init(module, mode);
  const next = lcg(2026);
  for (let frame = 0; frame < 1500; frame++) {
    scene = frame < 500 ? SCENE_CSS_VS : frame < 1200 ? SCENE_IN_GAME_VS : 21;
    detector.tick(frame);
    const theirs = Array.from({ length: FIELD_COUNT }, (_, fid) => local(fid, frame));
    const r = next() % 100;
    if (r < 12) theirs[next() % FIELD_COUNT] = 99;
    if (r === 12) theirs[MATCH_PHASE_FIELD] = 98;
    // A digest cut short, which no honest peer sends.
    if (r === 13) theirs.length = 10;
    detector.onPeerDigest('peerA', { frame, hashes: theirs });
  }
  return suspects;
};

const digestOf = (suspects: Suspect[]): string => createHash('sha256').update(JSON.stringify(suspects)).digest('hex');

// What kn-desync-detector.js emitted for this script at ff53345, before its
// flag decision moved to web/src/desync-fields.ts: the number of suspects
// and a hash of all of them, per comparison mode.
const GOLDEN: { mode: string; isLocalHost: boolean; count: number; sha256: string }[] = [
  {
    mode: 'B',
    isLocalHost: false,
    count: 94,
    sha256: 'a267f5ec6916ab9b2ea3426269f6dcadb71436f47a15d680232e7bd54a97d076',
  },
  {
    mode: 'B',
    isLocalHost: true,
    count: 94,
    sha256: 'a267f5ec6916ab9b2ea3426269f6dcadb71436f47a15d680232e7bd54a97d076',
  },
  {
    mode: 'C',
    isLocalHost: true,
    count: 18,
    sha256: '45532da945df3ec056849f40b646f0b75b2c43b91383e5994e2f0e0676db777f',
  },
  {
    mode: 'C',
    isLocalHost: false,
    count: 18,
    sha256: '2512ea6051c127bcd1718d7eee1d2defc16987e7ad42796552417c64c27ab208',
  },
];

test('the detector emits what it did before, with and without the bundle', () => {
  for (const g of GOLDEN) {
    const where = `mode ${g.mode}, ${g.isLocalHost ? 'host' : 'guest'}`;
    const builtIn = runDetector(g.mode, g.isLocalHost);
    assert.equal(builtIn.length, g.count, `${where}, built-in rule`);
    assert.equal(digestOf(builtIn), g.sha256, `${where}, built-in rule`);
    const withCore = runDetector(g.mode, g.isLocalHost, { desyncFieldsToFlag: fieldsToFlag });
    assert.deepStrictEqual(withCore, builtIn, `${where}, KNCore rule`);
    assert.ok(g.count > 10, `${where}: the script should produce suspects to compare`);
  }
});

test('the detector asks KNCore for the decision when the bundle is loaded', () => {
  let calls = 0;
  runDetector('B', false, {
    desyncFieldsToFlag: (...args) => {
      calls++;
      return fieldsToFlag(...args);
    },
  });
  assert.ok(calls > 1000, `KNCore.desyncFieldsToFlag was called ${calls} times`);
});
