import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { demo } from '../../web/src/demo/index.ts';
import * as ejs from '../../web/src/page/ejs-globals.ts';
import { fakeIndexedDb } from './fake-indexeddb.ts';
import { lcg } from './load-shared.ts';

// The one piece of real asynchronous work either page does here: hashing a ROM
// with crypto.subtle, which runs off the main thread and answers late on a
// busy machine. Counted, so a step waits for its answer (`settle`).
let digesting = 0;
const digest = crypto.subtle.digest.bind(crypto.subtle);
Object.defineProperty(crypto.subtle, 'digest', {
  configurable: true,
  value: (...args: Parameters<typeof digest>): ReturnType<typeof digest> => {
    digesting++;
    return digest(...args).finally(() => {
      digesting--;
    });
  },
});

/** Longest a step may leave a page busy: far beyond a digest of a few bytes, even on a loaded machine. */
const SETTLE_LIMIT_MS = 10_000;

/**
 * Waits until the pages have finished what a step started: no digest in
 * flight and no IndexedDB event unfired, for two turns of the event loop in a
 * row (a digest's answer can start more work, such as saving the ROM). The
 * fake clock does not move here; a page's timers run only on a frame step.
 */
const settle = async (pending: readonly (() => number)[]): Promise<void> => {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  for (let quiet = 0; quiet < 2;) {
    await nextTurn();
    const events = pending.reduce((sum, count) => sum + count(), 0);
    quiet = digesting === 0 && events === 0 ? quiet + 1 : 0;
    if (Date.now() > deadline) {
      throw new Error(`still busy after ${SETTLE_LIMIT_MS} ms: ${digesting} digests, ${events} IndexedDB events`);
    }
  }
};

// web/static/demo.js calls web/src/demo for its options, network settings,
// HUD text, menu script and ROM checks, and for its wiring: the emulator's
// boot, the engine's start, and the autopilot and fake peer connected to it
// (wiring.ts, given the page's own timers). Here the page script as it is now,
// with the real TypeScript behind `window.KNCore.demo`, is run beside the
// script it replaced (fixtures/demo.old.js: web/static/demo.js before the move,
// verbatim) on two identical fake pages with a fake engine and fake peer.
// Both are driven through the same visits, and after every step everything a
// page can show or hand to the engine must be the same on both.

const OLD_SOURCE = readFileSync(new URL('./fixtures/demo.old.js', import.meta.url), 'utf8');
// Changed since, on purpose. The old script runs with these changes and is
// held to everything else, character for character:
//  - Auto-compare paused by the Pause button counts as on, so its button, the
//    rollback button and leaving the match stop it, and nothing starts it
//    again over its pause mark. The test 'a paused auto-compare' shows the two
//    orderings the change is for.
//  - Once the page has asked to reload (Reset, or the autopilot's retry), it
//    takes no more of the match's edges: the run state has left. The old
//    script took them in the rest of the HUD frame that restarted the demo,
//    and could clear the autopilot's retry mark there, so the next stall
//    restarted the demo again instead of handing over.
//  - Decorative button glyphs now come from CSS, not the accessible label.
const SINCE_THE_OLD_SCRIPT: readonly (readonly [string, string])[] = [
  ['Play now →', 'Play now'],
  ['▶ Auto-compare every 6s', 'Auto-compare every 6s'],
  ['■ Stop auto-compare', 'Stop auto-compare'],
  [
    '  const _isAutoCompareRunning = () => _autoCompareTimer !== 0;',
    '  const _isAutoCompareRunning = () => _autoCompareTimer !== 0 || _autoComparePausedAt !== 0;',
  ],
  ["    _setStatus('Resetting demo…');", "    _reloading = true;\n    _setStatus('Resetting demo…');"],
  ['  const _resetDemo = () => {', '  let _reloading = false;\n  const _resetDemo = () => {'],
  [
    '    if (inMatchStrict !== _lastFakePeerMatchActive) {',
    '    if (!_reloading && inMatchStrict !== _lastFakePeerMatchActive) {',
  ],
  ['    if (inMatch !== _wasInMatch) {', '    if (!_reloading && inMatch !== _wasInMatch) {'],
];
const OLD_SCRIPT = new vm.Script(
  SINCE_THE_OLD_SCRIPT.reduce((script, [before, after]) => {
    assert.equal(script.split(before).length, 2, `the old script has this line once: ${before}`);
    return script.replace(before, after);
  }, OLD_SOURCE),
);
const OLD_SCRIPT_AS_IT_WAS = new vm.Script(OLD_SOURCE);
const NEW_SCRIPT = new vm.Script(readFileSync(new URL('../../web/static/demo.js', import.meta.url), 'utf8'));

/** Seeded random numbers from 0 up to 1, like `Math.random`. */
const seeded = (seed: number): (() => number) => {
  const next = lcg(seed);
  return (): number => next() / 2 ** 32;
};

/** A function, whatever it takes. */
type Callable = (...args: never[]) => void;

/** A value the comparison can put into words. */
type Shown = number | string | boolean | null | undefined | Callable | Shown[] | { [key: string]: Shown };

/** A value as text, so results from two vm realms compare; keeps -0, NaN and undefined apart. */
const show = (value: Shown): string => {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return 'fn';
  if (value === null || value === undefined || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(',')}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${key}:${show(item)}`)
    .join(',')}}`;
};

type Pad = { buttons: number; lx: number; ly: number; cx: number; cy: number };
type Listener = (event: { preventDefault: () => void }) => void;

/** An element with the few members demo.js touches. */
class FakeElement {
  id = '';
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  href = '';
  download = '';
  src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly style = { cssText: '', background: '', animation: '', width: '' };
  readonly classes = new Set<string>();
  readonly dataset: { [key: string]: string } = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = {
    add: (...names: string[]): void => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]): void => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  appendChild(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }
  remove(): void {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
  click(): void {
    this.fire('click');
  }
  /** Only `.name` selectors, over the element's children. */
  querySelectorAll(selector: string): FakeElement[] {
    const name = selector.replace(/^\./, '');
    return this.children.filter((child) => child.classes.has(name));
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => undefined });
  }
  describe(): string {
    return show({
      id: this.id,
      text: this.textContent,
      html: this.innerHTML,
      value: this.value,
      disabled: this.disabled,
      link: [this.href === '' ? '' : 'href', this.download, this.src],
      classes: [...this.classes].sort(),
      attributes: [...this.attributes],
      style: this.style,
      children: this.children.map((child) => child.describe()),
    });
  }
}

