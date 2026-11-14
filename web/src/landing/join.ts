/**
 * The invite page (docs/landing-design.md §7.2 M2, W3). Moved from
 * web/static/join.js.
 *
 * /join?room=CODE[&spectate=1] looks the room up, wakes the server if it's
 * napping, and says who invited you, what Join needs and what Watch doesn't
 * before handing off to /play.html. States: waiting · full · closed ·
 * in-app browser · waking · spectator link · unsupported browser.
 *
 * Ships in its own small bundle (web/src/join-entry.ts →
 * web/static/dist/kn-join.js): the page is served while the game server
 * sleeps, so it loads no core.
 */
import {
  FIRST_HEALTH_TIMEOUT_MS,
  FIRST_PING_TIMEOUT_MS,
  SLOW_WAKE_LINE,
  WAKE_POLL_MS,
  apiBase,
  elapsedText,
  hostUrl,
  isSlowWake,
  nextPingTimeout,
  playUrl,
  randomRoomCode,
  reportWakeDuration,
  sendDirectWake,
  type CodeHost,
  type WakeHost,
} from './wake.ts';
import { getJSONIfThere, isHealthAnswer, isRoomAnswer, type RoomAnswer } from './wire.ts';

/** How often a room on screen is looked up again. */
export const REFRESH_MS = 15000;
/** How long one room lookup is given. */
const LOOKUP_TIMEOUT_MS = 8000;

// ── Decisions ───────────────────────────────────────────────────────────────

/** What an invite link asks for. */
export interface Invite {
  /** The room code, or empty when the link carries none that could be a room. */
  readonly code: string;
  /** The link is a spectator link (`&spectate=1`). */
  readonly spectate: boolean;
}

/**
 * Read an invite link's query string. Room IDs are case-sensitive (the
 * server's /^[A-Za-z0-9]{3,16}$/): one that fits is taken as is, and anything
 * else is no code at all.
 */
export const inviteFrom = (search: string): Invite => {
  const params = new URLSearchParams(search);
  const raw = params.get('room') || '';
  return { code: /^[A-Za-z0-9]{3,16}$/.test(raw) ? raw : '', spectate: params.get('spectate') === '1' };
};

// The common in-app browsers that open links from chats (§7.2 M2).
const IN_APP: readonly (readonly [RegExp, string])[] = [
  [/Discord/i, 'Discord'],
  [/Instagram/i, 'Instagram'],
  [/FB_IAB|FBAN|FBAV|Messenger/i, 'Facebook'],
  [/musical_ly|TikTok|BytedanceWebview/i, 'TikTok'],
  [/Twitter/i, 'X'],
];

/** The app whose built-in browser this is, by its user agent, or null for a real browser. */
export const inAppBrowser = (userAgent: string): string | null =>
  IN_APP.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

/** The banner an in-app browser gets. */
export const inAppLine = (app: string): string =>
  `You're in ${app}'s built-in browser. Open this link in Safari or Chrome for the game to run.`;

/** The first screen the page moves to from its loading placeholder. */
export type FirstStep = 'closed' | 'unsupported' | 'lookup';

/**
 * Where a visit starts. No usable code is a closed room. A browser with no
 * WebRTC can do nothing on the room page, not even watch, so it is told so
 * without a lookup. (`canPlay` is WebRTC and WebAssembly, so the first test
 * follows from the second; both are kept as the page always had them.)
 */
export const firstStep = (code: string, canPlay: boolean, hasWebRTC: boolean): FirstStep => {
  if (!code) return 'closed';
  if (!canPlay && !hasWebRTC) return 'unsupported';
  return 'lookup';
};

/** What a room lookup found. */
export type Lookup =
  /** The server has no such room: gone for good. */
  | { readonly kind: 'gone' }
  /** Nobody is connected, but the server still has the room: it can come back. */
  | { readonly kind: 'closed'; readonly hostName: string }
  /** A room to join or watch. */
  | { readonly kind: 'open'; readonly room: RoomAnswer };

/** Sort a lookup's answer (null for a 404) into what the page shows for it. */
export const lookupResult = (room: RoomAnswer | null): Lookup => {
  if (!room) return { kind: 'gone' };
  if (room.closed) return { kind: 'closed', hostName: room.host_name ?? '' };
  return { kind: 'open', room };
};

