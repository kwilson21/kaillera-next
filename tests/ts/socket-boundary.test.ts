import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkServerMessage,
  createProtocolObserver,
  type ProtocolReport,
  redactPath,
  type WirePayload,
  REPORT_LIMIT,
} from '../../web/src/socket-boundary.ts';
import { KNCore } from '../../web/src/index.ts';

const token = { token: '1762992000.9f8e7d' };

/** A socket that only knows how to hand events to `onAny` listeners, as Socket.IO does. */
const fakeSocket = () => {
  const listeners: Array<(event: string, data: WirePayload) => void> = [];
  return {
    onAny: (listener: (event: string, data: WirePayload) => void): void => {
      listeners.push(listener);
    },
    receive: (event: string, data: WirePayload) => {
      for (const listener of listeners) listener(event, data);
    },
  };
};

const collector = (ready: () => boolean = () => true) => {
  const reports: ProtocolReport[] = [];
  const observer = createProtocolObserver((report) => {
    if (!ready()) return false;
    reports.push(report);
    return true;
  });
  return { reports, observer };
};

const microtasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('a message that matches its schema is not an issue', () => {
  assert.equal(checkServerMessage('upload-token', token), null);
  assert.equal(checkServerMessage('game-ended', { matchId: null }), null);
  assert.equal(checkServerMessage('session-log ack', { lastSeq: 3, auditLastSeq: -1 }), null);
});

test('a message off its schema names the path, not the value', () => {
  const issue = checkServerMessage('game-ended', { matchId: 7 });
  assert.ok(issue?.includes('matchId'));
  const named = checkServerMessage('upload-token', { token: { leaked: 'do-not-report-me' } });
  assert.ok(named?.includes('token'));
  assert.ok(!named?.includes('do-not-report-me'));
});

test('a record key in the path is payload data and is starred out', () => {
  const players = { 'b955ef2d-e4c1-4f6c-ad85-861949b2fe25': { socketId: 7 } };
  const issue = checkServerMessage('users-updated', { players });
  assert.ok(issue?.includes('["players"]["*"]["socketId"]'), issue ?? '');
  assert.ok(!issue?.includes('b955ef2d'));
  // A socket id of letters only is still not a field name: too long.
  assert.equal(redactPath('at ["players"]["PCVeuLuKjKBKLWHAAADx"]["slot"]'), 'at ["players"]["*"]["slot"]');
  assert.equal(redactPath('at ["hostRom"]["game_id"]'), 'at ["hostRom"]["game_id"]');
});

test('relays and unknown events are not judged', () => {
  // Peers' signals and data messages are built by another client, not the server.
  assert.equal(checkServerMessage('webrtc-signal', { sender: 'a', offer: {} }), null);
  assert.equal(checkServerMessage('data-message', { type: 'mode-select', mode: 'turbo' }), null);
  assert.equal(checkServerMessage('connect', undefined), null);
});

test('the observer reports a mismatch on an incoming event', () => {
  const { reports, observer } = collector();
  const socket = fakeSocket();
  observer.observe(socket);
  socket.receive('upload-token', token);
  socket.receive('game-ended', {});
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.type, 'protocol-mismatch');
  assert.equal(reports[0]?.message, 'game-ended');
});

test('the same mismatch is reported once, a different one again', () => {
  const { reports, observer } = collector();
  assert.equal(observer.check('game-ended', {}), false);
  assert.equal(observer.check('game-ended', {}), false);
  assert.equal(observer.check('game-ended', { matchId: 7 }), false);
  assert.equal(observer.check('game-ended', { matchId: null }), true);
  assert.equal(reports.length, 2);
});

test('an ack is checked under the name of the event it answers', () => {
  const { reports, observer } = collector();
  assert.equal(observer.checkAck('session-log', { lastSeq: 1, auditLastSeq: 0 }), true);
  assert.equal(observer.checkAck('join-room', { players: {} }), false);
  assert.equal(reports[0]?.message, 'join-room ack');
});

test('reports wait for the sink, and go out after the handlers of a later event ran', async () => {
  let haveToken = false;
  const { reports, observer } = collector(() => haveToken);
  const socket = fakeSocket();
  observer.observe(socket);
  // The first users-updated arrives before the upload token client events need.
  socket.receive('users-updated', { players: {} });
  assert.equal(reports.length, 0);
  socket.receive('upload-token', token);
  // Socket.IO runs onAny listeners first; the page's handler sets the token after.
  haveToken = true;
  assert.equal(reports.length, 0);
  await microtasks();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.message, 'users-updated');
});

test('a page sends a bounded number of reports', () => {
  const { reports, observer } = collector();
  for (let i = 0; i < REPORT_LIMIT * 3; i += 1)
    observer.check('rom-sharing-updated', { romSharing: `no-${i}`, [`k${i}`]: i });
  // Each of those is the same issue (wrong type at the same path): one report.
  assert.equal(reports.length, 1);
  const many = collector();
  const wrongPayloads: WirePayload[] = [
    null,
    1,
    'x',
    [],
    {},
    { matchId: 1 },
    { matchId: true },
    { matchId: [] },
    { matchId: {} },
  ];
  for (const event of ['game-ended', 'upload-token', 'reconnect-token', 'rom-sharing-updated', 'game-started']) {
    for (const payload of wrongPayloads) many.observer.check(event, payload);
  }
  assert.ok(many.reports.length <= REPORT_LIMIT);
  assert.ok(many.reports.length > 5);
});

test('KNCore exposes the observer to play.js', () => {
  assert.equal(KNCore.protocol.createObserver, createProtocolObserver);
  assert.equal(KNCore.protocol.checkServerMessage, checkServerMessage);
});
