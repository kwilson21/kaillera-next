import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { Schema } from 'effect';
import type { PageState } from '../../web/src/kn-state.ts';
import {
  buttonIndex,
  buttonPlace,
  BUTTONS,
  cornerRadius,
  pointNearButton,
  pointOnButton,
  slideChange,
  SLOP_PX,
} from '../../web/src/page/virtual-gamepad/buttons.ts';
import {
  type PadElement,
  type PadTouch,
  type PadTouchEvent,
  startVirtualGamepad,
  type VirtualGamepad,
} from '../../web/src/page/virtual-gamepad/gamepad.ts';
import { OVERLAY_HTML, OVERLAY_ID } from '../../web/src/page/virtual-gamepad/markup.ts';
import {
  type Box,
  DEADZONE,
  KNOB_AT_REST,
  knobTransform,
  MAX_AXIS,
  originOffset,
  type Point,
  STICK_DOWN,
  STICK_LEFT,
  stickOrigin,
  STICK_RADIUS,
  stickReading,
  STICK_RIGHT,
  STICK_UP,
} from '../../web/src/page/virtual-gamepad/stick.ts';

// The touch controls write `KNState.touchInput`, which the engines read every
// frame, so the TypeScript is held to the script it replaced: both run on the
// same fake page, are given the same touches, and must leave the same values
// and the same page after every one.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/virtual-gamepad.js as of #166, unchanged.
const OLD_SCRIPT = readFileSync(new URL('./fixtures/virtual-gamepad.old.js', import.meta.url), 'utf8');

type TouchValues = PageState['touchInput'];

/** The old script's own helpers, handed out of its closure so they can be called one at a time. */
interface OldHelpers {
  readonly hitTestBtn: (button: FakeElement, x: number, y: number) => boolean;
  readonly hitTestBtnSlop: (button: FakeElement, x: number, y: number, slop: number) => boolean;
  readonly updateStick: (clientX: number, clientY: number) => void;
  readonly setStick: (center: Point, knob: FakeElement) => void;
}
const PUBLIC_API_LINE = '  window.VirtualGamepad = {';
const HELPERS_LINE =
  '  window.oldHelpers = { hitTestBtn, hitTestBtnSlop, updateStick, setStick: (center, knob) => { _stickCenter = center; _stickEl = knob; } };';
assert.ok(OLD_SCRIPT.includes(PUBLIC_API_LINE));
const OLD_SCRIPT_WITH_HELPERS = new vm.Script(
  OLD_SCRIPT.replace(PUBLIC_API_LINE, `${HELPERS_LINE}\n${PUBLIC_API_LINE}`),
);

