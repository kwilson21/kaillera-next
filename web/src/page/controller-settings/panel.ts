/**
 * The in-game controller settings panel: the mapping grid with click-to-rebind,
 * the live stick preview, the range, sensitivity and dead-zone sliders, the
 * per-game switch and Reset. Moved from web/static/controller-settings.js,
 * which now only starts it and puts it on the page as
 * `window.ControllerSettings`.
 *
 * The panel builds its own elements and adds its own styles, so it works on
 * any page that loads it. What it decides is in logic.ts; this file reads the
 * page, the pads and storage, and writes what was decided.
 */
import { Duration, Effect } from 'effect';
import type { AxisName } from '../../gamepad-axes.ts';
import type { GamepadProfile } from '../../gamepad-profile.ts';
import type { PageState } from '../../kn-state.ts';
import {
  capturedInput,
  cStickAxes,
  type DeadzoneKey,
  deadzoneRingRadius,
  deadzoneText,
  gamepadBindingName,
  gameSettingKey,
  groupLabel,
  hundredthsFromSlider,
  invertKeyMap,
  KEYBOARD_MAP_KEY,
  type KeyMap,
  keyMapWithKey,
  keyName,
  listeningText,
  N64_BUTTONS,
  padStatusText,
  percentText,
  profileAfterCapture,
  RANGE_KEY,
  rangeFromSlider,
  rangeRingRadius,
  rangeText,
  resetStorageKeys,
  savedKeyboardMap,
  SENSITIVITY_KEY,
  sensitivityText,
  settingScope,
  sliderHundredths,
} from './logic.ts';
import { C_STICK_SVG, LEFT_STICK_SVG, PANEL_CSS } from './markup.ts';

/** `window.ControllerSettings`: what play.js, demo.js and the panel's own Quick Setup button call. */
export interface ControllerSettingsPanel {
  /** Build the panel afresh from the current pad and settings, and show it. */
  readonly open: () => void;
  /** Hide the panel and stop listening for a rebind. Nothing happens before the first `open`. */
  readonly close: () => void;
  readonly toggle: () => void;
  /** Start the page's remap wizard, when the page has one. */
  readonly startQuickSetup: () => void;
  /** Redraw the mapping grid; the remap wizard calls it after it saves. */
  readonly _refreshGrid: () => void;
}

// ── the page, as far as the panel uses it ───────────────────────────────────

/** The inline styles the panel sets. */
type PanelStyle = {
  position?: string;
  bottom?: string;
  left?: string;
  transform?: string;
  background?: string;
  color?: string;
  padding?: string;
  borderRadius?: string;
  fontSize?: string;
  zIndex?: string;
  opacity?: string;
  transition?: string;
  display?: string;
  justifyContent?: string;
  alignItems?: string;
  marginBottom?: string;
  marginTop?: string;
  margin?: string;
  textAlign?: string;
  lineHeight?: string;
  gap?: string;
  flex?: string;
};

/** A key press, as the panel reads it. */
interface PanelKeyEvent {
  readonly key: string;
  readonly keyCode: number;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

/** A text node; the panel only makes and places them. */
interface PanelText {
  readonly nodeValue: string | null;
}

/** A part of a stick drawing: a ring or a dot. */
interface PanelDrawingPart {
  setAttribute(name: string, value: string): void;
}

/** A stick drawing (an svg element). */
interface PanelDrawing {
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): PanelDrawingPart | null;
}

type PanelChild = PanelElement | PanelDrawing | PanelText;

/** An element the panel builds. `checked` and `value` are a checkbox's and a slider's. */
interface PanelElement {
  className: string;
  textContent: string | null;
  innerHTML: string;
  checked?: boolean;
  value?: string;
  readonly style: PanelStyle;
  readonly dataset: { prevText?: string | undefined };
  readonly classList: { add(name: string): void; remove(name: string): void };
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  appendChild(child: PanelChild): void;
  remove(): void;
}

/** Where the panel puts what it builds. */
interface PanelParent {
  appendChild(child: PanelChild): void;
}

