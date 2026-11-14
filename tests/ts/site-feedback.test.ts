import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  categoryOf,
  detectPage,
  fabHidden,
  feedbackPayload,
  formHtml,
  gatherContext,
  isGamePage,
  placeholderFor,
  startFeedback,
  submitToast,
  type FeedbackApi,
  type FeedbackHost,
  type FeedbackStyle,
  type SessionReportView,
} from '../../web/src/site/feedback.ts';

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/feedback.js as of #166, unchanged.
const OLD_SCRIPT = `/* feedback.js — Floating feedback button + modal form.
   Loaded on all pages. IIFE pattern (no ES modules). */
(() => {
  'use strict';

  // ── Configuration ───────────────────────────────────────────────────
  const CATEGORY_LABELS = {
    bug: { emoji: '🐛', label: 'Bug Report', placeholder: 'What happened? Steps to reproduce if possible...' },
    feature: { emoji: '💡', label: 'Feature', placeholder: 'What would you like to see?' },
    general: { emoji: '💬', label: 'General', placeholder: "What's on your mind?" },
  };

  let _selectedCategory = null;
  let _modal = null;
  let _fab = null;
  let _toolbarItem = null;
  const _isGamePage = window.location.pathname.includes('/play');

  // ── Context gathering ───────────────────────────────────────────────
  const _gatherContext = () => {
    const ctx = {
      url: window.location.href,
      page: _detectPage(),
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
    };
    try {
      const name = localStorage.getItem('kaillera-name');
      if (name) ctx.playerName = name;
    } catch (_) {}

    const ks = window.KNState;
    if (ks) {
      if (ks.room) ctx.roomCode = ks.room;
      // Links the report to its match so the server keeps that match's logs.
      if (ks.matchId) ctx.matchId = ks.matchId;
      if (ks.slot != null) ctx.playerSlot = ks.slot;
      if (ks.peers) {
        const peers = Object.values(ks.peers);
        ctx.peerCount = peers.length;
        const states = {};
        for (const p of peers) {
          if (p.pc) states[p.sid || 'unknown'] = p.pc.connectionState || 'unknown';
        }
        if (Object.keys(states).length) ctx.peerStates = states;
      }
      if (ks.sessionStats) ctx.sessionStats = { ...ks.sessionStats };
    }
    const mode = new URLSearchParams(window.location.search).get('mode');
    if (mode) ctx.mode = mode;

    return ctx;
  };

  const _detectPage = () => {
    const path = window.location.pathname;
    if (path.includes('play.html')) return 'game';
    const params = new URLSearchParams(window.location.search);
    if (params.get('room')) return 'lobby';
    return 'home';
  };

  // ── DOM creation ────────────────────────────────────────────────────
  const _injectStyles = () => {
    const style = document.createElement('style');
    style.textContent = \`
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
    \`;
    document.head.appendChild(style);
  };

  const _createFAB = () => {
    _fab = document.createElement('button');
    _fab.className = _isGamePage ? 'kn-feedback-fab kn-feedback-play-fab' : 'kn-feedback-fab';
    _fab.setAttribute('aria-label', 'Send feedback');
    _fab.innerHTML = '💬<span class="kn-feedback-fab-tooltip">Send Feedback</span>';
    _fab.addEventListener('click', _openModal);
    document.body.appendChild(_fab);
  };

  const _createModal = () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'kn-feedback-backdrop';
    backdrop.hidden = true;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) _closeModal();
    });

    const categoryButtons = Object.entries(CATEGORY_LABELS)
      .map(
        ([key, { emoji, label }]) =>
          \`<button type="button" class="kn-feedback-cat" data-cat="\${key}">\${emoji} \${label}</button>\`,
      )
      .join('');

    backdrop.innerHTML = \`
      <div class="kn-feedback-modal" role="dialog" aria-label="Send Feedback">
        <div class="kn-feedback-header">
          <h3>Send Feedback</h3>
          <button class="kn-feedback-close" aria-label="Close">&times;</button>
        </div>
        <div class="kn-feedback-categories">\${categoryButtons}</div>
        <label class="kn-feedback-label" for="kn-fb-message">Message</label>
        <textarea class="kn-feedback-textarea" id="kn-fb-message"
          placeholder="\${CATEGORY_LABELS.general.placeholder}"></textarea>
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
    \`;

    backdrop.querySelector('.kn-feedback-close').addEventListener('click', _closeModal);

    for (const btn of backdrop.querySelectorAll('.kn-feedback-cat')) {
      btn.addEventListener('click', () => {
        _selectedCategory = btn.dataset.cat;
        for (const b of backdrop.querySelectorAll('.kn-feedback-cat')) {
          b.classList.toggle('active', b === btn);
        }
        const ta = backdrop.querySelector('.kn-feedback-textarea');
        ta.placeholder = CATEGORY_LABELS[_selectedCategory].placeholder;
        _updateSubmitState(backdrop);
      });
    }

    const textarea = backdrop.querySelector('.kn-feedback-textarea');
    textarea.addEventListener('input', () => _updateSubmitState(backdrop));

    backdrop.querySelector('.kn-feedback-submit').addEventListener('click', () => _submit(backdrop));

    document.body.appendChild(backdrop);
    _modal = backdrop;
  };

  const _updateSubmitState = (modal) => {
    const msg = modal.querySelector('.kn-feedback-textarea').value.trim();
    modal.querySelector('.kn-feedback-submit').disabled = !msg;
  };

  const _openModal = () => {
    if (!_modal) return;
    _modal.hidden = false;
    requestAnimationFrame(() => _modal.classList.add('open'));
    _modal.querySelector('.kn-feedback-textarea').focus();
  };

  const _closeModal = () => {
    if (!_modal) return;
    _modal.classList.remove('open');
    setTimeout(() => {
      _modal.hidden = true;
    }, 150);
  };

  const _submit = async (modal) => {
    const btn = modal.querySelector('.kn-feedback-submit');
    const msg = modal.querySelector('.kn-feedback-textarea').value.trim();
    if (!msg) return;

    btn.disabled = true;
    btn.textContent = 'Sending...';

    const payload = {
      category: _selectedCategory || 'general',
      message: msg,
      email: modal.querySelector('.kn-feedback-email').value.trim() || null,
      company_fax: modal.querySelector('[name="company_fax"]').value,
      page: _detectPage(),
      context: _gatherContext(),
    };

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        _closeModal();
        _showToast('Thanks for your feedback!');
        _selectedCategory = null;
        modal.querySelector('.kn-feedback-textarea').value = '';
        modal.querySelector('.kn-feedback-email').value = '';
        modal.querySelector('[name="company_fax"]').value = '';
        for (const b of modal.querySelectorAll('.kn-feedback-cat')) b.classList.remove('active');
        modal.querySelector('.kn-feedback-textarea').placeholder = CATEGORY_LABELS.general.placeholder;
        _updateSubmitState(modal);
      } else if (res.status === 429) {
        _showToast('Please wait before submitting again');
      } else {
        _showToast('Submission failed, please try again');
      }
    } catch (_) {
      _showToast('Submission failed, please try again');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Feedback';
      _updateSubmitState(modal);
    }
  };

  const _showToast = (msg) => {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
      return;
    }
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
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
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  };

  const _setupToolbarItem = () => {
    if (!_isGamePage) return;

    const dropdown = document.getElementById('more-dropdown');
    if (!dropdown) return;

    _toolbarItem = document.createElement('button');
    _toolbarItem.className = 'more-option kn-feedback-toolbar-item';
    _toolbarItem.setAttribute('role', 'menuitem');
    _toolbarItem.textContent = 'Feedback';
    _toolbarItem.style.display = 'none';
    _toolbarItem.addEventListener('click', () => {
      if (typeof window.KNCloseMoreDropdown === 'function') window.KNCloseMoreDropdown();
      else dropdown.classList.add('hidden');
      _openModal();
    });

    const endBtn = document.getElementById('toolbar-end');
    if (endBtn) {
      dropdown.insertBefore(_toolbarItem, endBtn);
    } else {
      dropdown.appendChild(_toolbarItem);
    }
  };

  const _updateFABVisibility = () => {
    if (!_isGamePage || !_fab) return;
    const toolbar = document.getElementById('toolbar');
    const gameActive = toolbar && !toolbar.classList.contains('hidden');
    const overlay = document.getElementById('overlay');
    const setupActive = overlay && !overlay.classList.contains('hidden');
    const narrow = window.matchMedia('(max-width: 600px)').matches;
    _fab.hidden = gameActive || (setupActive && narrow);
    if (_toolbarItem) _toolbarItem.style.display = gameActive ? '' : 'none';
  };

  const _init = () => {
    _injectStyles();
    _createFAB();
    _createModal();
    _setupToolbarItem();

    if (_isGamePage) {
      _updateFABVisibility();
      const toolbar = document.getElementById('toolbar');
      if (toolbar) {
        const observer = new MutationObserver(_updateFABVisibility);
        observer.observe(toolbar, { attributes: true, attributeFilter: ['class'] });
      }
      const overlay = document.getElementById('overlay');
      if (overlay) {
        const observer = new MutationObserver(_updateFABVisibility);
        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      }
      // Fallback polling — toolbar may not exist at load time
      setInterval(_updateFABVisibility, 1000);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _modal && !_modal.hidden) _closeModal();
    });

    // Post-game feedback prompt (set by play.js on leave)
    try {
      if (localStorage.getItem('kn-feedback-prompt')) {
        localStorage.removeItem('kn-feedback-prompt');
        setTimeout(() => _promptFeedback(), 1000);
      }
    } catch (_) {}

    // First-visit callout — pulse + tooltip, dismissed on click or after 6s
    try {
      if (!_isGamePage && !localStorage.getItem('kn-feedback-seen') && _fab) {
        const callout = document.createElement('span');
        callout.className = 'kn-feedback-callout';
        callout.textContent = 'Got feedback? Let us know!';
        _fab.appendChild(callout);
        _fab.classList.add('intro');
        requestAnimationFrame(() => callout.classList.add('show'));

        const dismiss = () => {
          callout.classList.remove('show');
          _fab.classList.remove('intro');
          try {
            localStorage.setItem('kn-feedback-seen', '1');
          } catch (_) {}
          setTimeout(() => callout.remove(), 300);
        };
        setTimeout(dismiss, 6000);
        _fab.addEventListener('click', dismiss, { once: true });
      }
    } catch (_) {}
  };

  const _isPregameLobbyActive = () => {
    if (!_isGamePage) return false;
    const overlay = document.getElementById('overlay');
    return !!overlay && !overlay.classList.contains('hidden');
  };

  const _updateSessionPromptPlacement = (el) => {
    if (!el) return;
    el.classList.toggle('kn-feedback-session-prompt-lobby', _isPregameLobbyActive());
  };

  // ── Public API ──────────────────────────────────────────────────────
  // Exposed for play.js to nudge users after games.
  const _promptFeedback = () => {
    if (!_fab && !_toolbarItem) return;
    const el = document.createElement('div');
    el.className = 'kn-feedback-session-prompt';
    el.innerHTML = 'How was your session? <a href="#">Share feedback</a>';
    _updateSessionPromptPlacement(el);
    el.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      el.remove();
      _openModal();
    });
    document.body.appendChild(el);
    const overlay = document.getElementById('overlay');
    let observer = null;
    if (_isGamePage && overlay) {
      observer = new MutationObserver(() => _updateSessionPromptPlacement(el));
      observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
    setTimeout(() => {
      if (observer) observer.disconnect();
      if (el.parentNode) el.remove();
    }, 8000);
  };

  window.KNFeedback = { prompt: _promptFeedback, open: _openModal };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
`;

