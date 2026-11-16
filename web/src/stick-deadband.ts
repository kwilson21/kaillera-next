/**
 * The stick dead-band filter the engine calls with each frame's local input.
 * It keeps the state of the four stick axes and applies `stepAxis`
 * (stick-axis.ts, where the rule is described and verified) to each.
 */
import type { WireInput } from './input-wire.ts';
import { stepAxis, type AxisState } from './stick-axis.ts';

export interface StickDeadbandOptions {
  band?: number;
  settleFrames?: number;
}

/** The filter: call it with each frame's input; `reset` forgets everything held. */
export interface StickDeadband {
  <T extends WireInput>(input: T): T;
  reset: () => void;
}

const restingAxis = (): AxisState => ({ held: 0, cand: 0, count: 0 });

export function createStickDeadband(options: StickDeadbandOptions = {}): StickDeadband {
  const band = options.band ?? 2;
  const settleFrames = options.settleFrames ?? 4;
  let lx = restingAxis();
  let ly = restingAxis();
  let cx = restingAxis();
  let cy = restingAxis();
  const filter = <T extends WireInput>(input: T): T => {
    // `| 0` as the plain-JavaScript filter had it: a fractional or missing
    // axis is read as its integer part or 0.
    lx = stepAxis(lx, input.lx | 0, band, settleFrames);
    ly = stepAxis(ly, input.ly | 0, band, settleFrames);
    cx = stepAxis(cx, input.cx | 0, band, settleFrames);
    cy = stepAxis(cy, input.cy | 0, band, settleFrames);
    const out = { ...input };
    out.lx = lx.held;
    out.ly = ly.held;
    out.cx = cx.held;
    out.cy = cy.held;
    return out;
  };
  filter.reset = (): void => {
    lx = restingAxis();
    ly = restingAxis();
    cx = restingAxis();
    cy = restingAxis();
  };
  return filter;
}
