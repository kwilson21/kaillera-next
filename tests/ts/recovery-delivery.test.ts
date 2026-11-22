import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as resyncRequest from '../../web/src/resync-request.ts';
import { createRecoveryManager } from '../../web/src/recovery-delivery.ts';
import { createRecoveryTransferPool } from '../../web/src/recovery-transfer.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const engineFunction = (name: string) => {
  const start = source.indexOf(`  const ${name} = `);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  };', start) + 5);
};

// Execute the engine's actual handlers, not a second implementation. These
// tests force the rare send/ack orderings before the ROM-backed mesh run.
function room(guests = 2, realTransfers = false) {
  const context = vm.createContext({ resyncRequest, createRecoveryManager, createRecoveryTransferPool });
  vm.runInContext(
    `
    let now = 10000;
    const performance = { now: () => now };
    const window = { KNCore: { resyncRequest, recovery: { createRecoveryManager, createRecoveryTransferPool } } };
    const _playerSlot = 0, _frameNum = 1000, DELAY_FRAMES = 3;
    const INPUT_ASK_OVERDUE_ASKS = 3, INPUT_ASK_OVERDUE_MS = 1500;
    const OVERDUE_MAX_PUSHES = 3, OVERDUE_PUSH_QUIET_MS = 20000, OVERDUE_PUSH_TIMEOUT_MS = 5000;
    const _peers = ${JSON.stringify(Object.fromEntries(Array.from({ length: guests }, (_, i) => [String.fromCharCode(97 + i), { slot: i + 1 }])))};
    const _peerPhantom = {}, _syncChainMovedAt = {}, _knownPlayers = {};
    let _syncEnabled = true;
    const _recovery = createRecoveryManager({timeoutMs:5000, quietMs:20000, maxPushes:3}, notice => _handleRecoveryCommand(notice));
    const _recoveryTransfers = createRecoveryTransferPool();
    const sends = [], drops = [];
    const _config = {};
    const _syncLog = () => {}, KNEvent = () => {};
    const _syncTargetsFor = () => Object.entries(_peers).map(([sid, peer]) => ({ sid, peer }));
    ${
      realTransfers
        ? `
      let _pushingSyncState = false, _proactivePushInFlight = false;
      const _queuedSyncPushes = new Map(), _followUpWatches = new Map();
      const _coreFatalError = false, _hasKnSync = false;
      const _syncQueueEpoch = 1, _syncQueueGen = {}, _syncSendChains = {};
      let captureThrows = false, compressions = 0, holdCompression = false, releaseCompression;
      const compressionGate = new Promise(resolve => { releaseCompression = resolve; });
      window.EJS_emulator = { gameManager: { getState: () => {
        if (captureThrows) throw new Error('capture failure');
        return new Uint8Array([1, 2]);
      } } };
      const compressState = async (state) => { compressions++; if (holdCompression) await compressionGate; return state; };
      const pendingTransports = [];
      const _sendSyncChunksTo = (target) => new Promise((resolve) => {
        pendingTransports.push({ sid: target.sid, resolve });
      });

      ${engineFunction('_runQueuedSyncPush')}
      ${engineFunction('sendSyncChunks')}
      ${engineFunction('pushSyncState')}
    `
        : 'const pushSyncState = (sid, proactive, options) => sends.push({ sid, proactive, options });'
    }
    const hardDisconnectPeer = (sid) => { drops.push(sid); delete _peers[sid]; };
    ${engineFunction('_handleRecoveryCommand')}
    ${engineFunction('_onEscalationTransfer')}

    ${engineFunction('_escalateLostInput')}
    ${engineFunction('_checkOverduePushes')}
  `,
    context,
  );
  return (code: string) => vm.runInContext(code, context);
}

test('a delivered source guest cannot settle the third guest whose recovery transfer failed', () => {
  const run = room();
  run(`_escalateLostInput(_peers.a, 'push', now, 900);`);
  assert.equal(run('sends[0].options.escalation.length'), 2);
  run(`_onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);
       _onEscalationTransfer(sends[0].options.escalation, 'b', false, 1000);
       _recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);
       _checkOverduePushes();`);
  assert.equal(run('_recovery.state(1) !== null'), false);
  assert.equal(run('_recovery.state(2) !== null'), true);
  assert.equal(run('sends.length'), 1);
  run('now += 5000; _checkOverduePushes();');
  assert.equal(run('sends.length'), 2);
  assert.equal(run('sends[1].sid'), 'b');
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _recovery.acknowledge(2, 998, _recovery.entries().find((a) => a.slot === 2)?.wireId ?? 0);
       _checkOverduePushes();`);
  assert.equal(run('_recovery.entries().length'), 0);
  assert.equal(run('drops.length'), 0);
});

test('new holes coalesce while their own source still needs recovery', () => {
  const run = room();
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       _escalateLostInput(_peers.b, 'push', now, 901);`);
  assert.equal(run('sends.length'), 1);
});

