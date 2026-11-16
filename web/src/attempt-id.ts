/**
 * Which connection attempt a WebRTC signal belongs to.
 *
 * Every `webrtc-signal` a page sends carries `attemptId` `{page, attempt}`:
 * the page's id, made once when it loads, and its count of the offers it has
 * made to that player. An offer carries its own; an answer and a candidate
 * the one of the offer their connection was made for. Pages from before it
 * send none. The rollback and streaming engines read it with
 * `readAttemptId` (window.KNCore.attemptId); the server relays it as it is
 * (specs/peer_connection.qnt, specs/streaming_connection.qnt).
 */
import { Option, Schema } from 'effect';
import type { Attempt } from './peer-connection.ts';
import type { WirePayload } from './wire.ts';

const AttemptId = Schema.Struct({
  page: Schema.String.check(Schema.isMinLength(1), Schema.isMaxCodePoints(64)),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeAttemptId = Schema.decodeUnknownOption(AttemptId);

/** The `attemptId` of a `webrtc-signal`, or null when it has none or one that is not well formed. */
export const readAttemptId = (value: WirePayload | undefined): Attempt | null => {
  const decoded = Option.getOrNull(decodeAttemptId(value));
  return decoded === null ? null : { page: decoded.page, attempt: decoded.attempt };
};

/** A new id for this page: random, made once when it loads. */
export const newPageId = (): string => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};
