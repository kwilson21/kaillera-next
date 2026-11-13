/**
 * The socket boundary, observing: every message the server authors is decoded
 * against the schema generated from the server's own models
 * (protocol.gen.ts), and a message that does not match is reported once.
 *
 * Nothing here changes what the page does with a message. The page's handlers
 * still run on the raw payload; this only shows, from production, whether the
 * schemas and the server agree, before any handler is made to depend on a
 * decoded value.
 */
import { Result, Schema } from 'effect';
import { JoinRoomAck, serverEvents, SessionLogAck } from './protocol.ts';

/** Acks the server builds itself, by the event they answer. */
const serverAcks = {
  'join-room': JoinRoomAck,
  'session-log': SessionLogAck,
} as const;

/** Anything a Socket.IO message can carry: it arrives as parsed JSON. */
export type WirePayload =
  | null
  | undefined
  | boolean
  | number
  | string
  | readonly WirePayload[]
  | { readonly [key: string]: WirePayload };

const ISSUE_MAX = 240;

/** For one schema: what is wrong with a payload, or null. Names a path, never a value. */
const issueFinder = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (data: WirePayload): string | null => {
    const result = decode(data);
    return Result.isFailure(result) ? result.failure.message.slice(0, ISSUE_MAX) : null;
  };
};

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

/** Reports a page may send in one session: a server that is wrong is wrong on every message. */
export const REPORT_LIMIT = 20;

/**
 * Watch a socket's incoming events. `sink` returns false while it cannot take
 * a report yet (the page has no upload token until the server sends one); the
 * report is then held and offered again after the next event's handlers ran.
 */
export const createProtocolObserver = (sink: (report: ProtocolReport) => boolean) => {
  const seen = new Set<string>();
  const held: ProtocolReport[] = [];
  let sent = 0;

  const flush = (): void => {
    while (held.length > 0 && sent < REPORT_LIMIT) {
      const next = held[0];
      if (next === undefined || !sink(next)) return;
      held.shift();
      sent += 1;
    }
  };

  /** Check one message; a new kind of mismatch is reported, a repeat is not. */
  const check = (message: string, data: WirePayload): boolean => {
    const issue = checkServerMessage(message, data);
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

  return {
    check,
    /** Check the data half of an ack the server built (`join-room`, `session-log`). */
    checkAck: (event: keyof typeof serverAcks, data: WirePayload): boolean => check(`${event} ack`, data),
    /** Check every event the socket receives from now on. */
    observe: (socket: AnySocket): void => {
      socket.onAny((event, data) => {
        check(event, data);
        // Socket.IO calls this before the event's own handlers, and the
        // upload-token handler is what lets the sink take reports.
        queueMicrotask(flush);
      });
    },
    flush,
  };
};
