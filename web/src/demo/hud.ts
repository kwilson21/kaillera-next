/**
 * The demo's result card and the labels around it: what the current delay
 * feels like in each mode, the connection pill, the details line, and the
 * small labels on the controls. Moved from web/static/demo.js with every
 * string unchanged; demo.js still decides when to draw.
 */

/** One frame at 60 fps, as the page has always rounded it. */
const FRAME_MS = 16.67;

/** The engine's counters the card reads (`NetplayRollback.getHudCounters()`); any may be missing. */
export type HudCounters = {
  readonly delay?: number | null;
  readonly currentFrame?: number | null;
  readonly isCRollback?: boolean | null;
  readonly rollbackEventsTotal?: number | null;
  readonly rollbackEventsPerSec?: number | null;
  readonly fps?: number | null;
};

/** A connection's name and the colour it is shown in. */
export type ConnectionTier = { readonly label: string; readonly tone: 'idle' | 'great' | 'okay' | 'bad' };

/**
 * A frame delay as Kaillera-style clients name it: 1-2 frames cannot be
 * felt, 3 feels fine, 4 can be felt, 5 and up is past what classic netcode
 * calls playable.
 */
export const connectionTier = (delayFrames: number): ConnectionTier => {
  if (delayFrames <= 0) return { label: 'No connection', tone: 'idle' };
  if (delayFrames <= 2) return { label: 'Excellent', tone: 'great' };
  if (delayFrames === 3) return { label: 'Good', tone: 'great' };
  if (delayFrames === 4) return { label: 'Fair', tone: 'okay' };
  if (delayFrames === 5) return { label: 'Poor', tone: 'bad' };
  if (delayFrames === 6) return { label: 'Bad', tone: 'bad' };
  return { label: 'Terrible', tone: 'bad' };
};

/** The result card's headline, its explanation, and what the pill beneath shows. */
export type InputFeel = {
  readonly text: string;
  readonly sub: string;
  readonly state: 'idle' | 'instant' | 'late';
  /** The pill names a connection tier; otherwise it says why there is none. */
  readonly showTier: boolean;
  readonly effectiveDelay: number;
  readonly networkDelay: number;
};

/**
 * What a player feels at `delayFrames` of input delay. Outside a match
 * nothing is predicted or delayed, and the card says so; at no delay both
 * modes feel the same; otherwise rollback hides the trip and lockstep makes
 * the player wait for it.
 */
export const inputFeel = (rollbackEnabled: boolean, isInMatch: boolean, delayFrames: number): InputFeel => {
  const delay = Number.isFinite(delayFrames) ? Math.max(0, delayFrames | 0) : 0;
  const delayMs = delay * FRAME_MS;
  if (!isInMatch) {
    return {
      text: 'WAITING',
      sub: 'Start a match to see rollback in action. Nothing is being predicted in menus.',
      state: 'idle',
      showTier: false,
      effectiveDelay: 0,
      networkDelay: delay,
    };
  }
  if (delay <= 0) {
    return {
      text: 'NO LAG',
      sub: 'Crank the RTT slider — both modes feel the same at 0 ms.',
      state: 'idle',
      showTier: false,
      effectiveDelay: 0,
      networkDelay: 0,
    };
  }
  if (rollbackEnabled) {
    return {
      text: `${delayMs.toFixed(0)} ms · RTT HIDDEN`,
      sub: `Rollback keeps a ${delay}-frame input delay (${delayMs.toFixed(0)} ms) whatever the RTT, just enough to absorb jitter. The rest of the network lag is hidden by predicting the opponent and rewinding when the guess was wrong, so more RTT means more visible rewinds, not more lag.`,
      state: 'instant',
      showTier: true,
      effectiveDelay: delay,
      networkDelay: delay,
    };
  }
  return {
    text: `${delayMs.toFixed(0)} ms LATE`,
    sub: `Lockstep makes you feel the full ${delay}-frame delay because it can't predict the peer's input. Visuals stay smooth (no rewinds), but every press is delayed.`,
    state: 'late',
    showTier: true,
    effectiveDelay: delay,
    networkDelay: delay,
  };
};

/** The pill's markup when it names no tier. */
export const idlePillHtml = (isInMatch: boolean): string =>
  isInMatch
    ? '<strong>No active rollback</strong> &middot; Crank the RTT slider'
    : '<strong>Engine waiting</strong> &middot; Start a match to test rollback';

