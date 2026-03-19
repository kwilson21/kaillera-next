(function () {
  'use strict';

  var nameInput = document.getElementById('player-name');
  var codeInput = document.getElementById('room-code');

  // Restore saved name
  var savedName = localStorage.getItem('kaillera-name');
  if (savedName) nameInput.value = savedName;

  function getName() {
    return nameInput.value.trim() || 'Player';
  }

  function getCode() {
    var val = codeInput.value.trim();
    // Extract room code from full URL
    if (val.includes('room=')) {
      var match = val.match(/room=([A-Za-z0-9]+)/);
      if (match) val = match[1];
    }
    return val.toUpperCase();
  }

  function randomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function saveName() {
    localStorage.setItem('kaillera-name', getName());
  }

  document.getElementById('create-btn').addEventListener('click', function () {
    saveName();
    var code = randomCode();
    window.location.href = '/play.html?room=' + code +
      '&host=1&name=' + encodeURIComponent(getName()) +
      '&mode=lockstep-v4';
  });

  document.getElementById('join-btn').addEventListener('click', function () {
    var code = getCode();
    if (!code) { codeInput.focus(); return; }
    saveName();
    window.location.href = '/play.html?room=' + code +
      '&name=' + encodeURIComponent(getName());
  });

  document.getElementById('watch-btn').addEventListener('click', function () {
    var code = getCode();
    if (!code) { codeInput.focus(); return; }
    saveName();
    window.location.href = '/play.html?room=' + code +
      '&name=' + encodeURIComponent(getName()) +
      '&spectate=1';
  });

  // Auto-extract code from pasted URL
  codeInput.addEventListener('paste', function () {
    setTimeout(function () {
      var val = codeInput.value;
      if (val.includes('room=')) {
        var match = val.match(/room=([A-Za-z0-9]+)/);
        if (match) codeInput.value = match[1].toUpperCase();
      }
    }, 0);
  });
})();