// ── where a browser puts the controls ────────────────────────────────────────
// The layout is all CSS, so a fake page cannot work it out. These are the
// boxes Chromium gave tests/vgp-test.html at each screen size: the sixteen
// buttons in document order (Z and Start twice; the hidden copy has no size)
// with their computed corner radius, and the stick zone.
const BoxSchema = Schema.Struct({
  left: Schema.Number,
  top: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const LayoutSchema = Schema.Struct({
  name: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  buttons: Schema.Array(Schema.Struct({ ...BoxSchema.fields, radius: Schema.String })),
  stick: BoxSchema,
});
type Layout = typeof LayoutSchema.Type;
const LAYOUTS = Schema.decodeUnknownSync(Schema.Array(LayoutSchema))(
  JSON.parse(readFileSync(new URL('./fixtures/virtual-gamepad.layouts.json', import.meta.url), 'utf8')),
);

const NO_BOX: Box = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const boxFrom = (measured: typeof BoxSchema.Type): Box => ({
  left: measured.left,
  top: measured.top,
  right: measured.left + measured.width,
  bottom: measured.top + measured.height,
  width: measured.width,
  height: measured.height,
});
const inBox = (box: Box, x: number, y: number): boolean =>
  box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

// ── a fake page ──────────────────────────────────────────────────────────────

type Listener = (event: PadTouchEvent) => void;
type TouchType = 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel';

/** `data-idx`, kept as text whatever is assigned: the old script assigns a number. */
class FakeDataset {
  #idx: string | undefined = undefined;
  get idx(): string | undefined {
    return this.#idx;
  }
  set idx(value: string | undefined) {
    this.#idx = value === undefined ? undefined : String(value);
  }
}

class FakeStyle {
  display = '';
  margin = '';
  transform = '';
  flex = '';
}

/** One element as a snapshot shows it. */
interface ElementView {
  readonly tag: string;
  readonly id: string;
  readonly className: string;
  readonly text: string;
  readonly idx: string | undefined;
  readonly style: FakeStyle;
  readonly listeners: readonly string[];
  readonly box: Box;
  readonly radius: string;
  readonly children: readonly ElementView[];
}

class FakeElement implements PadElement {
  readonly page: FakePage;
  readonly tag: string;
  id = '';
  className = '';
  text = '';
  /** What was last assigned to innerHTML, compared as a whole. */
  markup = '';
  readonly dataset = new FakeDataset();
  readonly style = new FakeStyle();
  readonly listeners: { type: TouchType; listener: Listener; passive: boolean }[] = [];
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;

  constructor(page: FakePage, tag: string) {
    this.page = page;
    this.tag = tag;
  }

  readonly classList = {
    toggle: (name: string, force: boolean): boolean => {
      const names = this.className.split(' ').filter((n) => n !== '' && n !== name);
      if (force) names.push(name);
      this.className = names.join(' ');
      return force;
    },
  };

  get textContent(): string | null {
    return this.text;
  }

  set textContent(value: string | null) {
    this.text = value ?? '';
    this.children = [];
  }

  get innerHTML(): string {
    return this.markup;
  }

  /** The controls' frame is `<style>` and `<div class>` only; anything else is refused. */
  set innerHTML(markup: string) {
    this.markup = markup;
    this.children = [];
    /** The elements still open, innermost last. */
    const open: FakeElement[] = [];
    const innermost = (): FakeElement => open.at(-1) ?? this;
    let rest = markup;
    while (rest.trim() !== '') {
      const style = /^\s*<style>([\s\S]*?)<\/style>/.exec(rest);
      const div = /^\s*<div class="([^"]*)">/.exec(rest);
      const close = /^\s*<\/div>/.exec(rest);
      if (style) {
        const element = new FakeElement(this.page, 'style');
        element.text = style[1] ?? '';
        innermost().appendChild(element);
        rest = rest.slice(style[0].length);
      } else if (div) {
        const element = new FakeElement(this.page, 'div');
        element.className = div[1] ?? '';
        innermost().appendChild(element);
        open.push(element);
        rest = rest.slice(div[0].length);
      } else if (close && open.length > 0) {
        open.pop();
        rest = rest.slice(close[0].length);
      } else {
        throw new Error(`fake page: markup it cannot read: ${rest.slice(0, 40)}`);
      }
    }
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  /** `.class` and `.class[data-idx="n"]` are the only selectors the controls use. */
  querySelectorAll(selector: string): FakeElement[] {
    const parts = /^\.([\w-]+)(?:\[data-idx="([^"]*)"\])?$/.exec(selector);
    if (!parts) throw new Error(`fake page: selector it cannot read: ${selector}`);
    const [, className, idx] = parts;
    return this.descendants().filter(
      (el) => el.className.split(' ').includes(className ?? '') && (idx === undefined || el.dataset.idx === idx),
    );
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  appendChild(child: FakeElement): void {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    this.page.treeChanged();
  }

  insertBefore(child: FakeElement, before: FakeElement): void {
    child.parentNode?.removeChild(child);
    const at = this.children.indexOf(before);
    assert.ok(at >= 0, 'insertBefore: the reference element is not a child');
    child.parentNode = this;
    this.children.splice(at, 0, child);
    this.page.treeChanged();
  }

  removeChild(child: FakeElement): void {
    assert.ok(this.children.includes(child), 'removeChild: not a child');
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    this.page.treeChanged();
  }

  cloneNode(deep: boolean): FakeElement {
    const copy = new FakeElement(this.page, this.tag);
    copy.id = this.id;
    copy.className = this.className;
    copy.text = this.text;
    copy.dataset.idx = this.dataset.idx;
    Object.assign(copy.style, this.style);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  getBoundingClientRect(): Box {
    this.page.reads.push('box');
    return this.page.boxOf(this);
  }

  addEventListener(type: TouchType, listener: Listener, options: { passive: boolean }): void {
    this.listeners.push({ type, listener, passive: options.passive });
  }

  removeEventListener(type: TouchType, listener: Listener): void {
    const at = this.listeners.findIndex((l) => l.type === type && l.listener === listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  view(): ElementView {
    return {
      tag: this.tag,
      id: this.id,
      className: this.className,
      text: this.tag === 'style' ? `${this.text.length} characters` : this.text,
      idx: this.dataset.idx,
      style: { ...this.style },
      listeners: this.listeners.map((l) => `${l.type} passive=${l.passive}`),
      box: this.page.boxOf(this),
      radius: this.page.radiusOf(this),
      children: this.children.map((child) => child.view()),
    };
  }
}

/** Everything a touch can change: the values the engines read, and the page. */
interface PageView {
  readonly values: readonly (readonly [string, number])[] | string;
  readonly body: ElementView;
  readonly markup: string | undefined;
  readonly logs: readonly string[];
  readonly prevented: number;
  readonly reads: readonly string[];
}

/** A page with a body, a #game element, a screen size, and `KNState.touchInput`. */
class FakePage {
  layout: Layout;
  readonly body: FakeElement;
  readonly game: FakeElement;
  readonly logs: string[] = [];
  /** Every box and style read, in order: a touch must cost the same reads. */
  reads: string[] = [];
  prevented = 0;
  KNState: { touchInput?: TouchValues } | undefined = { touchInput: {} };
  VirtualGamepad?: VirtualGamepad;
  oldHelpers?: OldHelpers;

  constructor(layout: Layout) {
    this.layout = layout;
    this.body = new FakeElement(this, 'body');
    this.game = new FakeElement(this, 'div');
    this.game.id = 'game';
    this.body.appendChild(this.game);
    this.document = {
      body: this.body,
      createElement: (tag) => new FakeElement(this, tag),
      getElementById: (id) => this.body.descendants().find((el) => el.id === id) ?? null,
      elementFromPoint: (x, y) => this.elementAt(x, y),
    };
  }

  readonly document: {
    readonly body: FakeElement;
    readonly createElement: (tag: string) => FakeElement;
    readonly getElementById: (id: string) => FakeElement | null;
    readonly elementFromPoint: (x: number, y: number) => FakeElement | null;
  };

  readonly console = { log: (message: string): void => void this.logs.push(message) };

  readonly getComputedStyle = (element: FakeElement) => {
    this.reads.push('style');
    return { borderTopLeftRadius: this.radiusOf(element) };
  };

  overlay(): FakeElement | null {
    return this.body.children.find((el) => el.id === OVERLAY_ID) ?? null;
  }

  /** The controls' buttons in document order, looked up once per change to the page. */
  private buttonOrder: Map<FakeElement, number> | null = null;

  treeChanged(): void {
    this.buttonOrder = null;
  }

  /** The element's place among the controls' buttons, as the browser measured them. */
  private measured(element: FakeElement): Layout['buttons'][number] | undefined {
    const overlay = this.overlay();
    if (!overlay || overlay.style.display === 'none') return undefined;
    this.buttonOrder ??= new Map(overlay.querySelectorAll('.vgp-btn').map((el, at) => [el, at]));
    const at = this.buttonOrder.get(element);
    return at === undefined ? undefined : this.layout.buttons[at];
  }

  boxOf(element: FakeElement): Box {
    const overlay = this.overlay();
    if (!overlay || overlay.style.display === 'none') return NO_BOX;
    if (element.className === 'vgp-stick-zone' && element.parentNode?.parentNode === overlay) {
      return boxFrom(this.layout.stick);
    }
    const measured = this.measured(element);
    return measured ? boxFrom(measured) : NO_BOX;
  }

  radiusOf(element: FakeElement): string {
    return this.measured(element)?.radius ?? '';
  }

  /** The topmost element at a point: the knob in the middle of its zone, the zone, a button, or what is behind. */
  private elementAt(x: number, y: number): FakeElement | null {
    if (!(x >= 0 && y >= 0 && x < this.layout.width && y < this.layout.height)) return null;
    const overlay = this.overlay();
    if (!overlay || overlay.style.display === 'none') return this.body;
    const zone = overlay.querySelector('.vgp-stick-zone');
    if (zone) {
      const box = this.boxOf(zone);
      if (inBox(box, x, y)) {
        const fromMiddle = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
        return fromMiddle < box.width * 0.21 ? (zone.children[0] ?? zone) : zone;
      }
    }
    const button = overlay.querySelectorAll('.vgp-btn').find((el) => inBox(this.boxOf(el), x, y));
    if (button) return button;
    return y > this.layout.height / 2 ? overlay : this.body;
  }

  touch(type: TouchType, touches: readonly PadTouch[]): void {
    const overlay = this.overlay();
    if (!overlay) return;
    const event: PadTouchEvent = { preventDefault: () => void this.prevented++, changedTouches: touches };
    for (const { listener } of overlay.listeners.filter((l) => l.type === type)) listener(event);
  }

  /** Everything a touch can change: the values the engines read, and the page. */
  view(): PageView {
    const values = this.KNState?.touchInput;
    const reads = this.reads;
    this.reads = [];
    return {
      values: values ? Object.entries(values) : this.KNState ? 'no touchInput' : 'no KNState',
      body: this.body.view(),
      markup: this.overlay()?.markup,
      logs: [...this.logs],
      prevented: this.prevented,
      reads,
    };
  }
}

const newPage = (layout: Layout): FakePage => new FakePage(layout);

/** The old script on a page of its own. */
const startOld = (host: FakePage): VirtualGamepad => {
  OLD_SCRIPT_WITH_HELPERS.runInContext(
    vm.createContext({
      window: host,
      document: host.document,
      getComputedStyle: host.getComputedStyle,
      console: host.console,
    }),
  );
  assert.ok(host.VirtualGamepad, 'the old script did not define window.VirtualGamepad');
  return host.VirtualGamepad;
};

// ── random sessions ──────────────────────────────────────────────────────────

/** mulberry32: the same sessions on every run. */
const randomFrom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type ValueState = 'fresh' | 'filled' | 'none' | 'no KNState';
const VALUE_STATES: readonly ValueState[] = ['fresh', 'filled', 'none', 'no KNState'];

type Step =
  | { readonly kind: 'touch'; readonly type: TouchType; readonly touches: readonly PadTouch[] }
  | { readonly kind: 'layout'; readonly layout: Layout }
  | { readonly kind: 'visible'; readonly visible: boolean }
  | { readonly kind: 'destroy' }
  | { readonly kind: 'init' }
  | { readonly kind: 'values'; readonly to: ValueState }
  | { readonly kind: 'game'; readonly present: boolean };

const describeStep = (step: Step): string =>
  step.kind === 'touch'
    ? `${step.type} ${step.touches.map((t) => `#${t.identifier}@${t.clientX},${t.clientY}`).join(' ')}`
    : step.kind === 'layout'
      ? `screen becomes ${step.layout.name}`
      : JSON.stringify(step);

/** Do one step to one page; what it threw, if it threw. */
const apply = (host: FakePage, pad: VirtualGamepad, step: Step): string | null => {
  try {
    if (step.kind === 'touch') host.touch(step.type, step.touches);
    else if (step.kind === 'layout') host.layout = step.layout;
    else if (step.kind === 'visible') pad.setVisible(step.visible);
    else if (step.kind === 'destroy') pad.destroy();
    else if (step.kind === 'init') pad.init();
    else if (step.kind === 'game') {
      if (step.present && !host.game.parentNode) host.body.appendChild(host.game);
      if (!step.present && host.game.parentNode) host.body.removeChild(host.game);
    } else if (step.to === 'no KNState') host.KNState = undefined;
    else if (step.to === 'none') host.KNState = {};
    else if (step.to === 'fresh') host.KNState = { touchInput: {} };
    else host.KNState = { touchInput: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), 0])) };
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : 'threw something that is not an Error';
  }
};

/** Where a finger is, without which finger it is. */
type ScreenPoint = Omit<PadTouch, 'identifier'>;

/** A point for a finger: on or around the stick, on or around a button, or anywhere on the screen. */
const pointFor = (random: () => number, layout: Layout): ScreenPoint => {
  const aim = random();
  if (aim < 0.4) {
    const { left, top, width, height } = layout.stick;
    const reach = random() < 0.2 ? 3 : 1;
    return {
      clientX: left + width / 2 + (random() * 2 - 1) * width * 0.6 * reach,
      clientY: top + height / 2 + (random() * 2 - 1) * height * 0.6 * reach,
    };
  }
  if (aim < 0.9) {
    const shown = layout.buttons.filter((b) => b.width > 0);
    const button = shown[Math.floor(random() * shown.length)] ?? layout.stick;
    // Out to 1.3 half-sizes from the middle: inside, on the rounded corner, in the slop, and just past it.
    return {
      clientX: button.left + button.width / 2 + (random() * 2 - 1) * (button.width / 2 + 12),
      clientY: button.top + button.height / 2 + (random() * 2 - 1) * (button.height / 2 + 12),
    };
  }
  // Whole pixels now and then, and now and then off the screen.
  const x = random() * (layout.width + 40) - 20;
  const y = random() * (layout.height + 40) - 20;
  return random() < 0.5 ? { clientX: Math.round(x), clientY: Math.round(y) } : { clientX: x, clientY: y };
};

const pick = <T>(random: () => number, from: readonly T[]): T | undefined => from[Math.floor(random() * from.length)];

/** The next step of a session, and the fingers that are down after it. */
const nextStep = (random: () => number, layout: Layout, down: Set<number>): Step => {
  const roll = random();
  if (roll < 0.03) return { kind: 'layout', layout: pick(random, LAYOUTS) ?? layout };
  if (roll < 0.045) return { kind: 'visible', visible: random() < 0.5 };
  if (roll < 0.055) return { kind: 'destroy' };
  if (roll < 0.07) return { kind: 'init' };
  if (roll < 0.08) return { kind: 'values', to: pick(random, VALUE_STATES) ?? 'fresh' };
  if (roll < 0.085) return { kind: 'game', present: random() < 0.5 };

  const ids = [...down];
  if (ids.length === 0 || (ids.length < 5 && roll < 0.3)) {
    // New fingers; now and then two land in one event, and now and then an id that is already down comes again.
    const count = random() < 0.15 ? 2 : 1;
    const touches = Array.from({ length: count }, () => {
      const reused = random() < 0.03 ? pick(random, ids) : undefined;
      const free = [0, 1, 2, 3, 4, 5, 6, 7].find((id) => !down.has(id)) ?? 0;
      const identifier = reused ?? free;
      down.add(identifier);
      return { identifier, ...pointFor(random, layout) };
    });
    return { kind: 'touch', type: 'touchstart', touches };
  }
  if (roll < 0.8) {
    const moving = ids.filter(() => random() < 0.6);
    const touches = (moving.length > 0 ? moving : ids.slice(0, 1)).map((identifier) => ({
      identifier,
      ...pointFor(random, layout),
    }));
    return { kind: 'touch', type: 'touchmove', touches };
  }
  const lifted = random() < 0.1 ? ids : [pick(random, ids) ?? 0];
  for (const identifier of lifted) down.delete(identifier);
  // A finger that was never down lifts now and then.
  const touches = lifted.map((identifier) => ({ identifier, ...pointFor(random, layout) }));
  if (random() < 0.03) touches.push({ identifier: 99, clientX: 1, clientY: 1 });
  return { kind: 'touch', type: random() < 0.25 ? 'touchcancel' : 'touchend', touches };
};

test('random touch sessions leave the same values and the same page as the old script, step by step', () => {
  const SESSIONS = 240;
  const STEPS = 250;
  const seen = { stick: 0, buttons: 0, twoButtons: 0, both: 0, slides: 0, afterResize: 0, hiddenTouches: 0 };
  for (let session = 0; session < SESSIONS; session++) {
    const random = randomFrom(0x5eed + session);
    let layout = LAYOUTS[session % LAYOUTS.length] ?? assert.fail('no layouts');
    const oldPage = newPage(layout);
    const newPageHost = newPage(layout);
    const oldPad = startOld(oldPage);
    const newPad = startVirtualGamepad(newPageHost);
    assert.deepEqual(
      Object.keys(newPad).sort(),
      Object.keys(oldPad).sort(),
      'window.VirtualGamepad has the same members',
    );

    const down = new Set<number>();
    const steps: Step[] = [{ kind: 'init' }];
    if (session % 3 === 0) steps.unshift({ kind: 'values', to: 'filled' });
    let resizedWithFingersDown = false;
    let previous: readonly (readonly [string, number])[] = [];
    for (let i = 0; i < STEPS; i++) {
      const step = steps[i] ?? nextStep(random, layout, down);
      if (step.kind === 'layout') {
        layout = step.layout;
        resizedWithFingersDown = down.size > 0;
      }
      if (step.kind === 'destroy') down.clear();

      const oldThrew = apply(oldPage, oldPad, step);
      const newThrew = apply(newPageHost, newPad, step);
      const where = `session ${session}, step ${i} (${layout.name}): ${describeStep(step)}`;
      assert.equal(newThrew, oldThrew, `${where}: what was thrown`);
      const oldView = oldPage.view();
      const newView = newPageHost.view();
      assert.deepStrictEqual(newView, oldView, where);

      if (typeof oldView.values === 'string') continue;
      const pressed = oldView.values.filter(([key, value]) => (Number(key) < 16 || Number(key) > 19) && value === 1);
      const stick = oldView.values.some(([key, value]) => Number(key) >= 16 && Number(key) <= 19 && value > 0);
      if (stick) seen.stick++;
      if (pressed.length > 0) seen.buttons++;
      if (pressed.length > 1) seen.twoButtons++;
      if (stick && pressed.length > 0) seen.both++;
      if (
        step.kind === 'touch' &&
        step.type === 'touchmove' &&
        JSON.stringify(oldView.values) !== JSON.stringify(previous)
      ) {
        seen.slides++;
        if (resizedWithFingersDown) seen.afterResize++;
      }
      if (step.kind === 'touch' && oldPage.overlay()?.style.display === 'none') seen.hiddenTouches++;
      previous = oldView.values;
    }
  }
  // The sessions are only worth something if they press things.
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 200, `sessions reached "${what}" ${count} times`);
});