test('late acknowledgement of an earlier attempt cannot settle its replacement', () => {
  const run = room();
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       _onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);
       now += 5000; _checkOverduePushes();`);
  assert.equal(run('_recovery.state(1)'), 'sending');
  run('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);');
  assert.equal(run('_recovery.state(1)'), 'sending');
  run(`_onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);`);
  assert.equal(run('_recovery.state(1)'), 'sending');
});

test('four-player recovery keeps each missing recipient independently owed', () => {
  const run = room(3);
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       _onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);
       _onEscalationTransfer(sends[0].options.escalation, 'b', false, 1000);
       _onEscalationTransfer(sends[0].options.escalation, 'c', false, 1000);
       _recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);
       _checkOverduePushes(); now += 5000; _checkOverduePushes();`);
  assert.equal(run('sends[0].options.escalation.length'), 3);
  assert.equal(run('sends.length'), 3);
  assert.equal(run('sends[1].sid'), 'b');
  assert.equal(run('sends[2].sid'), 'c');
  // One recipient answers; the other misses three transfers and must rejoin.
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _recovery.acknowledge(2, 998, _recovery.entries().find((a) => a.slot === 2)?.wireId ?? 0);
       _onEscalationTransfer(sends[2].options.escalation, 'c', false, 1001);
       _checkOverduePushes(); now += 5000; _checkOverduePushes();
       _onEscalationTransfer(sends[3].options.escalation, 'c', false, 1002);
       now += 5000; _checkOverduePushes();`);
  assert.equal(run('_recovery.entries().length'), 0);
  assert.equal(run('drops.length'), 1);
  assert.equal(run('drops[0]'), 'c');
});

test('a guest skipped by a follow-up broadcast is pushed a fresh state when its earlier one settles', () => {
  // b still owes hole 1 when a's second hole is broadcast to a and c only.
  // Settling hole 1's state would leave b before hole 2 while the others
  // adopt it (specs/recovery_delivery.qnt, recovery_skipped).
  const run = room(3);
  // Hole 1's state was taken at 990, before the second broadcast (at 1000).
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       for (const sid of ['a', 'b', 'c']) _onEscalationTransfer(sends[0].options.escalation, sid, true, 990);
       _recovery.acknowledge(1, 987, _recovery.entries().find((t) => t.slot === 1).wireId);
       _recovery.acknowledge(3, 987, _recovery.entries().find((t) => t.slot === 3).wireId);
       _checkOverduePushes();
       globalThis.oldB = _recovery.entries().find((t) => t.slot === 2);`);
  assert.equal(run('_recovery.state(2)'), 'awaitingAck');
  run(`now += 1500; _escalateLostInput(_peers.a, 'push', now, 1100);`);
  assert.equal(run('sends[1].options.escalation.map((t) => t.slot).join()'), '1,3');
  run('_recovery.acknowledge(2, 987, oldB.wireId);');
  // b's earlier attempt settled; a fresh one is pushed to b alone.
  assert.equal(run('sends.length'), 3);
  assert.equal(run('sends[2].sid'), 'b');
  assert.equal(run('_recovery.current(sends[2].options.escalation[0])'), true);
  assert.equal(run('_recovery.state(2)'), 'sending');
  // It settles like any attempt, and is owed no further push.
  run(`_onEscalationTransfer(sends[2].options.escalation, 'b', true, 1101);
       _recovery.acknowledge(2, 1098, sends[2].options.escalation[0].wireId);`);
  assert.equal(run('_recovery.state(2)'), null);
  assert.equal(run("sends.filter((s) => s.sid === 'b').length"), 1);
  assert.equal(run('drops.length'), 0);
});

test('a skipped guest whose earlier attempt retries, ends or is reset is owed no follow-up push', () => {
  // A retry captures afresh, so it already covers the later hole.
  const retried = room(3);
  retried(`_escalateLostInput(_peers.a, 'push', now, 900);
           for (const sid of ['a', 'c']) _onEscalationTransfer(sends[0].options.escalation, sid, true, 1000);
           _onEscalationTransfer(sends[0].options.escalation, 'b', false, 1000);
           _recovery.acknowledge(1, 997, _recovery.entries().find((t) => t.slot === 1).wireId);
           _recovery.acknowledge(3, 997, _recovery.entries().find((t) => t.slot === 3).wireId);
           now += 1500; _escalateLostInput(_peers.a, 'push', now, 1100);
           now += 5000; _checkOverduePushes();`);
  assert.equal(retried("sends.filter((s) => s.sid === 'b').length"), 1);
  retried(`_onEscalationTransfer(sends.find((s) => s.sid === 'b').options.escalation, 'b', true, 1200);
           _recovery.acknowledge(2, 1197, _recovery.entries().find((t) => t.slot === 2).wireId);`);
  assert.equal(retried('_recovery.state(2)'), null);
  assert.equal(retried("sends.filter((s) => s.sid === 'b').length"), 1);
  // A reset recipient is owed nothing from before the reset.
  const reset = room(3);
  reset(`_escalateLostInput(_peers.a, 'push', now, 900);
         for (const sid of ['a', 'b', 'c']) _onEscalationTransfer(sends[0].options.escalation, sid, true, 1000);
         _recovery.acknowledge(1, 997, _recovery.entries().find((t) => t.slot === 1).wireId);
         now += 1500; _escalateLostInput(_peers.a, 'push', now, 1100);
         _recovery.reset(2);`);
  assert.equal(reset('_recovery.followUp({ slot: 2, sid: "b", sequence: 1, wireId: 1 }, now).kind'), 'none');
});

