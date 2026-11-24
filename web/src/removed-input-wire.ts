/**
 * The `roster-cut:` message: the host's cut of a removed player's input
 * (removed-input.ts has the rules, specs/removed_input.qnt the model).
 *
 *   roster-cut:<roster frame>:<slot>:<cut tag>:<first tag>:<input>;<input>;...
 *
 * Each input is `buttons,lx,ly,cx,cy`, the one the host applied for the slot
 * on each tag from <first tag> up to the cut tag (none when they are equal).
 * The host sends it on the lockstep channel just before the `roster-mask:`
 * and `roster:` of the same roster frame, and only for a roster it schedules
 * (one rule per match, controller-mask.ts matchScheduled); a page from before
 * it never sees one.
 */

/** One input: buttons and the two sticks. */
export interface CutInput {
  readonly buttons: number;
  readonly lx: number;
  readonly ly: number;
  readonly cx: number;
  readonly cy: number;
}

export interface RosterCut {
  /** The host's roster frame of the removal. */
  readonly rosterFrame: number;
  readonly slot: number;
  /** The first neutral tag. */
  readonly cut: number;
  /** The tag of `inputs[0]`. */
  readonly from: number;
  /** What the host applied on the tags from `from` up to `cut`. */
  readonly inputs: readonly CutInput[];
}

export const ROSTER_CUT_PREFIX = 'roster-cut:';
/** The most inputs one message carries (wordSpan is about 40 tags at the largest delay). */
export const ROSTER_CUT_MAX_INPUTS = 256;

const NEUTRAL: CutInput = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

const isInt = (n: number): boolean => Number.isSafeInteger(n);
const isStick = (n: number): boolean => Number.isInteger(n) && n >= -128 && n <= 127;
const isButtons = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffff;

/** The message for a cut. */
export const encodeRosterCut = (cut: RosterCut): string =>
  `${ROSTER_CUT_PREFIX}${cut.rosterFrame}:${cut.slot}:${cut.cut}:${cut.from}:` +
  cut.inputs.map((i) => `${i.buttons},${i.lx},${i.ly},${i.cx},${i.cy}`).join(';');

// A whole number written the way the host writes one, or null.
const intOf = (text: string | undefined): number | null => {
  if (text === undefined || !/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return isInt(n) ? n : null;
};

// `buttons,lx,ly,cx,cy`, or null.
const inputOf = (field: string): CutInput | null => {
  const v = field.split(',').map(intOf);
  if (v.length !== 5) return null;
  const [buttons, lx, ly, cx, cy] = v;
  if (buttons === null || buttons === undefined || !isButtons(buttons)) return null;
  if (lx == null || ly == null || cx == null || cy == null) return null;
  if (![lx, ly, cx, cy].every(isStick)) return null;
  return { buttons, lx, ly, cx, cy };
};

/** A cut from its message, or null when it is malformed. */
export const parseRosterCut = (msg: string): RosterCut | null => {
  if (typeof msg !== 'string' || !msg.startsWith(ROSTER_CUT_PREFIX)) return null;
  const parts = msg.slice(ROSTER_CUT_PREFIX.length).split(':');
  if (parts.length !== 5) return null;
  const rosterFrame = intOf(parts[0]);
  const slot = intOf(parts[1]);
  const cut = intOf(parts[2]);
  const from = intOf(parts[3]);
  if (rosterFrame === null || slot === null || cut === null || from === null) return null;
  if (rosterFrame < 0 || slot < 0 || slot > 3 || from < 0 || from > cut) return null;
  const body = parts[4] ?? '';
  const fields = body === '' ? [] : body.split(';');
  if (fields.length !== cut - from || fields.length > ROSTER_CUT_MAX_INPUTS) return null;
  const inputs: CutInput[] = [];
  for (const field of fields) {
    const i = inputOf(field);
    if (i === null) return null;
    inputs.push(i);
  }
  return { rosterFrame, slot, cut, from, inputs };
};

/** One input as one number, the same way for every input (firstDiffering compares them). */
export const packInput = (i: CutInput): number =>
  ((((i.buttons & 0xffff) * 256 + (i.lx & 255)) * 256 + (i.ly & 255)) * 256 + (i.cx & 255)) * 256 + (i.cy & 255);

/**
 * The input the cut gives tag `tag`: the host's below the cut (null when the
 * message does not reach that far back), neutral from the cut on.
 */
export const cutInputAt = (cut: RosterCut, tag: number): CutInput | null => {
  if (tag >= cut.cut) return NEUTRAL;
  if (tag < cut.from) return null;
  return cut.inputs[tag - cut.from] ?? null;
};
