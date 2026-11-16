/**
 * Messages peers send each other: over the WebRTC DataChannels, and through
 * the Socket.IO events the server only forwards (`data-message`,
 * `webrtc-signal`, `rom-signal`).
 *
 * The server never builds these, so they have no Pydantic model: this file is
 * their one description. `checkPeerText` and `checkRelay` say whether a
 * message matches, and handlers get only the messages that do
 * (socket-boundary.ts `createBoundary` drops the rest): play.js's relays and
 * ROM transfer strings, and the rollback engine's `lockstep` and `sync-state`
 * channel strings.
 *
 * A page loaded before a deploy can share a match with one loaded after it (a
 * late joiner, a reload), so what a page drops is part of the protocol:
 * - A JSON message may carry fields its schema does not name. They are not
 *   checked, and the handler reads the message as it was sent, so a newer
 *   page may add a field to a JSON message and an older page still reads it.
 * - A control string must match its pattern whole. Several handlers read
 *   everything after the prefix, and would misread a longer string, so a
 *   newer page that needs a new field sends it as a message of its own
 *   beside the old one, as `sync-request-id` and `sync-answer-id` do.
 * - A kind this page does not know, a control string or a JSON `type`, is
 *   dropped and logged once. The handlers had nothing to do with one either.
 *   A kind a current page no longer sends stays here while an older page
 *   might still send it ("Read but no longer sent").
 *
 * The per-frame input packet is binary and has its own codec, input-wire.ts.
 */
import { Result, Schema } from 'effect';
import { GameMode, RenegotiateRequest } from './protocol.ts';
import { issueFinder, type WirePayload } from './wire.ts';

// ── control strings ─────────────────────────────────────────────────────────

const INT = String.raw`-?\d+`;
const HEX = '[0-9a-f]';

/**
 * The colon-separated control strings, by channel and prefix. Each pattern is
 * the whole message after the prefix; a bare word has an empty one.
 */
const TEXT_GRAMMAR = {
  lockstep: {
    ready: '',
    'emu-ready': '',
    'late-join-pause': '',
    'late-join-resume': '',
    'late-join-ready': '',
    // A waiting late joiner says so on its own channels; the host answers a
    // too-early state request by letting it into the start (#125).
    'late-joiner': '',
    'join-the-start': '',
    leaving: '',
    'peer-resumed': '',
    // roster:<frame>:<slot>,<slot>,...   (no slots: the part after the colon is empty)
    roster: `:${INT}:(?:\\d+(?:,\\d+)*)?`,
    // left-out:<slot>  the host left that player out of the start; it joins late (specs/start_group.qnt)
    'left-out': ':\\d+',
    // menu-ready:<frame>:<scene>
    'menu-ready': `:${INT}:${INT}`,
    resend: `:${INT}`,
    // A guest moved forward by a resync: its inputs before this frame are settled.
    'inputs-settled': `:${INT}`,
    // dropped:<reason>  the host dropped this player from the match (desync:
    // its pushes went unanswered; host: any other drop); taken only from the
    // host (specs/drop_is_final.qnt).
    dropped: ':(?:desync|host)',
    // rb-check:<frame>:<gameplay hash>[:<game state hash>]
    'rb-check': `:${INT}:${INT}(?::${INT})?`,
    // rb-blocks:<frame>:<8 hex digits per block, no separator>
    'rb-blocks': `:${INT}:(?:${HEX}{8})*`,
    // rb-regions:<frame>:<hex>,<hex>,...
    'rb-regions': `:${INT}:(?:${HEX}+(?:,${HEX}+)*)?`,
    // rb-subhash:<frame>:<region>:<hex>,<hex>,...
    'rb-subhash': `:${INT}:${INT}:(?:${HEX}+(?:,${HEX}+)*)?`,
    'rb-delay': `:${INT}`,
    'rb-transport': ':(?:reliable|unreliable)',
    'rb-init-frame': `:${INT}`,
    // fpu-trace:<frame>:<hash>:<count>
    'fpu-trace': `:${INT}:${INT}:${INT}`,
    'sync-request-full': '',
    'sync-request-full-at': `:${INT}`,
    // The number of the request that follows on the same channel. A message
    // of its own, so a host that does not know it still reads the request.
    'sync-request-id': ':\\d+',
    // Read but no longer sent by a current page.
    // phase:<frame>:<scene>:<game status>
    phase: `:${INT}:${INT}:${INT}`,
    'sync-hash': `:${INT}:${INT}`,
    'sync-request': '',
    'sync-request-regions': '',
    'sync-request-at': `:${INT}`,
  },
  'sync-state': {
    // sync-start:<frame>:<chunks>:<full 0|1>:<proactive 0|1>
    'sync-start': `:${INT}:\\d+:[01]:[01]`,
    'sync-regions-start': `:${INT}:\\d+`,
    // The request the state that follows on the same channel answers; a state
    // the host sent for its own reasons has none.
    'sync-answer-id': ':\\d+',
    'sync-request-full': '',
    'sync-request-id': ':\\d+',
  },
} as const;

