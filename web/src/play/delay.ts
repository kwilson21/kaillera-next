/**
 * Input delay as the room shows and chooses it: what a player's preference
 * comes to, and the words beside the picker. Moved from web/static/play.js
 * unchanged in behaviour; play.js still reads and writes the controls.
 *
 * The engine negotiates the match's delay from `delayPreference`, so nothing
 * here may round, clamp or default differently from the code it replaced.
 */

/** Alone in the room there is nobody to wait for. */
export const SOLO_FRAME_DELAY = 0;
export const DEFAULT_FRAME_DELAY = 2;
export const MIN_FRAME_DELAY = 1;
export const MAX_FRAME_DELAY = 9;

/** A delay as it comes off a control or out of storage. */
type RawDelay = string | number | null | undefined;

const whole = (value: RawDelay): number => Number.parseInt(String(value), 10);

/**
 * A usable delay: between 1 and 9 frames. Anything that is not a positive
 * whole number becomes `fallback`; zero stays zero only where it is allowed.
 */
export const sanitizeFrameDelay = (
  value: RawDelay,
  fallback: number = DEFAULT_FRAME_DELAY,
  allowZero: boolean = false,
): number => {
  const parsed = whole(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero && parsed === SOLO_FRAME_DELAY) return SOLO_FRAME_DELAY;
  if (parsed <= 0) return fallback;
  return Math.min(MAX_FRAME_DELAY, Math.max(MIN_FRAME_DELAY, parsed));
};

/** Connection quality as Kaillera named it, by frames of delay. */
const QUALITY = ['LAN', 'Excellent', 'Excellent', 'Good', 'Good', 'Average', 'Average', 'Low', 'Bad', 'Bad'];

/** `Good`, `Bad`, ...; empty for no delay or no number. */
export const delayQualityLabel = (delay: RawDelay): string => {
  const parsed = whole(delay);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  return QUALITY[Math.min(MAX_FRAME_DELAY, Math.max(MIN_FRAME_DELAY, parsed))] ?? '';
};

/** The delay picker as the page finds it. */
export type DelayPicker = {
  /** This player is the only one in the room (and is not watching). */
  readonly solo: boolean;
  /** The Auto checkbox; undefined when the page has none. */
  readonly auto: boolean | undefined;
  /** The fixed-delay select's value; undefined when the page has none. */
  readonly selectValue: string | undefined;
  /** The delay Auto last measured. */
  readonly autoValue: RawDelay;
};

/** What Auto means right now. */
export const currentAutoDelay = (picker: Pick<DelayPicker, 'solo' | 'autoValue'>): number =>
  picker.solo ? SOLO_FRAME_DELAY : sanitizeFrameDelay(picker.autoValue);

/** The delay this player asks the match for. */
export const delayPreference = (picker: DelayPicker): number => {
  if (picker.solo) return SOLO_FRAME_DELAY;
  if (picker.auto) return currentAutoDelay(picker);
  if (picker.selectValue !== undefined) return sanitizeFrameDelay(picker.selectValue);
  return DEFAULT_FRAME_DELAY;
};

/** The select's "0" option, as it should stand. */
export type SoloOption = { readonly disabled: boolean; readonly fallbackValue: string };

/** The hint beside the picker, and what Auto puts in the select (undefined: leave it alone). */
export type PickerHint = { readonly text: string; readonly selectValue: string | undefined };

/**
 * The select's "0" option: offered only to a solo player on Auto. When it is
 * withdrawn while selected, `fallbackValue` is what the select moves to.
 */
export const soloOption = (picker: DelayPicker): SoloOption => ({
  disabled: !(picker.solo && picker.auto !== false),
  fallbackValue: String(currentAutoDelay(picker) || DEFAULT_FRAME_DELAY),
});

/**
 * The hint beside the picker, and the value Auto puts in the select
 * (undefined: leave the select alone).
 */
export const pickerHint = (picker: DelayPicker): PickerHint => {
  if (picker.solo) {
    const selectValue = picker.auto && picker.selectValue !== undefined ? String(SOLO_FRAME_DELAY) : undefined;
    const text = picker.auto
      ? '(solo: no delay)'
      : `(solo: no delay · fixed ${sanitizeFrameDelay(picker.selectValue)} for netplay)`;
    return { text, selectValue };
  }
  if (picker.auto) {
    const delay = currentAutoDelay(picker);
    const label = delayQualityLabel(delay);
    return {
      text: label ? `(${label})` : '',
      selectValue: picker.selectValue === undefined ? undefined : String(delay),
    };
  }
  const label = delayQualityLabel(picker.selectValue);
  return { text: label ? `(${label})` : '', selectValue: undefined };
};

/** The delay half of the Advanced summary line. `hint` is the text beside the picker. */
export const delaySummary = (picker: DelayPicker, hint: string | undefined): string => {
  if (picker.solo) {
    if (picker.auto) return 'Solo · no delay';
    return `Solo · no delay · Fixed ${sanitizeFrameDelay(picker.selectValue)} for netplay`;
  }
  const effective = hint?.trim() || 'pending';
  return picker.auto ? `Auto · effective ${effective}` : `Fixed ${sanitizeFrameDelay(picker.selectValue)}`;
};

/** The host's Advanced summary line. */
export const hostOptionsSummary = (resyncOn: boolean, romSharingOn: boolean, delayText: string): string =>
  `Resync ${resyncOn ? 'on' : 'off'} · ROM sharing ${romSharingOn ? 'on' : 'off'} · ${delayText}`;

/**
 * The hint once a match has negotiated its delay: the room's delay when it is
 * higher than this player's own, otherwise just the quality.
 */
export const effectiveDelayHint = (own: number, room: number): string => {
  if (room <= 0) return '(solo: no delay)';
  const label = QUALITY[room] ?? '';
  if (room > own) return `(room: ${room} — ${label})`;
  return label ? `(${label})` : '';
};
