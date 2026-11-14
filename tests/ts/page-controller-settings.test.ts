import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { Schema } from 'effect';
import { decodeGamepadProfile, type GamepadProfile } from '../../web/src/gamepad-profile.ts';
import {
  capturedInput,
  cStickAxes,
  deadzoneRingRadius,
  deadzoneText,
  gamepadBindingName,
  hundredthsFromSlider,
  invertKeyMap,
  type KeyMap,
  keyMapWithKey,
  keyName,
  N64_BUTTONS,
  percentText,
  profileAfterCapture,
  rangeFromSlider,
  rangeRingRadius,
  resetStorageKeys,
  savedKeyboardMap,
  sliderHundredths,
} from '../../web/src/page/controller-settings/logic.ts';
import { C_STICK_SVG, LEFT_STICK_SVG, PANEL_CSS } from '../../web/src/page/controller-settings/markup.ts';
import {
  type ControllerSettingsHost,
  type ControllerSettingsPanel,
  startControllerSettings,
} from '../../web/src/page/controller-settings/panel.ts';
import { DEFAULT_KEY_MAP, WIZARD_STEPS } from '../../web/src/play/remap-wizard.ts';

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/controller-settings.js as of #166, unchanged. It runs on the same
// fake page as the TypeScript, and the two are compared after every step.
const OLD_SCRIPT = readFileSync(new URL('./fixtures/controller-settings.old.js', import.meta.url), 'utf8');

/** The old script's own helpers, handed out of its closure so they can be called one at a time. */
interface OldHelpers {
  readonly keyName: (code: number) => string;
  readonly getKeyboardMap: () => KeyMap;
  readonly invertKeyMap: (map: KeyMap) => { readonly [bit: string]: number };
  readonly getGamepadBindingName: (bit: number, profile: GamepadProfile | null) => string;
}
const PUBLIC_API_LINE = '  window.ControllerSettings = {';
const OLD_SCRIPT_WITH_HELPERS = new vm.Script(
  OLD_SCRIPT.replace(
    PUBLIC_API_LINE,
    `  window.oldHelpers = { keyName, getKeyboardMap, invertKeyMap, getGamepadBindingName };\n${PUBLIC_API_LINE}`,
  ),
);

// ── a fake page ──────────────────────────────────────────────────────────────

type FakeStyle = { [property: string]: string };
/** What a cell remembers while it listens. */
type FakeDataset = { prevText?: string };
type FakeEvent = { readonly target: FakeElement };
type FakeChild = FakeElement | FakeText;

class FakeText {
  nodeValue: string;
  constructor(text: string) {
    this.nodeValue = text;
  }
}