// ── a page both versions run on ──────────────────────────────────────────────

const blankStyle = (): FeedbackStyle => ({
  position: '',
  bottom: '',
  left: '',
  transform: '',
  background: '',
  border: '',
  borderRadius: '',
  padding: '',
  color: '',
  fontSize: '',
  zIndex: '',
  boxShadow: '',
  display: '',
});

/** What a listener on the fake page is called with. */
interface FakeEvent {
  readonly target: object | null;
  readonly key: string;
  readonly preventDefault: () => void;
}
type FakeListener = (event: FakeEvent) => void;

interface Held {
  readonly type: string;
  readonly listener: FakeListener;
  readonly once: boolean;
}

/** What a test compares of an element: everything either version can set on it. */
interface Snapshot {
  readonly tag: string;
  readonly text: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly value: string;
  readonly style: FeedbackStyle;
  readonly listeners: readonly string[];
  readonly children: readonly Snapshot[];
}

const VOID_TAGS = new Set(['input', 'br', 'img']);
const ENTITIES = new Map([
  ['&times;', '×'],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
]);

/** The page's record of who watches which element's classes, and what has focus. */
class FakePageState {
  active: FakeElement | null = null;
  readonly watchers: { readonly target: FakeElement; readonly onChange: () => void }[] = [];