test('a skipped guest whose earlier state was taken at or after the newer broadcast is owed nothing', () => {
  // Its state, taken at 1000, already holds what the broadcast at 1000 sent.
  const run = room(3);
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       for (const sid of ['a', 'c']) _onEscalationTransfer(sends[0].options.escalation, sid, true, 990);
       _recovery.acknowledge(1, 987, _recovery.entries().find((t) => t.slot === 1).wireId);
       _recovery.acknowledge(3, 987, _recovery.entries().find((t) => t.slot === 3).wireId);
       globalThis.oldB = _recovery.entries().find((t) => t.slot === 2);
       now += 1500; _escalateLostInput(_peers.a, 'push', now, 1100);
       _onEscalationTransfer(sends[0].options.escalation, 'b', true, 1000);
       _recovery.acknowledge(2, 997, oldB.wireId);`);
  assert.equal(run('_recovery.state(2)'), null);
  assert.equal(run("sends.filter((s) => s.sid === 'b').length"), 0);
});

test('a follow-up is charged to the room capture budget and left once it is spent', () => {
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, () => {});
  const recipients = [1, 2, 3].map((slot) => ({ sid: `s${slot}`, slot, playerId: `p${slot}` }));
  // Hole 1 from slot 1 to all; slot 2 stays owed while slot 1's later holes
  // are broadcast to the others, until the room's nine captures are spent.
  let now = 1000;
  const first = manager.begin(1, 900, recipients, 990, now, true);
  const old2 = first.find((t) => t.slot === 2)!;
  manager.event(old2, { type: 'delivered', attempt: 1, now, before: 987 });
  for (const t of first) if (t.slot !== 2) manager.event(t, { type: 'delivered', attempt: 1, now, before: 987 });
  for (const t of first) if (t.slot !== 2) manager.acknowledge(t.slot, 987, t.wireId);
  // Slot 1's roster identity rotates (as in the identity-churn test), so its
  // own source budget never binds: the room's nine captures are what run out.
  for (let i = 0; i < 8; i++) {
    now += 100;
    const churned = recipients.map((r) => (r.slot === 1 ? { ...r, playerId: `p1-${i}` } : r));
    for (const t of manager.begin(1, 1000 + i, churned, 1000 + i, now, true)) {
      manager.event(t, { type: 'delivered', attempt: 1, now, before: 997 + i });
      manager.acknowledge(t.slot, 997 + i, t.wireId);
    }
  }
  manager.acknowledge(2, 987, old2.wireId);
  const outcome = manager.followUp(old2, now, 990);
  assert.equal(outcome.kind, 'budget');
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('actual broadcast releases one recipient while another is still sending, and old cleanup cannot release its retry', async () => {
  const run = room(2, true);
  run("_escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  assert.equal(run('pendingTransports.length'), 2);
  run("pendingTransports[0].resolve('failed');");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run('now += 5000; _checkOverduePushes();');
  await flush();
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('pendingTransports[2].sid'), 'a');
  assert.equal(run('_recoveryTransfers.size()'), 2);
  // The old broadcast's finally runs now. A's newer token stays reserved.
  run("pendingTransports[1].resolve('sent');");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run("pendingTransports[2].resolve('sent');");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 0);
  assert.equal(run('drops.length'), 0);
});

test('capture exceptions release reservations and the next attempt can run', async () => {
  const run = room(2, true);
  run("captureThrows = true; _escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 0);
  run('captureThrows = false; now += 5000; _checkOverduePushes();');
  await flush();
  assert.equal(run('pendingTransports.length'), 2);
  run("pendingTransports.forEach((t) => t.resolve('sent'));");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 0);
});

test('resetting recovery bookkeeping cannot enqueue additional captures behind live transfers', async () => {
  const run = room(3, true);
  run("_escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  for (let i = 0; i < 10; i++) {
    run(`_recovery.resetAll();
         _escalateLostInput(_peers.a, 'push', now, ${901 + i});`);
  }
  await flush();
  assert.equal(run('compressions'), 1);
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('_recoveryTransfers.size()'), 3);
  run("pendingTransports.forEach((t) => t.resolve('sent'));");
  await flush();
  assert.equal(run('_recoveryTransfers.size()'), 0);
});

test('disabled resync does not start recovery, retry, or drop a peer', () => {
  const run = room();
  run(`_syncEnabled = false;
    _escalateLostInput(_peers.a, 'push', now, 900);
    for (let i = 0; i < 10; i++) { now += 30000; _checkOverduePushes(); }`);
  assert.equal(run('sends.length'), 0);
  assert.equal(run('drops.length'), 0);
  assert.equal(run('_recovery.entries().length'), 0);
});

test('actor credits host freezes and only retries after its remaining acknowledgement deadline', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) => notices.push(n.type));
  const [a] = manager.begin(1, 900, [{ sid: 'a', slot: 1 }], 1000, 10000, true);
  assert.ok(a);
  manager.event(a, { type: 'delivered', attempt: 1, now: 10000, before: 997 });
  manager.freeze(60000, 71000);
  manager.event(a, { type: 'tick', now: 74999, away: false, chainProgress: 0 });
  assert.equal(manager.state(1), 'awaitingAck');
  manager.event(a, { type: 'tick', now: 75000, away: false, chainProgress: 0 });
  assert.deepEqual(notices, ['retry']);
  assert.equal(manager.current(a), false);
  manager.event(a, { type: 'delivered', attempt: 1, now: 75000, before: 997 });
  assert.equal(manager.state(1), 'sending');
});

test('actor failed delivery retries are bounded and reset invalidates every old event', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) => notices.push(n.type));
  manager.begin(1, 900, [{ sid: 'a', slot: 1 }], 1000, 10000, true);
  for (let i = 0; i < 3; i++) {
    const [a] = manager.entries();
    assert.ok(a);
    manager.event(a, { type: 'failed', attempt: a.sequence, now: 10000 + i * 5000 });
    manager.event(a, { type: 'tick', now: 15000 + i * 5000, away: false, chainProgress: 0 });
  }
  assert.deepEqual(notices, ['retry', 'retry', 'drop']);
  assert.equal(manager.state(1), null);
  manager.resetAll();
  const [old] = manager.begin(1, 900, [{ sid: 'a', slot: 1 }], 1000, 30000, true);
  manager.resetAll();
  const [fresh] = manager.begin(1, 900, [{ sid: 'a', slot: 1 }], 1000, 30000, true);
  assert.ok(old);
  assert.ok(fresh);
  manager.event(old, { type: 'failed', attempt: 1, now: 30000 });
  assert.equal(manager.current(fresh), true);
  assert.equal(manager.state(1), 'sending');
});

test('reset skips queued recovery before wire writes but lets started framing drain safely', async () => {
  const run = room(2, true);
  run(`let unblock;
    _syncSendChains.a = new Promise(resolve => { unblock = resolve; });
    _escalateLostInput(_peers.a, 'push', now, 900);`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run('pendingTransports.length'), 1);
  assert.equal(run('pendingTransports[0].sid'), 'b');
  // Toggle-off uses resetAll; reset invalidates the queued attempt, while
  // the already-started B operation still owns its physical reservation.
  run('_syncEnabled = false; _recovery.resetAll(); unblock();');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run('pendingTransports.length'), 1);
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run(`pendingTransports[0].resolve('sent');`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run('_recoveryTransfers.size()'), 0);
  assert.equal(run('_recovery.entries().length'), 0);
  assert.equal(run('drops.length'), 0);
});

// Run frozen production handlers from the reviewed pre-actor candidate and
// the new actual engine adapter through identical multi-recipient traces.
// Disabled mode is an intentional difference tested separately, not
// silently admitted as equivalent.
test('whole recovery lifecycle preserves baseline observable traces across delivery, retry, freeze, and reconnect', () => {
  const baseline = readFileSync(new URL('./fixtures/recovery-before-actor.js', import.meta.url), 'utf8');
  const before = vm.createContext({ resyncRequest });
  vm.runInContext(
    `
    let now = 10000;
    const performance = {now:()=>now};
    const window = {KNCore:{resyncRequest}};
    const _playerSlot=0, _frameNum=1000, DELAY_FRAMES=3;
    const INPUT_ASK_OVERDUE_ASKS=3, INPUT_ASK_OVERDUE_MS=1500;
    const OVERDUE_MAX_PUSHES=3, OVERDUE_PUSH_QUIET_MS=20000, OVERDUE_PUSH_TIMEOUT_MS=5000;
    const _peers={a:{slot:1},b:{slot:2}}, _peerPhantom={}, _syncChainMovedAt={}, _knownPlayers={};
    const _overduePushes={}, _holePushCounts={}, sends=[], drops=[];
    const _config={}, _syncLog=()=>{}, KNEvent=()=>{};
    const _syncTargetsFor=()=>Object.entries(_peers).map(([sid,peer])=>({sid,peer}));
    const pushSyncState=(sid,proactive,options)=>sends.push({sid,proactive,options});
    const hardDisconnectPeer=sid=>{drops.push(sid);delete _peers[sid];};
    ${baseline}
  `,
    before,
  );
  const oldRun = (code: string) => vm.runInContext(code, before);
  const newRun = room();
  const both = (code: string) => {
    oldRun(code);
    newRun(code);
  };
  const compare = () => {
    both('_checkOverduePushes();');
    assert.equal(oldRun('JSON.stringify(sends.map(s=>s.sid))'), newRun('JSON.stringify(sends.map(s=>s.sid))'));
    assert.equal(oldRun('JSON.stringify(drops)'), newRun('JSON.stringify(drops)'));
    assert.equal(oldRun('Object.keys(_overduePushes).length'), newRun('_recovery.entries().length'));
  };
  both(`_escalateLostInput(_peers.a,'push',now,900);
    _onEscalationTransfer(sends[0].options.escalation,'a',true,1000);
    _onEscalationTransfer(sends[0].options.escalation,'b',false,1000);`);
  compare();
  oldRun('_overduePushes[1].settled = true;');
  newRun('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);');
  compare();
  both('now += 5000;');
  compare();
  both(`_onEscalationTransfer(sends[1].options.escalation,'b',true,1001);`);
  compare();
  oldRun('for(const p of Object.values(_overduePushes)){p.armedAt+=60000;if(p.at!==null)p.at+=60000;}');
  newRun('_recovery.freeze(60000,now+60000);');
  both('now += 64999;');
  compare();
  both('now++;');
  compare();
  both(`_onEscalationTransfer(sends[1].options.escalation,'b',true,1001);`);
  compare(); // obsolete completion is ignored by both
  both('_peers.b.reconnecting = true;');
  compare();
  both(`_peers.b.reconnecting = false; _escalateLostInput(_peers.b,'push',now,901);`);
  compare();
  // Genuine no-progress sending uses the baseline's bounded quiet deadline.
  for (let i = 0; i < 3; i++) {
    both('now += 20000;');
    compare();
  }
  assert.equal(oldRun('drops.length'), 2);
});

test('slow in-flight recipient with chain progress does not consume retries or get dropped', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) => notices.push(n.type));
  const [a] = manager.begin(1, 900, [{ sid: 'a', slot: 1 }], 1000, 10000, true);
  assert.ok(a);
  manager.event(a, { type: 'enqueued', attempt: 1, now: 10000 });
  for (let i = 1; i <= 10; i++)
    manager.event(a, { type: 'tick', now: 10000 + i * 30000, away: false, chainProgress: 10000 + i * 30000 });
  assert.deepEqual(notices, []);
  assert.equal(manager.current(a), true);
  manager.event(a, { type: 'delivered', attempt: 1, now: 310000, before: 997 });
  manager.acknowledge(1, 997, manager.entries().find((a) => a.slot === 1)?.wireId ?? 0);
  assert.deepEqual(notices, ['settled']);
});

test('hung compression ends recovery logically without freeing its physical permit or sending a stale state', async () => {
  const run = room(2, true);
  run(`holdCompression = true; _escalateLostInput(_peers.a,'push',now,900);`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run('compressions'), 1);
  run('now += 20000; _checkOverduePushes();');
  await new Promise((resolve) => setTimeout(resolve, 0));
  run('now += 5000; _checkOverduePushes();');
  await new Promise((resolve) => setTimeout(resolve, 0));
  run('now += 5000; _checkOverduePushes();');
  assert.equal(run('drops.length'), 2);
  assert.equal(run('_recovery.entries().length'), 0);
  assert.equal(run('_recoveryTransfers.size()'), 2);
  assert.equal(run('compressions'), 1);
  assert.equal(run('pendingTransports.length'), 0);
  // The outstanding compressor is not physically cancellable. Its late
  // completion releases only its own permits and sends no obsolete header.
  run('releaseCompression();');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run('_recoveryTransfers.size()'), 0);
  assert.equal(run('pendingTransports.length'), 0);
});

test('a settled source recovers a trailing hole while another recipient remains physically blocked', async () => {
  for (const guests of [2, 3]) {
    const run = room(guests, true);
    run("_escalateLostInput(_peers.a, 'push', now, 900);");
    await flush();
    run("const originalB = _recovery.entries().find(a => a.slot === 2); pendingTransports[0].resolve('sent');");
    await flush();
    run('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0); now += 1500;');
    assert.equal(run('_recovery.held(1, 997)'), false);
    run("_escalateLostInput(_peers.a, 'push', now, 997);");
    await flush();
    assert.equal(run('pendingTransports.length'), guests + 1);
    assert.equal(run('pendingTransports.at(-1).sid'), 'a');
    assert.equal(run('_recovery.current(originalB)'), true);
    assert.equal(run('_recoveryTransfers.size()'), guests);
    run("pendingTransports.at(-1).resolve('sent');");
    await flush();
    run('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);');
    assert.equal(run('_recovery.state(1)'), null);
    // B may make slow progress for arbitrarily many acknowledgement periods.
    // Each later rate-limited source hole proceeds without resetting B's token or
    // releasing B's physically pending operation.
    for (let i = 0; i < 5; i++) {
      run(`now += 30001; _syncChainMovedAt.b = now; _syncChainMovedAt.c = now;
           _checkOverduePushes(); _escalateLostInput(_peers.a, 'push', now, ${998 + i});`);
      await flush();
      assert.equal(run('_recovery.current(originalB)'), true);
      assert.equal(run('_recoveryTransfers.size()'), guests);
      run("pendingTransports.at(-1).resolve('sent');");
      await flush();
      run('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);');
      assert.equal(run('drops.length'), 0);
    }
    run("pendingTransports.forEach(t => t.resolve('sent'));");
    await flush();
    assert.equal(run('_recoveryTransfers.size()'), 0);
  }
});

test('persistent failed recipient cannot starve new healthy-source recovery or reset its retry budget', () => {
  const run = room();
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
    _onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);
    _onEscalationTransfer(sends[0].options.escalation, 'b', false);
    _recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);`);
  for (let i = 0; i < 3; i++) {
    assert.equal(run(`_recovery.held(1, ${997 + i})`), false);
    if (i < 2)
      run(`_escalateLostInput(_peers.a, 'push', now, ${997 + i});
      _onEscalationTransfer(sends.at(-1).options.escalation, 'a', true, 1000);
      _recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0);`);
    run('now += 5000; _checkOverduePushes();');
    if (i < 2) run("_onEscalationTransfer(sends.at(-1).options.escalation, 'b', false);");
  }
  assert.equal(run('JSON.stringify(drops)'), '["b"]');
  assert.equal(run("sends.filter(s => s.sid === 'b').length"), 2);
});

