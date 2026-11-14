import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDLE_STOP_MS,
  MARKS,
  POLL_HIDDEN_MS,
  POLL_MS,
  asksForStats,
  codeFromInput,
  createText,
  featuredRoom,
  featuredWhy,
  frameUrl,
  hash,
  isIdle,
  isStaleFrame,
  isVideoId,
  liveText,
  markIndexFor,
  newVisitor,
  nextMarkIndex,
  plural,
  pollDelay,
  refreshesOnReturn,
  roomActions,
  rowSignature,
  savedVisitor,
  stateAfterFailedList,
  statusText,
  stickPose,
  stillAt,
  weekText,
} from '../../web/src/landing/board.ts';
import { playUrl } from '../../web/src/landing/wake.ts';
import { boardRooms, isBoardRoom, isJson, isPublicStats, type BoardRoom } from '../../web/src/landing/wire.ts';
import {
  FakePage,
  PagePair,
  bundleInputs,
  runBundle,
  runOldScript,
  type FakeElement,
  type JsonBody,
  type PageOptions,
  type Reply,
} from './landing-fake-page.ts';

// The front page as a visitor meets it is tests/test_landing_page.py and
// tests/test_landing_board.py, in a real browser. Here the TypeScript is held
// to the script it replaced: tests/ts/oracles/landing.js is
// web/static/landing.js as of #166, unchanged. Both run on the same fake page
// and must leave it the same after every step.

const ORIGIN = 'https://kn.example';

/** The old script and the new bundle on the front page. */
const front = (options: Partial<PageOptions> = {}): PagePair =>
  new PagePair({ file: 'index.html', url: `${ORIGIN}/`, stored: new Map([['kn-visitor', 'abc12345']]), ...options });

/** A `/list` row as the server sends it, with some fields changed. */
interface RowFields {
  readonly [field: string]: JsonBody;
}

const row = (code: string, fields: RowFields = {}): RowFields => ({
  room_name: code,
  room_code: code,
  game_id: 'ssb64',
  game: 'Super Smash Bros. 64',
  host_name: `host of ${code}`,
  player_count: 2,
  max_players: 4,
  spectator_count: 0,
  max_spectators: 20,
  status: 'lobby',
  has_password: false,
  listed: true,
  started_at: null,
  frame_url: null,
  frame_age_s: null,
  ...fields,
});

/** A page's clock, in the seconds the server counts in. */
const NOW_S = 1_800_000_000;

const playing = (code: string, minutesAgo: number, fields: RowFields = {}): RowFields =>
  row(code, { status: 'playing', started_at: NOW_S - minutesAgo * 60, ...fields });

/** A game server the test changes as it goes. */
class Site {
  up = true;
  list: Reply = { status: 200, json: [] };
  stats: Reply = { status: 200, json: { matches_this_week: null, people_playing_now: 0 } };

  readonly answer = (url: string): Reply => {
    if (url.endsWith('/health')) return this.up ? { status: 200, json: { status: 'ok' } } : 'fail';
    if (url.endsWith('/list')) return this.list;
    if (url.endsWith('/api/stats/public')) return this.stats;
    return { status: 204, text: '' };
  };

  rooms(...rows: RowFields[]): void {
    this.list = { status: 200, json: rows };
  }
}

const loaded = async (site: Site, options: Partial<PageOptions> = {}): Promise<PagePair> => {
  const pair = front(options);
  pair.serve(site.answer);
  await pair.load();
  return pair;
};

const boardState = (page: FakePage): string | undefined => page.el('board').attrs.get('data-state');

const find = (page: FakePage, selector: string): FakeElement => {
  const found = page.document.querySelector(selector);
  if (!found) throw new Error(`Nothing on the page matches ${selector}`);
  return found;
};

const asked = (page: FakePage, path: string): number =>
  page.requests.filter((request) => request === `GET ${path}`).length;

// ── Whole-page sequences, old against new ───────────────────────────────────

test('an awake server with no rooms: the empty board, with and without the numbers', async () => {
  for (const [stats, live, week, emptyWeek] of [
    [{ matches_this_week: null, people_playing_now: 0 }, 'no open rooms right now', '', ''],
    [{ matches_this_week: 1, people_playing_now: 0 }, 'no open rooms right now', '1 match this week', '1 match'],
    [{ matches_this_week: 12, people_playing_now: 1 }, '1 person playing right now', '12 matches this week', '12 m'],
    [{ matches_this_week: 0, people_playing_now: 3 }, '3 people playing right now', '0 matches this week', '0 m'],
    [{}, 'no open rooms right now', '', ''],
  ] as const) {
    const site = new Site();
    site.stats = { status: 200, json: stats };
    const pair = await loaded(site);
    assert.equal(boardState(pair.next), 'empty');
    assert.equal(pair.next.el('board-live').textContent, live);
    assert.equal(pair.next.el('board-week').textContent, week);
    assert.ok(pair.next.el('empty-week').textContent.startsWith(emptyWeek));
    assert.deepEqual(pair.next.requests, ['GET /health', 'GET /api/stats/public', 'GET /list']);
  }
});

