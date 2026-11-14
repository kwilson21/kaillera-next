/**
 * The N64 touch controls for phone and tablet players, in rollback and
 * streaming games alike (window.VirtualGamepad). Not shown for spectators.
 * Moved from web/static/virtual-gamepad.js.
 *
 * It writes touch state into `KNState.touchInput` by input index (the indices
 * EmulatorJS's simulateInput uses); the engines read that object every frame.
 * This file is the page side: building the controls, following fingers and
 * writing the values. Every value it writes is decided in stick.ts and
 * buttons.ts; where the controls sit is decided by the stylesheet in
 * markup.ts.
 */
import type { PageState } from '../../kn-state.ts';
import {
  buttonIndex,
  buttonPlace,
  BUTTONS,
  cornerRadius,
  pointNearButton,
  pointOnButton,
  slideChange,
  SLOP_PX,
} from './buttons.ts';
import { OVERLAY_HTML, OVERLAY_ID } from './markup.ts';
import {
  type Box,
  KNOB_AT_REST,
  knobTransform,
  originOffset,
  type Point,
  STICK_DOWN,
  STICK_LEFT,
  stickOrigin,
  stickReading,
  STICK_RIGHT,
  STICK_UP,
} from './stick.ts';

/** One finger in a touch event. */
export interface PadTouch {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

/** A touch event, as far as the controls read it. */
export interface PadTouchEvent {
  readonly preventDefault: () => void;
  readonly changedTouches: Iterable<PadTouch>;
}

type PadTouchType = 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel';

/**
 * An element of the page, as far as the controls use it. Members that take
 * an element or a listener are written as methods so that a page whose
 * elements are a narrower kind (a real `HTMLElement`, a test's stand-in) fits.
 */
export interface PadElement {
  id: string;
  className: string;
  innerHTML: string;
  textContent: string | null;
  readonly dataset: { idx?: string | undefined };
  readonly style: { display: string; margin: string; transform: string; flex: string };
  readonly classList: { readonly toggle: (name: string, force: boolean) => boolean };
  readonly parentNode: PadElement | null;
  querySelector(selector: string): PadElement | null;
  querySelectorAll(selector: string): Iterable<PadElement>;
  appendChild(child: PadElement): void;
  insertBefore(child: PadElement, before: PadElement): void;
  removeChild(child: PadElement): void;
  cloneNode(deep: boolean): PadElement;
  getBoundingClientRect(): Box;
  addEventListener(type: PadTouchType, listener: (event: PadTouchEvent) => void, options: { passive: boolean }): void;
  removeEventListener(type: PadTouchType, listener: (event: PadTouchEvent) => void): void;
}

/** The part of `window` the controls use. */
export interface VirtualGamepadHost {
  /** Read on every touch, so the engines and the controls always share the object that is there now. */
  readonly KNState?: { readonly touchInput?: PageState['touchInput'] | undefined } | undefined;
  readonly document: {
    readonly body: PadElement;
    createElement(tag: string): PadElement;
    getElementById(id: string): PadElement | null;
    elementFromPoint(x: number, y: number): PadElement | null;
  };
  getComputedStyle(element: PadElement): { readonly borderTopLeftRadius: string };
  readonly console: { readonly log: (message: string) => void };
}

/** `window.VirtualGamepad`: what play.js and the engines call. */
export interface VirtualGamepad {
  /** Build the controls and show them. Does nothing when they are already there. */
  readonly init: () => void;
  /** Take the controls away and set every touch value to 0. */
  readonly destroy: () => void;
  /** Hide the controls while a physical pad is connected, or show them again. Hiding sets every touch value to 0. */
  readonly setVisible: (visible: boolean) => void;
}

/** The controls for one page. Nothing is built until `init` is called. */
export const startVirtualGamepad = (host: VirtualGamepadHost): VirtualGamepad => {
  const doc = host.document;
  let overlay: PadElement | null = null;
  let stickZone: PadElement | null = null;
  let stickKnob: PadElement | null = null;
  /** The buttons in the order a touch is tested against them, as found when the controls were built. */
  let buttons: readonly PadElement[] | null = null;
  /** The finger on the stick and the origin it set; a later finger landing on the stick takes it over. */
  let stickTouch: number | null = null;
  let stickCenter: Point | null = null;
  /** Every other finger that is down, with the input indices it is pressing. */
  let buttonTouches = new Map<number, ReadonlySet<number>>();

  // KNState.touchInput is the canonical touch state object. The controls and
  // the engines read and write it directly; no reference to it is kept.
  const touchValues = (): PageState['touchInput'] | undefined => host.KNState?.touchInput;

  const allButtons = (): Iterable<PadElement> => buttons ?? overlay?.querySelectorAll('.vgp-btn') ?? [];

  /** A button with no size is the copy the stylesheet hides; its style is not read on a touch. */
  const isHidden = (box: Box): boolean => box.width === 0 || box.height === 0;

  /** The first button the point is on, exactly. */
  const buttonAt = (x: number, y: number): PadElement | null => {
    for (const button of allButtons()) {
      const box = button.getBoundingClientRect();
      if (isHidden(box)) continue;
      const radius = cornerRadius(host.getComputedStyle(button).borderTopLeftRadius);
      if (pointOnButton(box, radius, x, y)) return button;
    }
    return null;
  };

  /** The input indices of every button the point is on or within the slop of. */
  const indicesNear = (x: number, y: number): Set<number> => {
    const found = new Set<number>();
    for (const button of allButtons()) {
      const index = buttonIndex(button.dataset.idx);
      if (index === undefined) continue;
      const box = button.getBoundingClientRect();
      if (isHidden(box)) continue;
      const radius = cornerRadius(host.getComputedStyle(button).borderTopLeftRadius);
      if (pointNearButton(box, radius, x, y, SLOP_PX)) found.add(index);
    }
    return found;
  };

  /** Light or dim every copy of a button (Z and Start are on the page twice). */
  const setButtonActive = (index: number, active: boolean): void => {
    if (!overlay) return;
    for (const button of overlay.querySelectorAll(`.vgp-btn[data-idx="${index}"]`)) {
      button.classList.toggle('active', active);
    }
  };

  const updateStick = (clientX: number, clientY: number): void => {
    const values = touchValues();
    if (!stickCenter || !values) return;
    const reading = stickReading(stickCenter, clientX, clientY);
    if (stickKnob) stickKnob.style.transform = knobTransform(reading.knobX, reading.knobY);
    values[STICK_RIGHT] = reading.right;
    values[STICK_LEFT] = reading.left;
    values[STICK_DOWN] = reading.down;
    values[STICK_UP] = reading.up;
  };

  const onTouchStart = (event: PadTouchEvent): void => {
    event.preventDefault();
    for (const touch of event.changedTouches) {
      const target = doc.elementFromPoint(touch.clientX, touch.clientY);

      if (stickZone && (target === stickZone || target === stickKnob || target?.parentNode === stickZone)) {
        stickTouch = touch.identifier;
        const zone = stickZone.getBoundingClientRect();
        stickCenter = stickOrigin(zone, touch.clientX, touch.clientY);
        // Move the knob visual to the new center on contact
        const offset = originOffset(zone, stickCenter);
        if (stickKnob) stickKnob.style.transform = knobTransform(offset.x, offset.y);
        updateStick(touch.clientX, touch.clientY);
        continue;
      }

      // Touchstart uses the exact (non-slop) hit-test so a deliberate tap never
      // accidentally lights up a neighbor. Slop only kicks in on touchmove.
      const index = buttonIndex(buttonAt(touch.clientX, touch.clientY)?.dataset.idx);
      if (index === undefined) {
        // Track the touch even if it didn't land on a button so a slide
        // onto a button later still picks it up.
        buttonTouches.set(touch.identifier, new Set());
        continue;
      }
      buttonTouches.set(touch.identifier, new Set([index]));
      setButtonActive(index, true);
      const values = touchValues();
      if (values) values[index] = 1;
    }
  };

  const onTouchMove = (event: PadTouchEvent): void => {
    event.preventDefault();
    const values = touchValues();
    for (const touch of event.changedTouches) {
      if (touch.identifier === stickTouch && stickCenter) {
        updateStick(touch.clientX, touch.clientY);
        continue;
      }
      const held = buttonTouches.get(touch.identifier);
      if (held === undefined) continue;
      const under = indicesNear(touch.clientX, touch.clientY);
      const change = slideChange(held, under);
      // Release buttons the finger has slid off.
      for (const index of change.released) {
        if (values) values[index] = 0;
        setButtonActive(index, false);
      }
      // Engage buttons the finger has slid onto.
      for (const index of change.pressed) {
        if (values) values[index] = 1;
        setButtonActive(index, true);
      }
      buttonTouches.set(touch.identifier, under);
    }
  };

  /** A finger lifted, or the browser took the touch away: both let go of everything the finger held. */
  const onTouchEnd = (event: PadTouchEvent): void => {
    event.preventDefault();
    for (const touch of event.changedTouches) {
      if (touch.identifier === stickTouch) {
        stickTouch = null;
        stickCenter = null;
        const values = touchValues();
        if (values) {
          values[STICK_RIGHT] = 0;
          values[STICK_LEFT] = 0;
          values[STICK_DOWN] = 0;
          values[STICK_UP] = 0;
        }
        if (stickKnob) stickKnob.style.transform = KNOB_AT_REST;
        continue;
      }
      const held = buttonTouches.get(touch.identifier);
      if (held === undefined) continue;
      buttonTouches.delete(touch.identifier);
      const values = touchValues();
      for (const index of held) {
        if (values) values[index] = 0;
        setButtonActive(index, false);
      }
    }
  };

  const createOverlay = (): void => {
    const root = doc.createElement('div');
    overlay = root;
    root.id = OVERLAY_ID;
    root.innerHTML = OVERLAY_HTML;

    // Place buttons in their containers
    const shoulders = root.querySelector('.vgp-shoulders');
    const startPortrait = root.querySelector('.vgp-start-portrait');
    const startLandscape = root.querySelector('.vgp-start-landscape');
    const zPortrait = root.querySelector('.vgp-z-portrait');
    const zLandscape = root.querySelector('.vgp-z-landscape');
    const dpad = root.querySelector('.vgp-dpad');
    const cbuttons = root.querySelector('.vgp-cbuttons');
    const ab = root.querySelector('.vgp-ab');

    for (const [index, label, className] of BUTTONS) {
      const button = doc.createElement('div');
      button.className = `vgp-btn ${className}`;
      button.textContent = label;
      button.dataset.idx = String(index);

      const place = buttonPlace(className);
      if (place === 'shoulders') {
        shoulders?.appendChild(button);
      } else if (place === 'z') {
        // Portrait: Z in right column below AB. Landscape: own container between cbuttons and AB.
        zPortrait?.appendChild(button);
        zLandscape?.appendChild(button.cloneNode(true));
      } else if (place === 'start') {
        // Start in portrait row, and landscape container
        startPortrait?.appendChild(button);
        startLandscape?.appendChild(button.cloneNode(true));
      } else if (place === 'dpad') {
        dpad?.appendChild(button);
      } else if (place === 'ab') {
        ab?.appendChild(button);
      } else if (place === 'cbuttons') {
        cbuttons?.appendChild(button);
      }
    }

    // Reorder shoulders: L on left — spacer — R on right (Z is next to Start)
    const spacer = doc.createElement('div');
    spacer.style.flex = '1';
    const rButton = shoulders?.querySelector('.vgp-r');
    if (shoulders && rButton) shoulders.insertBefore(spacer, rButton);

    stickZone = root.querySelector('.vgp-stick-zone');
    stickKnob = doc.createElement('div');
    stickKnob.className = 'vgp-stick-knob';
    stickZone?.appendChild(stickKnob);

    root.addEventListener('touchstart', onTouchStart, { passive: false });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', onTouchEnd, { passive: false });
    root.addEventListener('touchcancel', onTouchEnd, { passive: false });

    buttons = [...root.querySelectorAll('.vgp-btn')];

    doc.body.appendChild(root);
  };

  const clearState = (): void => {
    const values = touchValues();
    if (!values) return;
    for (const key of Object.keys(values)) {
      values[key] = 0;
    }
  };

  return {
    init: () => {
      if (overlay) return;
      createOverlay();
      // Shrink game to share space — gamepad is an in-flow sibling
      const game = doc.getElementById('game');
      if (game) game.style.margin = '0';
      host.console.log('[virtual-gamepad] initialized');
    },

    destroy: () => {
      if (overlay) {
        overlay.removeEventListener('touchstart', onTouchStart);
        overlay.removeEventListener('touchmove', onTouchMove);
        overlay.removeEventListener('touchend', onTouchEnd);
        overlay.removeEventListener('touchcancel', onTouchEnd);
        overlay.parentNode?.removeChild(overlay);
        overlay = null;
      }
      buttons = null;
      clearState();
      stickTouch = null;
      stickCenter = null;
      buttonTouches = new Map();
      const game = doc.getElementById('game');
      if (game) game.style.margin = '';
      host.console.log('[virtual-gamepad] destroyed');
    },

    setVisible: (visible) => {
      if (overlay) {
        overlay.style.display = visible ? '' : 'none';
        if (!visible) clearState();
      }
      const game = doc.getElementById('game');
      if (game) game.style.margin = visible ? '0' : 'auto 0';
    },
  };
};
