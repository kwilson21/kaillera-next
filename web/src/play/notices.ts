/**
 * What the play page tells the player in passing: toasts, the error card and
 * the "room is full" banner. Moved from web/static/play.js.
 */

/** How long a toast stays before it fades, and how long the fade takes. */
export const TOAST_VISIBLE_MS = 2700;
export const TOAST_FADE_MS = 300;
const BANNER_MS = 5000;

/** Show a short message that goes away by itself. */
export const showToast = (message: string): void => {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), TOAST_FADE_MS);
  }, TOAST_VISIBLE_MS);
};

/** Fill and show the error card: the message and the way back to the lobby. */
export const showErrorCard = (message: string): void => {
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
  card.replaceChildren(heading, text, back);
};

/** Tell a player who was put in the audience why. Closes itself. */
export const showRoomFullBanner = (): void => {
  const banner = document.createElement('div');
  banner.className = 'room-full-banner';
  const text = document.createElement('span');
  text.textContent = 'Game is full — you’ve joined as a spectator';
  const close = document.createElement('button');
  close.className = 'banner-close';
  close.textContent = '✕';
  close.addEventListener('click', () => banner.remove());
  banner.append(text, close);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), BANNER_MS);
};
