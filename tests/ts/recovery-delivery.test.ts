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
       _recovery.acknowledge(1, 997);
       _checkOverduePushes();`);
  assert.equal(run('_recovery.state(1) !== null'), false);
  assert.equal(run('_recovery.state(2) !== null'), true);
  assert.equal(run('sends.length'), 1);
  run('now += 5000; _checkOverduePushes();');
  assert.equal(run('sends.length'), 2);
  assert.equal(run('sends[1].sid'), 'b');
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _recovery.acknowledge(2, 998);
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
  run('_recovery.acknowledge(1, 997);');
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
       _recovery.acknowledge(1, 997);
       _checkOverduePushes(); now += 5000; _checkOverduePushes();`);
  assert.equal(run('sends[0].options.escalation.length'), 3);
  assert.equal(run('sends.length'), 3);
  assert.equal(run('sends[1].sid'), 'b');
  assert.equal(run('sends[2].sid'), 'c');
  // One recipient answers; the other misses three transfers and must rejoin.
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _recovery.acknowledge(2, 998);
       _onEscalationTransfer(sends[2].options.escalation, 'c', false, 1001);
       _checkOverduePushes(); now += 5000; _checkOverduePushes();
       _onEscalationTransfer(sends[3].options.escalation, 'c', false, 1002);
       now += 5000; _checkOverduePushes();`);
  assert.equal(run('_recovery.entries().length'), 0);
  assert.equal(run('drops.length'), 1);
  assert.equal(run('drops[0]'), 'c');
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
  newRun('_recovery.acknowledge(1,997);');
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
  manager.acknowledge(1, 997);
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
    run('_recovery.acknowledge(1, 997); now += 1500;');
    assert.equal(run('_recovery.held(1, 997)'), false);
    run("_escalateLostInput(_peers.a, 'push', now, 997);");
    await flush();
    assert.equal(run('pendingTransports.length'), guests + 1);
    assert.equal(run('pendingTransports.at(-1).sid'), 'a');
    assert.equal(run('_recovery.current(originalB)'), true);
    assert.equal(run('_recoveryTransfers.size()'), guests);
    run("pendingTransports.at(-1).resolve('sent');");
    await flush();
    run('_recovery.acknowledge(1, 997);');
    assert.equal(run('_recovery.state(1)'), null);
    // B may make slow progress for arbitrarily many acknowledgement periods.
    // Each later source hole still proceeds without resetting B's token or
    // releasing B's physically pending operation.
    for (let i = 0; i < 5; i++) {
      run(`now += 4000; _syncChainMovedAt.b = now; _syncChainMovedAt.c = now;
           _checkOverduePushes(); _escalateLostInput(_peers.a, 'push', now, ${998 + i});`);
      await flush();
      assert.equal(run('_recovery.current(originalB)'), true);
      assert.equal(run('_recoveryTransfers.size()'), guests);
      run("pendingTransports.at(-1).resolve('sent');");
      await flush();
      run('_recovery.acknowledge(1, 997);');
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
    _recovery.acknowledge(1, 997);`);
  for (let i = 0; i < 3; i++) {
    assert.equal(run(`_recovery.held(1, ${997 + i})`), false);
    run(`_escalateLostInput(_peers.a, 'push', now, ${997 + i});
      _onEscalationTransfer(sends.at(-1).options.escalation, 'a', true, 1000);
      _recovery.acknowledge(1, 997); now += 5000; _checkOverduePushes();`);
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
  run('_recovery.acknowledge(1, 997); _recovery.reset(2);');
  assert.equal(run('_recoveryTransfers.size()'), 1);
  run("_escalateLostInput(_peers.a, 'push', now, 997);");
  await flush();
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('pendingTransports[2].sid'), 'a');
  assert.equal(run('_recoveryTransfers.size()'), 2);
  assert.equal(run('_recovery.state(2)'), 'backoff');
  run("pendingTransports[2].resolve('sent');");
  await flush();
  run('_recovery.acknowledge(1, 997); now += 5000; _checkOverduePushes();');
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
  run('_recovery.acknowledge(2, 997);');
  assert.equal(run('drops.length'), 0);
  assert.equal(run('_recoveryTransfers.size()'), 0);
});
