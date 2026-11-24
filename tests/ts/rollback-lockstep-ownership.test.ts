import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const registryStart = source.indexOf('  const _lockstepChannelRegistries =');
const installStart = source.indexOf('  const installPeerDataChannelHandlers =');
const installEnd = source.indexOf('  const armStartupConnectWatchdog =', installStart);
const channelPath = source.slice(registryStart < 0 ? installStart : registryStart, installEnd);
const fixture = runInNewContext(`
  (proof, firstId, secondId) => {
    const records = {opened: [], disconnected: [], received: []};
    const _peers = {};
    function setupDataChannel(sid, ch) {
      const opened = () => records.opened.push([sid, ch.id]);
      const closed = () => records.disconnected.push([sid, ch.id]);
      ch.onopen = opened;
      ch.onclose = closed;
      ch.onmessage = e => {
        const peer = _peers[sid];
        const allowed = typeof _acceptLockstepChannel === 'function'
          ? _acceptLockstepChannel(peer, ch, proof)
          : !!peer && (proof !== true || peer.dc === ch);
        if (allowed) records.received.push([sid, ch.id, e.data]);
      };
      if (ch.readyState === 'open') opened();
      return { opened, closed };
    }
    function setupSyncDataChannel() {}
    function setupRollbackInputDataChannel() {}
    const _onExtraDataChannel = null;
    class Channel {
      constructor(label, id) { this.label = label; this.id = id; this.readyState = 'connecting'; }
      open() { this.readyState = 'open'; this.onopen?.(); }
      close() { this.readyState = 'closed'; this.onclose?.(); }
      send(data) { this.other?.onmessage?.({data}); }
    }
    function side(sid, id) {
      const pc = { sent: [], createDataChannel(label) {
        const ch = new Channel(label, label === 'lockstep' ? id : null);
        this.sent.push(ch);
        return ch;
      }};
      const peer = {pc};
      _peers[sid] = peer;
      return peer;
    }
    ${channelPath}
    const a = side('P4', firstId), b = side('P3', secondId);
    function wire(local, remote) {
      const inbound = new Channel(local.label, local.id);
      local.other = inbound; inbound.other = local;
      remote.pc.ondatachannel({channel:inbound});
      return inbound;
    }
    return {records, a, b, wire, side, Channel, createOutgoingPeerChannels, installPeerDataChannelHandlers};
  }
`);

for (const [firstId, secondId] of [
  [0, 1],
  [1, 0],
] as const) {
  for (const firstOpen of ['local', 'remote']) {
    test(`same-PC reconnect glare uses one lockstep for both directions (ids ${firstId}/${secondId}, ${firstOpen} first)`, () => {
      const f = fixture(true, firstId, secondId);
      f.createOutgoingPeerChannels('P4', f.a);
      f.createOutgoingPeerChannels('P3', f.b);
      const aOut = f.a.pc.sent[0],
        bOut = f.b.pc.sent[0];
      const aIn = f.wire(bOut, f.a),
        bIn = f.wire(aOut, f.b);
      const order = firstOpen === 'local' ? [aOut, bOut, aIn, bIn] : [aIn, bIn, aOut, bOut];
      for (const ch of order) ch.open();
      const authoritative = Math.min(firstId, secondId);
      assert.equal(f.a.dc.id, authoritative);
      assert.equal(f.b.dc.id, authoritative);
      f.a.dc.send('P3 owner input');
      f.b.dc.send('P4 owner input');
      assert.deepEqual(JSON.parse(JSON.stringify(f.records.received)), [
        ['P3', authoritative, 'P3 owner input'],
        ['P4', authoritative, 'P4 owner input'],
      ]);
      const rejected = authoritative === aOut.id ? aIn : aOut;
      rejected.onmessage({ data: 'not selected' });
      rejected.close();
      assert.equal(f.records.received.length, 2);
      assert.equal(f.records.disconnected.length, 0);
    });
  }
}

test('one offered channel supports ordinary mixed/legacy peer input', () => {
  const f = fixture(false, 0, 1);
  f.createOutgoingPeerChannels('P4', f.a);
  f.installPeerDataChannelHandlers('P3', f.b);
  const aOut = f.a.pc.sent[0];
  const bIn = f.wire(aOut, f.b);
  aOut.open();
  bIn.open();
  f.a.dc.send('ordinary offer');
  f.b.dc.send('ordinary answer');
  assert.equal(f.records.received.length, 2);
  assert.equal(f.records.opened.length, 2);
});

