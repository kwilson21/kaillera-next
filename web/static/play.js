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
  var _romBlob = null;           // raw ROM Blob for re-creating blob URLs
  var _romBlobUrl = null;
  var _romHash = null;           // SHA-256 hex of loaded ROM
  var _hostRomHash = null;       // host's ROM hash for late-join verification
  var _pendingLateJoin = false;  // waiting for ROM before late-join init
  var _romSharingEnabled = false;   // room-level: host has sharing toggled on
  var _romSharingDecision = null;   // 'accepted', 'declined', or null (page-lifetime)
  var _romTransferInProgress = false;
  var _romTransferChunks = [];
  var _romTransferHeader = null;
  var _romTransferDC = null;        // active rom-transfer DataChannel (receiver side)
  var _romTransferDCs = {};         // active rom-transfer DataChannels (sender side, keyed by sid)
  var _romAcceptPollInterval = null; // polling interval for mid-game accept signaling
  var ROM_MAX_SIZE = 128 * 1024 * 1024;  // 128MB
  var ROM_CHUNK_SIZE = 64 * 1024;        // 64KB

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
    window._socket = socket;  // expose for E2E tests

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
    socket.on('rom-sharing-updated', onRomSharingUpdated);
    socket.on('data-message', onDataMessageForRomSharing);
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

            // Store host's ROM hash for verification
            _hostRomHash = roomData.rom_hash || null;

            // If no ROM cached, check if host is sharing
            if (!_romBlob && !_romBlobUrl) {
              if (roomData.rom_sharing) {
                // Show accept/decline prompt instead of ROM drop
                _romSharingEnabled = true;
                _pendingLateJoin = true;
                showLateJoinRomPrompt();
                updateRomSharingUI();
                return;
              }
              _pendingLateJoin = true;
              showLateJoinRomPrompt();
              return;
            }

            // Verify ROM hash if available
            if (_hostRomHash && _romHash && _hostRomHash !== _romHash) {
              showError('ROM mismatch — your ROM doesn\'t match the host\'s. Please load the correct ROM and rejoin.');
              return;
            }

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
    var ownerSid = data.owner || null;

    // Update ROM sharing state from users-updated (supplementary to rom-sharing-updated)
    if (data.romSharing !== undefined) {
      var wasSharing = _romSharingEnabled;
      _romSharingEnabled = !!data.romSharing;
      if (_romSharingEnabled !== wasSharing) {
        console.log('[play] ROM sharing state from users-updated:', _romSharingEnabled);
        if (_romSharingEnabled && !isHost) showToast('Host is sharing their ROM');
        updateRomSharingUI();
      }
    }

    // Update my slot
    var entries = Object.values(players);
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].socketId === socket.id) {
        mySlot = entries[i].slot;
        break;
      }
    }

    // Detect spectator → player transition (via claim-slot)
    var nowPlayer = mySlot !== null && mySlot !== undefined;
    if (isSpectator && nowPlayer) {
      isSpectator = false;
      if (_romSharingEnabled && _romSharingDecision === null) {
        updateRomSharingUI();
      }
    }

    // Check if we became the host (ownership transfer)
    var wasHost = isHost;
    if (ownerSid) {
      isHost = (ownerSid === socket.id);
    }
    if (!wasHost && isHost) {
      showToast('You are now the host');
    }

    // Diff for toasts
    diffForToasts(players, spectators);
    previousPlayers = JSON.parse(JSON.stringify(players));
    previousSpectators = JSON.parse(JSON.stringify(spectators));

    // Update overlay UI if in pre-game
    if (!gameRunning) {
      updatePlayerList(players, spectators, ownerSid);
      updateStartButton(players);
      updateGamepadSlot();
      // Show/hide host controls after ownership transfer
      var hostControls = document.getElementById('host-controls');
      var guestStatus = document.getElementById('guest-status');
      if (isHost) {
        if (hostControls) hostControls.style.display = '';
        if (guestStatus) guestStatus.style.display = 'none';
      } else {
        if (hostControls) hostControls.style.display = 'none';
        if (guestStatus) guestStatus.style.display = '';
      }
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

    // Verify ROM hash matches host's
    if (data.romHash && _romHash && data.romHash !== _romHash) {
      showError('ROM mismatch — your ROM doesn\'t match the host\'s. Please load the correct ROM and rejoin.');
      return;
    }

    gameRunning = true;

    // If we accepted ROM sharing but don't have a ROM yet, stay in overlay
    // with progress UI while connecting WebRTC and receiving the ROM
    if (_romSharingDecision === 'accepted' && !_romBlob && !_romBlobUrl) {
      console.log('[play] game started — waiting for ROM transfer');
      _romTransferInProgress = true;
      updateRomSharingUI();
      // Start engine in connect-only mode (WebRTC without emulator)
      initEngine();
      // Once DC opens to host, send rom-accepted signal
      waitForDCAndSendRomAccepted();
      return;
    }

    hideOverlay();
    showToolbar();
    showGameLoading();
    initEngine();
  }

  function onGameEnded() {
    gameRunning = false;
    if (engine) {
      engine.stop();
      engine = null;
    }
    destroyEmulator();
    dismissGameLoading();
    hideToolbar();
    showOverlay();
    // Clear stale engine status
    var statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.textContent = '';
    // Clean up ROM transfer state (decision persists for page lifetime)
    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferHeader = null;
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    Object.keys(_romTransferDCs).forEach(function (sid) {
      try { _romTransferDCs[sid].close(); } catch (_) {}
    });
    _romTransferDCs = {};
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
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

  // ── ROM Sharing ──────────────────────────────────────────────────────

  function onRomSharingUpdated(data) {
    var wasEnabled = _romSharingEnabled;
    _romSharingEnabled = !!data.romSharing;
    console.log('[play] rom-sharing-updated:', _romSharingEnabled);

    // Notify joiners
    if (!isHost) {
      if (_romSharingEnabled && !wasEnabled) showToast('Host is sharing their ROM');
      if (!_romSharingEnabled && wasEnabled) showToast('Host stopped sharing their ROM');
    }

    // If sharing was just disabled and we're mid-transfer, cancel
    if (wasEnabled && !_romSharingEnabled && _romTransferInProgress) {
      _romTransferInProgress = false;
      _romTransferChunks = [];
      _romTransferHeader = null;
      if (_romTransferDC) {
        try { _romTransferDC.close(); } catch (_) {}
        _romTransferDC = null;
      }
      showToast('ROM sharing disabled by host');
    }

    updateRomSharingUI();

    // Refresh start button — sharing state affects ROM readiness gating
    if (isHost && lastUsersData) {
      updateStartButton(lastUsersData.players || {});
    }
  }

  function onDataMessageForRomSharing(data) {
    // Socket.IO fallback for rom-accepted (broadcast to all peers; only host acts)
    if (data.type === 'rom-accepted' && isHost && _romSharingEnabled && data.sender) {
      console.log('[play] peer', data.sender, 'accepted ROM sharing (via socket)');
      startRomTransferTo(data.sender);
    }
  }

  function toggleRomSharing() {
    var cb = document.getElementById('opt-rom-sharing');
    if (!cb) return;
    var enabled = cb.checked;
    if (enabled && !_romBlob) {
      cb.checked = false;
      showToast('Load a ROM file before sharing');
      return;
    }
    socket.emit('rom-sharing-toggle', { enabled: enabled });
    // If disabling, close any active rom-transfer DataChannels
    if (!enabled) {
      Object.keys(_romTransferDCs).forEach(function (sid) {
        try { _romTransferDCs[sid].close(); } catch (_) {}
      });
      _romTransferDCs = {};
    }
  }

  function updateRomSharingUI() {
    var romDrop = document.getElementById('rom-drop');
    var prompt = document.getElementById('rom-sharing-prompt');
    var progress = document.getElementById('rom-transfer-progress');

    // Host never sees the prompt/progress
    if (isHost) return;
    // Spectators don't need ROMs
    if (isSpectator) return;

    console.log('[play] updateRomSharingUI: enabled=' + _romSharingEnabled +
      ' decision=' + _romSharingDecision + ' transfer=' + _romTransferInProgress +
      ' hasRom=' + !!_romBlob);

    if (_romSharingEnabled && _romSharingDecision === null && !_romBlob) {
      // Show accept/decline prompt, hide drop zone (only if no ROM loaded)
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = '';
      if (progress) progress.style.display = 'none';
    } else if (_romSharingEnabled && _romSharingDecision === 'accepted' && _romTransferInProgress) {
      // Transfer in progress — show progress bar
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
    } else if (_romSharingEnabled && _romSharingDecision === 'accepted' && !_romTransferInProgress && _romBlob) {
      // Transfer complete — show loaded state in drop zone
      if (romDrop) { romDrop.style.display = ''; romDrop.classList.add('loaded'); }
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    } else {
      // Default: show normal drop zone
      if (romDrop) romDrop.style.display = '';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    }
  }

  function findHostSid() {
    if (!lastUsersData || !lastUsersData.players) return null;
    var players = lastUsersData.players;
    for (var pid in players) {
      if (players[pid].slot === 0) return players[pid].socketId;
    }
    return null;
  }

  function acceptRomSharing() {
    _romSharingDecision = 'accepted';
    _romTransferInProgress = true;
    _romTransferChunks = [];
    _romTransferHeader = null;
    updateRomSharingUI();

    // Pre-game: no WebRTC connections exist yet. Just store the decision.
    // The rom-accepted signal will be sent when the game starts and
    // WebRTC connects (see onGameStarted).
    if (!gameRunning) {
      console.log('[play] ROM sharing accepted pre-game — will transfer after game starts');
      return;
    }

    // Mid-game join: start engine in connect-only mode to get WebRTC
    if (!engine && gameRunning) {
      initEngine();
      waitForDCAndSendRomAccepted();
      return;
    }

    // Engine exists with open DataChannel: signal immediately
    if (engine && engine.getPeerConnection) {
      var hostSid = findHostSid();
      if (hostSid) {
        var peers = window._peers || {};
        var hostPeer = peers[hostSid];
        if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
          hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
          return;
        }
      }
    }
    // Fallback: Socket.IO data-message
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
  }

  function waitForDCAndSendRomAccepted() {
    if (_romAcceptPollInterval) clearInterval(_romAcceptPollInterval);
    _romAcceptPollInterval = setInterval(function () {
      var hostSid = findHostSid();
      if (!hostSid) return;
      var peers = window._peers || {};
      var hostPeer = peers[hostSid];
      if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
        clearInterval(_romAcceptPollInterval);
        _romAcceptPollInterval = null;
        console.log('[play] DC open to host — sending rom-accepted');
        hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
      }
    }, 200);
    setTimeout(function () {
      if (_romAcceptPollInterval) {
        clearInterval(_romAcceptPollInterval);
        _romAcceptPollInterval = null;
      }
    }, 15000);
  }

  function declineRomSharing() {
    _romSharingDecision = 'declined';
    updateRomSharingUI();
  }

  function cancelRomTransfer() {
    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferHeader = null;
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    updateRomSharingUI();
    showToast('ROM transfer cancelled');
  }

  // ── ROM Transfer: Host sending ──────────────────────────────────────

  function startRomTransferTo(peerSid) {
    if (!_romBlob || !isHost) return;
    if (_romBlob.size > ROM_MAX_SIZE) {
      console.log('[play] ROM too large to share:', _romBlob.size);
      return;
    }
    var pc = engine && engine.getPeerConnection ? engine.getPeerConnection(peerSid) : null;
    if (!pc) {
      console.log('[play] no peer connection for', peerSid);
      return;
    }

    var dc = pc.createDataChannel('rom-transfer', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    _romTransferDCs[peerSid] = dc;

    dc.onopen = function () {
      console.log('[play] rom-transfer DC open to', peerSid);
      sendRomOverChannel(dc, peerSid);
    };
    dc.onclose = function () {
      delete _romTransferDCs[peerSid];
    };
    dc.onerror = function (e) {
      console.log('[play] rom-transfer DC error:', peerSid, e);
      delete _romTransferDCs[peerSid];
    };
  }

  function sendRomOverChannel(dc, peerSid) {
    var romName = localStorage.getItem('kaillera-rom-name') || 'rom.z64';
    var header = { type: 'rom-header', name: romName, size: _romBlob.size };
    if (_romHash) header.hash = _romHash;
    dc.send(JSON.stringify(header));

    var reader = new FileReader();
    reader.onload = function () {
      var buffer = reader.result;
      var offset = 0;

      function sendNextChunk() {
        if (dc.readyState !== 'open') return;
        while (offset < buffer.byteLength) {
          if (dc.bufferedAmount > 1024 * 1024) {
            dc.onbufferedamountlow = function () {
              dc.onbufferedamountlow = null;
              sendNextChunk();
            };
            return;
          }
          var end = Math.min(offset + ROM_CHUNK_SIZE, buffer.byteLength);
          dc.send(buffer.slice(offset, end));
          offset = end;
        }
        // All chunks sent
        dc.send(JSON.stringify({ type: 'rom-complete' }));
        console.log('[play] ROM transfer complete to', peerSid);
      }

      sendNextChunk();
    };
    reader.readAsArrayBuffer(_romBlob);
  }

  // ── ROM Transfer: Joiner receiving ──────────────────────────────────

  function onExtraDataChannel(remoteSid, channel) {
    if (channel.label !== 'rom-transfer') return;
    if (_romSharingDecision !== 'accepted') {
      channel.close();
      return;
    }

    console.log('[play] received rom-transfer DataChannel from', remoteSid);
    _romTransferDC = channel;
    channel.binaryType = 'arraybuffer';
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferInProgress = true;
    var bytesReceived = 0;

    channel.onmessage = function (e) {
      if (typeof e.data === 'string') {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'rom-header') {
            if (msg.size > ROM_MAX_SIZE) {
              showToast('ROM too large — loading manually');
              channel.close();
              cancelRomTransfer();
              return;
            }
            _romTransferHeader = msg;
            bytesReceived = 0;
            updateRomProgress(0, msg.size);
          } else if (msg.type === 'rom-complete') {
            finishRomTransfer();
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        _romTransferChunks.push(new Uint8Array(e.data));
        bytesReceived += e.data.byteLength;
        if (_romTransferHeader) {
          updateRomProgress(bytesReceived, _romTransferHeader.size);
        }
      }
    };

    channel.onclose = function () {
      if (_romTransferInProgress && !_romBlob) {
        showToast('ROM transfer interrupted');
        _romTransferInProgress = false;
        _romTransferDC = null;
        updateRomSharingUI();
      }
    };

    updateRomSharingUI();
  }

  function updateRomProgress(received, total) {
    var bar = document.getElementById('rom-progress-bar');
    var text = document.getElementById('rom-progress-text');
    var pct = total > 0 ? Math.round((received / total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (text) {
      var recMB = (received / (1024 * 1024)).toFixed(1);
      var totMB = (total / (1024 * 1024)).toFixed(1);
      text.textContent = 'Receiving ROM... ' + pct + '% (' + recMB + ' / ' + totMB + ' MB)';
    }
  }

  function finishRomTransfer() {
    var totalSize = 0;
    for (var i = 0; i < _romTransferChunks.length; i++) {
      totalSize += _romTransferChunks[i].byteLength;
    }

    if (_romTransferHeader && _romTransferHeader.size !== totalSize) {
      showToast('ROM transfer size mismatch — load manually');
      _romTransferInProgress = false;
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    var blob = new Blob(_romTransferChunks);
    var displayName = (_romTransferHeader && _romTransferHeader.name) || 'rom.z64';
    var expectedHash = _romTransferHeader ? _romTransferHeader.hash : null;

    // Set ROM data (ephemeral — do NOT cache to IndexedDB)
    _romBlob = blob;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;

    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferDC = null;

    // Verify hash if provided
    var reader = new FileReader();
    reader.onload = function () {
      hashArrayBuffer(reader.result).then(function (hash) {
        _romHash = hash;
        if (expectedHash && hash !== expectedHash) {
          showToast('ROM hash mismatch — may cause desync');
        }
        afterRomTransferComplete(displayName);
      }).catch(function () {
        afterRomTransferComplete(displayName);
      });
    };
    reader.readAsArrayBuffer(blob);
  }

  function afterRomTransferComplete(displayName) {
    console.log('[play] ROM transfer complete:', displayName);
    notifyRomReady();

    // Update drop zone to show loaded state
    var romDrop = document.getElementById('rom-drop');
    var statusEl = document.getElementById('rom-status');
    if (romDrop) romDrop.classList.add('loaded');
    if (statusEl) statusEl.textContent = 'Loaded: ' + displayName + ' (from host)';

    updateRomSharingUI();

    // If game is running and we were waiting for the ROM (connect-only mode),
    // hide overlay, show toolbar, and boot the emulator
    if (gameRunning && !window.EJS_emulator) {
      hideOverlay();
      showToolbar();
      bootEmulator();
    }
    // If we were in a pending late-join, dismiss the prompt
    if (_pendingLateJoin) {
      dismissLateJoinPrompt();
    }

    showToast('ROM loaded from host');
  }

  function notifyRomReady() {
    if (socket && socket.connected) {
      socket.emit('rom-ready', { ready: true });
    }
  }

  function onUnhandledEngineMessage(remoteSid, msg) {
    if (msg.type === 'rom-accepted' && isHost && _romSharingEnabled) {
      console.log('[play] peer', remoteSid, 'accepted ROM sharing');
      startRomTransferTo(remoteSid);
    }
  }

  function destroyEmulator() {
    var emu = window.EJS_emulator;
    if (emu) {
      // Close the emulator's own AudioContext to stop lingering audio.
      // The netplay engine's stop() handles its custom audio pipeline;
      // this catches the EJS/SDL2 AudioContext that runs independently.
      try {
        var gm = emu.gameManager;
        if (gm && gm.Module && gm.Module.SDL2 && gm.Module.SDL2.audioContext) {
          gm.Module.SDL2.audioContext.close();
        }
      } catch (_) {}
    }
    // Wipe EmulatorJS from the DOM entirely — clean slate for next game
    var gameEl = document.getElementById('game');
    if (gameEl) gameEl.innerHTML = '';
    window.EJS_emulator = undefined;

    // Remove injected EJS scripts so re-injection creates a clean load.
    // Also remove emulator.min.js to avoid const re-declaration errors.
    var scripts = document.querySelectorAll(
      'script[src*="loader.js"], script[src*="emulator.min.js"], script[src*="emulatorjs"]'
    );
    for (var i = 0; i < scripts.length; i++) {
      scripts[i].parentNode.removeChild(scripts[i]);
    }
    // Clean up EJS globals so loader.js can re-inject cleanly
    try { delete window.EJS_emulator; } catch (_) {}
    try { delete window.EJS_main; } catch (_) {}
    try { delete window.EJS_GameManager; } catch (_) {}

    // Revoke the consumed blob URL — bootEmulator() will create a fresh one
    if (_romBlobUrl) {
      URL.revokeObjectURL(_romBlobUrl);
      _romBlobUrl = null;
    }
  }

  function bootEmulator() {
    // Re-initialize EmulatorJS if it was destroyed
    if (window.EJS_emulator) {
      console.log('[play] bootEmulator: EJS already exists, skipping');
      return;
    }
    if (!_romBlob && !_romBlobUrl) {
      console.log('[play] bootEmulator: no ROM loaded');
      showToast('Please load a ROM file first');
      return;
    }
    // Create a fresh blob URL — the previous one may have been revoked by
    // EmulatorJS internally or by destroyEmulator() cleanup
    if (_romBlob) {
      if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
      _romBlobUrl = URL.createObjectURL(_romBlob);
    }
    console.log('[play] bootEmulator: gameUrl:', _romBlobUrl.substring(0, 50));
    window.EJS_gameUrl = _romBlobUrl;

    // If EmulatorJS class is already loaded (game restart), instantiate
    // directly to avoid const re-declaration errors from re-injecting scripts
    if (typeof EmulatorJS === 'function') {
      console.log('[play] bootEmulator: reusing existing EmulatorJS class');
      var config = {
        gameUrl: _romBlobUrl,
        system: window.EJS_core || 'n64',
        startOnLoaded: true,
        pathtodata: window.EJS_pathtodata || 'https://cdn.emulatorjs.org/stable/data/',
        shaders: window.EJS_SHADERS || {},
      };
      window.EJS_emulator = new EmulatorJS(
        document.querySelector(window.EJS_player || '#game'),
        config
      );
      return;
    }

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
        // If we were waiting for a ROM to late-join, proceed now
        if (_pendingLateJoin) {
          dismissLateJoinPrompt();
        }
      } else if (savedRom && statusEl) {
        statusEl.textContent = 'Last used: ' + savedRom + ' (file not cached — drop again)';
      }
    });
  }

  function handleRomFile(file) {
    var statusEl = document.getElementById('rom-status');
    var isZip = file.name.toLowerCase().endsWith('.zip');

    if (isZip) {
      if (statusEl) statusEl.textContent = 'Extracting ROM from zip…';
      var reader = new FileReader();
      reader.onload = function () {
        extractRomFromZip(reader.result).then(function (result) {
          if (!result) {
            if (statusEl) statusEl.textContent = 'No ROM found in zip (.z64/.n64/.v64)';
            return;
          }
          var romBlob = new Blob([result.data]);
          var romFile = new File([romBlob], result.name);
          loadRomData(romFile, result.name);
        }).catch(function (err) {
          console.log('[play] zip extraction failed:', err);
          if (statusEl) statusEl.textContent = 'Failed to extract ROM from zip';
        });
      };
      reader.readAsArrayBuffer(file);
    } else {
      loadRomData(file, file.name);
    }
  }

  function loadRomData(file, displayName) {
    _romBlob = file;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(file);
    window.EJS_gameUrl = _romBlobUrl;
    localStorage.setItem('kaillera-rom-name', displayName);
    cacheRom(file);

    var drop = document.getElementById('rom-drop');
    if (drop) drop.classList.add('loaded');
    var statusEl = document.getElementById('rom-status');
    if (statusEl) statusEl.textContent = 'Loaded: ' + displayName;

    // Enable ROM sharing checkbox if host
    var romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb && isHost) romShareCb.disabled = false;

    // Compute ROM hash and proceed with any pending late-join
    var reader = new FileReader();
    reader.onload = function () {
      hashArrayBuffer(reader.result).then(function (hash) {
        _romHash = hash;
        localStorage.setItem('kaillera-rom-hash', hash);
        console.log('[play] ROM hash:', hash.substring(0, 16) + '…');
      }).catch(function (err) {
        console.log('[play] hash failed:', err);
      }).then(function () {
        notifyRomReady();
        // Always proceed with late-join, even if hash computation failed
        if (_pendingLateJoin) {
          dismissLateJoinPrompt();
        }
      });
    };
    reader.readAsArrayBuffer(file);
  }

  // ── ZIP extraction ────────────────────────────────────────────────────

  var _ROM_EXTS = ['.z64', '.n64', '.v64', '.ndd'];

  function extractRomFromZip(arrayBuffer) {
    // Minimal ZIP parser using the central directory (reliable sizes).
    // Supports STORED (0) and DEFLATE (8) compression methods.
    var view = new DataView(arrayBuffer);
    var bytes = new Uint8Array(arrayBuffer);
    var len = bytes.length;

    // Find End of Central Directory record (last 22+ bytes of file)
    var eocdOffset = -1;
    for (var i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) return Promise.resolve(null);

    var cdOffset = view.getUint32(eocdOffset + 16, true);
    var cdEntries = view.getUint16(eocdOffset + 10, true);

    // Walk central directory entries
    var pos = cdOffset;
    for (var e = 0; e < cdEntries && pos + 46 <= len; e++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;

      var method = view.getUint16(pos + 10, true);
      var compSize = view.getUint32(pos + 20, true);
      var nameLen = view.getUint16(pos + 28, true);
      var extraLen = view.getUint16(pos + 30, true);
      var commentLen = view.getUint16(pos + 32, true);
      var localHeaderOffset = view.getUint32(pos + 42, true);

      var nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      var fileName = '';
      for (var ci = 0; ci < nameBytes.length; ci++) fileName += String.fromCharCode(nameBytes[ci]);

      var lower = fileName.toLowerCase();
      var isRom = false;
      for (var j = 0; j < _ROM_EXTS.length; j++) {
        if (lower.endsWith(_ROM_EXTS[j])) { isRom = true; break; }
      }

      if (isRom && compSize > 0) {
        // Read local file header to find data start
        var lNameLen = view.getUint16(localHeaderOffset + 26, true);
        var lExtraLen = view.getUint16(localHeaderOffset + 28, true);
        var dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        var compData = bytes.subarray(dataStart, dataStart + compSize);
        var baseName = fileName.split('/').pop();

        if (method === 0) {
          return Promise.resolve({ name: baseName, data: compData.slice() });
        } else if (method === 8) {
          var blob = new Blob([compData]);
          var ds = new DecompressionStream('deflate-raw');
          var decompressed = blob.stream().pipeThrough(ds);
          return new Response(decompressed).arrayBuffer().then(function (buf) {
            return { name: baseName, data: new Uint8Array(buf) };
          });
        }
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    return Promise.resolve(null);
  }

  function hashArrayBuffer(buf) {
    // crypto.subtle requires a secure context (HTTPS or localhost).
    // On LAN IPs over HTTP, fall back to a simple FNV-1a hash.
    if (window.crypto && window.crypto.subtle) {
      return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
        var arr = new Uint8Array(digest);
        var hex = '';
        for (var i = 0; i < arr.length; i++) {
          hex += ('0' + arr[i].toString(16)).slice(-2);
        }
        return hex;
      });
    }
    // Fallback: FNV-1a 64-bit (good enough for mismatch detection)
    var bytes = new Uint8Array(buf);
    var h1 = 0x811c9dc5 >>> 0;
    var h2 = 0x811c9dc5 >>> 0;
    for (var i = 0; i < bytes.length; i++) {
      if (i & 1) {
        h1 = (h1 ^ bytes[i]) >>> 0;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
      } else {
        h2 = (h2 ^ bytes[i]) >>> 0;
        h2 = Math.imul(h2, 0x01000193) >>> 0;
      }
    }
    var hex = ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
    // Pad to 64 chars to match SHA-256 length for server validation
    while (hex.length < 64) hex += '0';
    return Promise.resolve(hex);
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
        _romBlob = blob;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        // Compute hash from cached data
        hashArrayBuffer(req.result).then(function (hash) {
          _romHash = hash;
          localStorage.setItem('kaillera-rom-hash', hash);
          notifyRomReady();
          cb(name);
        });
      };
      req.onerror = function () { cb(null); };
    });
  }

  function initEngine() {
    // Re-create EmulatorJS if it was destroyed (restart after end-game)
    // Skip boot if no ROM loaded (connect-only mode for ROM sharing)
    if (_romBlob || _romBlobUrl) {
      bootEmulator();
    } else {
      console.log('[play] initEngine: connect-only mode (no ROM yet)');
    }

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
        // Show in toolbar (visible during gameplay) and overlay (visible pre-game)
        var toolbarEl = document.getElementById('toolbar-status');
        if (toolbarEl) toolbarEl.textContent = msg;
        var overlayEl = document.getElementById('engine-status');
        if (overlayEl) overlayEl.textContent = msg;
        // Update game loading overlay
        var loadingText = document.getElementById('game-loading-text');
        if (loadingText) loadingText.textContent = msg;
        // Dismiss loading overlay when lockstep loop starts
        if (msg.indexOf('game on') !== -1 || msg.indexOf('Spectating') !== -1) {
          dismissGameLoading();
        }
      },
      onPlayersChanged: function () {
        // Engine forwards users-updated — supplementary to our direct listener
      },
      initialPlayers: lastUsersData,
      lateJoin: _lateJoin,
    });
    _lateJoin = false;

    // Register ROM sharing delegation hooks
    if (engine.onExtraDataChannel) {
      engine.onExtraDataChannel(function (remoteSid, channel) {
        onExtraDataChannel(remoteSid, channel);
      });
    }
    if (engine.onUnhandledMessage) {
      engine.onUnhandledMessage(function (remoteSid, msg) {
        onUnhandledEngineMessage(remoteSid, msg);
      });
    }
  }

  function startGame() {
    if (!_romBlob && !_romBlobUrl) {
      showToast('Load a ROM file before starting');
      return;
    }
    var sel = document.getElementById('mode-select');
    var selectedMode = sel ? sel.value : mode;
    var optRollback = document.getElementById('opt-rollback');
    socket.emit('start-game', {
      mode: selectedMode,
      rollbackEnabled: optRollback ? optRollback.checked : false,
      romHash: _romHash || null,
    }, function (err) {
      if (err) showToast(err);
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

  // ── Late-Join ROM Prompt ─────────────────────────────────────────────

  function showLateJoinRomPrompt() {
    // Show the overlay with only the ROM drop zone visible
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Hide everything except the ROM section
    var sections = overlay.querySelectorAll('.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status');
    for (var i = 0; i < sections.length; i++) {
      sections[i].style.display = 'none';
    }

    // Show only the ROM drop section
    var romDrop = document.getElementById('rom-drop');
    if (romDrop && romDrop.parentNode) romDrop.parentNode.style.display = '';

    // Add a heading message
    var card = overlay.querySelector('.overlay-card');
    if (card) {
      var msg = document.createElement('p');
      msg.id = 'late-join-msg';
      msg.style.cssText = 'text-align:center;color:#6af;margin-bottom:12px;font-size:14px;';
      msg.textContent = 'Game in progress — load a ROM to join';
      card.insertBefore(msg, card.firstChild);
    }
  }

  function dismissLateJoinPrompt() {
    _pendingLateJoin = false;

    // Verify ROM hash before joining
    if (_hostRomHash && _romHash && _hostRomHash !== _romHash) {
      showError('ROM mismatch — your ROM doesn\'t match the host\'s. Please load the correct ROM and rejoin.');
      return;
    }

    // Remove the late-join message
    var msg = document.getElementById('late-join-msg');
    if (msg) msg.parentNode.removeChild(msg);

    // Restore all sections visibility
    var overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      var sections = overlay.querySelectorAll('.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status');
      for (var i = 0; i < sections.length; i++) {
        sections[i].style.display = '';
      }
    }

    // Now proceed with late join
    showToolbar();
    initEngine();
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

  function updatePlayerList(players, spectators, ownerSid) {
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
        var isOwner = ownerSid && playerInSlot.socketId === ownerSid;
        var suffix = isOwner ? ' (host)' : '';
        if (!playerInSlot.romReady && !_romSharingEnabled) suffix += ' — no ROM';
        nameEl.textContent = playerInSlot.playerName + suffix;
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
    var entries = Object.values(players);
    var allReady = entries.every(function (p) { return p.romReady; });

    if (playerCount < 2) {
      btn.disabled = true;
      btn.textContent = 'Start Game (need 2+)';
    } else if (!allReady && !_romSharingEnabled) {
      btn.disabled = true;
      var readyCount = entries.filter(function (p) { return p.romReady; }).length;
      btn.textContent = 'Waiting for ROMs (' + readyCount + '/' + playerCount + ')';
    } else {
      btn.disabled = false;
      btn.textContent = 'Start Game';
    }
  }

  // ── UI: Toolbar ────────────────────────────────────────────────────────

  function showGameLoading() {
    var el = document.getElementById('game-loading');
    if (el) {
      el.classList.remove('hidden', 'fade-out');
    }
  }

  function dismissGameLoading() {
    var el = document.getElementById('game-loading');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('fade-out');
    setTimeout(function () {
      el.classList.add('hidden');
      el.classList.remove('fade-out');
    }, 400);
  }

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
    hideInfoOverlay();
  }

  // ── UI: Info Overlay ──────────────────────────────────────────────────

  var _infoVisible = false;
  var _infoInterval = null;

  function toggleInfoOverlay() {
    _infoVisible = !_infoVisible;
    var el = document.getElementById('info-overlay');
    var btn = document.getElementById('toolbar-info');
    if (_infoVisible) {
      if (el) el.classList.remove('hidden');
      if (btn) btn.classList.add('active');
      if (!_infoInterval) _infoInterval = setInterval(updateInfoOverlay, 500);
      updateInfoOverlay();
    } else {
      hideInfoOverlay();
    }
  }

  function hideInfoOverlay() {
    _infoVisible = false;
    var el = document.getElementById('info-overlay');
    var btn = document.getElementById('toolbar-info');
    if (el) el.classList.add('hidden');
    if (btn) btn.classList.remove('active');
    if (_infoInterval) { clearInterval(_infoInterval); _infoInterval = null; }
  }

  function updateInfoOverlay() {
    var info = engine && engine.getInfo ? engine.getInfo() : null;

    var fpsEl = document.getElementById('info-fps');
    var pingEl = document.getElementById('info-ping');
    var delayEl = document.getElementById('info-delay');
    var playersEl = document.getElementById('info-players');

    if (info) {
      if (fpsEl) fpsEl.textContent = 'FPS: ' + (info.fps || 0);
      if (pingEl) pingEl.textContent = info.ping !== null ? 'Ping: ' + Math.round(info.ping) + 'ms' : 'Ping: --';
      if (delayEl) delayEl.textContent = 'Delay: ' + info.frameDelay + 'f';
      if (playersEl) playersEl.textContent = 'Players: ' + info.playerCount;
    } else {
      if (fpsEl) fpsEl.textContent = 'FPS: --';
      if (pingEl) pingEl.textContent = 'Ping: --';
      if (delayEl) delayEl.textContent = '';
      if (playersEl) playersEl.textContent = '';
    }
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
        statusEl.textContent = 'No controller — press any button to detect';
        statusEl.className = '';
      }
    }

    // Hide EJS virtual gamepad when a real gamepad is connected (and vice versa)
    var ejs = window.EJS_emulator;
    if (ejs && ejs.virtualGamepad) {
      if (detected.length > 0) {
        ejs.virtualGamepad.style.display = 'none';
      } else if (ejs.touch) {
        ejs.virtualGamepad.style.display = '';
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
    { prompt: 'Press: A',         type: 'button', bit: 0 },
    { prompt: 'Press: B',         type: 'button', bit: 1 },
    { prompt: 'Press: Start',     type: 'button', bit: 3 },
    { prompt: 'Press: Z',         type: 'button', bit: 12 },
    { prompt: 'Press: L',         type: 'button', bit: 10 },
    { prompt: 'Press: R',         type: 'button', bit: 11 },
    { prompt: 'Press: D-Up',      type: 'button', bit: 4 },
    { prompt: 'Press: D-Down',    type: 'button', bit: 5 },
    { prompt: 'Press: D-Left',    type: 'button', bit: 6 },
    { prompt: 'Press: D-Right',   type: 'button', bit: 7 },
    { prompt: 'Push stick UP',    type: 'axis', bit: 19, axisGroup: 'stickY' },
    { prompt: 'Push stick DOWN',  type: 'axis', bit: 18, axisGroup: 'stickY' },
    { prompt: 'Push stick LEFT',  type: 'axis', bit: 17, axisGroup: 'stickX' },
    { prompt: 'Push stick RIGHT', type: 'axis', bit: 16, axisGroup: 'stickX' },
    { prompt: 'Press: C-Up',      type: 'cbutton', bit: 23 },
    { prompt: 'Press: C-Down',    type: 'cbutton', bit: 22 },
    { prompt: 'Press: C-Left',    type: 'cbutton', bit: 20 },
    { prompt: 'Press: C-Right',   type: 'cbutton', bit: 21 },
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
  var _wizardSnapshots = [];  // state snapshots for go-back
  var _wizardHadGamepad = false;
  var _wizardHotPlugCheck = 0;

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
        67: 0, 88: 1, 86: 3, 38: 4, 40: 5, 37: 6, 39: 7,
        84: 10, 89: 11, 90: 12,
        68: 16, 65: 17, 83: 18, 87: 19,
        74: 20, 76: 21, 75: 22, 73: 23
      };
    }

    _wizardAxisCaptures = {};
    _wizardSnapshots = [];
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

    // Track initial gamepad presence for hot-plug notifications
    var initGps = navigator.getGamepads();
    _wizardHadGamepad = false;
    for (var gi2 = 0; gi2 < initGps.length; gi2++) {
      if (initGps[gi2]) { _wizardHadGamepad = true; break; }
    }
    _wizardHotPlugCheck = 0;

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
    var backBtn = document.getElementById('remap-back');
    if (promptEl) promptEl.textContent = WIZARD_STEPS[_wizardStep].prompt + ' (gamepad or key)';
    if (progressEl) progressEl.textContent = '(' + (_wizardStep + 1) + '/' + WIZARD_STEPS.length + ')';
    if (backBtn) backBtn.disabled = (_wizardStep === 0);
  }

  function wizardSaveSnapshot() {
    _wizardSnapshots.push({
      gamepadProfile: _wizardGamepadProfile ? JSON.parse(JSON.stringify(_wizardGamepadProfile)) : null,
      keyMap: _wizardKeyMap ? Object.assign({}, _wizardKeyMap) : null,
      axisCaptures: JSON.parse(JSON.stringify(_wizardAxisCaptures)),
    });
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

  function wizardBack() {
    if (!_wizardActive || _wizardStep === 0 || _wizardSnapshots.length === 0) return;
    var snap = _wizardSnapshots.pop();
    _wizardStep--;
    _wizardGamepadProfile = snap.gamepadProfile;
    _wizardKeyMap = snap.keyMap;
    _wizardAxisCaptures = snap.axisCaptures;
    _wizardDebounce = Date.now() + 150;
    updateWizardPrompt();
  }

  function wizardSkip() {
    if (!_wizardActive) return;
    wizardSaveSnapshot();
    wizardAdvance();
  }

  function wizardPoll() {
    if (!_wizardActive) return;
    _wizardRafId = requestAnimationFrame(wizardPoll);

    if (Date.now() < _wizardDebounce) return;

    var gps = navigator.getGamepads();

    // Hot-plug detection (check every ~30 frames / 500ms)
    _wizardHotPlugCheck++;
    if (_wizardHotPlugCheck % 30 === 0) {
      var hasNow = false;
      for (var hi = 0; hi < gps.length; hi++) {
        if (gps[hi]) { hasNow = true; break; }
      }
      if (hasNow && !_wizardHadGamepad) {
        showToast('Controller connected');
        _wizardHadGamepad = true;
      } else if (!hasNow && _wizardHadGamepad) {
        showToast('Controller disconnected');
        _wizardHadGamepad = false;
      }
    }

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
        var dz = 0.5;  // higher than gameplay deadzone to avoid accidental captures
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
    wizardSaveSnapshot();
    _wizardGamepadProfile.buttons[buttonIndex] = (1 << step.bit);
    wizardAdvance();
  }

  function captureGamepadAxis(axisIndex, isPositive, step) {
    if (!_wizardGamepadProfile) return;
    wizardSaveSnapshot();

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
    wizardSaveSnapshot();

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

  // ── Delay Preference ────────────────────────────────────────────────

  window._delayAutoValue = 2;

  function getDelayPreference() {
    var autoEl = document.getElementById('delay-auto');
    var selectEl = document.getElementById('delay-select');
    if (autoEl && autoEl.checked) {
      return window._delayAutoValue;
    }
    if (selectEl) {
      var v = parseInt(selectEl.value, 10);
      return v > 0 ? v : 2;
    }
    return 2;
  }

  window.getDelayPreference = getDelayPreference;

  function setAutoDelay(value) {
    window._delayAutoValue = value;
    var selectEl = document.getElementById('delay-select');
    var autoEl = document.getElementById('delay-auto');
    if (selectEl && autoEl && autoEl.checked) {
      selectEl.value = String(value);
    }
  }

  window.setAutoDelay = setAutoDelay;

  function showEffectiveDelay(own, room) {
    var el = document.getElementById('delay-effective');
    if (!el) return;
    if (room > own) {
      el.textContent = '(room: ' + room + ')';
    } else {
      el.textContent = '';
    }
  }

  window.showEffectiveDelay = showEffectiveDelay;

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

    var toolbarInfo = document.getElementById('toolbar-info');
    if (toolbarInfo) toolbarInfo.addEventListener('click', toggleInfoOverlay);

    var copyBtn = document.getElementById('copy-link');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    // Show/hide lockstep options based on mode selector
    var modeSelect = document.getElementById('mode-select');
    var lockstepOpts = document.getElementById('lockstep-options');
    if (modeSelect && lockstepOpts) {
      var updateOpts = function () {
        var isLockstep = modeSelect.value === 'lockstep';
        lockstepOpts.style.display = isLockstep ? '' : 'none';
        // Hide ROM sharing options in streaming mode
        var romSharingRow = document.getElementById('rom-sharing-options');
        var romSharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
        if (romSharingRow) romSharingRow.style.display = isLockstep ? '' : 'none';
        if (!isLockstep && romSharingDisclaimer) romSharingDisclaimer.style.display = 'none';
        // Auto-disable sharing when switching to streaming
        if (!isLockstep) {
          var cb = document.getElementById('opt-rom-sharing');
          if (cb && cb.checked) {
            cb.checked = false;
            socket.emit('rom-sharing-toggle', { enabled: false });
          }
        }
      };
      modeSelect.addEventListener('change', updateOpts);
      updateOpts();
    }

    // ROM sharing toggle
    var romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb) romShareCb.addEventListener('change', toggleRomSharing);

    // Show/hide disclaimer based on checkbox
    var romDisclaimer = document.getElementById('rom-sharing-disclaimer');
    if (romShareCb && romDisclaimer) {
      var updateDisclaimer = function () {
        romDisclaimer.style.display = romShareCb.checked ? '' : 'none';
      };
      romShareCb.addEventListener('change', updateDisclaimer);
      updateDisclaimer();
    }

    // ROM sharing accept/decline/cancel buttons
    var romAcceptBtn = document.getElementById('rom-accept-btn');
    if (romAcceptBtn) romAcceptBtn.addEventListener('click', acceptRomSharing);

    var romDeclineBtn = document.getElementById('rom-decline-btn');
    if (romDeclineBtn) romDeclineBtn.addEventListener('click', declineRomSharing);

    var romCancelBtn = document.getElementById('rom-transfer-cancel');
    if (romCancelBtn) romCancelBtn.addEventListener('click', cancelRomTransfer);

    // Delay picker
    var delayAuto = document.getElementById('delay-auto');
    var delaySelect = document.getElementById('delay-select');
    if (delayAuto && delaySelect) {
      delayAuto.addEventListener('change', function () {
        delaySelect.disabled = delayAuto.checked;
      });
    }

    connect();
    startGamepadManager();
    setupRomDrop();

    // Remap wizard buttons
    var remapBtn = document.getElementById('remap-btn');
    if (remapBtn) remapBtn.addEventListener('click', startWizard);

    var resetBtn = document.getElementById('reset-mapping-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetMappings);

    var backBtn = document.getElementById('remap-back');
    if (backBtn) backBtn.addEventListener('click', wizardBack);

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