/** The pill's markup for a tier at the delay the player feels. */
export const tierPillHtml = (rollbackEnabled: boolean, tier: ConnectionTier, effectiveDelay: number): string =>
  `${rollbackEnabled ? 'Rollback' : 'Lockstep'} feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${effectiveDelay} frame${effectiveDelay === 1 ? '' : 's'}</strong>`;

/**
 * The line of small print under the card: engine state, mode, RTT,
 * framerate, frame and rollbacks so far (with the engine's recent rate when
 * there is one).
 */
export const detailsText = (
  counters: HudCounters | null | undefined,
  rollbackEnabled: boolean,
  rtt: number,
): string => {
  const mode = rollbackEnabled ? 'Rollback' : 'Lockstep';
  const frame = counters?.currentFrame ?? 0;
  const cEngine = counters?.isCRollback ? 'Active' : 'Waiting (start a match)';
  const rollbacks = counters?.rollbackEventsTotal ?? 0;
  const rollbacksPerSec = counters?.rollbackEventsPerSec ?? 0;
  const rollbackText =
    rollbacksPerSec > 0
      ? `${rollbacks} (${rollbacksPerSec.toFixed(1)}/s)`
      : rollbacks > 0
        ? `${rollbacks} (idle)`
        : 'none yet';
  const fps = counters?.fps ?? 0;
  const fpsText = fps > 0 ? `${fps} fps` : '— fps';
  return (
    `Engine: ${cEngine} · Mode: ${mode} · RTT: ${rtt.toFixed(0)} ms · ` +
    `${fpsText} · Frame: ${frame} · Rollbacks: ${rollbackText}`
  );
};

/** An element the card writes to. */
export type HudElement = {
  textContent: string | null;
  innerHTML: string;
  readonly classList: {
    toggle(name: string, force?: boolean): boolean;
    remove(...names: string[]): void;
  };
};

/** The page the card is on; a `Document` is one. */
export type HudPage = { getElementById(id: string): HudElement | null };

/** What the card is drawn from. */
export type HudView = {
  readonly counters: HudCounters | null | undefined;
  readonly rollbackEnabled: boolean;
  /** The slider's RTT in milliseconds. */
  readonly rtt: number;
  /** A battle is on, the in-game pause menu included. */
  readonly isInMatch: boolean;
};

/**
 * Draw the result card: `#hud-feel`, `#hud-feel-sub`, the `#hud-frame-delay`
 * pill and the `#hud-details` line. An element the page lacks is skipped.
 */
export const renderHud = (page: HudPage, view: HudView): void => {
  const { counters, rollbackEnabled, rtt, isInMatch } = view;
  const feel = inputFeel(rollbackEnabled, isInMatch, counters?.delay ?? 0);
  const feelEl = page.getElementById('hud-feel');
  if (feelEl) {
    feelEl.textContent = feel.text;
    feelEl.classList.toggle('is-instant', feel.state === 'instant');
    feelEl.classList.toggle('is-late', feel.state === 'late');
  }

  const subEl = page.getElementById('hud-feel-sub');
  if (subEl) subEl.textContent = feel.sub;

  const delayEl = page.getElementById('hud-frame-delay');
  if (delayEl) {
    if (!feel.showTier) {
      delayEl.innerHTML = idlePillHtml(isInMatch);
      delayEl.classList.remove('is-great', 'is-okay', 'is-bad');
    } else {
      const tier = connectionTier(feel.effectiveDelay);
      delayEl.innerHTML = tierPillHtml(rollbackEnabled, tier, feel.effectiveDelay);
      delayEl.classList.toggle('is-great', tier.tone === 'great');
      delayEl.classList.toggle('is-okay', tier.tone === 'okay');
      delayEl.classList.toggle('is-bad', tier.tone === 'bad');
    }
  }

  const details = page.getElementById('hud-details');
  if (details) details.textContent = detailsText(counters, rollbackEnabled, rtt);
};

/** The rollback button: its words, `aria-pressed`, and whether it wears `is-off`. */
export type RollbackToggleLook = { readonly text: string; readonly pressed: 'true' | 'false'; readonly off: boolean };

export const rollbackToggleLook = (rollbackEnabled: boolean): RollbackToggleLook => ({
  text: `Rollback: ${rollbackEnabled ? 'ON' : 'OFF'}`,
  pressed: rollbackEnabled ? 'true' : 'false',
  off: !rollbackEnabled,
});

/** The label shown over the game when the mode changes mid-match. */
export type ModeSwitchLabel = { readonly title: string; readonly sub: string };

