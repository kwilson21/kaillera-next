// Around a join every page applies the same input for every slot
// (web/src/late-join-input-rule.ts; specs/late_join_input_agreement.qnt).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KNCore } from '../../web/src/index.ts';
import { MASK_LEAD } from '../../web/src/controller-mask.ts';
import {
  admittedLate,
  bridgeOffered,
  joinerHoldsOwnInput,
  legacyBootstrap,
} from '../../web/src/late-join-input-rule.ts';

test('the old Remix bootstrap runs only on Remix in a match on the immediate rule', () => {
  assert.equal(legacyBootstrap(true, false), true);
  assert.equal(legacyBootstrap(true, true), false);
  assert.equal(legacyBootstrap(false, false), false);
  assert.equal(legacyBootstrap(false, true), false);
});

test('the host sends the input bridge on every ROM, on Remix when the match is scheduled', () => {
  assert.equal(bridgeOffered(false, false), true);
  assert.equal(bridgeOffered(false, true), true);
  assert.equal(bridgeOffered(true, true), true);
  // A match with a page from before the rule: Remix keeps the old way.
  assert.equal(bridgeOffered(true, false), false);
});

test('the joiner holds its own input until it hears the roster, and below its frame + lead', () => {
  // The four-player rejoin run: state and roster at 1118.
  assert.equal(joinerHoldsOwnInput(1143, -1, MASK_LEAD), true);
  assert.equal(joinerHoldsOwnInput(5000, -1, MASK_LEAD), true);
  assert.equal(joinerHoldsOwnInput(1118, 1118, MASK_LEAD), true);
  assert.equal(joinerHoldsOwnInput(1177, 1118, MASK_LEAD), true);
  // Its controller is present from 1178 on every page.
  assert.equal(joinerHoldsOwnInput(1178, 1118, MASK_LEAD), false);
  assert.equal(joinerHoldsOwnInput(1300, 1118, MASK_LEAD), false);
});

test('a page that ran a joiner tag past the hold as absent heard the roster late', () => {
  assert.equal(admittedLate(1118, 1117, MASK_LEAD), false);
  assert.equal(admittedLate(1118, 1177, MASK_LEAD), false);
  assert.equal(admittedLate(1118, 1178, MASK_LEAD), true);
  // Every tag the joiner may send for real is past what a page on time ran.
  for (let ran = 1100; ran < 1250; ran++) {
    if (!admittedLate(1118, ran, MASK_LEAD)) {
      for (let tag = 1118; tag <= ran; tag++) assert.equal(joinerHoldsOwnInput(tag, 1118, MASK_LEAD), true);
    }
  }
});

test('the bundle exposes the rules', () => {
  assert.equal(KNCore.lateJoinInput.legacyBootstrap, legacyBootstrap);
  assert.equal(KNCore.lateJoinInput.bridgeOffered, bridgeOffered);
  assert.equal(KNCore.lateJoinInput.joinerHoldsOwnInput, joinerHoldsOwnInput);
  assert.equal(KNCore.lateJoinInput.admittedLate, admittedLate);
});