test('a reset recipient retaining a physical permit cannot reject a healthy recipient batch', async () => {
  const run = room(2, true);
  run("_escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  run("pendingTransports[0].resolve('sent');");
  await flush();
  run('_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0); _recovery.reset(2);');
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run("_escalateLostInput(_peers.a, 'push', now, 997);");
  await flush();
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('pendingTransports[2].sid'), 'a');
  assert.equal(run('_recoveryTransfers.size()'), 2);
  assert.equal(run('_recovery.state(2)'), 'backoff');
  run("pendingTransports[2].resolve('sent');");
  await flush();
  run(
    '_recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0); now += 5000; _checkOverduePushes();',
  );
  await flush();
  assert.equal(run('_recovery.state(1)'), null);
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run("pendingTransports[1].resolve('sent');");
  await flush();
  run('now += 5000; _checkOverduePushes();');
  await flush();
  assert.equal(run('pendingTransports.length'), 4);
  assert.equal(run('pendingTransports[3].sid'), 'b');
  run("pendingTransports[3].resolve('sent');");
  await flush();
  run('_recovery.acknowledge(2, 997, _recovery.entries().find((a) => a.slot === 2)?.wireId ?? 0);');
  assert.equal(run('drops.length'), 0);
  assert.equal(run('_recoveryTransfers.size()'), 0);
});

