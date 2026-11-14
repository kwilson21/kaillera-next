/**
 * The feedback button, its form, and the "How was your session?" prompt.
 * Moved from web/static/feedback.js.
 *
 * Every page gets a floating button that opens the form. On the play page
 * the button gives way to a "Feedback" entry in the toolbar's menu while a
 * game is on. A report goes to `POST /api/feedback` with what the page knows
 * about the session, so the server can keep that match's logs.
 */

/** The kinds of report the form offers. */
export type Category = 'bug' | 'feature' | 'general';

interface CategoryText {
  readonly emoji: string;
  readonly label: string;
  readonly placeholder: string;
}

const CATEGORIES = new Map<Category, CategoryText>([
  ['bug', { emoji: '🐛', label: 'Bug Report', placeholder: 'What happened? Steps to reproduce if possible...' }],
  ['feature', { emoji: '💡', label: 'Feature', placeholder: 'What would you like to see?' }],
  ['general', { emoji: '💬', label: 'General', placeholder: "What's on your mind?" }],
]);

/** A category button's `data-cat` as a category; null for anything else. */
export const categoryOf = (value: string | undefined): Category | null =>
  value === 'bug' || value === 'feature' || value === 'general' ? value : null;

/** What the message box suggests writing; the general text until a category is picked. */
export const placeholderFor = (category: Category | null): string =>
  CATEGORIES.get(category ?? 'general')?.placeholder ?? '';

/** Where a report was written from. */
export type FeedbackPage = 'game' | 'lobby' | 'home';

/** Which page this is, from its address. */
export const detectPage = (pathname: string, search: string): FeedbackPage => {
  if (pathname.includes('play.html')) return 'game';
  return new URLSearchParams(search).get('room') ? 'lobby' : 'home';
};

/** The play page: the button moves into the toolbar's menu during a game there. */
export const isGamePage = (pathname: string): boolean => pathname.includes('/play');

/** A peer as the engine keeps it, as far as a report reads it. */
export interface PeerReportView {
  readonly sid?: string | null | undefined;
  readonly pc?: { readonly connectionState?: string | null | undefined } | null | undefined;
}

/** `window.KNState` as far as a report reads it. */
export interface SessionReportView {
  readonly room?: string | null | undefined;
  readonly matchId?: string | null | undefined;
  readonly slot?: number | null | undefined;
  /** The engine's peers by socket id. */
  readonly peers?: object | null | undefined;
  readonly sessionStats?: object | null | undefined;
}

/** What a report says about the session it was written in. */
export interface FeedbackContext {
  url: string;
  page: FeedbackPage;
  userAgent: string;
  timestamp: number;
  playerName?: string;
  roomCode?: string;
  /** Links the report to its match, so the server keeps that match's logs. */
  matchId?: string;
  playerSlot?: number;
  peerCount?: number;
  /** Each connected peer's WebRTC connection state, by socket id. */
  peerStates?: { [sid: string]: string };
  sessionStats?: object;
  mode?: string;
}

/** What the page knows when a report is sent. */
export interface ContextSource {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly userAgent: string;
  readonly now: number;
  /** The saved player name, or null when there is none or storage is blocked. */
  readonly playerName: string | null;
  readonly state: SessionReportView | null | undefined;
}

/** The session context attached to a report. Fields with nothing to say are left out. */
export const gatherContext = (source: ContextSource): FeedbackContext => {
  const context: FeedbackContext = {
    url: source.href,
    page: detectPage(source.pathname, source.search),
    userAgent: source.userAgent,
    timestamp: source.now,
  };
  if (source.playerName) context.playerName = source.playerName;
  const state = source.state;
  if (state) {
    if (state.room) context.roomCode = state.room;
    if (state.matchId) context.matchId = state.matchId;
    if (state.slot != null) context.playerSlot = state.slot;
    if (state.peers) {
      const peers: PeerReportView[] = Object.values(state.peers);
      context.peerCount = peers.length;
      const states = new Map<string, string>();
      for (const peer of peers) {
        if (peer.pc) states.set(peer.sid || 'unknown', peer.pc.connectionState || 'unknown');
      }
      if (states.size) context.peerStates = Object.fromEntries(states);
    }
    if (state.sessionStats) context.sessionStats = { ...state.sessionStats };
  }
  const mode = new URLSearchParams(source.search).get('mode');
  if (mode) context.mode = mode;
  return context;
};

