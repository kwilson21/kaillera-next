import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { demo } from '../../web/src/demo/index.ts';
import { lcg } from './load-shared.ts';

// web/static/demo.js calls web/src/demo for its options, network settings,
// HUD text, menu script and ROM checks. Here the page script as it is now,
// with the real TypeScript behind `window.KNCore.demo`, is run beside the
// script it replaced (fixtures/demo.old.js: web/static/demo.js before the move,
// verbatim) on two identical fake pages with a fake engine and fake peer.
// Both are driven through the same visits, and after every step everything a
// page can show or hand to the engine must be the same on both.

const OLD_SCRIPT = new vm.Script(readFileSync(new URL('./fixtures/demo.old.js', import.meta.url), 'utf8'));
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
  | { kind: 'load'; name: string };

/** `window.KNDemo`, as demo.js leaves it. */
type DemoApi = {
  loadRomFile: (file: { name: string; bytes: ArrayBuffer }) => Promise<void>;
  setRollbackEnabled: (enabled: boolean) => void;
  startRecording: () => void;
  stopRecording: () => void;
  getRecording: () => string;
};

/** `window.KNCore` as a page script finds it. */
type Core = { demo?: typeof demo };

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
  let strict = false;
  let inclusive = false;
  let cRollback = false;
  let pilotFailure: string | null = null;
  let gamepads: { id: string }[] = [];
  let real: Pad = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
  let mirrored: ((frame: number) => Pad | null) | null = null;
  let gamepadsChanged: (() => void) | null = null;
  let blobs = 0;
  let api: DemoApi | undefined;
  let onWindow = '';

  const local = fakeStorage(visit.local);
  const session = fakeStorage(visit.session);
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
    addEventListener: (type: string): void => note('window.addEventListener', type),
    removeEventListener: (type: string): void => note('window.removeEventListener', type),
    location: { search: visit.search, reload: (): void => note('reload') },
    localStorage: local,
    sessionStorage: session,
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
    Blob,
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
      isInMatch: (): boolean => strict,
      isInMatchOrPaused: (): boolean => inclusive,
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
      strict = step.strict;
      inclusive = step.inclusive;
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
    } else await api?.loadRomFile({ name: step.name, bytes: new Uint8Array([1, 2, 3, 4]).buffer });
    await nextTurn();
  };

  /** Everything the page shows, has stored, has set on `window`, and has told the engine and the peer. */
  const snapshot = (): string => {
    READ_WINDOW.runInContext(context);
    return [
      ...[...elements.values(), head, body].map((element) => element.describe()),
      show([...local.items]),
      show([...session.items]),
      onWindow,
      show({ timers: timers.map((timer) => [timer.at, timer.every]), frames: frames.length }),
      // What it has said since the last look.
      ...log.splice(0),
    ].join('\n');
  };

  return { apply, snapshot, hasApi: (): boolean => api !== undefined };
};

/** The same visit on the old script and on the new one, compared after every step. */
const compareVisit = async (visit: Visit, steps: readonly Step[]): Promise<void> => {
  // The old script only checks that a core is there; it calls none of it.
  const before = openDemo(OLD_SCRIPT, {}, visit);
  const after = openDemo(NEW_SCRIPT, { demo }, visit);
  assert.equal(after.snapshot(), before.snapshot(), `on load: ${show(visit)}`);
  let done = 0;
  for (const step of steps) {
    await before.apply(step);
    await after.apply(step);
    done++;
    assert.equal(after.snapshot(), before.snapshot(), `step ${done} ${show(step)} of ${show(visit)}`);
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
  if (roll < 0.93) return { kind: 'input', real: randomPad(random) };
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
      : `Lockstep feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${effectiveDelay} frame${effectiveDelay === 1 ? '' : 's'}</strong>`;
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
