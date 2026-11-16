import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inviteLinks,
  moreMenuMaxHeight,
  moreMenuPlacement,
  shareFailureIsWorthTelling,
} from '../../web/src/play/menus.ts';

// The DOM half of menus.ts and notices.ts runs in a real browser in
// tests/test_play_menus_e2e.py; these are the parts that are plain arithmetic.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// positionMoreDropdown in web/static/play.js as of #140, with the rectangles
// and window width as parameters.
const oldPlacement = (rect: { top: number; right: number }, menu: { width: number; height: number }, inner: number) => {
  const gap = 6;
  const edge = 8;
  return {
    maxHeight: Math.max(160, rect.top - edge - gap),
    left: Math.min(inner - menu.width - edge, Math.max(edge, rect.right - menu.width)),
    top: Math.max(edge, rect.top - menu.height - gap),
  };
};

test('the More menu is placed where the old code placed it', () => {
  let compared = 0;
  for (const inner of [320, 375, 768, 1280]) {
    for (const top of [0, 40, 200, 700]) {
      for (const right of [30, 180, inner - 4, inner + 20]) {
        for (const width of [120, 220, 400]) {
          for (const height of [80, 300, 900]) {
            const button = { top, right };
            const menu = { width, height };
            assert.deepEqual(
              { maxHeight: moreMenuMaxHeight(button), ...moreMenuPlacement(button, menu, inner) },
              oldPlacement(button, menu, inner),
            );
            compared++;
          }
        }
      }
    }
  }
  assert.equal(compared, 576);
});

test('the More menu sits above its button with right edges aligned', () => {
  assert.deepEqual(moreMenuPlacement({ top: 700, right: 1000 }, { width: 200, height: 300 }, 1280), {
    left: 800,
    top: 394,
  });
});

test('the More menu stays on screen', () => {
  // Button near the left edge: the menu cannot start left of the margin.
  assert.equal(moreMenuPlacement({ top: 700, right: 100 }, { width: 200, height: 300 }, 1280).left, 8);
  // Button past the right edge: the menu ends at the margin.
  assert.equal(moreMenuPlacement({ top: 700, right: 1300 }, { width: 200, height: 300 }, 1280).left, 1072);
  // No room above: the menu starts at the top margin.
  assert.equal(moreMenuPlacement({ top: 100, right: 1000 }, { width: 200, height: 300 }, 1280).top, 8);
});

test('the More menu may fill the room above the button, and never shrinks below 160', () => {
  assert.equal(moreMenuMaxHeight({ top: 700, right: 0 }), 686);
  assert.equal(moreMenuMaxHeight({ top: 60, right: 0 }), 160);
});

test('a room has a Play link and a Watch link, each named for its toast and share sheet', () => {
  assert.deepEqual(inviteLinks('https://x/join?room=A', 'https://x/join?room=A&spectate=1'), {
    play: { url: 'https://x/join?room=A', label: 'Play link', title: 'Join my game on Kaillera Next' },
    watch: { url: 'https://x/join?room=A&spectate=1', label: 'Watch link', title: 'Watch my game on Kaillera Next' },
  });
});

test('closing the share sheet is not a failure; anything else is', () => {
  assert.equal(shareFailureIsWorthTelling('AbortError'), false);
  assert.equal(shareFailureIsWorthTelling('NotAllowedError'), false);
  assert.equal(shareFailureIsWorthTelling('DataError'), true);
  assert.equal(shareFailureIsWorthTelling(''), true);
});
