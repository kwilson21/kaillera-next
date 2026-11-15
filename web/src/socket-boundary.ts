/**
 * The socket boundary: what the server and peers send this page is decoded
 * before any handler sees it (`createBoundary`). Every message the server
 * authors is decoded against the schema generated from the server's own
 * models (protocol.gen.ts); a relay of what a peer sent, and a string a ROM
 * transfer channel delivers, against peer-protocol.ts. A message that does
 * not match is dropped, and logged once: no handler runs on it.
 *
 * The server holds every message it builds to the same model on the way out
 * (payloads.py `checked`, `extra="forbid"`), so a decoded server message is
 * the message as sent; the schemas transform nothing.
 *
 * `createProtocolObserver` is the observer this replaced on the play page. The
 * rollback engine still checks its DataChannel strings with it; it goes once
 * the engine decodes them too.
 */
import { Result, Schema } from 'effect';
import { checkPeerText, checkRelay, type PeerChannel, textKind } from './peer-protocol.ts';
import { JoinRoomAck, serverEvents, SessionLogAck, type ServerEventName, UsersUpdated } from './protocol.ts';
import { issueFinder, redactPath, type WirePayload } from './wire.ts';

export { redactPath, type WirePayload } from './wire.ts';

/** Acks the server builds itself, by the event they answer. */
const serverAcks = {
  'join-room': JoinRoomAck,
  'session-log': SessionLogAck,
} as const;

const finders = new Map<string, (data: WirePayload) => string | null>();
for (const [event, schema] of Object.entries(serverEvents)) finders.set(event, issueFinder(schema));
for (const [event, schema] of Object.entries(serverAcks)) finders.set(`${event} ack`, issueFinder(schema));

/** One server message that did not match its schema. */
export type ProtocolReport = {
  readonly type: 'protocol-mismatch';
  /** The event name, or `<event> ack`. */
  readonly message: string;
  /** What was expected and where: a path into the payload, never its values. */
  readonly issue: string;
};

/**
 * What is wrong with a message, or null when it matches its schema or is not
 * one the server authors (a relay, an unknown event).
 */
export const checkServerMessage = (message: string, data: WirePayload): string | null =>
  finders.get(message)?.(data) ?? null;

/** The one method of a Socket.IO client the observer needs. */
type AnySocket = { onAny: (listener: (event: string, data: WirePayload) => void) => void };

/** How many DataChannel strings of one kind an observer checks. */
export const PEER_SAMPLE = 16;
/** JSON text is sampled by its opening characters, which hold the `type`. */
const PEER_JSON_KEY = 24;
/** A peer sending endless distinct kinds cannot grow the sample table. */
export const PEER_KINDS_MAX = 256;

/** Reports a page may send in one session: a server that is wrong is wrong on every message. */
export const REPORT_LIMIT = 20;

/**
 * Watch a socket's incoming events. Reports from an observed socket are held
 * until the server has sent an upload token on it. `sink` may also return
 * false while it cannot take a report; the report is then held and offered
 * again after the next event's handlers ran.
 */
export const createProtocolObserver = (sink: (report: ProtocolReport) => boolean) => {
  const seen = new Set<string>();
  const held: ProtocolReport[] = [];
  let sent = 0;

  // True from the moment a socket is observed until the server sends that
  // page load an upload token: client events need one, and a token the page
  // restored from storage may have expired.
  let awaitingToken = false;

  const flush = (): void => {
    if (awaitingToken) return;
    while (held.length > 0 && sent < REPORT_LIMIT) {
      const next = held[0];
      if (next === undefined || !sink(next)) return;
      held.shift();
      sent += 1;
    }
  };

  /** A new kind of mismatch is reported, a repeat is not. */
  const note = (message: string, issue: string | null): boolean => {
    if (issue !== null) {
      const key = `${message}\n${issue}`;
      if (!seen.has(key) && seen.size < REPORT_LIMIT) {
        seen.add(key);
        held.push({ type: 'protocol-mismatch', message, issue });
      }
    }
    flush();
    return issue === null;
  };

  /**
   * Check one Socket.IO message: against the server's schema when the server
   * authored it, against the peer schema when it is a relay.
   */
  const check = (message: string, data: WirePayload): boolean => {
    const relay = checkRelay(message, data);
    return relay === null ? note(message, checkServerMessage(message, data)) : note(relay.kind, relay.issue);
  };

  // DataChannel strings arrive on the engine's tick path, some of them every
  // few frames. A kind that is wrong is wrong from its first message, so only
  // the first few of each kind are checked.
  const sampled = new Map<string, number>();
  const peerText = (channel: PeerChannel | 'rom-transfer', text: string): void => {
    const sampleKey = `${channel} ${text.startsWith('{') ? text.slice(0, PEER_JSON_KEY) : textKind(text)}`;
    const count = sampled.get(sampleKey);
    // The table is capped only against new kinds: one already in it keeps its sample.
    if (count === undefined ? sampled.size >= PEER_KINDS_MAX : count >= PEER_SAMPLE) return;
    sampled.set(sampleKey, (count ?? 0) + 1);
    const verdict = checkPeerText(channel, text);
    note(`dc ${verdict.kind}`, verdict.issue);
  };

  return {
    check,
    /** Check a string a DataChannel delivered (sampled: see above). */
    peerText,
    /** Check the data half of an ack the server built (`join-room`, `session-log`). */
    checkAck: (event: keyof typeof serverAcks, data: WirePayload): boolean => check(`${event} ack`, data),
    /** Check every event the socket receives from now on. */
    observe: (socket: AnySocket): void => {
      awaitingToken = true;
      socket.onAny((event, data) => {
        const matches = check(event, data);
        // Socket.IO calls this before the event's own handlers, and the
        // page's upload-token handler is what stores the token the sink
        // sends with: reports go out once those handlers have run.
        queueMicrotask(() => {
          if (event === 'upload-token' && matches) awaitingToken = false;
          flush();
        });
      });
    },
    flush,
  };
};