export type PeerChannel = keyof typeof TEXT_GRAMMAR;

const compiled = new Map<string, RegExp>();
for (const [channel, grammar] of Object.entries(TEXT_GRAMMAR)) {
  for (const [kind, rest] of Object.entries(grammar))
    compiled.set(`${channel} ${kind}`, new RegExp(`^${kind}${rest}$`));
}

/** `rb-check:1:2:3` is of kind `rb-check`; `ready` of kind `ready`. */
export const textKind = (text: string): string => {
  const colon = text.indexOf(':');
  return colon < 0 ? text : text.slice(0, colon);
};

// ── JSON messages on a DataChannel ──────────────────────────────────────────

const DelayProbe = Schema.Struct({ ts: Schema.Number });

const LockstepReady = Schema.Struct({
  delay: Schema.Number,
  extraDelay: Schema.optional(Schema.Number),
  caps: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const Digest = Schema.Struct({
  frame: Schema.Number,
  hashes: Schema.Array(Schema.Number),
  replayMeta: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});

const Empty = Schema.Struct({});

const RomResume = Schema.Struct({ offset: Schema.Number });

const RomHeader = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  hash: Schema.optional(Schema.NullOr(Schema.String)),
});

// ── data-message: relayed by the server, built by a peer ────────────────────

const Encoded = Schema.String;
const Sidecar = Schema.optional(Schema.NullOr(Schema.Unknown));

const SaveState = Schema.Struct({
  frame: Schema.Number,
  data: Encoded,
  stateFormat: Schema.optional(Schema.String),
  sourceRuntimeFamily: Schema.optional(Schema.String),
  saveRam: Schema.optional(Schema.NullOr(Encoded)),
  hiddenWords: Sidecar,
  audioFifo: Sidecar,
});

const LateJoinState = Schema.Struct({
  targetSid: Schema.String,
  frame: Schema.Number,
  data: Encoded,
  effectiveDelay: Schema.optional(Schema.Number),
  rbTransport: Schema.optional(Schema.String),
  rngValues: Sidecar,
  saveRam: Schema.optional(Schema.NullOr(Encoded)),
  hiddenWords: Sidecar,
  audioFifo: Sidecar,
});

const SyncStateSocket = Schema.Struct({
  targetSid: Schema.String,
  senderSid: Schema.String,
  frame: Schema.Number,
  full: Schema.Boolean,
  proactive: Schema.Boolean,
  reason: Schema.String,
  rawSize: Schema.Number,
  compressedSize: Schema.Number,
  data: Encoded,
  // The request this state answers; absent when it answers none.
  requestId: Schema.optional(Schema.Number),
});

/** JSON messages by where they travel and their `type`. */
const JSON_MESSAGES = {
  lockstep: {
    'delay-ping': DelayProbe,
    'delay-pong': DelayProbe,
    'lockstep-ready': LockstepReady,
    digest: Digest,
    'rom-accepted': Empty,
    // Sent over Socket.IO today; the channel still reads them.
    'save-state': SaveState,
    'late-join-state': LateJoinState,
  },
  'rom-transfer': {
    'rom-resume': RomResume,
    'rom-header': RomHeader,
    'rom-complete': Empty,
  },
  'data-message': {
    'mode-select': Schema.Struct({ mode: GameMode }),
    'rom-accepted': Schema.Struct({ sender: Schema.String }),
    'save-state': SaveState,
    'late-join-state': LateJoinState,
    'request-late-join': Schema.Struct({ requesterSid: Schema.String }),
    'sync-request-full-socket': Schema.Struct({
      targetSid: Schema.String,
      requesterSid: Schema.String,
      reason: Schema.String,
      frame: Schema.Number,
      // The request's number; absent from a page that does not number them.
      requestId: Schema.optional(Schema.Number),
    }),
    'sync-state-socket': SyncStateSocket,
    'late-join-ready': Schema.Struct({ senderSid: Schema.String }),
    'streaming-late-join-ready': Schema.Struct({ senderSid: Schema.String, isSpectator: Schema.Boolean }),
  },
} as const;

