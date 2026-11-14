import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REFRESH_MS,
  closedView,
  factsText,
  failedLookupShowsWaiting,
  firstStep,
  inAppBrowser,
  inviteFrom,
  inviteView,
  lookupResult,
  looksUpOnReturn,
  slotClass,
} from '../../web/src/landing/join.ts';
import {
  directWakeUrl,
  elapsedText,
  hostUrl,
  isSlowWake,
  nextPingTimeout,
  playUrl,
  roomCodeFrom,
  wakeReport,
} from '../../web/src/landing/wake.ts';
import { isHealthAnswer, isRoomAnswer, type RoomAnswer } from '../../web/src/landing/wire.ts';
import {
  FakePage,
  bundleInputs,
  runBundle,
  runOldScript,
  type JsonBody,
  type PageOptions,
  type Reply,
} from './landing-fake-page.ts';

// The invite page as a visitor meets it is tests/test_join_page.py, in a real
// browser. Here the TypeScript is held to the script it replaced:
// tests/ts/oracles/join.js is web/static/join.js as of #166, unchanged. Both
// run on the same fake page and must leave it the same after every step.

const ORIGIN = 'https://kn.example';

/** The old script and the new bundle, each on its own copy of the page. */
class Pair {
  readonly old: FakePage;
  readonly next: FakePage;

  constructor(search: string, options: Partial<PageOptions> = {}) {
    const all: PageOptions = { file: 'join.html', url: `${ORIGIN}/join${search}`, ...options };
    this.old = new FakePage(all);
    this.next = new FakePage(all);
  }

  /** Do the same thing to both pages, let them settle, and require them equal. */
  async step(what: string, act: (page: FakePage) => void | Promise<void>): Promise<void> {
    for (const page of [this.old, this.next]) {
      await act(page);
      await page.settle();
    }
    assert.equal(this.next.snapshot(), this.old.snapshot(), what);
  }

  serve(server: (url: string) => Reply): void {
    this.old.server = server;
    this.next.server = server;
  }

  async load(): Promise<void> {
    runOldScript('join.js', this.old);
    runBundle('join-entry.ts', this.next);
    await this.step('after loading', () => {});
  }
}

/** A `/room/<code>` answer as the server sends it, with some fields changed. */
interface RoomFields {
  readonly [field: string]: JsonBody;
}

const room = (fields: RoomFields = {}): RoomFields => ({
  status: 'lobby',
  player_count: 1,
  max_players: 4,
  has_password: false,
  game_id: 'ssb64',
  romName: null,
  host_name: 'Kaz',
  listed: false,
  closed: false,
  ...fields,
});

const awake =
  (roomReply: Reply) =>
  (url: string): Reply =>
    url.endsWith('/health') ? { status: 200, json: { status: 'ok' } } : url.includes('/room/') ? roomReply : 'fail';

const shown = (page: FakePage): string[] =>
  ['inv-loading', 'inv-main', 'inv-closed', 'inv-unsupported', 'inv-waking'].filter(
    (id) => !page.el(id).attrs.has('hidden'),
  );

// ── Whole-page sequences, old against new ───────────────────────────────────

test('a link with no usable room code is a closed room, with no request made', async () => {
  for (const search of ['', '?room=', '?room=ab', '?room=has%20space', '?room=WAYTOOLONGFORAROOMCODE', '?spectate=1']) {
    const pair = new Pair(search);
    pair.serve(awake({ status: 200, json: room() }));
    await pair.load();
    assert.deepEqual(shown(pair.next), ['inv-closed'], search);
    assert.deepEqual(pair.next.requests, []);
    assert.equal(pair.next.el('closed-title').textContent, 'This room has closed.');
  }
});

test('a browser with no WebRTC is told so without a lookup', async () => {
  const pair = new Pair('?room=KAZ64', { webrtc: false });
  pair.serve(awake({ status: 200, json: room() }));
  await pair.load();
  assert.deepEqual(shown(pair.next), ['inv-unsupported']);
  assert.deepEqual(pair.next.requests, []);
});

