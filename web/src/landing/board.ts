/**
 * The front page's decisions (docs/landing-design.md §7.2 M1): what the
 * open-rooms board says about a room, which match is featured, when the board
 * asks again, and what the room-code field takes. No page here; the page is
 * web/src/landing/front.ts. Moved from web/static/landing.js.
 */
import type { BoardRoom } from './wire.ts';

/** How often the board asks while the tab is visible, and while it is not. */
export const POLL_MS = 10000;
export const POLL_HIDDEN_MS = 30000;
/** With nothing pressed, scrolled or touched for this long, the board stops asking (§7.7). */
export const IDLE_STOP_MS = 10 * 60 * 1000;
/** The numbers are asked for on one poll in this many: about once a minute. */
export const STATS_EVERY = 6;
/** A frame older than this many seconds is shown as stale. */
export const STALE_FRAME_S = 30;

/** The board's states; exactly one shows. */
export type BoardState = 'loading' | 'live' | 'empty' | 'waking' | 'error';
export const BOARD_STATES: readonly BoardState[] = ['loading', 'live', 'empty', 'waking', 'error'];

/** `1 match`, `2 matches`. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** How long until the next poll. */
export const pollDelay = (hidden: boolean): number => (hidden ? POLL_HIDDEN_MS : POLL_MS);

/** The visitor has been away from the page long enough to stop polling. */
export const isIdle = (now: number, lastInteraction: number): boolean => now - lastInteraction > IDLE_STOP_MS;

/** This poll (the `pollCount`th since polling last started) also asks for the numbers. */
export const asksForStats = (pollCount: number): boolean => pollCount % STATS_EVERY === 0;

/**
 * The board's state after a list request got no answer. Health answered but
 * the list didn't: a board not yet on screen says so (Create stays usable); a
 * board already on screen stays.
 */
export const stateAfterFailedList = (state: BoardState): BoardState =>
  state === 'loading' || state === 'waking' ? 'error' : state;

/** The tab came back: a board on screen is refreshed at once. */
export const refreshesOnReturn = (hidden: boolean, state: BoardState): boolean =>
  !hidden && (state === 'live' || state === 'empty');

/** The Create button's words: it waits while the server wakes. */
export const createText = (state: BoardState): string =>
  state === 'waking' ? 'Create a room · ready in a moment' : 'Create a room';

/**
 * The line beside the board's title. The count covers every match, listed or
 * not, so it wins over an empty board; the empty line speaks only for the
 * rooms the board can show.
 */
export const liveText = (people: number, empty: boolean): string =>
  people > 0 ? `${plural(people, 'person', 'people')} playing right now` : empty ? 'no open rooms right now' : '';

/** Real or absent (§7.2 M0.5): nothing until a full week has been counted. */
export const weekText = (matches: number | null | undefined): string =>
  matches == null ? '' : `${plural(matches, 'match', 'matches')} this week`;

/** What a room is doing, for its row. `nowMs` is the page's clock. */
export const statusText = (room: BoardRoom, nowMs: number): string => {
  if (room.status === 'playing') {
    if (!room.started_at) return 'in game';
    const min = Math.max(1, Math.floor((nowMs / 1000 - room.started_at) / 60));
    return `in game · ${min} min`;
  }
  return room.player_count >= room.max_players ? 'full' : 'waiting for players';
};

/**
 * Everything a row shows that is not its frame or its minutes. A row is
 * rebuilt only when this changes, so a poll never steals keyboard focus.
 */
export const rowSignature = (room: BoardRoom): string =>
  [
    room.status,
    room.player_count,
    room.max_players,
    room.spectator_count < room.max_spectators,
    room.host_name,
    room.game,
  ].join('|');

/** One of a room's actions: a link into the room. */
export interface RoomAction {
  readonly act: 'watch' | 'join';
  readonly label: string;
  readonly primary: boolean;
  readonly spectate: boolean;
  readonly ariaLabel: string;
}

/**
 * The links a room offers, in order: Watch while there is room to watch, Join
 * while a slot is open. None means the row says "Room full". On the featured
 * match Watch is the primary action and Join says how many slots are open; in
 * a row Join is primary.
 */