test('stale callbacks from a replaced PC cannot open, close, or deliver input', () => {
  const f = fixture(true, 0, 1);
  f.createOutgoingPeerChannels('P4', f.a);
  const oldPc = f.a.pc;
  const old = oldPc.sent[0];
  old.open();
  const next = f.side('temporary', 1);
  f.a.pc = next.pc;
  f.createOutgoingPeerChannels('P4', f.a);
  const current = f.a.pc.sent[0];
  current.open();
  const opened = f.records.opened.length;
  old.open();
  old.onmessage({ data: 'stale input' });
  old.close();
  const incomingFromOldPc = new f.Channel('lockstep', 0);
  oldPc.ondatachannel({ channel: incomingFromOldPc });
  incomingFromOldPc.open();
  assert.equal(f.a.dc, current);
  assert.equal(f.records.opened.length, opened);
  assert.equal(f.records.disconnected.length, 0);
  assert.equal(f.records.received.length, 0);
});

test('a selected channel can fall back only to a remaining open channel on that connection', () => {
  const f = fixture(true, 0, 1);
  f.createOutgoingPeerChannels('P4', f.a);
  f.createOutgoingPeerChannels('P3', f.b);
  const aOut = f.a.pc.sent[0],
    bOut = f.b.pc.sent[0];
  const aIn = f.wire(bOut, f.a),
    bIn = f.wire(aOut, f.b);
  // Endpoints can observe opposite orders, and duplicate open callbacks
  // for the same channel must not mutate readiness twice.
  for (const ch of [aOut, bIn, bOut, aIn]) ch.open();
  const opened = f.records.opened.length;
  aOut.open();
  assert.equal(f.records.opened.length, opened);
  aOut.close();
  bIn.close();
  assert.equal(f.a.dc.id, 1);
  assert.equal(f.b.dc.id, 1);
  assert.equal(f.records.disconnected.length, 0);
  aOut.onmessage({ data: 'queued message on the closed primary' });
  assert.equal(f.records.received.length, 0);
  f.b.dc.send('current owner input on surviving channel');
  assert.equal(f.records.received.length, 1);
  aIn.close();
  assert.equal(f.records.disconnected.length, 1);
});

test('legacy duplicate on current connection does not become a trusted verified route', () => {
  const f = fixture(false, 0, 1);
  f.createOutgoingPeerChannels('P4', f.a);
  f.createOutgoingPeerChannels('P3', f.b);
  const aOut = f.a.pc.sent[0],
    bOut = f.b.pc.sent[0];
  const aIn = f.wire(bOut, f.a),
    bIn = f.wire(aOut, f.b);
  for (const ch of [aOut, bIn, bOut, aIn]) ch.open();
  assert.equal(f.a.dc.id, 0);
  // Preserve old-client input on its same-PC open alternative until both
  // versions negotiate the strict single-channel policy.
  bOut.send('legacy owner input');
  assert.equal(f.records.received.length, 1);
  aIn.close();
  bOut.send('late packet on retired channel');
  assert.equal(f.records.received.length, 1);
});

test('open-state beats callback arrival for ready and roster on the winning lane', () => {
  const f = fixture(true, 0, 1);
  f.createOutgoingPeerChannels('P4', f.a);
  f.createOutgoingPeerChannels('P3', f.b);
  const aOut = f.a.pc.sent[0],
    bOut = f.b.pc.sent[0];
  const aIn = f.wire(bOut, f.a),
    bIn = f.wire(aOut, f.b);
  aIn.open();
  bOut.open();
  assert.equal(f.a.dc.id, 1);
  assert.equal(f.b.dc.id, 1);
  // SCTP says both endpoints are open; the receiving page did not get its
  // lower stream's open callback before the reliable control message.
  bIn.readyState = 'open';
  aOut.open();
  f.a.dc.send('ready');
  assert.equal(f.b.dc.id, 0);
  f.b.dc.send('roster:2703:0,1,2,3');
  assert.deepEqual(JSON.parse(JSON.stringify(f.records.received)), [
    ['P3', 0, 'ready'],
    ['P4', 0, 'roster:2703:0,1,2,3'],
  ]);
  bIn.open();
  assert.equal(f.records.opened.filter(([, id]: [string, number]) => id === 0).length, 2);
});

test('sequential closed duplicates do not crowd out the eventual usable lane', () => {
  const f = fixture(true, 1, 0);
  f.createOutgoingPeerChannels('P4', f.a);
  f.createOutgoingPeerChannels('P3', f.b);
  const aOut = f.a.pc.sent[0],
    bOut = f.b.pc.sent[0];
  aOut.open();
  const stale = [];
  for (let id = 3; id < 10; id++) {
    const ch = new f.Channel('lockstep', id);
    f.a.pc.ondatachannel({ channel: ch });
    ch.readyState = 'closed'; // browser event queued, not dispatched
    stale.push(ch);
  }
  const aIn = f.wire(bOut, f.a);
  aIn.open();
  assert.equal(f.a.dc.id, 0);
  for (const ch of stale) ch.onclose?.();
  assert.equal(f.records.disconnected.length, 0);
  assert.equal(f.a.dc.id, 0);
});
