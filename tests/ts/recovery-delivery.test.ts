import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as resyncRequest from '../../web/src/resync-request.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const engineFunction = (name: string) => {
  const start = source.indexOf(`  const ${name} = `);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  };', start) + 5);
};

// Execute the engine's actual handlers, not a second implementation. These
// tests force the rare send/ack orderings before the ROM-backed mesh run.
function room(guests = 2, realTransfers = false) {
  const context = vm.createContext({ resyncRequest });
  vm.runInContext(
    `
    let now = 10000;
    const performance = { now: () => now };
    const window = { KNCore: { resyncRequest } };
    const _playerSlot = 0, _frameNum = 1000, DELAY_FRAMES = 3;
    const INPUT_ASK_OVERDUE_ASKS = 3, INPUT_ASK_OVERDUE_MS = 1500;
    const OVERDUE_MAX_PUSHES = 3, OVERDUE_PUSH_QUIET_MS = 20000, OVERDUE_PUSH_TIMEOUT_MS = 5000;
    const _peers = ${JSON.stringify(Object.fromEntries(Array.from({ length: guests }, (_, i) => [String.fromCharCode(97 + i), { slot: i + 1 }])))}; 
    const _overduePushes = {}, _holePushCounts = {}, _peerPhantom = {}, _syncChainMovedAt = {}, _knownPlayers = {};
    const sends = [], drops = [];
    const _config = {};
    const _syncLog = () => {}, KNEvent = () => {};
    const _syncTargetsFor = () => Object.entries(_peers).map(([sid, peer]) => ({ sid, peer }));
    ${
      realTransfers
        ? `
      let _pushingSyncState = false, _proactivePushInFlight = false;
      const _queuedSyncPushes = new Map(), _escalationTransfers = new Map(), _followUpWatches = new Map();
      const _coreFatalError = false, _syncEnabled = true, _hasKnSync = false;
      const _syncQueueEpoch = 1, _syncQueueGen = {}, _syncSendChains = {};
      let captureThrows = false, compressions = 0;
      window.EJS_emulator = { gameManager: { getState: () => {
        if (captureThrows) throw new Error('capture failure');
        return new Uint8Array([1, 2]);
      } } };
      const compressState = async (state) => { compressions++; return state; };
      const pendingTransports = [];
      const _sendSyncChunksTo = (target) => new Promise((resolve) => {
        pendingTransports.push({ sid: target.sid, resolve });
      });
      ${engineFunction('_releaseEscalationTransfers')}
      ${engineFunction('_runQueuedSyncPush')}
      ${engineFunction('sendSyncChunks')}
      ${engineFunction('pushSyncState')}
    `
        : 'const pushSyncState = (sid, proactive, options) => sends.push({ sid, proactive, options });'
    }
    const hardDisconnectPeer = (sid) => { drops.push(sid); delete _peers[sid]; };
    ${engineFunction('_sendEscalationPush')}
    ${engineFunction('_onEscalationTransfer')}
    ${engineFunction('_forgetHolePushes')}
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
       _overduePushes[1].settled = true;
       _checkOverduePushes();`);
  assert.equal(run('!!_overduePushes[1]'), false);
  assert.equal(run('!!_overduePushes[2]'), true);
  assert.equal(run('sends.length'), 1);
  run('now += 5000; _checkOverduePushes();');
  assert.equal(run('sends.length'), 2);
  assert.equal(run('sends[1].sid'), 'b');
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _overduePushes[2].settled = resyncRequest.acknowledgesDeliveredPush(true, _overduePushes[2].deliveredBefore, 998);
       _checkOverduePushes();`);
  assert.equal(run('Object.keys(_overduePushes).length'), 0);
  assert.equal(run('drops.length'), 0);
});

test('new holes coalesce while any broadcast recipient still needs recovery', () => {
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
  assert.equal(run('_overduePushes[1].at'), null);
  assert.equal(
    run(
      'resyncRequest.acknowledgesDeliveredPush(_overduePushes[1].at !== null, _overduePushes[1].deliveredBefore ?? -1, 997)',
    ),
    false,
  );
  run(`_onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);`);
  assert.equal(run('_overduePushes[1].at'), null);
});

test('four-player recovery keeps each missing recipient independently owed', () => {
  const run = room(3);
  run(`_escalateLostInput(_peers.a, 'push', now, 900);
       _onEscalationTransfer(sends[0].options.escalation, 'a', true, 1000);
       _onEscalationTransfer(sends[0].options.escalation, 'b', false, 1000);
       _onEscalationTransfer(sends[0].options.escalation, 'c', false, 1000);
       _overduePushes[1].settled = true;
       _checkOverduePushes(); now += 5000; _checkOverduePushes();`);
  assert.equal(run('sends[0].options.escalation.length'), 3);
  assert.equal(run('sends.length'), 3);
  assert.equal(run('sends[1].sid'), 'b');
  assert.equal(run('sends[2].sid'), 'c');
  // One recipient answers; the other misses three transfers and must rejoin.
  run(`_onEscalationTransfer(sends[1].options.escalation, 'b', true, 1001);
       _overduePushes[2].settled = true;
       _onEscalationTransfer(sends[2].options.escalation, 'c', false, 1001);
       _checkOverduePushes(); now += 5000; _checkOverduePushes();
       _onEscalationTransfer(sends[3].options.escalation, 'c', false, 1002);
       now += 5000; _checkOverduePushes();`);
  assert.equal(run('Object.keys(_overduePushes).length'), 0);
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
  assert.equal(run('_escalationTransfers.has(1)'), false);
  assert.equal(run('_escalationTransfers.has(2)'), true);
  run('now += 5000; _checkOverduePushes();');
  await flush();
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('pendingTransports[2].sid'), 'a');
  assert.equal(run('_escalationTransfers.has(1)'), true);
  // The old broadcast's finally runs now. A's newer token stays reserved.
  run("pendingTransports[1].resolve('sent');");
  await flush();
  assert.equal(run('_escalationTransfers.has(1)'), true);
  run("pendingTransports[2].resolve('sent');");
  await flush();
  assert.equal(run('_escalationTransfers.size'), 0);
  assert.equal(run('drops.length'), 0);
});

test('capture exceptions release reservations and the next attempt can run', async () => {
  const run = room(2, true);
  run("captureThrows = true; _escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  assert.equal(run('_escalationTransfers.size'), 0);
  run('captureThrows = false; now += 5000; _checkOverduePushes();');
  await flush();
  assert.equal(run('pendingTransports.length'), 2);
  run("pendingTransports.forEach((t) => t.resolve('sent'));");
  await flush();
  assert.equal(run('_escalationTransfers.size'), 0);
});

test('resetting recovery bookkeeping cannot enqueue additional captures behind live transfers', async () => {
  const run = room(3, true);
  run("_escalateLostInput(_peers.a, 'push', now, 900);");
  await flush();
  for (let i = 0; i < 10; i++) {
    run(`Object.keys(_overduePushes).forEach((slot) => delete _overduePushes[slot]);
         _escalateLostInput(_peers.a, 'push', now, ${901 + i});`);
  }
  await flush();
  assert.equal(run('compressions'), 1);
  assert.equal(run('pendingTransports.length'), 3);
  assert.equal(run('_escalationTransfers.size'), 3);
  run("pendingTransports.forEach((t) => t.resolve('sent'));");
  await flush();
  assert.equal(run('_escalationTransfers.size'), 0);
});
