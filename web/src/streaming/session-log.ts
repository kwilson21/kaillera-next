import { Duration, Effect } from 'effect';
import { startEvery } from '../poll.ts';
import type { NumberedSyncLogEntry, SyncLogRing } from '../sync-log-ring.ts';

type Send = (epoch: string, entries: NumberedSyncLogEntry[], mode: 'regular' | 'stop' | 'exit') => Promise<number>;

/** Each match owns its ring and cursor. Replayed entries have the same epoch and sequence on both transports. */
export function startLogUpload(ring: SyncLogRing, send: Send, cadence = 5000) {
  let acked = -1;
  let regular: Promise<boolean> | null = null;
  let final: Promise<void> | null = null;
  const drain = async (closing: boolean) => {
    do {
      // Bound each live stop batch while draining the ring in sequence.
      const entries = ring.entriesAfter(acked, 5000, closing ? 8 * 1024 : undefined);
      const last = entries.at(-1);
      if (!last) return true;
      const ack = await send(ring.epoch, entries, closing ? 'stop' : 'regular').catch(() => -1);
      if (!Number.isSafeInteger(ack) || ack < entries[0]!.seq) return false;
      acked = Math.max(acked, Math.min(ack, last.seq));
    } while (closing);
    return true;
  };
  const finish = async () => {
    const inFlight = regular;
    if (await drain(true)) return;
    // The server can decline a final append while the socket flush is committing.
    if (inFlight) await inFlight;
    await Effect.runPromise(Effect.sleep(Duration.millis(500)));
    await drain(true);
  };
  const flush = (keepalive = false) => {
    if (keepalive) {
      // Start the one exit request while the page is still alive.
      return send(ring.epoch, ring.entriesAfter(acked, Infinity, Infinity), 'exit').catch(() => -1);
    }
    if (!regular && !final)
      regular = drain(false).finally(() => {
        regular = null;
      });
    return regular ?? final;
  };
  const cancel = startEvery(() => {
    void flush();
  }, cadence);
  return {
    flush,
    stop: () => {
      cancel();
      final ??= finish().finally(() => {
        final = null;
      });
      return final;
    },
  };
}
