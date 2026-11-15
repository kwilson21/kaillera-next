import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  answersAnOlderRequest,
  endsRequest,
  isLateAnswerBeforeFrameAsked,
  keepsAwaitedAnswer,
  lateJoinLostHostStep,
  type LostHostStep,
} from '../../web/src/resync-request.ts';

const BOOLS = [false, true];
// Request numbers: 0 is no request; the engine's numbers start at 1.
const IDS = [0, 1, 2, 3];
const FRAMES = [-1, 0, 1, 50, 99, 100, 101, 200];
// What the engine holds: -1 for nothing held.
const HELD = [-1, 0, 1, 2, 3];

test('only its own answer ends a request', () => {
  assert.equal(endsRequest(2, 2, true), true);
  assert.equal(endsRequest(2, 2, false), true);
  // The answer to a request given up on, whether or not the host numbers.
  assert.equal(endsRequest(1, 2, true), false);
  assert.equal(endsRequest(1, 2, false), false);
  // A number from a newer request than this page knows of is not its own either.
  assert.equal(endsRequest(3, 2, true), false);
});

test('a state with no number ends a request only while the host has not numbered one', () => {
  assert.equal(endsRequest(0, 2, false), true);
  assert.equal(endsRequest(0, 2, true), false);
  assert.equal(endsRequest(0, 0, false), true);
  assert.equal(endsRequest(0, 0, true), false);
});

test('an older request is a numbered one other than the newest', () => {
  assert.equal(answersAnOlderRequest(1, 2), true);
  assert.equal(answersAnOlderRequest(3, 2), true);
  assert.equal(answersAnOlderRequest(2, 2), false);
  assert.equal(answersAnOlderRequest(0, 2), false);
  assert.equal(answersAnOlderRequest(0, 0), false);
});

test('a late answer from before the frame the newest request named is dropped', () => {
  assert.equal(isLateAnswerBeforeFrameAsked(1, 99, 2, 100), true);
  // At or after the frame asked it does not take the guest back.
  assert.equal(isLateAnswerBeforeFrameAsked(1, 100, 2, 100), false);
  assert.equal(isLateAnswerBeforeFrameAsked(1, 101, 2, 100), false);
});

test("the newest request's own answer, and a state with no number, are never dropped", () => {
  assert.equal(isLateAnswerBeforeFrameAsked(2, 10, 2, 100), false);
  assert.equal(isLateAnswerBeforeFrameAsked(0, 10, 2, 100), false);
});

test('a request that named no frame drops nothing', () => {
  assert.equal(isLateAnswerBeforeFrameAsked(1, 10, 2, -1), false);
  assert.equal(isLateAnswerBeforeFrameAsked(1, -5, 2, 0), false);
});

test('an older answer does not replace the held answer to the newest request', () => {
  assert.equal(keepsAwaitedAnswer(1, 2, 2), true);
  // What is held is not the awaited answer: the older one is buffered as before.
  assert.equal(keepsAwaitedAnswer(1, 2, 1), false);
  assert.equal(keepsAwaitedAnswer(1, 2, 0), false);
  assert.equal(keepsAwaitedAnswer(1, 2, -1), false);
});

test("the newest request's own answer, and a state with no number, are always buffered", () => {
  assert.equal(keepsAwaitedAnswer(2, 2, 2), false);
  assert.equal(keepsAwaitedAnswer(0, 2, 2), false);
});

test('the lost-host step does nothing unless a running joiner lost the host channel', () => {
  for (const channelOpen of BOOLS) {
    for (const out of BOOLS) {
      for (const asks of [0, 3, 5]) {
        assert.equal(lateJoinLostHostStep(false, false, true, channelOpen, out, asks, 3), 'idle');
        assert.equal(lateJoinLostHostStep(true, true, true, channelOpen, out, asks, 3), 'idle');
        assert.equal(lateJoinLostHostStep(true, false, false, channelOpen, out, asks, 3), 'idle');
      }
    }
  }
});

test('the lost-host step waits for the channel, then for a request already out', () => {
  assert.equal(lateJoinLostHostStep(true, false, true, false, false, 0, 3), 'waitForChannel');
  assert.equal(lateJoinLostHostStep(true, false, true, false, true, 3, 3), 'waitForChannel');
  assert.equal(lateJoinLostHostStep(true, false, true, true, true, 0, 3), 'inFlight');
  assert.equal(lateJoinLostHostStep(true, false, true, true, true, 3, 3), 'inFlight');
});

test('the lost-host step asks up to the bound, then gives up', () => {
  const steps: LostHostStep[] = [];
  for (let asks = 0; asks <= 4; asks++) steps.push(lateJoinLostHostStep(true, false, true, true, false, asks, 3));
  assert.deepEqual(steps, ['ask', 'ask', 'ask', 'giveUp', 'giveUp']);
});

