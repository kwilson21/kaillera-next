(function () {
  'use strict';

  // Recover pending sync logs from a previous game session that closed unexpectedly
  try {
    const pending = localStorage.getItem('kn-pending-log');
    if (pending) {
      localStorage.removeItem('kn-pending-log');
      const { room, slot, logs } = JSON.parse(pending);
      if (logs) {
        fetch(`/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=recovery`, {
          method: 'POST', body: logs, headers: { 'Content-Type': 'text/plain' },
        }).then(() => console.log('[lobby] recovered pending sync log'))
          .catch(() => {});
      }
    }
  } catch (_) {}

  const nameInput = document.getElementById('player-name');
  const codeInput = document.getElementById('room-code');

  // Restore saved name
  const savedName = localStorage.getItem('kaillera-name');
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
    localStorage.setItem('kaillera-name', getName());
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