  classesChanged(target: FakeElement): void {
    for (const watcher of this.watchers.filter((held) => held.target === target)) watcher.onChange();
  }
}

/**
 * An element, as much of one as the two versions use. Attributes are the one
 * store behind `className`, `hidden`, `disabled`, `placeholder`, `name` and
 * `dataset`, as in a browser. A text node is an element with the tag '#text'.
 */
class FakeElement {
  readonly tag: string;
  readonly page: FakePageState;
  readonly attributes = new Map<string, string>();
  readonly style = blankStyle();
  readonly held: Held[] = [];
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  value = '';
  text = '';

  constructor(page: FakePageState, tag: string) {
    this.page = page;
    this.tag = tag;
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', value);
    this.page.classesChanged(this);
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    // A browser coerces whatever is assigned; the old script assigns null at times.
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }
  get placeholder(): string {
    return this.attributes.get('placeholder') ?? '';
  }
  set placeholder(value: string) {
    this.attributes.set('placeholder', value);
  }
  get name(): string {
    return this.attributes.get('name') ?? '';
  }
  get dataset() {
    return { cat: this.attributes.get('data-cat') };
  }

  private classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  readonly classList = {
    contains: (name: string): boolean => this.classes().includes(name),
    add: (name: string): void => {
      if (!this.classes().includes(name)) this.className = [...this.classes(), name].join(' ');
    },
    remove: (name: string): void => {
      if (this.classes().includes(name))
        this.className = this.classes()
          .filter((held) => held !== name)
          .join(' ');
    },
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes().includes(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
  };

  get textContent(): string | null {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string | null) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    if (value) this.appendChild(textNode(this.page, value));
  }

  set innerHTML(html: string) {
    this.textContent = '';
    parseInto(this, html);
  }

