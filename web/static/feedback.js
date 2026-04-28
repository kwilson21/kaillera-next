/* feedback.js — Floating feedback button + modal form.
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
    style.textContent = `
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
          `<button type="button" class="kn-feedback-cat" data-cat="${key}">${emoji} ${label}</button>`,
      )
      .join('');

    backdrop.innerHTML = `
      <div class="kn-feedback-modal" role="dialog" aria-label="Send Feedback">
        <div class="kn-feedback-header">
          <h3>Send Feedback</h3>
          <button class="kn-feedback-close" aria-label="Close">&times;</button>
        </div>
        <div class="kn-feedback-categories">${categoryButtons}</div>
        <label class="kn-feedback-label" for="kn-fb-message">Message</label>
        <textarea class="kn-feedback-textarea" id="kn-fb-message"
          placeholder="Select a category above..."></textarea>
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
    modal.querySelector('.kn-feedback-submit').disabled = !_selectedCategory || !msg;
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
    if (!_selectedCategory || !msg) return;

    btn.disabled = true;
    btn.textContent = 'Sending...';

    const payload = {
      category: _selectedCategory,
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
        modal.querySelector('.kn-feedback-textarea').placeholder = 'Select a category above...';
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
