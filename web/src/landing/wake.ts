/**
 * What the front page and the invite page share: where the game server is,
 * the links into a room, a room's slot markers, and waking a server that naps when nobody is around
 * (docs/landing-design.md §7.2). Moved from web/static/landing.js and
 * web/static/join.js, which each had a copy.
 */
import type { NetHost } from './wire.ts';

/** How long after a ping that got no answer the next one goes out. */
export const WAKE_POLL_MS = 3000;
/** How long a wake may take before the page says something may be wrong. */
export const WAKE_SLOW_MS = 120000;
/** The first check, on load: an awake server answers well within this. */
export const FIRST_HEALTH_TIMEOUT_MS = 2000;
/** How long the first ping of a napping server is given. */
export const FIRST_PING_TIMEOUT_MS = 2500;

export const SLOW_WAKE_LINE =
  "Still powering on. If this takes more than a couple of minutes, something's wrong on our side. Reload, or come back in a bit.";

/**
 * How long the next ping is given after one that got no answer. A slow link
 * may need longer than a napping server does, so each miss doubles it, up to
 * 10 s.
 */
export const nextPingTimeout = (timeoutMs: number): number => Math.min(timeoutMs * 2, 10000);

/** The waking clock: minutes and two-digit seconds, `0:07`, `2:15`. */
export const elapsedText = (elapsedMs: number): string => {
  const s = Math.floor(elapsedMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The wake has taken long enough to say so. */
export const isSlowWake = (elapsedMs: number): boolean => elapsedMs > WAKE_SLOW_MS;

/**
 * Where the game server is. Same origin today; a static host in front
 * (deploy/static/README.md) can point the page at the game server with
 * `<meta name="kn-api" content="…">`.
 */
export const apiBase = (doc: Document): string =>
  doc.querySelector<HTMLMetaElement>('meta[name="kn-api"]')?.content || '';

/** The room page for a room: to play, or to watch. */
export const playUrl = (api: string, code: string, spectate: boolean): string =>
  `${api}/play.html?room=${encodeURIComponent(code)}${spectate ? '&spectate=1' : ''}`;

/** The room page for a new room this visitor hosts. */
export const hostUrl = (api: string, code: string): string => `${api}/play.html?room=${code}&host=1&mode=rollback`;

/** The class of a room's `index`th slot marker: taken slots carry their player colour. */
export const slotClass = (index: number, playerCount: number): string =>
  index < playerCount ? `slot p${(index % 4) + 1} on` : 'slot';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A room code from random bytes: one capital letter or digit for each. */
export const roomCodeFrom = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

/** The part of a page that makes a new room code. */
export interface CodeHost {
  readonly crypto: Pick<Crypto, 'getRandomValues'>;
}

export const randomRoomCode = (host: CodeHost): string => roomCodeFrom(host.crypto.getRandomValues(new Uint8Array(8)));

/**
 * The address to ping to wake the game server directly, or null when there
 * is none. The landing Worker writes the server's own origin into
 * `<meta name="kn-origin">`; the placeholder it replaces, an origin that is
 * this page's own, and a value that is not a URL all mean no direct ping (the
 * page's own polling does the waking then).
 */
export const directWakeUrl = (configured: string | null | undefined, pageOrigin: string): URL | null => {
  if (!configured || configured === '__KN_ORIGIN__') return null;
  try {
    const origin = new URL(configured);
    if (origin.origin === pageOrigin) return null;
    return new URL('/health', origin);
  } catch {
    // A malformed build value should not interrupt the normal same-origin poll.
    return null;
  }
};

/** The part of a page that waking uses. */
export interface WakeHost extends NetHost {
  readonly document: Document;
  readonly location: Pick<Location, 'origin'>;
  readonly Date: Pick<DateConstructor, 'now'>;
}

/** Ping the game server's own origin, if the page was given one. Says whether it did. */
export const sendDirectWake = (host: WakeHost): boolean => {
  const configured = host.document.querySelector<HTMLMetaElement>('meta[name="kn-origin"]')?.content;
  const url = directWakeUrl(configured, host.location.origin);
  if (!url) return false;
  try {
    host.fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
    return true;
  } catch {
    return false;
  }
};

/**
 * The wake timing the page reports, as the request body, or null for a time
 * not worth reporting (over an hour: a tab that slept, not a wake).
 */
export const wakeReport = (page: 'front' | 'invite', elapsedMs: number, directWakeSent: boolean): string | null => {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed > 60 * 60 * 1000) return null;
  return JSON.stringify({ page, elapsed_ms: elapsed, direct_wake_sent: directWakeSent });
};

/** Tell the server how long the wake took. Never interrupts the page. */
export const reportWakeDuration = (
  host: WakeHost,
  api: string,
  page: 'front' | 'invite',
  started: number,
  directWakeSent: boolean,
): void => {
  try {
    const body = wakeReport(page, host.Date.now() - started, directWakeSent);
    if (body === null) return;
    host
      .fetch(`${api}/api/wake-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
      .catch(() => {});
  } catch {
    // Wake telemetry must never interrupt the page's normal recovery path.
  }
};
