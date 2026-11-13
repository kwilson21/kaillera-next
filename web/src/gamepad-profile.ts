/**
 * A gamepad profile the player saved from the remap wizard or the
 * controller settings panel: which pad button is which N64 button, and how
 * the pad's axes are read. web/static/gamepad-manager.js keeps one per pad
 * id in localStorage and reads it back when the pad connects.
 *
 * What comes back from storage is whatever is there: an older build's
 * layout, a hand-edited value, a truncated write. It is decoded here before
 * it is used. One that does not fit is ignored and the pad gets its built-in
 * profile, where before a profile without `buttons` threw on every read of
 * the pad. Keys this version does not know are left out.
 */
import { flow, Option, Schema } from 'effect';

/** A missing value, or the null that JSON writes for one that was not a number. */
const maybe = <S extends Schema.Constraint>(schema: S) => Schema.optional(Schema.NullOr(schema));

const PAD_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Every key is a pad button or axis index: a non-negative whole number. The
 * pad's arrays are indexed with it, and an index below zero has no entry.
 * A record with any other key is refused whole; dropping the one entry would
 * leave a mapping the player did not make.
 */
const padIndexKeys = Schema.makeFilter((record: { readonly [key: string]: object | number }) =>
  Object.keys(record).every((key) => PAD_INDEX.test(key)),
);

/** One stick axis: the pad axis it reads and the N64 bit each end means. */
const StickAxis = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bits: maybe(Schema.Array(Schema.Int)),
});

/** A pad axis that acts as two buttons: the N64 mask each end presses. */
const AxisButton = Schema.Struct({
  pos: Schema.Int,
  neg: Schema.Int,
});

export const GamepadProfile = Schema.Struct({
  name: maybe(Schema.String),
  /** Pad button index to N64 button mask. */
  buttons: Schema.Record(Schema.String, Schema.Int).check(padIndexKeys),
  axes: maybe(Schema.Struct({ stickX: maybe(StickAxis), stickY: maybe(StickAxis) })),
  /** Pad axis index to the two masks it presses. */
  axisButtons: maybe(Schema.Record(Schema.String, AxisButton).check(padIndexKeys)),
  /** The raw axis value of full deflection. */
  axisRange: maybe(Schema.Finite.check(Schema.isGreaterThan(0))),
  axisCenter: maybe(Schema.Literal('auto')),
  deadzone: maybe(Schema.Finite),
});
export type GamepadProfile = typeof GamepadProfile.Type;

/** The profile in a value read from storage, or null if it is not one. */
export const decodeGamepadProfile = flow(Schema.decodeUnknownOption(GamepadProfile), Option.getOrNull);