// Every id in web/demo.html.
const PAGE_IDS = [
  'demo-status',
  'game',
  'rom-drop',
  'rom-file',
  'game-loading',
  'game-loading-text',
  'mode-switch',
  'mode-switch-title',
  'mode-switch-sub',
  'gesture-prompt',
  'gesture-button',
  'play-cta',
  'play-cta-headline',
  'play-cta-sub',
  'play-cta-button',
  'hud-feel',
  'hud-feel-sub',
  'hud-frame-delay',
  'hud-details',
  'lag-value',
  'lag',
  'rollback-toggle',
  'auto-compare',
  'auto-compare-btn',
  'auto-progress',
  'emu-controls',
  'emu-reset',
  'emu-pause',
  'emu-stop',
  'gamepad-status',
  'rb-timeline',
  'rb-head',
  'rb-lbl-bad',
  'rb-lbl-re',
  'rb-caption',
];

/** What the visit starts from. */
type Visit = {
  search: string;
  local: [string, string][];
  session: [string, string][];
  /** The ROM is the US SSB64, and the closed-loop menu autopilot is on the page. */
  closedLoop: boolean;
  seed: number;
  /** `KNShared.N64_MAX`, a stick's full deflection; 83 when not given. */
  stickMax?: number;
  /** The file name of a ROM an earlier visit left in the demo's ROM cache. */
  cached?: string | undefined;
  /** The browser asks for reduced motion. */
  reducedMotion?: boolean | undefined;
};

/** The engine's counters as a step sets them; a missing or off-shape field is part of the test. */
type Counters = {
  delay?: number | null | undefined;
  currentFrame?: number | undefined;
  isCRollback?: boolean | undefined;
  rollbackEventsTotal?: number | undefined;
  rollbackEventsPerSec?: number | undefined;
  fps?: number | null | undefined;
  totalMispredicts?: number;
};

/** `NetplayRollback.getSceneStatus()`. */
type Scene = { ready: boolean; scene: number | undefined; status: number | undefined };

/** SSB64's battle scene. */
const BATTLE_SCENE = 22;

/** The engine's match readings: the battle scene, in one of these game statuses. */
const battle = (scene: Scene | undefined, statuses: readonly number[]): boolean =>
  scene?.ready === true && scene.scene === BATTLE_SCENE && statuses.includes(scene.status ?? -1);

/** One thing done to the page or said by the engine. */
type Step =
  | { kind: 'slider'; value: string }
  | { kind: 'counters'; counters: Counters | undefined }
  | { kind: 'match'; strict: boolean; inclusive: boolean }
  | { kind: 'scene'; scene: Scene | undefined }
  | { kind: 'cRollback'; on: boolean }
  | { kind: 'pilotFailure'; failure: string | null }
  | { kind: 'gamepads'; ids: string[] }
  | { kind: 'frame'; ms: number }
  | { kind: 'click'; id: string }
  | { kind: 'rollback'; on: boolean }
  | { kind: 'input'; real: Pad }
  | { kind: 'mirror'; frame: number }
  | { kind: 'record'; call: 'startRecording' | 'stopRecording' | 'getRecording' }
  | { kind: 'load'; name: string }
  | { kind: 'shim' }
  /** The emulator's loader finishes (its event), its script loads, or its script fails. */
  | { kind: 'loader'; how: 'complete' | 'load' | 'error' };

/** `window.KNDemo`, as demo.js leaves it. */
type DemoApi = {
  loadRomFile: (file: { name: string; bytes: ArrayBuffer }) => Promise<void>;
  setRollbackEnabled: (enabled: boolean) => void;
  startRecording: () => void;
  stopRecording: () => void;
  getRecording: () => string;
  /** The run-state machine beside the flags; the old script has none. */
  /** The run state as one line (web/src/demo/run-state.ts); the old script has none. */
  runState?: { state: () => string };
};

/** `window.KNCore` as a page script finds it. */
type Core = { demo?: typeof demo; ejs?: typeof ejs };

/** A Blob that keeps what it was made from, so the fake File below can read it at once. */
class RecordingBlob extends Blob {
  readonly parts: readonly unknown[];
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    this.parts = parts;
  }
}

/** A File the fake FileReader reads: its bytes are those of the first part it was made from. */
class FakeFile {
  readonly name: string;
  readonly bytes: ArrayBuffer;
  constructor(parts: readonly unknown[], name: string) {
    this.name = name;
    const first = parts[0];
    const inner = first instanceof RecordingBlob ? first.parts[0] : first;
    this.bytes = ArrayBuffer.isView(inner)
      ? new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength).slice().buffer
      : new ArrayBuffer(0);
  }
}

/**
 * A WebGL context class with fresh prototypes for each page, its calls noted
 * on the instance. The second kind refuses pixelStorei and has no
 * compressedTexSubImage2D, the two cases the texture-upload shim must step
 * around.
 */
const fakeGlContext = (refuseAlignment: boolean, withSubUpload: boolean) => {
  class FakeGl {
    readonly UNPACK_ALIGNMENT = 3317;
    calls: string[] = [];
    pixelStorei(pname: number, param: number): void {
      if (refuseAlignment) throw new Error('refused');
      this.calls.push(`pixelStorei(${pname},${param})`);
    }
    texImage2D(...args: number[]): void {
      this.calls.push(`texImage2D(${args.join(',')})`);
    }
    texSubImage2D(...args: number[]): void {
      this.calls.push(`texSubImage2D(${args.join(',')})`);
    }
    compressedTexImage2D(...args: number[]): void {
      this.calls.push(`compressedTexImage2D(${args.join(',')})`);
    }
  }
  if (withSubUpload) {
    Object.assign(FakeGl.prototype, {
      compressedTexSubImage2D(this: FakeGl, ...args: number[]): void {
        this.calls.push(`compressedTexSubImage2D(${args.join(',')})`);
      },
    });
  }
  return FakeGl;
};

/** `matchMedia`'s answer, as the page reads it. */
type MediaQueryAnswer = { matches: boolean };

/** The timeline stub's state: how many frames it has been fed. */
type TimelineStubState = { n: number };

/** The elements the page hands the timeline's renderer, as the stub below reads them. */
type TimelineRefsSeen = {
  ticks?: FakeElement[];
  head?: FakeElement | null;
  labelBad?: FakeElement | null;
  labelReplay?: FakeElement | null;
  caption?: FakeElement | null;
};

/** The bytes of the ROM an earlier visit left in the cache. */
const CACHED_BYTES = [9, 8, 7, 6];

/** What demo.js gives the fake peer when it starts it. */
type PeerStart = {
  slot: number;
  getCurrentFrame: () => number;
  getMirroredInput: ((frame: number) => Pad | null) | null;
};

/** Keys held or mapped, as `readLocalInput` takes them; the fake reads neither. */
type Keys = { [code: string]: boolean };

const fakeStorage = (initial: [string, string][]) => {
  const items = new Map<string, string>(initial);
  return {
    items,
    getItem: (key: string): string | null => items.get(key) ?? null,
    setItem: (key: string, value: string): void => void items.set(key, String(value)),
    removeItem: (key: string): void => void items.delete(key),
  };
};