test('recovery ACK identifies the exact recipient and attempt across retries and match resets', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) => notices.push(n.type));
  const recipients = [
    { sid: 'a', slot: 1 },
    { sid: 'b', slot: 2 },
  ];
  const [old, other] = manager.begin(1, 900, recipients, 1000, 0, true);
  assert.ok(old);
  assert.ok(other);
  manager.event(old, { type: 'delivered', attempt: 1, now: 0, before: 997 });
  manager.event(old, { type: 'tick', now: 5001, away: false, chainProgress: 0 });
  const retry = manager.entries().find((a) => a.slot === 1)!;
  assert.notEqual(retry.wireId, old.wireId);
  manager.event(retry, { type: 'delivered', attempt: retry.sequence, now: 5001, before: 997 });
  for (const id of [old.wireId, other.wireId, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    manager.acknowledge(1, 997, id);
    assert.equal(manager.state(1), 'awaitingAck');
  }
  manager.acknowledge(1, 997, retry.wireId);
  assert.equal(manager.state(1), null);
  manager.resetAll();
  const [nextMatch] = manager.begin(1, 900, recipients, 1000, 0, true);
  assert.ok(nextMatch);
  manager.event(nextMatch, { type: 'delivered', attempt: 1, now: 0, before: 997 });
  manager.acknowledge(1, 997, retry.wireId);
  assert.equal(manager.state(1), 'awaitingAck');
  manager.acknowledge(1, 997, nextMatch.wireId);
  assert.equal(manager.state(1), null);
});

