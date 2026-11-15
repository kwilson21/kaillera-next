import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  answersAnOlderRequest,
  endsRequest,
  isLateAnswerBehind,
  keepsAwaitedAnswer,
  lateJoinLostHostStep,
  resyncDeadlineStep,
  type DeadlineStep,
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
  // The guest is at 98, short of the frame asked: the target's deadline gave it up.
  assert.equal(isLateAnswerBehind(1, 99, 2, 100, 98), true);
  // At or after the frame asked, and at or ahead of the guest, it does not take the guest back.
  assert.equal(isLateAnswerBehind(1, 100, 2, 100, 100), false);
  assert.equal(isLateAnswerBehind(1, 101, 2, 100, 100), false);
});

test('a late answer from before the frame the guest is on is dropped, whether or not a frame was named', () => {
  // The run that found it: an immediate request, then the first answer (frame 864) with the guest at 994.
  assert.equal(isLateAnswerBehind(1, 864, 2, -1, 994), true);
  assert.equal(isLateAnswerBehind(1, 864, 2, 0, 994), true);
  // Past the frame named, but behind the guest.
  assert.equal(isLateAnswerBehind(1, 101, 2, 100, 102), true);
  // One frame behind is behind.
  assert.equal(isLateAnswerBehind(1, 993, 2, -1, 994), true);
});

test("the newest request's own answer, and a state with no number, are never dropped", () => {
  assert.equal(isLateAnswerBehind(2, 10, 2, 100, 50), false);
  assert.equal(isLateAnswerBehind(0, 10, 2, 100, 50), false);
  assert.equal(isLateAnswerBehind(2, 864, 2, -1, 994), false);
  assert.equal(isLateAnswerBehind(0, 864, 2, -1, 994), false);
});