// Run in the page: hands this test what demo.js has left on `window`.
const READ_WINDOW = new vm.Script(`__read(window.KNDemo, {
  player: window.EJS_player,
  core: window.EJS_core,
  gameId: window.EJS_gameID,
  path: window.EJS_pathtodata,
  controls: window.EJS_defaultControls,
  gl: [window.WebGLRenderingContext, window.WebGL2RenderingContext].map((Context) => {
    const gl = new Context();
    const out = [String(Context.prototype.__knUnpackAlignmentPatched)];
    for (const upload of ['texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D']) {
      if (typeof gl[upload] !== 'function') {
        out.push(upload + ':none');
        continue;
      }
      gl.calls = [];
      gl[upload](1, 2);
      out.push(upload + ':' + gl.calls.join('|'));
    }
    return out.join(' ');
  }),
  options: window.EJS_defaultOptions,
  legacy: window.EJS_forceLegacyCores,
  shim: window.__knInstallUnpackAlignmentShim,
  gameUrl: window.EJS_gameUrl,
  gameName: window.EJS_gameName,
  startOnLoaded: window.EJS_startOnLoaded,
  boot: window.KNStartEmulatorBoot,
  live: window.__knDemoP2LiveInput,
  recording: window.__demoRecording,
  state: window.KNState,
});`);

