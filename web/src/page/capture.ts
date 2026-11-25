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
const DECLINED_MATCH_KEY = 'kn-diagnostic-images-declined-match';

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
  readonly KNDiag?: { readonly options?: { readonly local: boolean } } | undefined;
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
export const startCapture = (host: CaptureHost): CapturePolicy & { setMatch: (id: string | null) => void } => {
  const forcedOff = urlForcesCaptureOff(host.location.search);
  const matchOptOut = !host.KNDiag?.options?.local;
  let matchId: string | null = null;
  let declinedMatch: string | null = null;
  let enabled = true;
  try {
    enabled = captureEnabledFrom(host.KNStorage?.get('localStorage', CAPTURE_KEY));
    if (matchOptOut) declinedMatch = host.KNStorage?.get('sessionStorage', DECLINED_MATCH_KEY) ?? null;
  } catch {
    /* storage is blocked: the default stands */
  }
  let revision = 0;
  const declined = (): boolean => matchId !== null && declinedMatch === matchId;
  const allowed = (): boolean => enabled && !forcedOff && !declined();
  const notify = (): void => {
    host.dispatchEvent(new CustomEvent('kn-capture-change'));
  };

  // A lobby in another tab may opt in for future matches. An opt-out in this
  // match outlives that preference change and a reload of the playing tab.
  const declineMatch = (): boolean => {
    if (matchId === null || declined()) return false;
    declinedMatch = matchId;
    try {
      host.KNStorage?.set('sessionStorage', DECLINED_MATCH_KEY, matchId);
    } catch {
      /* this tab still observes the opt-out when storage is blocked */
    }
    return true;
  };

  const setMatch = (id: string | null): void => {
    if (!matchOptOut || id === matchId) return;
    const wasAllowed = allowed();
    matchId = id;
    if (!enabled) declineMatch();
    if (wasAllowed !== allowed()) revision++;
    notify();
  };

  const update = (value: boolean, sawOptOut = !value): void => {
    const declinedNow = sawOptOut && declineMatch();
    if (enabled === value && !declinedNow) return;
    enabled = value;
    revision++;
    notify();
  };

  const setEnabled = (value: boolean): void => {
    if (value && declined()) return;
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
      const saved = captureEnabledFrom(storage.getItem(CAPTURE_KEY));
      update(saved, !saved || event.newValue === 'off');
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
        checkbox.disabled = forcedOff || declined();
      }
      if (button) {
        button.setAttribute('aria-checked', String(allowed()));
        button.disabled = forcedOff || declined();
        button.textContent =
          declined() && !forcedOff
            ? 'Diagnostic images: Off (enable in lobby)'
            : captureButtonText(allowed(), forcedOff);
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
    setMatch,
    setEnabled,
    forcedOff,
    get revision() {
      return revision;
    },
  };
};
