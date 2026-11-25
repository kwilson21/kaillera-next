import { startDeadline } from '../start-deadline.ts';

type Tone = 'info' | 'success' | 'warn' | 'error';

interface ToastOptions {
  readonly key?: string;
  readonly matchId?: string | null;
}

interface Toast {
  readonly element: HTMLElement;
  readonly matchId: string | null;
  readonly tone: Tone;
  readonly message: string;
  cancel: () => void;
}

const MAX_TOASTS = 3;
const active = new Map<string, Toast>();
let currentMatch: string | null = null;

const toastId = (key: string, matchId: string | null): string => JSON.stringify([matchId, key]);
const isWarning = (tone: Tone): boolean => tone === 'warn' || tone === 'error';

const removeToast = (id: string): void => {
  const toast = active.get(id);
  if (!toast) return;
  active.delete(id);
  toast.cancel();
  toast.element.remove();
  const announcer = document.getElementById('notice-announcer');
  if (announcer?.textContent === toast.message) announcer.textContent = '';
};

export const dismissToast = (key: string, matchId: string | null = null): void => removeToast(toastId(key, matchId));

export const clearNotices = (): void => {
  for (const id of active.keys()) removeToast(id);
};

export const setNoticeMatch = (matchId: string | null): void => {
  if (matchId === currentMatch) return;
  currentMatch = matchId;
  for (const [id, toast] of active) {
    if (toast.matchId !== null && toast.matchId !== matchId) removeToast(id);
  }
};

export const placeNotices = (inLobby: boolean): void => {
  const stack = document.getElementById('toast-container');
  const dock = document.getElementById(inLobby ? 'room-notices' : 'floating-notices');
  if (stack && dock && stack.parentElement !== dock) dock.appendChild(stack);
};

/** Duplicate notices keep their original deadline. Routine updates yield to warnings. */
export const showToast = (message: string, tone: Tone = 'info', options: ToastOptions = {}): void => {
  const container = document.getElementById('toast-container');
  const matchId = options.matchId ?? null;
  if (!container || (matchId !== null && matchId !== currentMatch)) return;
  const id = toastId(options.key ?? message, matchId);
  const previous = active.get(id);
  if (previous?.message === message && previous.tone === tone) return;
  if (previous) removeToast(id);
  if (active.size >= MAX_TOASTS) {
    const available = [...active].filter(([, toast]) => !toast.element.contains(document.activeElement));
    const passive = available.find(([, toast]) => !isWarning(toast.tone));
    const evict = passive?.[0] ?? (isWarning(tone) ? available[0]?.[0] : undefined);
    if (evict === undefined) return;
    removeToast(evict);
  }

  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.tone = tone;
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  element.append(text, close);

  const toast: Toast = { element, message, matchId, tone, cancel: () => {} };
  const startExpiry = (): void => {
    if (active.get(id) !== toast) return;
    toast.cancel = startDeadline({
      deadlineMs: isWarning(tone) ? 6000 : 4000,
      onDeadline: () => removeToast(id),
    }).cancel;
  };
  close.addEventListener('pointerdown', (event) => event.preventDefault());
  close.addEventListener('click', () => removeToast(id));
  close.addEventListener('focus', () => toast.cancel());
  close.addEventListener('blur', startExpiry);
  active.set(id, toast);
  container.appendChild(element);
  const announcer = document.getElementById('notice-announcer');
  if (announcer) announcer.textContent = message;
  startExpiry();
};

/** Fill and show the error card: the message and the way back to the lobby. */
export const showErrorCard = (message: string, joinUrl: string | null = null): void => {
  const el = document.getElementById('error-msg');
  if (!el) return;
  el.classList.remove('hidden');
  const card = el.querySelector('.error-card');
  if (!card) return;
  const heading = document.createElement('h3');
  heading.textContent = 'Error';
  const text = document.createElement('p');
  text.textContent = message;
  const back = document.createElement('a');
  back.href = '/';
  back.className = 'error-back';
  back.textContent = 'Back to Lobby';
  card.replaceChildren(heading, text);
  if (joinUrl) {
    const join = document.createElement('a');
    join.href = joinUrl;
    join.className = 'error-back';
    join.textContent = 'Join this room';
    card.append(join);
  }
  card.append(back);
};

const warnBeforeLeaving = (event: BeforeUnloadEvent): void => {
  event.preventDefault();
  event.returnValue = true;
};

/** Only a host with a live match has emulator state the rest of the room depends on. */
export const guardHostNavigation = (active: boolean): void => {
  if (active) window.addEventListener('beforeunload', warnBeforeLeaving);
  else {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    document.querySelector<HTMLDialogElement>('#host-leave-dialog[open]')?.close();
  }
};
