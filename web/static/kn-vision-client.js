/**
 * kn-vision-client.js — Bridges KNDesync.events 'desync-suspect' to
 * /api/desync-vision. Captures canvas, downscales to ≤512px, POSTs.
 *
 * Design intent: thin. No business logic. The detector decided this
 * frame deserves a verdict; the vision client just delivers the
 * goods.
 */
(function () {
  'use strict';

  const TARGET_WIDTH = 512;
  const POST_PATH = '/api/desync-vision';

  async function _captureScaledPng() {
    if (!window.KNCapture?.allowed()) return null;
    const revision = KNCapture.revision;
    const src = document.querySelector('#game canvas');
    if (!src || !src.width || !src.height) return null;
    const ratio = TARGET_WIDTH / src.width;
    const scaled = document.createElement('canvas');
    scaled.width = Math.round(src.width * ratio);
    scaled.height = Math.round(src.height * ratio);
    const ctx = scaled.getContext('2d');
    ctx.drawImage(src, 0, 0, scaled.width, scaled.height);
    const blob = await new Promise((resolve) => scaled.toBlob(resolve, 'image/png'));
    if (!blob || !KNCapture.allowed() || revision !== KNCapture.revision) return null;
    const buf = await blob.arrayBuffer();
    if (!KNCapture.allowed() || revision !== KNCapture.revision) return null;
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  async function _onSuspect(detail) {
    if (!detail || !detail.matchId || !window.KNCapture?.allowed()) return;
    const revision = KNCapture.revision;
    let localPng;
    try {
      localPng = await _captureScaledPng();
    } catch (e) {
      console.warn('[KNVision] capture failed', e);
      return;
    }
    // A disable/re-enable while toBlob or arrayBuffer is pending must not
    // revive an image captured before the user opted out.
    if (!localPng || !KNCapture.allowed() || revision !== KNCapture.revision) return;

    const body = {
      match_id: detail.matchId,
      frame: detail.frame,
      field: detail.field,
      slot: detail.slot,
      trigger: detail.trigger,
      peers: [{ slot: KNState.slot ?? 0, png_b64: localPng, hash: detail.hashes?.local ?? null }],
      replay_meta: detail.replayMeta,
    };

    try {
      const res = await fetch(POST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      console.log('[KNVision] response:', json);
    } catch (e) {
      console.warn('[KNVision] POST failed', e);
    }
  }

  function _wire() {
    if (window.KNDesync && KNDesync.events) {
      KNDesync.events.addEventListener('desync-suspect', (e) => _onSuspect(e.detail));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    _wire();
  }

  window.KNVision = { _captureScaledPng, _onSuspect };
})();