  readonly setAttribute = (name: string, value: string): void => {
    this.attributes.set(name, value);
    if (name === 'class') this.page.classesChanged(this);
  };
  readonly appendChild = (child: FakeElement): void => {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
  };
  readonly insertBefore = (child: FakeElement, before: FakeElement): void => {
    child.remove();
    child.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, child);
  };
  readonly remove = (): void => {
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  };
  readonly focus = (): void => {
    this.page.active = this;
  };
  readonly addEventListener = (type: string, listener: FakeListener, options?: { once: boolean }): void => {
    this.held.push({ type, listener, once: options?.once ?? false });
  };

  /** Everything under this element, in document order. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  readonly getElementsByTagName = (tag: string): FakeElement[] =>
    this.descendants().filter((element) => element.tag === tag);
  /** `.class`, `[name="value"]` or a tag name: the selectors the old script uses. */
  readonly querySelectorAll = (selector: string): FakeElement[] => {
    const named = /^\[name="(.*)"\]$/.exec(selector);
    return this.descendants().filter((element) => {
      if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
      if (named) return element.name === named[1];
      return element.tag === selector;
    });
  };
  readonly querySelector = (selector: string): FakeElement | null => this.querySelectorAll(selector)[0] ?? null;

  /** This element, then its ancestors. */
  path(): FakeElement[] {
    return [this, ...(this.parentNode?.path() ?? [])];
  }

  /** Dispatch an event here; a click bubbles to the ancestors it had when it started. */
  fire(type: string): boolean {
    let prevented = false;
    const event: FakeEvent = {
      target: this,
      key: '',
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const at of this.path()) {
      for (const held of at.held.filter((entry) => entry.type === type)) {
        if (held.once) at.held.splice(at.held.indexOf(held), 1);
        held.listener(event);
      }
    }
    return prevented;
  }

  snapshot(): Snapshot {
    return {
      tag: this.tag,
      text: this.text,
      attributes: [...this.attributes].sort(([a], [b]) => a.localeCompare(b)),
      value: this.value,
      style: { ...this.style },
      listeners: this.held.map((held) => `${held.type}${held.once ? ' once' : ''}`),
      children: this.children.map((child) => child.snapshot()),
    };
  }
}

const textNode = (page: FakePageState, text: string): FakeElement => {
  const node = new FakeElement(page, '#text');
  node.text = text;
  return node;
};

