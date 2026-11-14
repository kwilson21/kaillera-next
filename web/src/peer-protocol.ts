/**
 * Messages peers send each other: over the WebRTC DataChannels, and through
 * the Socket.IO events the server only forwards (`data-message`,
 * `webrtc-signal`, `rom-signal`).
 *
 * The server never builds these, so they have no Pydantic model: this file is
 * their one description. The engine and play.js still build and read them by
 * hand; `checkPeerText` and `checkRelay` say whether a message they received
 * matches, so production can show the descriptions are right before any
 * handler reads a decoded value (socket-boundary.ts reports the misses).
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
    // menu-ready:<frame>:<scene>
    'menu-ready': `:${INT}:${INT}`,
    resend: `:${INT}`,
    // A guest moved forward by a resync: its inputs before this frame are settled.
    'inputs-settled': `:${INT}`,
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
    'sync-request-full': '',
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
