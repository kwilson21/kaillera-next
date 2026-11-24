import type { WirePayload } from './wire.ts';
import type { Input } from './owner-proof.ts';
import { JOURNAL_FRAMES } from './checkpoint-wire.ts';

export const sameInput = (a: Input, b: Input) => a.every((v, i) => v === b[i]);
export const neutral: Input = [0, 0, 0, 0, 0];
export const digestBytes = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join(
    '',
  );
export const digestRecord = (v: WirePayload) => digestBytes(new TextEncoder().encode(JSON.stringify(v)));
export type Step = Readonly<{ delay: number; values: readonly Input[] }>;

// Key each ring cell by its absolute frame. Delayed packets cannot evict newer records.
class FrameRing<T> {
  private readonly cells: ({ frame: number; value: T } | undefined)[] = Array.from({ length: JOURNAL_FRAMES });
  get(frame: number) {
    const cell = this.cells[frame % JOURNAL_FRAMES];
    return cell?.frame === frame ? cell.value : undefined;
  }
  set(frame: number, value: T) {
    const index = frame % JOURNAL_FRAMES,
      old = this.cells[index];
    if (!old || old.frame <= frame) this.cells[index] = { frame, value };
  }
}
export class CheckpointJournal {
  private readonly owned = new FrameRing<Input>();
  private readonly witnesses = new Map<number, FrameRing<Input>>();
  private readonly applied = new FrameRing<Step>();
  private readonly conflicts = new FrameRing<boolean>();
  private readonly self: number;
  private readonly slots: readonly number[];
  constructor(self: number, slots: readonly number[]) {
    this.self = self;
    this.slots = slots;
  }
  owner(tag: number) {
    return this.owned.get(tag);
  }
  witness(slot: number, tag: number, input: Input) {
    let ring = this.witnesses.get(slot);
    if (!ring) {
      ring = new FrameRing();
      this.witnesses.set(slot, ring);
    }
    const previous = ring.get(tag);
    if (previous && !sameInput(previous, input)) {
      this.conflicts.set(tag, true);
      return;
    }
    ring.set(tag, input);
    if (slot === this.self) this.owned.set(tag, input);
  }
  executed(frame: number, delay: number, values: readonly Input[]) {
    this.applied.set(frame, { delay, values });
  }
  step(frame: number) {
    return this.applied.get(frame);
  }
  matches(slot: number, tag: number, value: Input) {
    const witnessed = this.witnesses.get(slot)?.get(tag);
    return !this.conflicts.get(tag) && (!witnessed || sameInput(witnessed, value));
  }
  // Every member signs the same execution transcript; each owns one verified column.
  transcript(from: number, to: number): readonly Step[] | null {
    if (to < from || to - from > JOURNAL_FRAMES) return null;
    const rows: Step[] = [];
    for (let f = from; f < to; f++) {
      const step = this.applied.get(f);
      if (!step) return null;
      const tag = f - step.delay,
        actual = tag < 0 ? neutral : this.owned.get(tag);
      const own = step.values[this.slots.indexOf(this.self)];
      if (!actual || !own || !sameInput(actual, own) || this.conflicts.get(tag)) return null;
      rows.push(step);
    }
    return rows;
  }
}
