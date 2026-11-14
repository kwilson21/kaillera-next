import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, inviteUrl, roomClosedMessage, rosterToasts, type Roster } from '../../web/src/play/room-text.ts';

const named = (...names: string[]): Roster =>
  Object.fromEntries(names.map((name) => [`pid-${name}`, { playerName: name }]));

test('names are escaped before they reach HTML', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('1')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;',
  );
  assert.equal(escapeHtml('Plain Name'), 'Plain Name');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
});

test('the closed-room message names the host when it knows one', () => {
  assert.match(roomClosedMessage('Kaz'), /^Kaz's room has closed\..*Ask Kaz for a new link/);
  for (const nobody of ['', '   ', null, undefined]) {
    assert.match(roomClosedMessage(nobody), /^This room has closed\..*Ask for a new link/);
  }
});

test('invite links go to the invite page, with the room code encoded', () => {
  assert.equal(inviteUrl('https://example.test', 'ABC123', false), 'https://example.test/join?room=ABC123');
  assert.equal(inviteUrl('https://example.test', 'ABC123', true), 'https://example.test/join?room=ABC123&spectate=1');
  assert.equal(inviteUrl('http://localhost:27888', 'a b&c', false), 'http://localhost:27888/join?room=a%20b%26c');
});

test('the first roster a page sees announces nobody', () => {
  assert.deepEqual(rosterToasts({}, {}, named('Host', 'Guest'), named('Watcher')), []);
});

test('joining, leaving and watching are each announced once', () => {
  const before = named('Host');
  assert.deepEqual(rosterToasts(before, {}, named('Host', 'Guest'), {}), ['Guest joined']);
  assert.deepEqual(rosterToasts(named('Host', 'Guest'), {}, before, {}), ['Guest left']);
  assert.deepEqual(rosterToasts(before, {}, before, named('Watcher')), ['Watcher is watching']);
  assert.deepEqual(rosterToasts(before, named('Watcher'), before, {}), ['Watcher left']);
  assert.deepEqual(rosterToasts(before, {}, before, {}), []);
});

test('moving between playing and watching is not a join or a leave', () => {
  const host = named('Host');
  const guest = named('Guest');
  // Guest stops playing and watches instead.
  assert.deepEqual(rosterToasts({ ...host, ...guest }, {}, host, guest), []);
  // And claims a slot again.
  assert.deepEqual(rosterToasts(host, guest, { ...host, ...guest }, {}), []);
});

test('several changes in one update come out in a fixed order, names escaped', () => {
  const toasts = rosterToasts(named('Host', 'Old'), named('Gone'), named('Host', '<b>New</b>'), named('Eye'));
  assert.deepEqual(toasts, ['&lt;b&gt;New&lt;/b&gt; joined', 'Old left', 'Eye is watching', 'Gone left']);
});
