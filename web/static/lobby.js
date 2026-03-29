(function () {
  'use strict';

  const { get: _sg, set: _ss, remove: _sr } = KNStorage;

  // Recover pending sync logs from a previous game session that closed unexpectedly
  try {
    const pending = _sg('localStorage', 'kn-pending-log');
    if (pending) {
      _sr('localStorage', 'kn-pending-log');
      const { room, slot, logs } = JSON.parse(pending);
      if (logs) {
        // NOTE: intentionally fire-and-forget .then() — best-effort log recovery at page load
        const token = _sg('localStorage', 'kn-upload-token') || '';
        fetch(
          `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=recovery&token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            body: logs,
            headers: { 'Content-Type': 'text/plain' },
          },
        )
          .then(() => console.log('[lobby] recovered pending sync log'))
          .catch(() => {});
      }
    }
  } catch (_) {}

  const nameInput = document.getElementById('player-name');
  const codeInput = document.getElementById('room-code');

  // Restore saved name
  const savedName = _sg('localStorage', 'kaillera-name');
  if (savedName) nameInput.value = savedName;

  const getName = () => nameInput.value.trim() || 'Player';

  const getCode = () => {
    let val = codeInput.value.trim();
    // Extract room code from full URL
    if (val.includes('room=')) {
      const match = val.match(/room=([A-Za-z0-9]+)/);
      if (match) val = match[1];
    }
    return val.toUpperCase();
  };

  const randomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, (byte) => chars[byte % chars.length]).join('');
  };

  const saveName = () => {
    _ss('localStorage', 'kaillera-name', getName());
  };

  document.getElementById('create-btn').addEventListener('click', () => {
    saveName();
    const code = randomCode();
    window.location.href = `/play.html?room=${code}&host=1&name=${encodeURIComponent(getName())}&mode=lockstep`;
  });

  document.getElementById('join-btn').addEventListener('click', () => {
    const code = getCode();
    if (!code) {
      codeInput.focus();
      return;
    }
    saveName();
    window.location.href = `/play.html?room=${code}&name=${encodeURIComponent(getName())}`;
  });

  document.getElementById('watch-btn').addEventListener('click', () => {
    const code = getCode();
    if (!code) {
      codeInput.focus();
      return;
    }
    saveName();
    window.location.href = `/play.html?room=${code}&name=${encodeURIComponent(getName())}&spectate=1`;
  });

  // EmuLinker admin welcome — enter as "Moosehead"
  const ADMIN_NAMES = ['moosehead', 'suprafast', 'agent 21', 'agent21', 'knitephox', 'near', 'firo'];
  const showLobbyToast = (msg) => {
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed',
      bottom: '60px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#1a1a2e',
      border: '1px solid #333',
      borderRadius: '8px',
      padding: '10px 20px',
      color: '#0f8',
      fontFamily: "'Courier New', monospace",
      fontSize: '13px',
      zIndex: '99999',
      whiteSpace: 'nowrap',
      transition: 'opacity 0.3s',
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3000);
  };
  nameInput.addEventListener('change', () => {
    if (ADMIN_NAMES.includes(nameInput.value.trim().toLowerCase())) {
      showLobbyToast('Welcome admin. Type /help for commands.');
    }
  });

  // HELLO → HELLOD00D: type "HELLO" in the room code field (Kaillera protocol handshake)
  (() => {
    codeInput.addEventListener('input', () => {
      if (codeInput.value.toUpperCase() === 'HELLO') {
        codeInput.value = '';
        showHELLOD00D();
      }
    });
    const showHELLOD00D = () => {
      const el = document.createElement('div');
      el.id = 'kn-konami';
      el.innerHTML = `
        <style>
          #kn-konami{position:fixed;inset:0;background:rgba(0,0,0,.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;animation:kn-flick .3s ease-out;cursor:pointer}
          #kn-konami::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,136,.06) 2px,rgba(0,255,136,.06) 4px);pointer-events:none;animation:kn-scan .1s linear infinite}
          #kn-konami::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 60%,rgba(0,0,0,.7) 100%);pointer-events:none}
          @keyframes kn-flick{0%{opacity:1}3%{opacity:.7}6%{opacity:1}9%{opacity:.85}12%{opacity:1}50%{opacity:1}52%{opacity:.9}54%{opacity:1}}
          @keyframes kn-scan{to{background-position:0 4px}}
          @keyframes kn-pop{0%{transform:scale(.5);opacity:0}50%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
          @keyframes kn-glow{0%,100%{text-shadow:0 0 10px #0f8,0 0 20px #0f8,0 0 40px #0f8}50%{text-shadow:0 0 20px #0f8,0 0 40px #0f8,0 0 80px #0f8}}
          .kn-k-hero{font-family:'Courier New',monospace;font-size:48px;font-weight:bold;color:#0f8;animation:kn-pop .5s ease-out,kn-glow 2s ease-in-out infinite;letter-spacing:4px;margin-bottom:20px}
          .kn-k-sub{font-family:'Courier New',monospace;font-size:14px;color:#0a6;opacity:.8;margin-bottom:4px}
          .kn-k-credits{font-family:'Courier New',monospace;font-size:12px;color:#064;margin-top:16px;text-align:center;line-height:2}
          .kn-k-credits b{color:#0f8;font-weight:normal}
          .kn-k-v09{font-family:'Courier New',monospace;font-size:11px;color:#042;margin-top:24px}
          .kn-k-hint{position:absolute;bottom:20px;font-size:11px;color:#333}
        </style>
        <div class="kn-k-hero">HELLOD00D</div>
        <div class="kn-k-sub">Server Connection Response &mdash; port: 27888</div>
        <div class="kn-k-credits">
          <b>Kaillera</b> (2001) by Christophe Thibault<br>
          <b>EmuLinker</b> by Moosehead &middot; <b>EmuLinkerSF</b> by Suprafast<br>
          <b>EmuLinker X</b> by Moosehead, Suprafast, Near, Firo &amp; <b>Agent 21</b><br>
          <b>EmuLinker-K</b> &middot; <b>SupraClient</b> &middot; <b>n02</b> &middot; <b>Open Kaillera</b><br>
          <b>Kaillera Reborn</b> &middot; <b>RMG-K</b> &middot; <b>Project64k</b><br>
          <br>
          <b>kaillera-next</b> &mdash; continuing the legacy
        </div>
        <div class="kn-k-v09">v0.9 forever</div>
        <div class="kn-k-hint">press any key or click to close</div>
      `;
      document.body.appendChild(el);
      const close = () => {
        el.remove();
        document.removeEventListener('keydown', close);
      };
      el.addEventListener('click', close);
      setTimeout(() => document.addEventListener('keydown', close, { once: true }), 100);
    };
  })();

  // Auto-extract code from pasted URL
  codeInput.addEventListener('paste', () => {
    setTimeout(() => {
      const val = codeInput.value;
      if (val.includes('room=')) {
        const match = val.match(/room=([A-Za-z0-9]+)/);
        if (match) codeInput.value = match[1].toUpperCase();
      }
    }, 0);
  });
})();