test('the frame and stylesheet are the old script’s, character for character', () => {
  const host = newPage(LAYOUTS[0] ?? assert.fail('no layouts'));
  startOld(host).init();
  assert.equal(OVERLAY_HTML, host.overlay()?.markup);
  assert.equal(OVERLAY_ID, host.overlay()?.id);
});

// ── the decisions, one at a time, against the old script's own functions ─────

/** A page whose buttons have boxes and corner radii no stylesheet would give them. */
const oddPage = (random: () => number): FakePage => {
  const radii = ['50%', '8px', '6px', '14px', '0px', '', 'none', '3.5px', '21.75px', '1e2px', '-4px'];
  const size = (): number => (random() < 0.08 ? 0 : random() < 0.3 ? Math.ceil(random() * 80) : random() * 120);
  const host = newPage({
    name: 'odd',
    width: 1000,
    height: 1000,
    stick: { left: 100, top: 100, width: 120, height: 120 },
    buttons: Array.from({ length: 16 }, () => ({
      left: random() * 600,
      top: random() * 600,
      width: size(),
      height: size(),
      radius: pick(random, radii) ?? '',
    })),
  });
  return host;
};

test('which button a point is on, with and without slop, is what the old script answered', () => {
  const random = randomFrom(20260402);
  let on = 0;
  let near = 0;
  for (let round = 0; round < 150; round++) {
    const host = oddPage(random);
    startOld(host).init();
    const helpers = host.oldHelpers ?? assert.fail('the old helpers were not handed out');
    for (const button of host.overlay()?.querySelectorAll('.vgp-btn') ?? []) {
      const box = host.boxOf(button);
      const radius = cornerRadius(host.radiusOf(button));
      // Exactly on the outline, and exactly on the slop's: the middle of each side and each corner.
      for (const fx of [0, 0.5, 1]) {
        for (const fy of [0, 0.5, 1]) {
          for (const grow of [0, SLOP_PX]) {
            const x = box.left - grow + fx * (box.width + 2 * grow);
            const y = box.top - grow + fy * (box.height + 2 * grow);
            const where = JSON.stringify({ box, radius, x, y });
            assert.equal(
              pointOnButton(box, radius, x, y),
              helpers.hitTestBtn(button, x, y),
              `on the outline: ${where}`,
            );
            assert.equal(
              pointNearButton(box, radius, x, y, SLOP_PX),
              helpers.hitTestBtnSlop(button, x, y, SLOP_PX),
              `on the slop's outline: ${where}`,
            );
          }
        }
      }
      for (let i = 0; i < 40; i++) {
        // Around the outline, where the answer changes; whole pixels as often as not.
        const exact = random() < 0.5;
        const px = box.left + box.width / 2 + (random() * 2 - 1) * (box.width / 2 + 14);
        const py = box.top + box.height / 2 + (random() * 2 - 1) * (box.height / 2 + 14);
        const x = exact ? Math.round(px) : px;
        const y = exact ? Math.round(py) : py;
        const slop = random() < 0.7 ? SLOP_PX : random() * 20;
        const wasOn = helpers.hitTestBtn(button, x, y);
        const wasNear = helpers.hitTestBtnSlop(button, x, y, slop);
        assert.equal(pointOnButton(box, radius, x, y), wasOn, `on: ${JSON.stringify({ box, radius, x, y })}`);
        assert.equal(
          pointNearButton(box, radius, x, y, slop),
          wasNear,
          `near: ${JSON.stringify({ box, radius, x, y, slop })}`,
        );
        if (wasOn) on++;
        if (wasNear) near++;
      }
    }
  }
  assert.ok(on > 8_000 && near > on + 4_000, `points on a button: ${on}, near one: ${near}`);
});

