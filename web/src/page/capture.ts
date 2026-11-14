/**
 * Whether this page may take diagnostic pictures of the game canvas (not the
 * WebRTC game video). Moved from web/static/kn-capture.js.
 *
 * One setting, on by default, with a visible opt-out in the lobby and in the
 * in-game menu. `screenshots=off` or `knperf=light` in the URL turns pictures
 * off for the page whatever the setting says. Every reader fails closed: a
 * page without `window.KNCapture` takes no pictures.
 */
import type { SafeStorage } from '../kn-state.ts';

/** localStorage key of the setting: 'on' or 'off'. Absent means on. */
export const CAPTURE_KEY = 'kn-diagnostic-images';

/** What the diagnostics, the engine and the vision client read. */
export interface CapturePolicy {
  /** Pictures may be taken right now. */
  readonly allowed: () => boolean;
  /** The player's choice. Saved; applies to this tab even when saving fails. */
  readonly setEnabled: (value: boolean) => void;
  /** The URL turned pictures off for this page. */
  readonly forcedOff: boolean;
  /**
   * Goes up each time pictures are turned off, here or in another tab. A
   * picture still being encoded is thrown away when this has moved since it
   * was started, even if pictures were turned on again in between.
   */
  readonly revision: number;
}

/** The URL's override: `?screenshots=off` or `?knperf=light`. */
export const urlForcesCaptureOff = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return params.get('screenshots') === 'off' || params.get('knperf') === 'light';
};

/** The saved setting as a choice: anything but 'off' is on. */
export const captureEnabledFrom = (saved: string | null | undefined): boolean => saved !== 'off';

/** The words on the in-game menu's button. */
export const captureButtonText = (allowed: boolean, forcedOff: boolean): string =>
  `Diagnostic images: ${allowed ? 'On' : 'Off'}${forcedOff ? ' (URL override)' : ''}`;

/** The line under the lobby checkbox; empty unless the URL is the reason pictures are off. */
export const captureStatusText = (forcedOff: boolean): string =>
  forcedOff ? 'Images are off for this page because screenshots=off or knperf=light is set in the URL.' : '';

/**
 * A control the policy wires: the lobby checkbox, the menu button or the
 * status line. `checked` and `disabled` are optional because the page hands
 * over plain elements.
 */
interface CaptureControl {
  checked?: boolean;
  disabled?: boolean;
  /** Written as a boolean; an element's own `hidden` can also read 'until-found'. */
  hidden: boolean | string;
  textContent: string | null;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
}

/** A storage event, as far as the policy reads it. */
interface CaptureStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: object | null;
}

/** The part of `window` the policy uses. */
export interface CaptureHost {
  readonly location: { readonly search: string };
  readonly KNStorage?: SafeStorage | undefined;
  readonly localStorage: { readonly getItem: (key: string) => string | null };
  readonly document: {
    readonly readyState: string;
    readonly getElementById: (id: string) => CaptureControl | null;
    readonly addEventListener: (type: string, listener: () => void, options?: { once: boolean }) => void;
  };
  readonly addEventListener: {
    (type: 'storage', listener: (event: CaptureStorageEvent) => void): void;
    (type: 'kn-capture-change', listener: () => void): void;
  };
  readonly dispatchEvent: (event: Event) => boolean | void;
}

/**
 * Read the setting, follow it across tabs, wire the lobby checkbox and the
 * in-game menu button, and return the policy. Changing it never changes the
 * host's separate room-listing consent.
 */
export const startCapture = (host: CaptureHost): CapturePolicy => {
  const forcedOff = urlForcesCaptureOff(host.location.search);
  let enabled = true;
  try {
    enabled = captureEnabledFrom(host.KNStorage?.get('localStorage', CAPTURE_KEY));
  } catch {
    /* storage is blocked: the default stands */
  }
  let revision = 0;
  const allowed = (): boolean => enabled && !forcedOff;

  const update = (value: boolean): void => {
    if (enabled === value) return;
    enabled = value;
    revision++;
    host.dispatchEvent(new CustomEvent('kn-capture-change'));
  };

  const setEnabled = (value: boolean): void => {
    update(!!value);
    try {
      host.KNStorage?.set('localStorage', CAPTURE_KEY, enabled ? 'on' : 'off');
    } catch {
      /* this tab's choice still applies when it cannot be saved */
    }
  };

  host.addEventListener('storage', (event) => {
    if (event.key !== CAPTURE_KEY && event.key !== null) return;
    try {
      const storage = host.localStorage;
      if (event.storageArea !== storage) return;
      // Another tab may have turned pictures on again since, but its opt-out
      // still throws away the pictures this tab was already encoding.
      if (event.newValue === 'off') revision++;
      // Storage events can arrive behind a newer change made in this tab, so
      // the store is read again: an old 'on' never revives capture after a
      // newer opt-out.
      update(captureEnabledFrom(storage.getItem(CAPTURE_KEY)));
    } catch {
      /* storage is blocked: nothing another tab did can be read */
    }
  });

  const wireControls = (): void => {
    const checkbox = host.document.getElementById('opt-diagnostic-images');
    const button = host.document.getElementById('toolbar-diagnostic-images');
    const status = host.document.getElementById('diagnostic-images-status');
    const refresh = (): void => {
      if (checkbox) {
        checkbox.checked = allowed();
        checkbox.disabled = forcedOff;
      }
      if (button) {
        button.setAttribute('aria-checked', String(allowed()));
        button.disabled = forcedOff;
        button.textContent = captureButtonText(allowed(), forcedOff);
      }
      if (status) {
        status.textContent = captureStatusText(forcedOff);
        status.hidden = !forcedOff;
      }
    };
    checkbox?.addEventListener('change', () => setEnabled(checkbox.checked === true));
    button?.addEventListener('click', () => setEnabled(!allowed()));
    host.addEventListener('kn-capture-change', refresh);
    refresh();
  };
  if (host.document.readyState === 'loading') {
    host.document.addEventListener('DOMContentLoaded', wireControls, { once: true });
  } else wireControls();

  return {
    allowed,
    setEnabled,
    forcedOff,
    get revision() {
      return revision;
    },
  };
};
