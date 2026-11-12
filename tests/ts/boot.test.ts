import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOT_HARD_CAP_MS, BOOT_POLL_BUDGET, BOOT_PROGRESS_WINDOW_MS, bootTimedOut } from '../../web/src/boot.ts';

test('inside the poll budget a boot never times out, even with no progress', () => {
  assert.equal(bootTimedOut({ polls: BOOT_POLL_BUDGET, elapsedMs: 30_000, sinceProgressMs: 30_000 }), false);
});

test('past the budget, a stalled boot times out as it always did', () => {
  assert.equal(
    bootTimedOut({ polls: BOOT_POLL_BUDGET + 1, elapsedMs: 30_100, sinceProgressMs: BOOT_PROGRESS_WINDOW_MS }),
    true,
  );
});

test('past the budget, a boot that is still producing frames keeps waiting', () => {
  // The late joiner in a slow environment: 66 of 120 boot frames after 30 s,
  // a new frame every half second.
  assert.equal(bootTimedOut({ polls: BOOT_POLL_BUDGET + 1, elapsedMs: 30_100, sinceProgressMs: 500 }), false);
  assert.equal(bootTimedOut({ polls: 1_000, elapsedMs: 100_000, sinceProgressMs: BOOT_PROGRESS_WINDOW_MS - 1 }), false);
});

test('the hard cap ends even a progressing boot', () => {
  assert.equal(bootTimedOut({ polls: 1_800, elapsedMs: BOOT_HARD_CAP_MS, sinceProgressMs: 0 }), true);
});
