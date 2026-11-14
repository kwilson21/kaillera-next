import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  CAPTURE_KEY,
  captureEnabledFrom,
  startCapture,
  urlForcesCaptureOff,
  type CaptureHost,
  type CapturePolicy,
} from '../../web/src/page/capture.ts';

// The policy's behaviour on a page (controls, other tabs, pictures in flight)
// is tests/capture-privacy.test.mjs, which runs the diagnostics and the vision
// client against it. Here the module is held to the script it replaced.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/kn-capture.js as of #166, unchanged.
const OLD_SCRIPT = `/** Shared policy for diagnostic gameplay-canvas capture (not WebRTC game video). */
(function () {
  'use strict';

  const KEY = 'kn-diagnostic-images';
  const params = new URLSearchParams(window.location.search);
  const forcedOff = params.get('screenshots') === 'off' || params.get('knperf') === 'light';
  let enabled = true; // Preserve the existing default, with a visible opt-out.
  try {
    enabled = window.KNStorage?.get('localStorage', KEY) !== 'off';
  } catch (_) {}
  let revision = 0;
  const allowed = () => enabled && !forcedOff;

  function update(value) {
    if (enabled === value) return;
    enabled = value;
    revision++;
    window.dispatchEvent(new CustomEvent('kn-capture-change'));
  }

  function setEnabled(value) {
    update(!!value);
    try {
      window.KNStorage?.set('localStorage', KEY, enabled ? 'on' : 'off');
    } catch (_) {
      // The current tab's choice still applies when persistence is unavailable.
    }
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    try {
      const storage = window.localStorage;
      if (event.storageArea !== storage) return;
      // Even if another tab has since re-enabled images, its queued opt-out
      // must invalidate images that were already being encoded here.
      if (event.newValue === 'off') revision++;
      // Storage events can be queued behind a newer change in this tab.
      // Never revive capture from an old 'on' event after a newer opt-out.
      update(storage.getItem(KEY) !== 'off');
    } catch (_) {
      return;
    }
  });

  window.KNCapture = {
    allowed,
    setEnabled,
    forcedOff,
    get revision() {
      return revision;
    },
  };

  // The lobby and in-game menu share one setting; changing it never changes
  // the host's separate room-listing/live-preview consent.
  function wireControls() {
    const checkbox = document.getElementById('opt-diagnostic-images');
    const button = document.getElementById('toolbar-diagnostic-images');
    const status = document.getElementById('diagnostic-images-status');
    function refresh() {
      if (checkbox) {
        checkbox.checked = allowed();
        checkbox.disabled = forcedOff;
      }
      if (button) {
        button.setAttribute('aria-checked', String(allowed()));
        button.disabled = forcedOff;
        button.textContent = \`Diagnostic images: \${allowed() ? 'On' : 'Off'}\${forcedOff ? ' (URL override)' : ''}\`;
      }
      if (status) {
        status.textContent = forcedOff
          ? 'Images are off for this page because screenshots=off or knperf=light is set in the URL.'
          : '';
        status.hidden = !forcedOff;
      }
    }
    checkbox?.addEventListener('change', () => setEnabled(checkbox.checked));
    button?.addEventListener('click', () => setEnabled(!allowed()));
    window.addEventListener('kn-capture-change', refresh);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireControls, { once: true });
  else wireControls();
})();
`;

/** A storage event as the policy reads it. */
type StorageNews = {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: object | null;
};
type Listener = (event: StorageNews) => void;

/** A control as both versions use it, recording what was done to it. */
interface Control {
  checked: boolean;
  disabled: boolean;
  hidden: boolean | string;
  textContent: string | null;
  readonly attributes: Record<string, string>;
  readonly handlers: Map<string, () => void>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
}

const control = (): Control => {
  const handlers = new Map<string, () => void>();
  const attributes: Record<string, string> = {};
  return {
    checked: false,
    disabled: false,
    hidden: false,
    textContent: null,
    attributes,
    handlers,
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    addEventListener: (type, listener) => {
      handlers.set(type, listener);
    },
  };
};

/** A fake page: storage shared with "another tab", three controls, and window events. */
const page = (search: string, saved: string | null, storageBlocked: boolean) => {
  const stored = new Map<string, string>(saved === null ? [] : [[CAPTURE_KEY, saved]]);
  const storageListeners: Listener[] = [];
  const changeListeners: Listener[] = [];
  function addEventListener(type: 'storage', listener: Listener): void;
  function addEventListener(type: 'kn-capture-change', listener: () => void): void;
  function addEventListener(type: string, listener: Listener): void {
    if (type === 'storage') storageListeners.push(listener);
    else changeListeners.push(listener);
  }
  const checkbox = control();
  const button = control();
  const status = control();
  const controls = new Map([
    ['opt-diagnostic-images', checkbox],
    ['toolbar-diagnostic-images', button],
    ['diagnostic-images-status', status],
  ]);
  const blocked = (): never => {
    throw new Error('blocked');
  };
  const localStorage = { getItem: (key: string) => stored.get(key) ?? null };
  const host: CaptureHost & { KNCapture?: CapturePolicy } = {
    location: { search },
    localStorage,
    KNStorage: {
      get: (_store, key) => (storageBlocked ? blocked() : (stored.get(key) ?? null)),
      set: (_store, key, value) => {
        if (storageBlocked) blocked();
        stored.set(key, value);
      },
      remove: () => undefined,
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => controls.get(id) ?? null,
      addEventListener: () => undefined,
    },
    addEventListener,
    dispatchEvent: () => {
      for (const listener of changeListeners) listener({ key: null, newValue: null, storageArea: null });
      return true;
    },
  };
  /** This page hears a storage event. */
  const hear = (event: StorageNews): void => {
    for (const listener of storageListeners) listener(event);
  };
  /** Another tab writes the setting, and this page hears of it (`heard`, when the event is not the latest write). */
  const otherTab = (value: string | null, heard: string | null = value): void => {
    if (value === null) stored.delete(CAPTURE_KEY);
    else stored.set(CAPTURE_KEY, value);
    hear({ key: CAPTURE_KEY, newValue: heard, storageArea: localStorage });
  };
  return { host, checkbox, button, status, stored, otherTab, hear };
};

