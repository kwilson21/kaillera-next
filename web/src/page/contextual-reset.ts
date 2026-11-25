import { initialTransition, transition } from 'xstate';
import type { PageState } from '../kn-state.ts';
import { contextualResetIntent, readNativePause, type ReadWord } from '../contextual-reset.ts';
import { contextualResetMachine } from '../contextual-reset-machine.ts';
import { startDeadline } from '../start-deadline.ts';
import { startEvery } from '../poll.ts';

/** Preview only: a native input affordance, never a memory edit or emulator reset. */
export function startContextualReset(host: Window, state: PageState, read: ReadWord) {
  const doc = host.document;
  const panel = doc.createElement('section');
  panel.id = 'contextual-reset';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Paused game reset');
  panel.innerHTML =
    '<p role="status" aria-live="polite"></p><button type="button" aria-pressed="false">Hold A + B + Z + R</button>';
  doc.body.appendChild(panel);
  const button = panel.querySelector('button')!;
  const status = panel.querySelector('p')!;
  let [snapshot] = initialTransition(contextualResetMachine);
  let cancelDelay = () => {};
  let stopped = false;
  type Event = Parameters<typeof transition<typeof contextualResetMachine>>[2];
  const send = (event: Event): void => {
    if (stopped) return;
    const previous = snapshot;
    [snapshot] = transition(contextualResetMachine, snapshot, event);
    if (previous.context.scope !== snapshot.context.scope || previous.value !== snapshot.value) {
      cancelDelay();
      if (snapshot.value === 'pending') {
        const scope = snapshot.context.scope;
        cancelDelay = startDeadline({
          deadlineMs: 1000,
          onDeadline: () => {
            refresh();
            send({ type: 'elapsed', scope });
          },
        }).cancel;
      }
    }
    const visible = snapshot.value === 'ready' || snapshot.value === 'holding';
    state.resetComboHeld = snapshot.value === 'holding';
    button.setAttribute('aria-pressed', String(state.resetComboHeld));
    panel.hidden = !visible;
    if (!visible && doc.activeElement === button) button.blur();
  };
  const refresh = (): void => {
    if (stopped) return;
    let pause = null;
    try {
      pause = readNativePause(state.romHash, read);
    } catch {
      /* Missing engine is unsupported. */
    }
    const active = state.gameOn() && !state.remapActive && !doc.hidden && doc.hasFocus();
    const intent = pause
      ? contextualResetIntent(true, true, active, pause.owner, state.slot ?? -1, pause.mode === '12cb', pause.requested)
      : 0;
    const scope =
      intent && state.matchId ? `${state.gameId}/${state.matchId}/${state.romHash}/${pause!.owner}/${intent}` : '';
    status.textContent =
      intent === 2
        ? '12CB: request a reset. The other player must agree.'
        : intent === 3
          ? '12CB: hold to approve reset. Start declines.'
          : 'Paused game · release when the round ends';
    const bounds = doc.querySelector('#game')?.getBoundingClientRect();
    if (bounds) {
      panel.style.left = `${bounds.left + bounds.width / 2}px`;
      panel.style.top = `${Math.max(64, bounds.bottom - 108)}px`;
    }
    send({ type: 'observe', scope });
  };
  const press = (): void => {
    refresh();
    send({ type: 'press' });
  };
  const release = (): void => {
    send({ type: 'release' });
  };
  const close = (): void => {
    send({ type: 'cancel' });
  };
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    button.focus();
    button.setPointerCapture(event.pointerId);
    press();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'])
    button.addEventListener(event, release);
  button.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) press();
  });
  button.addEventListener('keyup', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    release();
  });
  button.addEventListener('click', (event) => {
    if (event.detail === 0) {
      if (state.resetComboHeld) release();
      else press();
    }
  });
  host.addEventListener('blur', close);
  host.addEventListener('pagehide', close);
  doc.addEventListener('visibilitychange', close);
  const stop = startEvery(refresh, 32);
  return {
    close,
    refresh,
    stop: () => {
      if (stopped) return;
      stop();
      host.removeEventListener('blur', close);
      host.removeEventListener('pagehide', close);
      doc.removeEventListener('visibilitychange', close);
      cancelDelay();
      close();
      stopped = true;
      panel.remove();
    },
  };
}