// The engine's rules (web/static/netplay-rollback.js), copied as they are
// written there, over the engine's own variables.
const engine = {
  ends: (answerFor: number, resyncRequestId: number, hostNumbersAnswers: boolean) =>
    answerFor > 0 ? answerFor === resyncRequestId : !hostNumbersAnswers,
  older: (answerFor: number, resyncRequestId: number) => answerFor > 0 && answerFor !== resyncRequestId,
  late: (state: { answerFor?: number; frame: number } | null, resyncRequestId: number, resyncRequestAt: number) =>
    !!state &&
    engine.older(state.answerFor || 0, resyncRequestId) &&
    resyncRequestAt > 0 &&
    state.frame < resyncRequestAt,
  keeps: (answerFor: number, resyncRequestId: number, pending: { answerFor?: number } | null) =>
    !(!engine.older(answerFor, resyncRequestId) || pending?.answerFor !== resyncRequestId),
  lostHost: (
    lateJoinLostHost: boolean,
    playerSlot: number,
    running: boolean,
    hostDcOpen: boolean,
    inFlight: boolean,
    asks: number,
    max: number,
  ): LostHostStep => {
    if (!lateJoinLostHost || playerSlot === 0 || !running) return 'idle';
    if (!hostDcOpen) return 'waitForChannel';
    if (inFlight) return 'inFlight';
    if (asks >= max) return 'giveUp';
    return 'ask';
  },
};

test("the proved rules agree with the engine's over a grid of inputs", () => {
  let cases = 0;
  for (const answerFor of IDS) {
    for (const newest of IDS) {
      for (const hostNumbers of BOOLS) {
        assert.equal(endsRequest(answerFor, newest, hostNumbers), engine.ends(answerFor, newest, hostNumbers));
        cases++;
      }
      assert.equal(answersAnOlderRequest(answerFor, newest), engine.older(answerFor, newest));
      for (const frame of FRAMES) {
        for (const askedAt of FRAMES) {
          assert.equal(
            isLateAnswerBeforeFrameAsked(answerFor, frame, newest, askedAt),
            engine.late({ answerFor, frame }, newest, askedAt),
            `answerFor=${answerFor} frame=${frame} newest=${newest} askedAt=${askedAt}`,
          );
          cases++;
        }
      }
      // A held state with no answerFor at all reads as 0, as the engine does.
      for (const frame of FRAMES) {
        assert.equal(isLateAnswerBeforeFrameAsked(0, frame, newest, 100), engine.late({ frame }, newest, 100));
      }
      for (const held of HELD) {
        const pending = held < 0 ? null : { answerFor: held };
        assert.equal(keepsAwaitedAnswer(answerFor, newest, held), engine.keeps(answerFor, newest, pending));
        cases++;
      }
      // A held state without a number: the engine passes -1 for it.
      assert.equal(keepsAwaitedAnswer(answerFor, newest, -1), engine.keeps(answerFor, newest, {}));
    }
  }
  for (const marked of BOOLS) {
    for (const playerSlot of [0, 1, 2, 3]) {
      for (const running of BOOLS) {
        for (const channelOpen of BOOLS) {
          for (const out of BOOLS) {
            for (const asks of [0, 1, 2, 3, 4]) {
              assert.equal(
                lateJoinLostHostStep(marked, playerSlot === 0, running, channelOpen, out, asks, 3),
                engine.lostHost(marked, playerSlot, running, channelOpen, out, asks, 3),
              );
              cases++;
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 1000);
});

test('the engine runs each proved rule beside its own and reports a difference', () => {
  const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
  const observed = {
    'ends-request': 'endsRequest',
    'answers-an-older-request': 'answersAnOlderRequest',
    'late-answer-before-frame-asked': 'isLateAnswerBeforeFrameAsked',
    'keeps-awaited-answer': 'keepsAwaitedAnswer',
    'late-join-lost-host': 'lateJoinLostHostStep',
  };
  for (const [what, name] of Object.entries(observed)) {
    assert.ok(source.includes(`'${what}',`) || source.includes(`'${what}', `), `${what} is not compared`);
    assert.ok(source.includes(`rules.${name}(`), `${name} is not called by the engine`);
  }
  assert.ok(source.includes("window.KNEvent?.('resync-disagree', message, { old, next });"));
  // Observing only: the engine's own rules are still the ones returned.
  assert.ok(source.includes('answerFor > 0 ? answerFor === _resyncRequestId : !_hostNumbersAnswers'));
  assert.ok(source.includes('answerFor > 0 && answerFor !== _resyncRequestId'));
  assert.ok(source.includes('_resyncRequestAt > 0 && state.frame < _resyncRequestAt'));
  assert.ok(
    source.includes('_answersAnOlderRequest(answerFor) && _pendingResyncState?.answerFor === _resyncRequestId'),
  );
  assert.ok(source.includes('if (!rules) return engineValue;'));
});

test('the module is listed for the proofs', () => {
  const listed = readFileSync(new URL('../../LemmaScript-files.txt', import.meta.url), 'utf8').split('\n');
  assert.ok(listed.some((line) => line.trim().split(/\s+/)[0] === 'web/src/resync-request.ts'));
});
