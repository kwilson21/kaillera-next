// The bystander observes the returning player's intact input channel. Each
// core independently records the controller writer between restore(C) and R.
export function observeCheckpoint({ returning, fault }) {
  const mod = window.EJS_emulator.gameManager.Module;
  const shared = window.KNShared;
  const slot = window.KNState.slot;
  const tuple = (v) => [v?.buttons || 0, v?.lx || 0, v?.ly || 0, v?.cx || 0, v?.cy || 0];
  const received = new Map();
  const output = { installs: [], freezes: [], releases: [], faults: 0, replaced: false };
  let replay;
  let recording = false;
  let frozen;
  const reset = mod._kn_set_frame;
  mod._kn_set_frame = function (f) {
    recording = !!frozen && f === frozen.c;
    if (recording) replay = { from: f, to: frozen.r, rows: [] };
    return reset.call(this, f);
  };
  const apply = shared.applyInputToWasm;
  shared.applyInputToWasm = function (s, v, ...rest) {
    if (recording && s === returning && typeof v === 'object') {
      const f = mod._kn_get_frame();
      if (f >= replay.from && f < replay.to) {
        replay.rows[f - replay.from] = { tag: f - window.NetplayRollback.getHudCounters().delay, value: tuple(v) };
      }
    }
    return apply.call(this, s, v, ...rest);
  };
  // Wrap the incoming dispatcher after the app binds its socket. Inspect
  // messages at the Socket.IO boundary, with the server's own sender stamp.
  const socket = window.__test_socket;
  const onevent = socket.onevent;
  socket.onevent = function (packet) {
    const [event, m] = packet.data || [];
    if (event === 'data-message' && m?.type === 'checkpoint-recovery' && m.op === 'freeze') frozen = m;
    return onevent.call(this, packet);
  };
  const emit = socket.emit;
  socket.emit = function (event, m, ...rest) {
    if (event === 'data-message' && m?.type === 'checkpoint-recovery') {
      const { op, c, r, state, history, request, id, anchor } = m;
      const receipt = { c, r, state, history, request, id, anchor };
      if (op === 'freeze') {
        frozen = m;
        output.freezes.push(receipt);
      }
      if (op === 'installed') output.installs.push(receipt);
      if (op === 'release') output.releases.push(receipt);
      if (slot === returning && op === 'journal' && ['missing-owner', 'wrong-owner'].includes(fault)) {
        output.faults++;
        if (fault === 'missing-owner') return this;
        m = { ...m, owner: 0 };
      }
      if (slot === 2 && op === 'installed' && fault === 'missing-install') {
        output.faults++;
        return this;
      }
      if (slot === 2 && op === 'frozen' && fault === 'replace-roster' && !output.faults) {
        output.faults++;
        const old = this.id;
        this.once('connect', () => {
          output.replaced = !!this.id && this.id !== old;
        });
        queueMicrotask(() => this.disconnect().connect());
      }
    }
    return emit.call(this, event, m, ...rest);
  };
  if (slot !== returning && slot !== 0) {
    const peer = Object.values(window.KNState.peers).find((p) => p.slot === returning);
    for (const ch of new Set([peer.dc, peer.rbDc].filter(Boolean))) {
      ch.addEventListener('message', ({ data }) => {
        if (!(data instanceof ArrayBuffer) || data.byteLength < 16 || data.byteLength % 4) return;
        const decoded = shared.decodeInput(data);
        if (!frozen || decoded.frame < frozen.r) received.set(decoded.frame, tuple(decoded));
      });
    }
  }
  window.__meshCheckpoint = () => ({ ...output, received: Object.fromEntries(received), replay });
}