/** The body of `POST /api/feedback`. */
export interface FeedbackPayload {
  readonly category: Category;
  readonly message: string;
  readonly email: string | null;
  /** A field no person fills in; the server drops reports that have it set. */
  readonly company_fax: string;
  readonly page: FeedbackPage;
  readonly context: FeedbackContext;
}

/** What the form holds when Send is pressed. */
export interface FormValues {
  readonly category: Category | null;
  readonly message: string;
  readonly email: string;
  readonly trap: string;
}

/** The report to send. The form does not send one with a blank message. */
export const feedbackPayload = (form: FormValues, context: FeedbackContext): FeedbackPayload => ({
  category: form.category || 'general',
  message: form.message.trim(),
  email: form.email.trim() || null,
  company_fax: form.trap,
  page: context.page,
  context,
});

/** What the visitor is told once the server has answered; `status` is null when it did not. */
export const submitToast = (status: number | null, ok: boolean): string => {
  if (ok) return 'Thanks for your feedback!';
  return status === 429 ? 'Please wait before submitting again' : 'Submission failed, please try again';
};

/**
 * Whether the floating button is hidden on the play page: during a game
 * (the toolbar's menu has the entry), and on a narrow screen while the lobby
 * overlay is up, where it would cover the lobby's own buttons.
 */
export const fabHidden = (gameActive: boolean, setupActive: boolean, narrow: boolean): boolean =>
  gameActive || (setupActive && narrow);

