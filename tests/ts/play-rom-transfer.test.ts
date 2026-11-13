import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chunkTaken,
  comparable,
  headerRefused,
  IDLE,
  receiverStep,
  ROM_MAX_SIZE,
  romProgress,
  type Receiver,
  type ReceiverEvent,
} from '../../web/src/play/rom-transfer.ts';
import {
  afterChannelClosed,
  afterResumeTimedOut,
  chunkVerdict,
  headerVerdict,
} from '../../web/src/play/rom-transfer-step.ts';

// ── the code these rules restate, kept as an oracle ──────────────────────────
// The receiver in web/static/play.js as of #142: its state variables and what
// each handler does to them, with the channel, the timers and the page taken
// out. play.js is still the code that runs; this is the same logic the
// observer there compares against.

type OldHeader = { size: number; hash: string | undefined };

const oldReceiver = () => {
  let state = 'idle';
  let retries = 0;
  let received = 0;
  let header: OldHeader | null = null;

  const cancel = () => {
    state = 'idle';
    header = null;
    received = 0;
    retries = 0;
  };

  const apply = (event: ReceiverEvent) => {
    switch (event.kind) {
      case 'accept':
        header = null;
        received = 0;
        retries = 0;
        state = 'resuming';
        break;
      case 'game-started':
        if (state === 'idle') state = 'resuming';
        break;
      case 'sharing-off':
        if (state === 'receiving' || state === 'resuming') state = 'paused';
        break;
      case 'sharing-on':
        if (state === 'paused' && received > 0) state = 'resuming';
        else if (state === 'idle') state = 'resuming';
        break;
      case 'retry':
        if (state !== 'paused' && state !== 'idle') return;
        retries = 0;
        state = 'resuming';
        break;
      case 'reconnected':
        retries = 0;
        state = 'resuming';
        break;
      case 'reset':
        cancel();
        break;
      case 'channel':
        if (!(state === 'resuming' || state === 'paused')) {
          header = null;
          received = 0;
          retries = 0;
        }
        state = 'receiving';
        break;
      case 'header':
        if (event.size > ROM_MAX_SIZE) {
          cancel();
          return;
        }
        if (header && (event.hash !== header.hash || event.size !== header.size)) received = 0;
        header = { size: event.size, hash: event.hash };
        break;
      case 'chunk':
        received += event.bytes;
        if (received > ROM_MAX_SIZE) {
          cancel();
          return;
        }
        if (header && received > header.size * 1.1) {
          cancel();
          return;
        }
        break;
      case 'complete':
        state = 'complete';
        // finishRomTransfer: the chunks add up to `received`.
        if (header && header.size !== received) state = 'idle';
        break;
      case 'closed':
        if (state === 'receiving') {
          retries++;
          state = 'paused';
        }
        break;
      case 'backoff-elapsed':
        if (state !== 'paused') return;
        state = 'resuming';
        break;
      case 'resume-timed-out':
        if (state !== 'resuming') return;
        state = 'paused';
        retries++;
        break;
    }
  };
  const view = () =>
    JSON.stringify({
      phase: state,
      retries,
      received,
      headerSize: header?.size ?? null,
      headerHash: header?.hash ?? null,
    });
  return { apply, view };
};

// A small fixed-seed generator, so a failure names a sequence that can be rerun.
const rng = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const KINDS = [
  'accept',
  'game-started',
  'sharing-off',
  'sharing-on',
  'retry',
  'reconnected',
  'reset',
  'channel',
  'header',
  'chunk',
  'chunk',
  'chunk',
  'complete',
  'closed',
  'backoff-elapsed',
  'resume-timed-out',
] as const;

const SIZES = [0, 1000, 65536, 300_000, 16 * 1024 * 1024, ROM_MAX_SIZE, ROM_MAX_SIZE + 1];
const CHUNKS = [0, 1, 1000, 65536, 100_000, 290_000, 8 * 1024 * 1024, ROM_MAX_SIZE];