/** Parse the markup the two versions write: tags with quoted or bare attributes, text, and a few entities. */
const parseInto = (root: FakeElement, html: string): void => {
  const open: FakeElement[] = [root];
  for (const [token, closing, tag, attributes] of html.matchAll(
    /<(\/?)([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/g,
  )) {
    const parent = open.at(-1) ?? root;
    if (tag === undefined) {
      parent.appendChild(
        textNode(
          root.page,
          token.replaceAll(/&[a-z]+;/g, (entity) => ENTITIES.get(entity) ?? entity),
        ),
      );
    } else if (closing) {
      open.pop();
    } else {
      const element = new FakeElement(root.page, tag);
      for (const [, name, value] of (attributes ?? '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
        if (name !== undefined) element.attributes.set(name, value ?? '');
      }
      parent.appendChild(element);
      if (!VOID_TAGS.has(tag)) open.push(element);
    }
  }
  assert.equal(open.length, 1, `unbalanced markup: ${html}`);
};

/** How a page is set up before either version starts on it. */
interface Setup {
  readonly pathname: string;
  readonly search: string;
  readonly readyState: 'loading' | 'complete';
  /** Which of the play page's own elements exist. */
  readonly toolbar: boolean;
  readonly overlay: boolean;
  readonly dropdown: boolean;
  readonly endButton: boolean;
  readonly stored: readonly (readonly [string, string])[];
  readonly storageBlocked: boolean;
  readonly pageToast: boolean;
  readonly closeDropdown: boolean;
  readonly state: SessionReportView | undefined;
}

/** What the server answers to a report. */
type Answer = 'ok' | 'rate-limited' | 'error' | 'down';

/** What is around the page: the server's next answer, and how wide the screen is. */
interface Surroundings {
  answer: Answer;
  narrow: boolean;
}

/** The fake page's window: the form's host, with the globals a test or a script may set. */
interface FakeWindow extends FeedbackHost<FakeElement> {
  showToast?: (message: string) => void;
  KNCloseMoreDropdown?: () => void;
  KNState?: SessionReportView;
  KNFeedback?: FeedbackApi;
}

const fakePage = (setup: Setup) => {
  const state = new FakePageState();
  const head = new FakeElement(state, 'head');
  const body = new FakeElement(state, 'body');
  const add = (id: string, parent: FakeElement, classes: string): FakeElement => {
    const element = new FakeElement(state, 'div');
    element.attributes.set('id', id);
    element.attributes.set('class', classes);
    parent.appendChild(element);
    return element;
  };
  // The play page as it loads: the lobby overlay up, the toolbar hidden.
  if (setup.overlay) add('overlay', body, '');
  const toolbar = setup.toolbar ? add('toolbar', body, 'hidden') : null;
  const dropdown = setup.dropdown ? add('more-dropdown', toolbar ?? body, 'more-dropdown') : null;
  if (dropdown && setup.endButton) add('toolbar-end', dropdown, 'more-option');

  const documentHeld: Held[] = [];
  const timers: { at: number; readonly every: number | null; readonly run: () => void }[] = [];
  const frames: (() => void)[] = [];
  const clock = { now: 1_700_000_000_000 };
  const stored = new Map(setup.stored);
  const requests: string[] = [];
  const toasts: string[] = [];
  const dropdownCloses: string[] = [];
  const server: Surroundings = { answer: 'ok', narrow: false };
  const blocked = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };

  class FakeObserver {
    readonly onChange: () => void;
    constructor(onChange: () => void) {
      this.onChange = onChange;
    }
    readonly observe = (target: FakeElement, options: { attributes: boolean; attributeFilter: string[] }): void => {
      assert.equal(JSON.stringify(options), '{"attributes":true,"attributeFilter":["class"]}');
      state.watchers.push({ target, onChange: this.onChange });
    };
    readonly disconnect = (): void => {
      for (const watcher of state.watchers.filter((held) => held.onChange === this.onChange)) {
        state.watchers.splice(state.watchers.indexOf(watcher), 1);
      }
    };
  }

  const window: FakeWindow = {
    document: {
      readyState: setup.readyState,
      head,
      body,
      createElement: (tag) => new FakeElement(state, tag),
      getElementById: (id) => body.descendants().find((element) => element.attributes.get('id') === id) ?? null,
      addEventListener: (type: string, listener: FakeListener) => {
        documentHeld.push({ type, listener, once: false });
      },
    },
    location: {
      href: `https://kn.example${setup.pathname}${setup.search}`,
      pathname: setup.pathname,
      search: setup.search,
    },
    navigator: { userAgent: 'FakeBrowser/1.0' },
    localStorage: {
      getItem: (key) => (setup.storageBlocked ? blocked() : (stored.get(key) ?? null)),
      setItem: (key, value) => {
        if (setup.storageBlocked) blocked();
        stored.set(key, value);
      },
      removeItem: (key) => {
        if (setup.storageBlocked) blocked();
        stored.delete(key);
      },
    },
    Date: { now: () => clock.now },
    MutationObserver: FakeObserver,
    fetch: (url, init) => {
      requests.push(`${url} ${init.method} ${JSON.stringify(init.headers)} ${init.body}`);
      if (server.answer === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      if (server.answer === 'ok') return Promise.resolve({ ok: true, status: 200 });
      return Promise.resolve({ ok: false, status: server.answer === 'rate-limited' ? 429 : 500 });
    },
    setTimeout: (run, ms) => {
      timers.push({ at: clock.now + ms, every: null, run });
    },
    setInterval: (run, ms) => {
      timers.push({ at: clock.now + ms, every: ms, run });
    },
    requestAnimationFrame: (callback) => {
      frames.push(callback);
    },
    matchMedia: (query) => {
      assert.equal(query, '(max-width: 600px)');
      return { matches: server.narrow };
    },
  };
  if (setup.pageToast) window.showToast = (message) => void toasts.push(message);
  if (setup.closeDropdown) window.KNCloseMoreDropdown = () => void dropdownCloses.push('closed');
  if (setup.state) window.KNState = setup.state;

  return {
    window,
    body,
    head,
    frames,
    requests,
    toasts,
    server,
    /** Fire a document event at every listener for it. */
    fireDocument: (type: string, key = ''): void => {
      for (const held of documentHeld.filter((entry) => entry.type === type)) {
        held.listener({ target: null, key, preventDefault: () => undefined });
      }
    },
    /** Let time pass: timers that come due run in order, and an interval is set again. */
    advance: (ms: number): void => {
      const until = clock.now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.now = due.at;
        if (due.every === null) timers.splice(timers.indexOf(due), 1);
        else due.at += due.every;
        due.run();
      }
      clock.now = until;
    },
    /** Run the animation-frame callbacks asked for so far. */
    frame: (): void => {
      for (const callback of frames.splice(0)) callback();
    },
    /** Everything a test compares. */
    state: () => ({
      head: head.snapshot(),
      body: body.snapshot(),
      focused: state.active ? body.descendants().indexOf(state.active) : -1,
      requests: [...requests],
      toasts: [...toasts],
      dropdownCloses: dropdownCloses.length,
      stored: [...stored].sort(([a], [b]) => a.localeCompare(b)),
      timers: timers.map((timer) => `${timer.at - clock.now}${timer.every === null ? '' : ' every'}`).sort(),
      frames: frames.length,
      watchers: state.watchers.length,
      documentListeners: documentHeld.map((held) => held.type),
    }),
  };
};

type Page = ReturnType<typeof fakePage>;

/** The old script on a page: its globals are the page's. */
const startOld = (page: Page): void => {
  const { window } = page;
  vm.runInNewContext(OLD_SCRIPT, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    fetch: window.fetch,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    MutationObserver: window.MutationObserver,
    Date: window.Date,
    URLSearchParams,
  });
};

/** The new module, started the way web/static/feedback.js starts it. */
const startNew = (page: Page): void => {
  page.window.KNFeedback = startFeedback(page.window);
};

/** Let a report in flight finish: the request is already settled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

const rng = (seed: number) => {
  // Neighbouring seeds are spread over the whole range first, so their first picks differ.
  let s = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0;
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 0x1_0000_0000) * n);
  };
};

const STATES: readonly (SessionReportView | undefined)[] = [
  undefined,
  { room: null, matchId: null, slot: -1, peers: {}, sessionStats: { reconnects: 0, desyncs: 0, stalls: 0 } },
  {
    room: 'AB12',
    matchId: 'm-7',
    slot: 0,
    peers: {
      s1: { sid: 's1', slot: 1, pc: { connectionState: 'connected' } },
      s2: { sid: '', slot: 2, pc: { connectionState: '' } },
      s3: { sid: 's3', slot: null, pc: null },
      s4: { slot: 3, pc: { connectionState: 'failed' } },
    },
    sessionStats: { reconnects: 2, desyncs: 0, stalls: 1 },
  },
  { room: 'CD34', matchId: null, slot: null, peers: null, sessionStats: null },
];

const setupFor = (pick: (n: number) => number): Setup => {
  const play = pick(2) === 0;
  const dropdown = play && pick(4) !== 0;
  const stored: (readonly [string, string])[] = [];
  if (pick(2) === 0) stored.push(['kaillera-name', 'Fox']);
  if (pick(3) === 0) stored.push(['kn-feedback-prompt', '1']);
  if (pick(2) === 0) stored.push(['kn-feedback-seen', '1']);
  return {
    pathname: play ? '/play.html' : (['/', '/index.html'][pick(2)] ?? '/'),
    search: ['', '?room=AB12', '?room=AB12&mode=rollback', '?mode=streaming'][pick(4)] ?? '',
    readyState: pick(3) === 0 ? 'loading' : 'complete',
    toolbar: play && pick(5) !== 0,
    overlay: play && pick(5) !== 0,
    dropdown,
    endButton: dropdown && pick(3) !== 0,
    stored,
    storageBlocked: pick(6) === 0,
    pageToast: pick(2) === 0,
    closeDropdown: pick(2) === 0,
    state: STATES[pick(STATES.length)],
  };
};

const MESSAGES = ['', '   ', 'It froze on the stage select', '  a < b & "c"  '];
const ANSWERS: readonly Answer[] = ['ok', 'ok', 'rate-limited', 'error', 'down'];
const WAITS = [100, 150, 300, 1000, 3000, 6000, 8000];

/** One thing a visitor, the page or the server does. The same picks drive the old page and the new. */
const step = (page: Page, pick: (n: number) => number): string => {
  const { body } = page;
  const kind = pick(20);
  const clickFirst = (selector: string): string => {
    body.querySelector(selector)?.fire('click');
    return `click ${selector}`;
  };
  if (kind === 0 || kind === 1) return clickFirst('.kn-feedback-fab');
  if (kind === 2) {
    const buttons = body.querySelectorAll('.kn-feedback-cat');
    buttons[pick(Math.max(buttons.length, 1))]?.fire('click');
    return 'category';
  }
  if (kind === 3 || kind === 4) {
    const box = body.querySelector('.kn-feedback-textarea');
    const message = MESSAGES[pick(MESSAGES.length)] ?? '';
    if (box) {
      box.value = message;
      box.fire('input');
    }
    return `message=${JSON.stringify(message)}`;
  }
  if (kind === 5) {
    const email = body.querySelector('.kn-feedback-email');
    const trap = body.querySelector('[name="company_fax"]');
    if (email) email.value = ['', ' fox@example.com '][pick(2)] ?? '';
    if (trap) trap.value = ['', '555'][pick(2)] ?? '';
    return 'email';
  }
  if (kind === 6 || kind === 7) return clickFirst('.kn-feedback-submit');
  if (kind === 8) {
    page.server.answer = ANSWERS[pick(ANSWERS.length)] ?? 'ok';
    return `server=${page.server.answer}`;
  }
  if (kind === 9) return clickFirst('.kn-feedback-close');
  if (kind === 10) return clickFirst(pick(2) === 0 ? '.kn-feedback-backdrop' : '.kn-feedback-modal');
  if (kind === 11) {
    const key = pick(2) === 0 ? 'Escape' : 'a';
    page.fireDocument('keydown', key);
    return `key ${key}`;
  }
  if (kind === 12 || kind === 13) {
    const ms = WAITS[pick(WAITS.length)] ?? 100;
    page.advance(ms);
    return `wait ${ms}`;
  }
  if (kind === 14) {
    page.frame();
    return 'frame';
  }
  if (kind === 15) {
    const id = pick(2) === 0 ? 'toolbar' : 'overlay';
    page.window.document.getElementById(id)?.classList.toggle('hidden');
    return `toggle ${id}`;
  }
  if (kind === 16) {
    page.server.narrow = !page.server.narrow;
    return `narrow=${page.server.narrow}`;
  }
  if (kind === 17) {
    page.window.KNFeedback?.prompt();
    return 'prompt()';
  }
  if (kind === 18) {
    if (pick(2) === 0) {
      page.window.KNFeedback?.open();
      return 'open()';
    }
    return clickFirst('.kn-feedback-toolbar-item');
  }
  const links = body.querySelectorAll('a');
  const prevented = links[pick(Math.max(links.length, 1))]?.fire('click');
  return `prompt link prevented=${prevented}`;
};

test('everything the form does to a page matches the old script, over random sequences', async () => {
  let reports = 0;
  let prompts = 0;
  let callouts = 0;
  let toolbarItems = 0;
  let fallbackToasts = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const setup = setupFor(rng(seed));
    const pages = [fakePage(setup), fakePage(setup)] as const;
    const pickers = [rng(seed * 104729), rng(seed * 104729)] as const;
    startOld(pages[0]);
    startNew(pages[1]);
    assert.deepEqual(Object.keys(pages[1].window.KNFeedback ?? {}), Object.keys(pages[0].window.KNFeedback ?? {}));
    assert.deepEqual(pages[1].state(), pages[0].state(), `seed ${seed} as the script loads`);
    // Called before the document is ready, neither does anything.
    for (const page of pages) {
      page.window.KNFeedback?.open();
      page.window.KNFeedback?.prompt();
      page.fireDocument('DOMContentLoaded');
    }
    assert.deepEqual(pages[1].state(), pages[0].state(), `seed ${seed} once the document is ready`);
    if (pages[1].body.querySelector('.kn-feedback-callout')) callouts++;
    if (pages[1].body.querySelector('.kn-feedback-toolbar-item')) toolbarItems++;
    const script: string[] = [];
    for (let i = 0; i < 40; i++) {
      script.push(step(pages[0], pickers[0]));
      step(pages[1], pickers[1]);
      await settle();
      assert.deepEqual(pages[1].state(), pages[0].state(), `seed ${seed} after ${script.join(' | ')}`);
      if (pages[1].body.querySelector('.kn-feedback-session-prompt')) prompts++;
      if (pages[1].body.children.some((child) => child.style.zIndex === '100001')) fallbackToasts++;
    }
    reports += pages[1].requests.length;
  }
  // The sequences send reports and reach each part of the page, so the comparison is not of idle pages.
  assert.ok(reports > 300, `${reports} reports sent`);
  assert.ok(prompts > 300, `session prompt on the page in ${prompts} states`);
  assert.ok(callouts > 20, `first-visit callout on ${callouts} pages`);
  assert.ok(toolbarItems > 50, `toolbar entry on ${toolbarItems} pages`);
  assert.ok(fallbackToasts > 100, `fallback toast on the page in ${fallbackToasts} states`);
});

