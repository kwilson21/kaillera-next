/**
 * What the play page tells the player while its connection to the server is
 * down: the reconnecting banner, the "server is unreachable" note in a game,
 * the error in the lobby, and a notice when the first connection is slow.
 *
 * These were bare timers in play.js, each cleared by hand on reconnect. Here
 * every notice is an Effect fiber that a reconnect interrupts, so none can
 * fire after the socket is back and none is left running when the page stops.
 *
 * The rules are play.js's, unchanged:
 * - 2 s into an outage the banner says it is reconnecting;
 * - in a game (which keeps running peer to peer) it says the server is
 *   unreachable after 15 s, and stays up until the socket returns;
 * - in the lobby, where nothing works without the server, the page gives up
 *   with an error after 30 s;
 * - a first connection that has not come up after 10 s gets a notice.
 * Whether an outage is in a game or the lobby is decided when it starts.
 */
import { Duration, Effect, Fiber } from 'effect';

/** Where the page was when its socket went down. */
export type OutageWhere = 'game' | 'lobby';

/** The page effects the notices drive; play.js supplies them. */
export interface NoticeEffects {
  /** Show the banner: reconnecting to the server. */
  readonly showReconnecting: () => void;
  /** In a game: the server is unreachable, the game carries on. */
  readonly showServerDown: () => void;
  /** Take the banner down. */
  readonly hide: () => void;
  /** In the lobby: give up, the page cannot work without the server. */
  readonly giveUp: () => void;
  /** The first connection is taking long. */
  readonly slowFirstConnect: () => void;
}

export interface NoticeTimings {
  readonly bannerAfterMs: number;
  readonly serverDownAfterMs: number;
  readonly giveUpAfterMs: number;
  readonly slowFirstConnectMs: number;
}

export const NOTICE_TIMINGS: NoticeTimings = {
  bannerAfterMs: 2_000,
  serverDownAfterMs: 15_000,
  giveUpAfterMs: 30_000,
  slowFirstConnectMs: 10_000,
};

/** One notice: wait, then show it. Interrupting the fiber cancels it. */
const after = (ms: number, show: () => void): Effect.Effect<void> =>
  Effect.sleep(Duration.millis(ms)).pipe(Effect.andThen(Effect.sync(show)));

type Running = Fiber.Fiber<void> | null;

export interface ConnectionNotices {
  /** The socket went down (or failed to connect) while the page was `where`. */
  readonly down: (where: OutageWhere) => void;
  /** The socket is connected: cancel every notice and take the banner down. */
  readonly up: () => void;
  /** The page is going away: cancel everything, show nothing. */
  readonly stop: () => void;
}

/**
 * Start the notices for a page whose first connection is under way (the
 * slow-first-connection notice starts counting now).
 */
export const startConnectionNotices = (
  effects: NoticeEffects,
  timings: NoticeTimings = NOTICE_TIMINGS,
): ConnectionNotices => {
  let firstConnect: Running = Effect.runFork(after(timings.slowFirstConnectMs, effects.slowFirstConnect));
  let banner: Running = null;
  let serverDown: Running = null;
  let giveUp: Running = null;

  const interrupt = (fiber: Running): null => {
    if (fiber) Effect.runFork(Fiber.interrupt(fiber));
    return null;
  };
  const cancelAll = (): void => {
    firstConnect = interrupt(firstConnect);
    banner = interrupt(banner);
    serverDown = interrupt(serverDown);
    giveUp = interrupt(giveUp);
  };

  return {
    down: (where) => {
      // Each notice runs once per outage, however many times the socket
      // reports the outage (Socket.IO repeats connect_error on every retry).
      banner ??= Effect.runFork(after(timings.bannerAfterMs, effects.showReconnecting));
      if (where === 'game') serverDown ??= Effect.runFork(after(timings.serverDownAfterMs, effects.showServerDown));
      else giveUp ??= Effect.runFork(after(timings.giveUpAfterMs, effects.giveUp));
    },
    up: () => {
      cancelAll();
      effects.hide();
    },
    stop: cancelAll,
  };
};