const randomEvent = (next: () => number): ReceiverEvent => {
  const kind = KINDS[Math.floor(next() * KINDS.length)] ?? 'reset';
  if (kind === 'header') {
    const hash = next() < 0.5 ? 'Saa' : next() < 0.5 ? 'Sbb' : undefined;
    return { kind, size: SIZES[Math.floor(next() * SIZES.length)] ?? 0, hash };
  }
  if (kind === 'chunk') return { kind, bytes: CHUNKS[Math.floor(next() * CHUNKS.length)] ?? 0 };
  return { kind };
};

test('agrees with the receiver in play.js over random transfers', () => {
  let compared = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const next = rng(seed);
    const old = oldReceiver();
    let state: Receiver = IDLE;
    for (let i = 0; i < 80; i++) {
      const event = randomEvent(next);
      old.apply(event);
      state = receiverStep(state, event).state;
      // The observer in play.js compares these two strings.
      assert.equal(JSON.stringify(comparable(state)), old.view(), `seed ${seed}, event ${i}: ${JSON.stringify(event)}`);
      compared++;
    }
  }
  assert.equal(compared, 40_000);
});

test('whole-number size check matches the old floating-point one', () => {
  // The old code compared received > size * 1.1 in floating point; the proved
  // rule compares 10 * received > 11 * size. Check every total near the line
  // for a spread of sizes, including real ROM sizes.
  const sizes = [1, 7, 10, 30, 1000, 4096, 65536, 300_000, 8 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024];
  for (let size = 1; size <= 4000; size++) sizes.push(size);
  let checked = 0;
  for (const size of sizes) {
    const line = Math.floor((size * 11) / 10);
    for (let total = Math.max(0, line - 3); total <= line + 3; total++) {
      assert.equal(chunkTaken(0, total, size), !(total > size * 1.1), `size ${size}, total ${total}`);
      checked++;
    }
  }
  assert.ok(checked > 28_000);
});

const run = (...events: ReceiverEvent[]) => events.reduce((s, e) => receiverStep(s, e).state, IDLE);
const last = (state: Receiver, event: ReceiverEvent) => receiverStep(state, event).next;

test('a transfer from accept to finished', () => {
  const receiving = run(
    { kind: 'accept' },
    { kind: 'channel' },
    { kind: 'header', size: 300_000, hash: 'Saa' },
    { kind: 'chunk', bytes: 200_000 },
    { kind: 'chunk', bytes: 100_000 },
  );
  assert.deepEqual(comparable(receiving), {
    phase: 'receiving',
    retries: 0,
    received: 300_000,
    headerSize: 300_000,
    headerHash: 'Saa',
  });
  assert.equal(last(receiving, { kind: 'complete' }), 'finished');
});

test('a file short of what the host announced is not kept', () => {
  const short = run(
    { kind: 'accept' },
    { kind: 'channel' },
    { kind: 'header', size: 300_000, hash: 'Saa' },
    {
      kind: 'chunk',
      bytes: 100_000,
    },
  );
  const step = receiverStep(short, { kind: 'complete' });
  assert.equal(step.next, 'abandoned');
  assert.equal(step.state.phase, 'idle');
});

test('a closed channel is retried by itself only after part of the file arrived', () => {
  const noBytes = run({ kind: 'accept' }, { kind: 'channel' });
  assert.equal(last(noBytes, { kind: 'closed' }), 'none');
  const someBytes = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'chunk', bytes: 1000 });
  assert.equal(last(someBytes, { kind: 'closed' }), 'ask-after-pause');
});

test('three automatic retries, then the guest decides; Retry starts the count again', () => {
  let state = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'chunk', bytes: 1000 }, { kind: 'closed' });
  const nexts: string[] = [];
  for (let i = 0; i < 3; i++) {
    state = receiverStep(state, { kind: 'backoff-elapsed' }).state;
    const step = receiverStep(state, { kind: 'resume-timed-out' });
    state = step.state;
    nexts.push(step.next);
  }
  assert.deepEqual(nexts, ['ask-after-pause', 'ask-after-pause', 'stalled']);
  assert.equal(state.retries, 4);
  const retried = receiverStep(state, { kind: 'retry' });
  assert.equal(retried.next, 'ask');
  assert.deepEqual([retried.state.phase, retried.state.retries, retried.state.received], ['resuming', 0, 1000]);
});