/** A demo page with `script` as its demo.js, on fakes this test drives. */
const openDemo = (script: vm.Script, core: Core | undefined, visit: Visit) => {
  const log: string[] = [];
  const note = (name: string, ...args: Shown[]): void => void log.push(`${name}(${args.map(show).join(',')})`);
  const elements = new Map(
    PAGE_IDS.map((id) => {
      const element = new FakeElement();
      element.id = id;
      return [id, element];
    }),
  );
  const lag = elements.get('lag');
  if (lag) lag.value = '0';
  // The timeline's tick marks, out of their data-i order as a page could list them.
  const track = elements.get('rb-timeline');
  for (const i of [3, 0, 7, 1, 6, 2, 5, 4]) {
    const tick = new FakeElement();
    tick.classes.add('t');
    tick.dataset['i'] = String(i);
    track?.appendChild(tick);
  }
  const head = new FakeElement();
  const body = new FakeElement();
  const attached = (): FakeElement[] => [...head.children, ...body.children];
  const ready: (() => void)[] = [];

  let clock = 1000;
  let nextId = 1;
  let timers: { id: number; at: number; every: number | null; run: () => void }[] = [];
  let frames: { id: number; run: (now: number) => void }[] = [];
  const random = seeded(visit.seed);

  // What the fake engine, peer and gamepads answer with; steps change it.
  let counters: Counters | undefined;
  let scene: Scene | undefined;
  let cRollback = false;
  let pilotFailure: string | null = null;
  let gamepads: { id: string }[] = [];
  let real: Pad = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
  let mirrored: ((frame: number) => Pad | null) | null = null;
  let gamepadsChanged: (() => void) | null = null;
  let blobs = 0;
  let api: DemoApi | undefined;
  let onWindow = '';
  let windowListeners: { type: string; listener: () => void }[] = [];

  const local = fakeStorage(visit.local);
  const session = fakeStorage(visit.session);
  const idb = fakeIndexedDb();
  if (visit.cached !== undefined) {
    idb.seed('kn-demo-rom', 'rom', 'current', { bytes: new Uint8Array(CACHED_BYTES), name: visit.cached });
  }
  // demo.js replaces readLocalInput on this object with its own wrapper.
  const shared = {
    N64_MAX: visit.stickMax ?? 83,
    readLocalInput: (_slot: number, _keyMap: Keys, _held: Keys): Pad => ({ ...real }),
    resetBootState: (): void => note('resetBootState'),
  };
  const context = vm.createContext({
    document: {
      head,
      body,
      addEventListener: (type: string, listener: () => void): void => {
        if (type === 'DOMContentLoaded') ready.push(listener);
      },
      getElementById: (id: string): FakeElement | null =>
        elements.get(id) ?? attached().find((element) => element.id === id) ?? null,
      createElement: (): FakeElement => new FakeElement(),
    },
    addEventListener: (type: string, listener: () => void): void => {
      note('window.addEventListener', type);
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: () => void): void => {
      note('window.removeEventListener', type);
      windowListeners = windowListeners.filter((entry) => entry.type !== type || entry.listener !== listener);
    },
    location: { search: visit.search, reload: (): void => note('reload') },
    localStorage: local,
    sessionStorage: session,
    indexedDB: idb.factory,
    matchMedia: (query: string): MediaQueryAnswer => {
      note('matchMedia', query);
      return { matches: visit.reducedMotion === true };
    },
    KNRollbackTimeline: {
      createState: (): TimelineStubState => ({ n: 0 }),
      reduce: (state: TimelineStubState, input: Shown, now: number): TimelineStubState => {
        note('timeline.reduce', state.n, input, now);
        return { n: state.n + 1 };
      },
      render: (state: TimelineStubState, refs: TimelineRefsSeen, options?: Shown): void =>
        note(
          'timeline.render',
          state.n,
          (refs.ticks ?? []).map((tick) => tick.dataset['i'] ?? ''),
          [refs.head?.id, refs.labelBad?.id, refs.labelReplay?.id, refs.caption?.id],
          options,
        ),
    },
    WebGLRenderingContext: fakeGlContext(false, true),
    WebGL2RenderingContext: fakeGlContext(true, false),
    performance: { now: (): number => clock },
    console: {
      log: (...args: Shown[]): void => note('console.log', ...args),
      info: (...args: Shown[]): void => note('console.info', ...args),
      warn: (...args: Shown[]): void => note('console.warn', ...args),
    },
    setTimeout: (run: () => void, ms: number): number => {
      timers.push({ id: nextId, at: clock + ms, every: null, run });
      return nextId++;
    },
    setInterval: (run: () => void, ms: number): number => {
      timers.push({ id: nextId, at: clock + ms, every: ms, run });
      return nextId++;
    },
    clearTimeout: (id: number): void => void (timers = timers.filter((timer) => timer.id !== id)),
    clearInterval: (id: number): void => void (timers = timers.filter((timer) => timer.id !== id)),
    requestAnimationFrame: (run: (now: number) => void): number => {
      frames.push({ id: nextId, run });
      return nextId++;
    },
    cancelAnimationFrame: (id: number): void => void (frames = frames.filter((frame) => frame.id !== id)),
    crypto: globalThis.crypto,
    URLSearchParams,
    Blob: RecordingBlob,
    File: FakeFile,
    URL: {
      createObjectURL: (): string => `blob:demo-${++blobs}`,
      revokeObjectURL: (url: string): void => note('revokeObjectURL', url),
    },
    FileReader: class {
      result: ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer(file: { bytes: ArrayBuffer }): void {
        queueMicrotask(() => {
          this.result = file.bytes;
          this.onload?.();
        });
      }
    },
    NetplayRollback: {
      init: (options: Shown): void => note('init', options),
      getHudCounters: (): Counters | undefined => counters,
      getSceneStatus: (): Scene | undefined => scene,
      // Read from the scene status as the engine does, so it never reports a match on a menu scene.
      isInMatch: (): boolean => battle(scene, [1]),
      isInMatchOrPaused: (): boolean => battle(scene, [1, 2, 3]),
      isCRollback: (): boolean => cRollback,
      readRdram32: (): number => 0,
      setPredictionsPaused: (paused: boolean): void => note('setPredictionsPaused', paused),
      setDelayRetuneEnabled: (enabled: boolean): void => note('setDelayRetuneEnabled', enabled),
      setDemoMode: (on: boolean): void => note('setDemoMode', on),
      pauseTick: (): void => note('pauseTick'),
      resumeTick: (): void => note('resumeTick'),
    },
    KNFakePeer: {
      start: (options: PeerStart): void => {
        mirrored = options.getMirroredInput;
        note('peer.start', options);
      },
      setNetwork: (network: Shown): void => note('peer.setNetwork', network),
      setMatchActive: (active: boolean): void => note('peer.setMatchActive', active),
    },
    KNShared: shared,
    KNState: {},
    KNCore: core,
    KNMenuAutopilot: visit.closedLoop
      ? {
          isSsb64UsRom: (): boolean => true,
          create: (options: Shown) => {
            note('pilot.create', options);
            return {
              p1: (frame: number): Pad => ({ buttons: 2, lx: frame, ly: 0, cx: 0, cy: 0 }),
              p2: (frame: number): Pad => ({ buttons: 4, lx: 0, ly: frame, cx: 0, cy: 0 }),
              failure: (): string | null => pilotFailure,
            };
          },
        }
      : undefined,
    GamepadManager: {
      start: (options: { playerSlot: number; onUpdate: () => void }): void => {
        gamepadsChanged = options.onUpdate;
        note('gamepads.start', options);
      },
      getDetected: (): { id: string }[] => gamepads,
      displayName: (id: string): string => (id === 'unnamed' ? '' : `Pad ${id}`),
    },
    ControllerSettings: { toggle: (): void => note('controls.toggle') },
    __random: (): number => random(),
    __read: (demoApi: DemoApi | undefined, left: Shown): void => {
      api = demoApi;
      onWindow = show(left);
    },
  });
  vm.runInContext('var window = globalThis; Math.random = __random;', context);
  script.runInContext(context);
  for (const listener of ready) listener();
  READ_WINDOW.runInContext(context);

  const advance = (ms: number): void => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = Math.max(clock, due.at);
      if (due.every === null) timers = timers.filter((timer) => timer !== due);
      else due.at += due.every;
      due.run();
    }
    clock = until;
    const queued = frames;
    frames = [];
    for (const frame of queued) frame.run(clock);
  };

  const apply = async (step: Step): Promise<void> => {
    if (step.kind === 'slider') {
      const slider = elements.get('lag');
      if (slider) slider.value = step.value;
      slider?.fire('input');
    } else if (step.kind === 'counters') counters = step.counters;
    else if (step.kind === 'scene') scene = step.scene;
    else if (step.kind === 'cRollback') cRollback = step.on;
    else if (step.kind === 'pilotFailure') pilotFailure = step.failure;
    else if (step.kind === 'match') {
      // Into the battle (status 1, Go), its pause menu (2), or out of it (5, End).
      if (step.inclusive) scene = { ready: true, scene: BATTLE_SCENE, status: step.strict ? 1 : 2 };
      else if (battle(scene, [1, 2, 3])) scene = { ready: true, scene: BATTLE_SCENE, status: 5 };
    } else if (step.kind === 'gamepads') {
      gamepads = step.ids.map((id) => ({ id }));
      gamepadsChanged?.();
    } else if (step.kind === 'frame') advance(step.ms);
    else if (step.kind === 'click') elements.get(step.id)?.click();
    else if (step.kind === 'rollback') api?.setRollbackEnabled(step.on);
    else if (step.kind === 'input') {
      real = step.real;
      note('readLocalInput', shared.readLocalInput(0, {}, {}));
    } else if (step.kind === 'mirror') note('mirrored', mirrored?.(step.frame));
    else if (step.kind === 'record') {
      const said = api?.[step.call]();
      note(step.call, typeof said === 'string' ? said : undefined);
    } else if (step.kind === 'shim') {
      vm.runInContext('window.__knInstallUnpackAlignmentShim?.()', context);
    } else if (step.kind === 'loader') {
      if (step.how === 'complete') {
        for (const entry of windowListeners.filter(({ type }) => type === 'kn-ejs-loader-complete')) entry.listener();
      } else {
        const script = body.children.find((child) => child.src === '/static/ejs-loader.js');
        if (step.how === 'load') script?.onload?.();
        else script?.onerror?.();
      }
    } else await api?.loadRomFile({ name: step.name, bytes: new Uint8Array([1, 2, 3, 4]).buffer });
    await settle([idb.pending]);
  };

  /** Everything the page shows, has stored, has set on `window`, and has told the engine and the peer. */
  const snapshot = (): string => {
    READ_WINDOW.runInContext(context);
    return [
      ...[...elements.values(), head, body].map((element) => element.describe()),
      show([...local.items]),
      show([...session.items]),
      idb.describe(),
      onWindow,
      show({ timers: timers.map((timer) => [timer.at, timer.every]), frames: frames.length }),
      // What it has said since the last look.
      ...log.splice(0),
    ].join('\n');
  };

  return {
    apply,
    snapshot,
    hasApi: (): boolean => api !== undefined,
    stored: idb.describe,
    /** IndexedDB events this page has started that have not fired yet. */
    pending: idb.pending,
    runState: (): DemoApi['runState'] => api?.runState,
    element: (id: string): FakeElement | undefined => elements.get(id),
    /** What the page left in sessionStorage, which a reload keeps. */
    session: (): [string, string][] => [...session.items],
  };
};

/** The same visit on the old script and on the new one, compared after every step. */
/** The run-state machine's states the visits have reached, by region (`engine:running`, ...). */
const REACHED = new Set<string>();

/** Notes the new page's run state among those reached, and returns it. */
const noteRunState = (page: ReturnType<typeof openDemo>): string => {
  const state = page.runState()?.state() ?? '';
  for (const part of state.split(' ')) REACHED.add(part);
  return state;
};