/** The words on the closed screen. */
export interface ClosedView {
  readonly title: string;
  readonly line: string;
}

export const closedView = (hostName: string): ClosedView => {
  const h = hostName.trim();
  return {
    title: h ? `${h}'s room has closed.` : 'This room has closed.',
    line: h
      ? `Rooms live only while someone's in them. Ask ${h} for a new link, or open your own.`
      : "Rooms live only while someone's in them. Ask for a new link, or open your own.",
  };
};

/** A game the invite can name, and what its ROM is called. */
interface Game {
  readonly name: string;
  readonly rom: string;
}

const GAMES: ReadonlyMap<string, Game> = new Map([
  ['ssb64', { name: 'Super Smash Bros. 64', rom: 'SSB64' }],
  ['smash-remix', { name: 'Smash Remix', rom: 'Smash Remix' }],
]);

const gameOf = (room: RoomAnswer): Game =>
  GAMES.get(room.game_id ?? '') ?? { name: room.romName || 'Super Smash Bros. 64', rom: 'SSB64' };

/** The class of the room's `index`th slot marker: taken slots carry their player colour. */
export const slotClass = (index: number, playerCount: number): string =>
  index < playerCount ? `slot p${(index % 4) + 1} on` : 'slot';

/** The line after the slot markers: how many are in, and what the room is doing. */
export const factsText = (room: RoomAnswer): string => {
  const status =
    room.status === 'playing' ? 'in game' : room.player_count >= room.max_players ? 'full' : 'waiting for players';
  return ` ${room.player_count} of ${room.max_players} in the room · ${status}`;
};

/** Everything the invite says about an open room. */
export interface InviteView {
  readonly kicker: string;
  readonly title: string;
  /** The "room is full" line is hidden. */
  readonly fullLineHidden: boolean;
  /** Watch is the primary action and comes first: a full room, or a spectator link. */
  readonly watchFirst: boolean;
  readonly joinText: string;
  readonly watchText: string;
  readonly joinHint: string;
  readonly next: string;
}

export const inviteView = (room: RoomAnswer, spectate: boolean): InviteView => {
  const game = gameOf(room);
  const host = (room.host_name || '').trim();
  const full = room.player_count >= room.max_players;
  return {
    kicker: spectate
      ? host
        ? `Watch ${host}'s room`
        : 'Watch this room'
      : host
        ? `${host} invited you to play`
        : "You're invited to play",
    title: game.name,
    fullLineHidden: !full || spectate,
    watchFirst: spectate || full,
    joinText: full ? 'Join when a slot opens' : spectate ? 'Join if a slot opens · needs your ROM' : 'Join the room',
    watchText: spectate || full ? 'Watch' : 'Watch instead',
    joinHint: spectate
      ? `needs your own ${game.rom} ROM`
      : `needs your own ${game.rom} ROM (.z64 / .n64 / .v64 / .zip)`,
    next: spectate
      ? "What happens next: you'll see the game as it plays, with sound. If a slot opens, you can take it with your own ROM."
      : room.status === 'playing'
        ? `What happens next: pick a name and drop your ROM; you join ${host ? `${host}'s` : 'the'} match in progress.`
        : `What happens next: pick a name, drop your ROM, wait for ${host || 'the host'} to press Start.`,
  };
};

/** The page's sections; exactly one shows. */
export type Section = 'inv-loading' | 'inv-main' | 'inv-closed' | 'inv-unsupported' | 'inv-waking';

const SECTIONS: readonly Section[] = ['inv-loading', 'inv-main', 'inv-closed', 'inv-unsupported', 'inv-waking'];

/**
 * A lookup that got no answer puts up the waiting screen only when nothing
 * better is showing: a room (or a closed room) already on screen stays.
 */
export const failedLookupShowsWaiting = (section: Section): boolean =>
  section === 'inv-loading' || section === 'inv-waking';

/**
 * The tab came back: look the room up now rather than on the next refresh,
 * for a room on screen and for a closed one the server still has.
 */
export const looksUpOnReturn = (hidden: boolean, section: Section, closedRecord: boolean): boolean =>
  !hidden && (section === 'inv-main' || (section === 'inv-closed' && closedRecord));

// ── The page ────────────────────────────────────────────────────────────────

/** The part of a page the invite uses. A browser `window` is one. */
export interface JoinHost extends WakeHost, CodeHost {
  readonly location: Location;
  readonly navigator: Navigator;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  readonly RTCPeerConnection?: unknown;
  readonly WebAssembly?: unknown;
}

