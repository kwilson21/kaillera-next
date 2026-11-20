// Read-only observer of the existing forward/catch-up writer boundary.
// Does not allocate native memory, call input feeds, or change native returns.
export function installNativeInputObserver(mod, hud, players = 4, limit = 2048, snapshotContext = () => null) {
  const rows = [],
    snapshots = [];
  let pending = null,
    sequence = 0,
    overflow = 0;
  const before = () => ({ nativeFrame: mod._kn_get_frame(), jsFrame: hud().currentFrame, delay: hud().delay });
  const originalPre = mod._kn_pre_tick,
    originalGet = mod._kn_get_input,
    originalSet = mod._kn_set_frame;
  mod._kn_set_frame = function (...args) {
    const pre = before(),
      result = originalSet.apply(this, args);
    sequence++;
    if (snapshots.length < 64)
      snapshots.push({ sequence, requestedFrame: args[0], pre, post: before(), context: snapshotContext() });
    return result;
  };
  mod._kn_pre_tick = function (...args) {
    const pre = before(),
      result = originalPre.apply(this, args),
      post = before();
    pending =
      result === 0
        ? { sequence, pre, post, result, frame: post.nativeFrame, key: post.nativeFrame - post.delay, inputs: {} }
        : null;
    return result;
  };
  mod._kn_get_input = function (slot, key, ...ptrs) {
    const result = originalGet.call(this, slot, key, ...ptrs);
    if (pending && slot >= 0 && slot < players && key === pending.key && mod._kn_get_frame() === pending.frame) {
      // Read the outputs of the exact getter invoked by _writeRingInputs.
      pending.inputs[slot] = {
        present: !!result,
        values: result ? ptrs.map((p) => mod.HEAP32[p >> 2]) : [0, 0, 0, 0, 0],
      };
      if (Object.keys(pending.inputs).length === players) {
        if (rows.length < limit) rows.push(pending);
        else overflow++;
        pending = null;
      }
    }
    return result;
  };
  return { export: () => ({ rows, snapshots, overflow, limit }) };
}
