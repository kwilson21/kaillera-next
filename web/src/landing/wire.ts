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

// ── Requests ────────────────────────────────────────────────────────────────

const request = async <T>(
  host: NetHost,
  url: string,
  timeoutMs: number,
  accepts: (body: unknown) => body is T,
  missingIsAnAnswer: boolean,
): Promise<T | null> => {
  const ctl = new AbortController();
  const timer = host.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await host.fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (missingIsAnAnswer && res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!accepts(body)) throw new Error('The answer does not fit');
    return body;
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
  const body = await request(host, url, timeoutMs, accepts, false);
  if (body === null) throw new Error('No answer');
  return body;
};

/** `getJSON`, except that a 404 is an answer: null, the thing asked for is not there. */
export const getJSONIfThere = <T>(
  host: NetHost,
  url: string,
  timeoutMs: number,
  accepts: (body: unknown) => body is T,
): Promise<T | null> => request(host, url, timeoutMs, accepts, true);
