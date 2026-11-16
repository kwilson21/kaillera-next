import type { PageState } from '../kn-state.ts';
import { resetComboActive } from '../reset-combo.ts';

export interface ResetComboControl {
  readonly open: () => void;
  readonly close: () => void;
}

/** A deliberate hold, not a timed macro: it lasts as many game frames as needed. */
export function startResetCombo(host: Window, state: PageState): ResetComboControl {
  const doc = host.document;
  const dialog = doc.createElement('dialog');
  dialog.id = 'reset-combo-dialog';
  dialog.setAttribute('aria-labelledby', 'reset-combo-title');
  dialog.setAttribute('aria-describedby', 'reset-combo-help');
  dialog.innerHTML = `<h2 id="reset-combo-title">Reset paused game</h2>
<p id="reset-combo-help">Pause the game with Start first. Hold the button below until the round ends or the results screen appears, then release. This sends R + Z + A + B together, just like a controller. It does not restart the emulator or end the room.</p>
<button type="button" id="reset-combo-hold" aria-pressed="false">Hold R + Z + A + B</button>
<p id="reset-combo-status" role="status" aria-live="polite">Ready</p>
<button type="button" id="reset-combo-close">Close</button>`;
  doc.body.appendChild(dialog);
  const hold = dialog.querySelector<HTMLButtonElement>('#reset-combo-hold')!;
  const status = dialog.querySelector<HTMLElement>('#reset-combo-status')!;
  const canPlay = (): boolean => state.gameOn() && state.slot !== null && state.slot >= 0;
  const setHeld = (held: boolean): void => {
    state.resetComboHeld = resetComboActive(dialog.open, held, canPlay());
    hold.setAttribute('aria-pressed', String(state.resetComboHeld));
    status.textContent = state.resetComboHeld ? 'Holding reset combination — release when the round ends' : 'Ready';
  };
  const release = (): void => setHeld(false);
  const close = (): void => {
    release();
    if (dialog.open) dialog.close();
  };
  hold.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    hold.focus();
    hold.setPointerCapture(event.pointerId);
    setHeld(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) hold.addEventListener(type, release);
  hold.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) setHeld(true);
  });
  hold.addEventListener('keyup', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    release();
  });
  // Assistive technologies may activate with click alone: toggle a held chord,
  // with the same aria-pressed state and the Close button always releasing it.
  hold.addEventListener('click', (event) => {
    if (event.detail === 0) setHeld(!state.resetComboHeld);
  });
  dialog.querySelector('#reset-combo-close')!.addEventListener('click', close);
  dialog.addEventListener('cancel', release);
  dialog.addEventListener('close', () => {
    release();
    doc.querySelector<HTMLButtonElement>('#toolbar-more')?.focus();
  });
  host.addEventListener('blur', close);
  host.addEventListener('pagehide', close);
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) close();
  });
  return {
    open: () => {
      if (!canPlay() || dialog.open) return;
      dialog.showModal();
      release();
      hold.focus();
    },
    close,
  };
}
