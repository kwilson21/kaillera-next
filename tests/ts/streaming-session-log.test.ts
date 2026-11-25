import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSyncLogRing } from '../../web/src/sync-log-ring.ts';
import { startLogUpload } from '../../web/src/streaming/session-log.ts';

test('retry keeps the same ordered delta, and teardown delivers the tail while the socket ack is pending', async () => {
  const ring = createSyncLogRing(10);
  const seen: Array<[boolean, string, number[]]> = [];
  let complete: (seq: number) => void = () => assert.fail('socket flush was never sent');
  let calls = 0;
  const writer = startLogUpload(ring, async (epoch, entries, closing) => {
    seen.push([closing, epoch, entries.map((e) => e.seq)]);
    if (closing) return entries.at(-1)!.seq;
    if (++calls === 1) return -1;
    return new Promise<number>((resolve) => {
      complete = resolve;
    });
  });
  ring.push({ t: 1, f: 10, msg: 'host booted' });
  await writer.flush();
  const sent = writer.flush();
  ring.push({ t: 3, f: 12, msg: 'guest connected' });
  const stopped = writer.stop();
  const duplicate = writer.flush(true);
  await stopped;
  await duplicate;
  complete(0);
  await sent;
  assert.deepEqual(seen, [
    [false, ring.epoch, [0]],
    [false, ring.epoch, [0]],
    [true, ring.epoch, [0, 1]],
  ]);
});

test('a declined final chunk is retried with the same epoch, then larger backlogs drain in sequence', async () => {
  const ring = createSyncLogRing(20);
  const chunks: number[][] = [];
  const writer = startLogUpload(ring, async (epoch, entries, closing) => {
    assert.equal(epoch, ring.epoch);
    assert.ok(closing);
    chunks.push(entries.map((e) => e.seq));
    return chunks.length === 1 ? -1 : entries.at(-1)!.seq;
  });
  for (let i = 0; i < 10; i++) ring.push({ t: i, f: i, msg: 'x'.repeat(3000) });
  await writer.stop();
  assert.deepEqual(chunks[0], chunks[1]);
  assert.deepEqual(
    chunks.slice(1).flat(),
    Array.from({ length: 10 }, (_, i) => i),
  );
});