// ── deciding: the boundary handlers sit behind ───────────────────────────────

/** Longest issue kept in a log line. */
const LOG_ISSUE_MAX = 300;

/** A server message, decoded against its schema: its value, or why it was not taken. */
export type Taken<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly issue: string };

const decoder = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (data: WirePayload): Taken<S['Type']> => {
    const result = decode(data);
    return Result.isSuccess(result)
      ? { ok: true, value: result.success }
      : { ok: false, issue: redactPath(result.failure.message, schema.ast).slice(0, LOG_ISSUE_MAX) };
  };
};

// A page loaded before a deploy keeps running against the new server until
// version-guard reloads it: within a minute while no match is on, at the end of
// the match otherwise. A newer server may add a field: decoding ignores fields
// a schema does not name (and leaves them out of the value), so the message
// still reaches its handler. It may also add a room status or a game mode:
// - `users-updated` and the `join-room` ack take any string there, so an old
//   page's roster stays live; its handlers read an unknown status as not
//   playing and an unknown mode as rollback, as they did with the raw payload.
// - `game-started` in a mode this page does not know is dropped: the page could
//   only run the wrong engine. It stays in the lobby, idle, and version-guard
//   reloads it into the new code.
// A field the server removes or retypes drops the message on an old page, so
// payloads.py changes a field a page reads only by adding a new one.
const newerServer = <F extends typeof UsersUpdated.fields>(fields: F) => ({
  ...fields,
  mode: Schema.NullOr(Schema.String),
  status: Schema.String,
});
const roomFromNewerServer = UsersUpdated.mapFields(newerServer);
const joinAckFromNewerServer = JoinRoomAck.mapFields(newerServer);

const serverDecoders = {
  'users-updated': decoder(roomFromNewerServer),
  'game-started': decoder(serverEvents['game-started']),
  'game-ended': decoder(serverEvents['game-ended']),
  'rom-sharing-updated': decoder(serverEvents['rom-sharing-updated']),
  'upload-token': decoder(serverEvents['upload-token']),
  'reconnect-token': decoder(serverEvents['reconnect-token']),
} satisfies Record<ServerEventName, (data: WirePayload) => Taken<WirePayload>>;

const ackDecoders = {
  'join-room': decoder(joinAckFromNewerServer),
  'session-log': decoder(SessionLogAck),
} as const;

/** What a decoder hands on when a message decodes. */
type DecodedBy<D> = D extends (data: WirePayload) => Taken<infer A> ? A : never;

/** Any server-authored event's payload, as the page decodes it. */
export type ServerMessage = DecodedBy<(typeof serverDecoders)[ServerEventName]>;

/** A server-authored event's payload, decoded. */
export const takeServerMessage = (event: ServerEventName, data: WirePayload): Taken<ServerMessage> =>
  serverDecoders[event](data);

/** The data half of an ack the server built, decoded. */
export const takeAck = <E extends keyof typeof ackDecoders>(event: E, data: WirePayload) => ackDecoders[event](data);

/** Logs lines this page writes about dropped messages, at most: a server that is wrong is wrong on every message. */
export const DROP_LOG_LIMIT = 20;

/**
 * The page's side of the boundary. Each method decodes one kind of message
 * and either hands it on or drops it; `log` is told the first time each kind
 * of message is dropped for each reason, up to `DROP_LOG_LIMIT` lines.
 */
export const createBoundary = (log: (line: string) => void) => {
  const logged = new Set<string>();
  const drop = (message: string, issue: string): void => {
    const key = `${message}\n${issue}`;
    if (logged.has(key) || logged.size >= DROP_LOG_LIMIT) return;
    logged.add(key);
    log(`[protocol] dropped ${message}: ${issue.replace(/\s*\n\s*/g, ' ')}`);
  };

  return {
    /** A handler for a server-authored event that runs only on a payload that decodes, and with the decoded value. */
    server:
      <R>(event: ServerEventName, handler: (value: ServerMessage) => R) =>
      (data: WirePayload): R | undefined => {
        const taken = takeServerMessage(event, data);
        if (!taken.ok) {
          drop(event, taken.issue);
          return undefined;
        }
        return handler(taken.value);
      },
    /**
     * A handler for a relay of what a peer sent (`data-message`, `rom-signal`)
     * that runs only on a message that matches what a peer may send.
     */
    relay:
      <R>(event: 'data-message' | 'rom-signal', handler: (data: WirePayload) => R) =>
      (data: WirePayload): R | undefined => {
        const verdict = checkRelay(event, data);
        if (verdict !== null && verdict.issue !== null) {
          drop(verdict.kind, verdict.issue);
          return undefined;
        }
        return handler(data);
      },
    /** The data half of an ack, decoded; null when it is off its schema (dropped) or absent. */
    ack: <E extends keyof typeof ackDecoders>(event: E, data: WirePayload) => {
      if (data === null || data === undefined) return null;
      const taken = ackDecoders[event](data);
      if (!taken.ok) {
        drop(`${event} ack`, taken.issue);
        return null;
      }
      return taken.value;
    },
    /** Whether a string a ROM transfer channel delivered may be handled; one that may not is dropped. */
    peerText: (channel: 'rom-transfer', text: string): boolean => {
      const verdict = checkPeerText(channel, text);
      if (verdict.issue === null) return true;
      drop(`dc ${verdict.kind}`, verdict.issue);
      return false;
    },
  };
};
