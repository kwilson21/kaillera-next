import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../../web/src/page/canvas-cadence.ts';

function harness(initiallyAllowed = true) {
  let at = 0;
  let allowed = initiallyAllowed;
  let reads = 0;
  let stops = 0;
  let frame = 0;
  let next: VideoFrameRequestCallback | null = null;
  const owner = Object.assign(new EventTarget(), { performance: { now: () => at } });
  const track = Object.assign(new EventTarget(), { stop: () => stops++ });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = Object.assign(new EventTarget(), {
    style: {},
    setAttribute() {},
    remove() {},
    play: () => Promise.resolve(),
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      next = callback;
      return 1;
    },
    cancelVideoFrameCallback() {
      next = null;
    },
  });
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: owner,
    createElement: () => video,
    body: { append() {} },
  });
  const canvas = {
    ownerDocument: doc,
    captureStream() {
      reads++;
      return stream;
    },
  };
  const ticks = [
    { at: 10, path: 'normal', total: 4 },
    { at: 24, path: 'replay', total: 13 },
    { at: 30, path: 'normal', total: 6 },
    { at: 100, path: 'normal', total: 5 },
  ];
  // @ts-expect-error The fixture implements only the canvas and owner-document APIs used by the probe.
  const probe = start(canvas, { frame: () => frame, captureAllowed: () => allowed, ticks: () => ticks });
  return {
    ...probe,
    ticks,
    fire(t: number, presented: number) {
      at = t + 2;
      frame++;
      const callback = next;
      next = null;
      callback?.(at, {
        expectedDisplayTime: at,
        presentationTime: t,
        presentedFrames: presented,
        mediaTime: t / 1000,
        width: 1,
        height: 1,
      });
    },
    hide(t: number, hidden: boolean) {
      at = t;
      doc.hidden = hidden;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    revoke() {
      allowed = false;
      owner.dispatchEvent(new Event('kn-capture-change'));
    },
    reads: () => reads,
    stops: () => stops,
  };
}

test('measures consecutive foreground video submissions and correlates ticks on the same clock', () => {
  const h = harness();
  h.fire(10, 1);
  h.fire(40, 2);
  h.fire(95, 5); // two submissions were missed by the JS observer
  h.fire(111, 6);
  h.hide(122, true);
  h.fire(130, 7);
  h.hide(500, false);
  h.fire(490, 8); // queued before foreground return
  h.fire(520, 9);
  h.fire(539, 10);
  const s = h.summary();
  assert.equal(s.samples, 3);
  assert.equal(s.missedCallbacks, 2);
  assert.equal(s.p95GapMs, 30);
  assert.deepEqual(s.worstGaps[0], {
    fromAt: 10,
    toAt: 40,
    fromFrame: 1,
    toFrame: 2,
    ms: 30,
    ticks: { paths: { replay: 1, normal: 1 }, maxMs: 13 },
  });
  assert.equal(s.worstGaps[1]?.ticks, null);
  assert.equal(s.lastFrameAgeMs, 2);
});

test('bounds the rolling percentile while retaining the lifetime worst gaps', () => {
  const h = harness();
  h.fire(1, 1);
  for (let i = 2; i <= 650; i++) h.fire(100 + 10 * i, i);
  const s = h.summary();
  assert.equal(s.samples, 649);
  assert.equal(s.recentSamples, 600);
  assert.equal(s.p95GapMs, 10);
  assert.equal(s.maxGapMs, 119);
  assert.equal(s.worstGaps.length, 3);
});

test('waits for full tick coverage and retains correlations when the engine ring expires', () => {
  const h = harness();
  h.fire(20, 1);
  h.fire(110, 2);
  assert.equal(h.summary().worstGaps[0]?.ticks, null);
  h.ticks.push({ at: 115, path: 'normal', total: 5 });
  const correlated = { paths: { replay: 1, normal: 2 }, maxMs: 13 };
  assert.deepEqual(h.summary().worstGaps[0]?.ticks, correlated);
  h.ticks.splice(0, 4);
  assert.deepEqual(h.summary().worstGaps[0]?.ticks, correlated);
});

test('capture is fail-closed and revoking it releases the track immediately', () => {
  const blocked = harness(false);
  assert.equal(blocked.summary().status, 'capture-disabled');
  assert.equal(blocked.reads(), 0);
  const h = harness();
  h.fire(10, 1);
  h.revoke();
  h.stop();
  h.fire(30, 2);
  assert.equal(h.stops(), 1);
  assert.equal(h.summary().status, 'capture-disabled');
  assert.equal(h.summary().samples, 0);
});
