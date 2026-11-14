/**
 * Helpers for the tests of what used to be web/static/shared.js: the
 * encoder's arguments and a deterministic generator for random cases.
 */
import type { FrameInput, WireInput } from '../../web/src/input-wire.ts';

export type EncodeArgs = [number, WireInput, number?, (FrameInput[] | null)?];

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
