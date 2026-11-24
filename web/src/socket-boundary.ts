/**
 * The socket boundary: what the server and peers send this page is decoded
 * before any handler sees it (`createBoundary`). Every message the server
 * authors is decoded against the schema generated from the server's own
 * models (protocol.gen.ts); a relay of what a peer sent, and a string a
 * DataChannel delivers (the rollback engine's `lockstep` and `sync-state`
 * channels, play.js's ROM transfer channel), against peer-protocol.ts. A
 * message that does not match is dropped, and logged once: no handler runs
 * on it.
 *
 * The server holds every message it builds to the same model on the way out
 * (payloads.py `checked`, `extra="forbid"`), so a decoded server message is
 * the message as sent; the schemas transform nothing.
 */
import { Result, Schema } from 'effect';
import { checkPeerText, checkRelay, type PeerChannel } from './peer-protocol.ts';
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

/**
 * What is wrong with a message, or null when it matches its schema or is not
 * one the server authors (a relay, an unknown event).
 */
export const checkServerMessage = (message: string, data: WirePayload): string | null =>
  finders.get(message)?.(data) ?? null;

// ── the boundary handlers sit behind ─────────────────────────────────────────

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
const newerServer = <F extends Pick<typeof UsersUpdated.fields, 'mode' | 'status'>>(fields: F) => ({
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
  'match-return-go': decoder(serverEvents['match-return-go']),
  'room-closed': decoder(serverEvents['room-closed']),
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
    /**
     * Whether a string a DataChannel delivered may be handled; one that may
     * not is dropped. Every string is checked: a control string is one
     * anchored pattern, so a check costs less than the handler's own parse.
     */
    peerText: (channel: PeerChannel | 'rom-transfer', text: string): boolean => {
      const verdict = checkPeerText(channel, text);
      if (verdict.issue === null) return true;
      drop(`dc ${verdict.kind}`, verdict.issue);
      return false;
    },
  };
};
