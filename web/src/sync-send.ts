/**
 * The host's state for a resync, handed to its data channel a chunk at a
 * time (specs/tick_deadlines.qnt, `input_link`).
 *
 * A state is 1.4 MB compressed, 24 chunks of 64 KB, on the `sync-state`
 * channel. The host's inputs go on another channel of the same connection,
 * and the connection sends what it is given in order: handed every chunk at
 * once (two answers, 2.9 MB, in the run that found this), it left the host's
 * inputs unsent for seconds, the guest gave up on the host at the peer-stale
 * deadline and ran past its prediction window, and the inputs then arrived
 * up to 83 frames deep (DEEP-MISPREDICT-SKIP, a desync). So the next chunk
 * goes only once less than a chunk of the state is waiting in the channel:
 * an input never queues behind more than one chunk.
 *
 * Written as one Effect program so that the wait for room cannot go on
 * without a deadline: each chunk waits at most `stallMs`, then the transfer
 * is given up (the guest's own deadlines ask again).
 */
import { Duration, Effect } from 'effect';
import { mayHandChunk } from './sync-chunk-room.ts';

export { mayHandChunk };

/** How a paced transfer ended. */
export type PacedSendOutcome =
  /** Every chunk was handed to the channel. */
  | 'sent'
  /** The channel closed, or the transfer was cancelled. */
  | 'closed'
  /** No room for the next chunk before the deadline. */
  | 'stalled';

export interface PacedSendOptions {
  /** Number of chunks. */
  readonly count: number;
  /** Hand chunk `i` to the channel. */
  readonly send: (i: number) => void;
  /** The channel's `bufferedAmount`. */
  readonly buffered: () => number;
  /** False once the channel has closed or the transfer should stop. */
  readonly open: () => boolean;
  readonly lowWaterBytes: number;
  readonly pollMs: number;
  readonly stallMs: number;
}

const waitForRoom = (o: PacedSendOptions): Effect.Effect<'room' | 'closed' | 'stalled'> =>
  Effect.gen(function* () {
    for (;;) {
      if (!o.open()) return 'closed' as const;
      if (mayHandChunk(o.buffered(), o.lowWaterBytes)) return 'room' as const;
      yield* Effect.sleep(Duration.millis(o.pollMs));
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(o.stallMs),
      orElse: () => Effect.succeed('stalled' as const),
    }),
  );

/** The transfer as an Effect. */
export const pacedSend = (o: PacedSendOptions): Effect.Effect<PacedSendOutcome> =>
  Effect.gen(function* () {
    for (let i = 0; i < o.count; i++) {
      const room = yield* waitForRoom(o);
      if (room !== 'room') return room;
      o.send(i);
    }
    return 'sent' as const;
  });

/** Run a paced transfer from the plain-script engine. */
export const sendPaced = (o: PacedSendOptions): Promise<PacedSendOutcome> => Effect.runPromise(pacedSend(o));