/** A connected pad, as the browser reports it. */
interface PanelPad {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

/** The pad in a player slot and the profile it is read with. */
interface ActivePad {
  readonly id: string;
  readonly profileName: string;
  readonly profile: GamepadProfile;
}

/** `window.GamepadManager` (web/static/gamepad-manager.js), as far as the panel calls it. */
interface PanelGamepads {
  readonly getAssignments: () => { readonly [slot: string]: { readonly gamepadIndex: number } | undefined };
  readonly getActiveProfile: (slot: number) => ActivePad | null;
  readonly saveGamepadProfile: (gamepadId: string, profile: GamepadProfile) => void;
  readonly clearGamepadProfile: (gamepadId: string) => void;
  readonly getCurrentSettings: () => {
    readonly range: number;
    readonly sensitivity: number;
    readonly deadzones: { readonly lx: number; readonly ly: number; readonly cx: number; readonly cy: number };
  };
  readonly setSetting: (key: string, value: number, scope: 'game' | 'global') => void;
  readonly axisTransform: (profile: GamepadProfile, name: AxisName) => (raw: number, center: number) => number;
  readonly axisCenter: (gamepadIndex: number, axisIndex: number) => number;
  readonly displayName: (id: string) => string;
}

/** `window.APISandbox` (web/static/api-sandbox.js): the browser's own calls, kept from before the emulator replaced them. */
interface PanelSandbox {
  readonly nativeRAF: (callback: () => void) => number;
  readonly nativeCancelRAF: (id: number) => void;
  readonly nativeGetGamepads: () => ArrayLike<PanelPad | null>;
}

/**
 * The part of `window` the panel uses. The other scripts' globals are read
 * when they are needed, never when the panel starts, so a page that defines
 * one later still works.
 */
export interface ControllerSettingsHost {
  readonly document: {
    readonly head: PanelParent;
    readonly body: PanelParent;
    createElement(tag: string): PanelElement;
    createElementNS(namespace: string, name: string): PanelDrawing;
    createTextNode(text: string): PanelText;
    addEventListener(type: 'keydown', listener: (event: PanelKeyEvent) => void, capture: boolean): void;
    removeEventListener(type: 'keydown', listener: (event: PanelKeyEvent) => void, capture: boolean): void;
  };
  readonly localStorage: {
    readonly getItem: (key: string) => string | null;
    readonly setItem: (key: string, value: string) => void;
    readonly removeItem: (key: string) => void;
  };
  addEventListener(type: 'gamepadconnected' | 'gamepaddisconnected', listener: () => void): void;
  setTimeout(callback: () => void, ms: number): void;
  confirm(message: string): boolean;
  readonly ControllerSettings?: ControllerSettingsPanel | undefined;
  readonly GamepadManager?: PanelGamepads | undefined;
  readonly APISandbox?: PanelSandbox | undefined;
  /** web/static/shared.js: the keys a player with no saved mapping has. */
  readonly KNShared?: { readonly DEFAULT_N64_KEYMAP: KeyMap } | undefined;
  /** The panel sets `remapActive` while it is open, so the engine does not read the keys pressed in it. */
  readonly KNState?: Pick<PageState, 'remapActive' | 'romHash'> | undefined;
  /** The engine, once loaded: told to read the key map again after the panel changes it. */
  readonly NetplayRollback?: { readonly refreshKeyMap?: () => void } | undefined;
  /** play.js's toast, on the play page. */
  readonly showToast?: ((message: string) => void) | undefined;
  /** play.js's remap wizard. */
  readonly _startIngameRemap?: (() => void) | undefined;
  readonly Switch2USB?: { readonly isSupported: () => boolean } | undefined;
}

/** The two elements of an open panel: the panel and the dimmed page behind it. */
type BuiltPanel = { readonly panel: PanelElement; readonly backdrop: PanelElement };

/** A global another script defines; reading one that is missing fails as a bare name did in the old script. */
const defined = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new ReferenceError(`${name} is not defined`);
  return value;
};

