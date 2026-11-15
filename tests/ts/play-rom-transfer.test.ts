import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDLE,
  pausedText,
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

// ── the code these rules replaced, kept as an oracle ─────────────────────────
// The receiver in web/static/play.js as of #142: its state variables and what
// each handler did to them, with the channel, the timers and the page taken
// out. play.js now keeps its transfer in `receiverStep`'s state.

/** A transfer laid out as play.js held its own (`view` below). */
const comparable = (state: Receiver) => ({
  phase: state.phase,
  retries: state.retries,
  received: state.received,
  headerSize: state.header?.size ?? null,
  headerHash: state.header?.hash ?? null,
});

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
        // Changed since, on purpose: a paused transfer resumes whether or
        // not any of the file arrived (it used to need some). See the
        // nothing-received tests below.
        if (state === 'paused' || state === 'idle') state = 'resuming';
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
        // finishRomTransfer: the chunks add up to `received`. Changed since,
        // on purpose: a short file drops the count and header with the bytes
        // (it used to set only the phase to idle). See the short-file test.
        if (header && header.size !== received) cancel();
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
      const taken = chunkVerdict(0, total, size, ROM_MAX_SIZE) === 'accept';
      assert.equal(taken, !(total > size * 1.1), `size ${size}, total ${total}`);
      checked++;
    }
  }
  assert.ok(checked > 28_000);
});

const run = (...events: ReceiverEvent[]) => events.reduce((s, e) => receiverStep(s, e).state, IDLE);
const last = (state: Receiver, event: ReceiverEvent) => receiverStep(state, event).next;
const after = (state: Receiver, ...events: ReceiverEvent[]) => events.reduce((s, e) => receiverStep(s, e).state, state);

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
  assert.deepEqual(step.state, IDLE);
});

// The ordering specs/rom_transfer.qnt found (`countIsHeld`): the page drops a
// short file's bytes, so a later request must not resume from its count.
test('after a short file, the next request starts the file again from nothing', () => {
  const short = run(
    { kind: 'accept' },
    { kind: 'channel' },
    { kind: 'header', size: 300_000, hash: 'Saa' },
    { kind: 'chunk', bytes: 100_000 },
    { kind: 'complete' },
  );
  for (const again of [{ kind: 'sharing-on' }, { kind: 'game-started' }, { kind: 'reconnected' }] as const) {
    const asked = receiverStep(short, again).state;
    assert.equal(asked.phase, 'resuming', again.kind);
    const resumed = receiverStep(asked, { kind: 'channel' }).state;
    assert.equal(resumed.received, 0, `${again.kind}: the host is asked for the file from its start`);
    assert.equal(resumed.header, null, again.kind);
  }
});

// Where these rules now differ from play.js's old receiver, on purpose: a
// transfer with nothing received used to stop and wait for Retry. A channel
// closes with nothing received when the host never heard the guest's first
// message (specs/rom_transfer.qnt, `retriesBeforeAsking`).
test('a closed channel is retried by itself, whether or not any of the file arrived', () => {
  const noBytes = run({ kind: 'accept' }, { kind: 'channel' });
  // Before: 'none', and the page showed "ROM transfer failed" until Retry.
  assert.equal(last(noBytes, { kind: 'closed' }), 'ask-after-pause');
  const someBytes = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'chunk', bytes: 1000 });
  assert.equal(last(someBytes, { kind: 'closed' }), 'ask-after-pause');
});

