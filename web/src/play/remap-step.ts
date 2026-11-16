/**
 * What the remap wizard does with one input: take it and move on, finish,
 * ignore it, or reject it. The part of web/src/play/remap-wizard.ts that
 * decides; building the new mapping follows from the verdict.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** What a step asks for: a button, a stick direction, or a C button (either). */
export type StepKind = 'button' | 'axis' | 'cbutton';

/** What the player did. Back is not here: it returns to an earlier state. */
export type InputKind = 'button' | 'axis' | 'key' | 'skip';

/**
 * `advance`: taken, on to the next step. `done`: taken, and that was the
 * last step. `ignore`: nothing to do with it at this step. `wrongStick`: the
 * other direction of this stick was captured on a different axis.
 */
export type StepVerdict = 'advance' | 'done' | 'ignore' | 'wrongStick';

/**
 * `hasPad`: a gamepad profile is being edited (without one only keys are
 * remapped). `pairedAxis`: the pad axis this stick's other direction was
 * captured on, or -1. `inputAxis`: the pad axis pushed, for an axis input.
 */
//@ requires 0 <= step && step < stepCount
//@ ensures (input === "key" || input === "skip") ==> (\result === "advance" || \result === "done")
//@ ensures (input === "button" || input === "axis") && !hasPad ==> \result === "ignore"
//@ ensures input === "button" && stepKind === "axis" ==> \result === "ignore"
//@ ensures input === "axis" && stepKind === "button" ==> \result === "ignore"
//@ ensures \result === "wrongStick" ==> hasPad && input === "axis" && stepKind === "axis" && pairedAxis >= 0 && pairedAxis !== inputAxis
//@ ensures hasPad && input === "axis" && stepKind === "axis" && pairedAxis >= 0 && pairedAxis !== inputAxis ==> \result === "wrongStick"
//@ ensures \result === "done" ==> step === stepCount - 1
//@ ensures \result === "advance" ==> step < stepCount - 1
export function stepVerdict(
  stepKind: StepKind,
  input: InputKind,
  hasPad: boolean,
  pairedAxis: number,
  inputAxis: number,
  step: number,
  stepCount: number,
): StepVerdict {
  if (input === 'button') {
    if (!hasPad || stepKind === 'axis') return 'ignore';
  }
  if (input === 'axis') {
    if (!hasPad || stepKind === 'button') return 'ignore';
    if (stepKind === 'axis' && pairedAxis >= 0 && pairedAxis !== inputAxis) return 'wrongStick';
  }
  if (step === stepCount - 1) return 'done';
  return 'advance';
}

/** The step the wizard is on after a verdict: one further when the input was taken. */
//@ requires 0 <= step
//@ ensures (verdict === "advance" || verdict === "done") ==> \result === step + 1
//@ ensures (verdict === "ignore" || verdict === "wrongStick") ==> \result === step
export function stepAfter(step: number, verdict: StepVerdict): number {
  if (verdict === 'advance' || verdict === 'done') return step + 1;
  return step;
}