const STYLES = `
      .kn-feedback-fab {
        position: fixed; bottom: 20px; right: 20px; z-index: 150;
        width: 48px; height: 48px; border-radius: 50%;
        background: #e94560; color: #fff; border: none; cursor: pointer;
        font-size: 20px; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(233,69,96,0.4);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .kn-feedback-fab.kn-feedback-play-fab {
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        z-index: 120;
      }
      @media (max-width: 600px) {
        .kn-feedback-fab.kn-feedback-play-fab {
          right: calc(16px + env(safe-area-inset-right, 0px));
          bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        }
      }
      .kn-feedback-fab:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(233,69,96,0.5);
      }
      .kn-feedback-fab[hidden] { display: none; }
      .kn-feedback-fab-tooltip {
        position: absolute; bottom: 56px; right: 0;
        background: #0f0f23; border: 1px solid #333; border-radius: 8px;
        padding: 6px 10px; color: #aaa; font-size: 11px; white-space: nowrap;
        pointer-events: none; opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-fab:hover .kn-feedback-fab-tooltip { opacity: 1; }

      @keyframes kn-feedback-pulse {
        0%, 100% { box-shadow: 0 4px 16px rgba(233,69,96,0.4); }
        50% { box-shadow: 0 0 24px rgba(233,69,96,0.8); }
      }
      .kn-feedback-fab.intro { animation: kn-feedback-pulse 1.5s ease-in-out 3; }
      .kn-feedback-callout {
        position: absolute; bottom: 56px; right: 0;
        background: #0f0f23; border: 1px solid #e94560; border-radius: 8px;
        padding: 8px 12px; color: #eee; font-size: 12px; white-space: nowrap;
        pointer-events: none; opacity: 0; transition: opacity 0.3s;
      }
      .kn-feedback-callout.show { opacity: 1; }

      .kn-feedback-backdrop {
        position: fixed; inset: 0; z-index: 301;
        background: rgba(0,0,0,0.6); display: flex;
        align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .kn-feedback-backdrop.open { opacity: 1; }
      .kn-feedback-backdrop[hidden] { display: none; }

      .kn-feedback-modal {
        background: #0f0f23; border: 1px solid #333; border-radius: 12px;
        width: 90%; max-width: 440px; padding: 24px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        max-height: 90vh; overflow-y: auto;
      }
      .kn-feedback-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 20px;
      }
      .kn-feedback-header h3 { color: #fff; font-size: 18px; margin: 0; }
      .kn-feedback-close {
        background: none; border: none; color: #666; font-size: 20px;
        cursor: pointer; padding: 4px 8px;
      }
      .kn-feedback-close:hover { color: #fff; }

      .kn-feedback-categories {
        display: flex; gap: 8px; margin-bottom: 16px;
      }
      .kn-feedback-cat {
        flex: 1; padding: 10px; text-align: center; border-radius: 8px;
        font-size: 13px; font-weight: 500; cursor: pointer;
        background: #16213e; color: #aaa; border: 1px solid #333;
        transition: background 0.1s, color 0.1s;
      }
      .kn-feedback-cat:hover { border-color: #e94560; }
      .kn-feedback-cat.active {
        background: #e94560; color: #fff; border-color: #e94560;
      }

      .kn-feedback-label {
        display: block; color: #888; font-size: 12px; margin-bottom: 4px;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .kn-feedback-textarea {
        width: 100%; min-height: 100px; padding: 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; resize: vertical;
        font-family: inherit; margin-bottom: 16px; box-sizing: border-box;
      }
      .kn-feedback-textarea:focus { outline: none; border-color: #e94560; }

      .kn-feedback-email {
        width: 100%; padding: 10px 12px;
        background: #16213e; border: 1px solid #333; border-radius: 8px;
        color: #eee; font-size: 14px; margin-bottom: 16px;
        font-family: inherit; box-sizing: border-box;
      }
      .kn-feedback-email:focus { outline: none; border-color: #e94560; }

      .kn-feedback-context-hint {
        background: #16213e; border-radius: 6px; padding: 8px 12px;
        margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
      }
      .kn-feedback-context-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #4ecca3;
        flex-shrink: 0;
      }
      .kn-feedback-context-text { color: #888; font-size: 12px; }

      .kn-feedback-submit {
        width: 100%; padding: 12px; border-radius: 8px; border: none;
        background: #e94560; color: #fff; font-weight: 600; font-size: 14px;
        cursor: pointer; transition: opacity 0.15s;
      }
      .kn-feedback-submit:disabled {
        opacity: 0.4; cursor: not-allowed;
      }
      .kn-feedback-submit:not(:disabled):hover { opacity: 0.9; }

      .kn-feedback-hp {
        position: absolute; left: -9999px; width: 1px; height: 1px;
        overflow: hidden; opacity: 0;
      }

      .kn-feedback-toolbar-item {
        width: 100%; text-align: left; padding: 10px 16px;
        background: none; border: none; color: #ccc;
        cursor: pointer; font-size: 14px;
      }
      .kn-feedback-toolbar-item:hover { background: #1a1a3e; }

      .kn-feedback-session-prompt {
        position: fixed;
        bottom: calc(80px + env(safe-area-inset-bottom, 0px));
        left: 50%;
        transform: translateX(-50%);
        background: #0f0f23;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 10px 20px;
        color: #eee;
        font-size: 14px;
        z-index: 151;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        cursor: pointer;
        max-width: calc(100vw - 24px);
        text-align: center;
        white-space: nowrap;
      }
      .kn-feedback-session-prompt a {
        color: #e94560;
        text-decoration: underline;
        margin-left: 4px;
      }
      .kn-feedback-session-prompt-lobby {
        top: calc(12px + env(safe-area-inset-top, 0px));
        bottom: auto;
      }
      @media (max-width: 600px) {
        .kn-feedback-session-prompt {
          padding: 8px 12px;
          font-size: 13px;
          white-space: normal;
        }
      }
    `;

