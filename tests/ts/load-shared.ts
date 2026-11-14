/**
 * Load web/static/shared.js the way a page does, for tests that compare its
 * built-in code with the TypeScript it delegates to.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { DecodedInput, FrameInput, ShortPacket, WireInput } from '../../web/src/input-wire.ts';
import type { RunnerStep } from '../../web/src/runner-step.ts';
import type { StickDeadband, StickDeadbandOptions } from '../../web/src/stick-deadband.ts';
import type { SyncLogRing } from '../../web/src/sync-log-ring.ts';

export type EncodeArgs = [number, WireInput, number?, (FrameInput[] | null)?];

/** The part of `window.KNCore` that shared.js calls. */
export interface SharedCore {
  encodeInput: (...args: EncodeArgs) => Int32Array<ArrayBuffer>;
  decodeInput: (buf: ArrayBuffer) => DecodedInput | ShortPacket;
  inputEqual: (a: WireInput, b: WireInput) => boolean;
  createSyncLogRing: (maxSize: number) => SyncLogRing;
  createStickDeadband: (options?: StickDeadbandOptions) => StickDeadband;
  classifyRunnerStep: (
    rescheduled: boolean,
    cycleBefore: number | null | undefined,
    cycleAfter: number | null | undefined,
  ) => RunnerStep;
}

/**
 * `window.KNShared` from shared.js. Without `core` there is no
 * `window.KNCore`, so the code built into shared.js runs.
 */
export const loadShared = (core?: Partial<SharedCore>): SharedCore => {
  const source = readFileSync(new URL('../../web/static/shared.js', import.meta.url), 'utf8');
  const window: { KNCore?: Partial<SharedCore>; KNShared?: SharedCore } = core ? { KNCore: core } : {};
  vm.runInContext(source, vm.createContext({ window, KNState: {}, console }));
  assert.ok(window.KNShared, 'shared.js did not define window.KNShared');
  return window.KNShared;
};

/** A small deterministic generator, so a failure names a reproducible case. */
export const lcg = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
};

/**
 * Objects made inside a vm context have another realm's prototypes, which
 * deepStrictEqual treats as a difference; structuredClone copies them into
 * this one and, unlike a JSON round trip, keeps `undefined` fields.
 */
export const plain = structuredClone;
