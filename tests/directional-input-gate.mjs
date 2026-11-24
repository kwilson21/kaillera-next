// Test-only record loss. Preserve every non-held input value and acknowledgment.
export function createDirectionalInputGate({ target, now }) {
  let state = null;
  const decode = (data) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || data.byteLength % 4) return null;
    const w = new Int32Array(data),
      records = [Array.from(w.slice(0, 4))];
    if (w.length >= 6)
      for (let i = 0; i < Math.min(Math.max(0, w[5]), Math.floor((w.length - 6) / 4)); i++)
        records.push(Array.from(w.slice(6 + 4 * i, 10 + 4 * i)));
    return { data, records, ack: w.length >= 5 ? w[4] : -1 };
  };
  const encode = (records, ack) => {
    // The newest remaining record is the primary so redundancy stays <= frame.
    const sorted = records.toSorted((a, b) => b[0] - a[0]);
    return new Int32Array([...sorted[0], ack, sorted.length - 1, ...sorted.slice(1).flat()]).buffer;
  };
  const heldRecord = (r) => r[0] >= state.from && r[0] < state.to;
  const split = (item) => {
    if (state.mode === 'burst') {
      if (item.records.some(heldRecord)) state.queue.push(item);
      else {
        state.passed += item.records.length;
        state.laterInputs += item.records.filter((r) => r[0] >= state.to).length;
        item.deliver(item.data);
      }
      return;
    }
    const held = item.records.filter(heldRecord),
      pass = item.records.filter((r) => !heldRecord(r));
    if (pass.length) {
      state.passed += pass.length;
      state.laterInputs += pass.filter((r) => r[0] >= state.to).length;
      item.deliver(encode(pass, item.ack));
    }
    if (held.length) state.queue.push({ ...item, records: held });
  };
  return {
    arm(slot, mode = 'isolated') {
      state = {
        slot,
        mode,
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
      if (!state || state.releasedAt !== null || !target(channel, state.slot)) return deliver(data);
      const decoded = decode(data);
      if (!decoded) return deliver(data);
      if (!decoded.records.some(heldRecord)) {
        state.passed += decoded.records.length;
        state.laterInputs += decoded.records.filter((r) => r[0] >= state.to).length;
        return deliver(data);
      }
      split({ ...decoded, deliver });
    },
    pin(from, to) {
      if (!state || state.releasedAt !== null || !(to > from)) throw new Error('gate not armed');
      state.from = from;
      state.to = to;
      const old = state.queue;
      state.queue = [];
      for (const item of old) split(item);
    },
    release(waitInput) {
      if (!state || state.releasedAt !== null || !(waitInput >= state.from && waitInput < state.to))
        throw new Error('release requires the observed held catch-up input');
      state.held = state.queue.length;
      state.frames = state.queue.flatMap((item) => item.records.map((r) => r[0]));
      state.releasedAt = now();
      for (const item of state.queue.splice(0))
        item.deliver(state.mode === 'burst' ? item.data : encode(item.records, item.ack));
    },
    stats() {
      if (!state) return null;
      const { queue, ...rest } = state;
      return {
        ...rest,
        queued: queue.length,
        capturedPackets: state.held + queue.length,
        queuedFrames: queue.flatMap((item) => item.records.map((r) => r[0])),
      };
    },
  };
}
export function catchUpHoleInput(snapshotFrame, delay, deep) {
  if (!Number.isInteger(snapshotFrame) || !Number.isInteger(delay) || snapshotFrame < 0 || delay < 0)
    throw new Error('finite non-negative snapshot frame and input delay required');
  return Math.max(0, snapshotFrame - (deep ? delay : 0));
}