// ── the behaviour, stated ────────────────────────────────────────────────────

const FRONT: Setup = {
  pathname: '/',
  search: '',
  readyState: 'complete',
  toolbar: false,
  overlay: false,
  dropdown: false,
  endButton: false,
  stored: [['kn-feedback-seen', '1']],
  storageBlocked: false,
  pageToast: true,
  closeDropdown: false,
  state: undefined,
};
const PLAY: Setup = {
  ...FRONT,
  pathname: '/play.html',
  search: '?room=AB12&mode=rollback',
  toolbar: true,
  overlay: true,
  dropdown: true,
  endButton: true,
  closeDropdown: true,
  state: STATES[2],
};

test('window.KNFeedback keeps its shape', () => {
  const page = fakePage(FRONT);
  startNew(page);
  const api = page.window.KNFeedback;
  assert.ok(api);
  assert.deepEqual(Object.keys(api), ['prompt', 'open']);
  assert.equal(typeof api.prompt, 'function');
  assert.equal(typeof api.open, 'function');
});

test("opening the form asks the page's requestAnimationFrame, with a callback that is not the emulator's runner", () => {
  const page = fakePage(PLAY);
  startNew(page);
  // The engine replaces window.requestAnimationFrame during a match, after
  // this module has started; the form must reach the replacement.
  const seen: (() => void)[] = [];
  Object.assign(page.window, { requestAnimationFrame: (callback: () => void) => void seen.push(callback) });
  page.window.KNFeedback?.open();
  assert.equal(page.frames.length, 0);
  assert.equal(seen.length, 1);
  const callback = seen[0];
  assert.ok(callback);
  // KNShared.isMainLoopRunner (web/static/shared.js) is `cb.name === 'MainLoop_runner'`:
  // the engine's interceptor keeps only that callback and passes every other to the browser.
  assert.equal(callback.name, '');
  const backdrop = page.body.querySelector('.kn-feedback-backdrop');
  assert.ok(backdrop);
  // The form is on screen and focused before the frame; the frame only starts the fade.
  assert.equal(backdrop.hidden, false);
  assert.equal(backdrop.classList.contains('open'), false);
  assert.equal(
    page.state().focused,
    page.body.descendants().indexOf(page.body.querySelector('.kn-feedback-textarea') ?? backdrop),
  );
  callback();
  assert.equal(backdrop.classList.contains('open'), true);
});

