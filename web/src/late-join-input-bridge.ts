import type { WireInput } from './input-wire.ts';
import type { WirePayload } from './wire.ts';

// A short window around H, the frame of the authoritative late-join state.
// The two endpoints need not have paused on the same tick: an original peer
// can have made H..H+5 before the pause reaches it. Include those real inputs
// if the host has received them by the time the snapshot is sent.
const MAX_DELAY = 12;
const MAX_AHEAD = 32;
const MAX_SLOTS = 3;

type BridgeFrame = [number, number, number, number, number, number];
export type LateJoinInputBridge = { slot: number; sid: string; frames: BridgeFrame[] }[];
export type OriginalInputSource = {
  slot: number;
  sid: string;
  /** The caller supplies only input confirmed for this source generation. */
  confirmed: (frame: number) => WireInput | undefined;
};

function between(value: WirePayload, lo: number, hi: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
}

// A delay of 0 has a window too: alone in a room the match runs on the C
// engine at 0, and a friend who joins it joins at 0 (specs/engine_start.qnt,
// lateJoinIntoSoloTest). Without one, the solo host sent no source and the
// joiner, with none to wait for, failed its input wait as it arrived.
function bounds(frame: number, delay: number): readonly [number, number] | null {
  if (!Number.isInteger(frame) || frame < 0 || frame > 0x7fffffff - MAX_AHEAD) return null;
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY) return null;
  return [Math.max(0, frame - delay), frame + delay + 7];
}

export function collectLateJoinInputBridge(
  frame: number,
  delay: number,
  sources: readonly OriginalInputSource[],
): LateJoinInputBridge {
  const range = bounds(frame, delay);
  if (!range || sources.length > MAX_SLOTS) return [];
  const [from, through] = range;
  return sources.map(({ slot, sid, confirmed }) => {
    const frames: BridgeFrame[] = [];
    for (let f = from; f <= through; f++) {
      const input = confirmed(f);
      if (input) frames.push([f, input.buttons, input.lx, input.ly, input.cx, input.cy]);
    }
    return { slot, sid, frames };
  });
}

// This optional field may be absent on old hosts. Discard a malformed bridge
// independently of the savestate; it must not change the Ready/deadline path.
export function decodeLateJoinInputBridge(
  data: WirePayload,
  frame: number,
  delay: number,
  ownSlot: number,
): LateJoinInputBridge {
  const range = bounds(frame, delay);
  if (!range || !Array.isArray(data) || data.length > MAX_SLOTS) return [];
  const [from, through] = range;
  const slots = new Set<number>();
  const sids = new Set<string>();
  const result: LateJoinInputBridge = [];
  for (const source of data) {
    if (source === null || typeof source !== 'object') return [];
    const { slot, sid, frames } = source;
    if (
      !between(slot, 0, 3) ||
      slot === ownSlot ||
      slots.has(slot) ||
      typeof sid !== 'string' ||
      !sid.length ||
      sid.length > 128 ||
      sids.has(sid) ||
      !Array.isArray(frames) ||
      frames.length > through - from + 1
    )
      return [];
    slots.add(slot);
    sids.add(sid);
    const checked: BridgeFrame[] = [];
    let prev = from - 1;
    for (const sample of frames) {
      if (!Array.isArray(sample) || sample.length !== 6) return [];
      const [f, buttons, lx, ly, cx, cy] = sample;
      if (
        !between(f, prev + 1, through) ||
        !between(buttons, -0x80000000, 0x7fffffff) ||
        !between(lx, -128, 127) ||
        !between(ly, -128, 127) ||
        !between(cx, -128, 127) ||
        !between(cy, -128, 127)
      )
        return [];
      checked.push([f, buttons, lx, ly, cx, cy]);
      prev = f;
    }
    result.push({ slot, sid, frames: checked });
  }
  return result;
}

// Only this uninterrupted boot-specific proof may skip the legacy JIT boot
// correction. A repeated pacing tick proves nothing new; a cursor jump
// cannot stand in for observing all the real original inputs.
export type LateJoinBootProgress = { next: number; through: number } | 'validated';

export function lateJoinBootProgress(progress: LateJoinBootProgress, apply: number): LateJoinBootProgress | null {
  if (progress === 'validated') return progress;
  if (apply > progress.next) return null;
  if (apply < progress.next) return progress;
  if (apply > progress.through) return 'validated';
  return { next: apply + 1, through: progress.through };
}