/** The form's markup. */
export const formHtml = (): string => {
  const categoryButtons = [...CATEGORIES]
    .map(
      ([key, { emoji, label }]) =>
        `<button type="button" class="kn-feedback-cat" data-cat="${key}">${emoji} ${label}</button>`,
    )
    .join('');
  return `
      <div class="kn-feedback-modal" role="dialog" aria-label="Send Feedback">
        <div class="kn-feedback-header">
          <h3>Send Feedback</h3>
          <button class="kn-feedback-close" aria-label="Close">&times;</button>
        </div>
        <div class="kn-feedback-categories">${categoryButtons}</div>
        <label class="kn-feedback-label" for="kn-fb-message">Message</label>
        <textarea class="kn-feedback-textarea" id="kn-fb-message"
          placeholder="${placeholderFor(null)}"></textarea>
        <input class="kn-feedback-email" id="kn-fb-email" type="email"
          placeholder="Email (optional, for follow-up)" />
        <input class="kn-feedback-hp" name="company_fax" tabindex="-1"
          autocomplete="off" aria-hidden="true" />
        <div class="kn-feedback-context-hint">
          <span class="kn-feedback-context-dot"></span>
          <span class="kn-feedback-context-text">Session context will be attached automatically</span>
        </div>
        <button class="kn-feedback-submit" disabled>Send Feedback</button>
      </div>
    `;
};

/** The inline styles this module sets: the fallback toast's, and the menu entry's `display`. */
export interface FeedbackStyle {
  position: string;
  bottom: string;
  left: string;
  transform: string;
  background: string;
  border: string;
  borderRadius: string;
  padding: string;
  color: string;
  fontSize: string;
  zIndex: string;
  boxShadow: string;
  display: string;
}

interface ClassList {
  readonly add: (name: string) => void;
  readonly remove: (name: string) => void;
  readonly toggle: (name: string, force?: boolean) => boolean;
  readonly contains: (name: string) => boolean;
}

/** A click, as far as this module reads it. */
interface ClickView {
  readonly target: object | null;
  readonly preventDefault: () => void;
}

type OnClick = (type: 'click', listener: (event: ClickView) => void, options?: { once: boolean }) => void;

/** The message box. */
interface MessageBox {
  value: string;
  placeholder: string;
  readonly focus: () => void;
  readonly addEventListener: (type: 'input', listener: () => void) => void;
}

/** The email field and the trap field. */
interface FormInput {
  value: string;
  readonly name: string;
}

/** A button of the form: close, a category, or Send. */
interface FormButton {
  disabled: boolean;
  textContent: string | null;
  readonly classList: ClassList;
  readonly dataset: { readonly cat?: string | undefined };
  readonly addEventListener: OnClick;
}

/** The link in the session prompt. */
interface PromptLink {
  readonly addEventListener: OnClick;
}

/**
 * An element this module creates or finds. `Self` is the page's own element
 * type, so what one element takes as a child is what the page creates.
 */
export interface FeedbackElement<Self> {
  className: string;
  /** Written as a boolean; an element's own `hidden` can also read 'until-found'. */
  hidden: boolean | string;
  innerHTML: string;
  textContent: string | null;
  readonly classList: ClassList;
  readonly style: FeedbackStyle;
  readonly parentNode: object | null;
  readonly setAttribute: (name: string, value: string) => void;
  readonly addEventListener: OnClick;
  readonly appendChild: (child: Self) => void;
  readonly insertBefore: (child: Self, before: Self) => void;
  readonly remove: () => void;
  readonly getElementsByTagName: {
    (tag: 'textarea'): ArrayLike<MessageBox>;
    (tag: 'input'): ArrayLike<FormInput>;
    (tag: 'button'): ArrayLike<FormButton>;
    (tag: 'a'): ArrayLike<PromptLink>;
  };
}

/** A key press, as far as this module reads it. */
interface KeyView {
  readonly key: string;
}

