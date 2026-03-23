/**
 * play.js — Play Page Controller
 *
 * Owns the Socket.IO connection, pre-game overlay, notifications,
 * in-game toolbar. Orchestrates: lobby → playing → end/leave.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────

  let socket = null;
  let roomCode = null;
  let playerName = null;
  let isHost = false;
  let isSpectator = false;
  let mode = 'lockstep';
  let mySlot = null;
  let lastUsersData = null;
  let engine = null;
  let gameRunning = false;
  let _gameRollbackEnabled = false;
  let previousPlayers = {};
  let previousSpectators = {};
  let _lateJoin = false;
  let _romBlob = null;           // raw ROM Blob for re-creating blob URLs
  let _romBlobUrl = null;
  let _romHash = null;           // SHA-256 hex of loaded ROM
  let _hostRomHash = null;       // host's ROM hash for late-join verification
  let _pendingLateJoin = false;  // waiting for ROM before late-join init
  let _romSharingEnabled = false;   // room-level: host has sharing toggled on
  let _romSharingDecision = null;   // 'accepted', 'declined', or null (page-lifetime)
  let _romTransferInProgress = false;
  let _romTransferChunks = [];
  let _romTransferHeader = null;
  let _romTransferDC = null;        // active rom-transfer DataChannel (receiver side)
  let _romTransferDCs = {};         // active rom-transfer DataChannels (sender side, keyed by sid)
  let _romAcceptPollInterval = null; // polling interval for mid-game accept signaling
  const ROM_MAX_SIZE = 128 * 1024 * 1024;  // 128MB
  const _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const ROM_CHUNK_SIZE = _isMobile ? 16 * 1024 : 64 * 1024;
  const ROM_BUFFER_THRESHOLD = _isMobile ? 256 * 1024 : 1024 * 1024;
  let _romTransferBytesReceived = 0;
  let _romTransferWaitingResume = false;
  let _romTransferResumeAttempts = 0;
  let _romTransferLastChunkAt = 0;
  let _romTransferWatchdog = null;
  let _currentInputType = 'keyboard';    // 'keyboard' or 'gamepad' — last used
  let _autoSpectated = false;       // true if we auto-joined as spectator due to full room

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  // ── URL Params ─────────────────────────────────────────────────────────

  function parseParams() {
    const params = new URLSearchParams(window.location.search);
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
    socket.on('connect_error', (e) => {
      if (!gameRunning) {
        showError(`Connection error: ${e.message}`);
      } else {
        showToast('Connection lost — returning to lobby...');
        setTimeout(() => { window.location.href = '/'; }, 2000);
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
          room_name: `${playerName}'s room`,
          game_id: 'ssb64',
        },
        maxPlayers: 4,
      }, (err) => {
        if (err) { showError(`Failed to create room: ${err}`); return; }
        mySlot = 0;
        showOverlay();
      });
    } else {
      // Non-host: check room exists, then join
      fetch(`/room/${encodeURIComponent(roomCode)}`)
        .then((response) => {
          if (!response.ok) { showError('Room not found'); return; }
          return response.json();
        })
        .then((roomData) => {
          if (!roomData) return;

          // Room full: auto-join as spectator with banner
          if (!isSpectator && roomData.player_count >= roomData.max_players) {
            isSpectator = true;
            _autoSpectated = true;
          }

          socket.emit('join-room', {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
            },
          }, (err, joinData) => {
            if (err) {
              // Room filled between REST check and join — auto-spectate
              if (err === 'Room is full') {
                isSpectator = true;
                _autoSpectated = true;
                socket.emit('join-room', {
                  extra: {
                    sessionid: roomCode,
                    userid: socket.id,
                    player_name: playerName,
                    spectate: true,
                  },
                }, (err2, joinData2) => {
                  if (err2) { showError(`Failed to join: ${err2}`); return; }
                  mySlot = null;
                  if (joinData2) lastUsersData = joinData2;
                  showRoomFullBanner();
                  showOverlay();
                });
                return;
              }
              showError(`Failed to join: ${err}`);
              return;
            }

            if (!isSpectator && joinData && joinData.players) {
              const entries = Object.values(joinData.players);
              for (let i = 0; i < entries.length; i++) {
                if (entries[i].socketId === socket.id) {
                  mySlot = entries[i].slot;
                  break;
                }
              }
            } else if (isSpectator) {
              mySlot = null;
              if (_autoSpectated) showRoomFullBanner();
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

              // Spectators don't need a ROM — they receive a video stream
              // from the host. Skip ROM checks and go straight to engine init.
              if (isSpectator) {
                hideOverlay();
                showToolbar();
                showGameLoading();
                initEngine();
                return;
              }

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
        })
        .catch(() => showError('Failed to connect'));
    }
  }

  // ── Users Updated ──────────────────────────────────────────────────────

  function onUsersUpdated(data) {
    lastUsersData = data;
    const players = data.players || {};
    const spectators = data.spectators || {};
    const ownerSid = data.owner || null;

    // Update ROM sharing state from users-updated (supplementary to rom-sharing-updated)
    if (data.romSharing !== undefined) {
      const wasSharing = _romSharingEnabled;
      _romSharingEnabled = !!data.romSharing;
      if (_romSharingEnabled !== wasSharing) {
        console.log('[play] ROM sharing state from users-updated:', _romSharingEnabled);
        if (_romSharingEnabled && !isHost) showToast('Host is sharing their ROM');
        updateRomSharingUI();
      }
    }

    // Update my slot
    const entries = Object.values(players);
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].socketId === socket.id) {
        mySlot = entries[i].slot;
        break;
      }
    }

    // Detect spectator → player transition (via claim-slot)
    const nowPlayer = mySlot !== null && mySlot !== undefined;
    if (isSpectator && nowPlayer) {
      isSpectator = false;
      if (_romSharingEnabled && _romSharingDecision === null) {
        updateRomSharingUI();
      }
    }

    // Check if we became the host (ownership transfer)
    const wasHost = isHost;
    if (ownerSid) {
      isHost = (ownerSid === socket.id);
    }
    if (!wasHost && isHost) {
      showToast('You are now the host');
    }

    // Diff for toasts
    diffForToasts(players, spectators);
    previousPlayers = structuredClone(players);
    previousSpectators = structuredClone(spectators);

    // Update overlay UI if in pre-game
    if (!gameRunning) {
      updatePlayerList(players, spectators, ownerSid);
      updateStartButton(players);
      updateGamepadSlot();
      // Show/hide host controls after ownership transfer
      const hostControls = document.getElementById('host-controls');
      const guestStatus = document.getElementById('guest-status');
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

    let pid;
    for (pid in players) {
      if (!previousPlayers[pid] && !previousSpectators[pid]) {
        showToast(`${escapeHtml(players[pid].playerName)} joined`);
      }
    }
    for (pid in previousPlayers) {
      if (!players[pid] && !spectators[pid]) {
        showToast(`${escapeHtml(previousPlayers[pid].playerName)} left`);
      }
    }
    for (pid in spectators) {
      if (!previousSpectators[pid] && !previousPlayers[pid]) {
        showToast(`${escapeHtml(spectators[pid].playerName)} is watching`);
      }
    }
    for (pid in previousSpectators) {
      if (!spectators[pid] && !players[pid]) {
        showToast(`${escapeHtml(previousSpectators[pid].playerName)} left`);
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
    // Clear stale status text from previous game
    const toolbarEl = document.getElementById('toolbar-status');
    if (toolbarEl) toolbarEl.textContent = '';
    const loadingText = document.getElementById('game-loading-text');
    if (loadingText) loadingText.textContent = 'Loading...';
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
    // Clear reconnect overlay (may persist from mid-game reconnect)
    const reconnectOverlay = document.getElementById('reconnect-overlay');
    if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
    // Clear stale engine status
    const statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.textContent = '';
    // Clean up ROM transfer state (decision persists for page lifetime)
    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferHeader = null;
    if (_romTransferDC) {
      try { _romTransferDC.close(); } catch (_) {}
      _romTransferDC = null;
    }
    Object.keys(_romTransferDCs).forEach((sid) => {
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
    const reason = (data && data.reason) || 'closed';
    const msg = reason === 'host-left' ? 'Host left — returning to lobby...' : 'Room closed';
    showToast(msg);
    setTimeout(() => { window.location.href = '/'; }, 2000);
  }

  // ── ROM Sharing ──────────────────────────────────────────────────────

  function onRomSharingUpdated(data) {
    const wasEnabled = _romSharingEnabled;
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
    const cb = document.getElementById('opt-rom-sharing');
    if (!cb) return;
    const enabled = cb.checked;
    if (enabled && !_romBlob) {
      cb.checked = false;
      showToast('Load a ROM file before sharing');
      return;
    }
    socket.emit('rom-sharing-toggle', { enabled: enabled });
    // If disabling, close any active rom-transfer DataChannels
    if (!enabled) {
      Object.keys(_romTransferDCs).forEach((sid) => {
        try { _romTransferDCs[sid].close(); } catch (_) {}
      });
      _romTransferDCs = {};
    }
  }

  function updateRomSharingUI() {
    const romDrop = document.getElementById('rom-drop');
    const prompt = document.getElementById('rom-sharing-prompt');
    const progress = document.getElementById('rom-transfer-progress');

    // Host never sees the prompt/progress
    if (isHost) return;
    // Spectators don't need ROMs
    if (isSpectator) return;

    console.log(`[play] updateRomSharingUI: enabled=${_romSharingEnabled}` +
      ` decision=${_romSharingDecision} transfer=${_romTransferInProgress}` +
      ` hasRom=${!!_romBlob}`);

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
    const players = lastUsersData.players;
    for (const pid in players) {
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
      const hostSid = findHostSid();
      if (hostSid) {
        const peers = window._peers || {};
        const hostPeer = peers[hostSid];
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
    _romAcceptPollInterval = setInterval(() => {
      const hostSid = findHostSid();
      if (!hostSid) return;
      const peers = window._peers || {};
      const hostPeer = peers[hostSid];
      if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
        clearInterval(_romAcceptPollInterval);
        _romAcceptPollInterval = null;
        console.log('[play] DC open to host — sending rom-accepted');
        hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
      }
    }, 200);
    setTimeout(() => {
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
    const pc = engine && engine.getPeerConnection ? engine.getPeerConnection(peerSid) : null;
    if (!pc) {
      console.log('[play] no peer connection for', peerSid);
      return;
    }

    const dc = pc.createDataChannel('rom-transfer', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    _romTransferDCs[peerSid] = dc;

    dc.onopen = () => {
      console.log('[play] rom-transfer DC open to', peerSid);
      // Don't auto-send if this was triggered by onPeerReconnected —
      // wait for receiver's rom-resume message with offset instead.
      if (!dc._waitForResume) {
        sendRomOverChannel(dc, peerSid);
      }
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'rom-resume' && msg.offset >= 0) {
            console.log('[play] ROM resume requested from offset', msg.offset);
            sendRomOverChannel(dc, peerSid, msg.offset);
          }
        } catch (_) {}
      }
    };
    dc.onclose = () => {
      delete _romTransferDCs[peerSid];
    };
    dc.onerror = (e) => {
      console.log('[play] rom-transfer DC error:', peerSid, e);
      delete _romTransferDCs[peerSid];
    };
  }

  function sendRomOverChannel(dc, peerSid, startOffset) {
    const romName = localStorage.getItem('kaillera-rom-name') || 'rom.z64';

    if (!startOffset) {
      // Fresh transfer: send header first
      const header = { type: 'rom-header', name: romName, size: _romBlob.size };
      if (_romHash) header.hash = _romHash;
      dc.send(JSON.stringify(header));
    }

    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result;
      let offset = startOffset || 0;
      let chunkIndex = Math.floor(offset / ROM_CHUNK_SIZE);
      let backpressureRetries = 0;
      const MAX_BACKPRESSURE_RETRIES = 3;

      function sendNextChunk() {
        if (dc.readyState !== 'open') {
          console.log('[play] ROM send: DC closed at offset', offset);
          return;
        }
        while (offset < buffer.byteLength) {
          if (dc.bufferedAmount > ROM_BUFFER_THRESHOLD) {
            backpressureRetries = 0;
            waitForDrain();
            return;
          }
          const end = Math.min(offset + ROM_CHUNK_SIZE, buffer.byteLength);
          try {
            dc.send(buffer.slice(offset, end));
          } catch (err) {
            console.log('[play] ROM send error at chunk', chunkIndex,
              'offset', offset, 'buffered', dc.bufferedAmount,
              'state', dc.readyState, err);
            retryChunk(offset, end, 0);
            return;
          }
          offset = end;
          chunkIndex++;
        }
        // All chunks sent
        dc.send(JSON.stringify({ type: 'rom-complete' }));
        console.log('[play] ROM transfer complete to', peerSid);
      }

      function waitForDrain() {
        const drainTimeout = setTimeout(() => {
          dc.onbufferedamountlow = null;
          if (dc.readyState !== 'open') return;
          if (dc.bufferedAmount <= ROM_BUFFER_THRESHOLD) {
            sendNextChunk();
          } else {
            backpressureRetries++;
            if (backpressureRetries >= MAX_BACKPRESSURE_RETRIES) {
              console.log('[play] ROM send: backpressure timeout after',
                MAX_BACKPRESSURE_RETRIES, 'retries at offset', offset);
              showToast('ROM transfer failed — load ROM manually');
              return;
            }
            console.log('[play] ROM send: backpressure retry', backpressureRetries);
            waitForDrain();
          }
        }, 5000);

        dc.onbufferedamountlow = () => {
          clearTimeout(drainTimeout);
          dc.onbufferedamountlow = null;
          backpressureRetries = 0;
          sendNextChunk();
        };
      }

      function retryChunk(chunkStart, chunkEnd, attempt) {
        if (attempt >= 3) {
          console.log('[play] ROM send: chunk retry exhausted at offset', chunkStart);
          showToast('ROM transfer failed — load ROM manually');
          return;
        }
        setTimeout(() => {
          if (dc.readyState !== 'open') return;
          try {
            dc.send(buffer.slice(chunkStart, chunkEnd));
            offset = chunkEnd;
            chunkIndex++;
            sendNextChunk();
          } catch (err) {
            console.log('[play] ROM send: retry', attempt + 1, 'failed:', err);
            retryChunk(chunkStart, chunkEnd, attempt + 1);
          }
        }, 500);
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

    // Resume: keep existing chunks, send resume offset
    if (_romTransferWaitingResume) {
      _romTransferWaitingResume = false;
      _romTransferInProgress = true;
      console.log('[play] resuming ROM transfer from offset', _romTransferBytesReceived);
      channel.onopen = () => {
        channel.send(JSON.stringify({ type: 'rom-resume', offset: _romTransferBytesReceived }));
      };
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'rom-resume', offset: _romTransferBytesReceived }));
      }
    } else {
      // Fresh transfer
      _romTransferChunks = [];
      _romTransferHeader = null;
      _romTransferBytesReceived = 0;
      _romTransferResumeAttempts = 0;
    }

    _romTransferInProgress = true;
    _romTransferLastChunkAt = Date.now();
    startRomTransferWatchdog();

    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'rom-header') {
            if (msg.size > ROM_MAX_SIZE) {
              showToast('ROM too large — loading manually');
              channel.close();
              cancelRomTransfer();
              return;
            }
            _romTransferHeader = msg;
            _romTransferBytesReceived = 0;
            updateRomProgress(0, msg.size);
          } else if (msg.type === 'rom-complete') {
            stopRomTransferWatchdog();
            finishRomTransfer();
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        _romTransferChunks.push(new Uint8Array(e.data));
        _romTransferBytesReceived += e.data.byteLength;
        _romTransferLastChunkAt = Date.now();
        if (_romTransferHeader) {
          updateRomProgress(_romTransferBytesReceived, _romTransferHeader.size);
        }
      }
    };

    channel.onclose = () => {
      if (_romTransferInProgress && !_romBlob) {
        _romTransferInProgress = false;
        _romTransferDC = null;
        stopRomTransferWatchdog();

        if (_romTransferResumeAttempts < 3 && _romTransferBytesReceived > 0) {
          _romTransferResumeAttempts++;
          _romTransferWaitingResume = true;
          showToast(`ROM transfer interrupted — retry ${_romTransferResumeAttempts}/3`);
        } else {
          showToast('ROM transfer failed — load ROM manually');
          _romTransferChunks = [];
          _romTransferWaitingResume = false;
          updateRomSharingUI();
        }
      }
    };

    updateRomSharingUI();
  }

  function startRomTransferWatchdog() {
    stopRomTransferWatchdog();
    _romTransferWatchdog = setInterval(() => {
      if (!_romTransferInProgress || _romTransferWaitingResume) return;
      if (Date.now() - _romTransferLastChunkAt > 10000) {
        console.log('[play] ROM transfer stalled — triggering resume');
        showToast('ROM transfer stalled — retrying...');
        if (_romTransferDC) {
          try { _romTransferDC.close(); } catch (_) {}
        }
        // onclose handler will set _romTransferWaitingResume
      }
    }, 3000);
  }

  function stopRomTransferWatchdog() {
    if (_romTransferWatchdog) {
      clearInterval(_romTransferWatchdog);
      _romTransferWatchdog = null;
    }
  }

  function updateRomProgress(received, total) {
    const bar = document.getElementById('rom-progress-bar');
    const text = document.getElementById('rom-progress-text');
    const pct = total > 0 ? Math.round((received / total) * 100) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (text) {
      const recMB = (received / (1024 * 1024)).toFixed(1);
      const totMB = (total / (1024 * 1024)).toFixed(1);
      text.textContent = `Receiving ROM... ${pct}% (${recMB} / ${totMB} MB)`;
    }
  }

  function finishRomTransfer() {
    let totalSize = 0;
    for (let i = 0; i < _romTransferChunks.length; i++) {
      totalSize += _romTransferChunks[i].byteLength;
    }

    if (_romTransferHeader && _romTransferHeader.size !== totalSize) {
      showToast('ROM transfer size mismatch — load manually');
      _romTransferInProgress = false;
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    const blob = new Blob(_romTransferChunks);
    const displayName = (_romTransferHeader && _romTransferHeader.name) || 'rom.z64';
    const expectedHash = _romTransferHeader ? _romTransferHeader.hash : null;

    // Set ROM data (ephemeral — do NOT cache to IndexedDB)
    _romBlob = blob;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;

    _romTransferInProgress = false;
    _romTransferChunks = [];
    _romTransferDC = null;

    // Verify hash if provided
    const reader = new FileReader();
    reader.onload = () => {
      hashArrayBuffer(reader.result).then((hash) => {
        _romHash = hash;
        if (expectedHash && hash !== expectedHash) {
          showToast('ROM hash mismatch — may cause desync');
        }
        afterRomTransferComplete(displayName);
      }).catch(() => {
        afterRomTransferComplete(displayName);
      });
    };
    reader.readAsArrayBuffer(blob);
  }

  function afterRomTransferComplete(displayName) {
    console.log('[play] ROM transfer complete:', displayName);
    notifyRomReady();

    // Update drop zone to show loaded state
    const romDrop = document.getElementById('rom-drop');
    const statusEl = document.getElementById('rom-status');
    if (romDrop) romDrop.classList.add('loaded');
    if (statusEl) statusEl.textContent = `Loaded: ${displayName} (from host)`;

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
    const emu = window.EJS_emulator;
    if (emu) {
      // Close the emulator's own AudioContext to stop lingering audio.
      // The netplay engine's stop() handles its custom audio pipeline;
      // this catches the EJS/SDL2 AudioContext that runs independently.
      try {
        const gm = emu.gameManager;
        if (gm && gm.Module && gm.Module.SDL2 && gm.Module.SDL2.audioContext) {
          gm.Module.SDL2.audioContext.close();
        }
      } catch (_) {}
    }
    // Wipe EmulatorJS from the DOM entirely — clean slate for next game
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.innerHTML = '';
    window.EJS_emulator = undefined;

    try { delete window.EJS_emulator; } catch (_) {}

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
      window.EJS_gameUrl = _romBlobUrl;
      window.EJS_emulator = new EmulatorJS(
        window.EJS_player || '#game',
        {
          gameUrl: _romBlobUrl,
          dataPath: window.EJS_pathtodata || 'https://cdn.emulatorjs.org/stable/data/',
          system: window.EJS_core || 'n64',
          startOnLoad: true,
        }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    script.onload = () => { console.log('[play] loader.js loaded'); };
    script.onerror = () => { console.log('[play] loader.js FAILED to load'); };
    document.body.appendChild(script);
  }

  function setupRomDrop() {
    const drop = document.getElementById('rom-drop');
    if (!drop) return;

    const savedRom = localStorage.getItem('kaillera-rom-name');
    const statusEl = document.getElementById('rom-status');

    // Prevent browser from navigating to dropped files anywhere on the page
    document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.body.addEventListener('drop', (e) => { e.preventDefault(); });

    // File input fallback (click to browse)
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.z64,.n64,.v64,.zip';
    fileInput.style.display = 'none';
    drop.appendChild(fileInput);

    drop.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleRomFile(fileInput.files[0]);
    });

    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('dragover');
    });

    drop.addEventListener('dragleave', () => {
      drop.classList.remove('dragover');
    });

    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleRomFile(e.dataTransfer.files[0]);
    });

    // Auto-load cached ROM from IndexedDB
    loadCachedRom((cachedName) => {
      if (cachedName) {
        drop.classList.add('loaded');
        if (statusEl) statusEl.textContent = `Loaded: ${cachedName} (drop to change)`;
        // If we were waiting for a ROM to late-join, proceed now
        if (_pendingLateJoin) {
          dismissLateJoinPrompt();
        }
      } else if (savedRom && statusEl) {
        statusEl.textContent = `Last used: ${savedRom} (file not cached — drop again)`;
      }
    });
  }

  function handleRomFile(file) {
    const statusEl = document.getElementById('rom-status');
    const isZip = file.name.toLowerCase().endsWith('.zip');

    if (isZip) {
      if (statusEl) statusEl.textContent = 'Extracting ROM from zip…';
      const reader = new FileReader();
      reader.onload = () => {
        extractRomFromZip(reader.result).then((result) => {
          if (!result) {
            if (statusEl) statusEl.textContent = 'No ROM found in zip (.z64/.n64/.v64)';
            return;
          }
          const romBlob = new Blob([result.data]);
          const romFile = new File([romBlob], result.name);
          loadRomData(romFile, result.name);
        }).catch((err) => {
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

    const drop = document.getElementById('rom-drop');
    if (drop) drop.classList.add('loaded');
    const statusEl = document.getElementById('rom-status');
    if (statusEl) statusEl.textContent = `Loaded: ${displayName}`;

    // Enable ROM sharing checkbox if host
    const romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb && isHost) romShareCb.disabled = false;

    // Compute ROM hash and proceed with any pending late-join
    const reader = new FileReader();
    reader.onload = () => {
      hashArrayBuffer(reader.result).then((hash) => {
        _romHash = hash;
        localStorage.setItem('kaillera-rom-hash', hash);
        console.log(`[play] ROM hash: ${hash.substring(0, 16)}…`);
      }).catch((err) => {
        console.log('[play] hash failed:', err);
      }).then(() => {
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

  const _ROM_EXTS = ['.z64', '.n64', '.v64', '.ndd'];

  function extractRomFromZip(arrayBuffer) {
    // Minimal ZIP parser using the central directory (reliable sizes).
    // Supports STORED (0) and DEFLATE (8) compression methods.
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.length;

    // Find End of Central Directory record (last 22+ bytes of file)
    let eocdOffset = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) return Promise.resolve(null);

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);

    // Walk central directory entries
    let pos = cdOffset;
    for (let e = 0; e < cdEntries && pos + 46 <= len; e++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;

      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);

      const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);

      const lower = fileName.toLowerCase();
      let isRom = false;
      for (let j = 0; j < _ROM_EXTS.length; j++) {
        if (lower.endsWith(_ROM_EXTS[j])) { isRom = true; break; }
      }

      if (isRom && compSize > 0) {
        // Read local file header to find data start
        const lNameLen = view.getUint16(localHeaderOffset + 26, true);
        const lExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        const compData = bytes.subarray(dataStart, dataStart + compSize);
        const baseName = fileName.split('/').pop();

        if (method === 0) {
          return Promise.resolve({ name: baseName, data: compData.slice() });
        } else if (method === 8) {
          const blob = new Blob([compData]);
          const ds = new DecompressionStream('deflate-raw');
          const decompressed = blob.stream().pipeThrough(ds);
          return new Response(decompressed).arrayBuffer().then((buf) => {
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
      return crypto.subtle.digest('SHA-256', buf).then((digest) => {
        const arr = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < arr.length; i++) {
          hex += ('0' + arr[i].toString(16)).slice(-2);
        }
        return hex;
      });
    }
    // Fallback: FNV-1a 64-bit (good enough for mismatch detection)
    const bytes = new Uint8Array(buf);
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x811c9dc5 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      if (i & 1) {
        h1 = (h1 ^ bytes[i]) >>> 0;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
      } else {
        h2 = (h2 ^ bytes[i]) >>> 0;
        h2 = Math.imul(h2, 0x01000193) >>> 0;
      }
    }
    let hex = ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
    // Pad to 64 chars to match SHA-256 length for server validation
    while (hex.length < 64) hex += '0';
    return Promise.resolve(hex);
  }

  // ── ROM IDB Cache ──────────────────────────────────────────────────────

  const _ROM_DB = 'kaillera-rom-cache';
  const _ROM_STORE = 'roms';

  function openRomDB(cb) {
    const req = indexedDB.open(_ROM_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(_ROM_STORE); };
    req.onsuccess = () => { cb(req.result); };
    req.onerror = () => { cb(null); };
  }

  function cacheRom(file) {
    const reader = new FileReader();
    reader.onload = () => {
      openRomDB((db) => {
        if (!db) return;
        const tx = db.transaction(_ROM_STORE, 'readwrite');
        tx.objectStore(_ROM_STORE).put(reader.result, 'current');
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function loadCachedRom(cb) {
    const name = localStorage.getItem('kaillera-rom-name');
    if (!name) { cb(null); return; }
    openRomDB((db) => {
      if (!db) { cb(null); return; }
      const tx = db.transaction(_ROM_STORE, 'readonly');
      const req = tx.objectStore(_ROM_STORE).get('current');
      req.onsuccess = () => {
        if (!req.result) { cb(null); return; }
        const blob = new Blob([req.result]);
        _romBlob = blob;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        // Compute hash from cached data
        hashArrayBuffer(req.result).then((hash) => {
          _romHash = hash;
          localStorage.setItem('kaillera-rom-hash', hash);
          notifyRomReady();
          cb(name);
        });
      };
      req.onerror = () => { cb(null); };
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

    const Engine = mode === 'streaming'
      ? window.NetplayStreaming
      : window.NetplayLockstep;

    if (!Engine) {
      showError('Netplay engine not loaded');
      return;
    }

    const rollbackEnabled = _gameRollbackEnabled;

    engine = Engine;
    engine.init({
      socket: socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      isSpectator: isSpectator,
      playerName: playerName,
      gameElement: document.getElementById('game'),
      rollbackEnabled: rollbackEnabled,
      onStatus: (msg) => {
        // Show in toolbar (visible during gameplay) and overlay (visible pre-game)
        const toolbarEl = document.getElementById('toolbar-status');
        if (toolbarEl) toolbarEl.textContent = msg;
        const overlayEl = document.getElementById('engine-status');
        if (overlayEl) overlayEl.textContent = msg;
        // Update game loading overlay
        const loadingText = document.getElementById('game-loading-text');
        if (loadingText) loadingText.textContent = msg;
        // Dismiss loading overlay when lockstep loop starts
        if (msg.indexOf('game on') !== -1 || msg.indexOf('Spectating') !== -1) {
          dismissGameLoading();
        }
      },
      onPlayersChanged: () => {
        // Engine forwards users-updated — supplementary to our direct listener
      },
      onToast: showToast,
      onReconnecting: (sid, isReconnecting) => {
        const overlay = document.getElementById('reconnect-overlay');
        if (!overlay) return;

        if (!isReconnecting) {
          // Always hide on false (reconnect resolved, game ended, or cleanup)
          overlay.classList.add('hidden');
          return;
        }

        // Only show overlay if ALL our DCs are down (we're the disconnected one).
        const peers = window._peers || {};
        const hasOpenDC = Object.values(peers).some((p) => {
          return p.dc && p.dc.readyState === 'open';
        });

        if (!hasOpenDC) {
          overlay.classList.remove('hidden');
          const text = document.getElementById('reconnect-text');
          const rejoinBtn = document.getElementById('reconnect-rejoin');
          if (text) text.textContent = 'Connection lost — reconnecting...';
          if (rejoinBtn) rejoinBtn.classList.add('hidden');
        }
      },
      onPeerReconnected: (sid) => {
        // Resume ROM transfer if waiting — mark DC to wait for receiver's rom-resume
        if (_romTransferWaitingResume && engine && engine.getPeerConnection) {
          startRomTransferTo(sid);
          // Mark the just-created DC as resume-aware so onopen doesn't auto-send
          if (_romTransferDCs[sid]) {
            _romTransferDCs[sid]._waitForResume = true;
          }
        }
      },
      initialPlayers: lastUsersData,
      lateJoin: _lateJoin,
    });
    _lateJoin = false;

    // Register ROM sharing delegation hooks
    if (engine.onExtraDataChannel) {
      engine.onExtraDataChannel((remoteSid, channel) => {
        onExtraDataChannel(remoteSid, channel);
      });
    }
    if (engine.onUnhandledMessage) {
      engine.onUnhandledMessage((remoteSid, msg) => {
        onUnhandledEngineMessage(remoteSid, msg);
      });
    }
  }

  function startGame() {
    if (!_romBlob && !_romBlobUrl) {
      showToast('Load a ROM file before starting');
      return;
    }
    const sel = document.getElementById('mode-select');
    const selectedMode = sel ? sel.value : mode;
    const optRollback = document.getElementById('opt-rollback');
    socket.emit('start-game', {
      mode: selectedMode,
      rollbackEnabled: optRollback ? optRollback.checked : false,
      romHash: _romHash || null,
    }, (err) => {
      if (err) showToast(err);
    });
  }

  function endGame() {
    socket.emit('end-game', {}, (err) => {
      if (err) {
        console.log('[play] end-game error:', err);
        showToast(`End game failed: ${err}`);
      }
    });
  }

  function leaveGame() {
    // Notify peers this is intentional (prevents reconnect attempt)
    if (engine && window._peers) {
      Object.values(window._peers).forEach((p) => {
        if (p.dc && p.dc.readyState === 'open') {
          try { p.dc.send('leaving'); } catch (_) {}
        }
      });
    }
    socket.emit('leave-room', {});
    if (engine) { engine.stop(); engine = null; }
    window.location.href = '/';
  }

  // ── Late-Join ROM Prompt ─────────────────────────────────────────────

  function showLateJoinRomPrompt() {
    // Show the overlay with only the ROM drop zone visible
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Hide everything except the ROM section
    const sections = overlay.querySelectorAll('.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status');
    for (let i = 0; i < sections.length; i++) {
      sections[i].style.display = 'none';
    }

    // Show only the ROM drop section
    const romDrop = document.getElementById('rom-drop');
    if (romDrop && romDrop.parentNode) romDrop.parentNode.style.display = '';

    // Add a heading message
    const card = overlay.querySelector('.overlay-card');
    if (card) {
      const msg = document.createElement('p');
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
    const msg = document.getElementById('late-join-msg');
    if (msg) msg.parentNode.removeChild(msg);

    // Restore all sections visibility
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      const sections = overlay.querySelectorAll('.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status');
      for (let i = 0; i < sections.length; i++) {
        sections[i].style.display = '';
      }
    }

    // Now proceed with late join
    showToolbar();
    initEngine();
  }

  // ── UI: Overlay ────────────────────────────────────────────────────────

  function showOverlay() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('hidden');

    const roomDisplay = document.getElementById('room-display');
    if (roomDisplay) roomDisplay.textContent = roomCode;

    const hostControls = document.getElementById('host-controls');
    const guestStatus = document.getElementById('guest-status');

    if (isHost) {
      if (hostControls) hostControls.style.display = '';
      if (guestStatus) guestStatus.style.display = 'none';
    } else {
      if (hostControls) hostControls.style.display = 'none';
      if (guestStatus) guestStatus.style.display = '';
    }

    // Show player controls (delay picker) for all non-spectator players in lockstep mode
    const playerControls = document.getElementById('player-controls');
    if (playerControls) {
      playerControls.style.display = (!isSpectator && mode === 'lockstep') ? '' : 'none';
    }

    const modeSel = document.getElementById('mode-select');
    if (modeSel) modeSel.value = mode;
  }

  function hideOverlay() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function updatePlayerList(players, spectators, ownerSid) {
    for (let i = 0; i < 4; i++) {
      const slotEl = document.querySelector(`.player-slot[data-slot="${i}"]`);
      if (!slotEl) continue;
      const nameEl = slotEl.querySelector('.name');
      if (!nameEl) continue;

      let playerInSlot = null;
      const entries = Object.values(players);
      for (let j = 0; j < entries.length; j++) {
        if (entries[j].slot === i) { playerInSlot = entries[j]; break; }
      }

      const gpEl = slotEl.querySelector('.gamepad');

      if (playerInSlot) {
        const isOwner = ownerSid && playerInSlot.socketId === ownerSid;
        let suffix = isOwner ? ' (host)' : '';
        if (!playerInSlot.romReady && !_romSharingEnabled) suffix += ' — no ROM';
        nameEl.textContent = playerInSlot.playerName + suffix;
        nameEl.classList.remove('empty');
        // Show input type indicator
        if (gpEl) {
          const itype = playerInSlot.inputType || 'keyboard';
          gpEl.textContent = itype === 'gamepad' ? '\uD83C\uDFAE' : '\u2328\uFE0F';
          gpEl.title = itype === 'gamepad' ? 'Gamepad' : 'Keyboard';
        }
      } else {
        nameEl.textContent = 'Open';
        nameEl.classList.add('empty');
        if (gpEl) { gpEl.textContent = ''; gpEl.title = ''; }
      }
    }

    const specEl = document.getElementById('spectator-list');
    if (specEl) {
      const specNames = Object.values(spectators).map((s) => { return s.playerName; });
      specEl.textContent = specNames.length > 0 ? `Watching: ${specNames.join(', ')}` : '';
    }
  }

  function updateStartButton(players) {
    const btn = document.getElementById('start-btn');
    if (!btn || !isHost) return;
    const playerCount = Object.keys(players).length;
    const entries = Object.values(players);
    const allReady = entries.every((p) => { return p.romReady; });

    if (playerCount < 2) {
      btn.disabled = true;
      btn.textContent = 'Start Game (need 2+)';
    } else if (!allReady && !_romSharingEnabled) {
      btn.disabled = true;
      const readyCount = entries.filter((p) => { return p.romReady; }).length;
      btn.textContent = `Waiting for ROMs (${readyCount}/${playerCount})`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Start Game';
    }
  }

  // ── UI: Toolbar ────────────────────────────────────────────────────────

  function showGameLoading() {
    const el = document.getElementById('game-loading');
    if (el) {
      el.classList.remove('hidden', 'fade-out');
    }
  }

  function dismissGameLoading() {
    const el = document.getElementById('game-loading');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('fade-out');
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('fade-out');
    }, 400);
  }

  function showToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    const roomEl = document.getElementById('toolbar-room');
    if (roomEl) roomEl.textContent = `Room: ${roomCode}`;

    const endBtn = document.getElementById('toolbar-end');
    if (endBtn) endBtn.style.display = isHost ? '' : 'none';

  }

  function hideToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.add('hidden');
    hideInfoOverlay();
  }

  // ── UI: Info Overlay ──────────────────────────────────────────────────

  let _infoVisible = false;
  let _infoInterval = null;

  function toggleInfoOverlay() {
    _infoVisible = !_infoVisible;
    const el = document.getElementById('info-overlay');
    const btn = document.getElementById('toolbar-info');
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
    const el = document.getElementById('info-overlay');
    const btn = document.getElementById('toolbar-info');
    if (el) el.classList.add('hidden');
    if (btn) btn.classList.remove('active');
    if (_infoInterval) { clearInterval(_infoInterval); _infoInterval = null; }
  }

  function updateInfoOverlay() {
    const info = engine && engine.getInfo ? engine.getInfo() : null;

    const headerEl = document.getElementById('info-header');
    const statsEl = document.getElementById('info-stats');
    const peersEl = document.getElementById('info-peers');

    if (!info) {
      if (headerEl) headerEl.textContent = '';
      if (statsEl) statsEl.textContent = 'FPS: -- | Ping: --';
      if (peersEl) peersEl.textContent = '';
      return;
    }

    // Header: mode + input type
    const inputType = (window.GamepadManager && window.GamepadManager.hasGamepad && window.GamepadManager.hasGamepad(mySlot))
      ? 'Gamepad' : 'Keyboard';
    const modeLabel = info.mode === 'streaming' ? 'Streaming' : 'Lockstep';
    if (headerEl) headerEl.textContent = `${modeLabel} | ${inputType}`;

    // Stats line
    const parts = [];
    parts.push(`FPS: ${info.fps || 0}`);
    const pingStr = info.ping !== null && info.ping !== undefined
      ? `${Math.round(info.ping)}ms` : '--';
    parts.push(`Ping: ${pingStr}`);

    if (info.mode === 'lockstep') {
      parts.push(`Delay: ${info.frameDelay}f`);
      parts.push(`Players: ${info.playerCount}`);
      if (info.syncEnabled && info.resyncCount > 0) {
        parts.push(`Resyncs: ${info.resyncCount}`);
      }
    } else {
      // Streaming: codec + resolution
      if (info.codec && info.codec !== '?') parts.push(info.codec);
      if (info.resolution && info.resolution !== '?x?') parts.push(info.resolution);
      parts.push(`Players: ${info.playerCount}`);
    }
    if (statsEl) statsEl.textContent = parts.join(' | ');

    // Peers detail
    const peerLines = [];
    if (info.mode === 'lockstep' && info.peers) {
      info.peers.forEach((p) => {
        const pRtt = p.rtt !== null ? `${Math.round(p.rtt)}ms` : '--';
        peerLines.push(`P${p.slot + 1}: ${pRtt}`);
      });
    } else if (info.mode === 'streaming') {
      // Streaming-specific detail (values are numeric from gatherStats)
      if (info.encodeTime !== null) peerLines.push(`Encode: ${info.encodeTime}ms`);
      if (info.bitrate !== null) peerLines.push(`BW: ${info.bitrate}Mbps`);
      if (info.jitter !== null) peerLines.push(`Jitter: ${info.jitter}ms`);
      if (info.lossRate && info.lossRate > 0) peerLines.push(`Loss: ${info.lossRate}%`);
    }
    if (peersEl) peersEl.textContent = peerLines.join(' | ');
  }

  // ── UI: Toast Notifications ───────────────────────────────────────────

  function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 2700);
  }

  // ── UI: Error ──────────────────────────────────────────────────────────

  function showError(msg) {
    const el = document.getElementById('error-msg');
    if (!el) return;
    el.classList.remove('hidden');
    const card = el.querySelector('.error-card');
    if (!card) return;
    card.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.textContent = 'Error';
    const p = document.createElement('p');
    p.textContent = msg;
    const a = document.createElement('a');
    a.href = '/';
    a.className = 'error-back';
    a.textContent = 'Back to Lobby';
    card.appendChild(h3);
    card.appendChild(p);
    card.appendChild(a);
  }

  function showRoomFullBanner() {
    const banner = document.createElement('div');
    banner.className = 'room-full-banner';
    banner.innerHTML = '<span>Game is full \u2014 you\u2019ve joined as a spectator</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'banner-close';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = () => { banner.remove(); };
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 5000);
  }

  // ── UI: Copy Link ─────────────────────────────────────────────────────

  function copyLink() {
    const url = `${window.location.origin}/play.html?room=${roomCode}`;
    // navigator.clipboard requires HTTPS; use execCommand fallback for HTTP
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied!');
      });
    } else {
      const ta = document.createElement('textarea');
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

  // ── UI: In-Game Share Dropdown ──────────────────────────────────────

  function copyToClipboard(text, label) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(`${label} copied!`);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(`${label} copied!`);
    }
  }

  function toggleShareDropdown() {
    const dd = document.getElementById('share-dropdown');
    const btn = document.getElementById('toolbar-share');
    if (!dd) return;
    const isOpen = !dd.classList.contains('hidden');
    if (isOpen) {
      dd.classList.add('hidden');
      if (btn) btn.classList.remove('active');
    } else {
      dd.classList.remove('hidden');
      if (btn) btn.classList.add('active');
    }
  }

  function closeShareDropdown() {
    const dd = document.getElementById('share-dropdown');
    const btn = document.getElementById('toolbar-share');
    if (dd) dd.classList.add('hidden');
    if (btn) btn.classList.remove('active');
  }

  // ── Gamepad Detection ─────────────────────────────────────────────────

  // ── Input Type Detection ─────────────────────────────────────────────

  function setInputType(type) {
    if (type === _currentInputType) return;
    _currentInputType = type;
    if (socket && socket.connected) {
      socket.emit('input-type', { type: type });
    }
  }

  function setupInputTypeDetection() {
    // Keyboard → set to keyboard
    document.addEventListener('keydown', () => {
      setInputType('keyboard');
    });

    // Gamepad → set to gamepad (checked via GamepadManager onUpdate)
    // The updateGamepadUI callback already fires on gamepad changes;
    // we piggyback on that in updateGamepadUI below.
  }

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
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    const assignments = window.GamepadManager ? GamepadManager.getAssignments() : {};
    const statusEl = document.getElementById('gamepad-status');

    // Update input type based on gamepad detection
    if (detected.length > 0) {
      setInputType('gamepad');
    }

    if (statusEl && !_wizardActive) {
      if (detected.length > 0) {
        const primary = detected[0];
        statusEl.textContent = `${primary.id.substring(0, 40)} (${primary.profileName})`;
        statusEl.className = 'gamepad-detected';
      } else {
        statusEl.textContent = 'No controller — press any button to detect';
        statusEl.className = '';
      }
    }

    // Hide EJS virtual gamepad when a real gamepad is connected (and vice versa)
    const ejs = window.EJS_emulator;
    if (ejs && ejs.virtualGamepad) {
      if (detected.length > 0) {
        ejs.virtualGamepad.style.display = 'none';
      } else if (ejs.touch) {
        ejs.virtualGamepad.style.display = '';
      }
    }

    // Update .gamepad spans in player slots
    for (let i = 0; i < 4; i++) {
      const span = document.querySelector(`.player-slot[data-slot="${i}"] .gamepad`);
      if (!span) continue;
      const assignment = assignments[i];
      if (assignment) {
        span.textContent = '\uD83C\uDFAE'; // gamepad emoji
        span.title = `${assignment.gamepadId} (${assignment.profileName})`;
      } else {
        span.textContent = '';
        span.title = '';
      }
    }
  }

  // ── Remap Wizard ──────────────────────────────────────────────────────

  const WIZARD_STEPS = [
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

  let _wizardActive = false;
  let _wizardStep = 0;
  let _wizardDebounce = 0;
  let _wizardRafId = null;
  let _wizardKeyHandler = null;
  let _wizardGamepadProfile = null;
  let _wizardKeyMap = null;
  let _wizardBaselineButtons = null;
  let _wizardAxisCaptures = {};
  let _wizardSnapshots = [];  // state snapshots for go-back
  let _wizardHadGamepad = false;
  let _wizardHotPlugCheck = 0;

  function startWizard() {
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    const gamepadId = detected.length > 0 ? detected[0].id : null;

    // Initialize gamepad profile from current (default or saved)
    if (gamepadId && window.GamepadManager) {
      const current = GamepadManager.hasCustomProfile(gamepadId)
        ? JSON.parse(localStorage.getItem(`gamepad-profile:${gamepadId}`))
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
    let savedKb = null;
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
    const wizardEl = document.getElementById('remap-wizard');
    const controlsEl = document.getElementById('gamepad-controls');
    const statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = '';
    if (controlsEl) controlsEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';

    // Capture baseline gamepad buttons (ignore already-pressed)
    _wizardBaselineButtons = {};
    if (gamepadId) {
      const gps = navigator.getGamepads();
      for (let gi = 0; gi < gps.length; gi++) {
        if (gps[gi]) {
          for (let bi = 0; bi < gps[gi].buttons.length; bi++) {
            if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[`${gi}:${bi}`] = true;
          }
        }
      }
    }

    // Keyboard listener
    _wizardKeyHandler = (e) => {
      if (!_wizardActive) return;
      if (e.keyCode === 27) { cancelWizard(); return; } // Escape
      e.preventDefault();
      if (Date.now() < _wizardDebounce) return;
      captureKeyboard(e.keyCode);
    };
    document.addEventListener('keydown', _wizardKeyHandler, true);

    // Track initial gamepad presence for hot-plug notifications
    const initGps = navigator.getGamepads();
    _wizardHadGamepad = false;
    for (let gi2 = 0; gi2 < initGps.length; gi2++) {
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

    const wizardEl = document.getElementById('remap-wizard');
    const controlsEl = document.getElementById('gamepad-controls');
    const statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = '';
    if (statusEl) statusEl.style.display = '';
  }

  function saveWizard() {
    // Save gamepad profile
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && _wizardGamepadProfile) {
      // Assemble axis captures into profile
      for (const groupName in _wizardAxisCaptures) {
        const cap = _wizardAxisCaptures[groupName];
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
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && window.GamepadManager) {
      GamepadManager.clearGamepadProfile(detected[0].id);
    }
    try { localStorage.removeItem('keyboard-mapping'); } catch (_) {}
    updateGamepadUI();
  }

  function updateWizardPrompt() {
    const promptEl = document.getElementById('remap-prompt');
    const progressEl = document.getElementById('remap-progress');
    const backBtn = document.getElementById('remap-back');
    if (promptEl) promptEl.textContent = `${WIZARD_STEPS[_wizardStep].prompt} (gamepad or key)`;
    if (progressEl) progressEl.textContent = `(${_wizardStep + 1}/${WIZARD_STEPS.length})`;
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
    const gps = navigator.getGamepads();
    for (let gi = 0; gi < gps.length; gi++) {
      if (gps[gi]) {
        for (let bi = 0; bi < gps[gi].buttons.length; bi++) {
          if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[`${gi}:${bi}`] = true;
        }
      }
    }
    updateWizardPrompt();
  }

  function wizardBack() {
    if (!_wizardActive || _wizardStep === 0 || _wizardSnapshots.length === 0) return;
    const snap = _wizardSnapshots.pop();
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

    const gps = navigator.getGamepads();

    // Hot-plug detection (check every ~30 frames / 500ms)
    _wizardHotPlugCheck++;
    if (_wizardHotPlugCheck % 30 === 0) {
      let hasNow = false;
      for (let hi = 0; hi < gps.length; hi++) {
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

    const step = WIZARD_STEPS[_wizardStep];

    for (let gi = 0; gi < gps.length; gi++) {
      const gp = gps[gi];
      if (!gp) continue;

      // Check buttons (for button and cbutton steps)
      if (step.type === 'button' || step.type === 'cbutton') {
        for (let bi = 0; bi < gp.buttons.length; bi++) {
          if (gp.buttons[bi].pressed && !_wizardBaselineButtons[`${gi}:${bi}`]) {
            captureGamepadButton(bi, step);
            return;
          }
        }
      }

      // Check axes (for axis and cbutton steps)
      if (step.type === 'axis' || step.type === 'cbutton') {
        const dz = 0.5;  // higher than gameplay deadzone to avoid accidental captures
        for (let ai = 0; ai < gp.axes.length; ai++) {
          const val = gp.axes[ai];
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
      const group = step.axisGroup;
      if (!_wizardAxisCaptures[group]) {
        _wizardAxisCaptures[group] = {};
      }
      const cap = _wizardAxisCaptures[group];

      // Check if partner direction was already captured on a different axis
      if (cap.index !== undefined && cap.index !== axisIndex) {
        const promptEl = document.getElementById('remap-prompt');
        if (promptEl) {
          const pairName = group === 'stickY' ? 'UP' : 'LEFT';
          promptEl.textContent = `Must use same stick as ${pairName} — try again`;
          setTimeout(() => { updateWizardPrompt(); }, 1000);
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
    const step = WIZARD_STEPS[_wizardStep];
    wizardSaveSnapshot();

    // Remove old entry for this keyCode (key can only map to one function)
    for (const k in _wizardKeyMap) {
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
    const autoEl = document.getElementById('delay-auto');
    const selectEl = document.getElementById('delay-select');
    if (autoEl && autoEl.checked) {
      return window._delayAutoValue;
    }
    if (selectEl) {
      const v = parseInt(selectEl.value, 10);
      return v > 0 ? v : 2;
    }
    return 2;
  }

  window.getDelayPreference = getDelayPreference;

  function setAutoDelay(value) {
    window._delayAutoValue = value;
    const selectEl = document.getElementById('delay-select');
    const autoEl = document.getElementById('delay-auto');
    if (selectEl && autoEl && autoEl.checked) {
      selectEl.value = String(value);
    }
  }

  window.setAutoDelay = setAutoDelay;

  function showEffectiveDelay(own, room) {
    const el = document.getElementById('delay-effective');
    if (!el) return;
    if (room > own) {
      el.textContent = `(room: ${room})`;
    } else {
      el.textContent = '';
    }
  }

  window.showEffectiveDelay = showEffectiveDelay;

  // ── Init ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    parseParams();
    if (!roomCode) {
      window.location.href = '/';
      return;
    }

    // Wire up buttons
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.addEventListener('click', startGame);

    const leaveBtn = document.getElementById('leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', leaveGame);

    const toolbarLeave = document.getElementById('toolbar-leave');
    if (toolbarLeave) toolbarLeave.addEventListener('click', leaveGame);

    const toolbarEnd = document.getElementById('toolbar-end');
    if (toolbarEnd) toolbarEnd.addEventListener('click', endGame);

    const toolbarInfo = document.getElementById('toolbar-info');
    if (toolbarInfo) toolbarInfo.addEventListener('click', toggleInfoOverlay);

    const toolbarShare = document.getElementById('toolbar-share');
    if (toolbarShare) toolbarShare.addEventListener('click', toggleShareDropdown);

    const sharePlay = document.getElementById('share-play');
    if (sharePlay) sharePlay.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}`;
      copyToClipboard(url, 'Play link');
      closeShareDropdown();
    });

    const shareWatch = document.getElementById('share-watch');
    if (shareWatch) shareWatch.addEventListener('click', () => {
      const url = `${window.location.origin}/play.html?room=${roomCode}&spectate=1`;
      copyToClipboard(url, 'Watch link');
      closeShareDropdown();
    });

    // Close share dropdown on outside click or Escape
    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('share-wrapper');
      if (wrapper && !wrapper.contains(e.target)) closeShareDropdown();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeShareDropdown();
    });

    const copyBtn = document.getElementById('copy-link');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    // Show/hide lockstep options based on mode selector
    const modeSelect = document.getElementById('mode-select');
    const lockstepOpts = document.getElementById('lockstep-options');
    if (modeSelect && lockstepOpts) {
      // Set mode-select from URL params before running updateOpts
      modeSelect.value = mode;
      const updateOpts = () => {
        const isLockstep = modeSelect.value === 'lockstep';
        lockstepOpts.style.display = isLockstep ? '' : 'none';
        // Toggle player controls (delay picker) for all players
        const pc = document.getElementById('player-controls');
        if (pc) pc.style.display = isLockstep ? '' : 'none';
        // Hide ROM sharing options in streaming mode
        const romSharingRow = document.getElementById('rom-sharing-options');
        const romSharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
        if (romSharingRow) romSharingRow.style.display = isLockstep ? '' : 'none';
        if (!isLockstep && romSharingDisclaimer) romSharingDisclaimer.style.display = 'none';
        // Auto-disable sharing when switching to streaming
        if (!isLockstep) {
          const cb = document.getElementById('opt-rom-sharing');
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
    const romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb) romShareCb.addEventListener('change', toggleRomSharing);

    // Show/hide disclaimer based on checkbox
    const romDisclaimer = document.getElementById('rom-sharing-disclaimer');
    if (romShareCb && romDisclaimer) {
      const updateDisclaimer = () => {
        romDisclaimer.style.display = romShareCb.checked ? '' : 'none';
      };
      romShareCb.addEventListener('change', updateDisclaimer);
      updateDisclaimer();
    }

    // ROM sharing accept/decline/cancel buttons
    const romAcceptBtn = document.getElementById('rom-accept-btn');
    if (romAcceptBtn) romAcceptBtn.addEventListener('click', acceptRomSharing);

    const romDeclineBtn = document.getElementById('rom-decline-btn');
    if (romDeclineBtn) romDeclineBtn.addEventListener('click', declineRomSharing);

    const romCancelBtn = document.getElementById('rom-transfer-cancel');
    if (romCancelBtn) romCancelBtn.addEventListener('click', cancelRomTransfer);

    // Delay picker
    const delayAuto = document.getElementById('delay-auto');
    const delaySelect = document.getElementById('delay-select');
    if (delayAuto && delaySelect) {
      delayAuto.addEventListener('change', () => {
        delaySelect.disabled = delayAuto.checked;
      });
    }

    connect();
    startGamepadManager();
    setupInputTypeDetection();
    setupRomDrop();

    // Remap wizard buttons
    const remapBtn = document.getElementById('remap-btn');
    if (remapBtn) remapBtn.addEventListener('click', startWizard);

    const resetBtn = document.getElementById('reset-mapping-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetMappings);

    const backBtn = document.getElementById('remap-back');
    if (backBtn) backBtn.addEventListener('click', wizardBack);

    const skipBtn = document.getElementById('remap-skip');
    if (skipBtn) skipBtn.addEventListener('click', wizardSkip);

    const cancelBtn = document.getElementById('remap-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelWizard);

    // Click .gamepad span to cycle through detected gamepads
    const gamepadSpans = document.querySelectorAll('.player-slot .gamepad');
    for (let gi = 0; gi < gamepadSpans.length; gi++) {
      const span = gamepadSpans[gi];
      span.style.cursor = 'pointer';
      span.addEventListener('click', () => {
        if (!window.GamepadManager) return;
        const slotEl = span.closest('.player-slot');
        if (!slotEl) return;
        const slot = parseInt(slotEl.getAttribute('data-slot'), 10);
        if (slot !== mySlot) return; // only reassign own slot

        const detected = GamepadManager.getDetected();
        if (detected.length <= 1) return; // nothing to cycle

        const assignments = GamepadManager.getAssignments();
        const currentIdx = assignments[slot] ? assignments[slot].gamepadIndex : -1;
        // Find next gamepad in detected list
        let nextIdx = detected[0].index;
        for (let d = 0; d < detected.length; d++) {
          if (detected[d].index === currentIdx && d + 1 < detected.length) {
            nextIdx = detected[d + 1].index;
            break;
          }
        }
        // Wrap around
        if (nextIdx === currentIdx) nextIdx = detected[0].index;
        GamepadManager.reassignSlot(slot, nextIdx);
      });
    }
  });
})();