const compareVisit = async (visit: Visit, steps: readonly Step[]): Promise<void> => {
  // The old script only checks that a core is there; it calls none of it.
  const before = openDemo(OLD_SCRIPT, {}, visit);
  const expected = () =>
    before.snapshot().replaceAll(/Lockstep(?= makes| feels)|(?<=Mode: )Lockstep|(?<=Switched to )lockstep/g, 'Classic');
  const after = openDemo(NEW_SCRIPT, { demo, ejs }, visit);
  noteRunState(after);
  assert.equal(after.snapshot(), expected(), `on load: ${show(visit)}`);
  // A cached ROM is restored on load: let both pages finish reading and hashing it.
  if (visit.cached !== undefined) {
    await settle([before.pending, after.pending]);
    noteRunState(after);
    assert.equal(after.snapshot(), expected(), `after restoring the cached ROM: ${show(visit)}`);
  }
  let done = 0;
  for (const step of steps) {
    await before.apply(step);
    await after.apply(step);
    done++;
    const state = noteRunState(after);
    assert.equal(after.snapshot(), expected(), `step ${done} ${show(step)} of ${show(visit)}`);
    // Stop or Reset: the page is reloading, and a browser runs nothing more of
    // it. Both pages finish asking for the reload, and the visit ends there.
    if (state === 'leaving') {
      await settle([before.pending, after.pending]);
      assert.equal(after.snapshot(), expected(), `reloading after step ${done} of ${show(visit)}`);
      return;
    }
  }
};

const SEARCHES = [
  '',
  '?record=1',
  '?record=p2',
  '?record=yes',
  '?record=',
  '?randomP1=1',
  '?demoRandomP1=1',
  '?p1Random=1',
  '?randomP1=true',
  '?autoCompare=0',
  '?autoCompare=1',
  '?autoCompare=0&randomP1=1',
  '?kngfx=texrect',
  '?kngfx=texrect-unopt',
  '?kngfx=webgl1',
  '?kngfx=angrylion',
  '?kngfx=parallel',
  '?kngfx=unpack1',
  '?kngfx=TEXRECT',
  '?kngfx=',
  '?kngfx=parallel&kngfx=webgl1',
  '?record=p2&record=1&autoCompare=00',
];
const STORED = ['0', '55', '110', '110.5', '111', '-1', '', ' 40 ', 'abc', 'NaN', 'Infinity', '1e2', '0x20', '54.4'];
const SLIDER = [...STORED, '100', '1', '0.4', '0.6', '109.99', '250', 'null'];
const DELAYS = [undefined, null, 0, 1, 2, 3, 4, 5, 6, 7, 12, -3, 2.9, -0.5, NaN, Infinity];
const CLICKS = [
  'rollback-toggle',
  'auto-compare-btn',
  'emu-pause',
  'emu-stop',
  'emu-controls',
  'emu-reset',
  'gesture-button',
];

const pick = <T>(random: () => number, from: readonly T[]): T | undefined => from[Math.floor(random() * from.length)];

const randomPad = (random: () => number): Pad => ({
  buttons: random() < 0.2 ? random() * 0x10000 : Math.floor(random() * 0x10000),
  lx: Math.round((random() - 0.5) * 200) / (random() < 0.2 ? 3 : 1),
  ly: Math.round((random() - 0.5) * 200),
  cx: Math.round((random() - 0.5) * 200),
  cy: Math.round((random() - 0.5) * 200),
});

const randomCounters = (random: () => number): Counters | undefined => {
  if (random() < 0.05) return undefined;
  const maybe = <T>(value: T): T | undefined => (random() < 0.15 ? undefined : value);
  return {
    delay: pick(random, DELAYS),
    currentFrame: maybe(Math.floor(random() * (random() < 0.3 ? 5000 : 1100))),
    isCRollback: maybe(random() < 0.5),
    rollbackEventsTotal: maybe(random() < 0.3 ? 0 : Math.floor(random() * 400)),
    rollbackEventsPerSec: maybe(random() < 0.4 ? 0 : random() * 9),
    fps: maybe(random() < 0.2 ? 0 : Math.floor(random() * 61)),
    totalMispredicts: Math.floor(random() * 1000),
  };
};

const randomStep = (random: () => number): Step => {
  const roll = random();
  if (roll < 0.12) return { kind: 'slider', value: pick(random, SLIDER) ?? '0' };
  if (roll < 0.3) return { kind: 'counters', counters: randomCounters(random) };
  if (roll < 0.4) {
    const inclusive = random() < 0.6;
    return { kind: 'match', inclusive, strict: inclusive && random() < 0.8 };
  }
  if (roll < 0.46) {
    const scene = {
      ready: random() < 0.8,
      scene: pick(random, [1, 7, 16, 22, undefined]),
      status: pick(random, [0, 1, 2]),
    };
    return { kind: 'scene', scene: random() < 0.1 ? undefined : scene };
  }
  if (roll < 0.49) return { kind: 'cRollback', on: random() < 0.7 };
  if (roll < 0.51) return { kind: 'pilotFailure', failure: pick(random, [null, '', 'cursor lost']) ?? null };
  if (roll < 0.54) return { kind: 'gamepads', ids: pick(random, [[], ['A'], ['unnamed'], ['A', 'B', 'C']]) ?? [] };
  if (roll < 0.74) return { kind: 'frame', ms: pick(random, [1, 16, 17, 100, 250, 640, 3000, 6100]) ?? 16 };
  if (roll < 0.8) return { kind: 'click', id: pick(random, CLICKS) ?? 'rollback-toggle' };
  if (roll < 0.83) return { kind: 'rollback', on: random() < 0.5 };
  if (roll < 0.91) return { kind: 'input', real: randomPad(random) };
  if (roll < 0.93) return { kind: 'loader', how: pick(random, ['complete', 'load', 'error'] as const) ?? 'complete' };
  if (roll < 0.97) return { kind: 'mirror', frame: Math.floor(random() * 1100) - 50 };
  if (roll < 0.99) {
    return {
      kind: 'record',
      call: pick(random, ['startRecording', 'stopRecording', 'getRecording'] as const) ?? 'getRecording',
    };
  }
  return { kind: 'load', name: pick(random, ['again.z64', 'notes.txt']) ?? 'again.z64' };
};

const randomVisit = (random: () => number, seed: number): Visit => {
  const local: [string, string][] = [];
  if (random() < 0.4) local.push(['kn-demo-rtt', pick(random, STORED) ?? '']);
  if (random() < 0.4) local.push(['kn-demo-lag', pick(random, STORED) ?? '']);
  return {
    search: pick(random, SEARCHES) ?? '',
    local,
    session: random() < 0.3 ? [['kn-demo-autopilot-retried', '1']] : [],
    closedLoop: random() < 0.25,
    seed,
    cached: random() < 0.25 ? pick(random, ['saved.z64', 'SAVED.N64', 'saved.zip', '']) : undefined,
    reducedMotion: random() < 0.2,
  };
};

