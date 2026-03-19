/**
 * play.js — Play Page Controller
 *
 * Owns the Socket.IO connection, pre-game overlay, notifications,
 * in-game toolbar. Orchestrates: lobby → playing → end/leave.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  var socket = null;
  var roomCode = null;
  var playerName = null;
  var isHost = false;
  var isSpectator = false;
  var mode = 'lockstep-v4';
  var mySlot = null;
  var lastUsersData = null;
  var engine = null;
  var gameRunning = false;
  var gamepadInterval = null;
  var previousPlayers = {};
  var previousSpectators = {};

  // ── URL Params ─────────────────────────────────────────────────────────

  function parseParams() {
    var params = new URLSearchParams(window.location.search);
    roomCode = params.get('room');
    isHost = params.get('host') === '1';
    playerName = params.get('name') || localStorage.getItem('kaillera-name') || 'Player';
    mode = params.get('mode') || 'lockstep-v4';
    isSpectator = params.get('spectate') === '1';
  }

  // ── Socket.IO ──────────────────────────────────────────────────────────

  function connect() {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

    socket.on('connect', onConnect);
    socket.on('connect_error', function (e) {
      if (!gameRunning) {
        showError('Connection error: ' + e.message);
      } else {
        showToast('Connection lost — returning to lobby...');
        setTimeout(function () { window.location.href = '/'; }, 2000);
      }
    });
    socket.on('users-updated', onUsersUpdated);
    socket.on('game-started', onGameStarted);
    socket.on('game-ended', onGameEnded);
  }

  function onConnect() {
    if (isHost) {
      socket.emit('open-room', {
        extra: {
          sessionid: roomCode,
          playerId: socket.id,
          player_name: playerName,
          room_name: playerName + "'s room",
          game_id: 'ssb64',
          domain: window.location.hostname,
        },
        maxPlayers: 4,
      }, function (err) {
        if (err) { showError('Failed to create room: ' + err); return; }
        mySlot = 0;
        showOverlay();
      });
    } else {
      // Non-host: check room exists, then join
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/room/' + encodeURIComponent(roomCode));
      xhr.onload = function () {
        if (xhr.status !== 200) {
          showError('Room not found. <a href="/">Back to lobby</a>');
          return;
        }
        var roomData = JSON.parse(xhr.responseText);

        socket.emit('join-room', {
          extra: {
            sessionid: roomCode,
            userid: socket.id,
            player_name: playerName,
            spectate: isSpectator,
          },
        }, function (err, joinData) {
          if (err) { showError('Failed to join: ' + err); return; }

          if (!isSpectator && joinData && joinData.players) {
            var entries = Object.values(joinData.players);
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].socketId === socket.id) {
                mySlot = entries[i].slot;
                break;
              }
            }
          } else if (isSpectator) {
            mySlot = null;
          }

          // Mid-game join handling
          if (roomData.status === 'playing') {
            if (isSpectator) {
              // Spectator joining mid-game: skip overlay, init engine immediately
              gameRunning = true;
              showToolbar();
              initEngine();
              return;
            } else {
              // Player joining mid-game (late join): init engine, it handles state transfer
              gameRunning = true;
              showToolbar();
              initEngine();
              return;
            }
          }

          showOverlay();
        });
      };
      xhr.onerror = function () {
        showError('Room not found. <a href="/">Back to lobby</a>');
      };
      xhr.send();
    }
  }

  // ── Users Updated ──────────────────────────────────────────────────────

  function onUsersUpdated(data) {
    lastUsersData = data;
    var players = data.players || {};
    var spectators = data.spectators || {};

    // Update my slot
    var entries = Object.values(players);
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].socketId === socket.id) {
        mySlot = entries[i].slot;
        break;
      }
    }

    // Diff for toasts
    diffForToasts(players, spectators);
    previousPlayers = JSON.parse(JSON.stringify(players));
    previousSpectators = JSON.parse(JSON.stringify(spectators));

    // Update overlay UI if in pre-game
    if (!gameRunning) {
      updatePlayerList(players, spectators);
      updateStartButton(players);
    }
  }

  function diffForToasts(players, spectators) {
    // Skip first update
    if (Object.keys(previousPlayers).length === 0 &&
        Object.keys(previousSpectators).length === 0) return;

    var pid;
    for (pid in players) {
      if (!previousPlayers[pid] && !previousSpectators[pid]) {
        showToast(players[pid].playerName + ' joined');
      }
    }
    for (pid in previousPlayers) {
      if (!players[pid] && !spectators[pid]) {
        showToast(previousPlayers[pid].playerName + ' left');
      }
    }
    for (pid in spectators) {
      if (!previousSpectators[pid] && !previousPlayers[pid]) {
        showToast(spectators[pid].playerName + ' is watching');
      }
    }
    for (pid in previousSpectators) {
      if (!spectators[pid] && !players[pid]) {
        showToast(previousSpectators[pid].playerName + ' left');
      }
    }
  }

  // ── Game Lifecycle ─────────────────────────────────────────────────────

  function onGameStarted(data) {
    mode = data.mode || mode;
    gameRunning = true;
    hideOverlay();
    showToolbar();
    initEngine();
  }

  function onGameEnded() {
    gameRunning = false;
    if (engine) {
      engine.stop();
      engine = null;
    }
    hideToolbar();
    showOverlay();
  }

  function initEngine() {
    var Engine = mode === 'streaming'
      ? window.NetplayStreaming
      : window.NetplayLockstepV4;

    if (!Engine) {
      showError('Netplay engine not loaded');
      return;
    }

    engine = Engine;
    engine.init({
      socket: socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      isSpectator: isSpectator,
      playerName: playerName,
      gameElement: document.getElementById('game'),
      onStatus: function (msg) {
        var el = document.getElementById('engine-status');
        if (el) el.textContent = msg;
      },
      onPlayersChanged: function () {
        // Engine forwards users-updated — supplementary to our direct listener
      },
      initialPlayers: lastUsersData,
    });
  }

  function startGame() {
    var sel = document.getElementById('mode-select');
    var selectedMode = sel ? sel.value : mode;
    socket.emit('start-game', { mode: selectedMode });
  }

  function endGame() {
    socket.emit('end-game', {}, function (err) {
      if (err) {
        console.log('[play] end-game error:', err);
        showToast('End game failed: ' + err);
      }
    });
  }

  function leaveGame() {
    socket.emit('leave-room', {});
    if (engine) { engine.stop(); engine = null; }
    window.location.href = '/';
  }

  // ── UI: Overlay ────────────────────────────────────────────────────────

  function showOverlay() {
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('hidden');

    var roomDisplay = document.getElementById('room-display');
    if (roomDisplay) roomDisplay.textContent = roomCode;

    var hostControls = document.getElementById('host-controls');
    var guestStatus = document.getElementById('guest-status');

    if (isHost) {
      if (hostControls) hostControls.style.display = '';
      if (guestStatus) guestStatus.style.display = 'none';
    } else {
      if (hostControls) hostControls.style.display = 'none';
      if (guestStatus) guestStatus.style.display = '';
    }

    var modeSel = document.getElementById('mode-select');
    if (modeSel) modeSel.value = mode;
  }

  function hideOverlay() {
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function updatePlayerList(players, spectators) {
    for (var i = 0; i < 4; i++) {
      var slotEl = document.querySelector('.player-slot[data-slot="' + i + '"]');
      if (!slotEl) continue;
      var nameEl = slotEl.querySelector('.name');
      if (!nameEl) continue;

      var playerInSlot = null;
      var entries = Object.values(players);
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].slot === i) { playerInSlot = entries[j]; break; }
      }

      if (playerInSlot) {
        nameEl.textContent = playerInSlot.playerName;
        nameEl.classList.remove('empty');
      } else {
        nameEl.textContent = 'Open';
        nameEl.classList.add('empty');
      }
    }

    var specEl = document.getElementById('spectator-list');
    if (specEl) {
      var specNames = Object.values(spectators).map(function (s) { return s.playerName; });
      specEl.textContent = specNames.length > 0 ? 'Watching: ' + specNames.join(', ') : '';
    }
  }

  function updateStartButton(players) {
    var btn = document.getElementById('start-btn');
    if (!btn || !isHost) return;
    var playerCount = Object.keys(players).length;
    btn.disabled = playerCount < 2;
    btn.textContent = playerCount < 2 ? 'Start Game (need 2+)' : 'Start Game';
  }

  // ── UI: Toolbar ────────────────────────────────────────────────────────

  function showToolbar() {
    var toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    var roomEl = document.getElementById('toolbar-room');
    if (roomEl) roomEl.textContent = 'Room: ' + roomCode;

    var endBtn = document.getElementById('toolbar-end');
    if (endBtn) endBtn.style.display = isHost ? '' : 'none';

    var syncBtn = document.getElementById('toolbar-sync');
    if (syncBtn) syncBtn.style.display = isHost ? '' : 'none';
  }

  function hideToolbar() {
    var toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.add('hidden');
  }

  // ── UI: Toast Notifications ───────────────────────────────────────────

  function showToast(msg) {
    var container = document.getElementById('toast-container');
    if (!container) return;

    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('fade-out');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 2700);
  }

  // ── UI: Error ──────────────────────────────────────────────────────────

  function showError(msg) {
    var el = document.getElementById('error-msg');
    if (!el) return;
    el.classList.remove('hidden');
    var card = el.querySelector('.error-card');
    if (card) card.innerHTML = '<h3>Error</h3><p>' + msg + '</p><a href="/" class="error-back">Back to Lobby</a>';
  }

  // ── UI: Copy Link ─────────────────────────────────────────────────────

  function copyLink() {
    var url = window.location.origin + '/play.html?room=' + roomCode;
    // navigator.clipboard requires HTTPS; use execCommand fallback for HTTP
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () {
        showToast('Link copied!');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link copied!');
    }
  }

  // ── Gamepad Detection ─────────────────────────────────────────────────

  function startGamepadPolling() {
    gamepadInterval = setInterval(function () {
      var gamepads = navigator.getGamepads();
      var detected = null;
      for (var i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) { detected = gamepads[i]; break; }
      }
      var el = document.getElementById('gamepad-status');
      if (el) {
        if (detected) {
          el.textContent = 'Controller detected: ' + detected.id;
          el.className = 'gamepad-detected';
        } else {
          el.textContent = 'No controller detected';
          el.className = '';
        }
      }
    }, 1000);
  }

  // ── Init ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    parseParams();
    if (!roomCode) {
      window.location.href = '/';
      return;
    }

    // Wire up buttons
    var startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.addEventListener('click', startGame);

    var leaveBtn = document.getElementById('leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', leaveGame);

    var toolbarLeave = document.getElementById('toolbar-leave');
    if (toolbarLeave) toolbarLeave.addEventListener('click', leaveGame);

    var toolbarEnd = document.getElementById('toolbar-end');
    if (toolbarEnd) toolbarEnd.addEventListener('click', endGame);

    var copyBtn = document.getElementById('copy-link');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    var syncBtn = document.getElementById('toolbar-sync');
    if (syncBtn) syncBtn.addEventListener('click', function () {
      if (engine && engine.setSyncEnabled) {
        var nowOn = !engine.isSyncEnabled();
        engine.setSyncEnabled(nowOn);
        syncBtn.textContent = 'Rollback: ' + (nowOn ? 'On' : 'Off');
        showToast('Rollback ' + (nowOn ? 'enabled' : 'disabled') + ' (experimental)');
      }
    });

    connect();
    startGamepadPolling();
  });
})();
