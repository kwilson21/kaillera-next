/**
 * The controller-present mask's schedule for one match: the mask the match
 * started with and each roster change, filed at the frame it takes effect
 * at. The rollback engine asks it for the mask of every frame it steps and
 * sets the core to that mask first, so a frame runs with the same mask on
 * every page and again with the same mask when it is replayed.
 *
 * The rules (which change is in effect at a frame, where a new one is filed,
 * when one arrives too late) are controller-mask.ts, verified; this file
 * keeps the arrays they work on. The model is specs/controller_mask.qnt.
 */
import { MASK_LEAD, changeInEffect, fileIndex, lateChange } from './controller-mask.ts';
import type { WirePayload } from './wire.ts';

/** A roster change: the host's roster frame, the frame it takes effect at, its mask. */
export interface MaskChange {
  readonly rosterFrame: number;
  readonly from: number;
  readonly mask: number;
}

/** What filing a change did. */
export interface FiledChange {
  /** The frame the change takes effect at. */
  readonly from: number;
  /** The mask in effect at `from` before it was filed. */
  readonly maskBefore: number;
  /**
   * The page has run frames the change covers with another mask: they ran
   * differently from the other pages', and the host's state is needed.
   */
  readonly late: boolean;
}

/**
 * The schedule as the host hands it to a late joiner with its state
 * (`late-join-state`'s `controllerMasks`): the mask in effect at the state's
 * frame and the changes filed after it, as [rosterFrame, from, mask].
 */
export interface MaskScheduleWire {
  readonly base: number;
  readonly changes: ReadonlyArray<readonly [number, number, number]>;
}

export interface MaskSchedule {
  /** A match is running and its frames take their mask from the schedule. */
  readonly active: () => boolean;
  /** Start the match's schedule: `base` until the first change; `frame` is the first frame to run. */
  readonly start: (base: number, frame: number) => void;
  /** A late joiner takes the host's schedule from the state's frame on; false (and nothing changes) if it is malformed. */
  readonly adopt: (wire: WirePayload, frame: number) => boolean;
  /** The match ended or the engine stopped: frames are not scheduled any more. */
  readonly stop: () => void;
  /** File a roster heard from (or broadcast by) the host at `rosterFrame`. */
  readonly fileRoster: (rosterFrame: number, mask: number) => FiledChange;
  /** File a change only this page makes (the demo's synthetic-peer toggle) at the next frame it has not run. */
  readonly fileLocal: (mask: number) => FiledChange;
  /** The mask frame `frame` runs with. */
  readonly maskAt: (frame: number) => number;
  /** Frame `frame` ran (forward, replay or catch-up). */
  readonly ran: (frame: number) => void;
  /** The lowest frame this page has not run. */
  readonly frontier: () => number;
  /** The roster frame of the latest roster change filed, or -1. */
  readonly lastRosterFrame: () => number;
  /** The schedule from `frame` on, for a late joiner loading a state of that frame. */
  readonly wireFrom: (frame: number) => MaskScheduleWire;
  /** One line for the sync log. */
  readonly describe: () => string;
}

const validMask = (mask: WirePayload): mask is number =>
  typeof mask === 'number' && Number.isInteger(mask) && mask >= 1 && mask <= 0x0f;
const validFrame = (frame: WirePayload): frame is number => typeof frame === 'number' && Number.isSafeInteger(frame);
const isRecord = (wire: WirePayload): wire is { readonly [key: string]: WirePayload } =>
  wire !== null && typeof wire === 'object' && !Array.isArray(wire);

/**
 * The mask of a roster: a bit for each of the slots 0-3 in it, less the slots
 * in `leaveOut` (synthetic peers outside the demo). It does not add the
 * page's own slot: every page computes the same mask from the same roster.
 */
export const rosterMask = (slots: readonly number[], leaveOut: readonly number[] = []): number => {
  let mask = 0;
  for (const slot of slots) {
    if (Number.isInteger(slot) && slot >= 0 && slot < 4 && !leaveOut.includes(slot)) mask |= 1 << slot;
  }
  return mask;
};

export const createMaskSchedule = (lead: number = MASK_LEAD): MaskSchedule => {
  let isActive = false;
  let base = 0x0f;
  let changes: MaskChange[] = [];
  let frontier = 0;

  const froms = (): number[] => changes.map((c) => c.from);
  const maskAt = (frame: number): number => {
    const i = changeInEffect(froms(), frame);
    return i < 0 ? base : changes[i]!.mask;
  };
  const file = (rosterFrame: number, from: number, mask: number): FiledChange => {
    const maskBefore = maskAt(from);
    const i = fileIndex(froms(), from);
    const change = { rosterFrame, from, mask };
    const replaces = i < changes.length && changes[i]!.from === from;
    changes = [...changes.slice(0, i), change, ...changes.slice(replaces ? i + 1 : i)];
    return { from, maskBefore, late: lateChange(from, frontier, maskBefore, mask) };
  };

  return {
    active: () => isActive,
    start: (startMask, frame) => {
      isActive = true;
      base = startMask;
      changes = [];
      frontier = frame;
    },
    adopt: (wire, frame) => {
      if (!isRecord(wire) || !Number.isSafeInteger(frame)) return false;
      const wireBase = wire['base'];
      const wireChanges = wire['changes'];
      if (!validMask(wireBase) || !Array.isArray(wireChanges)) return false;
      const adopted: MaskChange[] = [];
      for (const entry of wireChanges) {
        if (!Array.isArray(entry) || entry.length !== 3) return false;
        const [rosterFrame, from, mask] = entry;
        if (!validFrame(rosterFrame) || !validFrame(from) || !validMask(mask)) return false;
        // In increasing order and after the state's frame, as wireFrom sends them.
        if (from <= frame || (adopted.length > 0 && from <= adopted[adopted.length - 1]!.from)) return false;
        adopted.push({ rosterFrame, from, mask });
      }
      isActive = true;
      base = wireBase;
      changes = adopted;
      frontier = frame;
      return true;
    },
    stop: () => {
      isActive = false;
      changes = [];
      frontier = 0;
    },
    fileRoster: (rosterFrame, mask) => file(rosterFrame, rosterFrame + lead, mask),
    fileLocal: (mask) => file(-1, frontier, mask),
    maskAt,
    ran: (frame) => {
      if (frame + 1 > frontier) frontier = frame + 1;
    },
    frontier: () => frontier,
    lastRosterFrame: () => {
      for (let i = changes.length - 1; i >= 0; i--) if (changes[i]!.rosterFrame >= 0) return changes[i]!.rosterFrame;
      return -1;
    },
    wireFrom: (frame) => ({
      base: maskAt(frame),
      changes: changes.filter((c) => c.from > frame).map((c) => [c.rosterFrame, c.from, c.mask] as const),
    }),
    describe: () =>
      `base=0x${base.toString(16)} frontier=${frontier} changes=[${changes
        .map((c) => `${c.from}:0x${c.mask.toString(16)}`)
        .join(',')}]`,
  };
};
