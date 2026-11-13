/**
 * Running a moved decision beside the code it will replace.
 *
 * A decision that reaches the engine or a saved mapping does not take over
 * from play.js on the strength of tests alone (docs/roadmap.md, "Rules for
 * every stage"). The old code stays in charge; the new function runs on the
 * same inputs and a difference is reported as a `play-disagree` client event.
 * The new one takes over once production shows none.
 */
import type { WirePayload } from '../wire.ts';

/** One disagreement between play.js and the function meant to replace it. */
export type DisagreeReport = {
  readonly type: 'play-disagree';
  /** Which decision: 'delay-preference', 'remap-wizard', ... */
  readonly message: string;
  /** What play.js decided, and what the new function would have: JSON, cut to a window around the first difference. */
  readonly old: string;
  readonly next: string;
};

/** A page may report this many different disagreements; a wrong function is wrong often. */
export const DISAGREE_LIMIT = 10;
/** Longest value kept in a report. */
const VALUE_MAX = 300;

const asJson = (value: WirePayload | undefined): string => JSON.stringify(value) ?? 'undefined';

/** The part of a value worth reporting: a window around where the two first differ. */
const windowAt = (text: string, firstDifference: number): string => {
  const start = Math.max(0, Math.min(firstDifference - VALUE_MAX / 3, text.length - VALUE_MAX));
  return text.slice(start, start + VALUE_MAX);
};

const firstDifference = (a: string, b: string): number => {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
};

/**
 * Compare decisions and report where they differ. `sink` returns false when
 * it cannot send yet (client events need the room's upload token); the
 * report is then kept and offered again on the next comparison.
 */
export const createComparer = (sink: (report: DisagreeReport) => boolean) => {
  const seen = new Set<string>();
  let waiting: readonly DisagreeReport[] = [];

  const flush = (): void => {
    waiting = waiting.filter((report) => !sink(report));
  };

  /** Returns whether the two agree. The caller keeps using `oldValue`. */
  const compare = (what: string, oldValue: WirePayload | undefined, newValue: WirePayload | undefined): boolean => {
    const oldJson = asJson(oldValue);
    const nextJson = asJson(newValue);
    const agree = oldJson === nextJson;
    if (!agree) {
      const at = firstDifference(oldJson, nextJson);
      const old = windowAt(oldJson, at);
      const next = windowAt(nextJson, at);
      const key = `${what}\n${old}\n${next}`;
      if (!seen.has(key) && seen.size < DISAGREE_LIMIT) {
        seen.add(key);
        waiting = [...waiting, { type: 'play-disagree', message: what, old, next }];
      }
    }
    if (waiting.length > 0) flush();
    return agree;
  };

  return { compare, flush };
};