test('actual receiver keeps tokens across buffering, rejects stale decode and same-frame duplicate', async () => {
  const start = source.indexOf('  async function _handleDecodedSyncPayload(');
  const handler = source.slice(start, source.indexOf('\n  const handleSyncChunksComplete', start));
  const context = vm.createContext({});
  vm.runInContext(
    `
    let _lastAppliedRecoveryId = 7, _lastAppliedSyncHostFrame = 1000;
    let _pendingResyncState = null, _resyncRequestInFlight = false, _resyncRequestId=0;
    const _syncLog = () => {}, _clearLifecycleResyncGuard = () => {};
    const _endsResyncRequest = () => false, _answersAnOlderRequest = () => false;
    const _keepsAwaitedAnswer = () => false;
    ${handler}
    const receive = (id, frame=1000, full=true) => _handleDecodedSyncPayload({
      recoveryId:id, frame, isFull:full, isRegions:false, isProactive:false,
      decompressed:new Uint8Array([1,2]), wireSize:2, source:'dc'
    });
  `,
    context,
  );
  for (const id of [0, 6, 7]) {
    await vm.runInContext(`receive(${id})`, context);
    assert.equal(vm.runInContext('_pendingResyncState', context), null);
  }
  await vm.runInContext('receive(8)', context);
  assert.equal(vm.runInContext('_pendingResyncState.recoveryId', context), 8);
  await vm.runInContext('receive(10)', context);
  await vm.runInContext('receive(9)', context);
  assert.equal(vm.runInContext('_pendingResyncState.recoveryId', context), 10);
  vm.runInContext('_pendingResyncState=null; _lastAppliedRecoveryId=10;', context);
  await vm.runInContext('receive(10)', context);
  await vm.runInContext('receive(11,999)', context);
  await vm.runInContext('receive(11,1000,false)', context);
  assert.equal(vm.runInContext('_pendingResyncState', context), null);
});

test('actual guest keeps legacy settlement and returns exact recovery ACK only to host', () => {
  const context = vm.createContext({});
  vm.runInContext(
    `
    const messages=[[],[]], DELAY_FRAMES=0, _playerSlot=null;
    const _peers={host:{slot:0,dc:{readyState:'open',send:m=>messages[0].push(m)}},
      other:{slot:2,dc:{readyState:'open',send:m=>messages[1].push(m)}}};
    const _isPeerPendingLateJoin=()=>false, _settleInputsBefore=()=>{};
    const _inputAskedAt={}, performance={now:()=>0};
    ${engineFunction('_settleInputsAtResync')}
    _settleInputsAtResync({},1000,17);
  `,
    context,
  );
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(messages)', context)), [
    ['inputs-settled:1000', 'recovery-settled:1000:17'],
    ['inputs-settled:1000'],
  ]);
});

