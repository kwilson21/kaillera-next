/**
 * The control remap wizard's rules: which input it asks for next, what a
 * captured button, stick or key does to the mapping, and how Back and Skip
 * move through it. Moved from web/static/play.js.
 *
 * Nothing here touches the page, the gamepad API or the clock: play.js polls
 * the pads, listens for keys, debounces, and shows the prompts. Every state
 * is a new value, so going back is just returning to an earlier one.
 */
import { stepAfter, stepVerdict } from './remap-step.ts';

/** One input the wizard asks for. `bit` is the N64 input bit it will drive. */
export type WizardStep =
  | { readonly prompt: string; readonly type: 'button' | 'cbutton'; readonly bit: number }
  | { readonly prompt: string; readonly type: 'axis'; readonly bit: number; readonly axisGroup: StickGroup };

type StickGroup = 'stickX' | 'stickY';

export const WIZARD_STEPS: readonly WizardStep[] = [
  { prompt: 'Press: A', type: 'button', bit: 0 },
  { prompt: 'Press: B', type: 'button', bit: 1 },
  { prompt: 'Press: Start', type: 'button', bit: 3 },
  { prompt: 'Press: Z', type: 'button', bit: 12 },
  { prompt: 'Press: L', type: 'button', bit: 10 },
  { prompt: 'Press: R', type: 'button', bit: 11 },
  { prompt: 'Press: D-Up', type: 'button', bit: 4 },
  { prompt: 'Press: D-Down', type: 'button', bit: 5 },
  { prompt: 'Press: D-Left', type: 'button', bit: 6 },
  { prompt: 'Press: D-Right', type: 'button', bit: 7 },
  { prompt: 'Push stick UP', type: 'axis', bit: 19, axisGroup: 'stickY' },
  { prompt: 'Push stick DOWN', type: 'axis', bit: 18, axisGroup: 'stickY' },
  { prompt: 'Push stick LEFT', type: 'axis', bit: 17, axisGroup: 'stickX' },
  { prompt: 'Push stick RIGHT', type: 'axis', bit: 16, axisGroup: 'stickX' },
  { prompt: 'Press: C-Up', type: 'cbutton', bit: 23 },
  { prompt: 'Press: C-Down', type: 'cbutton', bit: 22 },
  { prompt: 'Press: C-Left', type: 'cbutton', bit: 20 },
  { prompt: 'Press: C-Right', type: 'cbutton', bit: 21 },
];

/** Keyboard key code to N64 input bit. */
export type KeyMap = Readonly<Record<number, number>>;

/** The keys a player with no saved mapping starts from. */
export const DEFAULT_KEY_MAP = {
  67: 0,
  88: 1,
  86: 3,
  38: 4,
  40: 5,
  37: 6,
  39: 7,
  84: 10,
  89: 11,
  90: 12,
  68: 16,
  65: 17,
  83: 18,
  87: 19,
  74: 20,
  76: 21,
  75: 22,
  73: 23,
} satisfies KeyMap;

type StickAxis = { readonly index: number; readonly bits: readonly [number, number] };
type AxisButtons = { readonly pos: number; readonly neg: number };

/** A gamepad profile as GamepadManager stores and reads it. */
export type PadProfile = {
  readonly name: string;
  /** Pad button index to an N64 input mask. */
  readonly buttons: Readonly<Record<number, number>>;
  readonly axes: Readonly<Record<string, StickAxis>>;
  /** Pad axis index to the masks its two directions press (the C buttons). */
  readonly axisButtons?: Readonly<Record<number, AxisButtons>>;
  readonly axisRange?: number | undefined;
  readonly axisCenter?: string | undefined;
  readonly deadzone?: number | undefined;
};

/** The profile the wizard edits: a copy of the current one, named Custom. */
export const customProfileFrom = (current: PadProfile): PadProfile => ({
  name: 'Custom',
  buttons: { ...current.buttons },
  axes: structuredClone(current.axes),
  axisButtons: structuredClone(current.axisButtons ?? {}),
  axisRange: current.axisRange,
  axisCenter: current.axisCenter,
  deadzone: current.deadzone || 0.3,
});

/** One stick axis while its two directions are being captured. */
type AxisCapture = { readonly index: number; readonly posBit?: number; readonly negBit?: number };

/** Where the wizard is. */
export type WizardState = {
  readonly step: number;
  /** Null when no gamepad is connected: only keys are remapped. */
  readonly profile: PadProfile | null;
  readonly keyMap: KeyMap;
  readonly axisCaptures: Readonly<Partial<Record<StickGroup, AxisCapture>>>;
  /** The states Back returns to, oldest first. */
  readonly history: readonly WizardState[];
};

/** The wizard at its first step. An empty saved key map means none was saved. */
export const startWizardState = (profile: PadProfile | null, savedKeyMap: KeyMap | null): WizardState => ({
  step: 0,
  profile,
  keyMap: savedKeyMap !== null && Object.keys(savedKeyMap).length > 0 ? { ...savedKeyMap } : { ...DEFAULT_KEY_MAP },
  axisCaptures: {},
  history: [],
});

