/**
 * What the front page and the invite page read from the game server, and the
 * one way they read it. These pages load no core and no Effect (they are
 * served while the server sleeps and must stay small), so the checks are
 * written by hand.
 *
 * An answer that does not fit is treated as no answer: the caller takes the
 * same path as for a failed request or a body that is not JSON.
 */

/** The part of a page a request needs. A browser `window` is one. */
export interface NetHost {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

// ── Field checks ────────────────────────────────────────────────────────────

const hasText = <K extends string>(value: unknown, key: K): value is { readonly [P in K]: string } =>
  typeof value === 'object' && value !== null && typeof Object.getOwnPropertyDescriptor(value, key)?.value === 'string';

const hasNumber = <K extends string>(value: unknown, key: K): value is { readonly [P in K]: number } =>
  typeof value === 'object' && value !== null && typeof Object.getOwnPropertyDescriptor(value, key)?.value === 'number';

/** A field the server may leave out or send as null. */
const mayHave = <K extends string>(
  value: unknown,
  key: K,
  type: 'string' | 'number' | 'boolean',
): value is { readonly [P in K]?: string | number | boolean | null } => {
  if (typeof value !== 'object' || value === null) return false;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return field === null || field === undefined || typeof field === type;
};

// ── GET /health ─────────────────────────────────────────────────────────────

/** The server is up. The pages read nothing from it but that it answered. */
export interface HealthAnswer {
  readonly status: string;
}

export const isHealthAnswer = (value: unknown): value is HealthAnswer => hasText(value, 'status');

// ── GET /room/<code> ────────────────────────────────────────────────────────

/** A room as the invite page needs it. The server sends more; the rest is not read. */
export interface RoomAnswer {
  readonly status: string;
  readonly player_count: number;
  readonly max_players: number;
  readonly host_name?: string | null;
  readonly game_id?: string | null;
  readonly romName?: string | null;
  /** Nobody is connected: only the room's own members may come back. */
  readonly closed?: boolean | null;
}

export const isRoomAnswer = (value: unknown): value is RoomAnswer =>
  hasText(value, 'status') &&
  hasNumber(value, 'player_count') &&
  hasNumber(value, 'max_players') &&
  mayHave(value, 'host_name', 'string') &&
  mayHave(value, 'game_id', 'string') &&
  mayHave(value, 'romName', 'string') &&
  mayHave(value, 'closed', 'boolean');

// ── GET /list ───────────────────────────────────────────────────────────────

/** A JSON value: what a response body parses to. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [field: string]: Json };

/** Any parsed body is JSON; this only names it. */
export const isJson = (body: unknown): body is Json => body !== undefined;

/** A listed room as the board needs it. */
export interface BoardRoom {
  readonly room_code: string;
  readonly status: string;
  readonly player_count: number;
  readonly max_players: number;
  readonly spectator_count: number;
  readonly max_spectators: number;
  readonly host_name?: string | null;
  /** The game's name, as the server worked it out. */
  readonly game?: string | null;
  /** When the match started, in seconds since the epoch; null in the lobby. */
  readonly started_at?: number | null;
  /** The room's latest frame, as a path on the game server; null when it has none. */
  readonly frame_url?: string | null;
  readonly frame_age_s?: number | null;
}

export const isBoardRoom = (value: unknown): value is BoardRoom =>
  hasText(value, 'room_code') &&
  value.room_code !== '' &&
  hasText(value, 'status') &&
  hasNumber(value, 'player_count') &&
  hasNumber(value, 'max_players') &&
  hasNumber(value, 'spectator_count') &&
  hasNumber(value, 'max_spectators') &&
  mayHave(value, 'host_name', 'string') &&
  mayHave(value, 'game', 'string') &&
  mayHave(value, 'started_at', 'number') &&
  mayHave(value, 'frame_url', 'string') &&
  mayHave(value, 'frame_age_s', 'number');

/**
 * The rooms in a `/list` answer. A body that is not a list is an empty
 * board, and a row that is not a listed room is left out, as the page always
 * did for a row with no room code.
 */
export const boardRooms = (body: Json): BoardRoom[] => (Array.isArray(body) ? body.filter(isBoardRoom) : []);

// ── GET /api/stats/public ───────────────────────────────────────────────────

/** The front page's numbers. Real or absent: a number the server has not counted is null. */
export interface PublicStats {
  readonly matches_this_week?: number | null;
  readonly people_playing_now?: number | null;
}

export const isPublicStats = (value: unknown): value is PublicStats =>
  !Array.isArray(value) &&
  mayHave(value, 'matches_this_week', 'number') &&
  mayHave(value, 'people_playing_now', 'number');

// ── Requests ────────────────────────────────────────────────────────────────

/** A request's outcome: the body that was accepted, or (where a 404 is an answer) nothing there. */
type Answer<T> = { readonly there: true; readonly body: T } | { readonly there: false };

const request = async <T>(
  host: NetHost,
  url: string,
  timeoutMs: number,
  accepts: (body: unknown) => body is T,
  missingIsAnAnswer: boolean,
): Promise<Answer<T>> => {
  const ctl = new AbortController();
  const timer = host.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await host.fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (missingIsAnAnswer && res.status === 404) return { there: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!accepts(body)) throw new Error('The answer does not fit');
    return { there: true, body };
  } finally {
    host.clearTimeout(timer);
  }
};

/**
 * GET a JSON answer, given up after `timeoutMs`. Rejects on a network
 * failure, a timeout, a status that is not 2xx, a body that is not JSON, and
 * a body `accepts` turns down.
 */
export const getJSON = async <T>(
  host: NetHost,
  url: string,
  timeoutMs: number,
  accepts: (body: unknown) => body is T,
): Promise<T> => {
  const answer = await request(host, url, timeoutMs, accepts, false);
  if (!answer.there) throw new Error('No answer');
  return answer.body;
};

/** `getJSON`, except that a 404 is an answer: null, the thing asked for is not there. */
export const getJSONIfThere = async <T>(
  host: NetHost,
  url: string,
  timeoutMs: number,
  accepts: (body: unknown) => body is T,
): Promise<T | null> => {
  const answer = await request(host, url, timeoutMs, accepts, true);
  return answer.there ? answer.body : null;
};
