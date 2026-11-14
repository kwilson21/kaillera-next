import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialTransition, transition } from 'xstate';
import { rejoinMachine } from '../../web/src/rejoin-machine.ts';

type Event = Parameters<typeof transition<typeof rejoinMachine>>[2];
const after = (...events: Event[]) => {
  let [snapshot] = initialTransition(rejoinMachine);
  for (const event of events) [snapshot] = transition(rejoinMachine, snapshot, event);
  return snapshot.value;
};
const up = { type: 'socketUp', gameOn: true } as const;

test('a socket that connects in the lobby starts no rejoin', () => {
  assert.equal(after(), 'idle');
  assert.equal(after({ type: 'socketUp', gameOn: false }), 'idle');
});

test('a socket that connects under a game starts the rejoin', () => {
  assert.equal(after(up), 'rejoining');
});

test('the rejoin ends with the socket, with the game, and with its own program', () => {
  assert.equal(after(up, { type: 'socketDown' }), 'idle');
  assert.equal(after(up, { type: 'gameOver' }), 'idle');
  assert.equal(after(up, { type: 'socketUp', gameOn: false }), 'idle');
});

test('a newer connection while rejoining asks again and stays rejoining', () => {
  assert.equal(after(up, up), 'rejoining');
});

test('the rejoin program is invoked in `rejoining` and nowhere else', () => {
  const [idle] = initialTransition(rejoinMachine);
  const [rejoining, actions] = transition(rejoinMachine, idle, up);
  assert.deepEqual(Object.keys(rejoining.children), ['attempt']);
  assert.ok(actions.length > 0, 'entering `rejoining` starts the invoked program');
  const [back, stopping] = transition(rejoinMachine, rejoining, { type: 'socketDown' });
  assert.deepEqual(Object.keys(back.children), []);
  assert.ok(stopping.length > 0, 'leaving `rejoining` stops it');
});
