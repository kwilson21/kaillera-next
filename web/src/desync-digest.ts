/**
 * The desync digest one peer sends another over the DataChannel: one hash
 * per game-state field for one frame, plus what the sender's last rollback
 * replay looked like. web/static/kn-desync-detector.js builds and compares
 * them; which fields get flagged is decided in desync-fields.ts.
 *
 * A digest arrives as JSON from another player's browser, so it is decoded
 * here before the detector reads it. One that does not fit is dropped: the
 * comparison indexes `hashes` by field id and the replay data is forwarded
 * to the server with a desync report, so neither may be whatever a peer
 * chose to send.
 */
import { flow, Option, Schema } from 'effect';
import { FIELD_COUNT } from './desync-fields.ts';

/** One hash per field id; at least `FIELD_COUNT` of them. */
const FieldHashes = Schema.Array(Schema.Finite).check(Schema.isMinLength(FIELD_COUNT));

/** The first frame of a replay where a field differed from the forward pass. */
const TrajectoryDivergence = Schema.Struct({
  offset: Schema.Int,
  absoluteFrame: Schema.Int,
  fieldId: Schema.Int,
  field: Schema.String,
  slot: Schema.NullOr(Schema.Int),
  replayHash: Schema.Finite,
  forwardHash: Schema.Finite,
});

/** The sender's last rollback replay: where it ran and the field hashes around it. */
const ReplayMeta = Schema.Struct({
  target: Schema.Int,
  final: Schema.Int,
  length: Schema.Int,
  pre: Schema.Array(Schema.Finite),
  post: Schema.Array(Schema.Finite),
  firstTrajectoryDivergence: Schema.NullOr(TrajectoryDivergence),
});

export const DesyncDigest = Schema.Struct({
  frame: Schema.Int,
  hashes: FieldHashes,
  replayMeta: Schema.optional(Schema.NullOr(ReplayMeta)),
});
export type DesyncDigest = typeof DesyncDigest.Type;

/** The digest in a received message, or null if the message is not one. */
export const decodeDesyncDigest = flow(Schema.decodeUnknownOption(DesyncDigest), Option.getOrNull);