/** What `el` sets on a new element, in the order given. */
type ElementAttrs = {
  readonly id?: string;
  readonly className?: string;
  readonly style?: PanelStyle;
  readonly type?: string;
  readonly min?: string;
  readonly max?: string;
  readonly value?: string;
  readonly step?: string;
  readonly onClick?: () => void;
  readonly onInput?: () => void;
};

/**
 * Add the panel's styles to the page, follow pads being plugged in and the
 * Escape key, and return the panel. Nothing is drawn until it is opened.
 */
export const startControllerSettings = (host: ControllerSettingsHost): ControllerSettingsPanel => {
  const document = host.document;
  const gamepads = (): PanelGamepads => defined(host.GamepadManager, 'GamepadManager');
  const sandbox = (): PanelSandbox => defined(host.APISandbox, 'APISandbox');

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  let panel: PanelElement | null = null;
  let backdrop: PanelElement | null = null;
  let isOpen = false;
  let vizRafId: number | null = null;

  // ── DOM helper ─────────────────────────────────────────────────────────────
  const el = (tag: string, attrs: ElementAttrs | null, ...children: (PanelChild | string | null)[]): PanelElement => {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (typeof v === 'object') Object.assign(e.style, v);
        else if (k === 'className') e.className = v;
        else e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  };

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showSavedToast = (): void => {
    // play.js's toast on the play page; the demo page has none, so the panel shows its own.
    if (host.showToast) {
      host.showToast('Settings saved');
      return;
    }
    const toast = el(
      'div',
      {
        style: {
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1d4ed8',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: '6px',
          fontSize: '13px',
          zIndex: '200',
          opacity: '1',
          transition: 'opacity 0.3s',
        },
      },
      'Settings saved',
    );
    document.body.appendChild(toast);
    // Shown for a second and a half, then faded out over the 0.3 s of its transition and removed.
    Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(1500));
        toast.style.opacity = '0';
        yield* Effect.sleep(Duration.millis(300));
        toast.remove();
      }),
    );
  };

  // ── Keyboard map ───────────────────────────────────────────────────────────
  const getKeyboardMap = (): KeyMap => {
    let saved: string | null = null;
    try {
      saved = host.localStorage.getItem(KEYBOARD_MAP_KEY);
    } catch {
      /* storage is blocked: the default keys apply */
    }
    return savedKeyboardMap(saved) ?? { ...defined(host.KNShared, 'KNShared').DEFAULT_N64_KEYMAP };
  };

  const saveKeyboardMap = (map: KeyMap): void => {
    host.localStorage.setItem(KEYBOARD_MAP_KEY, JSON.stringify(map));
    // The engine keeps the key map it read when the emulator became ready;
    // without this the new mapping would not reach the input it reads.
    host.NetplayRollback?.refreshKeyMap?.();
  };

  // ── Rebind ─────────────────────────────────────────────────────────────────
  let rebindCell: PanelElement | null = null;
  let rebindKeyHandler: ((event: PanelKeyEvent) => void) | null = null;
  let rebindPollId: number | null = null;

  const cancelRebind = (): void => {
    if (rebindCell) {
      rebindCell.classList.remove('listening');
      rebindCell.textContent = rebindCell.dataset.prevText || '—';
    }
    if (rebindKeyHandler) {
      document.removeEventListener('keydown', rebindKeyHandler, true);
      rebindKeyHandler = null;
    }
    if (rebindPollId) {
      sandbox().nativeCancelRAF(rebindPollId);
      rebindPollId = null;
    }
    rebindCell = null;
    if (host.KNState) host.KNState.remapActive = false;
  };

  const startRebind = (cell: PanelElement, type: 'gamepad' | 'keyboard', bit: number): void => {
    cancelRebind();
    rebindCell = cell;
    cell.dataset.prevText = cell.textContent ?? '';
    cell.textContent = listeningText(type, bit);
    cell.classList.add('listening');
    if (host.KNState) host.KNState.remapActive = true;

    if (type === 'keyboard') {
      const onKey = (e: PanelKeyEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          cancelRebind();
          return;
        }
        saveKeyboardMap(keyMapWithKey(getKeyboardMap(), e.keyCode, bit));
        refreshMappingGrid();
        cancelRebind();
      };
      rebindKeyHandler = onKey;
      document.addEventListener('keydown', onKey, true);
      return;
    }

    // Where the axes are now, so a stick already held does not bind at once.
    const assignedIndex = gamepads().getAssignments()[0]?.gamepadIndex;
    const assignedPad = assignedIndex === undefined ? undefined : sandbox().nativeGetGamepads()[assignedIndex];
    const baseline = assignedPad ? [...assignedPad.axes] : [];

    // Polled on the browser's own animation frame: pad readings only change once per frame.
    const pollRebind = (): void => {
      if (!rebindCell) return;
      rebindPollId = sandbox().nativeRAF(pollRebind);
      const pads = sandbox().nativeGetGamepads();
      let pad: PanelPad | null = null;
      for (let i = 0; i < pads.length; i++) {
        const candidate = pads[i];
        if (candidate) {
          pad = candidate;
          break;
        }
      }
      if (!pad) return;
      const captured = capturedInput(bit, pad.buttons, pad.axes, baseline);
      if (!captured) return;
      const active = gamepads().getActiveProfile(0);
      if (active) gamepads().saveGamepadProfile(active.id, profileAfterCapture(active.profile, bit, captured));
      refreshMappingGrid();
      cancelRebind();
    };
    rebindPollId = sandbox().nativeRAF(pollRebind);
  };

  // ── Mapping grid ───────────────────────────────────────────────────────────
  let mapGrid: PanelElement | null = null;

  const populateMappingGrid = (grid: PanelElement): void => {
    grid.appendChild(
      el(
        'div',
        { className: 'cs-map-header-row' },
        el('span', null),
        el('span', { className: 'cs-map-col-label' }, 'Gamepad'),
        el('span', { className: 'cs-map-col-label' }, 'Keyboard'),
      ),
    );

    const keyByBit = invertKeyMap(getKeyboardMap());
    const profile = gamepads().getActiveProfile(0)?.profile || null;

    let lastGroup: string | null = null;
    for (const button of N64_BUTTONS) {
      if (button.group !== lastGroup && button.group !== 'face') {
        grid.appendChild(el('div', { className: 'cs-map-group' }, groupLabel(button.group)));
        lastGroup = button.group;
      }
      if (button.group === 'face' && lastGroup === null) lastGroup = 'face';

      const label = el('span', { className: 'cs-map-label' }, button.label);

      const onAxis = button.group === 'cbutton' || button.group === 'stick';
      const padCell: PanelElement = el(
        'div',
        {
          className: 'cs-map-bind' + (onAxis ? ' axis-bind' : ''),
          onClick: () => startRebind(padCell, 'gamepad', button.bit),
        },
        gamepadBindingName(button.bit, profile),
      );

      const keyCode = keyByBit[button.bit];
      const keyCell: PanelElement = el(
        'div',
        {
          className: 'cs-map-bind',
          onClick: () => startRebind(keyCell, 'keyboard', button.bit),
        },
        keyCode !== undefined ? keyName(keyCode) : '—',
      );

      grid.appendChild(label);
      grid.appendChild(padCell);
      grid.appendChild(keyCell);
    }
  };

  const refreshMappingGrid = (): void => {
    if (!mapGrid) return;
    mapGrid.innerHTML = '';
    populateMappingGrid(mapGrid);
  };

  const buildMappingSection = (parent: PanelElement): void => {
    parent.appendChild(
      el(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
        el('div', { className: 'cs-section-label', style: { margin: '0' } }, 'Button Mapping'),
        el(
          'button',
          { className: 'cs-quick-btn', onClick: () => host.ControllerSettings?.startQuickSetup() },
          'Quick Setup ▸',
        ),
      ),
    );

    mapGrid = el('div', { className: 'cs-map-grid' });
    populateMappingGrid(mapGrid);
    parent.appendChild(mapGrid);
  };

  // ── Stick preview ──────────────────────────────────────────────────────────
  let vizLeftDot: PanelDrawingPart | null = null;
  let vizLeftDzRing: PanelDrawingPart | null = null;
  let vizLeftRangeRing: PanelDrawingPart | null = null;
  let vizLeftCoords: PanelElement | null = null;
  let vizRightDot: PanelDrawingPart | null = null;
  let vizRightDzRing: PanelDrawingPart | null = null;
  let vizRightCoords: PanelElement | null = null;
  let vizNoGamepad: PanelElement | null = null;
  let vizTrailDots: (PanelDrawingPart | null)[] = [];
  /** The left stick's last positions, oldest first, for the two trail dots. */
  let trailHistory = [
    { x: 60, y: 60 },
    { x: 60, y: 60 },
  ];

  const buildVizSection = (parent: PanelElement): void => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Live Stick Preview'));

    const wrap = el('div', { className: 'cs-viz-wrap' });
    const row = el('div', { className: 'cs-viz-row' });

    // Left stick (120×120)
    const leftDiv = el('div', { style: { textAlign: 'center' } });
    leftDiv.appendChild(el('div', { className: 'cs-viz-label' }, 'Left Stick'));
    const leftSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    leftSvg.setAttribute('width', '120');
    leftSvg.setAttribute('height', '120');
    leftSvg.innerHTML = LEFT_STICK_SVG;
    vizLeftDot = leftSvg.querySelector('.cs-dot');
    vizLeftDzRing = leftSvg.querySelector('.cs-dz-ring');
    vizLeftRangeRing = leftSvg.querySelector('.cs-range-ring');
    vizTrailDots = [leftSvg.querySelector('.cs-trail-1'), leftSvg.querySelector('.cs-trail-2')];
    leftDiv.appendChild(leftSvg);
    vizLeftCoords = el('div', { className: 'cs-viz-coords' }, 'X: 0  Y: 0');
    leftDiv.appendChild(vizLeftCoords);

    // C stick (80×80)
    const rightDiv = el('div', { style: { textAlign: 'center' } });
    rightDiv.appendChild(el('div', { className: 'cs-viz-label' }, 'C-Stick'));
    const rightSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    rightSvg.setAttribute('width', '80');
    rightSvg.setAttribute('height', '80');
    rightSvg.innerHTML = C_STICK_SVG;
    vizRightDot = rightSvg.querySelector('.cs-dot');
    vizRightDzRing = rightSvg.querySelector('.cs-dz-ring');
    rightDiv.appendChild(rightSvg);
    vizRightCoords = el('div', { className: 'cs-viz-coords', style: { marginTop: '14px' } }, 'X: 0  Y: 0');
    rightDiv.appendChild(vizRightCoords);

    row.appendChild(leftDiv);
    row.appendChild(rightDiv);
    wrap.appendChild(row);

    vizNoGamepad = el('div', { className: 'cs-no-gamepad', style: { display: 'none' } }, 'No gamepad detected');
    wrap.appendChild(vizNoGamepad);
    parent.appendChild(wrap);
  };

  /**
   * The pad's stick axes with polarity, rest position and the profile's range
   * applied (GamepadManager.axisTransform) but before dead zone, range and
   * sensitivity, so the dot moves the way the stick does. Null without a pad.
   */
  const readRawAxes = (): { lx: number; ly: number; cx: number; cy: number } | null => {
    const active = gamepads().getActiveProfile(0);
    if (!active) return null;
    const padIndex = gamepads().getAssignments()[0]?.gamepadIndex;
    if (padIndex === undefined) return null;
    const pad = sandbox().nativeGetGamepads()[padIndex];
    if (!pad) return null;
    const profile = active.profile;
    const cStick = cStickAxes(profile.axisButtons);
    const read = (name: AxisName, index: number): number => {
      const raw = pad.axes[index];
      return raw === undefined
        ? 0
        : gamepads().axisTransform(profile, name)(raw, gamepads().axisCenter(padIndex, index));
    };
    const stickX = profile.axes?.stickX;
    const stickY = profile.axes?.stickY;
    return {
      lx: stickX ? read('lx', stickX.index) : 0,
      ly: stickY ? read('ly', stickY.index) : 0,
      cx: read('cx', cStick.cx),
      cy: read('cy', cStick.cy),
    };
  };

  // The preview's render loop: one frame after another while the panel is open.
  const updateViz = (): void => {
    if (!isOpen) return;
    vizRafId = sandbox().nativeRAF(updateViz);

    const settings = gamepads().getCurrentSettings();
    vizLeftDzRing?.setAttribute('r', String(deadzoneRingRadius(56, settings.deadzones.lx)));
    vizLeftRangeRing?.setAttribute('r', String(rangeRingRadius(settings.range)));
    vizRightDzRing?.setAttribute('r', String(deadzoneRingRadius(36, settings.deadzones.cx)));

    const raw = readRawAxes();
    if (!raw) {
      if (vizNoGamepad) vizNoGamepad.style.display = '';
      return;
    }
    if (vizNoGamepad) vizNoGamepad.style.display = 'none';

    // A stick value in [-1, 1] to a position in the drawing.
    const lx = 60 + raw.lx * 52;
    const ly = 60 + raw.ly * 52;

    trailHistory.push({ x: lx, y: ly });
    if (trailHistory.length > 3) trailHistory.shift();
    if (vizTrailDots[0]) {
      vizTrailDots[0].setAttribute('cx', String(trailHistory[1]?.x ?? 60));
      vizTrailDots[0].setAttribute('cy', String(trailHistory[1]?.y ?? 60));
    }
    if (vizTrailDots[1]) {
      vizTrailDots[1].setAttribute('cx', String(trailHistory[0]?.x ?? 60));
      vizTrailDots[1].setAttribute('cy', String(trailHistory[0]?.y ?? 60));
    }

    vizLeftDot?.setAttribute('cx', String(lx));
    vizLeftDot?.setAttribute('cy', String(ly));
    if (vizLeftCoords) vizLeftCoords.textContent = `X:${percentText(raw.lx)}  Y:${percentText(raw.ly)}`;

    const cx = 40 + raw.cx * 33;
    const cy = 40 + raw.cy * 33;
    vizRightDot?.setAttribute('cx', String(cx));
    vizRightDot?.setAttribute('cy', String(cy));
    if (vizRightCoords) vizRightCoords.textContent = `X:${percentText(raw.cx)}  Y:${percentText(raw.cy)}`;
  };

  const stopVizLoop = (): void => {
    if (vizRafId) {
      sandbox().nativeCancelRAF(vizRafId);
      vizRafId = null;
    }
  };

  const startVizLoop = (): void => {
    stopVizLoop();
    vizRafId = sandbox().nativeRAF(updateViz);
  };

  // ── Per-game scope ─────────────────────────────────────────────────────────
  let perGameCheckbox: PanelElement | null = null;
  const getScope = (): 'game' | 'global' => settingScope(perGameCheckbox?.checked);

  // ── Analog tuning sliders ──────────────────────────────────────────────────
  const buildAnalogSection = (parent: PanelElement): void => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Analog Tuning'));

    const settings = gamepads().getCurrentSettings();

    const rangeVal = el('span', { className: 'cs-slider-val', style: { color: '#3b82f6' } }, rangeText(settings.range));
    const rangeInput: PanelElement = el('input', {
      type: 'range',
      min: '10',
      max: '100',
      value: String(settings.range),
      step: '1',
      onInput: () => {
        const v = rangeFromSlider(rangeInput.value ?? '');
        rangeVal.textContent = rangeText(v);
        gamepads().setSetting(RANGE_KEY, v, getScope());
      },
    });
    parent.appendChild(
      el(
        'div',
        { className: 'cs-slider-row' },
        el('div', { className: 'cs-slider-header' }, el('span', { className: 'cs-slider-name' }, 'Range'), rangeVal),
        rangeInput,
        el('div', { className: 'cs-slider-hint' }, 'Max output magnitude (66% = ±83 N64 units)'),
      ),
    );

    const sensVal = el(
      'span',
      { className: 'cs-slider-val', style: { color: '#a78bfa' } },
      sensitivityText(settings.sensitivity),
    );
    const sensInput: PanelElement = el('input', {
      type: 'range',
      min: '50',
      max: '200',
      value: sliderHundredths(settings.sensitivity),
      step: '5',
      onInput: () => {
        const v = hundredthsFromSlider(sensInput.value ?? '');
        sensVal.textContent = sensitivityText(v);
        gamepads().setSetting(SENSITIVITY_KEY, v, getScope());
      },
    });
    parent.appendChild(
      el(
        'div',
        { className: 'cs-slider-row' },
        el(
          'div',
          { className: 'cs-slider-header' },
          el('span', { className: 'cs-slider-name' }, 'Sensitivity'),
          sensVal,
        ),
        sensInput,
        el(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between' } },
          el('span', { className: 'cs-slider-hint' }, 'Gentle'),
          el('span', { className: 'cs-slider-hint' }, 'Linear'),
          el('span', { className: 'cs-slider-hint' }, 'Aggressive'),
        ),
      ),
    );
  };

  // ── Dead-zone sliders ──────────────────────────────────────────────────────
  const buildDzSlider = (label: string, key: DeadzoneKey, value: number): PanelElement => {
    const val = el('span', { className: 'cs-dz-val' }, deadzoneText(value));
    const input: PanelElement = el('input', {
      type: 'range',
      min: '0',
      max: '50',
      value: sliderHundredths(value),
      step: '1',
      style: { flex: '1' },
      onInput: () => {
        const v = hundredthsFromSlider(input.value ?? '');
        val.textContent = deadzoneText(v);
        gamepads().setSetting(key, v, getScope());
      },
    });
    return el('div', { className: 'cs-dz-row' }, el('span', { className: 'cs-dz-axis' }, label), input, val);
  };

  const buildDeadzoneSection = (parent: PanelElement): void => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Deadzone'));

    const settings = gamepads().getCurrentSettings();

    parent.appendChild(
      el(
        'div',
        { className: 'cs-dz-card' },
        el('div', { className: 'cs-dz-title' }, 'Left Stick'),
        buildDzSlider('X', 'kn-deadzone-lx', settings.deadzones.lx),
        buildDzSlider('Y', 'kn-deadzone-ly', settings.deadzones.ly),
      ),
    );
    parent.appendChild(
      el(
        'div',
        { className: 'cs-dz-card' },
        el('div', { className: 'cs-dz-title' }, 'C-Stick'),
        buildDzSlider('X', 'kn-deadzone-cx', settings.deadzones.cx),
        buildDzSlider('Y', 'kn-deadzone-cy', settings.deadzones.cy),
      ),
    );
  };

  // ── Footer ─────────────────────────────────────────────────────────────────
  const close = (): void => {
    if (!panel) return;
    panel.classList.remove('open');
    backdrop?.classList.remove('visible');
    isOpen = false;
    if (host.KNState) host.KNState.remapActive = false;
    stopVizLoop();
    cancelRebind();
  };

  const onReset = (): void => {
    if (!host.confirm('Reset all controller settings to defaults?')) return;
    for (const key of resetStorageKeys(host.KNState?.romHash)) host.localStorage.removeItem(key);
    // The engine keeps its own copy of the key map, so it is told as well.
    host.NetplayRollback?.refreshKeyMap?.();
    const active = gamepads().getActiveProfile(0);
    if (active) gamepads().clearGamepadProfile(active.id);
    rebuildPanel();
  };

  const buildFooter = (parent: PanelElement): void => {
    const checkbox = el('input', { type: 'checkbox' });
    perGameCheckbox = checkbox;
    const romHash = host.KNState?.romHash;
    if (romHash) checkbox.checked = host.localStorage.getItem(gameSettingKey(romHash, RANGE_KEY)) !== null;

    parent.appendChild(
      el(
        'div',
        { className: 'cs-footer' },
        el('label', null, checkbox, 'Save for this game only'),
        el(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          el('button', { className: 'cs-footer-reset', onClick: onReset }, 'Reset'),
          el(
            'button',
            {
              className: 'cs-quick-btn',
              onClick: () => {
                showSavedToast();
                close();
              },
            },
            'Done',
          ),
        ),
      ),
    );
  };

  // ── Build panel ────────────────────────────────────────────────────────────
  const buildPanel = (): BuiltPanel => {
    // A click outside the panel closes it.
    const newBackdrop = el('div', { id: 'cs-backdrop', onClick: () => close() });
    backdrop = newBackdrop;
    document.body.appendChild(newBackdrop);

    const newPanel = el('div', { id: 'controller-settings' });
    panel = newPanel;

    newPanel.appendChild(
      el(
        'div',
        { className: 'cs-header' },
        el('span', { className: 'cs-title' }, 'Controller Settings'),
        el('button', { className: 'cs-close', onClick: () => close() }, '×'),
      ),
    );

    const active = gamepads().getActiveProfile(0);
    newPanel.appendChild(
      el(
        'div',
        {
          style: {
            fontSize: '11px',
            color: active ? '#6f6' : '#475569',
            marginBottom: '12px',
            textAlign: 'center',
          },
        },
        active ? padStatusText(gamepads().displayName(active.id), active.profileName) : 'No controller detected',
      ),
    );

    newPanel.appendChild(
      el(
        'div',
        { style: { fontSize: '11px', color: '#64748b', lineHeight: '1.4', marginBottom: '12px', textAlign: 'center' } },
        'Tested: a modern Xbox controller. Other gamepads your browser recognizes should work; if buttons land in the wrong place, use Quick Setup below.' +
          (host.Switch2USB?.isSupported()
            ? ' Switch 2 Pro (experimental): USB-C cable only; the first time, press Connect Switch 2 Pro in the room, before the game starts.'
            : ''),
      ),
    );

    buildMappingSection(newPanel);
    newPanel.appendChild(el('div', { className: 'cs-sep' }));
    buildVizSection(newPanel);
    newPanel.appendChild(el('div', { className: 'cs-sep' }));
    buildAnalogSection(newPanel);
    newPanel.appendChild(el('div', { className: 'cs-sep' }));
    buildDeadzoneSection(newPanel);
    buildFooter(newPanel);

    document.body.appendChild(newPanel);
    return { panel: newPanel, backdrop: newBackdrop };
  };

  /** Take the panel off the page. */
  const removePanel = (): void => {
    if (panel) {
      panel.remove();
      panel = null;
    }
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
  };

  // ── Open / close ───────────────────────────────────────────────────────────
  const open = (): void => {
    // Built afresh every time, so it shows the pad and settings as they are now.
    removePanel();
    const built = buildPanel();
    built.panel.classList.add('open');
    built.backdrop.classList.add('visible');
    isOpen = true;
    if (host.KNState) host.KNState.remapActive = true;
    startVizLoop();
  };

  function rebuildPanel(): void {
    const wasOpen = isOpen;
    removePanel();
    mapGrid = null;
    vizLeftDot = null;
    vizLeftDzRing = null;
    vizLeftRangeRing = null;
    vizLeftCoords = null;
    vizRightDot = null;
    vizRightDzRing = null;
    vizRightCoords = null;
    vizNoGamepad = null;
    vizTrailDots = [];
    trailHistory = [
      { x: 60, y: 60 },
      { x: 60, y: 60 },
    ];
    if (wasOpen) open();
  }

  const toggle = (): void => {
    if (isOpen) close();
    else open();
  };

  const startQuickSetup = (): void => {
    if (host._startIngameRemap) host._startIngameRemap();
  };

  // A pad was plugged in or pulled out: rebuild an open panel. GamepadManager
  // hears the same event and must take the pad in first, and its listener may
  // run after this one, so the rebuild waits for the next task. That is an
  // ordering against another listener, not a wait with a length, so it stays
  // the page's own zero-delay timer.
  const onGamepadChange = (): void => {
    host.setTimeout(() => {
      if (isOpen) rebuildPanel();
    }, 0);
  };
  host.addEventListener('gamepadconnected', onGamepadChange);
  host.addEventListener('gamepaddisconnected', onGamepadChange);

  // Escape closes the panel, ahead of every other key listener on the page.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );

  return { open, close, toggle, startQuickSetup, _refreshGrid: refreshMappingGrid };
};

declare global {
  interface Window {
    ControllerSettings?: ControllerSettingsPanel;
  }
}
