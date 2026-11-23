/**
 * The rollback engine's RB-CHECK book: the gameplay hashes this page has
 * filed for frames it can no longer roll back, and the ones each peer sent,
 * paired by frame. It decides with `pairVerdict` (rb-check.ts); the engine
 * (web/static/netplay-rollback.js) files values, sends its own, and logs
 * what comes back.
 *
 * - The first value filed for a frame on either side is the one compared: a
 *   frame filed is final, so a second filing can only be a repeat.
 * - Whichever of a pair arrives second is compared with the first, at once.
 * - A lone value waits `history` frames past its frame (by this page's
 *   tick), then is reported once as not compared and dropped. A local value
 *   is reported only for a peer that has sent a value for that frame or an
 *   earlier one (a page from before this rule sends none, and a player that
 *   joined later had no value for it).
 */

import { pairVerdict, RB_ABSENT, RB_EXPIRED, RB_MATCH } from './rb-check.ts';

/** A filed value: the gameplay hash compared, and the wider game-state hash (0 when not taken). */
export interface RbCheckValue {
  readonly gp: number;
  readonly game: number;
}

export type RbCheckOutcome =
  | {
      readonly kind: 'match' | 'mismatch';
      readonly frame: number;
      readonly slot: number;
      readonly local: RbCheckValue;
      readonly peer: RbCheckValue;
    }
  | {
      readonly kind: 'uncompared';
      readonly frame: number;
      readonly slot: number;
      /** Which side never came. */
      readonly missing: 'local' | 'peer';
      readonly value: RbCheckValue;
    };

interface LocalEntry {
  readonly value: RbCheckValue;
  /** Slots this frame has been compared with or reported for. */
  readonly settled: Set<number>;
}

const isHash = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

export const createRbCheckBook = (history: number) => {
  const local = new Map<number, LocalEntry>();
  // slot -> frame -> value not yet compared
  const held = new Map<number, Map<number, RbCheckValue>>();
  // slot -> the oldest frame it has sent a value for
  const firstFrom = new Map<number, number>();

  const compare = (frame: number, slot: number, mine: RbCheckValue, theirs: RbCheckValue): RbCheckOutcome => {
    const verdict = pairVerdict(mine.gp, theirs.gp, frame, frame, history);
    return { kind: verdict === RB_MATCH ? 'match' : 'mismatch', frame, slot, local: mine, peer: theirs };
  };

  return {
    /** This page's value for `frame`, final here. Returns the comparisons it completes. */
    fileLocal(frame: number, value: RbCheckValue): RbCheckOutcome[] {
      if (!Number.isInteger(frame) || frame < 0 || !isHash(value.gp) || local.has(frame)) return [];
      const entry: LocalEntry = { value, settled: new Set() };
      local.set(frame, entry);
      const out: RbCheckOutcome[] = [];
      for (const [slot, frames] of held) {
        const theirs = frames.get(frame);
        if (theirs === undefined) continue;
        frames.delete(frame);
        entry.settled.add(slot);
        out.push(compare(frame, slot, value, theirs));
      }
      return out;
    },

    /** A peer's value for `frame`. Returns the comparison, if this page has filed the frame. */
    filePeer(slot: number, frame: number, value: RbCheckValue): RbCheckOutcome | null {
      if (!Number.isInteger(frame) || frame < 0 || !isHash(value.gp)) return null;
      const first = firstFrom.get(slot);
      if (first === undefined || frame < first) firstFrom.set(slot, frame);
      const mine = local.get(frame);
      if (mine !== undefined) {
        if (mine.settled.has(slot)) return null;
        mine.settled.add(slot);
        return compare(frame, slot, mine.value, value);
      }
      let frames = held.get(slot);
      if (frames === undefined) {
        frames = new Map();
        held.set(slot, frames);
      }
      if (!frames.has(frame)) frames.set(frame, value);
      return null;
    },

    /** The lone values that have waited past the history at `tick`, each reported once and dropped. */
    expire(tick: number): RbCheckOutcome[] {
      const out: RbCheckOutcome[] = [];
      for (const [slot, frames] of held) {
        for (const [frame, value] of frames) {
          if (pairVerdict(RB_ABSENT, value.gp, frame, tick, history) !== RB_EXPIRED) continue;
          frames.delete(frame);
          out.push({ kind: 'uncompared', frame, slot, missing: 'local', value });
        }
      }
      for (const [frame, entry] of local) {
        if (pairVerdict(entry.value.gp, RB_ABSENT, frame, tick, history) !== RB_EXPIRED) continue;
        local.delete(frame);
        for (const [slot, first] of firstFrom) {
          if (first > frame || entry.settled.has(slot)) continue;
          out.push({ kind: 'uncompared', frame, slot, missing: 'peer', value: entry.value });
        }
      }
      return out;
    },

    /**
     * The engine runs the frames from `frame` again (a resync's catch-up):
     * what it filed for them describes the state replaced. Peers' values stay.
     */
    forgetFrom(frame: number): void {
      for (const f of local.keys()) if (f >= frame) local.delete(f);
    },

    /** A peer is gone or starts clean (resetPeerState). */
    forgetPeer(slot: number): void {
      held.delete(slot);
      firstFrom.delete(slot);
    },

    /** A new match, or the engine stopped. */
    clear(): void {
      local.clear();
      held.clear();
      firstFrom.clear();
    },

    /** How many values are held, for tests and diagnostics. */
    size() {
      let peer = 0;
      for (const frames of held.values()) peer += frames.size;
      return { local: local.size, peer };
    },
  };
};

export type RbCheckBook = ReturnType<typeof createRbCheckBook>;
