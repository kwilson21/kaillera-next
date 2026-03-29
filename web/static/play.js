/**
 * play.js — Play Page Controller
 *
 * The main orchestrator for the game page. Owns the Socket.IO connection,
 * pre-game overlay, in-game toolbar, and all UI outside the emulator canvas.
 * Delegates actual netplay logic to LockstepEngine or StreamingEngine.
 *
 * ── Page Lifecycle ──────────────────────────────────────────────────────
 *
 *   1. Parse URL params (?room=, &host=1, &name=, &mode=)
 *   2. Connect Socket.IO → on connect, open-room (host) or join-room (guest)
 *   3. Show pre-game overlay: player list, mode select, ROM drop zone
 *   4. Host clicks "Start Game" → server broadcasts game-started
 *   5. onGameStarted(): boot EmulatorJS, create engine (lockstep or streaming)
 *   6. Engine runs the game; play.js updates toolbar, info overlay, toasts
 *   7. Host clicks "End Game" → server broadcasts game-ended
 *   8. onGameEnded(): hibernate emulator (keep WASM alive), return to overlay
 *   9. Next game: wake emulator, create new engine — no page reload needed
 *
 * ── Emulator Lifecycle ──────────────────────────────────────────────────
 *
 *   The WASM module is kept alive between games via hibernateEmulator() /
 *   wakeEmulator(). Emscripten's main loop corrupts on the 3rd
 *   EmulatorJS destroy/recreate cycle, so we never destroy — we pause
 *   the emulator, hide the canvas, and suppress EJS UI via CSS. Mode
 *   switching (lockstep ↔ streaming) works without page reload.
 *
 * ── Major Sections ──────────────────────────────────────────────────────
 *
 *   State & URL params .............. ~line 14
 *   Socket.IO connection ............ ~line 151
 *   Users updated handler ........... ~line 484
 *   Game lifecycle (start/end) ...... ~line 591
 *   ROM sharing UI + consent ........ ~line 715
 *   Pre-game ROM preloading ......... ~line 1010
 *   ROM transfer (host sending) ..... ~line 1148
 *   ROM transfer (guest receiving) .. ~line 1303
 *   ZIP extraction .................. ~line 1918
 *   ROM IDB cache ................... ~line 1976
 *   Sync log upload ................. ~line 2210
 *   Late-join ROM prompt ............ ~line 2264
 *   UI: Overlay ..................... ~line 2324
 *   UI: Toolbar ..................... ~line 2495
 *   UI: Info overlay ................ ~line 2545
 *   UI: Toasts / errors / share ..... ~line 2632
 *   Gamepad detection + remap wizard  ~line 2737
 *   Delay preference ................ ~line 3245
 *   Init ............................ ~line 3290
 *
 * ── Cross-Module Communication ──────────────────────────────────────────
 *
 *   Reads:  KNState.peers, KNState.frameNum (from engines, for info overlay)
 *   Writes: KNState.remapActive, KNState.delayAutoValue, KNState.romHash
 *   Exposes: window.play_notifyPeerStatus, window.play_notifyDesync,
 *            window.play_notifyResync (engine → play.js callbacks for toasts)
 *   Creates: window.LockstepEngine.init() or window.StreamingEngine.init()
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
  let _romBlob = null; // raw ROM Blob for re-creating blob URLs
  let _romBlobUrl = null;
  let _romHash = null; // SHA-256 hex of loaded ROM
  let _hostRomHash = null; // host's ROM hash for late-join verification
  let _hibernated = false; // true when emulator is hibernated between games
  let _hibernatedRomHash = null; // ROM hash at time of hibernate (detect ROM changes)
  let _pendingLateJoin = false; // waiting for ROM before late-join init
  let _romSharingEnabled = false; // room-level: host has sharing toggled on
  let _romSharingDecision = null; // 'accepted', 'declined', or null (page-lifetime)
  let _romDeclared = false; // true if user declared ROM ownership (streaming, page-lifetime)
  let _romTransferState = 'idle'; // 'idle' | 'receiving' | 'paused' | 'resuming' | 'complete'
  let _romTransferStallTimer = null; // setTimeout ID — resets on each chunk
  let _romTransferResumeTimer = null; // setTimeout ID — 15s resume timeout
  let _romTransferRetries = 0; // auto-retry count, capped at 3
  let _romTransferChunks = [];
  let _romTransferHeader = null;
  let _romTransferDC = null; // active rom-transfer DataChannel (receiver side)
  let _romTransferDCs = {}; // active rom-transfer DataChannels (sender side, keyed by sid)
  let _romAcceptPollInterval = null; // polling interval for mid-game accept signaling
  const ROM_MAX_SIZE = 128 * 1024 * 1024; // 128MB
  const _isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && /Macintosh/i.test(navigator.userAgent)) ||
    navigator.userAgentData?.mobile;
  const ROM_CHUNK_SIZE = 64 * 1024; // 64KB — same for all platforms
  const ROM_BUFFER_THRESHOLD = 1024 * 1024; // 1MB — DC handles this fine on mobile
  let _romTransferBytesReceived = 0;
  let _romTransferLastChunkAt = 0;
  let _preGamePC = null; // guest: pre-game RTCPeerConnection for ROM preload
  let _preGamePCs = {}; // host: pre-game RTCPeerConnections (sid → pc)
  let _romSignalHandler = null; // pre-game rom-signal Socket.IO listener
  let _currentInputType = _isMobile ? 'gamepad' : 'keyboard';
  let _autoSpectated = false; // true if we auto-joined as spectator due to full room
  let _uploadToken = localStorage.getItem('kn-upload-token') || ''; // HMAC token for sync-log/cache-state uploads

  const _persistentId =
    sessionStorage.getItem('kn-player-id') ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  sessionStorage.setItem('kn-player-id', _persistentId);

  const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => _escapeMap[c]);

  const getPlayerNameBySlot = (slot) => {
    if (!lastUsersData?.players) return null;
    for (const p of Object.values(lastUsersData.players)) {
      if (p.slot === slot) return escapeHtml(p.playerName);
    }
    return null;
  };

  // ── URL Params ─────────────────────────────────────────────────────────

  const parseParams = () => {
    const params = new URLSearchParams(window.location.search);
    roomCode = params.get('room');
    isHost = params.get('host') === '1';
    playerName = params.get('name') || localStorage.getItem('kaillera-name') || 'Player';
    localStorage.setItem('kaillera-name', playerName);
    mode = params.get('mode') || 'lockstep';
    isSpectator = params.get('spectate') === '1';
  };

  // ── Recover pending logs from previous session ───────────────────────
  try {
    const pending = localStorage.getItem('kn-pending-log');
    if (pending) {
      localStorage.removeItem('kn-pending-log');
      const { room, slot, logs } = JSON.parse(pending);
      if (logs) {
        // NOTE: intentionally fire-and-forget .then() — best-effort log recovery at page load
        fetch(
          `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=recovery&token=${encodeURIComponent(_uploadToken)}`,
          {
            method: 'POST',
            body: logs,
            headers: { 'Content-Type': 'text/plain' },
          },
        )
          .then(() => console.log('[play] recovered pending sync log'))
          .catch(() => {});
      }
    }
  } catch (_) {}

  // ── Global error handler ───────────────────────────────────────────────

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[play] unhandled rejection:', e.reason);
    showToast('Something went wrong — check console');
  });

  // ── Clean tab close ───────────────────────────────────────────────────

  window.addEventListener('pagehide', () => {
    // Notify peers this is intentional so they skip the 15s reconnect wait
    if (engine && KNState.peers) {
      for (const p of Object.values(KNState.peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('leaving');
          } catch (_) {}
        }
      }
    }

    // Capture sync logs before page unloads
    if (!engine) return;
    const logs = engine.exportSyncLog?.();
    if (!logs) return;
    const room = roomCode ?? 'unknown';
    const slot = window._playerSlot ?? 'x';

    // Store full log in localStorage for reliable recovery on next visit
    try {
      localStorage.setItem('kn-pending-log', JSON.stringify({ room, slot, logs, ts: Date.now() }));
    } catch (_) {}

    // Also fire sendBeacon with truncated log (browsers cap at ~64KB)
    const MAX_BEACON = 60000;
    let beaconLog = logs;
    if (logs.length > MAX_BEACON) {
      const cutIdx = logs.indexOf('\n', logs.length - MAX_BEACON);
      beaconLog = logs.slice(cutIdx === -1 ? logs.length - MAX_BEACON : cutIdx + 1);
    }
    const url = `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&src=beacon&token=${encodeURIComponent(_uploadToken)}`;
    try {
      navigator.sendBeacon(url, new Blob([beaconLog], { type: 'text/plain' }));
    } catch (_) {}
  });

  // ── Socket.IO ──────────────────────────────────────────────────────────

  const connect = () => {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
    window._socket = socket; // expose for E2E tests
    window._isSpectator = isSpectator;

    let _reconnectErrorTimer = null;
    let _reconnectDowngradeTimer = null;
    const _reconnectBanner = document.getElementById('reconnecting-banner');
    const _reconnectText = document.getElementById('reconnecting-text');
    const _showReconnecting = () => {
      if (_reconnectBanner) _reconnectBanner.classList.remove('hidden');
      if (_reconnectText) _reconnectText.textContent = 'Reconnecting to server\u2026';
    };
    const _showServerDown = () => {
      if (_reconnectBanner) _reconnectBanner.classList.remove('hidden');
      if (_reconnectText)
        _reconnectText.textContent =
          'Server is unreachable \u2014 your game is unaffected. New players cannot join until the server returns.';
    };
    const _hideReconnecting = () => {
      if (_reconnectBanner) _reconnectBanner.classList.add('hidden');
      if (_reconnectErrorTimer) {
        clearTimeout(_reconnectErrorTimer);
        _reconnectErrorTimer = null;
      }
      if (_reconnectDowngradeTimer) {
        clearTimeout(_reconnectDowngradeTimer);
        _reconnectDowngradeTimer = null;
      }
    };
    socket.on('connect', () => {
      _hideReconnecting();
      onConnect();
    });
    socket.on('disconnect', (reason) => {
      console.log('[play] socket disconnected:', reason, 'id was:', socket.id);
      // Show spinner banner after brief delay (lobby and in-game)
      setTimeout(() => {
        if (!socket.connected) _showReconnecting();
      }, 2000);
      if (gameRunning) {
        // In-game: swap spinner text to info message after 15s (game still works P2P)
        if (!_reconnectDowngradeTimer) {
          _reconnectDowngradeTimer = setTimeout(() => {
            if (!socket.connected) _showServerDown();
          }, 15000);
        }
      } else {
        // Lobby: hard error after 30s (can't do anything without server)
        if (!_reconnectErrorTimer) {
          _reconnectErrorTimer = setTimeout(() => {
            if (!socket.connected) showError('Unable to reach server');
          }, 30000);
        }
      }
    });
    socket.on('reconnect', (attempt) => {
      console.log('[play] socket reconnected after', attempt, 'attempts, new id:', socket.id);
      _hideReconnecting();
      const rejoinEvent = isHost ? 'open-room' : 'join-room';
      const payload = isHost
        ? {
            extra: {
              sessionid: roomCode,
              player_name: playerName,
              room_name: `${playerName}'s room`,
              game_id: 'ssb64',
              persistentId: _persistentId,
            },
            maxPlayers: 4,
          }
        : {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
            },
          };
      socket.emit(rejoinEvent, payload, (err, joinData) => {
        const data = isHost ? undefined : joinData;
        if (err) {
          console.log('[play] rejoin failed:', err);
          if (!gameRunning) {
            showToast('Room is no longer available');
            setTimeout(() => {
              window.location.href = '/';
            }, 2000);
          }
          return;
        }
        console.log('[play] rejoined room after reconnect');
        if (data?.players) {
          for (const entry of Object.values(data.players)) {
            if (entry.socketId === socket.id) {
              mySlot = entry.slot;
              break;
            }
          }
        }
        sendDeviceType();
      });
    });
    socket.on('connect_error', (e) => {
      console.log('[play] connect_error:', e.message);
      // During games: silent — Socket.IO keeps retrying
      // During lobby: banner handles visibility, just set 30s hard error
      if (!gameRunning) {
        setTimeout(() => {
          if (!socket.connected) _showReconnecting();
        }, 2000);
        if (!_reconnectErrorTimer) {
          _reconnectErrorTimer = setTimeout(() => {
            if (!socket.connected) showError('Unable to reach server');
          }, 30000);
        }
      }
    });
    socket.on('users-updated', onUsersUpdated);
    socket.on('upload-token', (data) => {
      _uploadToken = data?.token || '';
      try {
        localStorage.setItem('kn-upload-token', _uploadToken);
      } catch (_) {}
    });
    socket.on('game-started', onGameStarted);
    socket.on('game-ended', onGameEnded);
    socket.on('room-closed', onRoomClosed);
    socket.on('rom-sharing-updated', onRomSharingUpdated);
    socket.on('data-message', onDataMessage);

    // Lockstep peer-phantom notifications
    window.addEventListener('kn-peer-phantom', (e) => {
      const slot = e.detail?.slot;
      const name = getPlayerNameBySlot(slot) || `Player ${slot + 1}`;
      showToast(`${name} is unresponsive — continuing without them`);
    });
    window.addEventListener('kn-peer-recovered', (e) => {
      const slot = e.detail?.slot;
      const name = getPlayerNameBySlot(slot) || `Player ${slot + 1}`;
      showToast(`${name} reconnected`);
    });
  };

  const sendDeviceType = () => {
    if (socket?.connected) {
      socket.emit('device-type', { type: _isMobile ? 'mobile' : 'desktop' });
      socket.emit('input-type', { type: _currentInputType });
    }
  };

  const onConnect = async () => {
    // Mid-game reconnect: silently rejoin signaling channel, don't reset UI
    if (gameRunning) {
      const rejoinEvent = isHost ? 'open-room' : 'join-room';
      const payload = isHost
        ? {
            extra: {
              sessionid: roomCode,
              player_name: playerName,
              room_name: `${playerName}'s room`,
              game_id: 'ssb64',
              persistentId: _persistentId,
            },
            maxPlayers: 4,
          }
        : {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
            },
          };
      socket.emit(rejoinEvent, payload, (err) => {
        if (err) console.log('[play] mid-game rejoin failed:', err);
        else console.log('[play] mid-game rejoin succeeded');
        sendDeviceType();
      });
      return;
    }

    if (isHost) {
      socket.emit(
        'open-room',
        {
          extra: {
            sessionid: roomCode,
            playerId: socket.id,
            player_name: playerName,
            room_name: `${playerName}'s room`,
            game_id: 'ssb64',
            persistentId: _persistentId,
          },
          maxPlayers: 4,
        },
        (err) => {
          if (err) {
            showError(`Failed to create room: ${err}`);
            return;
          }
          mySlot = 0;
          sendDeviceType();
          // If ROM was already loaded from cache, notify server immediately
          if (_romBlob || _romBlobUrl) notifyRomReady();
          showOverlay();
        },
      );
    } else {
      // Non-host: check room exists, then join
      try {
        const response = await fetch(`/room/${encodeURIComponent(roomCode)}`);
        if (!response.ok) {
          showError('Room not found');
          return;
        }
        const roomData = await response.json();
        if (!roomData) return;

        // Room full: auto-join as spectator with banner
        if (!isSpectator && roomData.player_count >= roomData.max_players) {
          isSpectator = true;
          _autoSpectated = true;
        }

        socket.emit(
          'join-room',
          {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
            },
          },
          (err, joinData) => {
            if (err) {
              // Room filled between REST check and join — auto-spectate
              if (err === 'Room is full') {
                isSpectator = true;
                _autoSpectated = true;
                socket.emit(
                  'join-room',
                  {
                    extra: {
                      sessionid: roomCode,
                      userid: socket.id,
                      player_name: playerName,
                      spectate: true,
                      persistentId: _persistentId,
                    },
                  },
                  (err2, joinData2) => {
                    if (err2) {
                      showError(`Failed to join: ${err2}`);
                      return;
                    }
                    mySlot = null;
                    if (joinData2) lastUsersData = joinData2;
                    sendDeviceType();
                    showRoomFullBanner();
                    showOverlay();
                  },
                );
                return;
              }
              showError(`Failed to join: ${err}`);
              return;
            }

            if (!isSpectator && joinData?.players) {
              for (const entry of Object.values(joinData.players)) {
                if (entry.socketId === socket.id) {
                  mySlot = entry.slot;
                  break;
                }
              }
            } else if (isSpectator) {
              mySlot = null;
              if (_autoSpectated) showRoomFullBanner();
            }

            sendDeviceType();
            // If ROM was already loaded from cache, notify server immediately
            if (_romBlob || _romBlobUrl) notifyRomReady();

            // Mid-game join handling
            if (roomData.status === 'playing') {
              gameRunning = true;
              _lateJoin = !isSpectator;
              // Pick up the game mode — game-started event won't fire
              // since the game is already running. Try REST then join callback.
              if (roomData.mode) mode = roomData.mode;
              else if (joinData?.mode) mode = joinData.mode;
              // Use joinData directly — the users-updated socket event may not
              // have arrived yet (ack returns before broadcast is delivered)
              if (joinData) lastUsersData = joinData;

              // Store host's ROM hash for verification
              _hostRomHash = roomData.rom_hash ?? null;

              // Spectators and streaming guests don't need a ROM — they
              // receive a video stream. Skip ROM checks and go to engine init.
              if (isSpectator || mode === 'streaming') {
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

              // Verify ROM hash if available (skip when ROM came from host via sharing)
              if (romHashMismatch(_hostRomHash, _romHash) && _romSharingDecision !== 'accepted') {
                showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
                return;
              }

              showToolbar();
              initEngine();
              return;
            }

            showOverlay();
          },
        );
      } catch (_) {
        showError('Failed to connect');
      }
    }
  };

  // ── Users Updated ──────────────────────────────────────────────────────

  const onUsersUpdated = (data) => {
    lastUsersData = data;
    const players = data.players || {};
    const spectators = data.spectators || {};
    const ownerSid = data.owner ?? null;

    // Track room mode from server (set by host's set-mode event)
    if (data.mode) {
      mode = data.mode;
      // Sync mode-select dropdown if we're the host
      const modeSel = document.getElementById('mode-select');
      if (modeSel && !isHost) modeSel.value = mode;
    }

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
    for (const entry of Object.values(players)) {
      if (entry.socketId === socket.id) {
        mySlot = entry.slot;
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
      isHost = ownerSid === socket.id;
    }
    if (!wasHost && isHost) {
      showToast('You are now the host');
    }

    // Diff for toasts
    diffForToasts(players, spectators);
    previousPlayers = structuredClone(players);
    previousSpectators = structuredClone(spectators);

    // Always keep the player list current (fixes stale input/device type
    // indicators when a mobile player late-joins — the corrected users-updated
    // arrives after gameRunning is set to true)
    updatePlayerList(players, spectators, ownerSid);

    // Update overlay UI if in pre-game
    if (!gameRunning) {
      updateRomDeclarePrompt();
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
  };

  const diffForToasts = (players, spectators) => {
    // Skip first update
    if (Object.keys(previousPlayers).length === 0 && Object.keys(previousSpectators).length === 0) return;

    for (const pid in players) {
      if (!previousPlayers[pid] && !previousSpectators[pid]) {
        showToast(`${escapeHtml(players[pid].playerName)} joined`);
      }
    }
    for (const pid in previousPlayers) {
      if (!players[pid] && !spectators[pid]) {
        showToast(`${escapeHtml(previousPlayers[pid].playerName)} left`);
      }
    }
    for (const pid in spectators) {
      if (!previousSpectators[pid] && !previousPlayers[pid]) {
        showToast(`${escapeHtml(spectators[pid].playerName)} is watching`);
      }
    }
    for (const pid in previousSpectators) {
      if (!spectators[pid] && !players[pid]) {
        showToast(`${escapeHtml(previousSpectators[pid].playerName)} left`);
      }
    }
  };

  // ── Game Lifecycle ─────────────────────────────────────────────────────

  const onGameStarted = (data) => {
    console.log(
      '[play] onGameStarted:',
      JSON.stringify(data),
      `engine=${!!engine}`,
      `EJS=${!!window.EJS_emulator}`,
      `romBlob=${!!_romBlob}`,
      `romBlobUrl=${!!_romBlobUrl}`,
      `gameRunning=${gameRunning}`,
    );
    mode = data.mode || mode;
    _gameRollbackEnabled = !!data.rollbackEnabled;

    gameRunning = true;

    // Spectators and streaming-mode guests don't run an emulator — they
    // receive a video stream from the host. Skip ROM checks and boot.
    if (isSpectator || (mode === 'streaming' && !isHost)) {
      hideOverlay();
      showToolbar();
      showGameLoading();
      initEngine();
      return;
    }

    // Verify ROM hash matches host's (skip if ROM sharing — ROM comes from host)
    if (romHashMismatch(data.romHash, _romHash) && _romSharingDecision !== 'accepted') {
      showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
      return;
    }

    // If ROM sharing is enabled and we don't have a ROM yet (regardless of
    // whether the guest accepted, declined, or hasn't decided), stay in overlay.
    // This handles the race where the host starts before the guest finishes
    // downloading or even accepts the sharing prompt.
    if (_romSharingEnabled && !_romBlob && !_romBlobUrl) {
      initEngine();
      if (_romSharingDecision === 'accepted') {
        if (_romTransferState === 'idle') {
          _romTransferState = 'resuming';
        }
        updateRomSharingUI();
        if (_preGamePC) {
          console.log('[play] game started — pre-game ROM transfer in progress');
        } else {
          console.log('[play] game started — waiting for ROM transfer');
          waitForDCAndSendRomAccepted();
        }
      } else {
        console.log('[play] game started — waiting for guest to accept ROM sharing');
        updateRomSharingUI();
      }
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
  };

  const onGameEnded = () => {
    console.log(
      '[play] onGameEnded:',
      `engine=${!!engine}`,
      `EJS=${!!window.EJS_emulator}`,
      `romBlob=${!!_romBlob}`,
      `romBlobUrl=${!!_romBlobUrl}`,
    );
    gameRunning = false;
    _lateJoin = false;
    _pendingLateJoin = false;
    showToast('The host has ended the game');
    if (engine) {
      // Upload sync logs to server before stopping
      uploadSyncLogs('game-ended');
      engine.stop();
      engine = null;
    }
    hibernateEmulator();
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.classList.remove('kn-playing');
    dismissGameLoading();
    hideToolbar();
    showOverlay();
    // Refresh player list with latest data (device/input types may have
    // been updated during gameplay while updatePlayerList was skipped)
    if (lastUsersData) {
      const p = lastUsersData.players || {};
      const s = lastUsersData.spectators || {};
      updatePlayerList(p, s, lastUsersData.owner ?? null);
    }
    // Clear reconnect overlay (may persist from mid-game reconnect)
    const reconnectOverlay = document.getElementById('reconnect-overlay');
    if (reconnectOverlay) reconnectOverlay.classList.add('hidden');
    // Clear stale engine status
    const statusEl = document.getElementById('engine-status');
    if (statusEl) statusEl.textContent = '';
    // Clean up ROM transfer state (decision persists for page lifetime)
    resetRomTransfer();
    cleanupPreGameConnections();
  };

  const onRoomClosed = (data) => {
    gameRunning = false;
    if (engine) {
      engine.stop();
      engine = null;
    }
    const reason = data?.reason ?? 'closed';
    const msg = reason === 'host-left' ? 'Host left — returning to lobby...' : 'Room closed';
    showToast(msg);
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  };

  // ── ROM Sharing ──────────────────────────────────────────────────────

  const onRomSharingUpdated = (data) => {
    const wasEnabled = _romSharingEnabled;
    _romSharingEnabled = !!data.romSharing;
    console.log('[play] rom-sharing-updated:', _romSharingEnabled);

    if (!isHost) {
      if (_romSharingEnabled && !wasEnabled) showToast('Host is sharing their ROM');
      if (!_romSharingEnabled && wasEnabled) showToast('Host stopped sharing their ROM');
    }

    // Host disabled sharing — pause transfer but KEEP chunks
    if (wasEnabled && !_romSharingEnabled) {
      if (_romTransferState === 'receiving' || _romTransferState === 'resuming') {
        if (_romTransferDC) {
          try {
            _romTransferDC.close();
          } catch (_) {}
          _romTransferDC = null;
        }
        stopStallTimer();
        clearTimeout(_romTransferResumeTimer);
        _romTransferResumeTimer = null;
        _romTransferState = 'paused';
      }
      cleanupPreGameConnections();
    }

    // Host re-enabled sharing — resume if we have cached progress
    if (!isHost && _romSharingEnabled && !wasEnabled && _romSharingDecision === 'accepted' && !_romBlob) {
      if (_romTransferState === 'paused' && _romTransferBytesReceived > 0) {
        console.log('[play] ROM sharing re-enabled — resuming from offset', _romTransferBytesReceived);
        _romTransferState = 'resuming';
        requestResumeTransfer();
      } else if (_romTransferState === 'idle') {
        console.log('[play] ROM sharing re-enabled — starting fresh transfer');
        _romTransferState = 'resuming';
        requestResumeTransfer();
      }
    }

    updateRomSharingUI();

    if (isHost && lastUsersData) {
      updateStartButton(lastUsersData.players || {});
    }
  };

  const onDataMessage = (data) => {
    // Host broadcasts mode selection to guests pre-game
    if (data.type === 'mode-select' && !isHost && data.mode) {
      mode = data.mode;
      const modeSel = document.getElementById('mode-select');
      if (modeSel) modeSel.value = mode;
      updateRomDeclarePrompt();
      if (lastUsersData) updateStartButton(lastUsersData.players || {});
    }
    if (data.type === 'rom-accepted' && isHost && _romSharingEnabled && data.sender) {
      // Use engine's peer connection if available, otherwise pre-game connection
      if (engine?.getPeerConnection?.(data.sender)) {
        console.log('[play] peer', data.sender, 'accepted ROM sharing (via engine)');
        startRomTransferTo(data.sender);
      } else {
        console.log('[play] peer', data.sender, 'accepted ROM sharing (pre-game)');
        startPreGameRomTransfer(data.sender);
      }
    }
  };

  const toggleRomSharing = () => {
    const cb = document.getElementById('opt-rom-sharing');
    if (!cb) return;
    const enabled = cb.checked;
    if (enabled && !_romBlob) {
      cb.checked = false;
      showToast('Load a ROM file before sharing');
      return;
    }
    socket.emit('rom-sharing-toggle', { enabled });
    // If disabling, close any active rom-transfer DataChannels
    if (!enabled) {
      for (const sid of Object.keys(_romTransferDCs)) {
        try {
          _romTransferDCs[sid].close();
        } catch (_) {}
      }
      _romTransferDCs = {};
      cleanupPreGameConnections();
    }
  };

  const updateRomSharingUI = () => {
    const romDrop = document.getElementById('rom-drop');
    const prompt = document.getElementById('rom-sharing-prompt');
    const progress = document.getElementById('rom-transfer-progress');
    const retryBtn = document.getElementById('rom-transfer-retry');

    if (isHost) return;
    if (isSpectator) return;

    console.log(
      `[play] updateRomSharingUI: enabled=${_romSharingEnabled}` +
        ` decision=${_romSharingDecision} state=${_romTransferState}` +
        ` hasRom=${!!_romBlob}`,
    );

    // Hide retry button by default — only shown in paused state
    if (retryBtn) retryBtn.style.display = 'none';

    if (_romSharingEnabled && _romSharingDecision === null && !_romBlob) {
      // Show accept/decline prompt
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = '';
      if (progress) progress.style.display = 'none';
    } else if (_romTransferState === 'receiving') {
      // Transfer in progress — show progress bar
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
    } else if (_romTransferState === 'paused') {
      // Paused — show progress bar with retry button
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
      if (retryBtn) retryBtn.style.display = '';
      const text = document.getElementById('rom-progress-text');
      if (text && _romTransferHeader) {
        const pct = Math.round((_romTransferBytesReceived / _romTransferHeader.size) * 100);
        text.textContent = `ROM transfer paused — ${pct}% received`;
      } else if (text) {
        text.textContent = 'ROM transfer failed';
      }
    } else if (_romTransferState === 'resuming') {
      // Resuming — show progress bar with reconnecting text
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = '';
      const text = document.getElementById('rom-progress-text');
      if (text) text.textContent = 'ROM transfer reconnecting...';
    } else if (_romTransferState === 'complete' || (_romSharingDecision === 'accepted' && _romBlob)) {
      // Transfer complete
      if (romDrop) {
        romDrop.style.display = '';
        romDrop.classList.add('loaded');
      }
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    } else {
      // Default: show normal drop zone
      if (romDrop) romDrop.style.display = '';
      if (prompt) prompt.style.display = 'none';
      if (progress) progress.style.display = 'none';
    }
  };

  const findHostSid = () => {
    if (!lastUsersData?.players) return null;
    const players = lastUsersData.players;
    for (const pid in players) {
      if (players[pid].slot === 0) return players[pid].socketId;
    }
    return null;
  };

  const acceptRomSharing = () => {
    _romSharingDecision = 'accepted';
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
    _romTransferState = 'resuming';
    updateRomSharingUI();

    // Pre-game: initiate early ROM transfer via standalone WebRTC connection
    if (!gameRunning) {
      console.log('[play] ROM sharing accepted pre-game — requesting early transfer');
      registerRomSignalHandler();
      socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
      return;
    }

    // Mid-game join: start engine in connect-only mode to get WebRTC
    if (!engine && gameRunning) {
      initEngine();
      waitForDCAndSendRomAccepted();
      return;
    }

    // Engine exists with open DataChannel: signal immediately
    if (engine?.getPeerConnection) {
      const hostSid = findHostSid();
      if (hostSid) {
        const peers = KNState.peers || {};
        const hostPeer = peers[hostSid];
        if (hostPeer?.dc?.readyState === 'open') {
          hostPeer.dc.send(JSON.stringify({ type: 'rom-accepted' }));
          return;
        }
      }
    }
    // Fallback: Socket.IO data-message
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
  };

  const waitForDCAndSendRomAccepted = () => {
    if (_romAcceptPollInterval) clearInterval(_romAcceptPollInterval);
    _romAcceptPollInterval = setInterval(() => {
      const hostSid = findHostSid();
      if (!hostSid) return;
      const peers = KNState.peers || {};
      const hostPeer = peers[hostSid];
      if (hostPeer?.dc?.readyState === 'open') {
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
  };

  const declineRomSharing = () => {
    _romSharingDecision = 'declined';
    updateRomSharingUI();
  };

  const cancelRomTransfer = () => {
    _romTransferState = 'idle';
    if (_romTransferDC) {
      try {
        _romTransferDC.close();
      } catch (_) {}
      _romTransferDC = null;
    }
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = null;
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
    cleanupPreGameConnections();
    updateRomSharingUI();
    showToast('ROM transfer cancelled');
  };

  const retryRomTransfer = () => {
    if (_romTransferState !== 'paused' && _romTransferState !== 'idle') return;
    _romTransferRetries = 0;
    _romTransferState = 'resuming';
    updateRomSharingUI();
    showToast('Retrying ROM transfer...');
    requestResumeTransfer();
  };

  const resetRomTransfer = () => {
    // Game-end cleanup — same as cancel but no toast, also closes sender DCs
    _romTransferState = 'idle';
    if (_romTransferDC) {
      try {
        _romTransferDC.close();
      } catch (_) {}
      _romTransferDC = null;
    }
    for (const sid of Object.keys(_romTransferDCs)) {
      try {
        _romTransferDCs[sid].close();
      } catch (_) {}
    }
    _romTransferDCs = {};
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = null;
    if (_romAcceptPollInterval) {
      clearInterval(_romAcceptPollInterval);
      _romAcceptPollInterval = null;
    }
    _romTransferChunks = [];
    _romTransferHeader = null;
    _romTransferBytesReceived = 0;
    _romTransferRetries = 0;
  };

  // ── Pre-game ROM Preloading ─────────────────────────────────────────

  const registerRomSignalHandler = () => {
    if (_romSignalHandler) return;
    _romSignalHandler = async (data) => {
      const remoteSid = data.sender;
      if (!remoteSid) return;

      if (data.offer && !isHost) {
        // Guest: received offer from host for ROM preload
        const ICE = window._iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }];
        if (_preGamePC) {
          try {
            _preGamePC.close();
          } catch (_) {}
        }
        _preGamePC = new RTCPeerConnection({ iceServers: ICE });

        _preGamePC.onicecandidate = (e) => {
          if (e.candidate) {
            socket.emit('rom-signal', { target: remoteSid, candidate: e.candidate });
          }
        };

        _preGamePC.ondatachannel = (e) => {
          if (e.channel.label === 'rom-transfer') {
            onExtraDataChannel(remoteSid, e.channel);
          }
        };

        await _preGamePC.setRemoteDescription(data.offer);
        const answer = await _preGamePC.createAnswer();
        await _preGamePC.setLocalDescription(answer);
        socket.emit('rom-signal', { target: remoteSid, answer: _preGamePC.localDescription });
      }

      if (data.answer && isHost) {
        const pc = _preGamePCs[remoteSid];
        if (pc) {
          await pc.setRemoteDescription(data.answer);
        }
      }

      if (data.candidate) {
        const targetPC = isHost ? _preGamePCs[remoteSid] : _preGamePC;
        if (targetPC) {
          try {
            await targetPC.addIceCandidate(data.candidate);
          } catch (_) {}
        }
      }
    };
    socket.on('rom-signal', _romSignalHandler);
  };

  const startPreGameRomTransfer = async (peerSid) => {
    if (!_romBlob || !isHost) return;
    if (_romBlob.size > ROM_MAX_SIZE) {
      console.log('[play] ROM too large to share:', _romBlob.size);
      return;
    }

    registerRomSignalHandler();

    const ICE = window._iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }];
    const pc = new RTCPeerConnection({ iceServers: ICE });
    _preGamePCs[peerSid] = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('rom-signal', { target: peerSid, candidate: e.candidate });
      }
    };

    // Create rom-transfer DataChannel (same pattern as startRomTransferTo)
    const dc = pc.createDataChannel('rom-transfer', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    _romTransferDCs[peerSid] = dc;

    dc.onopen = () => {
      console.log('[play] pre-game rom-transfer DC open to', peerSid);
      // Always wait for receiver's rom-resume message with offset.
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'rom-resume' && msg.offset >= 0) {
            console.log('[play] pre-game ROM resume from offset', msg.offset);
            sendRomOverChannel(dc, peerSid, msg.offset);
          }
        } catch (_) {}
      }
    };
    dc.onclose = () => {
      delete _romTransferDCs[peerSid];
      if (_preGamePCs[peerSid]) {
        try {
          _preGamePCs[peerSid].close();
        } catch (_) {}
        delete _preGamePCs[peerSid];
      }
    };
    dc.onerror = () => {
      delete _romTransferDCs[peerSid];
      if (_preGamePCs[peerSid]) {
        try {
          _preGamePCs[peerSid].close();
        } catch (_) {}
        delete _preGamePCs[peerSid];
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rom-signal', { target: peerSid, offer: pc.localDescription });
  };

  const cleanupPreGameConnections = () => {
    if (_romSignalHandler) {
      socket.off('rom-signal', _romSignalHandler);
      _romSignalHandler = null;
    }
    if (_preGamePC) {
      try {
        _preGamePC.close();
      } catch (_) {}
      _preGamePC = null;
    }
    for (const sid of Object.keys(_preGamePCs)) {
      try {
        _preGamePCs[sid].close();
      } catch (_) {}
    }
    _preGamePCs = {};
  };

  // ── ROM Transfer: Host sending ──────────────────────────────────────

  const startRomTransferTo = (peerSid) => {
    if (!_romBlob || !isHost) return;
    if (_romBlob.size > ROM_MAX_SIZE) {
      console.log('[play] ROM too large to share:', _romBlob.size);
      return;
    }
    const pc = engine?.getPeerConnection?.(peerSid) ?? null;
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
      // Always wait for receiver's rom-resume message with offset.
      // This prevents double-sending when the guest also signals rom-resume.
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
  };

  const sendRomOverChannel = (dc, peerSid, startOffset) => {
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

      const sendNextChunk = () => {
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
            console.log(
              '[play] ROM send error at chunk',
              chunkIndex,
              'offset',
              offset,
              'buffered',
              dc.bufferedAmount,
              'state',
              dc.readyState,
              err,
            );
            retryChunk(offset, end, 0);
            return;
          }
          offset = end;
          chunkIndex++;
        }
        // All chunks sent
        dc.send(JSON.stringify({ type: 'rom-complete' }));
        console.log('[play] ROM transfer complete to', peerSid);
      };

      const waitForDrain = () => {
        const drainTimeout = setTimeout(() => {
          dc.onbufferedamountlow = null;
          if (dc.readyState !== 'open') return;
          if (dc.bufferedAmount <= ROM_BUFFER_THRESHOLD) {
            sendNextChunk();
          } else {
            backpressureRetries++;
            if (backpressureRetries >= MAX_BACKPRESSURE_RETRIES) {
              console.log(
                '[play] ROM send: backpressure timeout after',
                MAX_BACKPRESSURE_RETRIES,
                'retries at offset',
                offset,
              );
              showToast('ROM transfer failed — load ROM manually');
              return;
            }
            console.log('[play] ROM send: backpressure retry', backpressureRetries);
            waitForDrain();
          }
        }, 1000);

        dc.onbufferedamountlow = () => {
          clearTimeout(drainTimeout);
          dc.onbufferedamountlow = null;
          backpressureRetries = 0;
          sendNextChunk();
        };
      };

      const retryChunk = (chunkStart, chunkEnd, attempt) => {
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
      };

      sendNextChunk();
    };
    reader.readAsArrayBuffer(_romBlob);
  };

  // ── ROM Transfer: Joiner receiving ──────────────────────────────────

  const onExtraDataChannel = (remoteSid, channel) => {
    if (channel.label !== 'rom-transfer') return;
    if (_romSharingDecision !== 'accepted') {
      channel.close();
      return;
    }

    console.log('[play] received rom-transfer DataChannel from', remoteSid);
    _romTransferDC = channel;
    channel.binaryType = 'arraybuffer';

    if (_romTransferState === 'resuming' || _romTransferState === 'paused') {
      // Resume: keep cached chunks
      clearTimeout(_romTransferResumeTimer);
      _romTransferResumeTimer = null;
      console.log('[play] resuming ROM transfer from offset', _romTransferBytesReceived);
    } else {
      // Fresh transfer: clear any stale state
      _romTransferChunks = [];
      _romTransferHeader = null;
      _romTransferBytesReceived = 0;
      _romTransferRetries = 0;
    }

    _romTransferState = 'receiving';

    // Always tell the host where to start sending from.
    // offset 0 = fresh (host sends header + all chunks)
    // offset N = resume (host sends chunks from N, no header)
    const resumeOffset = _romTransferBytesReceived;
    const sendResumeMsg = () => {
      console.log('[play] sending rom-resume offset', resumeOffset);
      channel.send(JSON.stringify({ type: 'rom-resume', offset: resumeOffset }));
    };
    if (channel.readyState === 'open') {
      sendResumeMsg();
    } else {
      channel.onopen = sendResumeMsg;
    }

    _romTransferLastChunkAt = Date.now();
    resetStallTimer();

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
            // If header differs from cached (host changed ROM), clear chunks
            if (_romTransferHeader && (msg.hash !== _romTransferHeader.hash || msg.size !== _romTransferHeader.size)) {
              console.log('[play] ROM changed — clearing cached chunks');
              _romTransferChunks = [];
              _romTransferBytesReceived = 0;
            }
            _romTransferHeader = msg;
            if (_romTransferBytesReceived === 0) {
              updateRomProgress(0, msg.size);
            }
          } else if (msg.type === 'rom-complete') {
            stopStallTimer();
            _romTransferState = 'complete';
            finishRomTransfer();
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        _romTransferChunks.push(new Uint8Array(e.data));
        _romTransferBytesReceived += e.data.byteLength;
        _romTransferLastChunkAt = Date.now();
        resetStallTimer();
        if (_romTransferHeader) {
          updateRomProgress(_romTransferBytesReceived, _romTransferHeader.size);
        }
      }
    };

    channel.onclose = () => {
      if (_romTransferState === 'receiving') {
        _romTransferDC = null;
        stopStallTimer();
        _romTransferRetries++;
        _romTransferState = 'paused';
        console.log('[play] ROM transfer DC closed, retry', _romTransferRetries, '/ 3');

        if (_romTransferRetries <= 3 && _romTransferBytesReceived > 0) {
          showToast(`ROM transfer interrupted — retry ${_romTransferRetries}/3`);
          // Auto-retry after backoff
          _romTransferResumeTimer = setTimeout(() => {
            if (_romTransferState !== 'paused') return;
            _romTransferState = 'resuming';
            updateRomSharingUI();
            requestResumeTransfer();
          }, 2000);
        } else if (_romTransferRetries > 3) {
          showToast('ROM transfer stalled — cancel or wait for host');
        }
        updateRomSharingUI();
      }
    };

    updateRomSharingUI();
  };

  const requestResumeTransfer = () => {
    // Re-request transfer from host via Socket.IO
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
    // Timeout: if no DC arrives in 15s, fall back to paused
    _romTransferResumeTimer = setTimeout(() => {
      if (_romTransferState !== 'resuming') return;
      _romTransferState = 'paused';
      _romTransferRetries++;
      console.log('[play] ROM resume timed out, retry', _romTransferRetries);
      if (_romTransferRetries <= 3) {
        showToast('ROM transfer resume timed out — will retry');
        // Schedule another attempt
        _romTransferResumeTimer = setTimeout(() => {
          if (_romTransferState !== 'paused') return;
          _romTransferState = 'resuming';
          updateRomSharingUI();
          requestResumeTransfer();
        }, 2000);
      } else {
        showToast('ROM transfer stalled — cancel or wait for host');
      }
      updateRomSharingUI();
    }, 15000);
  };

  const resetStallTimer = () => {
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = setTimeout(onStallTimeout, 10000);
  };

  const stopStallTimer = () => {
    clearTimeout(_romTransferStallTimer);
    _romTransferStallTimer = null;
  };

  const onStallTimeout = () => {
    if (_romTransferState !== 'receiving') return;
    console.log('[play] ROM transfer stalled — no chunks for 10s');
    // Close DC — onclose will transition to paused
    if (_romTransferDC) {
      try {
        _romTransferDC.close();
      } catch (_) {}
    }
  };

  const updateRomProgress = (received, total) => {
    const bar = document.getElementById('rom-progress-bar');
    const text = document.getElementById('rom-progress-text');
    const pct = total > 0 ? Math.round((received / total) * 100) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (text) {
      const recMB = (received / (1024 * 1024)).toFixed(1);
      const totMB = (total / (1024 * 1024)).toFixed(1);
      text.textContent = `Receiving ROM... ${pct}% (${recMB} / ${totMB} MB)`;
    }
  };

  const finishRomTransfer = () => {
    let totalSize = 0;
    for (const chunk of _romTransferChunks) {
      totalSize += chunk.byteLength;
    }

    if (_romTransferHeader && _romTransferHeader.size !== totalSize) {
      showToast('ROM transfer size mismatch — load manually');
      _romTransferState = 'idle';
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    const blob = new Blob(_romTransferChunks);
    const displayName = _romTransferHeader?.name ?? 'rom.z64';
    const expectedHash = _romTransferHeader?.hash ?? null;

    // Set ROM data (ephemeral — do NOT cache to IndexedDB)
    _romBlob = blob;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;

    _romTransferState = 'complete';
    _romTransferChunks = [];
    _romTransferDC = null;

    // Use the host's hash directly — the bytes are verified identical (size check
    // passed) and recomputing locally can produce a different hash if the host
    // uses SHA-256 (HTTPS/localhost) while the guest uses FNV-1a (HTTP LAN IP).
    if (expectedHash) {
      _romHash = expectedHash;
      KNState.romHash = expectedHash;
      afterRomTransferComplete(displayName);
    } else {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          _romHash = await hashArrayBuffer(reader.result);
          KNState.romHash = _romHash;
        } catch (_) {}
        afterRomTransferComplete(displayName);
      };
      reader.readAsArrayBuffer(blob);
    }
  };

  const afterRomTransferComplete = (displayName) => {
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

    // Clean up pre-game WebRTC connections (ROM delivered, no longer needed)
    cleanupPreGameConnections();
  };

  const notifyRomReady = () => {
    if (socket?.connected) {
      socket.emit('rom-ready', { ready: true });
    }
  };

  const onUnhandledEngineMessage = (remoteSid, msg) => {
    if (msg.type === 'rom-accepted' && isHost && _romSharingEnabled) {
      console.log('[play] peer', remoteSid, 'accepted ROM sharing');
      startRomTransferTo(remoteSid);
    }
  };

  const destroyEmulator = () => {
    console.log('[play] destroyEmulator:', `EJS=${!!window.EJS_emulator}`);
    const emu = window.EJS_emulator;
    if (emu) {
      // Stop the Emscripten main loop to prevent stale rAF callbacks
      // from interfering with the next EmulatorJS instance.
      try {
        const mod = emu.gameManager?.Module;
        if (mod?.pauseMainLoop) mod.pauseMainLoop();
      } catch (_) {}
      // Close ALL emulator AudioContexts to stop lingering audio.
      // The netplay engine's stop() handles its custom audio pipeline;
      // this catches the EJS/SDL2 and OpenAL AudioContexts.
      try {
        const gm = emu.gameManager;
        if (gm?.Module) {
          if (gm.Module.SDL2?.audioContext) {
            gm.Module.SDL2.audioContext.close();
          }
          // OpenAL AudioContexts — lockstep overrides resume() to a no-op
          // to prevent auto-resuming during gameplay. Restore it before closing
          // so mobile WebKit can properly release the audio resources.
          if (gm.Module.AL?.contexts) {
            for (const [id, ctx] of Object.entries(gm.Module.AL.contexts)) {
              if (!ctx) continue;
              // Stop all OpenAL sources before restoring resume() —
              // during lockstep the emulator may set sources to PLAYING
              // even though the context was suspended. Restoring resume()
              // with active sources can briefly play stale audio on mobile.
              if (ctx.sources && gm.Module.AL.setSourceState) {
                for (const [sid, src] of Object.entries(ctx.sources)) {
                  if (src?.state === 0x1012) {
                    try {
                      gm.Module.AL.setSourceState(src, 0x1014);
                    } catch (_) {}
                  }
                }
              }
              if (ctx.audioCtx) {
                try {
                  // Restore native resume() if it was monkey-patched
                  const proto = AudioContext.prototype || webkitAudioContext.prototype;
                  if (proto?.resume) {
                    ctx.audioCtx.resume = proto.resume;
                  }
                  ctx.audioCtx.close();
                } catch (_) {}
              }
            }
          }
        }
      } catch (_) {}
    }
    // Note: fetch/XHR intercepts from core-redirector stay active for the
    // page lifetime — game restart needs them to redirect the core download.

    // Wipe EmulatorJS from the DOM entirely — clean slate for next game
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.innerHTML = '';
    window.EJS_emulator = undefined;

    try {
      delete window.EJS_emulator;
    } catch (_) {}

    // Revoke the consumed blob URL — bootEmulator() will create a fresh one
    if (_romBlobUrl) {
      URL.revokeObjectURL(_romBlobUrl);
      _romBlobUrl = null;
    }
  };

  const hibernateEmulator = () => {
    const emu = window.EJS_emulator;
    if (!emu) return;
    console.log('[play] hibernateEmulator: pausing + hiding');

    const mod = emu.gameManager?.Module;
    if (mod) {
      // Establish a known paused state. stopSync() restores native rAF but
      // never resumes the Emscripten main loop — it's left in limbo (not
      // paused, not running). Calling pauseMainLoop() here guarantees that
      // resumeMainLoop() in wakeEmulator() will schedule a fresh rAF callback.
      try {
        mod.pauseMainLoop();
      } catch (_) {}

      // Suspend (not close) OpenAL AudioContexts — lockstep monkey-patches
      // resume() to a no-op, so just suspend without touching resume here.
      // wakeEmulator() will restore native resume() and call it.
      if (mod.AL?.contexts) {
        for (const ctx of Object.values(mod.AL.contexts)) {
          if (ctx?.audioCtx && ctx.audioCtx.state !== 'closed') {
            try {
              ctx.audioCtx.suspend();
            } catch (_) {}
          }
        }
      }

      // Suspend SDL2 AudioContext if present
      if (mod.SDL2?.audioContext && mod.SDL2.audioContext.state !== 'closed') {
        try {
          mod.SDL2.audioContext.suspend();
        } catch (_) {}
      }
    }

    // Hide the game div contents
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.style.display = 'none';

    _hibernated = true;
    _hibernatedRomHash = _romHash;
  };

  const wakeEmulator = () => {
    const emu = window.EJS_emulator;
    if (!emu) return;
    console.log('[play] wakeEmulator: resuming + showing');

    const mod = emu.gameManager?.Module;
    if (mod) {
      // Clear EJS_PAUSED C flag — without this, emscripten_mainloop() bails
      // at the top (retroarch.c:6126) and retro_run never executes.
      if (mod._toggleMainLoop) mod._toggleMainLoop(1);

      // Don't resume the main loop here — let each engine handle it:
      // - Lockstep: enterManualMode() does pause+overrideRAF+resume, capturing
      //   the runner without EJS ever getting free frames to show its UI menus.
      // - Streaming host: initEngine() resumes explicitly after wake.

      // Restore OpenAL AudioContexts — undo lockstep's resume() monkey-patch
      // and unsuspend them so streaming's captureEmulatorAudio() finds live contexts.
      const proto = AudioContext.prototype || webkitAudioContext.prototype;
      if (mod.AL?.contexts) {
        for (const ctx of Object.values(mod.AL.contexts)) {
          if (ctx?.audioCtx && ctx.audioCtx.state !== 'closed') {
            try {
              if (proto.resume) ctx.audioCtx.resume = proto.resume;
              ctx.audioCtx.resume();
            } catch (_) {}
          }
        }
      }

      // Resume SDL2 AudioContext if present
      if (mod.SDL2?.audioContext && mod.SDL2.audioContext.state !== 'closed') {
        try {
          mod.SDL2.audioContext.resume();
        } catch (_) {}
      }
    }

    // Show the game div (streaming guests use #stream-overlay instead,
    // so #game stays hidden for them — see initEngine).
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.style.display = '';

    _hibernated = false;
    _hibernatedRomHash = null;
  };

  const bootEmulator = () => {
    if (window.__test_skipBoot) return;
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
    // Guests: disable auto-start so the emulator waits for a user gesture.
    // Without a gesture, browsers block the AudioContext and the WASM emulator
    // stalls at frame 6. The lockstep engine's gesture handler clicks the EJS
    // start button within a real user gesture context.
    if (!isHost) {
      window.EJS_startOnLoaded = false;
      console.log('[play] bootEmulator: guest — disabled auto-start for gesture gate');
    }

    console.log('[play] bootEmulator: gameUrl:', _romBlobUrl.substring(0, 50));
    window.EJS_gameUrl = _romBlobUrl;

    // If EmulatorJS class is already loaded (game restart), instantiate
    // directly to avoid const re-declaration errors from re-injecting scripts
    if (typeof EmulatorJS === 'function') {
      console.log('[play] bootEmulator: reusing existing EmulatorJS class');
      window.EJS_gameUrl = _romBlobUrl;
      window.EJS_emulator = new EmulatorJS(window.EJS_player || '#game', {
        gameUrl: _romBlobUrl,
        dataPath: window.EJS_pathtodata || '/static/ejs/',
        system: window.EJS_core || 'n64',
        startOnLoad: isHost,
      });
      return;
    }

    // Wait for IDB cache clear (core-redirector) before loading EJS.
    // If the clear hasn't finished, EJS might use stale cached core data.
    const injectLoader = () => {
      const script = document.createElement('script');
      script.src = '/static/ejs-loader.js';
      script.onload = () => {
        console.log('[play] loader.js loaded');
      };
      script.onerror = () => {
        console.log('[play] loader.js FAILED to load');
      };
      document.body.appendChild(script);
    };
    if (window._knCoreReady) {
      // NOTE: intentionally .then() — dual resolve/reject handler, cleaner than try/finally
      window._knCoreReady.then(injectLoader, injectLoader);
    } else {
      injectLoader();
    }
  };

  const setupRomDrop = () => {
    const drop = document.getElementById('rom-drop');
    if (!drop) return;

    const savedRom = localStorage.getItem('kaillera-rom-name');
    const statusEl = document.getElementById('rom-status');

    // Prevent browser from navigating to dropped files anywhere on the page
    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
    });

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
  };

  const handleRomFile = (file) => {
    const statusEl = document.getElementById('rom-status');
    const isZip = file.name.toLowerCase().endsWith('.zip');

    if (isZip) {
      if (statusEl) statusEl.textContent = 'Extracting ROM from zip\u2026';
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const result = await extractRomFromZip(reader.result);
          if (!result) {
            if (statusEl) statusEl.textContent = 'No ROM found in zip (.z64/.n64/.v64)';
            return;
          }
          const romBlob = new Blob([result.data]);
          const romFile = new File([romBlob], result.name);
          loadRomData(romFile, result.name);
        } catch (err) {
          console.log('[play] zip extraction failed:', err);
          if (statusEl) statusEl.textContent = 'Failed to extract ROM from zip';
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      loadRomData(file, file.name);
    }
  };

  const loadRomData = (file, displayName) => {
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
    reader.onload = async () => {
      try {
        const hash = await hashArrayBuffer(reader.result);
        _romHash = hash;
        KNState.romHash = hash;
        localStorage.setItem('kaillera-rom-hash', hash);
        console.log(`[play] ROM hash: ${hash.substring(0, 16)}\u2026`);
      } catch (err) {
        console.log('[play] hash failed:', err);
      }
      notifyRomReady();
      // Always proceed with late-join, even if hash computation failed
      if (_pendingLateJoin) {
        dismissLateJoinPrompt();
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // ── ZIP extraction ────────────────────────────────────────────────────

  const _ROM_EXTS = ['.z64', '.n64', '.v64', '.ndd'];

  const extractRomFromZip = async (arrayBuffer) => {
    const data = new Uint8Array(arrayBuffer);
    const entries = fflate.unzipSync(data);

    for (const [fileName, fileData] of Object.entries(entries)) {
      const lower = fileName.toLowerCase();
      if (_ROM_EXTS.some((ext) => lower.endsWith(ext)) && fileData.length > 0) {
        const baseName = fileName.split('/').pop();
        return { name: baseName, data: fileData };
      }
    }

    return null;
  };

  const hashArrayBuffer = async (buf) => {
    // crypto.subtle requires a secure context (HTTPS or localhost).
    // On LAN IPs over HTTP, fall back to FNV-1a.
    // Prefix with algorithm tag so cross-context comparisons can detect
    // mismatched algorithms and skip the check instead of false-alarming.
    if (window.crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const arr = new Uint8Array(digest);
      let hex = '';
      for (const byte of arr) {
        hex += `0${byte.toString(16)}`.slice(-2);
      }
      return `S${hex}`;
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
    return `F${'00000000'.concat(h1.toString(16)).slice(-8)}${'00000000'.concat(h2.toString(16)).slice(-8)}`;
  };

  // Compare ROM hashes: returns true if they definitely mismatch.
  // Hashes are prefixed with 'S' (SHA-256) or 'F' (FNV-1a).
  // If algorithms differ (host on localhost, guest on LAN HTTP), skip — can't compare.
  const romHashMismatch = (a, b) => {
    if (!a || !b) return false;
    if (a[0] !== b[0]) return false; // different algorithms, can't compare
    return a !== b;
  };

  // ── ROM IDB Cache ──────────────────────────────────────────────────────

  const _ROM_DB = 'kaillera-rom-cache';
  const _ROM_STORE = 'roms';

  const openRomDB = (cb) => {
    const req = indexedDB.open(_ROM_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(_ROM_STORE);
    };
    req.onsuccess = () => {
      cb(req.result);
    };
    req.onerror = () => {
      cb(null);
    };
  };

  const cacheRom = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      openRomDB((db) => {
        if (!db) return;
        const tx = db.transaction(_ROM_STORE, 'readwrite');
        tx.objectStore(_ROM_STORE).put(reader.result, 'current');
      });
    };
    reader.readAsArrayBuffer(file);
  };

  const loadCachedRom = (cb) => {
    const name = localStorage.getItem('kaillera-rom-name');
    if (!name) {
      cb(null);
      return;
    }
    openRomDB((db) => {
      if (!db) {
        cb(null);
        return;
      }
      const tx = db.transaction(_ROM_STORE, 'readonly');
      const req = tx.objectStore(_ROM_STORE).get('current');
      req.onsuccess = async () => {
        if (!req.result) {
          cb(null);
          return;
        }
        const blob = new Blob([req.result]);
        _romBlob = blob;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        // Enable ROM sharing checkbox immediately (don't gate on hash)
        const romShareCb = document.getElementById('opt-rom-sharing');
        if (romShareCb && isHost) romShareCb.disabled = false;
        // Compute hash from cached data (best-effort — don't block ROM load)
        try {
          const hash = await hashArrayBuffer(req.result);
          _romHash = hash;
          KNState.romHash = hash;
          localStorage.setItem('kaillera-rom-hash', hash);
        } catch (err) {
          console.log('[play] cached ROM hash failed:', err);
        }
        notifyRomReady();
        cb(name);
      };
      req.onerror = () => {
        cb(null);
      };
    });
  };

  const initEngine = () => {
    // Guard against double-init (e.g., race between game-started events).
    // Stop the previous engine so its socket listeners are removed first.
    if (engine) {
      engine.stop();
      engine = null;
    }

    // Spectators and streaming guests receive video via #stream-overlay —
    // keep #game hidden so the EJS canvas doesn't bleed through.
    // Only show #game when the emulator is needed (lockstep or streaming host).
    // Re-create EmulatorJS if it was destroyed (restart after end-game)
    // Skip boot if no ROM loaded (connect-only mode for ROM sharing)
    const needsEmulator = !isSpectator && !(mode === 'streaming' && !isHost);
    if (needsEmulator && (_romBlob || _romBlobUrl)) {
      // Show #game and suppress EJS overlays via CSS
      const gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.display = '';
        gameEl.classList.add('kn-playing');
      }
      if (_hibernated && _hibernatedRomHash === _romHash) {
        wakeEmulator();
        // Streaming host needs the emulator free-running for canvas capture.
        // Lockstep doesn't — enterManualMode() captures the runner via rAF
        // override without ever giving EJS free frames to show its UI menus.
        if (mode === 'streaming') {
          const wakeMod = window.EJS_emulator?.gameManager?.Module;
          if (wakeMod?.resumeMainLoop) wakeMod.resumeMainLoop();
        }
      } else {
        if (_hibernated) {
          // ROM changed — can't reuse hibernated emulator
          console.log('[play] initEngine: ROM changed, full restart');
          destroyEmulator();
          _hibernated = false;
          _hibernatedRomHash = null;
        }
        bootEmulator();
      }
    } else {
      console.log('[play] initEngine: connect-only mode (spectator or no ROM)');
    }

    const Engine = mode === 'streaming' ? window.NetplayStreaming : window.NetplayLockstep;

    if (!Engine) {
      showError('Netplay engine not loaded');
      return;
    }

    const rollbackEnabled = _gameRollbackEnabled;

    engine = Engine;
    engine.init({
      socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      isSpectator,
      playerName,
      gameElement: document.getElementById('game'),
      rollbackEnabled,
      romHash: _romHash ?? null,
      uploadToken: _uploadToken,
      isMobile: _isMobile,
      onStatus: (msg) => {
        // Show in toolbar (visible during gameplay) and overlay (visible pre-game)
        const toolbarEl = document.getElementById('toolbar-status');
        if (toolbarEl) toolbarEl.textContent = msg;
        const overlayEl = document.getElementById('engine-status');
        if (overlayEl) overlayEl.textContent = msg;
        // Update game loading overlay
        const loadingText = document.getElementById('game-loading-text');
        if (loadingText) loadingText.textContent = msg;
        // Dismiss loading overlay when game loop starts or stream connects
        if (msg.includes('game on') || msg.includes('Spectating') || msg.includes('streaming')) {
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
        const peers = KNState.peers || {};
        const hasOpenDC = Object.values(peers).some((p) => p.dc?.readyState === 'open');

        if (!hasOpenDC) {
          overlay.classList.remove('hidden');
          const text = document.getElementById('reconnect-text');
          const rejoinBtn = document.getElementById('reconnect-rejoin');
          if (text) text.textContent = 'Connection lost — reconnecting...';
          if (rejoinBtn) rejoinBtn.classList.add('hidden');
        }
      },
      onPeerReconnected: (sid) => {
        // Resume ROM transfer if paused — mark DC to wait for receiver's rom-resume
        if (_romTransferState === 'paused' && engine?.getPeerConnection) {
          startRomTransferTo(sid);
        }
      },
      initialPlayers: lastUsersData,
      lateJoin: _lateJoin,
    });
    _lateJoin = false;

    // Connection timeout: if the game-loading overlay is still visible after
    // 30 seconds, the WebRTC handshake likely failed (NAT/firewall).
    setTimeout(() => {
      const loadingEl = document.getElementById('game-loading');
      if (loadingEl && !loadingEl.classList.contains('hidden') && gameRunning) {
        const text = document.getElementById('game-loading-text');
        if (text) text.textContent = 'Connection timed out — check your network or firewall';
        showToast('Could not connect to other players');
      }
    }, 30000);

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
  };

  const startGame = () => {
    if (!_romBlob && !_romBlobUrl) {
      showToast('Load a ROM file before starting');
      return;
    }
    const sel = document.getElementById('mode-select');
    const selectedMode = sel ? sel.value : mode;
    const optRollback = document.getElementById('opt-rollback');
    socket.emit(
      'start-game',
      {
        mode: selectedMode,
        rollbackEnabled: optRollback ? optRollback.checked : false,
        romHash: _romHash ?? null,
      },
      (err) => {
        if (err) showToast(err);
      },
    );
  };

  // ── Sync log upload ──────────────────────────────────────────────────
  const uploadSyncLogs = async (trigger) => {
    const logs = engine?.exportSyncLog?.();
    if (!logs) return;
    const slot = window._playerSlot ?? 'x';
    const room = roomCode ?? 'unknown';
    const url = `/api/sync-logs?room=${encodeURIComponent(room)}&slot=${slot}&token=${encodeURIComponent(_uploadToken)}`;
    try {
      const res = await fetch(url, { method: 'POST', body: logs, headers: { 'Content-Type': 'text/plain' } });
      if (res.ok) {
        console.log(`[play] sync logs uploaded (${trigger}, ${Math.round(logs.length / 1024)}KB)`);
        showToast?.('Logs uploaded');
        try {
          localStorage.removeItem('kn-pending-log');
        } catch (_) {}
      } else {
        console.log(`[play] sync log upload failed: ${res.status}`);
        showToast?.(`Log upload failed: ${res.status}`);
      }
    } catch (err) {
      console.log('[play] sync log upload error:', err);
      showToast?.('Log upload failed');
    }
  };

  const endGame = () => {
    socket.emit('end-game', {}, (err) => {
      if (err) {
        console.log('[play] end-game error:', err);
        showToast(`End game failed: ${err}`);
      }
    });
  };

  const leaveGame = () => {
    // Notify peers this is intentional (prevents reconnect attempt)
    if (engine && KNState.peers) {
      for (const p of Object.values(KNState.peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('leaving');
          } catch (_) {}
        }
      }
    }
    socket.emit('leave-room', {});
    if (engine) {
      uploadSyncLogs('leave');
      engine.stop();
      engine = null;
    }
    window.location.href = '/';
  };

  // ── Late-Join ROM Prompt ─────────────────────────────────────────────

  const showLateJoinRomPrompt = () => {
    // Show the overlay with only the ROM drop zone visible
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Hide everything except the ROM section
    const sections = overlay.querySelectorAll(
      '.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status',
    );
    for (const section of sections) {
      section.style.display = 'none';
    }

    // Show only the ROM drop section
    const romDrop = document.getElementById('rom-drop');
    if (romDrop?.parentNode) romDrop.parentNode.style.display = '';

    // Add a heading message
    const card = overlay.querySelector('.overlay-card');
    if (card) {
      const msg = document.createElement('p');
      msg.id = 'late-join-msg';
      msg.style.cssText = 'text-align:center;color:#6af;margin-bottom:12px;font-size:14px;';
      msg.textContent = 'Game in progress — load a ROM to join';
      card.insertBefore(msg, card.firstChild);
    }
  };

  const dismissLateJoinPrompt = () => {
    _pendingLateJoin = false;

    // Verify ROM hash before joining (skip if ROM sharing — ROM comes from host)
    if (romHashMismatch(_hostRomHash, _romHash) && _romSharingDecision !== 'accepted') {
      showError("ROM mismatch — your ROM doesn't match the host's. Please load the correct ROM and rejoin.");
      return;
    }

    // Remove the late-join message
    const msg = document.getElementById('late-join-msg');
    if (msg) msg.parentNode.removeChild(msg);

    // Restore all sections visibility
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      const sections = overlay.querySelectorAll(
        '.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status',
      );
      for (const section of sections) {
        section.style.display = '';
      }
    }

    // Now proceed with late join
    showToolbar();
    initEngine();
  };

  // ── UI: Overlay ────────────────────────────────────────────────────────

  const showOverlay = () => {
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

    // Spectators don't need ROM, gamepad, or player controls — just the player list
    const romDrop = document.getElementById('rom-drop');
    const romSharingPrompt = document.getElementById('rom-sharing-prompt');
    const gamepadArea = document.getElementById('gamepad-area');
    if (isSpectator) {
      if (romDrop) romDrop.style.display = 'none';
      if (romSharingPrompt) romSharingPrompt.style.display = 'none';
      if (gamepadArea) gamepadArea.style.display = 'none';
      if (guestStatus) guestStatus.textContent = 'Waiting for host to start the game...';
    }

    // Show player controls (delay picker) for all non-spectator players in lockstep mode
    const playerControls = document.getElementById('player-controls');
    if (playerControls) {
      playerControls.style.display = !isSpectator && mode === 'lockstep' ? '' : 'none';
    }

    const modeSel = document.getElementById('mode-select');
    if (modeSel) modeSel.value = mode;
  };

  const hideOverlay = () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
  };

  const updatePlayerList = (players, spectators, ownerSid) => {
    for (let i = 0; i < 4; i++) {
      const slotEl = document.querySelector(`.player-slot[data-slot="${i}"]`);
      if (!slotEl) continue;
      const nameEl = slotEl.querySelector('.name');
      if (!nameEl) continue;

      let playerInSlot = null;
      for (const entry of Object.values(players)) {
        if (entry.slot === i) {
          playerInSlot = entry;
          break;
        }
      }

      const gpEl = slotEl.querySelector('.gamepad');
      const devEl = slotEl.querySelector('.device');

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
        // Show device type indicator
        if (devEl) {
          const dtype = playerInSlot.deviceType || 'desktop';
          devEl.textContent = dtype === 'mobile' ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F';
          devEl.title = dtype === 'mobile' ? 'Mobile' : 'Desktop';
        }
      } else {
        nameEl.textContent = 'Open';
        nameEl.classList.add('empty');
        if (gpEl) {
          gpEl.textContent = '';
          gpEl.title = '';
        }
        if (devEl) {
          devEl.textContent = '';
          devEl.title = '';
        }
      }
    }

    const specEl = document.getElementById('spectator-list');
    if (specEl) {
      const specNames = Object.values(spectators).map((s) => s.playerName);
      specEl.textContent = specNames.length > 0 ? `Watching: ${specNames.join(', ')}` : '';
    }
  };

  const updateRomDeclarePrompt = () => {
    const prompt = document.getElementById('rom-declare-prompt');
    const romDrop = document.getElementById('rom-drop');
    if (!prompt) return;
    // Show only in streaming mode for non-host, non-spectator players
    // when ROM sharing is off. In lockstep mode, normal ROM loading applies.
    const isStreaming = mode === 'streaming';
    const show = isStreaming && !isHost && !isSpectator && !_romSharingEnabled;
    prompt.style.display = show ? '' : 'none';

    // Auto-declare if guest already has a ROM loaded (e.g., from a previous
    // lockstep game). They already loaded/owned the ROM — re-asking is friction.
    if (show && !_romDeclared && (_romBlob || _romBlobUrl)) {
      _romDeclared = true;
      const cb = document.getElementById('rom-declare-cb');
      if (cb) cb.checked = true;
      if (socket?.connected) {
        socket.emit('rom-declare', { declared: true });
      }
    }

    // Hide ROM drop box when declaration is checked (streaming guests don't need a ROM)
    if (romDrop && show && _romDeclared) {
      romDrop.style.display = 'none';
    } else if (romDrop && !_romDeclared && !_romSharingEnabled) {
      romDrop.style.display = '';
    }
  };

  const updateStartButton = (players) => {
    const btn = document.getElementById('start-btn');
    if (!btn || !isHost) return;
    const sel = document.getElementById('mode-select');
    const selectedMode = sel ? sel.value : mode;
    const playerCount = Object.keys(players).length;
    const entries = Object.values(players);

    if (playerCount < 1) {
      btn.disabled = true;
      btn.textContent = 'Start Game';
    } else if (selectedMode === 'streaming' && playerCount < 2) {
      btn.disabled = true;
      btn.textContent = 'Start Game (need 2+)';
    } else if (selectedMode === 'streaming') {
      // Streaming: check ROM declarations (host is exempt)
      const guestsReady = entries.every((p) => p.slot === 0 || p.romDeclared);
      if (!guestsReady) {
        btn.disabled = true;
        const declaredCount = entries.filter((p) => p.slot === 0 || p.romDeclared).length;
        btn.textContent = `Waiting for declarations (${declaredCount}/${playerCount})`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Start Game';
      }
    } else {
      // Lockstep: check ROMs loaded
      const allReady = entries.every((p) => p.romReady);
      if (!allReady && !_romSharingEnabled) {
        btn.disabled = true;
        const readyCount = entries.filter((p) => p.romReady).length;
        btn.textContent = `Waiting for ROMs (${readyCount}/${playerCount})`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Start Game';
      }
    }
  };

  // ── UI: Toolbar ────────────────────────────────────────────────────────

  let _loadingTimeoutId = null;

  const showGameLoading = () => {
    const el = document.getElementById('game-loading');
    if (el) {
      el.classList.remove('hidden', 'fade-out');
    }
    // Show a reassurance message if loading takes more than 15 seconds
    if (_loadingTimeoutId) clearTimeout(_loadingTimeoutId);
    _loadingTimeoutId = setTimeout(() => {
      const text = document.getElementById('game-loading-text');
      if (text && !el?.classList.contains('hidden')) {
        text.textContent = 'Still loading — this can take a moment on first boot...';
      }
    }, 15000);
  };

  const dismissGameLoading = () => {
    if (_loadingTimeoutId) {
      clearTimeout(_loadingTimeoutId);
      _loadingTimeoutId = null;
    }
    const el = document.getElementById('game-loading');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('fade-out');
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('fade-out');
    }, 400);
  };

  const showToolbar = () => {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    const roomEl = document.getElementById('toolbar-room');
    if (roomEl) roomEl.textContent = `Room: ${roomCode}`;

    const endBtn = document.getElementById('toolbar-end');
    if (endBtn) endBtn.style.display = isHost ? '' : 'none';
  };

  const hideToolbar = () => {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.add('hidden');
    hideInfoOverlay();
  };

  // ── UI: Info Overlay ──────────────────────────────────────────────────

  let _infoVisible = false;
  let _infoInterval = null;

  const toggleInfoOverlay = () => {
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
  };

  const hideInfoOverlay = () => {
    _infoVisible = false;
    const el = document.getElementById('info-overlay');
    const btn = document.getElementById('toolbar-info');
    if (el) el.classList.add('hidden');
    if (btn) btn.classList.remove('active');
    if (_infoInterval) {
      clearInterval(_infoInterval);
      _infoInterval = null;
    }
  };

  const updateInfoOverlay = () => {
    const info = engine?.getInfo?.() ?? null;

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
    const inputType = window.GamepadManager?.hasGamepad?.(mySlot) ? 'Gamepad' : 'Keyboard';
    const modeLabel = info.mode === 'streaming' ? 'Streaming' : 'Lockstep';
    if (headerEl) headerEl.textContent = `${modeLabel} | ${inputType}`;

    // Stats line
    const parts = [];
    parts.push(`FPS: ${info.fps || 0}`);
    const pingStr = info.ping !== null && info.ping !== undefined ? `${Math.round(info.ping)}ms` : '--';
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
      for (const p of info.peers) {
        const pRtt = p.rtt !== null ? `${Math.round(p.rtt)}ms` : '--';
        peerLines.push(`P${p.slot + 1}: ${pRtt}`);
      }
    } else if (info.mode === 'streaming') {
      // Streaming-specific detail (values are numeric from gatherStats)
      if (info.encodeTime !== null) peerLines.push(`Encode: ${info.encodeTime}ms`);
      if (info.bitrate !== null) peerLines.push(`BW: ${info.bitrate}Mbps`);
      if (info.jitter !== null) peerLines.push(`Jitter: ${info.jitter}ms`);
      if (info.lossRate && info.lossRate > 0) peerLines.push(`Loss: ${info.lossRate}%`);
    }
    if (peersEl) peersEl.textContent = peerLines.join(' | ');
  };

  // ── UI: Toast Notifications ───────────────────────────────────────────

  const showToast = (msg) => {
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
  };

  // ── UI: Error ──────────────────────────────────────────────────────────

  const showError = (msg) => {
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
  };

  const showRoomFullBanner = () => {
    const banner = document.createElement('div');
    banner.className = 'room-full-banner';
    banner.innerHTML = '<span>Game is full \u2014 you\u2019ve joined as a spectator</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'banner-close';
    closeBtn.textContent = '\u2715';
    closeBtn.onclick = () => {
      banner.remove();
    };
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
    setTimeout(() => {
      if (banner.parentNode) banner.remove();
    }, 5000);
  };

  // ── UI: Copy Link ─────────────────────────────────────────────────────

  const copyLink = () => {
    const url = `${window.location.origin}/play.html?room=${roomCode}`;
    copyToClipboard(url, 'Link');
  };

  // ── UI: In-Game Share Dropdown ──────────────────────────────────────

  const copyToClipboard = async (text, label) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied!`);
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
  };

  const toggleShareDropdown = () => {
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
  };

  const closeShareDropdown = () => {
    const dd = document.getElementById('share-dropdown');
    const btn = document.getElementById('toolbar-share');
    if (dd) dd.classList.add('hidden');
    if (btn) btn.classList.remove('active');
  };

  // ── Gamepad Detection ─────────────────────────────────────────────────

  // ── Input Type Detection ─────────────────────────────────────────────

  const setInputType = (type) => {
    if (type === _currentInputType) return;
    _currentInputType = type;
    if (socket?.connected) {
      socket.emit('input-type', { type });
    }
  };

  const setupInputTypeDetection = () => {
    // Mobile always uses gamepad (virtual touch or real) — no keyboard switching
    if (!_isMobile) {
      document.addEventListener('keydown', () => {
        setInputType('keyboard');
      });
    }

    // Gamepad → set to gamepad (checked via GamepadManager onUpdate)
    // The updateGamepadUI callback already fires on gamepad changes;
    // we piggyback on that in updateGamepadUI below.
  };

  const startGamepadManager = () => {
    if (!window.GamepadManager) return;
    GamepadManager.start({
      playerSlot: mySlot || 0,
      onUpdate: updateGamepadUI,
    });
  };

  const updateGamepadSlot = () => {
    // Re-start with correct slot when mySlot changes (after join/connect)
    if (window.GamepadManager && mySlot !== null) {
      GamepadManager.start({
        playerSlot: mySlot,
        onUpdate: updateGamepadUI,
      });
    }
  };

  const updateGamepadUI = () => {
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
    if (ejs?.virtualGamepad) {
      if (detected.length > 0) {
        ejs.virtualGamepad.style.display = 'none';
      } else if (ejs.touch) {
        ejs.virtualGamepad.style.display = '';
      }
    }

    // Toggle standalone virtual gamepad (streaming mode guests)
    if (window.VirtualGamepad) {
      if (detected.length > 0) {
        VirtualGamepad.setVisible(false);
      } else if ('ontouchstart' in window) {
        VirtualGamepad.setVisible(true);
      }
    }

    // Mobile: constrain game to 4:3 for vertical centering when gamepad hides virtual controls
    const gameEl = document.getElementById('game');
    if (gameEl && 'ontouchstart' in window) {
      gameEl.classList.toggle('gamepad-connected', detected.length > 0);
    }

    // Mobile: show/hide gamepad indicator during gameplay
    const gamepadIndicator = document.getElementById('gamepad-indicator');
    if (gamepadIndicator && 'ontouchstart' in window) {
      gamepadIndicator.classList.toggle('hidden', detected.length === 0);
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
  };

  // ── Remap Wizard ──────────────────────────────────────────────────────

  const WIZARD_STEPS = [
    { prompt: 'Press: A', type: 'button', bit: 0 },
    { prompt: 'Press: B', type: 'button', bit: 1 },
    { prompt: 'Press: Start', type: 'button', bit: 3 },
    { prompt: 'Press: Z', type: 'button', bit: 12 },
    { prompt: 'Press: L', type: 'button', bit: 10 },
    { prompt: 'Press: R', type: 'button', bit: 11 },
    { prompt: 'Press: D-Up', type: 'button', bit: 4 },
    { prompt: 'Press: D-Down', type: 'button', bit: 5 },
    { prompt: 'Press: D-Left', type: 'button', bit: 6 },
    { prompt: 'Press: D-Right', type: 'button', bit: 7 },
    { prompt: 'Push stick UP', type: 'axis', bit: 19, axisGroup: 'stickY' },
    { prompt: 'Push stick DOWN', type: 'axis', bit: 18, axisGroup: 'stickY' },
    { prompt: 'Push stick LEFT', type: 'axis', bit: 17, axisGroup: 'stickX' },
    { prompt: 'Push stick RIGHT', type: 'axis', bit: 16, axisGroup: 'stickX' },
    { prompt: 'Press: C-Up', type: 'cbutton', bit: 23 },
    { prompt: 'Press: C-Down', type: 'cbutton', bit: 22 },
    { prompt: 'Press: C-Left', type: 'cbutton', bit: 20 },
    { prompt: 'Press: C-Right', type: 'cbutton', bit: 21 },
  ];

  let _wizardActive = false;
  let _wizardInGame = false; // true when wizard launched from in-game toolbar
  let _wizardStep = 0;
  let _wizardDebounce = 0;
  let _wizardRafId = null;
  let _wizardKeyHandler = null;
  let _wizardGamepadProfile = null;
  let _wizardKeyMap = null;
  let _wizardBaselineButtons = null;
  let _wizardAxisCaptures = {};
  let _wizardSnapshots = []; // state snapshots for go-back
  let _wizardHadGamepad = false;
  let _wizardHotPlugCheck = 0;

  const startWizard = (inGame) => {
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    const gamepadId = detected.length > 0 ? detected[0].id : null;

    // Initialize gamepad profile from current (default or saved)
    if (gamepadId && window.GamepadManager) {
      const current = GamepadManager.hasCustomProfile(gamepadId)
        ? JSON.parse(localStorage.getItem(`gamepad-profile:${gamepadId}`))
        : GamepadManager.getDefaultProfile(gamepadId);
      _wizardGamepadProfile = {
        name: 'Custom',
        buttons: { ...current.buttons },
        axes: JSON.parse(JSON.stringify(current.axes)),
        axisButtons: JSON.parse(JSON.stringify(current.axisButtons || {})),
        deadzone: current.deadzone || 0.3,
      };
    } else {
      _wizardGamepadProfile = null;
    }

    // Initialize keyboard map from current (saved or DEFAULT_N64_KEYMAP)
    let savedKb = null;
    try {
      savedKb = JSON.parse(localStorage.getItem('keyboard-mapping'));
    } catch (_) {}
    if (savedKb && Object.keys(savedKb).length > 0) {
      _wizardKeyMap = { ...savedKb };
    } else {
      _wizardKeyMap = {
        67: 0,
        88: 1,
        86: 3,
        38: 4,
        40: 5,
        37: 6,
        39: 7,
        84: 10,
        89: 11,
        90: 12,
        68: 16,
        65: 17,
        83: 18,
        87: 19,
        74: 20,
        76: 21,
        75: 22,
        73: 23,
      };
    }

    _wizardAxisCaptures = {};
    _wizardSnapshots = [];
    _wizardStep = 0;
    _wizardActive = true;
    KNState.remapActive = true; // exposed for netplay input suppression
    _wizardInGame = !!inGame;
    _wizardDebounce = 0;

    if (_wizardInGame) {
      // Show in-game remap overlay
      const igOverlay = document.getElementById('ingame-remap');
      if (igOverlay) igOverlay.classList.remove('hidden');
    } else {
      // Show wizard UI in pre-game overlay, hide normal controls
      const wizardEl = document.getElementById('remap-wizard');
      const controlsEl = document.getElementById('gamepad-controls');
      const statusEl = document.getElementById('gamepad-status');
      if (wizardEl) wizardEl.style.display = '';
      if (controlsEl) controlsEl.style.display = 'none';
      if (statusEl) statusEl.style.display = 'none';
    }

    // Capture baseline gamepad buttons (ignore already-pressed)
    _wizardBaselineButtons = {};
    if (gamepadId) {
      const gps = GamepadManager.nativeGetGamepads();
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
      if (e.keyCode === 27) {
        cancelWizard();
        return;
      } // Escape
      e.preventDefault();
      if (Date.now() < _wizardDebounce) return;
      captureKeyboard(e.keyCode);
    };
    document.addEventListener('keydown', _wizardKeyHandler, true);

    // Track initial gamepad presence for hot-plug notifications
    const initGps = GamepadManager.nativeGetGamepads();
    _wizardHadGamepad = false;
    for (let gi2 = 0; gi2 < initGps.length; gi2++) {
      if (initGps[gi2]) {
        _wizardHadGamepad = true;
        break;
      }
    }
    _wizardHotPlugCheck = 0;

    // Start polling loop
    updateWizardPrompt();
    wizardPoll();
  };

  const cancelWizard = () => {
    const wasInGame = _wizardInGame;
    _wizardActive = false;
    KNState.remapActive = false;
    _wizardInGame = false;
    if (_wizardRafId) {
      clearTimeout(_wizardRafId);
      _wizardRafId = null;
    }
    if (_wizardKeyHandler) {
      document.removeEventListener('keydown', _wizardKeyHandler, true);
      _wizardKeyHandler = null;
    }

    if (wasInGame) {
      const igOverlay = document.getElementById('ingame-remap');
      if (igOverlay) igOverlay.classList.add('hidden');
    } else {
      const wizardEl = document.getElementById('remap-wizard');
      const controlsEl = document.getElementById('gamepad-controls');
      const statusEl = document.getElementById('gamepad-status');
      if (wizardEl) wizardEl.style.display = 'none';
      if (controlsEl) controlsEl.style.display = '';
      if (statusEl) statusEl.style.display = '';
    }
  };

  const saveWizard = () => {
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
  };

  const resetMappings = () => {
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && window.GamepadManager) {
      GamepadManager.clearGamepadProfile(detected[0].id);
    }
    try {
      localStorage.removeItem('keyboard-mapping');
    } catch (_) {}
    updateGamepadUI();
  };

  const updateWizardPrompt = () => {
    const prefix = _wizardInGame ? 'ingame-remap' : 'remap';
    const promptEl = document.getElementById(`${prefix}-prompt`);
    const progressEl = document.getElementById(`${prefix}-progress`);
    const backBtn = document.getElementById(`${prefix}-back`);
    if (promptEl) promptEl.textContent = `${WIZARD_STEPS[_wizardStep].prompt} (gamepad or key)`;
    if (progressEl) progressEl.textContent = `(${_wizardStep + 1}/${WIZARD_STEPS.length})`;
    if (backBtn) backBtn.disabled = _wizardStep === 0;
  };

  const wizardSaveSnapshot = () => {
    _wizardSnapshots.push({
      gamepadProfile: _wizardGamepadProfile ? JSON.parse(JSON.stringify(_wizardGamepadProfile)) : null,
      keyMap: _wizardKeyMap ? { ..._wizardKeyMap } : null,
      axisCaptures: JSON.parse(JSON.stringify(_wizardAxisCaptures)),
    });
  };

  const wizardAdvance = () => {
    _wizardDebounce = Date.now() + 150;
    _wizardStep++;
    if (_wizardStep >= WIZARD_STEPS.length) {
      saveWizard();
      return;
    }
    // Reset baseline for new step
    _wizardBaselineButtons = {};
    const gps = GamepadManager.nativeGetGamepads();
    for (let gi = 0; gi < gps.length; gi++) {
      if (gps[gi]) {
        for (let bi = 0; bi < gps[gi].buttons.length; bi++) {
          if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[`${gi}:${bi}`] = true;
        }
      }
    }
    updateWizardPrompt();
  };

  const wizardBack = () => {
    if (!_wizardActive || _wizardStep === 0 || _wizardSnapshots.length === 0) return;
    const snap = _wizardSnapshots.pop();
    _wizardStep--;
    _wizardGamepadProfile = snap.gamepadProfile;
    _wizardKeyMap = snap.keyMap;
    _wizardAxisCaptures = snap.axisCaptures;
    _wizardDebounce = Date.now() + 150;
    updateWizardPrompt();
  };

  const wizardSkip = () => {
    if (!_wizardActive) return;
    wizardSaveSnapshot();
    wizardAdvance();
  };

  const wizardPoll = () => {
    if (!_wizardActive) return;
    // Use setTimeout instead of rAF — lockstep overrides rAF and our
    // callback would replace the emulator's frame runner, freezing the game.
    _wizardRafId = setTimeout(wizardPoll, 16);

    if (Date.now() < _wizardDebounce) return;

    const gps = GamepadManager.nativeGetGamepads();

    // Hot-plug detection (check every ~30 frames / 500ms)
    _wizardHotPlugCheck++;
    if (_wizardHotPlugCheck % 30 === 0) {
      let hasNow = false;
      for (let hi = 0; hi < gps.length; hi++) {
        if (gps[hi]) {
          hasNow = true;
          break;
        }
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
        const dz = 0.5; // higher than gameplay deadzone to avoid accidental captures
        for (let ai = 0; ai < gp.axes.length; ai++) {
          const val = gp.axes[ai];
          if (Math.abs(val) > dz) {
            captureGamepadAxis(ai, val > 0, step);
            return;
          }
        }
      }
    }
  };

  const captureGamepadButton = (buttonIndex, step) => {
    if (!_wizardGamepadProfile) return;
    wizardSaveSnapshot();
    _wizardGamepadProfile.buttons[buttonIndex] = 1 << step.bit;
    wizardAdvance();
  };

  const captureGamepadAxis = (axisIndex, isPositive, step) => {
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
        const prefix = _wizardInGame ? 'ingame-remap' : 'remap';
        const promptEl = document.getElementById(`${prefix}-prompt`);
        if (promptEl) {
          const pairName = group === 'stickY' ? 'UP' : 'LEFT';
          promptEl.textContent = `Must use same stick as ${pairName} — try again`;
          setTimeout(() => {
            updateWizardPrompt();
          }, 1000);
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
        _wizardGamepadProfile.axisButtons[axisIndex].pos |= 1 << step.bit;
      } else {
        _wizardGamepadProfile.axisButtons[axisIndex].neg |= 1 << step.bit;
      }
      wizardAdvance();
    }
  };

  const captureKeyboard = (keyCode) => {
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
  };

  // ── Delay Preference ────────────────────────────────────────────────

  KNState.delayAutoValue = 2;

  const getDelayPreference = () => {
    const autoEl = document.getElementById('delay-auto');
    const selectEl = document.getElementById('delay-select');
    if (autoEl?.checked) {
      return KNState.delayAutoValue;
    }
    if (selectEl) {
      const v = parseInt(selectEl.value, 10);
      return v > 0 ? v : 2;
    }
    return 2;
  };

  window.getDelayPreference = getDelayPreference;

  const setAutoDelay = (value) => {
    KNState.delayAutoValue = value;
    const selectEl = document.getElementById('delay-select');
    const autoEl = document.getElementById('delay-auto');
    if (selectEl && autoEl?.checked) {
      selectEl.value = String(value);
    }
  };

  window.setAutoDelay = setAutoDelay;

  const KAILLERA_LABELS = ['LAN', 'Excellent', 'Excellent', 'Good', 'Good', 'Average', 'Average', 'Low', 'Bad', 'Bad'];

  const showEffectiveDelay = (own, room) => {
    const el = document.getElementById('delay-effective');
    if (!el) return;
    const label = KAILLERA_LABELS[room] ?? '';
    if (room > own) {
      el.textContent = `(room: ${room} — ${label})`;
    } else {
      el.textContent = label ? `(${label})` : '';
    }
  };

  window.showEffectiveDelay = showEffectiveDelay;

  // ── Init ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    console.log('kaillera-next — v0.9 forever');
    console.log('Welcome to a new EmuLinker Server!');
    console.log('Edit language.properties to setup your login announcements');
    parseParams();
    if (!roomCode) {
      window.location.href = '/';
      return;
    }

    // Name input — populate from current name, save + notify on change
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) {
      nameInput.value = playerName;
      nameInput.addEventListener('change', () => {
        const val = nameInput.value.trim();
        if (val && val !== playerName) {
          playerName = val;
          localStorage.setItem('kaillera-name', playerName);
          if (socket?.connected) {
            socket.emit('set-name', { name: playerName });
          }
        } else if (!val) {
          nameInput.value = playerName;
        }
      });
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

    // Mobile: tap info overlay to expand/collapse details
    const infoOverlay = document.getElementById('info-overlay');
    if (infoOverlay && _isMobile) {
      infoOverlay.addEventListener('click', () => {
        infoOverlay.classList.toggle('expanded');
      });
    }

    const dumpLogsBtn = document.getElementById('dump-logs-btn');
    if (dumpLogsBtn)
      dumpLogsBtn.addEventListener('click', () => {
        if (engine?.dumpLogs) {
          engine.dumpLogs();
          showToast('Debug logs sent to server');
        }
      });

    const toolbarShare = document.getElementById('toolbar-share');
    if (toolbarShare) toolbarShare.addEventListener('click', toggleShareDropdown);

    const sharePlay = document.getElementById('share-play');
    if (sharePlay)
      sharePlay.addEventListener('click', () => {
        const url = `${window.location.origin}/play.html?room=${roomCode}`;
        copyToClipboard(url, 'Play link');
        closeShareDropdown();
      });

    const shareWatch = document.getElementById('share-watch');
    if (shareWatch)
      shareWatch.addEventListener('click', () => {
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
          if (cb?.checked) {
            cb.checked = false;
            socket.emit('rom-sharing-toggle', { enabled: false });
          }
        }
        updateRomDeclarePrompt();
        if (lastUsersData) updateStartButton(lastUsersData.players || {});
        // Broadcast mode to guests so they can show/hide declaration prompt
        if (socket?.connected) {
          socket.emit('data-message', { type: 'mode-select', mode: modeSelect.value });
          // Also set on server for users-updated payload (requires server restart)
          socket.emit('set-mode', { mode: modeSelect.value });
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

    const romRetryBtn = document.getElementById('rom-transfer-retry');
    if (romRetryBtn) romRetryBtn.addEventListener('click', retryRomTransfer);
    const romCancelBtn = document.getElementById('rom-transfer-cancel');
    if (romCancelBtn) romCancelBtn.addEventListener('click', cancelRomTransfer);

    // ROM ownership declaration (streaming mode)
    const romDeclareCb = document.getElementById('rom-declare-cb');
    if (romDeclareCb) {
      // Restore cached state
      if (_romDeclared) romDeclareCb.checked = true;
      romDeclareCb.addEventListener('change', () => {
        _romDeclared = romDeclareCb.checked;
        if (socket?.connected) {
          socket.emit('rom-declare', { declared: _romDeclared });
        }
        updateRomDeclarePrompt();
      });
    }

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

    // In-game remap (toolbar button + overlay buttons)
    const toolbarRemapBtn = document.getElementById('toolbar-remap');
    if (toolbarRemapBtn) toolbarRemapBtn.addEventListener('click', () => startWizard(true));

    const igBackBtn = document.getElementById('ingame-remap-back');
    if (igBackBtn) igBackBtn.addEventListener('click', wizardBack);

    const igSkipBtn = document.getElementById('ingame-remap-skip');
    if (igSkipBtn) igSkipBtn.addEventListener('click', wizardSkip);

    const igCancelBtn = document.getElementById('ingame-remap-cancel');
    if (igCancelBtn) igCancelBtn.addEventListener('click', cancelWizard);

    // Sync log upload
    const toolbarLogs = document.getElementById('toolbar-logs');
    if (toolbarLogs) {
      toolbarLogs.addEventListener('click', () => {
        uploadSyncLogs('manual');
      });
    }

    // Click .gamepad span to cycle through detected gamepads
    const gamepadSpans = document.querySelectorAll('.player-slot .gamepad');
    for (const span of gamepadSpans) {
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

    // Mobile landscape prompt — game is unplayable in portrait on phones
    if (_isMobile && window.innerHeight > window.innerWidth) {
      showToast('Rotate to landscape for best experience');
    }
  });

  // E2E test hook — simulate ROM-loaded state without drag-and-drop
  window.__test_setRomLoaded = () => {
    _romBlob = new Uint8Array([0]);
    _romBlobUrl = 'blob:test';
    window.__test_skipBoot = true;
  };
})();
