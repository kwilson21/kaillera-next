// Test-only receive fault. Never changes packet contents or engine input history.
export function createDirectionalInputGate({ target, now }) {
  let state = null;
  const framesOf = (data) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || data.byteLength % 4) return [];
    const words = new Int32Array(data);
    const frames = [words[0]];
    if (words.length >= 6) {
      const count = Math.min(Math.max(0, words[5]), Math.floor((words.length - 6) / 4));
      for (let i = 0; i < count; i++) frames.push(words[6 + 4 * i]);
    }
    return frames;
  };
  const matches = (frames) => frames.some((f) => f >= state.from && f < state.to);
  return {
    arm(slot) {
      state = {
        slot,
        from: 0,
        to: Infinity,
        queue: [],
        held: 0,
        passed: 0,
        laterInputs: 0,
        releasedAt: null,
        frames: [],
      };
    },
    receive(channel, data, deliver) {
      if (!state || state.releasedAt !== null || !target(channel, state.slot)) return deliver();
      const frames = framesOf(data);
      if (!matches(frames)) {
        state.passed++;
        if (frames.some((f) => f >= state.to)) state.laterInputs++;
        return deliver();
      }
      state.queue.push({ frames, deliver });
    },
    pin(from, to) {
      if (!state || state.releasedAt !== null || !(to > from)) throw new Error('gate not armed');
      state.from = from;
      state.to = to;
      const old = state.queue;
      state.queue = [];
      for (const item of old) {
        if (matches(item.frames)) state.queue.push(item);
        else {
          state.passed++;
          if (item.frames.some((f) => f >= state.to)) state.laterInputs++;
          item.deliver();
        }
      }
    },
    release(waitInput) {
      if (!state || state.releasedAt !== null || !(waitInput >= state.from && waitInput < state.to))
        throw new Error('release requires the observed held catch-up input');
      state.held = state.queue.length;
      state.frames = state.queue.flatMap((item) => item.frames.filter((f) => f >= state.from && f < state.to));
      state.releasedAt = now();
      for (const item of state.queue.splice(0)) item.deliver();
    },
    stats() {
      if (!state) return null;
      const { queue, ...rest } = state;
      return { ...rest, queued: queue.length };
    },
  };
}
