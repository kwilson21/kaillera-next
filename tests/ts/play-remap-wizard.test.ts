import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  comparable,
  customProfileFrom,
  DEFAULT_KEY_MAP,
  finishedProfile,
  startWizardState,
  WIZARD_STEPS,
  wizardInput,
  wizardPrompt,
  type PadProfile,
  type WizardInput,
  type WizardState,
} from '../../web/src/play/remap-wizard.ts';

// ── the code this module replaced, kept as an oracle ─────────────────────────
// web/static/play.js as of #139: one mutable wizard, with the page, the clock
// and the pad polling taken out. `keepRejectedSnapshot` is the one thing the
// new code does differently on purpose (see the wrong-stick test below).

type OldCapture = { index?: number; posBit?: number; negBit?: number };
type OldProfile = {
  name: string;
  buttons: Record<number, number>;
  axes: Record<string, { index: number; bits: readonly number[] }>;
  axisButtons: Record<number, { pos: number; neg: number }>;
  axisRange?: number | undefined;
  axisCenter?: string | undefined;
  deadzone: number;
};
type OldSnapshot = {
  gamepadProfile: OldProfile | null;
  keyMap: Record<number, number>;
  axisCaptures: Record<string, OldCapture>;
};

// SAFETY: JSON.parse of a JSON.stringify of a T is a T for the plain data used here.
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const oldWizard = (
  current: PadProfile | null,
  savedKeyMap: Record<number, number> | null,
  keepRejectedSnapshot: boolean,
) => {
  let profile: OldProfile | null =
    current === null
      ? null
      : {
          name: 'Custom',
          buttons: { ...current.buttons },
          axes: jsonCopy(current.axes),
          axisButtons: jsonCopy(current.axisButtons ?? {}),
          axisRange: current.axisRange,
          axisCenter: current.axisCenter,
          deadzone: current.deadzone || 0.3,
        };
  let keyMap: Record<number, number> =
    savedKeyMap && Object.keys(savedKeyMap).length > 0 ? { ...savedKeyMap } : { ...DEFAULT_KEY_MAP };
  let axisCaptures: Record<string, OldCapture> = {};
  let snapshots: OldSnapshot[] = [];
  let step = 0;
  let saved = false;

  const saveSnapshot = () => {
    snapshots.push({
      gamepadProfile: profile ? jsonCopy(profile) : null,
      keyMap: { ...keyMap },
      axisCaptures: jsonCopy(axisCaptures),
    });
  };
  const advance = () => {
    step++;
    if (step >= WIZARD_STEPS.length) saved = true;
  };

  const apply = (input: WizardInput) => {
    if (saved) return;
    const at = WIZARD_STEPS[step];
    assert.ok(at);
    if (input.kind === 'back') {
      if (step === 0 || snapshots.length === 0) return;
      const snap = snapshots.pop();
      assert.ok(snap);
      step--;
      profile = snap.gamepadProfile;
      keyMap = snap.keyMap;
      axisCaptures = snap.axisCaptures;
    } else if (input.kind === 'skip') {
      saveSnapshot();
      advance();
    } else if (input.kind === 'key') {
      saveSnapshot();
      for (const k in keyMap) if (parseInt(k, 10) === input.keyCode) delete keyMap[k];
      keyMap[input.keyCode] = at.bit;
      advance();
    } else if (input.kind === 'button') {
      // The poll only looked at buttons on button and cbutton steps.
      if (at.type === 'axis' || !profile) return;
      saveSnapshot();
      profile.buttons[input.index] = 1 << at.bit;
      advance();
    } else {
      // The poll only looked at axes on axis and cbutton steps.
      if (at.type === 'button' || !profile) return;
      saveSnapshot();
      if (at.type === 'axis') {
        const cap = (axisCaptures[at.axisGroup] ??= {});
        if (cap.index !== undefined && cap.index !== input.index) {
          if (!keepRejectedSnapshot) snapshots.pop();
          return;
        }
        cap.index = input.index;
        if (input.positive) cap.posBit = at.bit;
        else cap.negBit = at.bit;
        advance();
      } else {
        const masks = (profile.axisButtons[input.index] ??= { pos: 0, neg: 0 });
        if (input.positive) masks.pos |= 1 << at.bit;
        else masks.neg |= 1 << at.bit;
        advance();
      }
    }
  };

  /** What saveWizard handed to GamepadManager and to storage. */
  const result = () => {
    const out = profile ? jsonCopy(profile) : null;
    if (out) {
      for (const [group, cap] of Object.entries(axisCaptures)) {
        if (cap.index !== undefined && cap.posBit !== undefined && cap.negBit !== undefined) {
          out.axes[group] = { index: cap.index, bits: [cap.posBit, cap.negBit] };
        }
      }
    }
    return { step, saved, profile: out, keyMap: jsonCopy(keyMap) };
  };
  /** What play.js hands the observer after each input (wizardShadowCompare). */
  const view = () =>
    JSON.stringify({
      step,
      keyMap,
      buttons: profile?.buttons ?? null,
      axisButtons: profile?.axisButtons ?? null,
      axisCaptures,
    });
  return { apply, result, view };
};