/** Run the invite page on `host`. Called once, by the page's bundle. */
export const startJoinPage = (host: JoinHost): void => {
  const doc = host.document;
  const $ = <E extends HTMLElement = HTMLElement>(id: string): E => {
    const found = doc.querySelector<E>(`#${id}`);
    if (!found) throw new Error(`The invite page has no #${id}`);
    return found;
  };
  const API = apiBase(doc);
  const { code, spectate } = inviteFrom(host.location.search);

  let state: Section = 'inv-loading';
  const show = (id: Section): void => {
    state = id;
    for (const s of SECTIONS) $(s).hidden = s !== id;
  };

  // ── Copy link (in-app banner, unsupported browser) ────────────────────────

  const copyLink = async (btn: HTMLElement): Promise<void> => {
    const url = host.location.href;
    try {
      await host.navigator.clipboard.writeText(url);
    } catch {
      const ta = doc.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      doc.body.append(ta);
      ta.select();
      try {
        doc.execCommand('copy');
      } catch {
        /* nothing more to try; the link is in the address bar */
      }
      ta.remove();
    }
    btn.textContent = 'Copied';
    host.setTimeout(() => {
      btn.textContent = 'Copy link';
    }, 2000);
  };
  const inAppCopy = $('inapp-copy');
  inAppCopy.addEventListener('click', () => void copyLink(inAppCopy));
  const unsupCopy = $('unsup-copy');
  unsupCopy.addEventListener('click', () => void copyLink(unsupCopy));

  const inApp = inAppBrowser(host.navigator.userAgent);
  if (inApp) {
    $('inapp-text').textContent = inAppLine(inApp);
    $('inapp').hidden = false;
  }
  const hasWebRTC = typeof host.RTCPeerConnection === 'function';
  const canPlay = hasWebRTC && typeof host.WebAssembly === 'object';

  // ── Room states ────────────────────────────────────────────────────────

  const openOwn = $<HTMLButtonElement>('open-own');
  openOwn.addEventListener('click', () => {
    openOwn.disabled = true;
    host.location.href = hostUrl(API, randomRoomCode(host));
  });

  const showClosed = (hostName: string): void => {
    const view = closedView(hostName);
    $('closed-title').textContent = view.title;
    $('closed-line').textContent = view.line;
    doc.title = 'Room closed · kaillera-next';
    show('inv-closed');
  };

  let slotsShown = false;
  const factsEl = (room: RoomAnswer): DocumentFragment => {
    const frag = doc.createDocumentFragment();
    const slots = doc.createElement('span');
    slots.className = slotsShown ? 'slots' : 'slots fill-in'; // markers fill in once, as the lookup answers
    slots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < room.max_players; i++) {
      const s = doc.createElement('i');
      s.className = slotClass(i, room.player_count);
      s.style.setProperty('--n', String(i));
      slots.append(s);
    }
    slotsShown = true;
    frag.append(slots, factsText(room));
    return frag;
  };

  const showRoom = (room: RoomAnswer): void => {
    const view = inviteView(room, spectate);
    const { watchFirst } = view;

    $('inv-kicker').textContent = view.kicker;
    $('inv-title').textContent = view.title;
    doc.title = `${$('inv-kicker').textContent} · kaillera-next`;
    $('inv-facts').replaceChildren(factsEl(room));
    $('inv-fullline').hidden = view.fullLineHidden;

    const join = $<HTMLAnchorElement>('inv-join');
    const watch = $<HTMLAnchorElement>('inv-watch');
    const joinHint = $('inv-join-hint');
    const watchHint = $('inv-watch-hint');
    join.href = playUrl(API, code, false);
    watch.href = playUrl(API, code, true);
    join.textContent = view.joinText;
    watch.textContent = view.watchText;
    join.className = watchFirst ? 'btn big' : 'btn primary big';
    watch.className = watchFirst ? 'btn primary big' : 'btn big';
    joinHint.textContent = view.joinHint;
    // Primary first: Watch leads for a full room or a spectator link.
    // Moving a node drops its focus, so the stack is only reordered when the
    // order changes, and a focused action gets its focus back.
    const stack = $('inv-stack');
    if (stack.firstElementChild !== (watchFirst ? watch : join)) {
      const focused = doc.activeElement === join ? join : doc.activeElement === watch ? watch : null;
      const joinPair = [join, joinHint];
      const watchPair = [watch, watchHint];
      stack.replaceChildren(...(watchFirst ? [...watchPair, ...joinPair] : [...joinPair, ...watchPair]));
      if (focused) focused.focus({ preventScroll: true });
    }
    // No WebRTC: nothing on the room page can work, not even watching.
    join.hidden = joinHint.hidden = !canPlay;
    watch.hidden = watchHint.hidden = !hasWebRTC;

    $('inv-next').textContent = view.next;
    if (state !== 'inv-main') show('inv-main');
  };

  // ── Waking ─────────────────────────────────────────────────────────────

  let clock = 0;
  const waitingScreen = (started: number = host.Date.now()): void => {
    if (state !== 'inv-waking') show('inv-waking');
    if (clock) return;
    clock = host.setInterval(() => {
      const elapsed = host.Date.now() - started;
      $('elapsed').textContent = elapsedText(elapsed);
      if (isSlowWake(elapsed)) $('waking-line').textContent = SLOW_WAKE_LINE;
    }, 1000);
  };
  const stopClock = (): void => {
    host.clearInterval(clock);
    clock = 0;
  };

  // Lookups can overlap (the tab comes back while a refresh is out). An
  // answer older than the one on screen is dropped.
  let refreshTimer = 0;
  let lookupSeq = 0;
  let shownSeq = 0;
  let closedRecord = false; // closed, but the server still has the room
  const again = (ms: number): void => {
    host.clearTimeout(refreshTimer);
    refreshTimer = host.setTimeout(() => void lookup(), ms);
  };
  const lookup = async (): Promise<void> => {
    host.clearTimeout(refreshTimer);
    const seq = ++lookupSeq;
    let room: RoomAnswer | null;
    try {
      room = await getJSONIfThere(host, `${API}/room/${encodeURIComponent(code)}`, LOOKUP_TIMEOUT_MS, isRoomAnswer);
    } catch {
      if (seq !== lookupSeq) return; // a newer lookup is out and retries itself
      // Health already succeeded; this waiting screen is not a server wake.
      // The server answered /health but not this. A room already on screen
      // stays; otherwise the waiting screen (with its clock and, after two
      // minutes, the "something's wrong" line) shows while we retry.
      if (failedLookupShowsWaiting(state)) waitingScreen();
      again(WAKE_POLL_MS);
      return;
    }
    if (seq < shownSeq) return;
    shownSeq = seq;
    stopClock();
    closedRecord = false;
    const result = lookupResult(room);
    if (result.kind === 'gone') {
      showClosed('');
      return;
    }
    // A room nobody is connected to takes back only its own members (§7.2
    // M0.2), so it can come back: keep checking until it does.
    if (result.kind === 'closed') {
      closedRecord = true;
      showClosed(result.hostName);
    } else {
      showRoom(result.room);
    }
    again(REFRESH_MS);
  };

  const waking = (started: number): void => {
    waitingScreen(started);
    const directWakeSent = sendDirectWake(host);
    let timeout = FIRST_PING_TIMEOUT_MS;
    const poll = async (): Promise<void> => {
      try {
        await getJSONIfThere(host, `${API}/health`, timeout, isHealthAnswer);
      } catch {
        timeout = nextPingTimeout(timeout);
        host.setTimeout(() => void poll(), WAKE_POLL_MS);
        return;
      }
      reportWakeDuration(host, API, 'invite', started, directWakeSent);
      void lookup(); // the clock runs until the room answers
    };
    host.setTimeout(() => void poll(), WAKE_POLL_MS);
  };

  const start = async (): Promise<void> => {
    const first = firstStep(code, canPlay, hasWebRTC);
    if (first === 'closed') {
      showClosed('');
      return;
    }
    if (first === 'unsupported') {
      show('inv-unsupported');
      return;
    }
    const started = host.Date.now();
    try {
      await getJSONIfThere(host, `${API}/health`, FIRST_HEALTH_TIMEOUT_MS, isHealthAnswer);
    } catch {
      waking(started);
      return;
    }
    void lookup();
  };

  doc.addEventListener('visibilitychange', () => {
    if (looksUpOnReturn(doc.hidden, state, closedRecord)) void lookup();
  });

  void start();
};