test('the stick values for a thumb position are the old script’s, bit for bit', () => {
  const random = randomFrom(64);
  const host = newPage(LAYOUTS[0] ?? assert.fail('no layouts'));
  startOld(host).init();
  const helpers = host.oldHelpers ?? assert.fail('the old helpers were not handed out');
  const knob = host.document.createElement('div');
  const values: TouchValues = {};
  host.KNState = { touchInput: values };
  const distinct = new Set<number>();
  const offsets = [
    0, -0, 0.0005, 0.001, 0.0011, 5.99, 6, 6.000001, 7, 25, 49.999999, 50, 50.000001, 1e6, -6, -50, 1e-9,
  ];
  for (let i = 0; i < 300_000; i++) {
    const center = { x: random() < 0.3 ? Math.round(random() * 900) : random() * 900, y: random() * 900 };
    const reach = pick(random, [0.5, 6, 8, 30, 50, 52, 80, 400]) ?? 50;
    const edge = random() < 0.1;
    const dx = edge ? (pick(random, offsets) ?? 0) : (random() * 2 - 1) * reach;
    const dy = edge ? (pick(random, offsets) ?? 0) : (random() * 2 - 1) * reach;
    const whole = random() < 0.3;
    const x = whole ? Math.round(center.x + dx) : center.x + dx;
    const y = whole ? Math.round(center.y + dy) : center.y + dy;

    helpers.setStick(center, knob);
    helpers.updateStick(x, y);
    const reading = stickReading(center, x, y);
    const where = JSON.stringify({ center, x, y });
    // deepStrictEqual tells 0 from -0, so a sign that only shows after a division is caught too.
    assert.deepStrictEqual(
      [reading.right, reading.left, reading.down, reading.up],
      [values[STICK_RIGHT], values[STICK_LEFT], values[STICK_DOWN], values[STICK_UP]],
      where,
    );
    assert.equal(knobTransform(reading.knobX, reading.knobY), knob.style.transform, where);
    distinct.add(reading.right).add(reading.up);
  }
  assert.ok(distinct.size > 20_000, `distinct stick values seen: ${distinct.size}`);
});