test('a resumed channel keeps what arrived; a new file from the host drops it', () => {
  const resumed = run(
    { kind: 'accept' },
    { kind: 'channel' },
    { kind: 'header', size: 300_000, hash: 'Saa' },
    { kind: 'chunk', bytes: 100_000 },
    { kind: 'closed' },
    { kind: 'backoff-elapsed' },
    { kind: 'channel' },
  );
  assert.equal(resumed.received, 100_000);
  assert.equal(receiverStep(resumed, { kind: 'header', size: 300_000, hash: 'Saa' }).state.received, 100_000);
  assert.equal(receiverStep(resumed, { kind: 'header', size: 300_000, hash: 'Sbb' }).state.received, 0);
  assert.equal(receiverStep(resumed, { kind: 'header', size: 400_000, hash: 'Saa' }).state.received, 0);
});

test('a ROM past the size limit is refused, by header or by bytes', () => {
  assert.equal(headerRefused(ROM_MAX_SIZE), false);
  assert.equal(headerRefused(ROM_MAX_SIZE + 1), true);
  const receiving = run({ kind: 'accept' }, { kind: 'channel' });
  const refused = receiverStep(receiving, { kind: 'header', size: ROM_MAX_SIZE + 1, hash: undefined });
  assert.deepEqual([refused.next, refused.state], ['abandoned', IDLE]);
  const flooded = receiverStep(receiving, { kind: 'chunk', bytes: ROM_MAX_SIZE + 1 });
  assert.deepEqual([flooded.next, flooded.state], ['abandoned', IDLE]);
});

test('the host turning sharing off pauses, and on again resumes only what had started', () => {
  const receiving = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'chunk', bytes: 1000 });
  const paused = receiverStep(receiving, { kind: 'sharing-off' }).state;
  assert.equal(paused.phase, 'paused');
  assert.equal(last(paused, { kind: 'sharing-on' }), 'ask');
  const pausedEmpty = receiverStep(run({ kind: 'accept' }), { kind: 'sharing-off' }).state;
  assert.equal(last(pausedEmpty, { kind: 'sharing-on' }), 'none');
});

test('the proved decisions, restated over small cases', () => {
  for (let retries = 1; retries <= 6; retries++) {
    for (const received of [0, 1, 1000]) {
      const closed = afterChannelClosed(retries, received);
      assert.equal(closed, retries > 3 ? 'stalled' : received > 0 ? 'retry' : 'wait');
    }
    assert.equal(afterResumeTimedOut(retries), retries <= 3 ? 'retry' : 'stalled');
  }
  assert.equal(chunkVerdict(0, 10, -1, 100), 'accept');
  assert.equal(chunkVerdict(95, 10, -1, 100), 'tooLarge');
  assert.equal(chunkVerdict(0, 111, 100, 1000), 'overHeader');
  assert.equal(chunkVerdict(0, 110, 100, 1000), 'accept');
  assert.equal(headerVerdict(10, 100, false, false), 'keep');
  assert.equal(headerVerdict(10, 100, true, true), 'keep');
  assert.equal(headerVerdict(10, 100, true, false), 'restart');
  assert.equal(headerVerdict(101, 100, true, true), 'tooLarge');
});

test('progress is a whole percentage and megabytes to one place', () => {
  assert.deepEqual(romProgress(0, 0), { percent: 0, text: 'Receiving ROM... 0% (0.0 / 0.0 MB)' });
  assert.deepEqual(romProgress(4 * 1024 * 1024, 16 * 1024 * 1024), {
    percent: 25,
    text: 'Receiving ROM... 25% (4.0 / 16.0 MB)',
  });
});