test('a report carries the category, the message and the session', async () => {
  const page = fakePage({ ...PLAY, stored: [['kaillera-name', 'Fox']] });
  startNew(page);
  page.body.querySelector('.kn-feedback-fab')?.fire('click');
  page.body.querySelector('.kn-feedback-cat')?.fire('click');
  const box = page.body.querySelector('.kn-feedback-textarea');
  assert.ok(box);
  assert.equal(box.placeholder, 'What happened? Steps to reproduce if possible...');
  box.value = ' It froze ';
  box.fire('input');
  page.body.querySelector('.kn-feedback-submit')?.fire('click');
  await settle();
  assert.deepEqual(page.requests, [
    '/api/feedback POST {"Content-Type":"application/json"} ' +
      JSON.stringify({
        category: 'bug',
        message: 'It froze',
        email: null,
        company_fax: '',
        page: 'game',
        context: {
          url: 'https://kn.example/play.html?room=AB12&mode=rollback',
          page: 'game',
          userAgent: 'FakeBrowser/1.0',
          timestamp: 1_700_000_000_000,
          playerName: 'Fox',
          roomCode: 'AB12',
          matchId: 'm-7',
          playerSlot: 0,
          peerCount: 4,
          peerStates: { s1: 'connected', unknown: 'failed' },
          sessionStats: { reconnects: 2, desyncs: 0, stalls: 1 },
          mode: 'rollback',
        },
      }),
  ]);
  assert.deepEqual(page.toasts, ['Thanks for your feedback!']);
  assert.equal(box.value, '');
  assert.equal(box.placeholder, "What's on your mind?");
});