test('new holes and valid acknowledgements cannot renew the cumulative source capture budget', () => {
  const run = room();
  for (let i = 0; i < 3; i++) {
    run(`_escalateLostInput(_peers.a, 'push', now, ${900 + i});
      _onEscalationTransfer(sends.at(-1).options.escalation, 'a', true, 1000);
      _onEscalationTransfer(sends.at(-1).options.escalation, 'b', true, 1000);
      _recovery.acknowledge(1, 997, _recovery.entries().find((a) => a.slot === 1)?.wireId ?? 0); _recovery.acknowledge(2, 997, _recovery.entries().find((a) => a.slot === 2)?.wireId ?? 0);
      _recovery.forgetHistory(1); now += 1500;`);
  }
  assert.equal(run('sends.length'), 3);
  run("_recovery.reset(1); _escalateLostInput(_peers.a, 'push', now, 904);");
  assert.equal(run('sends.length'), 3);
  assert.equal(run('JSON.stringify(drops)'), '["a"]');
  assert.equal(run('!!_peers.b'), true);
});

test('capture budget expires by source and a new match resets its history', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) => notices.push(n.type));
  for (let i = 0; i < 3; i++) {
    manager.begin(1, i, [{ slot: 1, sid: 'a' }], 100, i * 1500, true);
    manager.reset(1);
  }
  assert.equal(manager.begin(1, 4, [{ slot: 1, sid: 'a' }], 100, 30000, true).length, 1);
  manager.reset(1);
  manager.resetAll();
  assert.equal(manager.begin(1, 5, [{ slot: 1, sid: 'a' }], 100, 30001, true).length, 1);
  assert.equal(notices.includes('budget-exhausted'), false);
});

test('wire request flood retains one queued completion and creates no extra Effect operations', async () => {
  const run = room(2, true);
  run("holdCompression = true; const first = pushSyncState('a');");
  await flush();
  run("const queued = pushSyncState('a', false, { requestIds: {a: 1} });");
  await flush();
  await run(
    "Promise.all(Array.from({length: 1000}, (_, i) => pushSyncState('a', false, {waitForResult:false, requestIds:{a:i+2}})))",
  );
  assert.equal(run('_queuedSyncPushes.size'), 1);
  assert.equal(run('compressions'), 1);
  assert.equal(run("_queuedSyncPushes.get('a').options.requestIds.a"), 1001);
  assert.equal(run("'waiters' in _queuedSyncPushes.get('a')"), false);
  assert.equal(run("typeof _queuedSyncPushes.get('a').resolve"), 'function');
  // A coordinated caller colliding with wire traffic waits for the real send,
  // not null (which its dispatch treats as a failed send and requeues).
  run(
    "let coordinatedDone = false; const coordinated = pushSyncState('a', false, {watchFor:['a']}).then(result => { coordinatedDone = true; return result; });",
  );
  await flush();
  assert.equal(run('coordinatedDone'), false);
  run('releaseCompression();');
  await flush();
  run("pendingTransports.forEach(t => t.resolve('sent'));");
  await flush();
  run("pendingTransports.forEach(t => t.resolve('sent'));");
  await run('Promise.all([first, queued, coordinated])');
  assert.equal(run('coordinatedDone'), true);
  assert.notEqual(await run('coordinated'), null);
  assert.equal(run('compressions'), 2);
  assert.equal(run('_queuedSyncPushes.size'), 0);
});

test('source identity budget survives slot changes without charging a replacement guest', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) =>
    notices.push(n.attempt.sid),
  );
  for (let i = 0; i < 3; i++) {
    manager.begin(1, i, [{ slot: 1, sid: 'a', playerId: 'player-a' }], 100, i * 1000, true);
    manager.reset(1);
  }
  assert.equal(manager.begin(1, 4, [{ slot: 1, sid: 'replacement', playerId: 'player-b' }], 100, 4000, true).length, 1);
  assert.equal(manager.begin(2, 4, [{ slot: 2, sid: 'a', playerId: 'player-a' }], 100, 4000, true).length, 0);
  assert.equal(notices.at(-1), 'a');
  manager.reset(2);
  assert.equal(manager.begin(2, 5, [{ slot: 2, sid: 'a', playerId: 'player-a' }], 100, 5000, true).length, 0);
  assert.equal(notices.at(-1), 'a');
});

