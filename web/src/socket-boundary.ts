/**
 * The socket boundary, observing: every message the server authors is decoded
 * against the schema generated from the server's own models
 * (protocol.gen.ts), every message a peer authors against peer-protocol.ts,
 * and a message that does not match is reported once.
 *
 * Nothing here changes what the page does with a message. The page's handlers
 * still run on the raw payload; this only shows, from production, whether the
 * schemas and the server agree, before any handler is made to depend on a
 * decoded value.
 */
import { checkPeerText, checkRelay, type PeerChannel, textKind } from './peer-protocol.ts';
import { JoinRoomAck, serverEvents, SessionLogAck } from './protocol.ts';
import { issueFinder, type WirePayload } from './wire.ts';

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
