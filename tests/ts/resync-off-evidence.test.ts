import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resyncOffEvidence } from '../resync-off-evidence.mjs';

const ask = '10\t1000.0\tf=2087\tRB-INPUT-ASK f=2087 slot=1 frames=2077..2084 count=8';
const rb = '11\t6100.0\tf=2087\tRB-INPUT-STALL-TIMEOUT f=2087 apply=2084 slot=1 adv=0 stalledMs=5100';
const stale = '11\t6100.0\tf=2087\tPEER-PHANTOM slot=1 lastAdvance=1100 staleSec=5.0 — excluded from pacing';
const evidence = (lines: string[], lastFrame = 2187, dropped = 64) =>
  resyncOffEvidence({ lines, range: [2077, 2085], dropped, lastFrame });

test('resync off distinguishes the two causally equivalent baseline deadlines', () => {
  assert.equal(evidence([ask, rb]).passed, true);
  assert.equal(evidence([ask, rb]).timeout?.path, 'rollback-input-deadline');
  assert.equal(evidence([ask, stale]).passed, true);
  assert.equal(evidence([ask, stale]).timeout?.path, 'peer-stale-deadline');
});
test('resync off rejects unrelated, premature, missing, or non-progressing timeout evidence', () => {
  for (const lines of [
    [rb],
    [stale, ask],
    [ask],
    [ask, stale.replace('slot=1', 'slot=2')],
    [ask, stale.replace('f=2087', 'f=2088')],
    [ask, stale.replace('5.0', '4.9')],
    [ask, stale.replace('lastAdvance=1100', 'lastAdvance=2100')],
    [ask, rb.replace('5100', '4900')],
  ])
    assert.equal(evidence(lines).passed, false);
  assert.equal(evidence([ask, stale], 2100).passed, false);
  assert.equal(evidence([ask, stale], 2187, 0).passed, false);
});
test('resync off rejects hidden recovery activity even when a baseline timeout also occurs', () => {
  for (const activity of [
    'INPUT-ASK-PUSH f=2087 slot=1 hole=2077',
    'INPUT-ASK-PUSH-AGAIN slot=1',
    'INPUT-ASK-PUSH-GAVEUP slot=1',
    'INPUT-ASK-OVERDUE slot=1 → push',
    'escalation push not sent: busy',
    'peer hard-disconnected: guest slot: 1',
    'pushed full state frame 2087',
    'sync sent to slot=1: header + 24 chunks',
  ]) {
    const result = evidence([ask, stale, activity]);
    assert.equal(result.passed, false);
    assert.equal(result.forbidden.length, 1);
  }
});