test('during a game the button gives way to the entry in the toolbar menu', () => {
  const page = fakePage(PLAY);
  startNew(page);
  const fab = page.body.querySelector('.kn-feedback-fab');
  const item = page.body.querySelector('.kn-feedback-toolbar-item');
  const toolbar = page.window.document.getElementById('toolbar');
  assert.ok(fab && item && toolbar);
  assert.equal(fab.hidden, false);
  assert.equal(item.style.display, 'none');
  // The entry sits just above "End game".
  assert.equal(item.parentNode?.children.at(-1)?.attributes.get('id'), 'toolbar-end');
  toolbar.classList.remove('hidden');
  assert.equal(fab.hidden, true);
  assert.equal(item.style.display, '');
  item.fire('click');
  assert.equal(page.state().dropdownCloses, 1);
  assert.equal(page.body.querySelector('.kn-feedback-backdrop')?.hidden, false);
});

test('the pure pieces', () => {
  assert.equal(detectPage('/play.html', ''), 'game');
  assert.equal(detectPage('/', '?room=AB12'), 'lobby');
  assert.equal(detectPage('/', '?room='), 'home');
  assert.equal(detectPage('/index.html', ''), 'home');
  assert.equal(isGamePage('/play.html'), true);
  assert.equal(isGamePage('/play'), true);
  assert.equal(isGamePage('/'), false);
  assert.equal(categoryOf('bug'), 'bug');
  assert.equal(categoryOf('other'), null);
  assert.equal(categoryOf(undefined), null);
  assert.equal(placeholderFor('feature'), 'What would you like to see?');
  assert.equal(placeholderFor(null), placeholderFor('general'));
  assert.equal(submitToast(200, true), 'Thanks for your feedback!');
  assert.equal(submitToast(429, false), 'Please wait before submitting again');
  assert.equal(submitToast(500, false), 'Submission failed, please try again');
  assert.equal(submitToast(null, false), 'Submission failed, please try again');
  for (const gameActive of [false, true]) {
    for (const setupActive of [false, true]) {
      for (const narrow of [false, true]) {
        // `_fab.hidden = gameActive || (setupActive && narrow)` in web/static/feedback.js as of #166.
        assert.equal(fabHidden(gameActive, setupActive, narrow), gameActive || (setupActive && narrow));
      }
    }
  }
  const context = gatherContext({
    href: 'https://kn.example/',
    pathname: '/',
    search: '',
    userAgent: 'UA',
    now: 5,
    playerName: null,
    state: undefined,
  });
  assert.deepEqual(context, { url: 'https://kn.example/', page: 'home', userAgent: 'UA', timestamp: 5 });
  assert.deepEqual(feedbackPayload({ category: null, message: ' hi ', email: ' ', trap: '' }, context), {
    category: 'general',
    message: 'hi',
    email: null,
    company_fax: '',
    page: 'home',
    context,
  });
  assert.match(formHtml(), /<button type="button" class="kn-feedback-cat" data-cat="bug">🐛 Bug Report<\/button>/);
});

test('a real window is a host the feedback form accepts', () => {
  // The caller in web/static is plain script, so the compiler checks the fit here.
  const fits: typeof window extends FeedbackHost<HTMLElement> ? true : false = true;
  assert.ok(fits);
});
