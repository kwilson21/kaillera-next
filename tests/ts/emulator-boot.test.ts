import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEmulatorBoot } from '../../web/src/play/emulator-boot.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const unexpected = (): never => assert.fail('Unexpected boot callback');

test('metadata deadline falls back once and a loader timeout releases ownership for a retry', async () => {
  const boot = startEmulatorBoot(10, 10);
  const failures = deferred<string>();
  const fallback: string[] = [];
  const signals: AbortSignal[] = [];
  const pending = deferred<void>();
  const load = (signal: AbortSignal) => {
    signals.push(signal);
    return pending.promise;
  };
  assert.ok(
    boot.start(
      () => pending.promise,
      load,
      (err) => fallback.push(err),
      failures.resolve,
    ),
  );
  assert.equal(
    boot.start(() => undefined, load, unexpected, unexpected),
    false,
  );
  await failures.promise;
  assert.equal(fallback.length, 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
  const retry = deferred<void>();
  assert.ok(
    boot.start(
      () => undefined,
      async () => retry.resolve(),
      unexpected,
      unexpected,
    ),
  );
  pending.resolve();
  await retry.promise;
  boot.cancel();
});

test('a cancelled preparation or loader cannot complete or fail the next boot', async () => {
  const boot = startEmulatorBoot();
  const first = deferred<void>();
  assert.ok(boot.start(() => first.promise, unexpected, unexpected, unexpected));
  boot.cancel();
  const second = deferred<void>();
  const loaded = deferred<AbortSignal>();
  assert.ok(
    boot.start(
      () => undefined,
      (signal) => {
        loaded.resolve(signal);
        return second.promise;
      },
      unexpected,
      unexpected,
    ),
  );
  const signal = await loaded.promise;
  boot.cancel();
  assert.ok(signal.aborted);
  const third = deferred<void>();
  assert.ok(
    boot.start(
      () => undefined,
      () => third.promise,
      unexpected,
      unexpected,
    ),
  );
  first.resolve();
  second.reject(new Error('old script'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    boot.start(() => undefined, unexpected, unexpected, unexpected),
    false,
  );
  third.resolve();
  boot.cancel();
});
