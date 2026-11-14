import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialKNState,
  installKNState,
  type PageState,
  type SafeStorage,
  type StatePage,
} from '../../web/src/kn-state.ts';
import { plain } from './load-shared.ts';

const memoryStorage = (): SafeStorage & { calls: string[] } => {
  const values = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    get: (store, key) => {
      calls.push(`get ${store} ${key}`);
      return values.get(`${store}:${key}`) ?? null;
    },
    set: (store, key, value) => {
      calls.push(`set ${store} ${key}`);
      values.set(`${store}:${key}`, value);
    },
    remove: (store, key) => {
      calls.push(`remove ${store} ${key}`);
      values.delete(`${store}:${key}`);
    },
  };
};

/** The fields that are data, without the storage functions. */
const dataOf = (state: PageState): Record<string, string> =>
  Object.fromEntries(
    Object.entries(plain(JSON.parse(JSON.stringify(state)))).map(([key, value]) => [key, JSON.stringify(value)]),
  );

/**
 * The state web/static/kn-state.js built, captured before it was removed
 * (`git show d7dc88c:web/static/kn-state.js`). Scripts read these starting
 * values; changing one here is changing what a page starts with.
 */
const BUILT_BY_THE_SCRIPT = {
  remapActive: 'false',
  touchInput: '{}',
  peers: '{}',
  frameNum: '0',
  delayAutoValue: '2',
  romHash: 'null',
  gameId: 'null',
  room: 'null',
  slot: '-1',
  uploadToken: 'null',
  sessionStats: '{"reconnects":0,"desyncs":0,"stalls":0}',
  matchId: 'null',
  isLocalHost: 'false',
  boardFrame: 'false',
  DEFAULT_ICE_SERVERS: '[{"urls":"stun:stun.cloudflare.com:3478"}]',
} satisfies Record<string, string>;

test('a page starts with the state kn-state.js built', () => {
  const typed = initialKNState(memoryStorage());
  assert.deepEqual(dataOf(typed), BUILT_BY_THE_SCRIPT);
  assert.deepEqual(
    Object.keys(typed).sort(),
    [...Object.keys(BUILT_BY_THE_SCRIPT), 'safeGet', 'safeSet', 'safeRemove'].sort(),
  );
});

test('the storage helpers go to the storage', () => {
  const storage = memoryStorage();
  const state = initialKNState(storage);
  state.safeSet('sessionStorage', 'a', '1');
  assert.equal(state.safeGet('sessionStorage', 'a'), '1');
  state.safeRemove('sessionStorage', 'a');
  assert.equal(state.safeGet('sessionStorage', 'a'), null);
  assert.deepEqual(storage.calls, [
    'set sessionStorage a',
    'get sessionStorage a',
    'remove sessionStorage a',
    'get sessionStorage a',
  ]);
});

test('installing puts the starting state on the page', () => {
  const storage = memoryStorage();
  const page: StatePage = { KNStorage: storage };
  installKNState(page);
  assert.ok(page.KNState, 'no KNState was set');
  assert.deepEqual(dataOf(page.KNState), BUILT_BY_THE_SCRIPT);
  page.KNState.safeSet('localStorage', 'k', 'v');
  assert.deepEqual(storage.calls, ['set localStorage k']);
});

test('a page that did not load storage.js gets no state', (t) => {
  t.mock.method(console, 'error', () => {});
  const page: StatePage = {};
  installKNState(page);
  assert.equal(page.KNState, undefined);
});

test('a peer without a data channel yet fits the type', () => {
  const state = initialKNState(memoryStorage());
  // createBasePeer (web/src/page/peer-connection.ts) starts every peer with `dc: null`.
  state.peers['sid'] = { slot: 1, dc: null };
  assert.equal(state.peers['sid']?.dc ?? null, null); // play.js sets the slot to null for a spectator.
  state.slot = null;
  assert.equal(state.slot, null);
});

test('every page gets its own state objects', () => {
  const storage = memoryStorage();
  const a = initialKNState(storage);
  const b = initialKNState(storage);
  a.sessionStats.reconnects = 3;
  a.touchInput['4'] = 1;
  a.peers['sid'] = { slot: 0 };
  assert.equal(b.sessionStats.reconnects, 0);
  assert.deepEqual(b.touchInput, {});
  assert.deepEqual(b.peers, {});
});