/** The label for a switch to rollback (`toRollback`) or lockstep at `delay` frames of input delay. */
export const modeSwitchLabel = (toRollback: boolean, delay: number): ModeSwitchLabel => {
  const ms = Math.round(delay * FRAME_MS);
  return {
    title: toRollback ? 'Switched to rollback' : 'Switched to lockstep',
    sub: toRollback
      ? `${delay}-frame input delay (${ms} ms) — predicts the opponent, rewinds on a wrong guess`
      : `${delay}-frame input delay (${ms} ms) — waits for the opponent's input every frame`,
  };
};

/** How long auto-compare stays in one mode. */
export const AUTO_COMPARE_PERIOD_MS = 6000;

/** Where auto-compare stands. */
export type AutoComparePhase = {
  /** Periods completed since it started; rollback is on in the even ones. */
  readonly cycle: number;
  readonly rollbackOn: boolean;
  /** The progress bar's CSS width. */
  readonly fillWidth: string;
};

/** Auto-compare `elapsedMs` after it started (time spent paused left out). */
export const autoComparePhase = (elapsedMs: number): AutoComparePhase => {
  const cycle = Math.floor(elapsedMs / AUTO_COMPARE_PERIOD_MS);
  const phase = elapsedMs % AUTO_COMPARE_PERIOD_MS;
  return { cycle, rollbackOn: cycle % 2 === 0, fillWidth: `${(phase / AUTO_COMPARE_PERIOD_MS) * 100}%` };
};

/** The line under the controls about gamepads, and whether it wears `is-detected`. */
export type GamepadStatus = { readonly text: string; readonly detected: boolean };

/** No gamepad has been found. */
export const NO_GAMEPAD: GamepadStatus = {
  text: 'No gamepad detected — keyboard works (keys below).',
  detected: false,
};

/** `count` gamepads are connected (one or more); `firstName` is the first one's display name, if it has one. */
export const gamepadDetected = (count: number, firstName: string | null | undefined): GamepadStatus => {
  const more = count > 1 ? ` (+${count - 1} more)` : '';
  return { text: `Gamepad detected: ${firstName || 'Gamepad'}${more}. Open Controls to remap.`, detected: true };
};

/** The badge at the top of the page that says whether the player's inputs count. */
export type InputIndicator = {
  readonly text: string;
  readonly background: string;
  readonly animation: string;
  /** The badge goes away by itself after this long; null when it stays. */
  readonly removeAfterMs: number | null;
};

/** The badge's own style, whatever it says. */
export const INPUT_INDICATOR_CSS =
  'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;' +
  'padding:8px 16px;border-radius:6px;color:#111;' +
  'font-family:sans-serif;font-weight:800;font-size:13px;letter-spacing:0.08em;' +
  'pointer-events:none;text-transform:uppercase;will-change:opacity;';

/**
 * The badge's animations. The pulse moves only the box shadow and the fades
 * only opacity, so the badge stays on one compositor layer.
 */
export const INPUT_INDICATOR_KEYFRAMES =
  '@keyframes inputPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,200,75,0.5)}50%{box-shadow:0 0 0 10px rgba(245,200,75,0)}}' +
  '@keyframes inputFadeIn{0%{opacity:0}100%{opacity:1}}' +
  '@keyframes inputFadeOut{0%{opacity:1}66%{opacity:1}100%{opacity:0}}';

const PULSING = 'inputFadeIn 200ms ease-out, inputPulse 1.6s ease-in-out 200ms infinite';

/**
 * The badge for a state: `disabled` while the autopilot drives the menus
 * (amber, stays), `enabled` when the player takes over (green, fades),
 * `post-match` after a match (amber, stays). Null for any other state, which
 * gets a bare badge.
 */
export const inputIndicator = (state: string): InputIndicator | null => {
  if (state === 'disabled') {
    return { text: 'Setting up demo, inputs disabled', background: '#f5c84b', animation: PULSING, removeAfterMs: null };
  }
  if (state === 'enabled') {
    return {
      text: 'Setup finished, inputs enabled',
      background: '#7ddc8a',
      animation: 'inputFadeIn 200ms ease-out, inputFadeOut 2.2s ease-out 200ms forwards',
      removeAfterMs: 2400,
    };
  }
  if (state === 'post-match') {
    return {
      text: 'Match ended — hit Reset for another round',
      background: '#f5c84b',
      animation: PULSING,
      removeAfterMs: null,
    };
  }
  return null;
};