type Page = ReturnType<typeof page>;

const startOld = (fake: Page): CapturePolicy => {
  const window = fake.host;
  vm.runInNewContext(OLD_SCRIPT, { window, document: window.document, URLSearchParams, CustomEvent });
  assert.ok(window.KNCapture, 'the old script did not define window.KNCapture');
  return window.KNCapture;
};

const startNew = (fake: Page): CapturePolicy => startCapture(fake.host);

const seen = (c: Control) => ({
  checked: c.checked,
  disabled: c.disabled,
  hidden: c.hidden,
  text: c.textContent,
  attributes: c.attributes,
});

/** Everything a reader or a player can see of the policy. */
const visible = (policy: CapturePolicy, fake: Page) => ({
  allowed: policy.allowed(),
  forcedOff: policy.forcedOff,
  revision: policy.revision,
  saved: fake.stored.get(CAPTURE_KEY) ?? null,
  checkbox: seen(fake.checkbox),
  button: seen(fake.button),
  status: seen(fake.status),
});

type Step = (policy: CapturePolicy, fake: Page) => void;

const STEPS = new Map<string, Step>([
  ['off', (policy) => policy.setEnabled(false)],
  ['on', (policy) => policy.setEnabled(true)],
  [
    'checkboxOff',
    (_, fake) => {
      fake.checkbox.checked = false;
      fake.checkbox.handlers.get('change')?.();
    },
  ],
  [
    'checkboxOn',
    (_, fake) => {
      fake.checkbox.checked = true;
      fake.checkbox.handlers.get('change')?.();
    },
  ],
  ['button', (_, fake) => fake.button.handlers.get('click')?.()],
  ['tabOff', (_, fake) => fake.otherTab('off')],
  ['tabOn', (_, fake) => fake.otherTab('on')],
  ['tabCleared', (_, fake) => fake.otherTab(null)],
  // An opt-out event that arrives after the other tab turned pictures on again.
  ['tabStaleOff', (_, fake) => fake.otherTab('on', 'off')],
  // An old 'on' event that arrives after a newer opt-out.
  ['tabStaleOn', (_, fake) => fake.otherTab('off', 'on')],
]);

test('every sequence of three actions leaves the page as the old script left it', () => {
  const names = [...STEPS.keys()];
  let compared = 0;
  for (const search of ['', '?screenshots=off', '?knperf=light', '?screenshots=on&knperf=full']) {
    for (const saved of [null, 'on', 'off', 'junk']) {
      for (const storageBlocked of [false, true]) {
        for (const a of names) {
          for (const b of names) {
            for (const c of names) {
              const oldPage = page(search, saved, storageBlocked);
              const newPage = page(search, saved, storageBlocked);
              const oldPolicy = startOld(oldPage);
              const newPolicy = startNew(newPage);
              assert.deepEqual(visible(newPolicy, newPage), visible(oldPolicy, oldPage));
              for (const name of [a, b, c]) {
                STEPS.get(name)?.(oldPolicy, oldPage);
                STEPS.get(name)?.(newPolicy, newPage);
                assert.deepEqual(
                  visible(newPolicy, newPage),
                  visible(oldPolicy, oldPage),
                  `${JSON.stringify({ search, saved, storageBlocked })} after ${[a, b, c].join(', ')} (at ${name})`,
                );
                compared++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 4 * 4 * 2 * names.length ** 3 * 3);
});

test('a storage event for another key, or from another store, changes nothing', () => {
  const fake = page('', null, false);
  const policy = startNew(fake);
  fake.stored.set(CAPTURE_KEY, 'off');
  fake.hear({ key: 'something-else', newValue: 'off', storageArea: fake.host.localStorage });
  fake.hear({ key: CAPTURE_KEY, newValue: 'off', storageArea: {} });
  assert.equal(policy.allowed(), true);
  assert.equal(policy.revision, 0);
});

test('the URL override and the saved setting are read as the old script read them', () => {
  assert.equal(urlForcesCaptureOff('?screenshots=off'), true);
  assert.equal(urlForcesCaptureOff('?room=X&knperf=light'), true);
  assert.equal(urlForcesCaptureOff('?screenshots=OFF'), false);
  assert.equal(urlForcesCaptureOff(''), false);
  assert.equal(captureEnabledFrom(null), true);
  assert.equal(captureEnabledFrom(undefined), true);
  assert.equal(captureEnabledFrom('on'), true);
  assert.equal(captureEnabledFrom('off'), false);
});

test('a real window satisfies the host the policy asks for', () => {
  const accepts = (host: CaptureHost): CaptureHost => host;
  const check = (win: Window): CaptureHost => accepts(win);
  assert.equal(typeof check, 'function');
});