test('a late answer at or ahead of the guest is kept when no frame was named', () => {
  assert.equal(isLateAnswerBehind(1, 994, 2, -1, 994), false);
  assert.equal(isLateAnswerBehind(1, 1000, 2, -1, 994), false);
  assert.equal(isLateAnswerBehind(1, -5, 2, 0, -5), false);
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

test('the deadline waits while an answer is coming, decoding, or not yet due', () => {
  // requestOut, answerComing, decoding, decodingForMs, graceMs, waitedMs, timeoutMs, lostHost, owed, asksAgain, max
  assert.equal(resyncDeadlineStep(false, false, false, 0, 10000, 99999, 8000, false, true, 0, 2), 'noRequest');
  assert.equal(resyncDeadlineStep(true, true, false, 0, 10000, 99999, 8000, false, true, 0, 2), 'wait');
  assert.equal(resyncDeadlineStep(true, false, true, 9999, 10000, 99999, 8000, false, true, 0, 2), 'wait');
  assert.equal(resyncDeadlineStep(true, false, false, 0, 10000, 7999, 8000, false, true, 0, 2), 'wait');
  // A decode past its grace no longer holds the deadline off (I1).
  assert.equal(resyncDeadlineStep(true, false, true, 10000, 10000, 99999, 8000, false, true, 0, 2), 'askAgain');
});

test('at the deadline an owed resync is asked for again up to the bound, then given up', () => {
  const steps: DeadlineStep[] = [];
  for (let asks = 0; asks <= 3; asks++) {
    steps.push(resyncDeadlineStep(true, false, false, 0, 10000, 8000, 8000, false, true, asks, 2));
  }
  assert.deepEqual(steps, ['askAgain', 'askAgain', 'stopAsking', 'stopAsking']);
  // Nothing owed (a coordinated request): let go; the desync check asks again.
  assert.equal(resyncDeadlineStep(true, false, false, 0, 10000, 8000, 8000, false, false, 0, 2), 'letGo');
  // The late joiner's lost-host resync goes first, owed or not.
  assert.equal(resyncDeadlineStep(true, false, false, 0, 10000, 8000, 8000, true, true, 0, 2), 'lostHost');
  assert.equal(resyncDeadlineStep(true, false, false, 0, 10000, 8000, 8000, true, false, 5, 2), 'lostHost');
});

// The engine's rules (web/static/netplay-rollback.js), copied as they are
// written there, over the engine's own variables.
const engine = {
  ends: (answerFor: number, resyncRequestId: number, hostNumbersAnswers: boolean) =>
    answerFor > 0 ? answerFor === resyncRequestId : !hostNumbersAnswers,
  older: (answerFor: number, resyncRequestId: number) => answerFor > 0 && answerFor !== resyncRequestId,
  late: (
    state: { answerFor?: number; frame: number } | null,
    resyncRequestId: number,
    resyncRequestAt: number,
    frameNum: number,
  ) =>
    !!state &&
    engine.older(state.answerFor || 0, resyncRequestId) &&
    (state.frame < frameNum || (resyncRequestAt > 0 && state.frame < resyncRequestAt)),
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
  // _checkResyncRequestDeadline: the returns and the step it computes.
  deadline: (
    inFlight: boolean,
    answerComing: boolean,
    decoding: boolean,
    decodingForMs: number,
    graceMs: number,
    waitedMs: number,
    timeoutMs: number,
    lateJoinLostHost: boolean,
    owedResync: boolean,
    asksAgain: number,
    max: number,
  ): DeadlineStep => {
    if (!inFlight) return 'noRequest';
    if (answerComing || (decoding && decodingForMs < graceMs)) return 'wait';
    if (waitedMs < timeoutMs) return 'wait';
    if (lateJoinLostHost) return 'lostHost';
    if (!owedResync) return 'letGo';
    if (asksAgain >= max) return 'stopAsking';
    return 'askAgain';
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
          for (const guestFrame of FRAMES) {
            assert.equal(
              isLateAnswerBehind(answerFor, frame, newest, askedAt, guestFrame),
              engine.late({ answerFor, frame }, newest, askedAt, guestFrame),
              `answerFor=${answerFor} frame=${frame} newest=${newest} askedAt=${askedAt} guestFrame=${guestFrame}`,
            );
            cases++;
          }
        }
      }
      // A held state with no answerFor at all reads as 0, as the engine does.
      for (const frame of FRAMES) {
        for (const guestFrame of FRAMES) {
          assert.equal(
            isLateAnswerBehind(0, frame, newest, 100, guestFrame),
            engine.late({ frame }, newest, 100, guestFrame),
          );
        }
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
  for (const out of BOOLS) {
    for (const coming of BOOLS) {
      for (const decoding of BOOLS) {
        for (const decodingForMs of [0, 9999, 10000, 20000]) {
          for (const waitedMs of [0, 7999, 8000, 30000]) {
            for (const lostHost of BOOLS) {
              for (const owed of BOOLS) {
                for (const asks of [0, 1, 2, 3]) {
                  const args = [
                    out,
                    coming,
                    decoding,
                    decodingForMs,
                    10000,
                    waitedMs,
                    8000,
                    lostHost,
                    owed,
                    asks,
                    2,
                  ] as const;
                  assert.equal(resyncDeadlineStep(...args), engine.deadline(...args));
                  cases++;
                }
              }
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
    'late-answer-behind': 'isLateAnswerBehind',
    'keeps-awaited-answer': 'keepsAwaitedAnswer',
    'late-join-lost-host': 'lateJoinLostHostStep',
    'deadline-step': 'resyncDeadlineStep',
  };
  for (const [what, name] of Object.entries(observed)) {
    assert.ok(source.includes(`'${what}',`) || source.includes(`'${what}', `), `${what} is not compared`);
    assert.ok(source.includes(`rules.${name}(`), `${name} is not called by the engine`);
  }
  assert.ok(source.includes("window.KNEvent?.('resync-disagree', message, { old, next });"));
  // Observing only: the engine's own rules are still the ones returned.
  assert.ok(source.includes('answerFor > 0 ? answerFor === _resyncRequestId : !_hostNumbersAnswers'));
  assert.ok(source.includes('answerFor > 0 && answerFor !== _resyncRequestId'));
  assert.ok(source.includes('(state.frame < _frameNum || (_resyncRequestAt > 0 && state.frame < _resyncRequestAt))'));
  assert.ok(
    source.includes('_answersAnOlderRequest(answerFor) && _pendingResyncState?.answerFor === _resyncRequestId'),
  );
  assert.ok(source.includes('if (!rules) return engineValue;'));
});

test('the module is listed for the proofs', () => {
  const listed = readFileSync(new URL('../../LemmaScript-files.txt', import.meta.url), 'utf8').split('\n');
  assert.ok(listed.some((line) => line.trim().split(/\s+/)[0] === 'web/src/resync-request.ts'));
});