test('seeded visits: the page shows and sends what the old script did, step for step', async () => {
  for (let seed = 1; seed <= 160; seed++) {
    const random = seeded(seed);
    const visit = randomVisit(random, seed);
    const steps: Step[] = [];
    // One visit in five never gets a ROM; the others get one early, and some a file the page refuses.
    if (random() < 0.8) {
      for (let i = Math.floor(random() * 6); i > 0; i--) steps.push(randomStep(random));
      steps.push({
        kind: 'load',
        name: pick(random, ['game.z64', 'GAME.N64', 'a.v64', 'rom.zip', 'z64']) ?? 'game.z64',
      });
    }
    for (let i = 0; i < 90; i++) steps.push(randomStep(random));
    await compareVisit(visit, steps);
  }
});

// The demo has little traffic and no way to report to the server, so these
// visits are the evidence that the run-state machine agrees with demo.js's
// flags. They count only if they take it everywhere.
test('the seeded visits reach every state of every region of the run-state machine', () => {
  const states = [
    ['engine', ['idle', 'running']],
    ['loader', ['none', 'loading', 'done']],
    ['match', ['menus', 'playing', 'gamePaused']],
    ['tick', ['running', 'paused']],
    ['autoCompare', ['off', 'running', 'paused']],
    ['mode', ['rollback', 'lockstep']],
    ['interaction', ['untouched', 'touched']],
  ] as const;
  const expected = [...states.flatMap(([name, all]) => all.map((state) => `${name}:${state}`)), 'leaving'];
  assert.deepEqual(
    expected.filter((state) => !REACHED.has(state)),
    [],
  );
});

// Entering a match animates the slider to the restored preference.
const INTO_A_MATCH: Step[] = [
  { kind: 'match', strict: true, inclusive: true },
  { kind: 'frame', ms: 16 },
  { kind: 'frame', ms: 400 },
  { kind: 'frame', ms: 500 },
];

test('every stored RTT, new key and old: what the page restores and animates the slider to', async () => {
  for (const rtt of [null, ...STORED]) {
    for (const lag of [null, ...STORED]) {
      const local: [string, string][] = [];
      if (rtt !== null) local.push(['kn-demo-rtt', rtt]);
      if (lag !== null) local.push(['kn-demo-lag', lag]);
      await compareVisit({ search: '', local, session: [], closedLoop: false, seed: 1 }, INTO_A_MATCH);
    }
  }
});

test('every address: what the page gives the emulator on load and shows on the way into a match', async () => {
  for (const search of SEARCHES) {
    for (const closedLoop of [false, true]) {
      await compareVisit({ search, local: [], session: [], closedLoop, seed: 1 }, [
        { kind: 'load', name: 'game.z64' },
        { kind: 'click', id: 'gesture-button' },
        { kind: 'input', real: { buttons: 3.7, lx: 4.5, ly: -5.5, cx: 6.2, cy: -7.9 } },
        { kind: 'mirror', frame: 640 },
        ...INTO_A_MATCH,
        { kind: 'input', real: { buttons: 3.7, lx: 4.5, ly: -5.5, cx: 6.2, cy: -7.9 } },
        { kind: 'record', call: 'getRecording' },
      ]);
    }
  }
});

// The two orderings the change since the old script is for. As it was, a
// paused auto-compare outlived the match and ran in the menus once the tick
// resumed, and its button (which still read "Stop auto-compare") restarted it
// with the pause mark left set, after which Pause no longer paused it.
test('a paused auto-compare: leaving the match or clicking its button stops it, where it used to run on', async () => {
  const visit: Visit = { search: '', local: [], session: [], closedLoop: false, seed: 1 };
  const autoComparePaused: Step[] = [
    { kind: 'load', name: 'game.z64' },
    { kind: 'match', strict: true, inclusive: true },
    { kind: 'frame', ms: 16 },
    // Auto-compare starts 600 ms into the match.
    { kind: 'frame', ms: 700 },
    { kind: 'click', id: 'emu-pause' },
  ];
  const orderings: [string, Step[]][] = [
    [
      'leave the match while paused, then resume',
      [
        { kind: 'match', strict: false, inclusive: false },
        { kind: 'frame', ms: 16 },
        { kind: 'click', id: 'emu-pause' },
      ],
    ],
    [
      'click the auto-compare button while paused, then resume and pause again',
      [
        { kind: 'click', id: 'auto-compare-btn' },
        { kind: 'click', id: 'emu-pause' },
        { kind: 'click', id: 'emu-pause' },
      ],
    ],
  ];
  /** Whether auto-compare shows as on, and the mode, a cycle (6 s) after the ordering. */
  const after = async (script: vm.Script, steps: readonly Step[]) => {
    const page = openDemo(script, script === NEW_SCRIPT ? { demo, ejs } : {}, visit);
    for (const step of [...autoComparePaused, ...steps]) await page.apply(step);
    const on = page.element('auto-compare')?.classes.has('is-running') ?? false;
    await page.apply({ kind: 'frame', ms: 6100 });
    return { on, lockstepAfterACycle: page.element('rollback-toggle')?.classes.has('is-off') ?? false };
  };
  for (const [name, steps] of orderings) {
    assert.deepEqual(await after(NEW_SCRIPT, steps), { on: false, lockstepAfterACycle: false }, `now: ${name}`);
    assert.deepEqual(
      await after(OLD_SCRIPT, steps),
      { on: false, lockstepAfterACycle: false },
      `old, changed: ${name}`,
    );
    assert.deepEqual(
      await after(OLD_SCRIPT_AS_IT_WAS, steps),
      { on: true, lockstepAfterACycle: true },
      `as it was: ${name}`,
    );
    // And the new page agrees with the old one changed, step for step.
    await compareVisit(visit, [...autoComparePaused, ...steps, { kind: 'frame', ms: 6100 }]);
  }
});

// The ordering the run state's `leaving` is for. The closed-loop autopilot
// reports a failure on the frame the battle begins: the page marks its one
// retry and restarts the demo. The old script went on with that frame and
// took the match's edge, which clears the retry mark, so after the reload the
// next failure restarted the demo again, and again. Now the page takes
// nothing more once it has asked to reload: the mark survives, and the next
// failure hands the player control.
test('a restart in the frame a match begins: the retry mark survives the reload, where it used to be cleared', async () => {
  const visit: Visit = { search: '', local: [], session: [], closedLoop: true, seed: 1 };
  const failsAsTheBattleBegins: Step[] = [
    { kind: 'load', name: 'game.z64' },
    { kind: 'pilotFailure', failure: 'cursor lost' },
    { kind: 'match', strict: true, inclusive: true },
    { kind: 'frame', ms: 16 },
  ];
  /** The page after the failing frame, and what the next visit (the reload) does with what it left. */
  const visitAndReload = async (script: vm.Script) => {
    const core = script === NEW_SCRIPT ? { demo, ejs } : {};
    const first = openDemo(script, core, visit);
    for (const step of failsAsTheBattleBegins) await first.apply(step);
    const left = first.session();
    const firstSaid = first.snapshot();
    const second = openDemo(script, core, { ...visit, session: left });
    await second.apply({ kind: 'load', name: 'game.z64' });
    await second.apply({ kind: 'pilotFailure', failure: 'cursor lost' });
    await second.apply({ kind: 'frame', ms: 16 });
    const secondSaid = second.snapshot();
    return {
      retryMarkKept: left.some(([key, value]) => key === 'kn-demo-autopilot-retried' && value === '1'),
      matchEdgeAfterReload: /reload\(\)[\s\S]*peer\.setMatchActive\(true\)/.test(firstSaid),
      restartsAgain: secondSaid.includes('reload()'),
      handsOver: secondSaid.includes("you're in control"),
    };
  };
  assert.deepEqual(await visitAndReload(NEW_SCRIPT), {
    retryMarkKept: true,
    matchEdgeAfterReload: false,
    restartsAgain: false,
    handsOver: true,
  });
  assert.deepEqual(await visitAndReload(OLD_SCRIPT), await visitAndReload(NEW_SCRIPT), 'the old script, changed');
  assert.deepEqual(
    await visitAndReload(OLD_SCRIPT_AS_IT_WAS),
    { retryMarkKept: false, matchEdgeAfterReload: true, restartsAgain: true, handsOver: false },
    'the old script as it was',
  );
});