const PAD: PadProfile = {
  name: 'Standard',
  buttons: { 0: 1 << 0, 2: 1 << 1, 9: 1 << 3, 6: 1 << 12 },
  axes: { stickX: { index: 0, bits: [16, 17] }, stickY: { index: 1, bits: [18, 19] } },
  axisButtons: { 2: { pos: 1 << 21, neg: 1 << 20 }, 3: { pos: 1 << 22, neg: 1 << 23 } },
  axisRange: 1,
  deadzone: 0.25,
};

/** The new wizard driven the way play.js drives it, reported like the oracle. */
const newWizard = (current: PadProfile | null, savedKeyMap: Record<number, number> | null) => {
  let state: WizardState = startWizardState(current === null ? null : customProfileFrom(current), savedKeyMap);
  let saved = false;
  const apply = (input: WizardInput) => {
    if (saved) return;
    const outcome = wizardInput(state, input);
    state = outcome.state;
    if (outcome.result === 'done') saved = true;
    return outcome;
  };
  const result = () => ({
    step: state.step,
    saved,
    profile: jsonCopy(finishedProfile(state)),
    keyMap: jsonCopy(state.keyMap),
  });
  const view = () => JSON.stringify(comparable(state));
  return { apply, result, view };
};

// A small fixed-seed generator, so a failure names a sequence that can be rerun.
const rng = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const randomInput = (next: () => number): WizardInput => {
  const roll = next();
  if (roll < 0.1) return { kind: 'back' };
  if (roll < 0.2) return { kind: 'skip' };
  if (roll < 0.45) return { kind: 'key', keyCode: [65, 67, 73, 90, 13, 32][Math.floor(next() * 6)] ?? 65 };
  if (roll < 0.7) return { kind: 'button', index: Math.floor(next() * 6) };
  return { kind: 'axis', index: Math.floor(next() * 3), positive: next() < 0.5 };
};

test('agrees with the code it replaced over random sessions', () => {
  let compared = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const next = rng(seed);
    const pad = seed % 4 === 0 ? null : PAD;
    const keys = seed % 3 === 0 ? { 13: 3, 32: 0 } : seed % 3 === 1 ? {} : null;
    const before = jsonCopy({ pad, keys });
    const old = oldWizard(pad, keys, false);
    const now = newWizard(pad, keys);
    for (let i = 0; i < 60; i++) {
      const input = randomInput(next);
      old.apply(input);
      now.apply(input);
      assert.deepEqual(now.result(), old.result(), `seed ${seed}, input ${i}: ${JSON.stringify(input)}`);
      // The observer in play.js compares these two strings: equal here means no report there.
      assert.equal(now.view(), old.view(), `seed ${seed}, input ${i}: ${JSON.stringify(input)}`);
      compared++;
    }
    assert.deepEqual({ pad, keys }, before, "the caller's profile and key map are not modified");
  }
  assert.ok(compared > 20_000);
});

const press = (state: WizardState, ...inputs: WizardInput[]): WizardState =>
  inputs.reduce((s, input) => wizardInput(s, input).state, state);

const skipTo = (state: WizardState, step: number): WizardState => {
  let s = state;
  while (s.step < step) s = wizardInput(s, { kind: 'skip' }).state;
  return s;
};

const start = () => startWizardState(customProfileFrom(PAD), null);