// ── the rules themselves ─────────────────────────────────────────────────────

test('the stick values change at the same thumb positions as the old script’s, to the last bit', () => {
  // A value is a rounded number, so arithmetic that is off in its last bit
  // gives the same value almost everywhere: it only shows where a value
  // changes. For each value the stick can give, find the two neighbouring
  // thumb positions (no number between them) where it changes, and ask the
  // old script about those and the positions around them.
  const host = newPage(LAYOUTS[0] ?? assert.fail('no layouts'));
  startOld(host).init();
  const helpers = host.oldHelpers ?? assert.fail('the old helpers were not handed out');
  const knob = host.document.createElement('div');
  const values: TouchValues = {};
  host.KNState = { touchInput: values };
  const scratch = new Float64Array(1);
  const bits = new BigInt64Array(scratch.buffer);
  /** The number `steps` representable numbers above (or below) `value`. */
  const neighbour = (value: number, steps: number): number => {
    scratch[0] = value;
    bits[0] = (bits[0] ?? 0n) + BigInt(value >= 0 ? steps : -steps);
    return scratch[0] ?? value;
  };

  let compared = 0;
  for (const [origin, slope] of [
    [{ x: 0, y: 0 }, 0],
    [{ x: 311.5, y: 640.25 }, 0],
    [{ x: 84, y: 564 }, 0.75],
    [{ x: 84.328125, y: 564.1875 }, -0.3],
  ] satisfies [Point, number][]) {
    const oldAt = (x: number, y: number): readonly (number | undefined)[] => {
      helpers.setStick(origin, knob);
      helpers.updateStick(x, y);
      return [values[STICK_RIGHT], values[STICK_LEFT], values[STICK_DOWN], values[STICK_UP]];
    };
    const yAt = (x: number): number => origin.y + (x - origin.x) * slope;
    for (let value = 1; value < MAX_AXIS; value += 13) {
      // The thumb moves right along a line; `right` only grows. Halve the gap until nothing is between.
      let below = origin.x;
      let above = origin.x + STICK_RADIUS;
      for (;;) {
        const middle = below + (above - below) / 2;
        if (middle <= below || middle >= above) break;
        if (stickReading(origin, middle, yAt(middle)).right < value) below = middle;
        else above = middle;
      }
      for (const steps of [-2, -1, 0, 1, 2, 3]) {
        const x = neighbour(below, steps);
        const reading = stickReading(origin, x, yAt(x));
        assert.deepStrictEqual(
          [reading.right, reading.left, reading.down, reading.up],
          oldAt(x, yAt(x)),
          JSON.stringify({ origin, x, y: yAt(x), value }),
        );
        compared++;
      }
    }
  }
  assert.ok(compared > 50_000, `positions compared: ${compared}`);
});

