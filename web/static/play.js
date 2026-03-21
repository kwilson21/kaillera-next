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
  var mode = 'lockstep';
  var mySlot = null;
  var lastUsersData = null;
  var engine = null;
  var gameRunning = false;
  var _gameRollbackEnabled = false;
  var previousPlayers = {};
  var previousSpectators = {};
  var _lateJoin = false;
  var _romBlobUrl = null;

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  // ── URL Params ─────────────────────────────────────────────────────────

  function parseParams() {
    var params = new URLSearchParams(window.location.search);
    roomCode = params.get('room');
    isHost = params.get('host') === '1';
    playerName = params.get('name') || localStorage.getItem('kaillera-name') || 'Player';
    mode = params.get('mode') || 'lockstep';
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
    socket.on('room-closed', onRoomClosed);
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
          showError('Room not found');
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
            gameRunning = true;
            _lateJoin = !isSpectator;
            // Use joinData directly — the users-updated socket event may not
            // have arrived yet (ack returns before broadcast is delivered)
            if (joinData) lastUsersData = joinData;
            showToolbar();
            initEngine();
            return;
          }

          showOverlay();
        });
      };
      xhr.onerror = function () {
        showError('Room not found');
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
      updateGamepadSlot();
    }
  }

  function diffForToasts(players, spectators) {
    // Skip first update
    if (Object.keys(previousPlayers).length === 0 &&
        Object.keys(previousSpectators).length === 0) return;

    var pid;
    for (pid in players) {
      if (!previousPlayers[pid] && !previousSpectators[pid]) {
        showToast(escapeHtml(players[pid].playerName) + ' joined');
      }
    }
    for (pid in previousPlayers) {
      if (!players[pid] && !spectators[pid]) {
        showToast(escapeHtml(previousPlayers[pid].playerName) + ' left');
      }
    }
    for (pid in spectators) {
      if (!previousSpectators[pid] && !previousPlayers[pid]) {
        showToast(escapeHtml(spectators[pid].playerName) + ' is watching');
      }
    }
    for (pid in previousSpectators) {
      if (!spectators[pid] && !players[pid]) {
        showToast(escapeHtml(previousSpectators[pid].playerName) + ' left');
      }
    }
  }

  // ── Game Lifecycle ─────────────────────────────────────────────────────

  function onGameStarted(data) {
    mode = data.mode || mode;
    _gameRollbackEnabled = !!data.rollbackEnabled;
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
    destroyEmulator();
    hideToolbar();
    showOverlay();
    // Clear stale engine status
    var statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.textContent = '';
  }

  function onRoomClosed(data) {
    gameRunning = false;
    if (engine) {
      engine.stop();
      engine = null;
    }
    var reason = (data && data.reason) || 'closed';
    var msg = reason === 'host-left' ? 'Host left — returning to lobby...' : 'Room closed';
    showToast(msg);
    setTimeout(function () { window.location.href = '/'; }, 2000);
  }

  function destroyEmulator() {
    // Wipe EmulatorJS from the DOM entirely — clean slate for next game
    var gameEl = document.getElementById('game');
    if (gameEl) gameEl.innerHTML = '';
    window.EJS_emulator = undefined;
  }

  function bootEmulator() {
    // Re-initialize EmulatorJS if it was destroyed
    if (window.EJS_emulator) {
      console.log('[play] bootEmulator: EJS already exists, skipping');
      return;
    }
    if (!_romBlobUrl) {
      console.log('[play] bootEmulator: no ROM loaded');
      showToast('Please load a ROM file first');
      return;
    }
    console.log('[play] bootEmulator: injecting loader.js, gameUrl:', _romBlobUrl.substring(0, 50));
    window.EJS_gameUrl = _romBlobUrl;
    var script = document.createElement('script');
    script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    script.onload = function () { console.log('[play] loader.js loaded'); };
    script.onerror = function () { console.log('[play] loader.js FAILED to load'); };
    document.body.appendChild(script);
  }

  function setupRomDrop() {
    var drop = document.getElementById('rom-drop');
    if (!drop) return;

    var savedRom = localStorage.getItem('kaillera-rom-name');
    var statusEl = document.getElementById('rom-status');

    // Prevent browser from navigating to dropped files anywhere on the page
    document.body.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.body.addEventListener('drop', function (e) { e.preventDefault(); });

    // File input fallback (click to browse)
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.z64,.n64,.v64,.zip';
    fileInput.style.display = 'none';
    drop.appendChild(fileInput);

    drop.addEventListener('click', function () {
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files.length > 0) handleRomFile(fileInput.files[0]);
    });

    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('dragover');
    });

    drop.addEventListener('dragleave', function () {
      drop.classList.remove('dragover');
    });

    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleRomFile(e.dataTransfer.files[0]);
    });

    // Auto-load cached ROM from IndexedDB
    loadCachedRom(function (cachedName) {
      if (cachedName) {
        drop.classList.add('loaded');
        if (statusEl) statusEl.textContent = 'Loaded: ' + cachedName + ' (drop to change)';
      } else if (savedRom && statusEl) {
        statusEl.textContent = 'Last used: ' + savedRom + ' (file not cached — drop again)';
      }
    });
  }

  function handleRomFile(file) {
    _romBlobUrl = URL.createObjectURL(file);
    window.EJS_gameUrl = _romBlobUrl;
    localStorage.setItem('kaillera-rom-name', file.name);
    cacheRom(file);

    var drop = document.getElementById('rom-drop');
    if (drop) drop.classList.add('loaded');
    var statusEl = document.getElementById('rom-status');
    if (statusEl) statusEl.textContent = 'Loaded: ' + file.name;
  }

  // ── ROM IDB Cache ──────────────────────────────────────────────────────

  var _ROM_DB = 'kaillera-rom-cache';
  var _ROM_STORE = 'roms';

  function openRomDB(cb) {
    var req = indexedDB.open(_ROM_DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(_ROM_STORE); };
    req.onsuccess = function () { cb(req.result); };
    req.onerror = function () { cb(null); };
  }

  function cacheRom(file) {
    var reader = new FileReader();
    reader.onload = function () {
      openRomDB(function (db) {
        if (!db) return;
        var tx = db.transaction(_ROM_STORE, 'readwrite');
        tx.objectStore(_ROM_STORE).put(reader.result, 'current');
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function loadCachedRom(cb) {
    var name = localStorage.getItem('kaillera-rom-name');
    if (!name) { cb(null); return; }
    openRomDB(function (db) {
      if (!db) { cb(null); return; }
      var tx = db.transaction(_ROM_STORE, 'readonly');
      var req = tx.objectStore(_ROM_STORE).get('current');
      req.onsuccess = function () {
        if (!req.result) { cb(null); return; }
        var blob = new Blob([req.result]);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        cb(name);
      };
      req.onerror = function () { cb(null); };
    });
  }

  function initEngine() {
    // Re-create EmulatorJS if it was destroyed (restart after end-game)
    bootEmulator();

    var Engine = mode === 'streaming'
      ? window.NetplayStreaming
      : window.NetplayLockstep;

    if (!Engine) {
      showError('Netplay engine not loaded');
      return;
    }

    var rollbackEnabled = _gameRollbackEnabled;

    engine = Engine;
    engine.init({
      socket: socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      isSpectator: isSpectator,
      playerName: playerName,
      gameElement: document.getElementById('game'),
      rollbackEnabled: rollbackEnabled,
      onStatus: function (msg) {
        var el = document.getElementById('engine-status');
        if (el) el.textContent = msg;
      },
      onPlayersChanged: function () {
        // Engine forwards users-updated — supplementary to our direct listener
      },
      initialPlayers: lastUsersData,
      lateJoin: _lateJoin,
    });
    _lateJoin = false;
  }

  function startGame() {
    if (!_romBlobUrl) {
      showToast('Load a ROM file before starting');
      return;
    }
    var sel = document.getElementById('mode-select');
    var selectedMode = sel ? sel.value : mode;
    var optRollback = document.getElementById('opt-rollback');
    socket.emit('start-game', {
      mode: selectedMode,
      rollbackEnabled: optRollback ? optRollback.checked : false,
    });
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
    if (!card) return;
    card.innerHTML = '';
    var h3 = document.createElement('h3');
    h3.textContent = 'Error';
    var p = document.createElement('p');
    p.textContent = msg;
    var a = document.createElement('a');
    a.href = '/';
    a.className = 'error-back';
    a.textContent = 'Back to Lobby';
    card.appendChild(h3);
    card.appendChild(p);
    card.appendChild(a);
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

  function startGamepadManager() {
    if (!window.GamepadManager) return;
    GamepadManager.start({
      playerSlot: mySlot || 0,
      onUpdate: updateGamepadUI,
    });
  }

  function updateGamepadSlot() {
    // Re-start with correct slot when mySlot changes (after join/connect)
    if (window.GamepadManager && mySlot !== null) {
      GamepadManager.start({
        playerSlot: mySlot,
        onUpdate: updateGamepadUI,
      });
    }
  }

  function updateGamepadUI() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    var assignments = window.GamepadManager ? GamepadManager.getAssignments() : {};
    var statusEl = document.getElementById('gamepad-status');

    if (statusEl && !_wizardActive) {
      if (detected.length > 0) {
        var primary = detected[0];
        statusEl.textContent = primary.id.substring(0, 40) + ' (' + primary.profileName + ')';
        statusEl.className = 'gamepad-detected';
      } else {
        statusEl.textContent = 'No controller detected';
        statusEl.className = '';
      }
    }

    // Update .gamepad spans in player slots
    for (var i = 0; i < 4; i++) {
      var span = document.querySelector('.player-slot[data-slot="' + i + '"] .gamepad');
      if (!span) continue;
      var assignment = assignments[i];
      if (assignment) {
        span.textContent = '\uD83C\uDFAE'; // gamepad emoji
        span.title = assignment.gamepadId + ' (' + assignment.profileName + ')';
      } else {
        span.textContent = '';
        span.title = '';
      }
    }
  }

  // ── Remap Wizard ──────────────────────────────────────────────────────

  var WIZARD_STEPS = [
    { prompt: 'Press: A',         type: 'button', bit: 8 },
    { prompt: 'Press: B',         type: 'button', bit: 0 },
    { prompt: 'Press: Start',     type: 'button', bit: 3 },
    { prompt: 'Press: Z',         type: 'button', bit: 9 },
    { prompt: 'Press: L',         type: 'button', bit: 10 },
    { prompt: 'Press: R',         type: 'button', bit: 11 },
    { prompt: 'Press: D-Up',      type: 'button', bit: 4 },
    { prompt: 'Press: D-Down',    type: 'button', bit: 5 },
    { prompt: 'Press: D-Left',    type: 'button', bit: 6 },
    { prompt: 'Press: D-Right',   type: 'button', bit: 7 },
    { prompt: 'Push stick UP',    type: 'axis', bit: 16, axisGroup: 'stickY' },
    { prompt: 'Push stick DOWN',  type: 'axis', bit: 17, axisGroup: 'stickY' },
    { prompt: 'Push stick LEFT',  type: 'axis', bit: 18, axisGroup: 'stickX' },
    { prompt: 'Push stick RIGHT', type: 'axis', bit: 19, axisGroup: 'stickX' },
    { prompt: 'Press: C-Up',      type: 'cbutton', bit: 12 },
    { prompt: 'Press: C-Down',    type: 'cbutton', bit: 13 },
    { prompt: 'Press: C-Left',    type: 'cbutton', bit: 14 },
    { prompt: 'Press: C-Right',   type: 'cbutton', bit: 15 },
  ];

  var _wizardActive = false;
  var _wizardStep = 0;
  var _wizardDebounce = 0;
  var _wizardRafId = null;
  var _wizardKeyHandler = null;
  var _wizardGamepadProfile = null;
  var _wizardKeyMap = null;
  var _wizardBaselineButtons = null;
  var _wizardAxisCaptures = {};

  function startWizard() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    var gamepadId = detected.length > 0 ? detected[0].id : null;

    // Initialize gamepad profile from current (default or saved)
    if (gamepadId && window.GamepadManager) {
      var current = GamepadManager.hasCustomProfile(gamepadId)
        ? JSON.parse(localStorage.getItem('gamepad-profile:' + gamepadId))
        : GamepadManager.getDefaultProfile(gamepadId);
      _wizardGamepadProfile = {
        name: 'Custom',
        buttons: Object.assign({}, current.buttons),
        axes: JSON.parse(JSON.stringify(current.axes)),
        axisButtons: JSON.parse(JSON.stringify(current.axisButtons || {})),
        deadzone: current.deadzone || 0.3,
      };
    } else {
      _wizardGamepadProfile = null;
    }

    // Initialize keyboard map from current (saved or DEFAULT_N64_KEYMAP)
    var savedKb = null;
    try { savedKb = JSON.parse(localStorage.getItem('keyboard-mapping')); } catch (_) {}
    if (savedKb && Object.keys(savedKb).length > 0) {
      _wizardKeyMap = Object.assign({}, savedKb);
    } else {
      _wizardKeyMap = {
        88: 0, 67: 8, 86: 3, 38: 4, 40: 5, 37: 6, 39: 7,
        90: 9, 84: 10, 89: 11, 73: 12, 75: 13, 74: 14, 76: 15,
        87: 16, 83: 17, 65: 18, 68: 19
      };
    }

    _wizardAxisCaptures = {};
    _wizardStep = 0;
    _wizardActive = true;
    _wizardDebounce = 0;

    // Show wizard UI, hide normal controls
    var wizardEl = document.getElementById('remap-wizard');
    var controlsEl = document.getElementById('gamepad-controls');
    var statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = '';
    if (controlsEl) controlsEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';

    // Capture baseline gamepad buttons (ignore already-pressed)
    _wizardBaselineButtons = {};
    if (gamepadId) {
      var gps = navigator.getGamepads();
      for (var gi = 0; gi < gps.length; gi++) {
        if (gps[gi]) {
          for (var bi = 0; bi < gps[gi].buttons.length; bi++) {
            if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[gi + ':' + bi] = true;
          }
        }
      }
    }

    // Keyboard listener
    _wizardKeyHandler = function (e) {
      if (!_wizardActive) return;
      if (e.keyCode === 27) { cancelWizard(); return; } // Escape
      e.preventDefault();
      if (Date.now() < _wizardDebounce) return;
      captureKeyboard(e.keyCode);
    };
    document.addEventListener('keydown', _wizardKeyHandler, true);

    // Start polling loop
    updateWizardPrompt();
    wizardPoll();
  }

  function cancelWizard() {
    _wizardActive = false;
    if (_wizardRafId) { cancelAnimationFrame(_wizardRafId); _wizardRafId = null; }
    if (_wizardKeyHandler) {
      document.removeEventListener('keydown', _wizardKeyHandler, true);
      _wizardKeyHandler = null;
    }

    var wizardEl = document.getElementById('remap-wizard');
    var controlsEl = document.getElementById('gamepad-controls');
    var statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = '';
    if (statusEl) statusEl.style.display = '';
  }

  function saveWizard() {
    // Save gamepad profile
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && _wizardGamepadProfile) {
      // Assemble axis captures into profile
      for (var groupName in _wizardAxisCaptures) {
        var cap = _wizardAxisCaptures[groupName];
        if (cap.index !== undefined && cap.posBit !== undefined && cap.negBit !== undefined) {
          _wizardGamepadProfile.axes[groupName] = {
            index: cap.index,
            bits: [cap.posBit, cap.negBit],
          };
        }
      }
      GamepadManager.saveGamepadProfile(detected[0].id, _wizardGamepadProfile);
    }

    // Save keyboard mapping
    try {
      localStorage.setItem('keyboard-mapping', JSON.stringify(_wizardKeyMap));
    } catch (_) {}

    cancelWizard();
  }

  function resetMappings() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && window.GamepadManager) {
      GamepadManager.clearGamepadProfile(detected[0].id);
    }
    try { localStorage.removeItem('keyboard-mapping'); } catch (_) {}
    updateGamepadUI();
  }

  function updateWizardPrompt() {
    var promptEl = document.getElementById('remap-prompt');
    var progressEl = document.getElementById('remap-progress');
    if (promptEl) promptEl.textContent = WIZARD_STEPS[_wizardStep].prompt + ' (gamepad or key)';
    if (progressEl) progressEl.textContent = '(' + (_wizardStep + 1) + '/' + WIZARD_STEPS.length + ')';
  }

  function wizardAdvance() {
    _wizardDebounce = Date.now() + 150;
    _wizardStep++;
    if (_wizardStep >= WIZARD_STEPS.length) {
      saveWizard();
      return;
    }
    // Reset baseline for new step
    _wizardBaselineButtons = {};
    var gps = navigator.getGamepads();
    for (var gi = 0; gi < gps.length; gi++) {
      if (gps[gi]) {
        for (var bi = 0; bi < gps[gi].buttons.length; bi++) {
          if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[gi + ':' + bi] = true;
        }
      }
    }
    updateWizardPrompt();
  }

  function wizardSkip() {
    if (!_wizardActive) return;
    wizardAdvance();
  }

  function wizardPoll() {
    if (!_wizardActive) return;
    _wizardRafId = requestAnimationFrame(wizardPoll);

    if (Date.now() < _wizardDebounce) return;

    var gps = navigator.getGamepads();
    var step = WIZARD_STEPS[_wizardStep];

    for (var gi = 0; gi < gps.length; gi++) {
      var gp = gps[gi];
      if (!gp) continue;

      // Check buttons (for button and cbutton steps)
      if (step.type === 'button' || step.type === 'cbutton') {
        for (var bi = 0; bi < gp.buttons.length; bi++) {
          if (gp.buttons[bi].pressed && !_wizardBaselineButtons[gi + ':' + bi]) {
            captureGamepadButton(bi, step);
            return;
          }
        }
      }

      // Check axes (for axis and cbutton steps)
      if (step.type === 'axis' || step.type === 'cbutton') {
        var dz = 0.3;
        for (var ai = 0; ai < gp.axes.length; ai++) {
          var val = gp.axes[ai];
          if (Math.abs(val) > dz) {
            captureGamepadAxis(ai, val > 0, step);
            return;
          }
        }
      }
    }
  }

  function captureGamepadButton(buttonIndex, step) {
    if (!_wizardGamepadProfile) return;
    _wizardGamepadProfile.buttons[buttonIndex] = (1 << step.bit);
    wizardAdvance();
  }

  function captureGamepadAxis(axisIndex, isPositive, step) {
    if (!_wizardGamepadProfile) return;

    if (step.type === 'axis') {
      var group = step.axisGroup;

      if (!_wizardAxisCaptures[group]) {
        _wizardAxisCaptures[group] = {};
      }
      var cap = _wizardAxisCaptures[group];

      // Check if partner direction was already captured on a different axis
      if (cap.index !== undefined && cap.index !== axisIndex) {
        var promptEl = document.getElementById('remap-prompt');
        if (promptEl) {
          var pairName = group === 'stickY' ? 'UP' : 'LEFT';
          promptEl.textContent = 'Must use same stick as ' + pairName + ' — try again';
          setTimeout(function () { updateWizardPrompt(); }, 1000);
        }
        return;
      }

      cap.index = axisIndex;
      if (isPositive) {
        cap.posBit = step.bit;
      } else {
        cap.negBit = step.bit;
      }

      wizardAdvance();
    } else if (step.type === 'cbutton') {
      if (!_wizardGamepadProfile.axisButtons) _wizardGamepadProfile.axisButtons = {};
      if (!_wizardGamepadProfile.axisButtons[axisIndex]) {
        _wizardGamepadProfile.axisButtons[axisIndex] = { pos: 0, neg: 0 };
      }
      if (isPositive) {
        _wizardGamepadProfile.axisButtons[axisIndex].pos |= (1 << step.bit);
      } else {
        _wizardGamepadProfile.axisButtons[axisIndex].neg |= (1 << step.bit);
      }
      wizardAdvance();
    }
  }

  function captureKeyboard(keyCode) {
    var step = WIZARD_STEPS[_wizardStep];

    // Remove old entry for this keyCode (key can only map to one function)
    for (var k in _wizardKeyMap) {
      if (parseInt(k, 10) === keyCode) {
        delete _wizardKeyMap[k];
      }
    }

    // Add new entry
    _wizardKeyMap[keyCode] = step.bit;
    wizardAdvance();
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

    // Show/hide lockstep options based on mode selector
    var modeSelect = document.getElementById('mode-select');
    var lockstepOpts = document.getElementById('lockstep-options');
    if (modeSelect && lockstepOpts) {
      var updateOpts = function () {
        lockstepOpts.style.display = modeSelect.value === 'lockstep' ? '' : 'none';
      };
      modeSelect.addEventListener('change', updateOpts);
      updateOpts();
    }

    connect();
    startGamepadManager();
    setupRomDrop();

    // Remap wizard buttons
    var remapBtn = document.getElementById('remap-btn');
    if (remapBtn) remapBtn.addEventListener('click', startWizard);

    var resetBtn = document.getElementById('reset-mapping-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetMappings);

    var skipBtn = document.getElementById('remap-skip');
    if (skipBtn) skipBtn.addEventListener('click', wizardSkip);

    var cancelBtn = document.getElementById('remap-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelWizard);

    // Click .gamepad span to cycle through detected gamepads
    var gamepadSpans = document.querySelectorAll('.player-slot .gamepad');
    for (var gi = 0; gi < gamepadSpans.length; gi++) {
      (function (span) {
        span.style.cursor = 'pointer';
        span.addEventListener('click', function () {
          if (!window.GamepadManager) return;
          var slotEl = span.closest('.player-slot');
          if (!slotEl) return;
          var slot = parseInt(slotEl.getAttribute('data-slot'), 10);
          if (slot !== mySlot) return; // only reassign own slot

          var detected = GamepadManager.getDetected();
          if (detected.length <= 1) return; // nothing to cycle

          var assignments = GamepadManager.getAssignments();
          var currentIdx = assignments[slot] ? assignments[slot].gamepadIndex : -1;
          // Find next gamepad in detected list
          var nextIdx = detected[0].index;
          for (var d = 0; d < detected.length; d++) {
            if (detected[d].index === currentIdx && d + 1 < detected.length) {
              nextIdx = detected[d + 1].index;
              break;
            }
          }
          // Wrap around
          if (nextIdx === currentIdx) nextIdx = detected[0].index;
          GamepadManager.reassignSlot(slot, nextIdx);
        });
      })(gamepadSpans[gi]);
    }
  });
})();