test('a stick direction on the wrong axis is rejected and leaves Back where it was', () => {
  const upStep = WIZARD_STEPS.findIndex((s) => s.prompt === 'Push stick UP');
  const atDown = press(skipTo(start(), upStep), { kind: 'axis', index: 1, positive: false });
  assert.equal(atDown.step, upStep + 1);

  const rejected = wizardInput(atDown, { kind: 'axis', index: 0, positive: true });
  assert.equal(rejected.result, 'wrong-stick');
  assert.equal(rejected.result === 'wrong-stick' && rejected.pairName, 'UP');
  assert.equal(rejected.state, atDown, 'nothing changed');

  // Back after the rejection returns to the UP step with UP not yet captured.
  const back = wizardInput(rejected.state, { kind: 'back' }).state;
  assert.equal(back.step, upStep);
  assert.deepEqual(back.axisCaptures, {});

  // The old code saved a Back snapshot before rejecting. Back then returned
  // to the UP step with UP still captured, so the player could not move the
  // stick to another axis: the very thing they went back to do.
  const replay = (wizard: { apply: (input: WizardInput) => void }) => {
    for (let i = 0; i < upStep; i++) wizard.apply({ kind: 'skip' });
    wizard.apply({ kind: 'axis', index: 1, positive: false }); // UP on axis 1
    wizard.apply({ kind: 'axis', index: 0, positive: true }); // DOWN on axis 0: rejected
    wizard.apply({ kind: 'back' }); // back to UP
    wizard.apply({ kind: 'axis', index: 0, positive: false }); // UP on axis 0 this time
  };
  const old = oldWizard(PAD, null, true);
  replay(old);
  assert.equal(old.result().step, upStep, 'old: UP on the other axis was rejected');
  const now = newWizard(PAD, null);
  replay(now);
  assert.equal(now.result().step, upStep + 1, 'new: UP on the other axis is taken');
});

test('a stick is saved only when both of its directions were captured on one axis', () => {
  const upStep = WIZARD_STEPS.findIndex((s) => s.prompt === 'Push stick UP');
  const both = press(
    skipTo(start(), upStep),
    { kind: 'axis', index: 3, positive: false },
    { kind: 'axis', index: 3, positive: true },
    { kind: 'axis', index: 2, positive: false },
  );
  const profile = finishedProfile(both);
  assert.deepEqual(profile?.axes['stickY'], { index: 3, bits: [18, 19] });
  // LEFT alone: the stick keeps its old axis.
  assert.deepEqual(profile?.axes['stickX'], PAD.axes['stickX']);
});

test('a button step takes a button, a stick step takes a stick, a C step takes either', () => {
  const s0 = start();
  assert.equal(wizardInput(s0, { kind: 'axis', index: 0, positive: true }).result, 'ignored');
  const a = wizardInput(s0, { kind: 'button', index: 5 });
  assert.equal(a.result, 'advanced');
  assert.equal(a.state.profile?.buttons[5], 1 << 0);

  const upStep = WIZARD_STEPS.findIndex((s) => s.type === 'axis');
  assert.equal(wizardInput(skipTo(s0, upStep), { kind: 'button', index: 5 }).result, 'ignored');

  const cStep = WIZARD_STEPS.findIndex((s) => s.type === 'cbutton');
  const atC = skipTo(s0, cStep);
  assert.equal(wizardInput(atC, { kind: 'button', index: 5 }).state.profile?.buttons[5], 1 << 23);
  assert.deepEqual(wizardInput(atC, { kind: 'axis', index: 3, positive: true }).state.profile?.axisButtons?.[3], {
    pos: (1 << 22) | (1 << 23),
    neg: 1 << 23,
  });
});

test('with no gamepad only keys are remapped', () => {
  const s0 = startWizardState(null, null);
  assert.equal(wizardInput(s0, { kind: 'button', index: 0 }).result, 'ignored');
  const cStep = WIZARD_STEPS.findIndex((s) => s.type === 'cbutton');
  assert.equal(wizardInput(skipTo(s0, cStep), { kind: 'axis', index: 0, positive: true }).result, 'ignored');
  const keyed = wizardInput(s0, { kind: 'key', keyCode: 13 });
  assert.equal(keyed.state.keyMap[13], 0);
  assert.equal(finishedProfile(keyed.state), null);
});

test('the last step finishes, and Back at the first step does nothing', () => {
  const s0 = start();
  assert.equal(wizardInput(s0, { kind: 'back' }).result, 'ignored');
  const last = skipTo(s0, WIZARD_STEPS.length - 1);
  assert.equal(wizardInput(last, { kind: 'skip' }).result, 'done');
  assert.equal(wizardInput(last, { kind: 'key', keyCode: 13 }).result, 'done');
});

test('the prompt names the step, counts it, and offers Back after the first', () => {
  assert.deepEqual(wizardPrompt(start()), {
    prompt: 'Press: A (gamepad or key)',
    progress: '(1/18)',
    canGoBack: false,
  });
  assert.deepEqual(wizardPrompt(skipTo(start(), 10)), {
    prompt: 'Push stick UP (gamepad or key)',
    progress: '(11/18)',
    canGoBack: true,
  });
});

test('every N64 input the default keys drive has a step, once', () => {
  const bits = WIZARD_STEPS.map((s) => s.bit);
  assert.equal(new Set(bits).size, bits.length);
  assert.deepEqual(
    [...bits].sort((a, b) => a - b),
    Object.values(DEFAULT_KEY_MAP).sort((a, b) => a - b),
  );
});
