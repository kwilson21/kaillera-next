import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentAutoDelay,
  delayPreference,
  delayQualityLabel,
  delaySummary,
  effectiveDelayHint,
  hostOptionsSummary,
  pickerHint,
  sanitizeFrameDelay,
  soloOption,
  type DelayPicker,
} from '../../web/src/play/delay.ts';

// ── the code this module replaced, kept as an oracle ─────────────────────────
// web/static/play.js as of #133, with its DOM reads turned into parameters:
// `auto` is `autoEl?.checked`, `select` is the select element or undefined.

type OldSelect = { value: string } | undefined;
type OldAuto = boolean | undefined;
type OldRaw = string | number | null | undefined;

const OLD_LABELS = ['LAN', 'Excellent', 'Excellent', 'Good', 'Good', 'Average', 'Average', 'Low', 'Bad', 'Bad'];

const oldSanitize = (value: OldRaw, fallback = 2, allowZero = false): number => {
  // The old code passed the raw value; parseInt applies this same ToString itself.
  const parsed = parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero && parsed === 0) return 0;
  if (parsed <= 0) return fallback;
  return Math.min(9, Math.max(1, parsed));
};

const oldCurrentAuto = (solo: boolean, autoValue: OldRaw): number => (solo ? 0 : oldSanitize(autoValue));

const oldPreference = (solo: boolean, auto: OldAuto, select: OldSelect, autoValue: OldRaw): number => {
  if (solo) return 0;
  if (auto) return oldCurrentAuto(solo, autoValue);
  if (select) return oldSanitize(select.value);
  return 2;
};