test('channels that close before any byte use the three retries, then the guest decides', () => {
  let state = run({ kind: 'accept' }, { kind: 'channel' });
  const nexts: string[] = [];
  for (let close = 0; close < 4; close++) {
    const closed = receiverStep(state, { kind: 'closed' });
    nexts.push(closed.next);
    state = closed.state;
    if (closed.next === 'ask-after-pause') state = after(state, { kind: 'backoff-elapsed' }, { kind: 'channel' });
  }
  assert.deepEqual(nexts, ['ask-after-pause', 'ask-after-pause', 'ask-after-pause', 'stalled']);
  assert.equal(state.retries, 4);
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

const why = (step: ReturnType<typeof receiverStep>): string | null => (step.next === 'abandoned' ? step.reason : null);

test('a ROM past the size limit is refused, by header or by bytes, and says which', () => {
  const receiving = run({ kind: 'accept' }, { kind: 'channel' });
  const atLimit = receiverStep(receiving, { kind: 'header', size: ROM_MAX_SIZE, hash: undefined });
  assert.equal(atLimit.next, 'none');
  const refused = receiverStep(receiving, { kind: 'header', size: ROM_MAX_SIZE + 1, hash: undefined });
  assert.deepEqual([refused.next, refused.state, why(refused)], ['abandoned', IDLE, 'tooLarge']);
  const flooded = receiverStep(receiving, { kind: 'chunk', bytes: ROM_MAX_SIZE + 1 });
  assert.deepEqual([flooded.next, flooded.state, why(flooded)], ['abandoned', IDLE, 'tooLarge']);
  const announced = receiverStep(receiving, { kind: 'header', size: 100_000, hash: 'Saa', name: 'game.z64' }).state;
  assert.equal(announced.header?.name, 'game.z64');
  const over = receiverStep(announced, { kind: 'chunk', bytes: 110_001 });
  assert.deepEqual([over.next, why(over)], ['abandoned', 'overHeader']);
  const short = receiverStep(receiverStep(announced, { kind: 'chunk', bytes: 50_000 }).state, { kind: 'complete' });
  assert.deepEqual([short.next, why(short)], ['abandoned', 'sizeMismatch']);
});

test('the host turning sharing off pauses, and on again resumes, with or without bytes', () => {
  const receiving = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'chunk', bytes: 1000 });
  const paused = receiverStep(receiving, { kind: 'sharing-off' }).state;
  assert.equal(paused.phase, 'paused');
  assert.equal(last(paused, { kind: 'sharing-on' }), 'ask');
  const pausedEmpty = receiverStep(run({ kind: 'accept' }), { kind: 'sharing-off' }).state;
  // Before: 'none', and the guest stayed paused though the host shared again.
  assert.equal(last(pausedEmpty, { kind: 'sharing-on' }), 'ask');
});

test('while paused, the page says a retry is coming, or what is left to the guest', () => {
  const closed = (bytes: number, closes: number) => {
    let state = run({ kind: 'accept' }, { kind: 'channel' }, { kind: 'header', size: 1000, hash: 'Saa' });
    if (bytes > 0) state = after(state, { kind: 'chunk', bytes });
    for (let close = 1; close < closes; close++) {
      state = after(state, { kind: 'closed' }, { kind: 'backoff-elapsed' }, { kind: 'channel' });
    }
    return receiverStep(state, { kind: 'closed' }).state;
  };
  assert.equal(pausedText(closed(0, 1), true), 'ROM transfer interrupted — retrying (1/3)');
  assert.equal(pausedText(closed(500, 3), true), 'ROM transfer interrupted — retrying (3/3)');
  // Out of retries: the guest decides.
  assert.equal(pausedText(closed(500, 4), true), 'ROM transfer paused — 50% received');
  assert.equal(pausedText(closed(0, 4), true), 'ROM transfer paused — 0% received');
  // The host stopped sharing: nothing is retried until it shares again.
  const stopped = receiverStep(run({ kind: 'accept' }, { kind: 'channel' }), { kind: 'sharing-off' }).state;
  assert.equal(pausedText(stopped, false), 'ROM transfer failed');
});

test('the proved decisions, restated over small cases', () => {
  for (let retries = 1; retries <= 6; retries++) {
    assert.equal(afterChannelClosed(retries), retries <= 3 ? 'retry' : 'stalled');
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
