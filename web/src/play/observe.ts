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
  /** What play.js decided, and what the new function would have, as JSON. */
  readonly old: string;
  readonly next: string;
};

/** A page may report this many different disagreements; a wrong function is wrong often. */
export const DISAGREE_LIMIT = 10;
/** Longest value kept in a report. */
const VALUE_MAX = 300;

const shown = (value: WirePayload | undefined): string => (JSON.stringify(value) ?? 'undefined').slice(0, VALUE_MAX);

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
    const old = shown(oldValue);
    const next = shown(newValue);
    if (old !== next) {
      const key = `${what}\n${old}\n${next}`;
      if (!seen.has(key) && seen.size < DISAGREE_LIMIT) {
        seen.add(key);
        waiting = [...waiting, { type: 'play-disagree', message: what, old, next }];
      }
    }
    if (waiting.length > 0) flush();
    return old === next;
  };

  return { compare, flush };
};