export type JsonRoute = keyof typeof JSON_MESSAGES;

const jsonFinders = new Map<string, (data: WirePayload) => string | null>();
for (const [route, messages] of Object.entries(JSON_MESSAGES)) {
  for (const [type, schema] of Object.entries(messages)) jsonFinders.set(`${route} ${type}`, issueFinder(schema));
}

/** One peer message, named for a report: where it travelled and what kind it is. */
export type PeerVerdict = {
  /** `lockstep rb-check`, `data-message save-state`, ... */
  readonly kind: string;
  /** What is wrong, or null. Names the kind or a path, never a value. */
  readonly issue: string | null;
};

const decodeTyped = Schema.decodeUnknownResult(Schema.Struct({ type: Schema.String }));

const typeOf = (message: WirePayload): string | null => {
  const typed = decodeTyped(message);
  return Result.isSuccess(typed) ? typed.success.type : null;
};

/** A parsed JSON message that travelled on `route`. */
export const checkPeerJson = (route: JsonRoute, message: WirePayload): PeerVerdict => {
  const type = typeOf(message);
  if (type === null) return { kind: `${route} (no type)`, issue: 'Expected an object with a string "type"' };
  const find = jsonFinders.get(`${route} ${type}`);
  // The type came off the wire: it names the report only when it is a known one.
  if (find === undefined) return { kind: `${route} (unknown type)`, issue: 'Unknown message type' };
  return { kind: `${route} ${type}`, issue: find(message) };
};

/** A string a DataChannel delivered: a control string, or JSON text. */
export const checkPeerText = (channel: PeerChannel | 'rom-transfer', text: string): PeerVerdict => {
  if (text.startsWith('{')) {
    if (channel === 'sync-state') return { kind: `${channel} (json)`, issue: 'This channel carries no JSON' };
    let message: WirePayload;
    try {
      message = JSON.parse(text);
    } catch {
      return { kind: `${channel} (json)`, issue: 'Not valid JSON' };
    }
    return checkPeerJson(channel, message);
  }
  if (channel === 'rom-transfer') return { kind: `${channel} (text)`, issue: 'This channel carries only JSON text' };
  const pattern = compiled.get(`${channel} ${textKind(text)}`);
  if (pattern === undefined) return { kind: `${channel} (unknown)`, issue: 'Unknown control string' };
  const kind = `${channel} ${textKind(text)}`;
  return { kind, issue: pattern.test(text) ? null : `Does not match ${pattern.source}` };
};

// ── webrtc-signal and rom-signal: rebuilt by the server from a peer's keys ───

const SessionDescription = Schema.Struct({ type: Schema.String, sdp: Schema.optional(Schema.String) });

const SignalRelay = Schema.Struct({
  sender: Schema.String,
  target: Schema.String,
  offer: Schema.optional(SessionDescription),
  answer: Schema.optional(SessionDescription),
  // An ICE candidate object, or null for end-of-candidates.
  candidate: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  reconnect: Schema.optional(Schema.Boolean),
  // A reconnect offer that is a startup retry, from a page whose game has not started.
  startupReconnect: Schema.optional(Schema.Boolean),
  // Which attempt the signal belongs to: the page that made the offer and that
  // page's count of its offers (attempt-id.ts). Pages from before it send none.
  attemptId: Schema.optional(Schema.Struct({ page: Schema.String, attempt: Schema.Number })),
});

const signalRelayIssue = issueFinder(SignalRelay);
const renegotiateIssue = issueFinder(RenegotiateRequest);
const senderIssue = issueFinder(Schema.Struct({ sender: Schema.String }));

/**
 * A relayed Socket.IO event. Null for an event that is not a relay.
 * `webrtc-signal` is also the one event the server sends for itself (to a new
 * room owner), which carries no `sender`.
 */
export const checkRelay = (event: string, data: WirePayload): PeerVerdict | null => {
  if (event === 'data-message') return checkPeerJson('data-message', data);
  if (event === 'rom-signal') return { kind: event, issue: signalRelayIssue(data) };
  if (event === 'webrtc-signal') {
    // A peer may relay `requestRenegotiate` too, and the server adds `sender`
    // to everything it relays: only a message without one is the server's own.
    const fromServer = senderIssue(data) !== null && renegotiateIssue(data) === null;
    return fromServer
      ? { kind: `${event} (renegotiate)`, issue: null }
      : { kind: event, issue: signalRelayIssue(data) };
  }
  return null;
};
