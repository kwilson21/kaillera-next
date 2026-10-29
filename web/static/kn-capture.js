/** Shared policy for diagnostic gameplay-canvas capture (not WebRTC game video). */
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
        button.textContent = `Diagnostic images: ${allowed() ? 'On' : 'Off'}${forcedOff ? ' (URL override)' : ''}`;
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