/** The part of `window` the feedback form uses. */
export interface FeedbackHost<E extends FeedbackElement<E>> {
  readonly document: {
    readonly readyState: string;
    readonly head: { readonly appendChild: (child: E) => void };
    readonly body: { readonly appendChild: (child: E) => void };
    readonly createElement: (tag: string) => E;
    readonly getElementById: (id: string) => E | null;
    readonly addEventListener: {
      (type: 'keydown', listener: (event: KeyView) => void): void;
      (type: 'DOMContentLoaded', listener: () => void): void;
    };
  };
  readonly location: { readonly href: string; readonly pathname: string; readonly search: string };
  readonly navigator: { readonly userAgent: string };
  /** Reading it, and every call on it, throws in a browser that blocks storage. */
  readonly localStorage: {
    readonly getItem: (key: string) => string | null;
    readonly setItem: (key: string, value: string) => void;
    readonly removeItem: (key: string) => void;
  };
  readonly Date: { readonly now: () => number };
  readonly MutationObserver: new (onChange: () => void) => {
    readonly observe: (target: E, options: { attributes: boolean; attributeFilter: string[] }) => void;
    readonly disconnect: () => void;
  };
  readonly fetch: (
    url: string,
    init: { method: 'POST'; headers: { 'Content-Type': string }; body: string },
  ) => Promise<{ readonly ok: boolean; readonly status: number }>;
  readonly setTimeout: (handler: () => void, ms: number) => void;
  readonly setInterval: (handler: () => void, ms: number) => void;
  readonly requestAnimationFrame: (callback: () => void) => void;
  readonly matchMedia: (query: string) => { readonly matches: boolean };
  /** The play page's own toast (play.js); without it a toast is drawn here. */
  readonly showToast?: ((message: string) => void) | undefined;
  /** Closes the toolbar's menu the way play.js opened it. */
  readonly KNCloseMoreDropdown?: (() => void) | undefined;
  readonly KNState?: SessionReportView | undefined;
}

/** `window.KNFeedback`: what play.js calls. */
export interface FeedbackApi {
  /** Ask "How was your session?" for a few seconds, with a link to the form. */
  readonly prompt: () => void;
  /** Open the form. */
  readonly open: () => void;
}

/** The form once built: its backdrop and the controls inside it. */
interface Form<E> {
  readonly backdrop: E;
  readonly message: MessageBox;
  readonly email: FormInput;
  readonly trap: FormInput;
  readonly send: FormButton;
  readonly categories: readonly FormButton[];
}

/** The one of `items` that passes `test`. The form's markup is this module's, so each control is there. */
const required = <T>(items: ArrayLike<T>, test: (item: T) => boolean, name: string): T => {
  const found = Array.from(items).find(test);
  if (found === undefined) throw new Error(`feedback form has no ${name}`);
  return found;
};

/**
 * Start the feedback button on a page and return `window.KNFeedback`. The
 * button and the form are built once the document is ready; until then
 * `open` and `prompt` do nothing.
 */