test('the ROM cache: what a load keeps, the next visit restores, and Stop forgets', async () => {
  for (const cached of [undefined, 'saved.z64', 'SAVED.N64', 'saved.zip', '']) {
    await compareVisit({ search: '', local: [], session: [], closedLoop: false, seed: 1, cached }, [
      { kind: 'frame', ms: 16 },
      { kind: 'load', name: 'game.z64' },
      { kind: 'load', name: 'notes.txt' },
      // Stop acts once the emulator's loader is on the page, which the start button puts there.
      { kind: 'click', id: 'gesture-button' },
      { kind: 'click', id: 'emu-stop' },
      { kind: 'frame', ms: 16 },
      { kind: 'click', id: 'emu-reset' },
    ]);
  }
  // The comparison above holds whatever both scripts do; this shows they did use the cache.
  const page = openDemo(NEW_SCRIPT, { demo, ejs }, { search: '', local: [], session: [], closedLoop: false, seed: 1 });
  await page.apply({ kind: 'load', name: 'game.z64' });
  assert.match(page.stored(), /"current",\{"bytes":\[1,2,3,4\],"name":"game.z64"\}/);
  await page.apply({ kind: 'click', id: 'gesture-button' });
  await page.apply({ kind: 'click', id: 'emu-stop' });
  assert.doesNotMatch(page.stored(), /game\.z64/);
  const restored = openDemo(
    NEW_SCRIPT,
    { demo, ejs },
    { search: '', local: [], session: [], closedLoop: false, seed: 1, cached: 'saved.z64' },
  );
  await settle([restored.pending]);
  assert.match(restored.snapshot(), /Restoring saved\.z64|init\(/);
});

test('faster rendering is opt-in and applies only to a core that supports it', () => {
  const events: [string, string][] = [];
  const setVariable = (key: string, value: string) => events.push([key, value]);
  const page: ejs.EjsPage = { EJS_emulator: { gameManager: { setVariable } } };
  ejs.installEjsGlobals(page, '', 'test');
  assert.equal(ejs.earlyVideoPresentationEnabled(page), false);
  ejs.installEjsGlobals(page, '?kngfx=early-video', 'test');
  assert.equal(ejs.earlyVideoPresentationEnabled(page), true);
  assert.deepEqual(events, []);

  const supportedPage: ejs.EjsPage = {
    EJS_emulator: { gameManager: { setVariable, Module: { _kn_get_early_video_frames: () => 0 } } },
  };
  ejs.setEarlyVideoPresentation(supportedPage, true);
  ejs.setEarlyVideoPresentation(supportedPage, false);
  assert.equal(ejs.earlyVideoPresentationEnabled(supportedPage), false);
  assert.deepEqual(events, [
    ['mupen64plus-EarlyVideoPresentation', 'True'],
    ['mupen64plus-EarlyVideoPresentation', 'False'],
  ]);
});

test('every address: the EmulatorJS settings and controls, and the texture-upload shim installed again later', async () => {
  for (const search of SEARCHES) {
    await compareVisit({ search, local: [], session: [], closedLoop: false, seed: 1 }, [
      { kind: 'shim' },
      { kind: 'shim' },
    ]);
  }
  // The comparison holds whatever both do; this shows the shim does its work.
  const page = openDemo(
    NEW_SCRIPT,
    { demo, ejs },
    { search: '?kngfx=unpack1', local: [], session: [], closedLoop: false, seed: 1 },
  );
  assert.match(page.snapshot(), /true texImage2D:pixelStorei\(3317,1\)\|texImage2D\(1,2\)/);
  assert.match(page.snapshot(), /true texImage2D:texImage2D\(1,2\) [^"]*compressedTexSubImage2D:none/);
});

test('the rollback timeline: what the card feeds it each frame, in both modes and with reduced motion', async () => {
  const steps: Step[] = [
    { kind: 'load', name: 'game.z64' },
    { kind: 'counters', counters: { delay: 3, rollbackEventsTotal: 2, currentFrame: 400, isCRollback: true } },
    { kind: 'frame', ms: 250 },
    { kind: 'rollback', on: false },
    { kind: 'frame', ms: 250 },
    { kind: 'match', strict: true, inclusive: true },
    { kind: 'counters', counters: { delay: 5, rollbackEventsTotal: 9, currentFrame: 900 } },
    { kind: 'frame', ms: 250 },
    { kind: 'frame', ms: 250 },
  ];
  for (const reducedMotion of [false, true]) {
    await compareVisit({ search: '', local: [], session: [], closedLoop: false, seed: 1, reducedMotion }, steps);
  }
  // The comparison holds whatever both do; this shows the timeline was fed and drawn.
  const seen = async (reducedMotion: boolean): Promise<string> => {
    const page = openDemo(
      NEW_SCRIPT,
      { demo, ejs },
      { search: '', local: [], session: [], closedLoop: false, seed: 1, reducedMotion },
    );
    let log = '';
    for (const step of steps) {
      await page.apply(step);
      log += page.snapshot();
    }
    return log;
  };
  const moving = await seen(false);
  assert.match(moving, /timeline\.reduce\(/);
  assert.match(
    moving,
    /timeline\.render\(\d+,\["0","1","2","3","4","5","6","7"\],\["rb-head","rb-lbl-bad","rb-lbl-re","rb-caption"\],undefined\)/,
  );
  const still = await seen(true);
  assert.doesNotMatch(still, /timeline\.reduce\(/);
  assert.equal(still.match(/timeline\.render\(/g)?.length, 1);
  assert.match(still, /timeline\.render\(0,.*\{still:true\}\)/);
});

test('every slider value: the network handed to the fake peer and the label beside the slider', async () => {
  const values = [...SLIDER];
  for (let tenth = 0; tenth <= 1150; tenth++) values.push(String(tenth / 10));
  await compareVisit(
    { search: '', local: [], session: [], closedLoop: false, seed: 1 },
    values.map((value) => ({ kind: 'slider', value })),
  );
});

test('every frame of the menu script: the inputs both players are given', async () => {
  for (const search of ['', '?record=p2']) {
    const steps: Step[] = [{ kind: 'load', name: 'game.z64' }];
    for (const frame of [NaN, -1, undefined, ...Array.from({ length: 1000 }, (_, i) => i)]) {
      steps.push(
        { kind: 'counters', counters: frame === undefined ? {} : { currentFrame: frame, delay: 2 } },
        { kind: 'input', real: { buttons: 9.7, lx: 1.5, ly: -2.5, cx: 3, cy: -4 } },
        { kind: 'mirror', frame: frame ?? 0 },
      );
    }
    await compareVisit({ search, local: [], session: [], closedLoop: false, seed: 1 }, steps);
  }
});

test('every delay in and out of a match, in both modes: the result card, pill and details line', async () => {
  const steps: Step[] = [];
  for (const inclusive of [false, true]) {
    for (const on of [true, false]) {
      steps.push({ kind: 'match', strict: inclusive, inclusive }, { kind: 'frame', ms: 700 }, { kind: 'rollback', on });
      for (const delay of [...DELAYS, 8, 9, 30, 1e9, -1e9, 0.999, 1.0001]) {
        for (const rate of [undefined, 0, 0.04, 2.25]) {
          const counters = { delay, rollbackEventsPerSec: rate, rollbackEventsTotal: delay === 3 ? 0 : 41, fps: delay };
          steps.push({ kind: 'counters', counters }, { kind: 'frame', ms: 250 });
        }
      }
    }
  }
  await compareVisit({ search: '?autoCompare=0', local: [], session: [], closedLoop: false, seed: 1 }, steps);
});

test('a random player 1: the inputs drawn, and how long each is held', async () => {
  for (const stickMax of [83, 20, 127]) {
    const steps: Step[] = [
      { kind: 'load', name: 'game.z64' },
      { kind: 'match', strict: true, inclusive: true },
      { kind: 'frame', ms: 16 },
    ];
    for (let frame = 0; frame < 60000; frame += 40) {
      steps.push(
        { kind: 'counters', counters: { currentFrame: frame } },
        { kind: 'input', real: { buttons: 1, lx: 2, ly: 3, cx: 4, cy: 5 } },
      );
    }
    await compareVisit(
      { search: '?randomP1=1', local: [], session: [], closedLoop: false, seed: stickMax, stickMax },
      steps,
    );
  }
});

test('the autopilot deadline: the frame and scene at which the page gives up on the menus', async () => {
  for (const closedLoop of [false, true]) {
    for (const retried of [false, true]) {
      for (const scene of [1, 22, undefined]) {
        for (const frame of [0, 1521, 1522, 1523, 3599, 3600, 3601, NaN]) {
          await compareVisit(
            {
              search: '',
              local: [],
              session: retried ? [['kn-demo-autopilot-retried', '1']] : [],
              closedLoop,
              seed: 1,
            },
            [
              { kind: 'load', name: 'game.z64' },
              { kind: 'scene', scene: { ready: true, scene, status: 0 } },
              { kind: 'counters', counters: { currentFrame: frame } },
              { kind: 'frame', ms: 16 },
              { kind: 'input', real: { buttons: 1, lx: 2, ly: 3, cx: 4, cy: 5 } },
            ],
          );
        }
      }
    }
  }
});

test('with no core the page says to reload and calls nothing', () => {
  const page = openDemo(NEW_SCRIPT, undefined, {
    search: '?record=1',
    local: [],
    session: [],
    closedLoop: false,
    seed: 1,
  });
  assert.match(page.snapshot(), /"Part of this page did not load\. Reload the page to try again\."/);
  assert.equal(page.hasApi(), false);
});

// ── the pieces the page cannot reach on a fake, against the lines they replaced ──

test('the ROM hash is the old one, and is nothing where the browser cannot compute SHA-256', async () => {
  // fixtures/demo.old.js, lines 346-356.
  const oldHash = async (bytes: ArrayBuffer, crypto: { subtle?: SubtleCrypto } | undefined): Promise<string | null> => {
    try {
      if (!crypto?.subtle) throw new TypeError('no subtle');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return 'S' + hex;
    } catch {
      return null;
    }
  };
  const random = seeded(7);
  for (let i = 0; i < 40; i++) {
    const bytes = Uint8Array.from({ length: Math.floor(random() * 300) }, () => Math.floor(random() * 256)).buffer;
    assert.equal(await demo.rom.demoRomHash(bytes), await oldHash(bytes, globalThis.crypto));
  }
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  assert.ok(real);
  try {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    assert.equal(await demo.rom.demoRomHash(new ArrayBuffer(8)), await oldHash(new ArrayBuffer(8), {}));
    assert.equal(await demo.rom.demoRomHash(new ArrayBuffer(8)), null);
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
  }
});

test('the pill for every tier and delay, in both modes', () => {
  // fixtures/demo.old.js, lines 1339-1341.
  const oldPill = (rollbackEnabled: boolean, tier: { label: string }, effectiveDelay: number): string =>
    rollbackEnabled
      ? `Rollback feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${effectiveDelay} frame${effectiveDelay === 1 ? '' : 's'}</strong>`
      : `Classic feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${effectiveDelay} frame${effectiveDelay === 1 ? '' : 's'}</strong>`;
  for (const delay of [0, 1, 2, 3, 7, 0.5, -1, NaN]) {
    for (const on of [true, false]) {
      const tier = demo.hud.connectionTier(delay);
      assert.equal(demo.hud.tierPillHtml(on, tier, delay), oldPill(on, tier, delay));
    }
  }
});

test('connection tiers for delays the page never shows a tier for', () => {
  // fixtures/demo.old.js, lines 1241-1249.
  const oldTier = (delayFrames: number) => {
    if (delayFrames <= 0) return { label: 'No connection', tone: 'idle' };
    if (delayFrames <= 2) return { label: 'Excellent', tone: 'great' };
    if (delayFrames === 3) return { label: 'Good', tone: 'great' };
    if (delayFrames === 4) return { label: 'Fair', tone: 'okay' };
    if (delayFrames === 5) return { label: 'Poor', tone: 'bad' };
    if (delayFrames === 6) return { label: 'Bad', tone: 'bad' };
    return { label: 'Terrible', tone: 'bad' };
  };
  for (const delay of [-2, -0, 0, 0.5, 1, 2, 2.5, 3, 3.5, 4, 5, 6, 6.5, 7, 100, NaN, Infinity, -Infinity]) {
    assert.deepEqual(demo.hud.connectionTier(delay), oldTier(delay), String(delay));
  }
});