/** A ring or dot of a stick drawing: found by class, and only its attributes are written. */
class FakePart {
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeElement {
  readonly tag: string;
  className = '';
  value?: string;
  checked?: boolean;
  readonly style: FakeStyle = {};
  readonly dataset: FakeDataset = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  readonly parts = new Map<string, FakePart>();
  children: FakeChild[] = [];
  parent: FakeElement | null = null;
  markup = '';
  readonly classList = {
    add: (name: string): void => {
      if (!this.classNames().includes(name)) this.className = [...this.classNames(), name].join(' ');
    },
    remove: (name: string): void => {
      this.className = this.classNames()
        .filter((n) => n !== name)
        .join(' ');
    },
  };

  constructor(tag: string) {
    this.tag = tag;
  }

  classNames(): string[] {
    return this.className.split(' ').filter((n) => n !== '');
  }

  get textContent(): string | null {
    return this.children.map((c) => (c instanceof FakeText ? c.nodeValue : c.textContent)).join('');
  }

  set textContent(text: string | null) {
    this.children = text ? [new FakeText(text)] : [];
  }

  get innerHTML(): string {
    return this.markup;
  }

  set innerHTML(markup: string) {
    this.markup = markup;
    this.children = [];
    this.parts.clear();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'value') this.value = value;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  appendChild(child: FakeChild): void {
    if (child instanceof FakeElement) {
      child.remove();
      child.parent = this;
    }
    this.children.push(child);
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  /** A part of the drawing set as innerHTML, when the markup has an element of that class. */
  querySelector(selector: string): FakePart | null {
    if (!this.markup.includes(`class="${selector.slice(1)}"`)) return null;
    const part = this.parts.get(selector) ?? new FakePart();
    this.parts.set(selector, part);
    return part;
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }

  /** Every element under this one, in document order. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.descendants()] : []));
  }
}

/** Everything about an element a player or a test could see. */
type Shot =
  | string
  | {
      readonly tag: string;
      readonly className: string;
      readonly attributes: readonly (readonly [string, string])[];
      readonly style: FakeStyle;
      readonly prevText: string | null;
      readonly value: string | null;
      readonly checked: boolean | null;
      readonly markup: string;
      readonly parts: readonly (readonly [string, readonly (readonly [string, string])[]])[];
      readonly listens: readonly string[];
      readonly children: readonly Shot[];
    };

const shot = (node: FakeChild): Shot =>
  node instanceof FakeText
    ? node.nodeValue
    : {
        tag: node.tag,
        className: node.className,
        attributes: [...node.attributes],
        style: { ...node.style },
        prevText: node.dataset.prevText ?? null,
        value: node.value ?? null,
        checked: node.checked ?? null,
        markup: node.markup,
        parts: [...node.parts].map(([selector, part]) => [selector, [...part.attributes]]),
        listens: [...node.listeners.keys()],
        children: node.children.map(shot),
      };

type KeyPress = {
  readonly key: string;
  readonly keyCode: number;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
};
type KeyListener = (event: KeyPress) => void;

type FakePad = { axes: number[]; buttons: { pressed: boolean }[] };
type ActivePad = { readonly id: string; readonly profileName: string; profile: GamepadProfile };
type Settings = {
  range: number;
  sensitivity: number;
  deadzones: { lx: number; ly: number; cx: number; cy: number };
};

interface PageOptions {
  readonly saved?: readonly (readonly [string, string])[];
  readonly active?: ActivePad | null;
  readonly romHash?: string | null;
  readonly ownToast?: boolean;
  readonly switch2?: boolean;
  readonly storageBlocked?: boolean;
}

/** A page with a pad, storage, the other scripts' globals, and queues the test runs by hand. */
const page = (options: PageOptions = {}) => {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const stored = new Map<string, string>(options.saved ?? []);
  /** What the panel asked the other scripts to do, in order. */
  const calls: string[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const timers: (() => void)[] = [];
  const keyListeners: KeyListener[] = [];
  const padListeners: (() => void)[] = [];
  const pads: (FakePad | null)[] = [];
  const settings: Settings = { range: 66, sensitivity: 1, deadzones: { lx: 0.15, ly: 0.15, cx: 0.15, cy: 0.15 } };
  const state = {
    active: options.active === undefined ? null : options.active && structuredClone(options.active),
    assigned: options.active ? 0 : null,
    confirmAnswer: true,
  };
  const blocked = (): never => {
    throw new Error('blocked');
  };

  const localStorage = {
    getItem: (key: string): string | null => (options.storageBlocked ? blocked() : (stored.get(key) ?? null)),
    setItem: (key: string, value: string): void => {
      stored.set(key, String(value));
    },
    removeItem: (key: string): void => {
      stored.delete(key);
    },
  };

  const GamepadManager = {
    getAssignments: () => (state.assigned === null ? {} : { 0: { gamepadIndex: state.assigned } }),
    getActiveProfile: (slot: number) => (slot === 0 ? state.active : null),
    saveGamepadProfile: (gamepadId: string, profile: GamepadProfile): void => {
      const text = JSON.stringify(profile);
      calls.push(`save ${gamepadId} ${text}`);
      // As gamepad-manager.js does: what was saved is read back and decoded.
      const decoded = decodeGamepadProfile(JSON.parse(text));
      if (state.active && state.active.id === gamepadId && decoded) state.active.profile = decoded;
    },
    clearGamepadProfile: (gamepadId: string): void => {
      calls.push(`clear ${gamepadId}`);
    },
    getCurrentSettings: () => settings,
    setSetting: (key: string, value: number, scope: 'game' | 'global'): void => {
      calls.push(`set ${key} ${String(value)} ${scope}`);
      if (key === 'kn-analog-range') settings.range = value;
      if (key === 'kn-analog-sensitivity') settings.sensitivity = value;
      if (key === 'kn-deadzone-lx') settings.deadzones.lx = value;
      if (key === 'kn-deadzone-cx') settings.deadzones.cx = value;
    },
    axisTransform: (_profile: GamepadProfile, name: string) => (raw: number, center: number) =>
      (raw - center) * (name === 'ly' ? -1 : 1),
    axisCenter: (gamepadIndex: number, axisIndex: number): number => (gamepadIndex + axisIndex) / 100,
    displayName: (id: string): string => `Pad ${id}`,
  };

  const APISandbox = {
    nativeRAF: (callback: () => void): number => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    nativeCancelRAF: (id: number): void => {
      frames.delete(id);
    },
    nativeGetGamepads: () => pads,
  };

  const document = {
    head,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_namespace: string, name: string) => new FakeElement(name),
    createTextNode: (text: string) => new FakeText(text),
    addEventListener: (_type: 'keydown', listener: KeyListener, _capture: boolean): void => {
      keyListeners.push(listener);
    },
    removeEventListener: (_type: 'keydown', listener: KeyListener, _capture: boolean): void => {
      const at = keyListeners.indexOf(listener);
      if (at >= 0) keyListeners.splice(at, 1);
    },
  };

  const host: ControllerSettingsHost & { ControllerSettings?: ControllerSettingsPanel; oldHelpers?: OldHelpers } = {
    document,
    localStorage,
    addEventListener: (_type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void => {
      padListeners.push(listener);
    },
    setTimeout: (callback: () => void, _ms: number): void => {
      timers.push(callback);
    },
    confirm: (message: string): boolean => {
      calls.push(`confirm ${message}`);
      return state.confirmAnswer;
    },
    GamepadManager,
    APISandbox,
    KNShared: { DEFAULT_N64_KEYMAP: { 67: 0, 88: 1, 13: 3, 86: 3, 38: 4, 40: 5, 68: 16, 65: 17, 74: 20, 73: 23 } },
    KNState: { remapActive: false, romHash: options.romHash ?? null },
    NetplayRollback: { refreshKeyMap: () => calls.push('refreshKeyMap') },
    _startIngameRemap: () => calls.push('startIngameRemap'),
    showToast: options.ownToast ? undefined : (message: string) => calls.push(`toast ${message}`),
    Switch2USB: options.switch2 ? { isSupported: () => true } : undefined,
  };

  return { host, head, body, stored, calls, frames, timers, keyListeners, padListeners, pads, state, settings };
};

type Page = ReturnType<typeof page>;

const startOld = (fake: Page): ControllerSettingsPanel => {
  const window = fake.host;
  OLD_SCRIPT_WITH_HELPERS.runInNewContext({
    window,
    document: window.document,
    localStorage: window.localStorage,
    setTimeout: window.setTimeout,
    confirm: window.confirm,
    get GamepadManager() {
      return window.GamepadManager;
    },
    get APISandbox() {
      return window.APISandbox;
    },
    get KNShared() {
      return window.KNShared;
    },
    get KNState() {
      return window.KNState;
    },
  });
  assert.ok(window.ControllerSettings, 'the old script did not define window.ControllerSettings');
  return window.ControllerSettings;
};

/** As web/static/controller-settings.js starts it. */
const startNew = (fake: Page): ControllerSettingsPanel => {
  fake.host.ControllerSettings = startControllerSettings(fake.host);
  return fake.host.ControllerSettings;
};

/** Everything the panel has done to its page. */
const visible = (fake: Page) => ({
  head: shot(fake.head),
  body: shot(fake.body),
  stored: [...fake.stored],
  calls: [...fake.calls],
  remapActive: fake.host.KNState?.remapActive,
  frames: fake.frames.size,
  timers: fake.timers.length,
  keyListeners: fake.keyListeners.length,
});

// ── what a player can do ─────────────────────────────────────────────────────

const withClass = (fake: Page, name: string): FakeElement[] =>
  fake.body.descendants().filter((e) => e.classNames().includes(name));
const withTag = (fake: Page, tag: string): FakeElement[] => fake.body.descendants().filter((e) => e.tag === tag);

type Step =
  | { readonly kind: 'open' | 'close' | 'toggle' | 'refreshGrid' | 'quickSetup' }
  | { readonly kind: 'frame' | 'timers' | 'perGame' | 'done' | 'backdrop' }
  | { readonly kind: 'cell'; readonly index: number }
  | { readonly kind: 'button'; readonly text: string }
  | { readonly kind: 'key'; readonly key: string; readonly keyCode: number }
  | { readonly kind: 'slider'; readonly index: number; readonly value: string }
  | { readonly kind: 'pads'; readonly pads: readonly (FakePad | null)[] }
  | { readonly kind: 'reset'; readonly confirm: boolean }
  | { readonly kind: 'padChange'; readonly active: ActivePad | null }
  | { readonly kind: 'romHash'; readonly hash: string | null };

/** Do one thing on a page. Returns what the step itself reported, for the two pages to agree on. */
const apply = (fake: Page, panel: ControllerSettingsPanel, step: Step): string => {
  switch (step.kind) {
    case 'open':
      panel.open();
      return '';
    case 'close':
      panel.close();
      return '';
    case 'toggle':
      panel.toggle();
      return '';
    case 'refreshGrid':
      panel._refreshGrid();
      return '';
    case 'quickSetup':
      panel.startQuickSetup();
      return '';
    case 'frame':
      // One animation frame: every callback asked for before it runs once.
      for (const [id, callback] of Array.from(fake.frames)) {
        if (!fake.frames.delete(id)) continue;
        callback();
      }
      return '';
    case 'timers':
      for (const callback of fake.timers.splice(0)) callback();
      return '';
    case 'perGame': {
      const checkbox = withTag(fake, 'input').find((e) => e.attributes.get('type') === 'checkbox');
      if (checkbox) checkbox.checked = !checkbox.checked;
      return String(checkbox?.checked);
    }
    case 'done':
      withClass(fake, 'cs-quick-btn')
        .find((e) => e.textContent === 'Done')
        ?.fire('click');
      return '';
    case 'backdrop':
      for (const e of fake.body.descendants()) if (e.attributes.get('id') === 'cs-backdrop') e.fire('click');
      return '';
    case 'cell':
      withClass(fake, 'cs-map-bind')[step.index]?.fire('click');
      return '';
    case 'button':
      withTag(fake, 'button')
        .find((e) => e.textContent === step.text)
        ?.fire('click');
      return '';
    case 'key': {
      let prevented = 0;
      let stopped = 0;
      const event = {
        key: step.key,
        keyCode: step.keyCode,
        preventDefault: () => prevented++,
        stopPropagation: () => stopped++,
      };
      // A listener removed by an earlier one does not hear the event.
      for (const listener of Array.from(fake.keyListeners)) if (fake.keyListeners.includes(listener)) listener(event);
      return `${prevented} ${stopped}`;
    }
    case 'slider': {
      const slider = withTag(fake, 'input').filter((e) => e.attributes.get('type') === 'range')[step.index];
      if (slider) {
        slider.value = step.value;
        slider.fire('input');
      }
      return '';
    }
    case 'pads':
      fake.pads.splice(0, fake.pads.length, ...structuredClone(step.pads));
      return '';
    case 'reset':
      fake.state.confirmAnswer = step.confirm;
      withClass(fake, 'cs-footer-reset')[0]?.fire('click');
      return '';
    case 'padChange':
      fake.state.active = step.active && structuredClone(step.active);
      fake.state.assigned = step.active ? 0 : null;
      for (const listener of fake.padListeners) listener();
      return '';
    case 'romHash':
      if (fake.host.KNState) fake.host.KNState.romHash = step.hash;
      return '';
  }
};

// ── random inputs ────────────────────────────────────────────────────────────

/** A small seeded generator, so a failure names inputs that can be run again. */
const seeded = (seed: number) => {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  const pick = <T>(items: readonly [T, ...T[]]): T => items[int(items.length)] ?? items[0];
  return { next, int, pick };
};
type Random = ReturnType<typeof seeded>;

const BITS = N64_BUTTONS.map((b) => b.bit);

const randomMask = (random: Random): number => {
  const roll = random.int(10);
  if (roll === 0) return 0;
  if (roll === 1) return (1 << (BITS[random.int(BITS.length)] ?? 0)) | (1 << (BITS[random.int(BITS.length)] ?? 0));
  return 1 << (BITS[random.int(BITS.length)] ?? 0);
};

/** The `bits` of a stick in a stored profile: missing, null, or a list of any length. */
type StickBits = { bits?: number[] | null };

const randomBits = (random: Random): StickBits => {
  const roll = random.int(8);
  if (roll === 0) return {};
  if (roll === 1) return { bits: null };
  if (roll === 2) return { bits: [] };
  if (roll === 3) return { bits: [16 + random.int(4)] };
  return { bits: [16 + random.int(4), 16 + random.int(4)] };
};

/** A profile as gamepad-manager.js hands one over: built in, or decoded from storage. */
const randomProfile = (random: Random): GamepadProfile => {
  const buttons = Object.fromEntries(
    Array.from({ length: random.int(12) }, () => [String(random.int(17)), randomMask(random)]),
  );
  const stick = () => ({ index: random.int(6), ...randomBits(random) });
  const sticks = [
    ...(random.int(4) > 0 ? [['stickX', stick()] as const] : []),
    ...(random.int(4) > 0 ? [['stickY', stick()] as const] : []),
  ];
  if (random.int(2) === 0) sticks.reverse();
  const axisButtons = Object.fromEntries(
    Array.from({ length: random.int(4) }, () => [
      String(random.int(6)),
      { pos: randomMask(random), neg: randomMask(random) },
    ]),
  );
  const fields: (readonly [string, Schema.Json])[] = [];
  if (random.int(2) === 0) fields.push(['name', 'Custom']);
  fields.push(['buttons', buttons]);
  if (random.int(6) > 0) fields.push(['axes', random.int(8) === 0 ? null : Object.fromEntries(sticks)]);
  if (random.int(5) > 0) fields.push(['axisButtons', random.int(8) === 0 ? null : axisButtons]);
  if (random.int(3) === 0) fields.push(['axisRange', 0.8], ['axisCenter', 'auto']);
  if (random.int(2) === 0) fields.push(['deadzone', 0.15]);
  const candidate = Object.fromEntries(fields);
  const profile = decodeGamepadProfile(candidate);
  assert.ok(profile, `the generator made a profile the decoder refuses: ${JSON.stringify(candidate)}`);
  return profile;
};

const randomPad = (random: Random): FakePad => ({
  axes: Array.from({ length: random.int(7) }, () =>
    random.int(3) === 0 ? 0 : Math.round(random.next() * 200 - 100) / 100,
  ),
  buttons: Array.from({ length: random.int(18) }, () => ({ pressed: random.int(12) === 0 })),
});

const randomActive = (random: Random): ActivePad | null =>
  random.int(5) === 0
    ? null
    : {
        id: random.pick(['045e-0b13-Xbox Wireless Controller', 'x'.repeat(50), 'Raphnet']),
        profileName: random.pick(['Standard', 'Custom', 'Switch 2 Pro']),
        profile: randomProfile(random),
      };

/** Saved keyboard mappings: usable ones, and every kind of junk the old script could meet. */
const SAVED_KEY_MAPS = [
  null,
  '',
  'x',
  '{',
  '0',
  '5',
  '-1',
  'true',
  'false',
  'null',
  '""',
  '"abc"',
  '[]',
  '[3,4]',
  '[null,5,"x",[1],{"a":1}]',
  '{}',
  '{"65":0}',
  '{"65":0,"66":1,"13":3,"90":12,"74":20}',
  '{"65":"0","66":"1"}',
  '{"a":1}',
  '{"a":1,"b":2,"70":3}',
  '{"12abc":3,"-5":2,"1.9":4,"x":7}',
  '{"x":7,"-5":2,"12abc":3}',
  '{"__proto__":3}',
  '{"__proto__":{"65":3},"66":1}',
  '{"65":null,"66":{"x":1},"67":[1],"68":true,"69":1.5}',
  '{"65":0,"065":1}',
  '{"065":1,"65":0}',
  '{"NaN":1,"x":2}',
  '{" 7":1}',
  '{"1e3":2}',
  '{"0x10":1}',
  '{"65":0,"66":0}',
  '{"65":16,"66":16,"67":17}',
  '{"4294967296":1,"70":2}',
  '{"constructor":1,"toString":2}',
  '{"65":[16],"66":"16","67":16}',
  ' {"65":0} ',
  '{"65":0}x',
] as const;

const randomStep = (random: Random): Step => {
  const roll = random.int(30);
  if (roll < 3) return { kind: 'open' };
  if (roll < 4) return { kind: 'close' };
  if (roll < 5) return { kind: 'toggle' };
  if (roll < 9) return { kind: 'cell', index: random.int(N64_BUTTONS.length * 2 + 1) };
  if (roll < 12) {
    return random.int(6) === 0
      ? { kind: 'key', key: 'Escape', keyCode: 27 }
      : { kind: 'key', key: 'k', keyCode: random.pick([65, 66, 67, 13, 88, 90, 70, 71, 0, 255]) };
  }
  if (roll < 16)
    return {
      kind: 'pads',
      pads: Array.from({ length: random.int(3) }, () => (random.int(4) === 0 ? null : randomPad(random))),
    };
  if (roll < 20) return { kind: 'frame' };
  if (roll < 22) {
    return {
      kind: 'slider',
      index: random.int(6),
      value: random.pick(['10', '66', '100', '50', '200', '0', '37', '', 'x', '12.7']),
    };
  }
  if (roll < 23) return { kind: 'perGame' };
  if (roll < 24) return { kind: 'reset', confirm: random.int(3) > 0 };
  if (roll < 25) return { kind: random.pick(['done', 'backdrop', 'refreshGrid', 'quickSetup']) };
  if (roll < 26) return { kind: 'button', text: random.pick(['×', 'Quick Setup ▸']) };
  if (roll < 28) return { kind: 'padChange', active: randomActive(random) };
  if (roll < 29) return { kind: 'timers' };
  return { kind: 'romHash', hash: random.pick([null, 'abc123', '']) };
};

/** Run the same steps on an old page and a new one, comparing after each. Returns what the panel asked of the other scripts. */
const compareRuns = (options: PageOptions, steps: readonly Step[], label: string): readonly string[] => {
  const oldPage = page(options);
  const newPage = page(options);
  const oldPanel = startOld(oldPage);
  const newPanel = startNew(newPage);
  assert.deepEqual(visible(newPage), visible(oldPage), `${label}: at the start`);
  for (const [at, step] of steps.entries()) {
    const context = `${label}: after step ${at} of ${JSON.stringify(steps.slice(0, at + 1))}`;
    assert.equal(apply(newPage, newPanel, step), apply(oldPage, oldPanel, step), context);
    assert.deepEqual(visible(newPage), visible(oldPage), context);
  }
  return newPage.calls;
};

// ── the panel as a whole ─────────────────────────────────────────────────────

test('random sessions leave the page, storage and the other scripts as the old script left them', () => {
  const seen = new Map<string, number>();
  for (let seed = 1; seed <= 300; seed++) {
    const random = seeded(seed);
    const options: PageOptions = {
      saved: [
        ...SAVED_KEY_MAPS.slice(random.int(SAVED_KEY_MAPS.length))
          .slice(0, 1)
          .flatMap((saved) => (saved === null ? [] : [['keyboard-mapping', saved] as const])),
        ...(random.int(3) === 0 ? [['kn-gamepad:abc123:kn-analog-range', '80'] as const] : []),
        ...(random.int(3) === 0 ? [['kn-analog-range', '70'] as const, ['unrelated', 'kept'] as const] : []),
      ],
      active: randomActive(random),
      romHash: random.pick([null, 'abc123']),
      switch2: random.int(4) === 0,
    };
    const calls = compareRuns(
      options,
      Array.from({ length: 40 }, () => randomStep(random)),
      `seed ${seed}`,
    );
    for (const call of calls) {
      const kind = call.split(' ')[0] ?? '';
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
  }
  // The sessions did reach every way the panel has of changing something.
  for (const kind of ['save', 'set', 'clear', 'confirm', 'refreshKeyMap', 'toast', 'startIngameRemap']) {
    assert.ok((seen.get(kind) ?? 0) >= 20, `only ${seen.get(kind) ?? 0} "${kind}" calls in all sessions`);
  }
});

test('the markup of a just-opened panel is the old script’s, with and without a pad', () => {
  const random = seeded(7);
  const states: PageOptions[] = [
    {},
    { switch2: true, romHash: 'abc123', saved: [['kn-gamepad:abc123:kn-analog-range', '80']] },
    { active: { id: 'Xbox Wireless Controller', profileName: 'Standard', profile: randomProfile(random) } },
    { active: { id: 'y'.repeat(60), profileName: 'Custom', profile: randomProfile(random) }, switch2: true },
    { saved: [['keyboard-mapping', '{"65":0,"66":1,"112":3,"97":4,"222":5,"1":6}']] },
  ];
  for (const options of states) compareRuns(options, [{ kind: 'open' }, { kind: 'frame' }], JSON.stringify(options));

  const fake = page();
  startNew(fake).open();
  assert.equal(fake.head.children.length, 1);
  assert.equal(fake.head.descendants()[0]?.textContent, PANEL_CSS);
  const ids = fake.body.descendants().flatMap((e) => e.attributes.get('id') ?? []);
  assert.deepEqual(ids, ['cs-backdrop', 'controller-settings']);
  const drawings = withTag(fake, 'svg').map((e) => e.markup);
  assert.deepEqual(drawings, [LEFT_STICK_SVG, C_STICK_SVG]);
  assert.equal(withClass(fake, 'cs-map-bind').length, N64_BUTTONS.length * 2);
});

test('every rebind of a pad button or axis saves the profile the old script saved', () => {
  let saves = 0;
  for (let seed = 1; seed <= 1200; seed++) {
    const random = seeded(seed + 10_000);
    const active = { id: 'pad', profileName: 'Standard', profile: randomProfile(random) };
    const row = random.int(N64_BUTTONS.length);
    const held = randomPad(random);
    const pushed = randomPad(random);
    if (random.int(2) === 0) pushed.buttons = pushed.buttons.map(() => ({ pressed: false }));
    const steps: Step[] = [
      { kind: 'pads', pads: [held] },
      { kind: 'open' },
      { kind: 'cell', index: row * 2 },
      { kind: 'frame' },
      { kind: 'pads', pads: random.int(5) === 0 ? [null, pushed] : [pushed] },
      { kind: 'frame' },
      { kind: 'frame' },
    ];
    compareRuns({ active }, steps, `seed ${seed}`);

    // The same answer from the pure functions alone.
    const bit = N64_BUTTONS[row]?.bit ?? 0;
    const captured = capturedInput(bit, pushed.buttons, pushed.axes, held.axes);
    const check = page({ active });
    const panel = startNew(check);
    for (const step of steps) apply(check, panel, step);
    const saved = check.calls.filter((call) => call.startsWith('save '));
    const firstFrame = capturedInput(bit, held.buttons, held.axes, held.axes);
    if (firstFrame === null) {
      assert.deepEqual(
        saved,
        captured ? [`save pad ${JSON.stringify(profileAfterCapture(active.profile, bit, captured))}`] : [],
      );
    }
    saves += saved.length;
  }
  assert.ok(saves > 400, `only ${saves} of the runs saved a profile`);
});

test('every rebind of a key saves the mapping the old script saved, from any saved text', () => {
  for (const saved of SAVED_KEY_MAPS) {
    for (const row of [0, 2, 13, 17]) {
      for (const keyCode of [65, 66, 70]) {
        const options = { saved: saved === null ? [] : [['keyboard-mapping', saved] as const] };
        const steps: Step[] = [
          { kind: 'open' },
          { kind: 'cell', index: row * 2 + 1 },
          { kind: 'key', key: 'k', keyCode },
          { kind: 'cell', index: 3 },
          { kind: 'key', key: 'k', keyCode: 66 },
        ];
        compareRuns(options, steps, `${saved} row ${row} key ${keyCode}`);
      }
    }
  }
});

test('with storage blocked the panel opens on the default keys, as the old script did', () => {
  compareRuns({ storageBlocked: true }, [{ kind: 'open' }, { kind: 'frame' }, { kind: 'close' }], 'blocked');
  // With a game loaded the old script read the per-game key outside any try, and so does this.
  const steps: Step[] = [{ kind: 'open' }];
  const oldPage = page({ storageBlocked: true, romHash: 'abc123' });
  const newPage = page({ storageBlocked: true, romHash: 'abc123' });
  const oldPanel = startOld(oldPage);
  const newPanel = startNew(newPage);
  for (const step of steps) {
    assert.throws(() => apply(oldPage, oldPanel, step), /blocked/);
    assert.throws(() => apply(newPage, newPanel, step), /blocked/);
  }
  assert.deepEqual(visible(newPage), visible(oldPage));
});

test('without play.js’s toast, Done shows the panel’s own for 1.5 s and removes it 0.3 s after it fades', async () => {
  const oldPage = page({ ownToast: true });
  const newPage = page({ ownToast: true });
  const oldPanel = startOld(oldPage);
  const newPanel = startNew(newPage);
  for (const step of [{ kind: 'open' }, { kind: 'done' }] satisfies Step[]) {
    apply(oldPage, oldPanel, step);
    apply(newPage, newPanel, step);
  }
  const toast = (fake: Page) =>
    fake.body.children.map(shot).filter((s) => typeof s !== 'string' && s.style['zIndex'] === '200');
  assert.equal(toast(oldPage).length, 1);
  assert.deepEqual(toast(newPage), toast(oldPage));

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = Date.now();
  // The old script's first timer: fade.
  apply(oldPage, oldPanel, { kind: 'timers' });
  await pause(1200);
  assert.equal(newPage.body.children.length, 3, 'the toast went before its 1.5 s were up');
  assert.notDeepEqual(toast(newPage), toast(oldPage), 'the toast faded before its 1.5 s were up');
  while (toast(newPage).length === 1 && JSON.stringify(toast(newPage)) !== JSON.stringify(toast(oldPage))) {
    assert.ok(Date.now() - started < 5000, 'the toast never faded');
    await pause(10);
  }
  assert.ok(Date.now() - started >= 1500);
  assert.deepEqual(toast(newPage), toast(oldPage));
  // The old script's second timer: remove.
  apply(oldPage, oldPanel, { kind: 'timers' });
  const faded = Date.now();
  while (toast(newPage).length === 1) {
    assert.ok(Date.now() - faded < 5000, 'the toast was never removed');
    await pause(10);
  }
  assert.ok(Date.now() - faded >= 250);
  assert.deepEqual(visible(newPage).body, visible(oldPage).body);
});

test('the panel keeps every member the old object had', () => {
  const oldPanel = startOld(page());
  const newPanel = startNew(page());
  assert.deepEqual(Object.keys(newPanel), Object.keys(oldPanel));
  assert.deepEqual(Object.keys(newPanel), ['open', 'close', 'toggle', 'startQuickSetup', '_refreshGrid']);
});

// ── the pure functions against the old script's own ──────────────────────────

const oldHelpers = (fake: Page): OldHelpers => {
  startOld(fake);
  assert.ok(fake.host.oldHelpers);
  return fake.host.oldHelpers;
};

test('saved keyboard text is read as the old script read it, junk included', () => {
  for (const saved of SAVED_KEY_MAPS) {
    const fake = page({ saved: saved === null ? [] : [['keyboard-mapping', saved]] });
    const old = oldHelpers(fake);
    const defaults = fake.host.KNShared?.DEFAULT_N64_KEYMAP ?? {};
    const oldMap = old.getKeyboardMap();
    const newMap = savedKeyboardMap(saved) ?? { ...defaults };
    // As text, so the order of the keys is compared too: it is the order they are saved in.
    assert.equal(JSON.stringify(newMap), JSON.stringify(oldMap), `${saved}`);
    assert.equal(JSON.stringify(invertKeyMap(newMap)), JSON.stringify(old.invertKeyMap(oldMap)), `${saved}`);
    assert.deepEqual(Object.keys(invertKeyMap(newMap)), Object.keys(old.invertKeyMap(oldMap)), `${saved}`);
  }
});

test('what counts as no saved mapping', () => {
  for (const saved of [null, '', 'x', '{', '0', '5', 'true', 'false', 'null', '""', '[]', '{}', '{"65":0}x']) {
    assert.equal(savedKeyboardMap(saved), null, `${saved}`);
  }
  assert.deepEqual(savedKeyboardMap('{"65":0,"12abc":3,"x":"y"}'), { 65: 0, 12: 3, NaN: 'y' });
  assert.deepEqual(savedKeyboardMap('"ab"'), { 0: 'a', 1: 'b' });
  assert.deepEqual(savedKeyboardMap('[7,null]'), { 0: 7, 1: null });
});

test('binding a key takes it from its old input and clears the input’s old keys', () => {
  assert.deepEqual(keyMapWithKey({ 65: 0, 66: 1 }, 70, 0), { 66: 1, 70: 0 });
  assert.deepEqual(keyMapWithKey({ 65: 0, 66: 1 }, 66, 0), { 66: 0 });
  assert.deepEqual(keyMapWithKey({ 65: 0, 66: 0, 67: 2 }, 67, 0), { 67: 0 });
  // A saved value that is not a number is not that input's key, and stays.
  assert.deepEqual(keyMapWithKey({ 65: '0', 66: 1 }, 70, 0), { 65: '0', 66: 1, 70: 0 });
});

test('key codes are named as the old script named them', () => {
  const old = oldHelpers(page());
  for (let code = -2; code <= 300; code++) assert.equal(keyName(code), old.keyName(code), `${code}`);
  assert.equal(keyName(NaN), old.keyName(NaN));
});

test('pad bindings are named as the old script named them', () => {
  const old = oldHelpers(page());
  for (let seed = 1; seed <= 2000; seed++) {
    const profile = randomProfile(seeded(seed));
    for (const bit of BITS) {
      assert.equal(gamepadBindingName(bit, profile), old.getGamepadBindingName(bit, profile), JSON.stringify(profile));
    }
  }
  assert.equal(gamepadBindingName(0, null), old.getGamepadBindingName(0, null));
});

test('a stick the profile lists as null is skipped, where the old script threw', () => {
  const profile = decodeGamepadProfile({ buttons: {}, axes: { stickX: null, stickY: { index: 1, bits: [18, 19] } } });
  assert.ok(profile);
  const old = oldHelpers(page());
  assert.throws(() => old.getGamepadBindingName(19, profile));
  assert.equal(gamepadBindingName(19, profile), 'Axis1-');
  assert.deepEqual(profileAfterCapture(profile, 19, { kind: 'button', index: 4 }), {
    buttons: { 4: 1 << 19 },
    axes: { stickX: null },
  });
});

test('what a pad reading binds', () => {
  const up = [{ pressed: false }, { pressed: false }];
  assert.deepEqual(capturedInput(0, [{ pressed: false }, { pressed: true }, { pressed: true }], [1], []), {
    kind: 'button',
    index: 1,
  });
  // An axis does not bind a plain button.
  assert.equal(capturedInput(0, up, [1, -1], []), null);
  assert.deepEqual(capturedInput(16, up, [0.2, -0.9], []), { kind: 'axis', index: 1, positive: false });
  assert.deepEqual(capturedInput(23, up, [0.51], []), { kind: 'axis', index: 0, positive: true });
  // Exactly half way, or held there from the start, is not a push.
  assert.equal(capturedInput(16, up, [0.5], []), null);
  assert.equal(capturedInput(16, up, [0.9], [0.7]), null);
  assert.equal(capturedInput(16, up, [-0.75], [-0.5]), null);
  assert.deepEqual(capturedInput(16, up, [0.9], [0.5]), { kind: 'axis', index: 0, positive: true });
  assert.deepEqual(capturedInput(16, up, [0.9, -0.9], [0.9]), { kind: 'axis', index: 1, positive: false });
});

test('a captured input changes only the bit it was bound to', () => {
  const standard = decodeGamepadProfile({
    name: 'Standard',
    buttons: { 0: 1, 1: 2, 9: 8 },
    axes: { stickX: { index: 0, bits: [16, 17] }, stickY: { index: 1, bits: [18, 19] } },
    axisButtons: { 2: { pos: 1 << 21, neg: 1 << 20 }, 3: { pos: 1 << 22, neg: 1 << 23 } },
    deadzone: 0.15,
  });
  assert.ok(standard);
  // A to button 5: button 0 no longer presses A.
  assert.deepEqual(profileAfterCapture(standard, 0, { kind: 'button', index: 5 }).buttons, { 1: 2, 5: 1, 9: 8 });
  // Stick Up to a button: the Y axis that drove it goes.
  assert.deepEqual(profileAfterCapture(standard, 19, { kind: 'button', index: 5 }).axes, {
    stickX: { index: 0, bits: [16, 17] },
  });
  // Stick Left to axis 4 pushed negative: X is read from axis 4, right keeps bit 16.
  assert.deepEqual(profileAfterCapture(standard, 17, { kind: 'axis', index: 4, positive: false }).axes, {
    stickX: { index: 4, bits: [16, 17] },
    stickY: { index: 1, bits: [18, 19] },
  });
  // Stick Up to axis 1 pushed positive: the pad's +Y is up.
  assert.deepEqual(profileAfterCapture(standard, 19, { kind: 'axis', index: 1, positive: true }).axes?.stickY, {
    index: 1,
    bits: [19, 19],
  });
  // C-Up to axis 5 pushed positive: axis 3 loses it.
  assert.deepEqual(profileAfterCapture(standard, 23, { kind: 'axis', index: 5, positive: true }).axisButtons, {
    2: { pos: 1 << 21, neg: 1 << 20 },
    3: { pos: 1 << 22, neg: 0 },
    5: { pos: 1 << 23, neg: 0 },
  });
  // C-Right to a button: axis 2 keeps only C-Left.
  assert.deepEqual(profileAfterCapture(standard, 21, { kind: 'button', index: 7 }).axisButtons, {
    2: { pos: 0, neg: 1 << 20 },
    3: { pos: 1 << 22, neg: 1 << 23 },
  });
  // What was not touched is carried over.
  const after = profileAfterCapture(standard, 0, { kind: 'button', index: 5 });
  assert.equal(after.name, 'Standard');
  assert.equal(after.deadzone, 0.15);
});

test('slider positions are read, and settings shown, as the old script did', () => {
  // The old script's expressions, from its three onInput handlers and buildDzSlider.
  for (const position of ['10', '66', '100', '50', '200', '0', '37', '5', '', 'x', '12.7', ' 40', '-3', '1e2']) {
    assert.equal(rangeFromSlider(position), parseInt(position, 10));
    assert.equal(hundredthsFromSlider(position), parseInt(position, 10) / 100);
  }
  for (let hundredths = 0; hundredths <= 200; hundredths++) {
    const value = hundredths / 100;
    assert.equal(sliderHundredths(value), String(Math.round(value * 100)));
    assert.equal(hundredthsFromSlider(sliderHundredths(value)), value);
    assert.equal(deadzoneText(value), value.toFixed(2));
  }
});

test('the preview’s rings and percentages', () => {
  assert.equal(deadzoneRingRadius(56, 0.15), 8);
  assert.equal(deadzoneRingRadius(56, 0), 2);
  assert.equal(deadzoneRingRadius(36, 0.15), 5);
  assert.equal(rangeRingRadius(66), 37);
  assert.equal(rangeRingRadius(100), 56);
  assert.equal(percentText(0), '   0%');
  assert.equal(percentText(1), ' 100%');
  assert.equal(percentText(-1), '-100%');
  assert.equal(percentText(-0.5), '-50%');
  assert.equal(percentText(0.074), '   7%');
});

test('the C stick is read from the axes the profile names, or 2 and 3', () => {
  assert.deepEqual(cStickAxes(undefined), { cx: 2, cy: 3 });
  assert.deepEqual(cStickAxes(null), { cx: 2, cy: 3 });
  assert.deepEqual(cStickAxes({ 3: { pos: 1 << 21, neg: 1 << 20 }, 5: { pos: 1 << 23, neg: 1 << 22 } }), {
    cx: 3,
    cy: 5,
  });
  assert.deepEqual(cStickAxes({ 4: { pos: 1 << 20, neg: 0 } }), { cx: 4, cy: 3 });
  assert.deepEqual(cStickAxes({ 0: { pos: 0, neg: 1 << 22 }, 1: { pos: 1 << 22, neg: 0 } }), { cx: 2, cy: 1 });
});

test('Reset removes the analog settings, their per-game twins and the keyboard mapping, in order', () => {
  assert.deepEqual(resetStorageKeys(null), [
    'kn-analog-range',
    'kn-analog-sensitivity',
    'kn-deadzone-lx',
    'kn-deadzone-ly',
    'kn-deadzone-cx',
    'kn-deadzone-cy',
    'keyboard-mapping',
  ]);
  assert.deepEqual(resetStorageKeys('').length, 7);
  assert.deepEqual(resetStorageKeys('h').slice(0, 4), [
    'kn-analog-range',
    'kn-gamepad:h:kn-analog-range',
    'kn-analog-sensitivity',
    'kn-gamepad:h:kn-analog-sensitivity',
  ]);
  assert.equal(resetStorageKeys('h').length, 13);
});

// ── against the typed modules that already existed ───────────────────────────

test('the grid lists the remap wizard’s inputs, bit for bit and in its order', () => {
  assert.deepEqual(
    N64_BUTTONS.map((b) => b.bit),
    WIZARD_STEPS.map((s) => s.bit),
  );
});

test('the engine’s default keys are the wizard’s plus Enter for Start', () => {
  // The panel takes its defaults from shared.js (the engine's), not from the
  // wizard's table: they differ by one key, and this pins which.
  const source = readFileSync(new URL('../../web/static/shared.js', import.meta.url), 'utf8');
  const table = /const DEFAULT_N64_KEYMAP = \{([^}]*)\}/.exec(source)?.[1] ?? '';
  const engine = Object.fromEntries([...table.matchAll(/(\d+): (\d+),/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(engine, { ...DEFAULT_KEY_MAP, 13: 3 });
});

test('a real window satisfies the host the panel asks for', () => {
  const accepts = (host: ControllerSettingsHost): ControllerSettingsHost => host;
  const check = (win: Window): ControllerSettingsHost => accepts(win);
  assert.equal(typeof check, 'function');
});