export const roomActions = (room: BoardRoom, featured: boolean): RoomAction[] => {
  const host = room.host_name || 'this player';
  const open = room.max_players - room.player_count;
  const actions: RoomAction[] = [];
  if (room.spectator_count < room.max_spectators) {
    actions.push({
      act: 'watch',
      label: 'Watch',
      primary: featured,
      spectate: true,
      ariaLabel: `Watch ${host}'s room`,
    });
  }
  if (open > 0) {
    actions.push({
      act: 'join',
      label: featured ? `Join · ${plural(open, 'slot', 'slots')} open` : 'Join',
      primary: !featured,
      spectate: false,
      ariaLabel: `Join ${host}'s room, needs your ROM`,
    });
  }
  return actions;
};

/** The frame to show for a room, as an address, or empty: only a match in play has one. */
export const frameUrl = (api: string, room: BoardRoom): string =>
  room.frame_url && room.status === 'playing' ? api + room.frame_url : '';

/** A shown frame is old enough to mark as stale. */
export const isStaleFrame = (room: BoardRoom): boolean => (room.frame_age_s ?? Number.NaN) > STALE_FRAME_S;

/**
 * The match the board features: the newest in play with an open slot
 * (joinable beats watchable), else the newest in play. Null with no match in
 * play. Matches that started together keep the list's order.
 */
export const featuredRoom = (rooms: readonly BoardRoom[]): BoardRoom | null => {
  const ingame = rooms.filter((r) => r.status === 'playing');
  const newest = (a: BoardRoom, b: BoardRoom): number => (b.started_at || 0) - (a.started_at || 0);
  return ingame.filter((r) => r.player_count < r.max_players).sort(newest)[0] || ingame.sort(newest)[0] || null;
};

/** The line under the featured match's actions. */
export const featuredWhy = (room: BoardRoom): string =>
  room.player_count < room.max_players
    ? 'Watch drops you in as a spectator. Join takes the open slot, mid-game, with your own ROM.'
    : 'Watch drops you in as a spectator. Join opens up when a slot does.';

/**
 * The room the code field names. A pasted link keeps its room ID exactly (IDs
 * are case-sensitive); a typed code is uppercased, since generated codes are,
 * and loses anything that is not a letter or a digit. Empty for nothing usable.
 */
export const codeFromInput = (value: string): string => {
  const val = value.trim();
  const m = val.match(/room=([A-Za-z0-9]+)/);
  return m?.[1] ?? val.toUpperCase().replace(/[^A-Z0-9]/g, '');
};

/** A YouTube video id the page will embed: nothing else reaches the player's address. */
export const isVideoId = (id: string | undefined): id is string => /^[A-Za-z0-9_-]{6,20}$/.test(id || '');

// ── Header marks (§5.8) ─────────────────────────────────────────────────────

/** The marks beside the name, in the order a click steps through them. "letters" is the name alone. */
export const MARKS = ['seats', 'ports', 'dpad', 'wheel', 'ko', 'stick', 'letters'] as const;
export type Mark = (typeof MARKS)[number];

/** Reduced motion freezes an animated mark on a representative frame, this many seconds in. */
export const stillAt = (mark: Mark): number => (mark === 'seats' ? 3.0 : mark === 'ports' ? 1.5 : 0);

/** FNV-1a over a string's UTF-16 units, as an unsigned 32-bit number. */
export const hash = (str: string): number => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The mark a visitor sees today: one per visit, the same all day, different visitors apart. */
export const markIndexFor = (nowMs: number, visitor: string): number =>
  hash(`${Math.floor(nowMs / 864e5)}:${visitor}`) % MARKS.length;

/** The mark after this one. */
export const nextMarkIndex = (index: number): number => (index + 1) % MARKS.length;

/** A saved visitor id worth keeping: any text at all. */
export const savedVisitor = (saved: string | null | undefined): string | null => saved || null;

/** A new visitor id from a random number in [0, 1). */
export const newVisitor = (random: number): string => random.toString(36).slice(2, 10);

/** Where the stick mark's cap sits and which way it points, for a pointer at (x, y) in the mark's 32-unit box. */
export interface StickPose {
  readonly dx: number;
  readonly dy: number;
  /** The direction lit, or empty near the centre. */
  readonly dir: '' | 'n' | 'e' | 's' | 'w';
}

/** The cap follows the pointer up to 8 units from the centre; past 5 it lights a direction. */
export const stickPose = (x: number, y: number): StickPose => {
  let dx = x - 16;
  let dy = y - 16;
  const d = Math.hypot(dx, dy);
  const m = Math.min(d, 8);
  if (d > 0) {
    dx = (dx / d) * m;
    dy = (dy / d) * m;
  }
  const dir = m > 5 ? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n') : '';
  return { dx, dy, dir };
};