const oldQuality = (delay: OldRaw): string => {
  const parsed = parseInt(String(delay), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  return OLD_LABELS[Math.min(9, Math.max(1, parsed))] ?? '';
};

/** Returns the hint text; mutates `select` as the old code mutated the element. */
const oldHint = (solo: boolean, auto: OldAuto, select: OldSelect, autoValue: OldRaw): string => {
  if (solo) {
    if (auto && select) select.value = String(0);
    const manualDelay = oldSanitize(select?.value);
    return auto ? '(solo: no delay)' : `(solo: no delay · fixed ${manualDelay} for netplay)`;
  }
  let delay: OldRaw = select?.value;
  if (auto) {
    delay = oldCurrentAuto(solo, autoValue);
    if (select) select.value = String(delay);
  }
  const label = oldQuality(delay);
  return label ? `(${label})` : '';
};

const oldSummary = (solo: boolean, auto: OldAuto, select: OldSelect, hint: string | undefined): string => {
  if (solo) {
    if (auto) return 'Solo · no delay';
    return `Solo · no delay · Fixed ${oldSanitize(select?.value)} for netplay`;
  }
  const effective = hint?.trim() || 'pending';
  return auto ? `Auto · effective ${effective}` : `Fixed ${oldSanitize(select?.value)}`;
};

const oldEffective = (own: number, room: number): string => {
  if (room <= 0) return '(solo: no delay)';
  const label = OLD_LABELS[room] ?? '';
  if (room > own) return `(room: ${room} — ${label})`;
  return label ? `(${label})` : '';
};

// ── every combination the page can present ──────────────────────────────────

const RAW: OldRaw[] = [
  0,
  1,
  2,
  3,
  5,
  9,
  10,
  11,
  -1,
  2.7,
  Number.NaN,
  '5',
  '03',
  '3abc',
  'abc',
  '',
  ' 4',
  null,
  undefined,
];
const SELECT_VALUES: Array<string | undefined> = [undefined, '0', '1', '2', '3', '5', '9', '10', '', 'abc', '-1'];
const AUTO: OldAuto[] = [true, false, undefined];

const pickers = function* (): Generator<DelayPicker> {
  for (const solo of [true, false]) {
    for (const auto of AUTO) {
      for (const selectValue of SELECT_VALUES) {
        for (const autoValue of RAW) yield { solo, auto, selectValue, autoValue };
      }
    }
  }
};

const selectOf = (picker: DelayPicker): OldSelect =>
  picker.selectValue === undefined ? undefined : { value: picker.selectValue };

test('sanitizeFrameDelay matches the old function for every input, fallback and zero rule', () => {
  for (const value of [...RAW, ...SELECT_VALUES]) {
    for (const fallback of [2, 4]) {
      for (const allowZero of [false, true]) {
        const got = sanitizeFrameDelay(value, fallback, allowZero);
        assert.equal(got, oldSanitize(value, fallback, allowZero), `${String(value)}/${fallback}/${allowZero}`);
      }
    }
    assert.equal(sanitizeFrameDelay(value), oldSanitize(value));
    assert.equal(delayQualityLabel(value), oldQuality(value));
  }
});

test('the delay a player asks for is what the old code asked for, in every picker state', () => {
  let checked = 0;
  for (const picker of pickers()) {
    const { solo, auto, autoValue } = picker;
    assert.equal(
      delayPreference(picker),
      oldPreference(solo, auto, selectOf(picker), autoValue),
      JSON.stringify(picker),
    );
    assert.equal(currentAutoDelay(picker), oldCurrentAuto(solo, autoValue));
    checked += 1;
  }
  assert.equal(checked, 2 * 3 * 11 * 19);
});

test('the picker hint and what Auto writes into the select match the old code', () => {
  for (const picker of pickers()) {
    const select = selectOf(picker);
    const text = oldHint(picker.solo, picker.auto, select, picker.autoValue);
    const hint = pickerHint(picker);
    assert.equal(hint.text, text, JSON.stringify(picker));
    // The old code wrote the element; the new one says what to write, or nothing.
    const after = hint.selectValue ?? picker.selectValue;
    assert.equal(after, select?.value, JSON.stringify(picker));
  }
});

test('the summary line matches the old code, whatever the hint beside the picker says', () => {
  for (const picker of pickers()) {
    for (const hint of [undefined, '', '  ', '(Good)', ' (room: 5 — Average) ']) {
      const expected = oldSummary(picker.solo, picker.auto, selectOf(picker), hint);
      assert.equal(delaySummary(picker, hint), expected, JSON.stringify(picker));
    }
  }
});

test('the zero option is offered only to a solo player on Auto', () => {
  for (const picker of pickers()) {
    const option = soloOption(picker);
    assert.equal(option.disabled, !(picker.solo && picker.auto !== false));
    const oldFallback = String(oldCurrentAuto(picker.solo, picker.autoValue) || 2);
    assert.equal(option.fallbackValue, oldFallback);
  }
});

test('the negotiated-delay hint matches the old code for every own and room delay', () => {
  for (let own = 0; own <= 10; own += 1) {
    for (let room = -1; room <= 11; room += 1) assert.equal(effectiveDelayHint(own, room), oldEffective(own, room));
  }
});

// ── and a few read as a person would ────────────────────────────────────────

test('alone in a room there is no delay; with company Auto uses what it measured', () => {
  const picker = { solo: false, auto: true, selectValue: '2', autoValue: 4 };
  assert.equal(delayPreference({ ...picker, solo: true }), 0);
  assert.equal(delayPreference(picker), 4);
  assert.equal(delayPreference({ ...picker, auto: false, selectValue: '7' }), 7);
  assert.equal(delayPreference({ ...picker, auto: false, selectValue: '0' }), 2);
  assert.equal(delayPreference({ ...picker, auto: false, selectValue: '15' }), 9);
  assert.deepEqual(pickerHint(picker), { text: '(Good)', selectValue: '4' });
  assert.equal(delaySummary(picker, '(Good)'), 'Auto · effective (Good)');
});

test('the words beside a negotiated delay', () => {
  assert.equal(effectiveDelayHint(2, 0), '(solo: no delay)');
  assert.equal(effectiveDelayHint(2, 2), '(Excellent)');
  assert.equal(effectiveDelayHint(2, 5), '(room: 5 — Average)');
  assert.equal(hostOptionsSummary(true, false, 'Fixed 3'), 'Resync on · ROM sharing off · Fixed 3');
});