test('every kind of listed room reads the same as it did, alone on the board', async () => {
  let compared = 0;
  for (const reducedMotion of [false, true]) {
    for (const status of ['lobby', 'playing']) {
      for (const [player_count, max_players] of [
        [0, 4],
        [1, 4],
        [4, 4],
        [5, 4],
        [1, 2],
        [2, 2],
      ] as const) {
        for (const [spectator_count, max_spectators] of [
          [0, 20],
          [20, 20],
          [0, 0],
        ] as const) {
          for (const host_name of ['Kaz', '', null]) {
            for (const game of ['Super Smash Bros. 64', '', null]) {
              for (const started_at of [null, NOW_S - 30, NOW_S - 7 * 60]) {
                const site = new Site();
                site.rooms(
                  row('KAZ64', {
                    status,
                    player_count,
                    max_players,
                    spectator_count,
                    max_spectators,
                    host_name,
                    game,
                    started_at,
                    frame_url: '/room/KAZ64/frame.jpg?t=1',
                    frame_age_s: 3,
                  }),
                );
                const pair = await loaded(site, { reducedMotion });
                assert.equal(boardState(pair.next), 'live');
                compared++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 2 * 2 * 6 * 3 * 3 * 3 * 3);
});

test('the pure decisions say what the old page put on screen', async () => {
  const rooms = [
    row('LOBBY1'),
    row('FULL01', { player_count: 4 }),
    playing('GAME01', 12, { player_count: 4 }),
    playing('GAME02', 3, { player_count: 3, host_name: null, game: null }),
    playing('GAME03', 1, { player_count: 4, spectator_count: 20 }),
    playing('GAME04', 5, { player_count: 2, started_at: null }),
    row('NOWATCH', { spectator_count: 20, host_name: '' }),
  ];
  const page = new FakePage({ file: 'index.html', url: `${ORIGIN}/` });
  const site = new Site();
  site.rooms(...rooms);
  page.server = site.answer;
  runOldScript('landing.js', page);
  await page.settle();
  const decoded = boardRooms(rooms);
  assert.equal(decoded.length, rooms.length);

  const actionsOf = (box: FakeElement): (string | undefined)[][] =>
    box
      .querySelectorAll('.acts a')
      .map((a) => [
        a.attrs.get('data-act'),
        a.textContent,
        a.attrs.get('class'),
        a.attrs.get('href'),
        a.attrs.get('aria-label'),
      ]);
  for (const room of decoded) {
    const el = find(page, `.room[data-code="${room.room_code}"]`);
    assert.equal(el.querySelector('.st')?.textContent, statusText(room, page.now) || 'Room full');
    assert.equal(el.attrs.get('data-sig'), rowSignature(room));
    assert.deepEqual(
      actionsOf(el),
      roomActions(room, false).map((action) => [
        action.act,
        action.label,
        action.primary ? 'btn primary' : 'btn',
        playUrl('', room.room_code, action.spectate),
        action.ariaLabel,
      ]),
    );
    assert.equal(el.querySelectorAll('.acts .st').length, roomActions(room, false).length ? 0 : 1);
  }

  const featured = featuredRoom(decoded);
  assert.equal(featured?.room_code, 'GAME02', 'the newest match with an open slot');
  assert.equal(page.el('featured').attrs.get('data-code'), featured?.room_code);
  assert.ok(featured);
  assert.deepEqual(
    actionsOf(page.el('featured')),
    roomActions(featured, true).map((action) => [
      action.act,
      action.label,
      action.primary ? 'btn primary' : 'btn',
      playUrl('', featured.room_code, action.spectate),
      action.ariaLabel,
    ]),
  );
  assert.equal(find(page, '#featured .why').textContent, featuredWhy(featured));
  assert.equal(find(page, '#featured .st').textContent, statusText(featured, page.now));
});

test('which match is featured follows the list, as it did', async () => {
  const lists: RowFields[][] = [
    [row('A'), row('B')],
    [playing('A', 5, { player_count: 4 }), playing('B', 9, { player_count: 4 })],
    [playing('A', 5, { player_count: 4 }), playing('B', 9, { player_count: 3 })],
    [playing('A', 5), playing('B', 5), playing('C', 5)],
    [playing('A', 5, { started_at: null }), playing('B', 50), row('C')],
    [playing('A', 5, { player_count: 4 }), row('B'), playing('C', 2, { player_count: 4 })],
  ];
  const site = new Site();
  const pair = await loaded(site);
  for (const [index, list] of lists.entries()) {
    site.rooms(...list);
    await pair.step(`list ${index}`, (page) => page.advance(POLL_MS));
    assert.equal(
      pair.next.el('featured').attrs.get('data-code') ?? '',
      featuredRoom(boardRooms(list))?.room_code ?? '',
      `list ${index}`,
    );
  }
});

test('a board that changes from poll to poll: rows arrive, move, go live and leave', async () => {
  const site = new Site();
  site.rooms(row('AAA'), row('BBB'), row('CCC'));
  const pair = await loaded(site);
  const codes = (page: FakePage): (string | undefined)[] =>
    page.el('rooms').children.map((el) => el.attrs.get('data-code'));
  assert.deepEqual(codes(pair.next), ['AAA', 'BBB', 'CCC']);

  await pair.step('focus on Join in the second row', (page) =>
    find(page, '.room[data-code="BBB"] [data-act="join"]').focus(),
  );

  site.rooms(row('AAA'), row('BBB', { player_count: 3 }), row('CCC'));
  await pair.step('the focused row is rebuilt', (page) => page.advance(POLL_MS));
  assert.equal(pair.next.document.activeElement, find(pair.next, '.room[data-code="BBB"] [data-act="join"]'));

  site.rooms(row('BBB', { player_count: 3 }), row('AAA'), row('CCC'), row('DDD'));
  await pair.step('rows change places and one arrives', (page) => page.advance(POLL_MS));
  assert.deepEqual(codes(pair.next), ['BBB', 'AAA', 'CCC', 'DDD']);
  assert.equal(pair.next.document.activeElement.attrs.get('data-act'), 'join');

  site.rooms(row('BBB', { player_count: 4 }), row('AAA'), row('CCC'), row('DDD'));
  await pair.step('the focused room fills: its Join goes, focus stays in the row', (page) => page.advance(POLL_MS));
  assert.equal(pair.next.document.activeElement, find(pair.next, '.room[data-code="BBB"] [data-act="watch"]'));

  site.rooms(playing('BBB', 0, { player_count: 4 }), row('AAA'), row('CCC'), row('DDD'));
  await pair.step('it goes live: featured, and its slots bounce once', (page) => page.advance(POLL_MS));
  assert.equal(pair.next.el('featured').attrs.get('data-code'), 'BBB');
  assert.equal(find(pair.next, '.room[data-code="BBB"] .slots').attrs.get('class'), 'slots bounce');

  await pair.step('focus on the featured Watch', (page) => find(page, '#featured [data-act="watch"]').focus());
  site.rooms(playing('BBB', 1, { player_count: 4 }), playing('DDD', 0), row('AAA'), row('CCC'));
  await pair.step('a newer joinable match takes the featured place', (page) => page.advance(POLL_MS));
  assert.equal(pair.next.el('featured').attrs.get('data-code'), 'DDD');
  assert.equal(pair.next.document.activeElement, find(pair.next, '.room[data-code="BBB"] [data-act="watch"]'));

  site.rooms(playing('DDD', 1), row('AAA'), row('CCC'));
  await pair.step('the focused room leaves: focus goes to the row now in its place', (page) => page.advance(POLL_MS));
  assert.deepEqual(codes(pair.next), ['DDD', 'AAA', 'CCC']);
  assert.notEqual(pair.next.document.activeElement, pair.next.document.body);

  site.rooms();
  await pair.step('every room leaves', (page) => page.advance(POLL_MS));
  assert.equal(boardState(pair.next), 'empty');
  site.rooms(row('EEE'));
  await pair.step('and one opens', (page) => page.advance(POLL_MS));
  assert.equal(boardState(pair.next), 'live');
  assert.deepEqual(codes(pair.next), ['EEE']);
});

test('a long run of boards drawn at random stays the same, focus and all', async () => {
  // A small generator with a fixed seed, so a failure is the same failure each run.
  let seed = 20240607;
  const random = (below: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % below;
  };
  const pool = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  for (const reducedMotion of [false, true]) {
    const site = new Site();
    const pair = await loaded(site, { reducedMotion });
    for (let poll = 0; poll < 120; poll++) {
      const rows: RowFields[] = [];
      for (const code of [...pool].sort(() => random(3) - 1)) {
        if (random(3) === 0) continue;
        const max_players = random(4) === 0 ? 2 : 4;
        const fields = {
          max_players,
          player_count: random(max_players + 1),
          spectator_count: random(5) === 0 ? 20 : random(3),
          host_name: random(6) === 0 ? null : `host of ${code}`,
          frame_url: random(2) === 0 ? `/room/${code}/frame.jpg?t=${random(3)}` : null,
          frame_age_s: random(60),
        };
        rows.push(random(2) === 0 ? row(code, fields) : playing(code, random(20), fields));
      }
      site.rooms(...rows);
      site.stats =
        random(8) === 0
          ? 'fail'
          : { status: 200, json: { matches_this_week: random(40), people_playing_now: random(9) } };
      await pair.step(`poll ${poll}`, (page) => page.advance(POLL_MS));
      const drawnFrom = seed;
      await pair.step(`poll ${poll}: frames arrive or fail, a link takes focus`, (page) => {
        seed = drawnFrom; // the same draws on both pages
        for (const img of page.document.querySelectorAll('.thumb img, .screen-box img')) {
          if (!img.attrs.has('data-loaded')) img.fire(random(4) === 0 ? 'error' : 'load');
        }
        const links = page.document.querySelectorAll('#st-live a');
        links[random(links.length + 1)]?.focus();
      });
    }
  }
});

test('frames: one shown, one loading behind it, the old one fading out', async () => {
  for (const reducedMotion of [false, true]) {
    const site = new Site();
    site.rooms(playing('AAA', 2, { frame_url: '/room/AAA/frame.jpg?t=1', frame_age_s: 2 }), row('BBB'), row('CCC'));
    const pair = await loaded(site, { reducedMotion });
    const thumb = (page: FakePage): FakeElement => find(page, '.room[data-code="AAA"] .thumb');
    assert.equal(thumb(pair.next).attrs.get('class'), 'thumb');
    assert.equal(thumb(pair.next).attrs.get('aria-hidden'), 'true');
    assert.equal(thumb(pair.next).children[0]?.attrs.get('src'), '/room/AAA/frame.jpg?t=1');

    await pair.step('the frames load', (page) => {
      for (const img of page.document.querySelectorAll('#st-live img')) img.fire('load');
    });
    assert.equal(thumb(pair.next).attrs.get('class'), 'thumb live');
    assert.equal(thumb(pair.next).attrs.has('aria-hidden'), false);

    await pair.step('the same frame on the next poll: nothing is fetched', (page) => page.advance(POLL_MS));
    assert.equal(thumb(pair.next).children.length, 1);

    site.rooms(playing('AAA', 2, { frame_url: '/room/AAA/frame.jpg?t=2', frame_age_s: 31 }), row('BBB'), row('CCC'));
    await pair.step('a new frame loads behind the shown one', (page) => page.advance(POLL_MS));
    assert.equal(thumb(pair.next).children.length, 2);
    assert.equal(thumb(pair.next).attrs.get('class'), 'thumb live stale');

    site.rooms(playing('AAA', 2, { frame_url: '/room/AAA/frame.jpg?t=3', frame_age_s: 1 }), row('BBB'), row('CCC'));
    await pair.step('a newer one replaces the one still loading', (page) => page.advance(POLL_MS));
    assert.equal(thumb(pair.next).children.length, 2);
    assert.equal(thumb(pair.next).children[1]?.attrs.get('src'), '/room/AAA/frame.jpg?t=3');

    await pair.step('it loads', (page) => {
      for (const img of page.document.querySelectorAll('#st-live img'))
        if (!img.attrs.has('data-loaded')) img.fire('load');
    });
    assert.equal(thumb(pair.next).children.length, reducedMotion ? 1 : 2);
    await pair.step('the old frame is still there at 649 ms', (page) => page.advance(649));
    await pair.step('and gone at 650 ms', (page) => page.advance(1));
    assert.equal(thumb(pair.next).children.length, 1);

    site.rooms(playing('AAA', 2, { frame_url: '/room/AAA/frame.jpg?t=4', frame_age_s: 1 }), row('BBB'), row('CCC'));
    await pair.step('the next frame is asked for', (page) => page.advance(POLL_MS));
    await pair.step('and fails: the shown one stays', (page) => {
      for (const img of page.document.querySelectorAll('#st-live img'))
        if (!img.attrs.has('data-loaded')) img.fire('error');
    });
    assert.equal(thumb(pair.next).children.length, 1);
    assert.equal(thumb(pair.next).attrs.get('class'), 'thumb live');

    site.rooms(row('AAA'), row('BBB'), row('CCC'));
    await pair.step('back in the lobby: no frame', (page) => page.advance(POLL_MS));
    assert.equal(thumb(pair.next).children.length, 0);
    assert.equal(thumb(pair.next).attrs.get('class'), 'thumb');
  }
});

test('frames are lazy below the second row and not fetched in a hidden tab', async () => {
  const site = new Site();
  const rows = ['AAA', 'BBB', 'CCC', 'DDD'].map((code) =>
    playing(code, 1, { frame_url: `/room/${code}/frame.jpg?t=1` }),
  );
  site.rooms(...rows);
  const pair = await loaded(site);
  assert.deepEqual(
    pair.next.el('rooms').children.map((el) => el.querySelector('img')?.attrs.get('loading')),
    [undefined, undefined, 'lazy', 'lazy'],
  );
  assert.equal(find(pair.next, '#featured img').attrs.get('loading'), undefined);

  await pair.step('the tab is hidden', (page) => {
    page.document.hidden = true;
    page.document.fire('visibilitychange');
  });
  site.rooms(...rows.map((r) => ({ ...r, frame_url: `${String(r.frame_url)}0` })));
  await pair.step('the poll already due goes out, and fetches no frame', (page) => page.advance(POLL_MS));
  assert.equal(asked(pair.next, '/list'), 2);
  assert.equal(pair.next.document.querySelectorAll('#st-live img').length, 0);
  await pair.step('the next is 30 s later, not 10', (page) => page.advance(POLL_HIDDEN_MS - 1));
  assert.equal(asked(pair.next, '/list'), 2);
  await pair.step('to the millisecond', (page) => page.advance(1));
  assert.equal(asked(pair.next, '/list'), 3);
  await pair.step('back: refreshed at once, frames and all', (page) => {
    page.document.hidden = false;
    page.document.fire('visibilitychange');
  });
  assert.equal(asked(pair.next, '/list'), 4);
  assert.equal(pair.next.document.querySelectorAll('#st-live img').length, 5);
});

test('the numbers are asked for on the first poll and every sixth, and again right after a failure', async () => {
  const site = new Site();
  site.stats = { status: 200, json: { matches_this_week: 5, people_playing_now: 2 } };
  const pair = await loaded(site);
  for (let poll = 1; poll <= 13; poll++) {
    await pair.step(`poll ${poll}`, (page) => page.advance(POLL_MS));
    assert.equal(asked(pair.next, '/list'), poll + 1);
    assert.equal(asked(pair.next, '/api/stats/public'), 1 + Math.floor(poll / 6), `after poll ${poll}`);
  }
  assert.equal(pair.next.el('board-week').textContent, '5 matches this week');

  for (const failure of [{ status: 500, json: {} }, { status: 200, text: 'oops' }, 'fail'] satisfies Reply[]) {
    site.stats = failure;
    for (let poll = 0; poll < 6; poll++) await pair.step('polls up to the next ask', (page) => page.advance(POLL_MS));
    const before = asked(pair.next, '/api/stats/public');
    while (asked(pair.next, '/api/stats/public') === before) {
      await pair.step('a poll', (page) => page.advance(POLL_MS));
    }
    assert.equal(pair.next.el('board-week').textContent, '', 'a failed ask drops the numbers');
    assert.equal(pair.next.el('board-live').textContent, 'no open rooms right now');
    site.stats = { status: 200, json: { matches_this_week: 6, people_playing_now: 2 } };
    await pair.step('the very next poll asks again', (page) => page.advance(POLL_MS));
    assert.equal(asked(pair.next, '/api/stats/public'), before + 2);
    assert.equal(pair.next.el('board-week').textContent, '6 matches this week');
  }
});

test('the board stops asking after ten idle minutes and starts again on a touch', async () => {
  const site = new Site();
  const pair = await loaded(site);
  await pair.step('ten minutes with nobody there', (page) => page.advance(IDLE_STOP_MS));
  const polls = asked(pair.next, '/list');
  assert.equal(polls, 1 + IDLE_STOP_MS / POLL_MS);
  await pair.step('one more poll, the last', (page) => page.advance(POLL_MS));
  assert.equal(asked(pair.next, '/list'), polls + 1);
  await pair.step('then nothing', (page) => page.advance(5 * IDLE_STOP_MS));
  assert.equal(asked(pair.next, '/list'), polls + 1);
  let expected = polls + 1;
  for (const event of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
    await pair.step(`${event} starts it again, with the numbers`, (page) => page.fireWindow(event));
    expected += 1;
    assert.equal(asked(pair.next, '/list'), expected);
    await pair.step('and it runs out again', (page) => page.advance(IDLE_STOP_MS + POLL_MS));
    expected += IDLE_STOP_MS / POLL_MS + 1;
    assert.equal(asked(pair.next, '/list'), expected);
    await pair.step('quiet', (page) => page.advance(IDLE_STOP_MS));
    assert.equal(asked(pair.next, '/list'), expected);
  }
  await pair.step('a touch starts it', (page) => page.fireWindow('scroll'));
  const stats = asked(pair.next, '/api/stats/public');
  await pair.step('a touch while polling only moves the idle clock', async (page) => {
    page.fireWindow('scroll');
    await page.settle();
    page.fireWindow('scroll');
  });
  assert.equal(asked(pair.next, '/api/stats/public'), stats);
  assert.equal(asked(pair.next, '/list'), expected + 1);
});

test('a list the server does not answer: an error before there is a board, the board after', async () => {
  for (const failure of [
    { status: 500, text: 'boom' },
    { status: 200, text: '<html>' },
    'fail',
    'hold',
  ] satisfies Reply[]) {
    const site = new Site();
    site.list = failure;
    const pair = await loaded(site);
    if (failure === 'hold') {
      assert.equal(boardState(pair.next), 'loading');
      await pair.step('given up after 8 s', (page) => page.advance(8000));
    }
    assert.equal(boardState(pair.next), 'error');
    assert.equal(pair.next.el('create-btn').attrs.has('disabled'), false);
    site.rooms(row('AAA'));
    await pair.step('the next poll brings the board', (page) => page.advance(POLL_MS));
    assert.equal(boardState(pair.next), 'live');
    site.list = failure;
    await pair.step('a failed poll under a board keeps the board', (page) => page.advance(POLL_MS + 8000));
    assert.equal(boardState(pair.next), 'live');
    site.rooms();
    await pair.step('and the poll after it is heard', (page) => page.advance(POLL_MS));
    assert.equal(boardState(pair.next), 'empty');
  }
});

test('a list that is not a list is an empty board; rows that are not rooms are left out', async () => {
  for (const json of [{}, 'rooms', 7, null, { rooms: [row('AAA')] }] satisfies JsonBody[]) {
    const site = new Site();
    site.list = { status: 200, json };
    const pair = await loaded(site);
    assert.equal(boardState(pair.next), 'empty');
  }
  const site = new Site();
  // Unlisted rooms come without a room code; the board never showed them.
  const legacy = { room_name: 'legacy', host_name: 'Kaz', player_count: 1, max_players: 4, status: 'lobby' };
  site.list = { status: 200, json: [null, 0, 'x', [], row('AAA'), legacy, row('')] };
  const pair = await loaded(site);
  assert.deepEqual(
    pair.next.el('rooms').children.map((el) => el.attrs.get('data-code')),
    ['AAA'],
  );
});

test('answers that come back out of order: the older list is dropped, the numbers follow their own order', async () => {
  const site = new Site();
  site.rooms(row('AAA'));
  const pair = await loaded(site);
  site.list = 'hold';
  site.stats = 'hold';
  await pair.step('a poll goes out', (page) => page.advance(POLL_MS));
  await pair.step('the tab comes back while it is out', (page) => page.document.fire('visibilitychange'));
  assert.deepEqual(
    pair.next.held.map((held) => held.url),
    ['/list', '/api/stats/public', '/list'],
  );
  await pair.step('the newer list answers first, and waits for its numbers', (page) => {
    const [newer] = page.held.splice(2, 1);
    newer?.settle({ status: 200, json: [row('NEW')] });
  });
  await pair.step('the numbers arrive', (page) =>
    page.release('/api/stats/public', { status: 200, json: { matches_this_week: 3, people_playing_now: 1 } }),
  );
  assert.deepEqual(
    pair.next.el('rooms').children.map((el) => el.attrs.get('data-code')),
    ['NEW'],
  );
  await pair.step('the older list is dropped', (page) => page.release('/list', { status: 200, json: [row('OLD')] }));
  assert.deepEqual(
    pair.next.el('rooms').children.map((el) => el.attrs.get('data-code')),
    ['NEW'],
  );
  assert.equal(pair.next.el('board-week').textContent, '3 matches this week');

  await pair.step('again: a poll goes out', (page) => page.advance(POLL_MS));
  await pair.step('and the tab comes back', (page) => page.document.fire('visibilitychange'));
  await pair.step('the older list fails after the newer was shown', async (page) => {
    const [newer] = page.held.splice(2, 1);
    newer?.settle({ status: 200, json: [] });
    await page.settle();
    await page.release('/api/stats/public', 'fail');
    await page.release('/list', 'fail');
  });
  assert.equal(boardState(pair.next), 'empty');
  await pair.step('polling carries on', (page) => page.advance(POLL_MS));
});

test('a napping server: the waking board, its clock, the pings, then the report and the board', async () => {
  const site = new Site();
  site.up = false;
  site.rooms(row('AAA'));
  const pair = await loaded(site);
  assert.equal(boardState(pair.next), 'waking');
  assert.equal(pair.next.el('create-btn').textContent, 'Create a room · ready in a moment');
  for (const id of ['create-btn', 'join-btn', 'watch-btn', 'room-code']) {
    assert.equal(pair.next.el(id).attrs.has('disabled'), true, id);
  }
  await pair.step('interaction while waking starts no poll', (page) => page.fireWindow('pointerdown'));
  for (let second = 1; second <= 125; second++) await pair.step(`${second} s in`, (page) => page.advance(1000));
  assert.equal(pair.next.el('elapsed').textContent, '2:05');
  assert.match(pair.next.el('waking-line').textContent, /^Still powering on\./);
  assert.equal(pair.next.el('board').attrs.get('data-slow'), '1');
  assert.equal(asked(pair.next, '/list'), 0);

  site.up = true;
  await pair.step('the server is up', (page) => page.advance(3000));
  assert.equal(boardState(pair.next), 'live');
  assert.equal(pair.next.el('create-btn').textContent, 'Create a room');
  assert.equal(
    pair.next.requests.filter((request) => request.startsWith('POST'))[0],
    `POST /api/wake-event ${JSON.stringify({ page: 'front', elapsed_ms: 126000, direct_wake_sent: false })}`,
  );
  await pair.step('the clock has stopped, the board polls', (page) => page.advance(POLL_MS));
  assert.equal(pair.next.el('elapsed').textContent, '2:06');
});

test('pings of a napping server are given 2.5 s, then 5, then 10', async () => {
  const site = new Site();
  const pair = front();
  pair.serve((url) => (url.endsWith('/health') ? 'hold' : site.answer(url)));
  await pair.load();
  await pair.step('the first check is given 2 s', (page) => page.advance(2000));
  assert.equal(boardState(pair.next), 'waking');
  for (const timeout of [2500, 5000, 10000, 10000]) {
    await pair.step('the next ping goes out', (page) => page.advance(3000));
    assert.equal(pair.next.held.length, 1);
    await pair.step('still out just before its timeout', (page) => page.advance(timeout - 1));
    assert.equal(pair.next.held.length, 1, `a ping is given ${timeout} ms`);
    await pair.step('given up at it', (page) => page.advance(1));
    assert.equal(pair.next.held.length, 0);
  }
});

test('the server origin the Worker wrote in is pinged directly', async () => {
  for (const [configured, direct] of [
    ['https://origin.example', true],
    [ORIGIN, false],
    ['not a url', false],
    ['__KN_ORIGIN__', false],
  ] as const) {
    const site = new Site();
    site.up = false;
    const pair = await loaded(site, { edit: ['content="__KN_ORIGIN__"', `content="${configured}"`] });
    assert.equal(pair.next.requests.includes('GET https://origin.example/health'), direct, configured);
    site.up = true;
    await pair.step('the server is up', (page) => page.advance(3000));
    assert.equal(
      pair.next.requests.filter((request) => request.startsWith('POST'))[0],
      `POST /api/wake-event ${JSON.stringify({ page: 'front', elapsed_ms: 3000, direct_wake_sent: direct })}`,
    );
  }
});

test('a page pointed at another server asks that server and links to it', async () => {
  const site = new Site();
  site.rooms(playing('AAA', 1, { frame_url: '/room/AAA/frame.jpg?t=1' }));
  const pair = await loaded(site, {
    edit: ['<meta charset="UTF-8" />', '<meta charset="UTF-8" /><meta name="kn-api" content="https://game.example" />'],
  });
  assert.deepEqual(pair.next.requests, [
    'GET https://game.example/health',
    'GET https://game.example/api/stats/public',
    'GET https://game.example/list',
  ]);
  assert.equal(find(pair.next, '.room [data-act="join"]').attrs.get('href'), 'https://game.example/play.html?room=AAA');
  assert.equal(find(pair.next, '.room img').attrs.get('src'), 'https://game.example/room/AAA/frame.jpg?t=1');
  await pair.step('create', (page) => page.el('create-btn').click());
  assert.match(
    pair.next.navigations[0] ?? '',
    /^https:\/\/game\.example\/play\.html\?room=[A-Z0-9]{8}&host=1&mode=rollback$/,
  );
});

test('Create, and the code field: a typed code, a pasted link, nothing at all', async () => {
  const site = new Site();
  const pair = await loaded(site);
  await pair.step('Have a code? opens the field', (page) => page.el('code-link').click());
  assert.equal(pair.next.el('code-box').attrs.get('class'), 'code open');
  assert.equal(pair.next.el('code-link').attrs.get('aria-expanded'), 'true');
  assert.equal(pair.next.document.activeElement, pair.next.el('room-code'));

  for (const button of ['join-btn', 'watch-btn']) {
    await pair.step('with no code the field shakes', (page) => page.el(button).click());
    assert.equal(pair.next.el('room-code').attrs.get('class'), 'shake');
    assert.deepEqual(pair.next.navigations, []);
    await pair.step('once', (page) => page.el('room-code').fire('animationend'));
    assert.equal(pair.next.el('room-code').attrs.get('class'), '');
  }

  const type = (text: string) => (page: FakePage) => {
    page.el('room-code').value = text;
    page.el('room-code').fire('input');
  };
  await pair.step('a typed code', type(' kaz-64 '));
  await pair.step('Enter joins', (page) => page.el('room-code').fire('keydown', { key: 'Enter' }));
  await pair.step('other keys do nothing', (page) => page.el('room-code').fire('keydown', { key: 'a' }));
  await pair.step('a pasted link', type('https://kn.example/play.html?room=aBc123&spectate=1'));
  await pair.step('Watch', (page) => page.el('watch-btn').click());
  await pair.step('Create', (page) => page.el('create-btn').click());
  assert.equal(pair.next.navigations.length, 3);
  assert.deepEqual(pair.next.navigations.slice(0, 2), ['/play.html?room=KAZ64', '/play.html?room=aBc123&spectate=1']);
  assert.match(pair.next.navigations[2] ?? '', /^\/play\.html\?room=[A-Z0-9]{8}&host=1&mode=rollback$/);
  for (const id of ['create-btn', 'join-btn', 'watch-btn']) assert.equal(pair.next.el(id).attrs.has('disabled'), true);

  await pair.step('a page shown fresh keeps them as they are', (page) =>
    page.fireWindow('pageshow', { persisted: false }),
  );
  assert.equal(pair.next.el('create-btn').attrs.has('disabled'), true);
  await pair.step('back from the room page: the buttons work again', (page) =>
    page.fireWindow('pageshow', { persisted: true }),
  );
  for (const id of ['create-btn', 'join-btn', 'watch-btn']) assert.equal(pair.next.el(id).attrs.has('disabled'), false);
});

test('HELLO in the code field answers HELLOD00D, closed by a click or a key', async () => {
  const site = new Site();
  const pair = await loaded(site);
  const type = (text: string) => (page: FakePage) => {
    page.el('room-code').value = text;
    page.el('room-code').fire('input');
  };
  const dialog = (page: FakePage): FakeElement | null => page.document.querySelector('[role="dialog"]');
  await pair.step('hell', type('hell'));
  assert.equal(dialog(pair.next), null);
  await pair.step('hello', type('hello'));
  assert.equal(dialog(pair.next)?.children[0]?.textContent, 'HELLOD00D');
  assert.equal(pair.next.el('room-code').value, '');
  await pair.step('a key within 100 ms does not close it', async (page) => {
    await page.advance(99);
    page.document.fire('keydown');
  });
  assert.notEqual(dialog(pair.next), null);
  await pair.step('a key after that does', async (page) => {
    await page.advance(1);
    page.document.fire('keydown');
  });
  assert.equal(dialog(pair.next), null);
  await pair.step('again', type('HELLO'));
  await pair.step('a click closes it', (page) => dialog(page)?.click());
  assert.equal(dialog(pair.next), null);
  await pair.step('and the key listener is gone with it', async (page) => {
    await page.advance(200);
    page.document.fire('keydown');
  });
});

test('the header mark: one per visitor per day, a click steps to the next', async () => {
  const shownMark = (page: FakePage): string => page.el('hdr-mark').children[0]?.attrs.get('data-mark') ?? 'letters';
  for (const reducedMotion of [false, true]) {
    for (const visitor of ['abc12345', 'zzzzzzzz', 'q', 'anon']) {
      const pair = await loaded(new Site(), { reducedMotion, stored: new Map([['kn-visitor', visitor]]) });
      let index = markIndexFor(pair.next.now, visitor);
      assert.equal(shownMark(pair.next), MARKS[index]);
      for (let click = 0; click < MARKS.length + 1; click++) {
        await pair.step('a click on the name', (page) => page.el('name').fire('click'));
        if (!reducedMotion) {
          assert.equal(pair.next.el('hdr-mark').classList.contains('fade'), true);
          await pair.step('the old mark fades for 300 ms', (page) => page.advance(299));
          assert.equal(shownMark(pair.next), MARKS[index]);
          await pair.step('then the next shows', (page) => page.advance(1));
        }
        index = nextMarkIndex(index);
        assert.equal(shownMark(pair.next), MARKS[index]);
        assert.equal(pair.next.el('hdr-mark').classList.contains('wide'), MARKS[index] === 'ko');
        assert.equal(pair.next.el('hdr-mark').children[0]?.attrs.get('focusable') ?? 'false', 'false');
      }
    }
  }
});

test('a first visit draws a visitor id and keeps it; a page with no storage is "anon"', async () => {
  const fresh = await loaded(new Site(), { stored: new Map() });
  const drawn = fresh.next.stored.get('kn-visitor') ?? '';
  assert.match(drawn, /^[0-9a-z]{1,8}$/);
  assert.equal(drawn, fresh.old.stored.get('kn-visitor'));
  const shownMark = (page: FakePage): string => page.el('hdr-mark').children[0]?.attrs.get('data-mark') ?? 'letters';
  assert.equal(shownMark(fresh.next), MARKS[markIndexFor(fresh.next.now, drawn)]);

  const blocked = await loaded(new Site(), { storageBroken: true });
  assert.equal(shownMark(blocked.next), MARKS[markIndexFor(blocked.next.now, 'anon')]);
});

test('the stick mark follows the pointer and lights a direction; pressing it does not change the mark', async () => {
  // Find a visitor whose mark today is the stick.
  const probe = new FakePage({ file: 'index.html', url: `${ORIGIN}/` });
  const visitor = Array.from({ length: 200 }, (_, n) => `v${n}`).find(
    (candidate) => MARKS[markIndexFor(probe.now, candidate)] === 'stick',
  );
  assert.ok(visitor);
  const pair = await loaded(new Site(), { stored: new Map([['kn-visitor', visitor]]) });
  const stick = (page: FakePage): FakeElement => find(page, '#hdr-mark [data-mark="stick"]');
  for (const [clientX, clientY] of [
    [16, 16],
    [16, 2],
    [30, 16],
    [16, 31],
    [0, 15],
    [20, 19],
    [100, -40],
  ] as const) {
    await pair.step(`pointer at ${clientX},${clientY}`, (page) =>
      stick(page).fire('pointermove', { clientX, clientY }),
    );
    const pose = stickPose(clientX, clientY);
    assert.equal(find(pair.next, '#hdr-mark .cap').style.transform, `translate(${pose.dx}px,${pose.dy}px)`);
    assert.deepEqual(
      pair.next.document
        .querySelectorAll('#hdr-mark .cd')
        .filter((dot) => dot.attrs.get('stroke-opacity') === '1')
        .map((dot) => dot.attrs.get('data-dir')),
      pose.dir ? [pose.dir] : [],
    );
  }
  await pair.step('pressed', (page) => stick(page).fire('pointerdown', { clientX: 30, clientY: 16 }));
  assert.equal(find(pair.next, '#hdr-mark .ring').attrs.get('class'), 'ring fire');
  await pair.step('the click that follows lands on the stick: the mark stays', async (page) => {
    page.el('name').fire('click', { target: find(page, '#hdr-mark .cap') });
    await page.advance(300);
  });
  assert.notEqual(pair.next.document.querySelector('#hdr-mark [data-mark="stick"]'), null);
  for (const event of ['pointerup', 'pointerleave']) {
    await pair.step(event, (page) => stick(page).fire(event));
    assert.equal(find(pair.next, '#hdr-mark .cap').style.transform, 'translate(0,0)');
  }
});

test('screenshots are listed with their sizes, and a video box appears only with a video id', async () => {
  const plain = await loaded(new Site());
  const shots = plain.next.el('shots').children;
  assert.equal(shots.length, 3);
  for (const img of shots) {
    assert.match(img.attrs.get('src') ?? '', /^\/static\/shots\/.+\.webp$/);
    assert.equal(img.attrs.get('loading'), 'lazy');
    assert.ok(img.attrs.get('alt') && img.attrs.get('width') && img.attrs.get('height'));
  }
  assert.equal(shots[2]?.attrs.get('class'), 'wide');
  assert.equal(plain.next.el('how-media').attrs.has('hidden'), false);
  assert.equal(plain.next.document.querySelectorAll('.lite button').length, 0);

  for (const id of ['dQw4w9WgXcQ', 'short', 'has space!!', 'a/b/c/d/e/f']) {
    const pair = await loaded(new Site(), {
      edit: ['data-video="" data-title="Intro"', `data-video="${id}" data-poster="/static/p.webp" data-title="Intro"`],
    });
    const box = find(pair.next, '.lite[data-title="Intro"]');
    assert.equal(box.attrs.has('hidden'), !isVideoId(id), id);
    if (!isVideoId(id)) continue;
    assert.equal(box.querySelector('button')?.attrs.get('aria-label'), 'Play video: Intro, 0:50');
    await pair.step('play', (page) => find(page, '.lite[data-title="Intro"] button').click());
    assert.equal(
      box.querySelector('iframe')?.attrs.get('src'),
      `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&cc_load_policy=1`,
    );
  }
});

// ── Answers that do not fit ─────────────────────────────────────────────────

test('numbers that do not fit are handled as numbers that never came', async () => {
  // The old script kept whatever JSON it got and showed no number for it. It
  // is now the same as a failed request: no numbers, and asked for again on
  // the next poll.
  for (const json of [
    [],
    'stats',
    7,
    null,
    { matches_this_week: '5' },
    { people_playing_now: {} },
  ] satisfies JsonBody[]) {
    assert.equal(isPublicStats(json), false);
    const offered = new FakePage({ file: 'index.html', url: `${ORIGIN}/` });
    const failed = new FakePage({ file: 'index.html', url: `${ORIGIN}/` });
    for (const [page, stats] of [
      [offered, { status: 200, json }],
      [failed, { status: 500, json: {} }],
    ] as const) {
      const site = new Site();
      site.stats = stats;
      site.rooms(row('AAA'));
      page.server = site.answer;
      runBundle('landing-entry.ts', page);
      await page.advance(2 * POLL_MS);
    }
    assert.equal(asked(offered, '/api/stats/public'), 3);
    assert.equal(offered.snapshot(), failed.snapshot());
  }
});

test('list rows and the numbers are checked field by field', () => {
  assert.ok(isBoardRoom(row('AAA')));
  assert.ok(isBoardRoom(playing('AAA', 3, { frame_url: '/room/AAA/frame.jpg?t=1', frame_age_s: 0.5 })));
  assert.ok(
    isBoardRoom({
      room_code: 'A',
      status: 'lobby',
      player_count: 0,
      max_players: 4,
      spectator_count: 0,
      max_spectators: 20,
    }),
  );
  for (const fields of [
    { room_code: '' },
    { room_code: 5 },
    { status: null },
    { player_count: '2' },
    { max_players: null },
    { spectator_count: [] },
    { max_spectators: '20' },
    { host_name: 1 },
    { game: {} },
    { started_at: 'now' },
    { frame_url: 3 },
    { frame_age_s: 'old' },
  ]) {
    assert.equal(isBoardRoom(row('AAA', fields)), false, JSON.stringify(fields));
  }
  for (const json of [null, 'AAA', 3, []]) assert.equal(isBoardRoom(json), false);
  assert.deepEqual(
    boardRooms([row('AAA'), null, { room_code: 'B' }, row('CCC')]).map((r) => r.room_code),
    ['AAA', 'CCC'],
  );
  for (const json of [null, {}, 'x', 0, true]) assert.deepEqual(boardRooms(json), []);
  for (const json of [null, {}, [], 'x', 0, false]) assert.equal(isJson(json), true);

  assert.ok(isPublicStats({ matches_this_week: null, people_playing_now: 0 }));
  assert.ok(isPublicStats({ matches_this_week: 12, people_playing_now: 3 }));
  assert.ok(isPublicStats({}));
});

// ── Decisions ───────────────────────────────────────────────────────────────

const lobby: BoardRoom = {
  room_code: 'AAA',
  status: 'lobby',
  player_count: 2,
  max_players: 4,
  spectator_count: 0,
  max_spectators: 20,
  host_name: 'Kaz',
  game: 'Super Smash Bros. 64',
};

test('what a room is doing', () => {
  const now = NOW_S * 1000;
  assert.equal(statusText(lobby, now), 'waiting for players');
  assert.equal(statusText({ ...lobby, player_count: 4 }, now), 'full');
  assert.equal(statusText({ ...lobby, player_count: 5 }, now), 'full');
  assert.equal(statusText({ ...lobby, status: 'playing' }, now), 'in game');
  assert.equal(statusText({ ...lobby, status: 'playing', started_at: null }, now), 'in game');
  assert.equal(statusText({ ...lobby, status: 'playing', started_at: NOW_S }, now), 'in game · 1 min');
  assert.equal(statusText({ ...lobby, status: 'playing', started_at: NOW_S - 119 }, now), 'in game · 1 min');
  assert.equal(statusText({ ...lobby, status: 'playing', started_at: NOW_S - 120 }, now), 'in game · 2 min');
  assert.equal(statusText({ ...lobby, status: 'playing', started_at: NOW_S + 600 }, now), 'in game · 1 min');
});

test('a row is rebuilt only when what it shows changes', () => {
  const sig = rowSignature(lobby);
  assert.equal(rowSignature({ ...lobby, started_at: 5, frame_url: '/f', frame_age_s: 9, spectator_count: 19 }), sig);
  for (const change of [
    { status: 'playing' },
    { player_count: 3 },
    { max_players: 2 },
    { spectator_count: 20 },
    { host_name: 'Agent 21' },
    { game: 'Smash Remix' },
  ]) {
    assert.notEqual(rowSignature({ ...lobby, ...change }), sig, JSON.stringify(change));
  }
});

test('the links a room offers, in a row and featured', () => {
  assert.deepEqual(
    roomActions(lobby, false).map((a) => [a.act, a.label, a.primary]),
    [
      ['watch', 'Watch', false],
      ['join', 'Join', true],
    ],
  );
  assert.deepEqual(
    roomActions(lobby, true).map((a) => [a.act, a.label, a.primary]),
    [
      ['watch', 'Watch', true],
      ['join', 'Join · 2 slots open', false],
    ],
  );
  assert.equal(roomActions({ ...lobby, player_count: 3 }, true)[1]?.label, 'Join · 1 slot open');
  assert.deepEqual(
    roomActions({ ...lobby, player_count: 4 }, false).map((a) => a.act),
    ['watch'],
  );
  assert.deepEqual(
    roomActions({ ...lobby, spectator_count: 20 }, false).map((a) => a.act),
    ['join'],
  );
  assert.deepEqual(roomActions({ ...lobby, player_count: 4, spectator_count: 20 }, false), []);
  assert.equal(roomActions(lobby, false)[0]?.ariaLabel, "Watch Kaz's room");
  assert.equal(
    roomActions({ ...lobby, host_name: null }, false)[1]?.ariaLabel,
    "Join this player's room, needs your ROM",
  );
});

test('the featured match: newest with an open slot, else newest, else none', () => {
  const match = (code: string, started_at: number | null, player_count: number): BoardRoom => ({
    ...lobby,
    room_code: code,
    status: 'playing',
    started_at,
    player_count,
  });
  assert.equal(featuredRoom([]), null);
  assert.equal(featuredRoom([lobby]), null);
  assert.equal(featuredRoom([match('A', 100, 4), match('B', 200, 4)])?.room_code, 'B');
  assert.equal(featuredRoom([match('A', 100, 3), match('B', 200, 4)])?.room_code, 'A');
  assert.equal(featuredRoom([match('A', 100, 3), match('B', 200, 2)])?.room_code, 'B');
  assert.equal(featuredRoom([match('A', 100, 3), match('B', 100, 3)])?.room_code, 'A', 'a tie keeps list order');
  assert.equal(featuredRoom([match('A', null, 3), match('B', 1, 3)])?.room_code, 'B');
  const rooms = [match('A', 100, 4), match('B', 200, 4)];
  featuredRoom(rooms);
  assert.deepEqual(
    rooms.map((r) => r.room_code),
    ['A', 'B'],
    'the list itself is not reordered',
  );
  assert.match(featuredWhy(match('A', 1, 3)), /Join takes the open slot/);
  assert.match(featuredWhy(match('A', 1, 4)), /Join opens up when a slot does/);
});

test('frames: only a match in play has one, and one over 30 s old is stale', () => {
  const live = { ...lobby, status: 'playing', frame_url: '/room/AAA/frame.jpg?t=1' };
  assert.equal(frameUrl('', live), '/room/AAA/frame.jpg?t=1');
  assert.equal(frameUrl('https://game.example', live), 'https://game.example/room/AAA/frame.jpg?t=1');
  assert.equal(frameUrl('', { ...live, status: 'lobby' }), '');
  assert.equal(frameUrl('', { ...live, frame_url: null }), '');
  assert.equal(isStaleFrame({ ...live, frame_age_s: 30 }), false);
  assert.equal(isStaleFrame({ ...live, frame_age_s: 30.1 }), true);
  assert.equal(isStaleFrame({ ...live, frame_age_s: null }), false);
  assert.equal(isStaleFrame(live), false);
});

test('when the board asks', () => {
  assert.equal(pollDelay(false), 10000);
  assert.equal(pollDelay(true), 30000);
  assert.equal(isIdle(IDLE_STOP_MS, 0), false);
  assert.equal(isIdle(IDLE_STOP_MS + 1, 0), true);
  assert.deepEqual([0, 1, 5, 6, 7, 12].map(asksForStats), [true, false, false, true, false, true]);
  assert.equal(stateAfterFailedList('loading'), 'error');
  assert.equal(stateAfterFailedList('waking'), 'error');
  for (const state of ['live', 'empty', 'error'] as const) assert.equal(stateAfterFailedList(state), state);
  assert.equal(refreshesOnReturn(false, 'live'), true);
  assert.equal(refreshesOnReturn(false, 'empty'), true);
  assert.equal(refreshesOnReturn(true, 'live'), false);
  for (const state of ['loading', 'waking', 'error'] as const) assert.equal(refreshesOnReturn(false, state), false);
});

test('the words around the board', () => {
  assert.equal(plural(1, 'match', 'matches'), '1 match');
  assert.equal(plural(0, 'match', 'matches'), '0 matches');
  assert.equal(liveText(1, true), '1 person playing right now');
  assert.equal(liveText(2, false), '2 people playing right now');
  assert.equal(liveText(0, true), 'no open rooms right now');
  assert.equal(liveText(0, false), '');
  assert.equal(weekText(null), '');
  assert.equal(weekText(undefined), '');
  assert.equal(weekText(0), '0 matches this week');
  assert.equal(weekText(1), '1 match this week');
  assert.equal(createText('waking'), 'Create a room · ready in a moment');
  for (const state of ['loading', 'live', 'empty', 'error'] as const) assert.equal(createText(state), 'Create a room');
});

test('the code field takes a typed code or a pasted link', () => {
  assert.equal(codeFromInput(''), '');
  assert.equal(codeFromInput('   '), '');
  assert.equal(codeFromInput('abc123'), 'ABC123');
  assert.equal(codeFromInput(' ab-c 12_3! '), 'ABC123');
  assert.equal(codeFromInput('https://kn.example/play.html?room=aBc123'), 'aBc123');
  assert.equal(codeFromInput('https://kn.example/join?room=aBc123&spectate=1'), 'aBc123');
  assert.equal(codeFromInput('room=xyz'), 'xyz');
  assert.equal(codeFromInput('room='), 'ROOM');
  assert.equal(codeFromInput('---'), '');
});

test('video ids, marks, visitor ids and the stick', () => {
  for (const id of ['dQw4w9WgXcQ', 'abc-_1', 'a'.repeat(20)]) assert.equal(isVideoId(id), true, id);
  for (const id of [undefined, '', 'short', 'a'.repeat(21), 'has space', 'a/b/c/d/e'])
    assert.equal(isVideoId(id), false);

  assert.equal(hash(''), 2166136261);
  assert.equal(hash('a'), 0xe40c292c);
  assert.equal(hash('foobar'), 0xbf9cf968);
  const day = 864e5;
  assert.equal(markIndexFor(5 * day, 'v'), markIndexFor(6 * day - 1, 'v'), 'the same all day');
  assert.equal(markIndexFor(5 * day, 'v'), hash('5:v') % MARKS.length);
  assert.equal(new Set(Array.from({ length: 50 }, (_, n) => markIndexFor(0, `visitor${n}`))).size, MARKS.length);
  assert.deepEqual(
    MARKS.map((_, index) => nextMarkIndex(index)),
    [1, 2, 3, 4, 5, 6, 0],
  );
  assert.equal(stillAt('seats'), 3);
  assert.equal(stillAt('ports'), 1.5);
  assert.equal(stillAt('ko'), 0);

  assert.equal(savedVisitor('abc'), 'abc');
  assert.equal(savedVisitor(''), null);
  assert.equal(savedVisitor(null), null);
  assert.equal(newVisitor(0.5), 'i');
  assert.match(newVisitor(0.123456789), /^[0-9a-z]{8}$/);

  assert.deepEqual(stickPose(16, 16), { dx: 0, dy: 0, dir: '' });
  assert.deepEqual(stickPose(20, 16), { dx: 4, dy: 0, dir: '' });
  assert.deepEqual(stickPose(22, 16), { dx: 6, dy: 0, dir: 'e' });
  assert.deepEqual(stickPose(116, 16), { dx: 8, dy: 0, dir: 'e' });
  assert.deepEqual(stickPose(0, 16), { dx: -8, dy: 0, dir: 'w' });
  assert.deepEqual(stickPose(16, 0), { dx: 0, dy: -8, dir: 'n' });
  assert.deepEqual(stickPose(16, 24), { dx: 0, dy: 8, dir: 's' });
  assert.equal(stickPose(26, 26).dir, 's', 'a diagonal goes to the vertical');
});

// ── The bundle ──────────────────────────────────────────────────────────────

test('the front page bundle is made of the landing modules only: no core, no Effect', () => {
  const inputs = bundleInputs('landing-entry.ts');
  assert.ok(inputs.includes('web/src/landing/front.ts'));
  for (const input of inputs) {
    assert.ok(input === 'web/src/landing-entry.ts' || input.startsWith('web/src/landing/'), input);
  }
});