test('actual engine charges the roster player across socket rotation and ignores peer identity claims', () => {
  const run = room();
  run("_knownPlayers.a = {persistentId: 'authenticated-player'};");
  let sid = 'a';
  for (let i = 0; i < 3; i++) {
    run(`_peers['${sid}'].persistentId = 'untrusted-claim-${i}';
      _escalateLostInput(_peers['${sid}'], 'push', now, ${900 + i});
      for (const attempt of sends.at(-1).options.escalation) {
        _onEscalationTransfer([attempt], attempt.sid, true, 1000);
        _recovery.acknowledge(attempt.slot, 997, attempt.wireId);
      }
      _recovery.reset(1);
      _peers['rotated-${i}'] = _peers['${sid}']; delete _peers['${sid}'];
      _knownPlayers['rotated-${i}'] = _knownPlayers['${sid}']; delete _knownPlayers['${sid}'];
      now += 1500;`);
    sid = `rotated-${i}`;
  }
  assert.equal(run('sends.length'), 3);
  run(`_peers['${sid}'].persistentId = 'yet-another-untrusted-claim';
    _escalateLostInput(_peers['${sid}'], 'push', now, 904);`);
  assert.equal(run('sends.length'), 3);
  assert.equal(run('JSON.stringify(drops)'), JSON.stringify([sid]));
  assert.equal(run('!!_peers.b'), true);
  // An unrelated authenticated replacement in the same slot is independent.
  run(`_recovery.reset(1); _peers.replacement = {slot:1, persistentId:'authenticated-player'};
    _knownPlayers.replacement = {persistentId:'different-player'};
    _escalateLostInput(_peers.replacement, 'push', now, 905);`);
  assert.equal(run('sends.length'), 4);
  assert.equal(run('sends.at(-1).options.escalation.find(a => a.slot === 1).sid'), 'replacement');
});

test('unrecognized rotating socket keys cannot use peer claims to renew a slot budget', () => {
  const run = room(1);
  for (let i = 0; i < 3; i++) {
    run(`_peers.a.persistentId = 'claim-${i}';
      _escalateLostInput(_peers.a, 'push', now, ${900 + i});
      const attempt${i} = sends.at(-1).options.escalation[0];
      _onEscalationTransfer([attempt${i}], 'a', true, 1000);
      _recovery.acknowledge(1, 997, attempt${i}.wireId); _recovery.reset(1); now += 1500;`);
  }
  run(
    "_peers.rotated = _peers.a; delete _peers.a; _peers.rotated.persistentId = 'new-claim'; _escalateLostInput(_peers.rotated, 'push', now, 904);",
  );
  assert.equal(run('sends.length'), 3);
  assert.equal(run('JSON.stringify(drops)'), '["rotated"]');
});

test('persistent player budget expires and match reset clears it across new socket keys', () => {
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, () => {});
  for (let i = 0; i < 3; i++) {
    assert.equal(manager.begin(1, i, [{ slot: 1, sid: `socket-${i}`, playerId: 'p' }], 100, i * 1000, true).length, 1);
    manager.reset(1);
  }
  assert.equal(manager.begin(1, 4, [{ slot: 1, sid: 'rotated', playerId: 'p' }], 100, 29999, true).length, 0);
  assert.equal(manager.begin(1, 4, [{ slot: 1, sid: 'rotated', playerId: 'p' }], 100, 30000, true).length, 1);
  manager.resetAll();
  assert.equal(manager.begin(1, 5, [{ slot: 1, sid: 'next-match', playerId: 'p' }], 100, 30001, true).length, 1);
});

test('roster omission on the same authenticated connection cannot renew capture budget', () => {
  const run = room(1);
  run("_knownPlayers.a={persistentId:'player-a'}");
  for (let i = 0; i < 3; i++) {
    run(`_escalateLostInput(_peers.a,'push',now,${900 + i});`);
    run(`const attempt${i}=sends.at(-1).options.escalation[0];
      _onEscalationTransfer([attempt${i}], 'a', true, 1000);
      _recovery.acknowledge(1,997,attempt${i}.wireId);`);
  }
  run("delete _knownPlayers.a; _escalateLostInput(_peers.a,'push',now,904)");
  assert.equal(run('sends.length'), 3);
  assert.equal(run('JSON.stringify(drops)'), '["a"]');
});

test('client identity churn cannot exceed the room capture window; expiry and match reset release it', () => {
  const notices: string[] = [];
  const manager = createRecoveryManager({ timeoutMs: 5000, quietMs: 20000, maxPushes: 3 }, (n) =>
    notices.push(n.attempt.sid),
  );
  for (let i = 0; i < 9; i++) {
    assert.equal(
      manager.begin(1, i, [{ slot: 1, sid: `socket-${i}`, playerId: `player-${i}` }], 100, i * 1000, true).length,
      1,
    );
    manager.reset(1);
  }
  assert.equal(manager.begin(1, 10, [{ slot: 1, sid: 'fresh', playerId: 'fresh' }], 100, 9000, true).length, 0);
  assert.deepEqual(notices, ['fresh']);
  manager.reset(1);
  assert.equal(manager.begin(1, 11, [{ slot: 1, sid: 'fresh', playerId: 'fresh' }], 100, 30000, true).length, 1);
  manager.reset(1);
  manager.resetAll();
  assert.equal(manager.begin(1, 12, [{ slot: 1, sid: 'fresh', playerId: 'fresh' }], 100, 30001, true).length, 1);
});

test('room cap stops actual capture and compression before a fresh identity can broadcast', async () => {
  const run = room(1, true);
  for (let i = 0; i < 9; i++) {
    run(`_knownPlayers.a={persistentId:'identity-${i}'};
      _escalateLostInput(_peers.a,'push',now,${900 + i});`);
    await flush();
    run("pendingTransports.at(-1).resolve('sent')");
    await flush();
    run('_recovery.reset(1)');
  }
  assert.equal(run('compressions'), 9);
  run("_knownPlayers.a={persistentId:'fresh'};_escalateLostInput(_peers.a,'push',now,999)");
  await flush();
  assert.equal(run('compressions'), 9);
  assert.equal(run('JSON.stringify(drops)'), '["a"]');
});