/** Something the player did. */
export type WizardInput =
  | { readonly kind: 'button'; readonly index: number }
  | { readonly kind: 'axis'; readonly index: number; readonly positive: boolean }
  | { readonly kind: 'key'; readonly keyCode: number }
  | { readonly kind: 'skip' }
  | { readonly kind: 'back' };

/**
 * What the input did. `advanced`: on to the next step. `done`: that was the
 * last step. `ignored`: nothing to do with it here. `wrong-stick`: the other
 * direction of this stick was captured on a different axis; `pairName` is the
 * direction to match.
 */
export type WizardOutcome =
  | { readonly state: WizardState; readonly result: 'advanced' | 'done' | 'ignored' }
  | { readonly state: WizardState; readonly result: 'wrong-stick'; readonly pairName: 'UP' | 'LEFT' };

/** Move on from `state` with these changes, remembering `state` for Back. */
const taken = (state: WizardState, verdict: 'advance' | 'done', changes: Partial<WizardState>): WizardOutcome => ({
  state: { ...state, ...changes, step: stepAfter(state.step, verdict), history: [...state.history, state] },
  result: verdict === 'done' ? 'done' : 'advanced',
});

/** The mapping after a taken input. The verdict has already ruled out every input that does not fit the step. */
const changesFor = (state: WizardState, step: WizardStep, input: TakenInput): Partial<WizardState> => {
  if (input.kind === 'skip') return {};
  // A key drives one input: binding it here takes it from wherever it was.
  if (input.kind === 'key') return { keyMap: { ...state.keyMap, [input.keyCode]: step.bit } };
  const profile = state.profile;
  if (profile === null) return {};
  if (input.kind === 'button') {
    return { profile: { ...profile, buttons: { ...profile.buttons, [input.index]: 1 << step.bit } } };
  }
  if (step.type === 'axis') {
    const direction = input.positive ? { posBit: step.bit } : { negBit: step.bit };
    const captured = state.axisCaptures[step.axisGroup];
    return {
      axisCaptures: { ...state.axisCaptures, [step.axisGroup]: { ...captured, index: input.index, ...direction } },
    };
  }
  const masks = profile.axisButtons?.[input.index] ?? { pos: 0, neg: 0 };
  const bit = 1 << step.bit;
  const pressed = input.positive ? { ...masks, pos: masks.pos | bit } : { ...masks, neg: masks.neg | bit };
  return { profile: { ...profile, axisButtons: { ...profile.axisButtons, [input.index]: pressed } } };
};

type TakenInput = Exclude<WizardInput, { readonly kind: 'back' }>;

/** Apply one input to the wizard. Whether it is taken is decided by `stepVerdict` (remap-step.ts). */
export const wizardInput = (state: WizardState, input: WizardInput): WizardOutcome => {
  if (input.kind === 'back') {
    const previous = state.history.at(-1);
    return previous === undefined || state.step === 0
      ? { state, result: 'ignored' }
      : { state: previous, result: 'advanced' };
  }
  const step = WIZARD_STEPS[state.step];
  if (step === undefined) return { state, result: 'ignored' };
  const pairedAxis = step.type === 'axis' ? (state.axisCaptures[step.axisGroup]?.index ?? -1) : -1;
  const verdict = stepVerdict(
    step.type,
    input.kind,
    state.profile !== null,
    pairedAxis,
    input.kind === 'axis' ? input.index : -1,
    state.step,
    WIZARD_STEPS.length,
  );
  if (verdict === 'ignore') return { state, result: 'ignored' };
  if (verdict === 'wrongStick') {
    return {
      state,
      result: 'wrong-stick',
      pairName: step.type === 'axis' && step.axisGroup === 'stickX' ? 'LEFT' : 'UP',
    };
  }
  return taken(state, verdict, changesFor(state, step, input));
};

/**
 * What play.js's own wizard holds, laid out the same way, so the two can be
 * compared after every input while play.js is still in charge.
 */
export const comparable = (state: WizardState) => ({
  step: state.step,
  keyMap: state.keyMap,
  buttons: state.profile?.buttons ?? null,
  axisButtons: state.profile?.axisButtons ?? null,
  axisCaptures: state.axisCaptures,
});

/**
 * The profile to save: the edited one, with each stick whose two directions
 * were both captured. Null when there was no gamepad.
 */
export const finishedProfile = (state: WizardState): PadProfile | null => {
  if (state.profile === null) return null;
  const captured = Object.entries(state.axisCaptures).flatMap(([group, capture]) =>
    capture.posBit !== undefined && capture.negBit !== undefined
      ? [[group, { index: capture.index, bits: [capture.posBit, capture.negBit] }] as const]
      : [],
  );
  return { ...state.profile, axes: { ...state.profile.axes, ...Object.fromEntries(captured) } };
};

/** What the wizard shows at this step. */
export const wizardPrompt = (state: WizardState) => ({
  prompt: `${WIZARD_STEPS[state.step]?.prompt ?? ''} (gamepad or key)`,
  progress: `(${state.step + 1}/${WIZARD_STEPS.length})`,
  canGoBack: state.step > 0,
});