test('every kind of open room reads the same as it did, for a player link and a spectator link', async () => {
  let compared = 0;
  for (const search of ['?room=KAZ64', '?room=KAZ64&spectate=1']) {
    for (const wasm of [true, false]) {
      for (const status of ['lobby', 'playing']) {
        for (const [player_count, max_players] of [
          [0, 4],
          [1, 4],
          [3, 4],
          [4, 4],
          [5, 4],
          [2, 2],
          [1, 2],
          [0, 0],
        ] as const) {
          for (const host_name of ['Kaz', '', '  ', ' Agent 21 ', null]) {
            for (const game of [
              { game_id: 'ssb64', romName: null },
              { game_id: 'smash-remix', romName: 'Smash Remix 1.5.2' },
              { game_id: 'mk64', romName: 'Mario Kart 64' },
              { game_id: null, romName: null },
              { game_id: null, romName: '' },
            ]) {
              const pair = new Pair(search, { wasm });
              pair.serve(awake({ status: 200, json: room({ status, player_count, max_players, host_name, ...game }) }));
              await pair.load();
              assert.deepEqual(shown(pair.next), ['inv-main']);
              compared++;
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 2 * 2 * 2 * 8 * 5 * 5);
});

test('the invite view says what the old page put on screen', async () => {
  for (const spectate of [false, true]) {
    for (const fields of [
      {},
      { player_count: 4 },
      { status: 'playing', host_name: '' },
      { game_id: 'other', romName: 'GoldenEye 007' },
    ]) {
      const page = new FakePage({
        file: 'join.html',
        url: `${ORIGIN}/join?room=KAZ64${spectate ? '&spectate=1' : ''}`,
      });
      const answer = room(fields);
      page.server = awake({ status: 200, json: answer });
      runOldScript('join.js', page);
      await page.settle();
      assert.ok(isRoomAnswer(answer));
      const view = inviteView(answer, spectate);
      assert.equal(view.kicker, page.el('inv-kicker').textContent);
      assert.equal(view.title, page.el('inv-title').textContent);
      assert.equal(view.fullLineHidden, page.el('inv-fullline').attrs.has('hidden'));
      assert.equal(view.joinText, page.el('inv-join').textContent);
      assert.equal(view.watchText, page.el('inv-watch').textContent);
      assert.equal(view.joinHint, page.el('inv-join-hint').textContent);
      assert.equal(view.next, page.el('inv-next').textContent);
      assert.equal(view.watchFirst, page.el('inv-stack').firstElementChild === page.el('inv-watch'));
      assert.equal(page.el('inv-join').attrs.get('href'), playUrl('', 'KAZ64', false));
      assert.equal(page.el('inv-watch').attrs.get('href'), playUrl('', 'KAZ64', true));
      const slots = page.el('inv-facts').querySelectorAll('.slot');
      assert.deepEqual(
        slots.map((slot) => slot.attrs.get('class')),
        slots.map((_, index) => slotClass(index, answer.player_count)),
      );
      assert.ok(page.el('inv-facts').textContent.endsWith(factsText(answer)));
    }
  }
});

test('a room on screen is looked up again every 15 s, and follows what the lookups say', async () => {
  const pair = new Pair('?room=KAZ64');
  let answer: Reply = { status: 200, json: room() };
  pair.serve((url) => awake(answer)(url));
  await pair.load();
  assert.equal(pair.next.el('inv-kicker').textContent, 'Kaz invited you to play');
  await pair.step('focus on Join', (page) => page.el('inv-join').focus());

  answer = { status: 200, json: room({ player_count: 4 }) };
  await pair.step('one millisecond short of the refresh', (page) => page.advance(REFRESH_MS - 1));
  assert.equal(pair.next.requests.length, 2);
  await pair.step('the room filled', (page) => page.advance(1));
  assert.equal(pair.next.requests.length, 3);
  assert.equal(pair.next.el('inv-join').textContent, 'Join when a slot opens');
  assert.equal(pair.next.el('inv-stack').firstElementChild, pair.next.el('inv-watch'));
  assert.equal(pair.next.document.activeElement, pair.next.el('inv-join'), 'Join keeps focus when Watch moves ahead');

  answer = { status: 200, json: room({ closed: true }) };
  await pair.step('nobody is connected', (page) => page.advance(REFRESH_MS));
  assert.deepEqual(shown(pair.next), ['inv-closed']);
  assert.equal(pair.next.el('closed-title').textContent, "Kaz's room has closed.");

  answer = { status: 200, json: room({ status: 'playing', player_count: 2 }) };
  await pair.step('its members came back', (page) => page.advance(REFRESH_MS));
  assert.deepEqual(shown(pair.next), ['inv-main']);

  answer = { status: 500, json: {} };
  await pair.step('a lookup fails under a room on screen', (page) => page.advance(REFRESH_MS));
  assert.deepEqual(shown(pair.next), ['inv-main'], 'the room stays');
  await pair.step('and is retried 3 s later', (page) => page.advance(3000));

  answer = { status: 404, json: { detail: 'Room not found' } };
  await pair.step('the room is gone', (page) => page.advance(3000));
  assert.deepEqual(shown(pair.next), ['inv-closed']);
  assert.equal(pair.next.el('closed-title').textContent, 'This room has closed.');
  const asked = pair.next.requests.length;
  await pair.step('a room gone for good is not looked up again', (page) => page.advance(10 * REFRESH_MS));
  assert.equal(pair.next.requests.length, asked);
});

test('a lookup the server does not answer shows the waiting screen and its clock', async () => {
  for (const reply of [{ status: 500, json: {} }, { status: 200, text: '<html>' }, 'fail'] satisfies Reply[]) {
    const pair = new Pair('?room=KAZ64');
    let answer: Reply = reply;
    pair.serve((url) => awake(answer)(url));
    await pair.load();
    assert.deepEqual(shown(pair.next), ['inv-waking']);
    for (let second = 1; second <= 125; second++) await pair.step(`${second} s in`, (page) => page.advance(1000));
    assert.equal(pair.next.el('elapsed').textContent, '2:05');
    assert.match(pair.next.el('waking-line').textContent, /^Still powering on\./);
    answer = { status: 200, json: room() };
    await pair.step('the room answers', (page) => page.advance(3000));
    assert.deepEqual(shown(pair.next), ['inv-main']);
    await pair.step('the clock has stopped', (page) => page.advance(5000));
  }
});

test('a lookup that hangs is given up after 8 s', async () => {
  const pair = new Pair('?room=KAZ64');
  pair.serve(awake('hold'));
  await pair.load();
  assert.deepEqual(shown(pair.next), ['inv-loading']);
  await pair.step('still out', (page) => page.advance(7999));
  assert.equal(pair.next.held.length, 1);
  await pair.step('given up', (page) => page.advance(1));
  assert.equal(pair.next.held.length, 0);
  assert.deepEqual(shown(pair.next), ['inv-waking']);
});

test('a napping server is pinged with a growing timeout, then the wake is reported and the room looked up', async () => {
  const pair = new Pair('?room=KAZ64');
  let up = false;
  pair.serve((url) => {
    if (url.endsWith('/health')) return up ? { status: 200, json: { status: 'ok' } } : 'hold';
    if (url.includes('/room/')) return { status: 200, json: room() };
    return { status: 204, text: '' };
  });
  await pair.load();
  await pair.step('the first check is given 2 s', (page) => page.advance(2000));
  assert.deepEqual(shown(pair.next), ['inv-waking']);
  // Each ping goes out 3 s after the one before was given up: 2.5 s, 5 s, 10 s, 10 s.
  for (const timeout of [2500, 5000, 10000, 10000]) {
    await pair.step('the next ping goes out', (page) => page.advance(3000));
    assert.equal(pair.next.held.length, 1);
    await pair.step('it is still out just before its timeout', (page) => page.advance(timeout - 1));
    assert.equal(pair.next.held.length, 1, `a ping is given ${timeout} ms`);
    await pair.step('and given up at it', (page) => page.advance(1));
    assert.equal(pair.next.held.length, 0);
  }
  up = true;
  await pair.step('the server is up', (page) => page.advance(3000));
  assert.deepEqual(shown(pair.next), ['inv-main']);
  const elapsed = 2000 + 4 * 3000 + 2500 + 5000 + 10000 + 10000 + 3000;
  assert.equal(
    pair.next.requests.at(-2),
    `POST /api/wake-event ${JSON.stringify({ page: 'invite', elapsed_ms: elapsed, direct_wake_sent: false })}`,
  );
  await pair.step('no ping after the wake', (page) => page.advance(60000));
});

test('the server origin the Worker wrote in is pinged directly, once', async () => {
  for (const [configured, direct] of [
    ['https://origin.example', true],
    ['https://origin.example/some/path', true],
    [ORIGIN, false],
    ['not a url', false],
    ['', false],
    ['__KN_ORIGIN__', false],
  ] as const) {
    const pair = new Pair('?room=KAZ64', { edit: ['content="__KN_ORIGIN__"', `content="${configured}"`] });
    let up = false;
    pair.serve((url) => {
      if (url === 'https://origin.example/health') return 'fail';
      if (url.endsWith('/health')) return up ? { status: 200, json: { status: 'ok' } } : 'fail';
      return url.includes('/room/') ? { status: 200, json: room() } : { status: 204, text: '' };
    });
    await pair.load();
    assert.equal(pair.next.requests.includes('GET https://origin.example/health'), direct, configured);
    up = true;
    await pair.step('the server is up', (page) => page.advance(3000));
    assert.equal(
      pair.next.requests.filter((request) => request.startsWith('POST'))[0],
      `POST /api/wake-event ${JSON.stringify({ page: 'invite', elapsed_ms: 3000, direct_wake_sent: direct })}`,
    );
  }
});

test('a wake that took over an hour is not reported', async () => {
  const pair = new Pair('?room=KAZ64');
  let up = false;
  pair.serve((url) => (up ? awake({ status: 200, json: room() })(url) : 'fail'));
  await pair.load();
  await pair.step('an hour of pings', (page) => page.advance(60 * 60 * 1000));
  up = true;
  await pair.step('the server is up', (page) => page.advance(3000));
  assert.deepEqual(shown(pair.next), ['inv-main']);
  assert.deepEqual(
    pair.next.requests.filter((request) => request.startsWith('POST')),
    [],
  );
});

test('a 404 from /health counts as an answer, as it always has', async () => {
  const pair = new Pair('?room=KAZ64');
  pair.serve((url) => (url.endsWith('/health') ? { status: 404, text: '' } : { status: 200, json: room() }));
  await pair.load();
  assert.deepEqual(shown(pair.next), ['inv-main']);
});

test('answers that come back out of order: the older one is dropped', async () => {
  const pair = new Pair('?room=KAZ64');
  let answer: Reply = { status: 200, json: room() };
  pair.serve((url) => awake(answer)(url));
  await pair.load();
  answer = 'hold';
  await pair.step('the refresh goes out', (page) => page.advance(REFRESH_MS));
  await pair.step('the tab comes back while it is out', (page) => page.document.fire('visibilitychange'));
  assert.equal(pair.next.held.length, 2);
  await pair.step('the newer lookup answers first', (page) => {
    const [newer] = page.held.splice(1, 1);
    newer?.settle({ status: 200, json: room({ player_count: 3 }) });
  });
  assert.match(pair.next.el('inv-facts').textContent, /3 of 4/);
  await pair.step('the older answer is dropped', (page) =>
    page.release('/room/', { status: 200, json: room({ player_count: 2 }) }),
  );
  assert.match(pair.next.el('inv-facts').textContent, /3 of 4/);

  answer = 'hold';
  await pair.step('again, the refresh goes out', (page) => page.advance(REFRESH_MS));
  await pair.step('and the tab comes back', (page) => page.document.fire('visibilitychange'));
  await pair.step('the older lookup fails: the newer one retries itself', (page) => page.release('/room/', 'fail'));
  await pair.step('the newer lookup fails too', (page) => page.release('/room/', 'fail'));
  await pair.step('and is retried', (page) => page.advance(3000));
});

test('coming back to the tab looks the room up only when there is one to look up', async () => {
  for (const [json, looksUp] of [
    [room(), true],
    [room({ closed: true }), true],
    [null, false],
  ] as const) {
    const pair = new Pair('?room=KAZ64');
    pair.serve(awake(json === null ? { status: 404, text: '' } : { status: 200, json }));
    await pair.load();
    const asked = pair.next.requests.length;
    await pair.step('hidden', (page) => {
      page.document.hidden = true;
      page.document.fire('visibilitychange');
    });
    assert.equal(pair.next.requests.length, asked);
    await pair.step('back', (page) => {
      page.document.hidden = false;
      page.document.fire('visibilitychange');
    });
    assert.equal(pair.next.requests.length, asked + (looksUp ? 1 : 0));
  }
});

test('an in-app browser gets the banner, and Copy link copies the address either way', async () => {
  for (const clipboard of [true, false]) {
    const pair = new Pair('?room=KAZ64', {
      clipboard,
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile Instagram 300.0',
    });
    pair.serve(awake({ status: 200, json: room() }));
    await pair.load();
    assert.equal(pair.next.el('inapp').attrs.has('hidden'), false);
    assert.match(pair.next.el('inapp-text').textContent, /^You're in Instagram's built-in browser\./);
    for (const id of ['inapp-copy', 'unsup-copy']) {
      await pair.step('copy', (page) => page.el(id).click());
      assert.equal(pair.next.el(id).textContent, 'Copied');
      await pair.step('the button still says so', (page) => page.advance(1999));
      await pair.step('and goes back after 2 s', (page) => page.advance(1));
      assert.equal(pair.next.el(id).textContent, 'Copy link');
    }
    const copied = clipboard ? pair.next.clipboard : pair.next.document.copied;
    assert.deepEqual(copied, [`${ORIGIN}/join?room=KAZ64`, `${ORIGIN}/join?room=KAZ64`]);
  }
});

test('Open your own room goes to a new room as its host', async () => {
  const pair = new Pair('?room=KAZ64');
  pair.serve(awake({ status: 404, text: '' }));
  await pair.load();
  await pair.step('open', (page) => page.el('open-own').click());
  assert.equal(pair.next.navigations.length, 1);
  assert.match(pair.next.navigations[0] ?? '', /^\/play\.html\?room=[A-Z0-9]{8}&host=1&mode=rollback$/);
  assert.equal(pair.next.el('open-own').attrs.has('disabled'), true);
});

test('a page pointed at another server asks that server and links to it', async () => {
  const pair = new Pair('?room=KAZ64', {
    edit: ['<meta charset="UTF-8" />', '<meta charset="UTF-8" /><meta name="kn-api" content="https://game.example" />'],
  });
  pair.serve(awake({ status: 200, json: room() }));
  await pair.load();
  assert.deepEqual(pair.next.requests, ['GET https://game.example/health', 'GET https://game.example/room/KAZ64']);
  assert.equal(pair.next.el('inv-join').attrs.get('href'), 'https://game.example/play.html?room=KAZ64');
});

// ── Answers that do not fit ─────────────────────────────────────────────────

test('a room answer that does not fit is handled as an answer that never came', async () => {
  // The old script put such an answer on screen ("undefined of undefined in
  // the room"). It is now the same as a body that is not JSON, which both
  // scripts always retried from the waiting screen.
  for (const json of [{}, [], 'room', 7, null, room({ player_count: '1' }), room({ status: null })]) {
    assert.equal(isRoomAnswer(json), false);
    const offered = new FakePage({ file: 'join.html', url: `${ORIGIN}/join?room=KAZ64` });
    const junk = new FakePage({ file: 'join.html', url: `${ORIGIN}/join?room=KAZ64` });
    offered.server = awake({ status: 200, json });
    junk.server = awake({ status: 200, text: 'not json' });
    for (const page of [offered, junk]) {
      runBundle('join-entry.ts', page);
      await page.advance(4000);
    }
    assert.deepEqual(shown(offered), ['inv-waking']);
    assert.equal(offered.snapshot(), junk.snapshot());
  }
});

test('room and health answers are checked field by field', () => {
  assert.ok(isRoomAnswer({ status: 'lobby', player_count: 0, max_players: 4 }));
  assert.ok(isRoomAnswer(room()));
  assert.ok(isRoomAnswer(room({ host_name: null, game_id: null, closed: null })));
  for (const fields of [
    { status: 3 },
    { player_count: null },
    { max_players: '4' },
    { host_name: 5 },
    { game_id: {} },
    { romName: 1 },
    { closed: 'yes' },
  ]) {
    assert.equal(isRoomAnswer(room(fields)), false, JSON.stringify(fields));
  }
  assert.ok(isHealthAnswer({ status: 'ok', redis: true, rooms: 0, players: 0 }));
  assert.ok(isHealthAnswer({ status: 'degraded' }));
  for (const json of [null, 'ok', 1, [], {}, { status: true }]) assert.equal(isHealthAnswer(json), false);
});

// ── Decisions ───────────────────────────────────────────────────────────────

test('an invite link is read for its room code and whether it is a spectator link', () => {
  assert.deepEqual(inviteFrom('?room=KAZ64'), { code: 'KAZ64', spectate: false });
  assert.deepEqual(inviteFrom('?room=kaz64&spectate=1'), { code: 'kaz64', spectate: true });
  assert.deepEqual(inviteFrom('?room=KAZ64&spectate=true'), { code: 'KAZ64', spectate: false });
  for (const search of ['', '?room=', '?room=ab', '?room=KAZ-64', '?room=12345678901234567', '?code=KAZ64']) {
    assert.equal(inviteFrom(search).code, '', search);
  }
  assert.equal(inviteFrom('?room=abc').code, 'abc');
  assert.equal(inviteFrom('?room=1234567890123456').code, '1234567890123456');
});

test('where a visit starts', () => {
  assert.equal(firstStep('', true, true), 'closed');
  assert.equal(firstStep('', false, false), 'closed');
  assert.equal(firstStep('KAZ64', false, false), 'unsupported');
  assert.equal(firstStep('KAZ64', false, true), 'lookup');
  assert.equal(firstStep('KAZ64', true, true), 'lookup');
});

test('a lookup is sorted into gone, closed or open', () => {
  const open: RoomAnswer = { status: 'lobby', player_count: 1, max_players: 4, host_name: 'Kaz' };
  assert.deepEqual(lookupResult(null), { kind: 'gone' });
  assert.deepEqual(lookupResult(open), { kind: 'open', room: open });
  assert.deepEqual(lookupResult({ ...open, closed: false }), { kind: 'open', room: { ...open, closed: false } });
  assert.deepEqual(lookupResult({ ...open, closed: true }), { kind: 'closed', hostName: 'Kaz' });
  assert.deepEqual(lookupResult({ ...open, closed: true, host_name: null }), { kind: 'closed', hostName: '' });
});

test('the closed screen names the host when it knows one', () => {
  assert.equal(closedView(' Kaz ').title, "Kaz's room has closed.");
  assert.match(closedView('Kaz').line, /Ask Kaz for a new link/);
  assert.equal(closedView('  ').title, 'This room has closed.');
  assert.match(closedView('').line, /Ask for a new link/);
});

test('in-app browsers are told from real ones by user agent', () => {
  assert.equal(inAppBrowser('Mozilla/5.0 Discord/1.0'), 'Discord');
  assert.equal(inAppBrowser('Mozilla/5.0 [FBAN/FBIOS;FBAV/400]'), 'Facebook');
  assert.equal(inAppBrowser('Mozilla/5.0 musical_ly_30 BytedanceWebview'), 'TikTok');
  assert.equal(inAppBrowser('Mozilla/5.0 Twitter for iPhone'), 'X');
  assert.equal(inAppBrowser('Mozilla/5.0 (Macintosh) Safari/605'), null);
});

test('which screens a failed lookup and a returning tab act on', () => {
  assert.equal(failedLookupShowsWaiting('inv-loading'), true);
  assert.equal(failedLookupShowsWaiting('inv-waking'), true);
  assert.equal(failedLookupShowsWaiting('inv-main'), false);
  assert.equal(failedLookupShowsWaiting('inv-closed'), false);
  assert.equal(looksUpOnReturn(false, 'inv-main', false), true);
  assert.equal(looksUpOnReturn(true, 'inv-main', false), false);
  assert.equal(looksUpOnReturn(false, 'inv-closed', true), true);
  assert.equal(looksUpOnReturn(false, 'inv-closed', false), false);
  assert.equal(looksUpOnReturn(false, 'inv-waking', true), false);
});

test('waking: the ping timeout doubles to 10 s, the clock reads minutes and seconds', () => {
  assert.deepEqual([2500, 5000, 10000, 20000].map(nextPingTimeout), [5000, 10000, 10000, 10000]);
  assert.deepEqual([0, 999, 1000, 59999, 60000, 125000, 600000].map(elapsedText), [
    '0:00',
    '0:00',
    '0:01',
    '0:59',
    '1:00',
    '2:05',
    '10:00',
  ]);
  assert.equal(isSlowWake(120000), false);
  assert.equal(isSlowWake(120001), true);
});

test('the direct wake address, the wake report, room codes and room links', () => {
  assert.equal(directWakeUrl('https://origin.example', ORIGIN)?.href, 'https://origin.example/health');
  assert.equal(directWakeUrl('https://origin.example/x?y=1', ORIGIN)?.href, 'https://origin.example/health');
  for (const configured of [null, undefined, '', '__KN_ORIGIN__', ORIGIN, `${ORIGIN}/`, 'nonsense']) {
    assert.equal(directWakeUrl(configured, ORIGIN), null);
  }
  assert.equal(wakeReport('front', 1500, true), '{"page":"front","elapsed_ms":1500,"direct_wake_sent":true}');
  assert.equal(wakeReport('invite', -5, false), '{"page":"invite","elapsed_ms":0,"direct_wake_sent":false}');
  assert.equal(wakeReport('invite', 60 * 60 * 1000, false)?.includes('3600000'), true);
  assert.equal(wakeReport('invite', 60 * 60 * 1000 + 1, false), null);
  assert.equal(roomCodeFrom(new Uint8Array([0, 25, 26, 35, 36, 255])), 'AZ09AD');
  assert.equal(playUrl('', 'a b', false), '/play.html?room=a%20b');
  assert.equal(playUrl('https://game.example', 'KAZ64', true), 'https://game.example/play.html?room=KAZ64&spectate=1');
  assert.equal(hostUrl('', 'ABCD1234'), '/play.html?room=ABCD1234&host=1&mode=rollback');
});

// ── The bundle ──────────────────────────────────────────────────────────────

test('the invite bundle is made of the landing modules only: no core, no Effect', () => {
  const inputs = bundleInputs('join-entry.ts');
  assert.ok(inputs.includes('web/src/landing/join.ts'));
  for (const input of inputs) {
    assert.ok(input === 'web/src/join-entry.ts' || input.startsWith('web/src/landing/'), input);
  }
});