test('the stick: dead zone, curve, clamp and rounding', () => {
  const origin = { x: 200, y: 300 };
  const at = (dx: number, dy: number): readonly number[] => {
    const r = stickReading(origin, origin.x + dx, origin.y + dy);
    return [r.right, r.left, r.down, r.up];
  };
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
  // 12% of 50px is 6px: nothing at or inside it.
  assert.deepEqual(at(6, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(0, -STICK_RADIUS * DEADZONE), [0, 0, 0, 0]);
  assert.deepEqual(at(7, 0), [239, 0, 0, 0]);
  assert.deepEqual(at(-7, 0), [0, 239, 0, 0]);
  assert.deepEqual(at(0, 7), [0, 0, 239, 0]);
  assert.deepEqual(at(0, -7), [0, 0, 0, 239]);
  assert.deepEqual(at(25, 0), [10998, 0, 0, 0]);
  assert.deepEqual(at(30, -30), [18125, 0, 0, 18125]);
  // Full deflection at the radius, and no more beyond it.
  assert.deepEqual(at(STICK_RADIUS, 0), [MAX_AXIS, 0, 0, 0]);
  assert.deepEqual(at(5000, 0), [MAX_AXIS, 0, 0, 0]);
  assert.deepEqual(at(-200, 150), [0, 26214, 19660, 0]);

  const far = stickReading(origin, origin.x - 200, origin.y + 150);
  assert.deepEqual([far.knobX, far.knobY], [-40, 30], 'the knob stops at the radius, in the same direction');
  assert.equal(knobTransform(far.knobX, far.knobY), 'translate(calc(-50% + -40px), calc(-50% + 30px))');
  assert.equal(KNOB_AT_REST, 'translate(-50%, -50%)');
});

test('the stick’s origin is where the thumb lands, kept a margin away from the zone’s edge', () => {
  const zone = boxFrom({ left: 20, top: 500, width: 128, height: 128 });
  assert.deepEqual(stickOrigin(zone, 84, 564), { x: 84, y: 564 });
  assert.deepEqual(stickOrigin(zone, 90, 570), { x: 90, y: 570 });
  // The margin is half the zone less the radius: 14px here, measured in from each edge.
  assert.deepEqual(stickOrigin(zone, 21, 501), { x: 34, y: 514 });
  assert.deepEqual(stickOrigin(zone, 147, 627), { x: 134, y: 614 });
  assert.deepEqual(originOffset(zone, { x: 34, y: 614 }), { x: -50, y: 50 });
  // A zone narrower than the stick's travel (94px on the smallest phone) has a margin below zero:
  // the origin may then sit up to 3px outside the zone. The old arithmetic, as it was.
  const small = boxFrom({ left: 10, top: 10, width: 94, height: 94 });
  assert.deepEqual(stickOrigin(small, 57, 57), { x: 57, y: 57 });
  assert.deepEqual(stickOrigin(small, 0, 200), { x: 7, y: 107 });
});

test('the buttons: indices, places and the outline a touch is tested against', () => {
  assert.deepEqual(
    BUTTONS.map(([index, , className]) => `${className}=${index}`),
    [
      'vgp-a=0',
      'vgp-b=1',
      'vgp-start=3',
      'vgp-l=10',
      'vgp-r=11',
      'vgp-z=12',
      'vgp-du=4',
      'vgp-dd=5',
      'vgp-dl=6',
      'vgp-dr=7',
      'vgp-cu=23',
      'vgp-cd=22',
      'vgp-cl=21',
      'vgp-cr=20',
    ],
  );
  assert.deepEqual(
    BUTTONS.map(([, , className]) => buttonPlace(className)),
    [
      'ab',
      'ab',
      'start',
      'shoulders',
      'shoulders',
      'z',
      'dpad',
      'dpad',
      'dpad',
      'dpad',
      'cbuttons',
      'cbuttons',
      'cbuttons',
      'cbuttons',
    ],
  );
  assert.equal(buttonPlace('vgp-stick-knob'), 'none');

  assert.equal(cornerRadius('50%'), 50);
  assert.equal(cornerRadius('8px'), 8);
  assert.equal(cornerRadius(''), 0);
  assert.equal(buttonIndex('12'), 12);
  assert.equal(buttonIndex(undefined), undefined);

  const round = boxFrom({ left: 100, top: 100, width: 60, height: 60 });
  assert.equal(pointOnButton(round, 50, 130, 130), true);
  assert.equal(pointOnButton(round, 50, 102, 102), false, 'the corner of a round button is not on it');
  assert.equal(pointNearButton(round, 50, 102, 102, SLOP_PX), false);
  assert.equal(pointOnButton(round, 50, 160, 130), true, 'the outline itself is on the button');
  assert.equal(pointOnButton(round, 50, 165, 130), false);
  assert.equal(pointNearButton(round, 50, 165, 130, SLOP_PX), true, 'within the slop of its edge');
  const square = boxFrom({ left: 100, top: 100, width: 60, height: 30 });
  assert.equal(pointOnButton(square, 8, 102, 102), true, 'the corner of a square button is on it');
  assert.equal(pointOnButton(square, 8, 99, 102), false);
  assert.equal(pointNearButton(square, 8, 92, 138, SLOP_PX), true);
  assert.equal(pointNearButton(square, 8, 91, 138, SLOP_PX), false);
  assert.equal(pointOnButton(NO_BOX, 50, 0, 0), false, 'the hidden copy is never hit');
  assert.equal(pointNearButton(NO_BOX, 50, 0, 0, SLOP_PX), false);
});

test('a sliding finger lets go of what it left and presses what it reached', () => {
  assert.deepEqual(slideChange(new Set([0]), new Set([0, 12])), { released: [], pressed: [12] });
  assert.deepEqual(slideChange(new Set([0, 12]), new Set([12])), { released: [0], pressed: [] });
  assert.deepEqual(slideChange(new Set([4, 6]), new Set([7, 5])), { released: [4, 6], pressed: [7, 5] });
  assert.deepEqual(slideChange(new Set(), new Set()), { released: [], pressed: [] });
});

test('on a page: a tap, a drag, two fingers, hiding and taking the controls away', () => {
  const layout = LAYOUTS[0] ?? assert.fail('no layouts');
  const host = newPage(layout);
  const pad = startVirtualGamepad(host);
  assert.equal(host.overlay(), null, 'nothing is built before init');
  pad.init();
  pad.init();
  assert.equal(host.body.children.filter((el) => el.id === OVERLAY_ID).length, 1, 'init twice builds once');
  assert.equal(host.game.style.margin, '0');
  assert.deepEqual(host.logs, ['[virtual-gamepad] initialized']);
  const values: TouchValues = host.KNState?.touchInput ?? assert.fail('no touchInput');

  const middle = (className: string): ScreenPoint => {
    const button = host
      .overlay()
      ?.querySelectorAll(className)
      .find((el) => host.boxOf(el).width > 0);
    const box = host.boxOf(button ?? assert.fail(`${className} is not shown`));
    return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  };
  const active = (): string[] =>
    (host.overlay()?.querySelectorAll('.active') ?? []).map((el) => el.className.replace('vgp-btn ', ''));

  host.touch('touchstart', [{ identifier: 1, ...middle('.vgp-a') }]);
  assert.deepEqual({ ...values }, { 0: 1 });
  assert.deepEqual(active(), ['vgp-a active']);

  const stick = middle('.vgp-stick-zone');
  host.touch('touchstart', [{ identifier: 2, ...stick }]);
  host.touch('touchmove', [{ identifier: 2, clientX: stick.clientX + 25, clientY: stick.clientY }]);
  assert.deepEqual({ ...values }, { 0: 1, 16: 10998, 17: 0, 18: 0, 19: 0 });
  host.touch('touchmove', [{ identifier: 2, clientX: stick.clientX - 200, clientY: stick.clientY + 150 }]);
  assert.deepEqual({ ...values }, { 0: 1, 16: 0, 17: 26214, 18: 19660, 19: 0 });

  // Z is on the page twice; both copies light.
  host.touch('touchmove', [{ identifier: 1, ...middle('.vgp-z') }]);
  assert.deepEqual({ ...values }, { 0: 0, 12: 1, 16: 0, 17: 26214, 18: 19660, 19: 0 });
  assert.deepEqual(active(), ['vgp-z active', 'vgp-z active']);

  host.touch('touchcancel', [{ identifier: 2, clientX: 0, clientY: 0 }]);
  assert.deepEqual({ ...values }, { 0: 0, 12: 1, 16: 0, 17: 0, 18: 0, 19: 0 });
  host.touch('touchend', [{ identifier: 1, clientX: 0, clientY: 0 }]);
  assert.deepEqual({ ...values }, { 0: 0, 12: 0, 16: 0, 17: 0, 18: 0, 19: 0 });
  assert.deepEqual(active(), []);
  assert.equal(host.prevented, 7, 'every touch on the controls is kept from the page');

  host.touch('touchstart', [{ identifier: 3, ...middle('.vgp-b') }]);
  pad.setVisible(false);
  assert.equal(values[1], 0, 'hiding lets go of everything');
  assert.equal(host.overlay()?.style.display, 'none');
  assert.equal(host.game.style.margin, 'auto 0');
  pad.setVisible(true);
  assert.equal(host.game.style.margin, '0');

  host.touch('touchstart', [{ identifier: 4, ...middle('.vgp-cu') }]);
  assert.equal(values[23], 1);
  pad.destroy();
  assert.equal(values[23], 0, 'taking the controls away lets go of everything');
  assert.equal(host.overlay(), null);
  assert.equal(host.game.style.margin, '');
  assert.deepEqual(host.logs, ['[virtual-gamepad] initialized', '[virtual-gamepad] destroyed']);
});