export const startFeedback = <E extends FeedbackElement<E>>(host: FeedbackHost<E>): FeedbackApi => {
  const { document } = host;
  const gamePage = isGamePage(host.location.pathname);
  let selected: Category | null = null;
  let form: Form<E> | null = null;
  let fab: E | null = null;
  let toolbarItem: E | null = null;

  const context = (): FeedbackContext => {
    let playerName: string | null = null;
    try {
      playerName = host.localStorage.getItem('kaillera-name');
    } catch {
      /* storage is blocked: the report goes without a name */
    }
    return gatherContext({
      href: host.location.href,
      pathname: host.location.pathname,
      search: host.location.search,
      userAgent: host.navigator.userAgent,
      now: host.Date.now(),
      playerName,
      state: host.KNState,
    });
  };

  const showToast = (message: string): void => {
    if (typeof host.showToast === 'function') {
      host.showToast(message);
      return;
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '80px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#0f0f23',
      border: '1px solid #333',
      borderRadius: '8px',
      padding: '10px 20px',
      color: '#eee',
      fontSize: '14px',
      zIndex: '100001',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    });
    document.body.appendChild(toast);
    host.setTimeout(() => toast.remove(), 3000);
  };

  /** Send can be pressed once there is a message. */
  const updateSendState = (built: Form<E>): void => {
    built.send.disabled = !built.message.value.trim();
  };

  const open = (): void => {
    if (!form) return;
    const { backdrop, message } = form;
    backdrop.hidden = false;
    // The callback must stay an anonymous function passed straight to the
    // page's requestAnimationFrame: during a match that is the engine's
    // interceptor, which tells the emulator's own frame callback from a
    // page's by its name (KNShared.isMainLoopRunner).
    host.requestAnimationFrame(() => backdrop.classList.add('open'));
    message.focus();
  };

  const close = (): void => {
    if (!form) return;
    const { backdrop } = form;
    backdrop.classList.remove('open');
    host.setTimeout(() => {
      backdrop.hidden = true;
    }, 150);
  };

  const submit = async (built: Form<E>): Promise<void> => {
    if (!built.message.value.trim()) return;
    built.send.disabled = true;
    built.send.textContent = 'Sending...';
    const payload = feedbackPayload(
      { category: selected, message: built.message.value, email: built.email.value, trap: built.trap.value },
      context(),
    );
    try {
      const response = await host.fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        close();
        showToast(submitToast(response.status, true));
        selected = null;
        built.message.value = '';
        built.email.value = '';
        built.trap.value = '';
        for (const button of built.categories) button.classList.remove('active');
        built.message.placeholder = placeholderFor(null);
        updateSendState(built);
      } else {
        showToast(submitToast(response.status, false));
      }
    } catch {
      showToast(submitToast(null, false));
    } finally {
      built.send.disabled = false;
      built.send.textContent = 'Send Feedback';
      updateSendState(built);
    }
  };

  const injectStyles = (): void => {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  };

  const createFab = (): void => {
    const button = document.createElement('button');
    button.className = gamePage ? 'kn-feedback-fab kn-feedback-play-fab' : 'kn-feedback-fab';
    button.setAttribute('aria-label', 'Send feedback');
    button.innerHTML = '💬<span class="kn-feedback-fab-tooltip">Send Feedback</span>';
    button.addEventListener('click', open);
    document.body.appendChild(button);
    fab = button;
  };

  const createForm = (): void => {
    const backdrop = document.createElement('div');
    backdrop.className = 'kn-feedback-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    backdrop.innerHTML = formHtml();

    const buttons = backdrop.getElementsByTagName('button');
    const inputs = backdrop.getElementsByTagName('input');
    const built: Form<E> = {
      backdrop,
      message: required(backdrop.getElementsByTagName('textarea'), () => true, 'message box'),
      email: required(inputs, (input) => input.name !== 'company_fax', 'email field'),
      trap: required(inputs, (input) => input.name === 'company_fax', 'trap field'),
      send: required(buttons, (button) => button.classList.contains('kn-feedback-submit'), 'send button'),
      categories: Array.from(buttons).filter((button) => button.classList.contains('kn-feedback-cat')),
    };

    required(buttons, (button) => button.classList.contains('kn-feedback-close'), 'close button').addEventListener(
      'click',
      close,
    );
    for (const button of built.categories) {
      button.addEventListener('click', () => {
        selected = categoryOf(button.dataset.cat);
        for (const other of built.categories) other.classList.toggle('active', other === button);
        built.message.placeholder = placeholderFor(selected);
        updateSendState(built);
      });
    }
    built.message.addEventListener('input', () => updateSendState(built));
    built.send.addEventListener('click', () => void submit(built));

    document.body.appendChild(backdrop);
    form = built;
  };

  /** On the play page: the "Feedback" entry in the toolbar's menu, shown only during a game. */
  const setupToolbarItem = (): void => {
    if (!gamePage) return;
    const dropdown = document.getElementById('more-dropdown');
    if (!dropdown) return;

    const item = document.createElement('button');
    item.className = 'more-option kn-feedback-toolbar-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = 'Feedback';
    item.style.display = 'none';
    item.addEventListener('click', () => {
      if (typeof host.KNCloseMoreDropdown === 'function') host.KNCloseMoreDropdown();
      else dropdown.classList.add('hidden');
      open();
    });

    const endButton = document.getElementById('toolbar-end');
    if (endButton) dropdown.insertBefore(item, endButton);
    else dropdown.appendChild(item);
    toolbarItem = item;
  };

  /** An element that is on the page and not hidden by the `hidden` class. */
  const shown = (id: string): boolean => {
    const element = document.getElementById(id);
    return !!element && !element.classList.contains('hidden');
  };

  const updateFabVisibility = (): void => {
    if (!gamePage || !fab) return;
    const gameActive = shown('toolbar');
    const setupActive = shown('overlay');
    const narrow = host.matchMedia('(max-width: 600px)').matches;
    fab.hidden = fabHidden(gameActive, setupActive, narrow);
    if (toolbarItem) toolbarItem.style.display = gameActive ? '' : 'none';
  };

  /** Call `onChange` whenever the element's classes change. Returns the observer, or null when the element is absent. */
  const watchClasses = (id: string, onChange: () => void) => {
    const element = document.getElementById(id);
    if (!element) return null;
    const observer = new host.MutationObserver(onChange);
    observer.observe(element, { attributes: true, attributeFilter: ['class'] });
    return observer;
  };

  /** Above the lobby overlay the prompt sits at the top, clear of the lobby's buttons. */
  const placePrompt = (prompt: E): void => {
    prompt.classList.toggle('kn-feedback-session-prompt-lobby', gamePage && shown('overlay'));
  };

  const prompt = (): void => {
    if (!fab && !toolbarItem) return;
    const banner = document.createElement('div');
    banner.className = 'kn-feedback-session-prompt';
    banner.innerHTML = 'How was your session? <a href="#">Share feedback</a>';
    placePrompt(banner);
    required(banner.getElementsByTagName('a'), () => true, 'prompt link').addEventListener('click', (event) => {
      event.preventDefault();
      banner.remove();
      open();
    });
    document.body.appendChild(banner);
    const observer = gamePage ? watchClasses('overlay', () => placePrompt(banner)) : null;
    host.setTimeout(() => {
      if (observer) observer.disconnect();
      if (banner.parentNode) banner.remove();
    }, 8000);
  };

  /** On a first visit: the button pulses and says what it is for, until clicked or 6 s have passed. */
  const introduce = (button: E): void => {
    const callout = document.createElement('span');
    callout.className = 'kn-feedback-callout';
    callout.textContent = 'Got feedback? Let us know!';
    button.appendChild(callout);
    button.classList.add('intro');
    host.requestAnimationFrame(() => callout.classList.add('show'));

    const dismiss = (): void => {
      callout.classList.remove('show');
      button.classList.remove('intro');
      try {
        host.localStorage.setItem('kn-feedback-seen', '1');
      } catch {
        /* storage is blocked: the callout shows again on the next visit */
      }
      host.setTimeout(() => callout.remove(), 300);
    };
    host.setTimeout(dismiss, 6000);
    button.addEventListener('click', dismiss, { once: true });
  };

  const init = (): void => {
    injectStyles();
    createFab();
    createForm();
    setupToolbarItem();

    if (gamePage) {
      updateFabVisibility();
      watchClasses('toolbar', updateFabVisibility);
      watchClasses('overlay', updateFabVisibility);
      // The toolbar may not be on the page yet when this runs, so the classes are also polled.
      host.setInterval(updateFabVisibility, 1000);
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && form && !form.backdrop.hidden) close();
    });

    // play.js leaves this flag when a player leaves a game, for the page they land on.
    try {
      if (host.localStorage.getItem('kn-feedback-prompt')) {
        host.localStorage.removeItem('kn-feedback-prompt');
        host.setTimeout(() => prompt(), 1000);
      }
    } catch {
      /* storage is blocked: no flag to read */
    }

    try {
      if (!gamePage && !host.localStorage.getItem('kn-feedback-seen') && fab) introduce(fab);
    } catch {
      /* storage is blocked: no first-visit callout */
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { prompt, open };
};
