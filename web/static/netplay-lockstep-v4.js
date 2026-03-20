/**
 * kaillera-next -- Lockstep v4: 4-Player Mesh + Spectators + Drop/Late Join
 *
 * Upgrades the 2-player lockstep to full mesh networking:
 *   - Up to 4 players in a lockstep mesh (6 bidirectional connections)
 *   - Spectators receive canvas video stream from host, no lockstep participation
 *   - Graceful drop handling: remaining players continue without crashing
 *   - Late join: host sends save state + frame counter to new peers
 *
 * Core lockstep mechanism is preserved from v3/v4:
 *   1. rAF interception captures the Emscripten main loop runner
 *   2. setInterval(16) tick loop for background-tab-safe ~60fps
 *   3. Each tick: read input -> send to all peers -> wait for all -> write to Wasm -> step
 *   4. Direct memory input via DataView writes to HEAPU8 (no simulateInput)
 *
 * Mesh initiation: lower slot creates data channel + sends offer.
 * Spectators never initiate -- players initiate connections TO spectators.
 */

(function () {
  'use strict';

  const GAME_ID     = 'ssb64';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Input delay in frames -- both peers buffer this many frames of input
  // before applying. Hides network latency: peer has DELAY_FRAMES worth
  // of time to deliver their input before we need it.
  const DELAY_FRAMES = 2;

  // Maximum time (ms) to stall waiting for remote input before treating
  // the peer as disconnected. Like Kaillera, we WAIT -- no prediction.
  const MAX_STALL_MS = 30000;

  // Desync detection: check every N frames (~2 seconds at 60fps).
  // The emulator is non-deterministic (audio/timing reads performance.now()),
  // so desyncs are inherent. Frequent resyncs keep games visually in sync.
  const SYNC_CHECK_INTERVAL = 120;

  // Standard online cheats (same as other prototypes)
  const SSB64_ONLINE_CHEATS = [
    { desc: 'Have All Characters',   code: '810A4938 0FF0' },
    { desc: 'Have Mushroom Kingdom', code: '800A4937 00FF' },
    { desc: 'Stock Mode',            code: '800A4D0B 0002' },
    { desc: '5 Stocks',              code: '800A4D0F 0004' },
    { desc: 'Timer On',              code: '800A4D11 0001' },
    { desc: 'Items Off',             code: '800A4D24 0000' },
    { desc: 'No Wind',               code: '810BA9F1 0000+800BA9F3 0000' },
  ];

  // Default N64 keymap (EJS defaults) -- fallback when EJS controls unavailable
  const DEFAULT_N64_KEYMAP = {
    88: 0,    // X -> B
    67: 8,    // C -> A
    86: 3,    // V -> Start
    38: 4,    // Up -> D-Up
    40: 5,    // Down -> D-Down
    37: 6,    // Left -> D-Left
    39: 7,    // Right -> D-Right
    90: 9,    // Z -> Z-trigger
    84: 10,   // T -> L-shoulder
    89: 11,   // Y -> R-shoulder
    73: 12,   // I -> C-Up
    75: 13,   // K -> C-Down
    74: 14,   // J -> C-Left
    76: 15,   // L -> C-Right
    87: 16,   // W -> Analog Up
    83: 17,   // S -> Analog Down
    65: 18,   // A -> Analog Left
    68: 19,   // D -> Analog Right
  };

  // -- Direct memory input layout -----------------------------------------------
  //
  // Layout: int32[20][4] -- 20 buttons x 4 players
  // Button stride: 20 bytes (gap between button N and button N+1 for same player)
  // Player stride: 4 bytes (gap between player 0 and player 1 for same button)
  //
  // The base address changes with each WASM compilation, so we auto-discover it
  // at startup by calling _simulate_input and detecting which byte changed.
  // Fallback: 715364 (CDN core address).

  var INPUT_BASE       = 715364;  // auto-discovered at startup
  const BUTTON_STRIDE  = 20;
  const PLAYER_STRIDE  = 4;

  // -- State -----------------------------------------------------------------

  let socket             = null;
  let sessionId          = null;
  let _playerSlot        = -1;      // 0-3 for players, null for spectators
  let _isSpectator       = false;
  let _audioEnabled      = true;     // true = real time (audio), false = frozen (no desync)
  let _peers             = {};      // remoteSid -> PeerState
  let _knownPlayers      = {};      // socketId -> {slot, playerName}
  let _expectedPeerCount = 0;       // other players in room (excludes spectators)
  let _gameStarted       = false;
  let _selfEmuReady      = false;
  let _p1KeyMap          = null;
  let _heldKeys          = new Set();

  // Lockstep state
  let _lockstepReadyPeers = {};     // remoteSid -> true when peer signals lockstep-ready
  let _selfLockstepReady  = false;
  let _guestStateBytes    = null;   // decompressed state bytes to load
  let _frameNum           = 0;      // current logical frame number
  let _localInputs        = {};     // frame -> inputMask
  let _remoteInputs       = {};     // slot -> {frame -> mask} (nested for multi-peer)
  let _running            = false;  // tick loop active

  // Manual mode / rAF interception state
  let _origRAF           = null;    // saved window.requestAnimationFrame
  let _pendingRunner     = null;    // captured Emscripten MainLoop_runner
  let _manualMode        = false;   // true once enterManualMode() called
  let _stallStart        = 0;       // timestamp when current stall began
  let _tickInterval      = null;    // setInterval handle for tick loop

  // State sync — host checks game state hash and pushes only when desynced
  let _syncEnabled       = false;   // off by default — opt-in via toolbar button
  let _syncWorker        = null;    // Web Worker for compress/decompress
  let _syncCheckInterval = 300;    // check hash every N frames (~5s at 60fps)
  let _syncHashBytes     = 65536;  // hash first 64KB of state (game state, not audio)
  let _resyncCount       = 0;
  let _syncChunks        = [];     // incoming chunks from host DC
  let _syncExpected      = 0;      // expected chunk count
  let _syncFrame         = 0;      // frame number of incoming sync
  let _pendingSyncCheck  = null;   // deferred sync check {frame, hash, peerSid}

  // Spectator streaming state
  let _hostStream        = null;    // MediaStream for spectator canvas streaming
  let _guestVideo        = null;    // <video> element (spectator only)

  // Expose for Playwright
  window._playerSlot  = _playerSlot;
  window._isSpectator = _isSpectator;
  window._peers       = _peers;
  window._frameNum    = 0;

  function setStatus(msg) {
    if (_config && _config.onStatus) _config.onStatus(msg);
    console.log('[lockstep-v4]', msg);
  }

  function onDataMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'save-state')     handleSaveStateMsg(msg);
    if (msg.type === 'late-join-state') handleLateJoinState(msg);
  }

  // -- users-updated ---------------------------------------------------------

  function onUsersUpdated(data) {
    var players    = data.players    || {};
    var spectators = data.spectators || {};

    // Rebuild known players map
    _knownPlayers = {};
    Object.values(players).forEach(function (p) {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    });

    // Update my slot from server (handles spectator -> player transition)
    var myPlayerEntry = Object.values(players).find(function (p) {
      return p.socketId === socket.id;
    });
    if (myPlayerEntry) {
      if (_isSpectator) {
        console.log('[lockstep-v4] transitioned from spectator to player, slot:', myPlayerEntry.slot);
        _isSpectator = false;
        window._isSpectator = false;
      }
      _playerSlot = myPlayerEntry.slot;
      window._playerSlot = _playerSlot;
    }

    // Count expected peers (other players, excludes spectators)
    var otherPlayers = Object.values(players).filter(function (p) {
      return p.socketId !== socket.id;
    });
    _expectedPeerCount = otherPlayers.length;

    // Establish mesh connections to other players
    // Lower slot initiates (creates data channel + sends offer)
    for (var i = 0; i < otherPlayers.length; i++) {
      var p = otherPlayers[i];
      if (_peers[p.socketId]) {
        _peers[p.socketId].slot = p.slot;
        continue;
      }

      var shouldInitiate;
      if (_isSpectator) {
        shouldInitiate = false;  // spectators never initiate
      } else {
        shouldInitiate = _playerSlot < p.slot;
      }

      createPeer(p.socketId, p.slot, shouldInitiate);
      if (shouldInitiate) sendOffer(p.socketId);
    }

    // Players initiate connections to spectators
    if (!_isSpectator) {
      var specList = Object.values(spectators);
      for (var j = 0; j < specList.length; j++) {
        var s = specList[j];
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }

    // Notify controller
    if (_config && _config.onPlayersChanged) {
      _config.onPlayersChanged(data);
    }
  }

  // -- WebRTC multi-peer mesh ------------------------------------------------

  function createPeer(remoteSid, remoteSlot, isInitiator) {
    var peer = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      dc: null,
      slot: remoteSlot,
      pendingCandidates: [],
      remoteDescSet: false,
      ready: false,
      emuReady: false,
    };

    peer.pc.onicecandidate = function (e) {
      if (e.candidate) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };

    peer.pc.onconnectionstatechange = function () {
      var s = peer.pc.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        console.log('[lockstep-v4] peer', remoteSid, 'connection', s);
        handlePeerDisconnect(remoteSid);
      }
    };

    // Spectators: listen for incoming video tracks from host
    if (_isSpectator || (remoteSlot === 0 && _playerSlot === null)) {
      peer.pc.ontrack = function (event) {
        console.log('[lockstep-v4] received track:', event.track.kind);
        showSpectatorVideo(event, peer);
      };
    }

    _peers[remoteSid] = peer;
    window._peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,
        maxRetransmits: 2,
      });
      setupDataChannel(remoteSid, peer.dc);
    } else {
      peer.pc.ondatachannel = function (e) {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      };
    }
    return peer;
  }

  async function sendOffer(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    var offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer: offer });
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    var senderSid = data.sender;
    if (!senderSid) return;

    // Create peer on demand if offer arrives before users-updated
    if (data.offer && !_peers[senderSid]) {
      var known = _knownPlayers[senderSid];
      createPeer(senderSid, known ? known.slot : null, false);
    }

    var peer = _peers[senderSid];
    if (!peer) return;

    if (data.offer) {
      await peer.pc.setRemoteDescription(data.offer);
      await drainCandidates(peer);
      var answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { target: senderSid, answer: answer });

    } else if (data.answer) {
      await peer.pc.setRemoteDescription(data.answer);
      await drainCandidates(peer);

    } else if (data.candidate) {
      if (peer.remoteDescSet) {
        try { await peer.pc.addIceCandidate(data.candidate); } catch (_) {}
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  }

  async function drainCandidates(peer) {
    peer.remoteDescSet = true;
    for (var i = 0; i < peer.pendingCandidates.length; i++) {
      try { await peer.pc.addIceCandidate(peer.pendingCandidates[i]); } catch (_) {}
    }
    peer.pendingCandidates = [];
  }

  // -- Data channel ----------------------------------------------------------

  function setupDataChannel(remoteSid, ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = function () {
      var peer = _peers[remoteSid];
      if (!peer) return;
      console.log('[lockstep-v4] DC open with', remoteSid, 'slot:', peer.slot);
      peer.ready = true;
      ch.send('ready');

      if (_selfEmuReady) ch.send('emu-ready');

      // Late join: if game is already running, host sends state to new player
      if (_running && _playerSlot === 0 && peer.slot !== null && peer.slot !== undefined) {
        setTimeout(function () { sendLateJoinState(remoteSid); }, 500);
      }

      // Late join: if game is running, host starts spectator stream for new spectator
      if (_running && _playerSlot === 0 && peer.slot === null) {
        startSpectatorStreamForPeer(remoteSid);
      }

      if (!_gameStarted) startGameSequence();
    };

    ch.onclose = function () {
      console.log('[lockstep-v4] DC closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = function (e) {
      console.log('[lockstep-v4] DC error:', remoteSid, e);
    };

    ch.onmessage = function (e) {
      var peer = _peers[remoteSid];
      if (!peer) return;

      // String messages
      if (typeof e.data === 'string') {
        if (e.data === 'ready')     { peer.ready = true; }
        if (e.data === 'emu-ready') { peer.emuReady = true; checkAllEmuReady(); }
        if (e.data === 'lockstep-ready') {
          _lockstepReadyPeers[remoteSid] = true;
          checkAllLockstepReady();
        }
        // State sync: hash check from host
        // IMPORTANT: only compare when we're at the SAME frame as the host.
        // Comparing at different frames always shows a diff (not a real desync).
        if (e.data.substring(0, 10) === 'sync-hash:') {
          var parts = e.data.split(':');
          var syncFrame = parseInt(parts[1], 10);
          var hostHash = parseInt(parts[2], 10);
          if (_frameNum === syncFrame) {
            var localHash = hashGameState();
            if (localHash !== hostHash) {
              console.log('[lockstep-v4] DESYNC at frame', syncFrame,
                'local:', localHash, 'host:', hostHash, '-- requesting state');
              peer.dc.send('sync-request');
            }
          } else if (_frameNum < syncFrame) {
            // We're behind — store for deferred check when we reach that frame
            _pendingSyncCheck = { frame: syncFrame, hash: hostHash, peerSid: sid };
          }
          // If _frameNum > syncFrame, skip — frame already passed
        }
        // State sync: host received request, or chunked binary transfer header
        if (e.data === 'sync-request' && _playerSlot === 0) {
          pushSyncState();
        }
        if (e.data.substring(0, 11) === 'sync-start:') {
          var parts = e.data.split(':');
          _syncFrame = parseInt(parts[1], 10);
          _syncExpected = parseInt(parts[2], 10);
          _syncChunks = [];
        }
        // JSON messages
        if (e.data.charAt(0) === '{') {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveStateMsg(msg);
            if (msg.type === 'late-join-state')  handleLateJoinState(msg);
          } catch (_) {}
        }
        return;
      }

      // Binary: sync state chunk (large) or input (8 bytes)
      if (e.data instanceof ArrayBuffer && e.data.byteLength !== 8) {
        // Sync chunk from host
        _syncChunks.push(new Uint8Array(e.data));
        if (_syncChunks.length >= _syncExpected && _syncExpected > 0) {
          handleSyncChunksComplete();
        }
        return;
      }
      // Binary: Int32Array [frame, inputMask] -- 8 bytes per input
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 8) {
        if (peer.slot === null || peer.slot === undefined) return;  // spectators don't send input
        var arr = new Int32Array(e.data);
        if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
        _remoteInputs[peer.slot][arr[0]] = arr[1];
        _remoteReceived++;
        if (arr[0] > _lastRemoteFrame) _lastRemoteFrame = arr[0];
        if (!_lastRemoteFramePerSlot[peer.slot] || arr[0] > _lastRemoteFramePerSlot[peer.slot]) {
          _lastRemoteFramePerSlot[peer.slot] = arr[0];
        }
      }
    };
  }

  // -- Peer disconnect (drop handling) ---------------------------------------

  function handlePeerDisconnect(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;

    // If the peer was a player, zero their input in Wasm memory
    if (peer.slot !== null && peer.slot !== undefined) {
      try { writeInputToMemory(peer.slot, 0); } catch (_) {}
      delete _remoteInputs[peer.slot];
    }

    delete _peers[remoteSid];
    delete _lockstepReadyPeers[remoteSid];
    window._peers = _peers;
    console.log('[lockstep-v4] peer disconnected:', remoteSid, 'slot:', peer.slot);

    // Check if any active player peers remain
    var remaining = getActivePeers();
    if (remaining.length === 0 && _running) {
      setStatus('All peers disconnected -- running solo');
      // Keep running: single-player mode. The tick loop handles zero active peers
      // gracefully by just stepping frames with local input only.
    } else if (_running) {
      var count = remaining.length + 1;  // +1 for self
      setStatus('Peer left -- ' + count + ' player' + (count > 1 ? 's' : '') + ' remaining');
    }
  }

  // -- Helper: get active player peers ---------------------------------------

  // All connected player peers (for sending input to)
  function getActivePeers() {
    return Object.values(_peers).filter(function (p) {
      return p.slot !== null && p.slot !== undefined
        && p.dc && p.dc.readyState === 'open';
    });
  }

  // Strict input blocking (Kaillera-style): wait for ALL active player
  // peers, not just those who have started sending. The emulator CANNOT
  // advance without every peer's input for the apply frame. This forces
  // network-paced stepping — both sides step at identical rate.
  function getInputPeers() {
    return getActivePeers();
  }

  // -- Game start sequence ---------------------------------------------------

  // Minimum frames the emulator must run before we consider it ready.
  var MIN_BOOT_FRAMES = 120;  // ~2 seconds at 60fps

  function startGameSequence() {
    if (_gameStarted) return;
    _gameStarted = true;

    // Spectators: don't start emulator, don't enter manual mode
    if (_isSpectator) {
      setStatus('Spectating...');
      return;
    }

    setStatus('Starting emulator...');
    triggerEmulatorStart();
    applyStandardCheats();
    setupKeyTracking();
    disableEJSKeyboard();

    // Wait for gameManager AND for the emulator to be ready.
    // Host: waits for MIN_BOOT_FRAMES (needs a fully booted emulator to capture state).
    // Guest: only waits for Module to exist (will load host's state, no independent boot).
    // This prevents boot frame count differences that cause desync.
    var waitForEmu = function () {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(waitForEmu, 100); return; }

      var mod = gm.Module;
      var frames = mod && mod._get_current_frame_count
        ? mod._get_current_frame_count() : 0;

      if (_playerSlot === 0 && frames < MIN_BOOT_FRAMES) {
        // Host: needs full boot to capture a valid state
        setTimeout(waitForEmu, 100);
        return;
      }
      if (_playerSlot !== 0 && frames < 10) {
        // Guest: just needs Module initialized (minimal frames)
        setTimeout(waitForEmu, 100);
        return;
      }

      // Auto-discover INPUT_BASE by calling _simulate_input and detecting the change
      if (mod._simulate_input) {
        try {
          // Reset button 0 for player 0
          mod._simulate_input(0, 0, 0);
          var scanEnd = Math.min(mod.HEAPU8.length, 4 * 1024 * 1024);
          var snap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanEnd));
          mod._simulate_input(0, 0, 1);
          for (var si = 0; si < scanEnd; si++) {
            if (mod.HEAPU8[si] !== snap[si]) {
              INPUT_BASE = si;
              break;
            }
          }
          mod._simulate_input(0, 0, 0);
          console.log('[lockstep-v4] INPUT_BASE auto-discovered: ' + INPUT_BASE);
        } catch (e) {
          console.log('[lockstep-v4] INPUT_BASE auto-discovery failed, using default: ' + INPUT_BASE);
        }
      }

      // Pause immediately to prevent any more free frames
      mod.pauseMainLoop();
      console.log('[lockstep-v4] emulator ready (' + frames + ' frames) — paused' +
        (_playerSlot === 0 ? ' (host, full boot)' : ' (guest, minimal boot)'));
      _selfEmuReady = true;

      // Notify all connected peers
      Object.values(_peers).forEach(function (p) {
        if (p.dc && p.dc.readyState === 'open') {
          try { p.dc.send('emu-ready'); } catch (_) {}
        }
      });

      checkAllEmuReady();
    };
    waitForEmu();
  }

  function checkAllEmuReady() {
    if (!_selfEmuReady) return;
    if (_isSpectator) return;
    if (_running) return;

    // Wait for at least 1 player peer to be emu-ready
    var playerPeers = Object.values(_peers).filter(function (p) {
      return p.slot !== null && p.slot !== undefined;
    });
    var emuReadyCount = playerPeers.filter(function (p) { return p.emuReady; }).length;
    if (emuReadyCount === 0) return;

    console.log('[lockstep-v4] ' + (emuReadyCount + 1) + ' emulators ready -- syncing initial state');
    setStatus('Syncing...');

    if (_playerSlot === 0) {
      // Host: capture and send save state
      sendInitialState();
    }
    // Guests: wait for save state via handleSaveStateMsg
  }

  function checkAllLockstepReady() {
    if (!_selfLockstepReady) return;
    if (_running) return;

    // Check that at least 1 player peer is lockstep-ready
    var playerPeerSids = Object.keys(_peers).filter(function (sid) {
      var p = _peers[sid];
      return p.slot !== null && p.slot !== undefined;
    });
    var readyCount = playerPeerSids.filter(function (sid) {
      return _lockstepReadyPeers[sid];
    }).length;

    if (readyCount === 0) return;

    console.log('[lockstep-v4] ' + (readyCount + 1) + ' players lockstep-ready -- GO');

    // Load the save state. Host also loads its own captured state to reset
    // the WebGL context so the canvas renders correctly.
    var gm = window.EJS_emulator.gameManager;
    if (_guestStateBytes) {
      gm.loadState(_guestStateBytes);
      _guestStateBytes = null;
      console.log('[lockstep-v4] loaded initial state (slot ' + _playerSlot + ')');
    } else {
      // Fallback: self-reset to fix GL context
      console.log('[lockstep-v4] WARNING: no state bytes, doing self-reset');
      var selfState = gm.getState();
      gm.loadState(selfState);
    }

    // Enter manual mode RIGHT BEFORE starting lockstep -- no async gap
    enterManualMode();

    // Both sides reset and start true lockstep sync
    // (Warmup removed — deterministic timing patch makes it unnecessary)
    _frameNum = 0;
    startLockstep();

    // Host: start spectator streaming after lockstep begins
    if (_playerSlot === 0) {
      setTimeout(startSpectatorStream, 1000);
    }
  }

  async function sendInitialState() {
    var gm = window.EJS_emulator.gameManager;
    try {
      var raw = gm.getState();
      var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      // Store for host to also load (resets GL context for proper rendering)
      _guestStateBytes = bytes;
      var compressed = await compressState(bytes);
      var b64 = uint8ToBase64(compressed);
      console.log('[lockstep-v4] sending initial state via Socket.IO (' +
        Math.round(bytes.length / 1024) + 'KB raw -> ' +
        Math.round(compressed.length / 1024) + 'KB gzip)');

      // Send via Socket.IO -- save state is ~1.5MB which crashes WebRTC
      // data channels (SCTP limit with maxRetransmits).
      socket.emit('data-message', { type: 'save-state', frame: 0, data: b64 });

      // Host is ready
      _selfLockstepReady = true;
      Object.values(_peers).forEach(function (p) {
        if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
          try { p.dc.send('lockstep-ready'); } catch (_) {}
        }
      });
      checkAllLockstepReady();
    } catch (err) {
      console.log('[lockstep-v4] failed to send initial state:', err);
    }
  }

  function handleSaveStateMsg(msg) {
    if (_isSpectator) return;
    console.log('[lockstep-v4] received initial state');
    setStatus('Loading initial state...');

    var compressed = base64ToUint8(msg.data);
    decompressState(compressed).then(function (bytes) {
      _guestStateBytes = bytes;
      console.log('[lockstep-v4] initial state decompressed (' + bytes.length + ' bytes)');

      _selfLockstepReady = true;
      Object.values(_peers).forEach(function (p) {
        if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
          try { p.dc.send('lockstep-ready'); } catch (_) {}
        }
      });
      checkAllLockstepReady();
    }).catch(function (err) {
      console.log('[lockstep-v4] failed to decompress initial state:', err);
    });
  }

  // -- Late join -------------------------------------------------------------

  async function sendLateJoinState(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    if (peer.slot === null || peer.slot === undefined) return;

    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;

    try {
      var raw = gm.getState();
      var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      var compressed = await compressState(bytes);
      var b64 = uint8ToBase64(compressed);
      console.log('[lockstep-v4] sending late-join state to', remoteSid,
        '(' + Math.round(bytes.length / 1024) + 'KB raw -> ' +
        Math.round(compressed.length / 1024) + 'KB gzip)',
        'frame:', _frameNum);

      // Send via Socket.IO since save states are too large for DC
      socket.emit('data-message', {
        type: 'late-join-state',
        frame: _frameNum,
        data: b64,
      });
    } catch (err) {
      console.log('[lockstep-v4] failed to send late-join state:', err);
    }
  }

  function handleLateJoinState(msg) {
    if (_isSpectator) return;
    if (_running) return;  // already running, ignore duplicate

    console.log('[lockstep-v4] received late-join state for frame', msg.frame);
    setStatus('Loading late-join state...');

    var compressed = base64ToUint8(msg.data);
    decompressState(compressed).then(function (bytes) {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) {
        console.log('[lockstep-v4] gameManager not ready');
        return;
      }

      gm.loadState(bytes);
      enterManualMode();
      _frameNum = _lastRemoteFrame > msg.frame ? _lastRemoteFrame : msg.frame;
      console.log('[lockstep-v4] late-join state loaded, starting at frame', _frameNum);
      startLockstep();
    }).catch(function (err) {
      console.log('[lockstep-v4] failed to handle state:', err);
    });
  }

  // -- Guest audio muting + host audio streaming ----------------------------

  // -- Spectator canvas streaming --------------------------------------------

  function startSpectatorStream() {
    if (_playerSlot !== 0) return;

    var canvas = document.querySelector('#game canvas');
    if (!canvas) {
      console.log('[lockstep-v4] canvas not found for spectator stream');
      return;
    }

    // Create a smaller capture canvas for efficiency (same as streaming prototype)
    var captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    var ctx = captureCanvas.getContext('2d');

    _hostStream = captureCanvas.captureStream(0);  // manual frame control
    var captureTrack = _hostStream.getVideoTracks()[0];

    // Blit loop: copy emulator canvas to capture canvas every frame
    function blitFrame() {
      _origRAF.call(window, blitFrame);
      ctx.drawImage(canvas, 0, 0, 640, 480);
      if (captureTrack.requestFrame) captureTrack.requestFrame();
    }
    blitFrame();

    console.log('[lockstep-v4] spectator capture stream started (640x480)');

    // Add tracks to all existing spectator peer connections
    Object.entries(_peers).forEach(function (entry) {
      var sid = entry[0];
      var peer = entry[1];
      if (peer.slot === null) {
        addStreamToPeer(sid);
      }
    });
  }

  function startSpectatorStreamForPeer(remoteSid) {
    if (!_hostStream) {
      // Stream not started yet -- it will be started after lockstep begins
      // and will pick up this peer then
      return;
    }
    addStreamToPeer(remoteSid);
  }

  function addStreamToPeer(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer || !_hostStream) return;

    _hostStream.getTracks().forEach(function (track) {
      peer.pc.addTrack(track, _hostStream);
    });
    renegotiate(remoteSid);
  }

  async function renegotiate(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    try {
      var offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { target: remoteSid, offer: offer });
    } catch (err) {
      console.log('[lockstep-v4] renegotiate failed:', err);
    }
  }

  function showSpectatorVideo(event, peer) {
    if (!_guestVideo) {
      _guestVideo = document.createElement('video');
      _guestVideo.id = 'guest-video';
      _guestVideo.autoplay = true;
      _guestVideo.playsInline = true;
      _guestVideo.muted = false;
      _guestVideo.disableRemotePlayback = true;
      _guestVideo.setAttribute('playsinline', '');

      var gameDiv = (_config && _config.gameElement) || document.getElementById('game');
      if (gameDiv) {
        gameDiv.innerHTML = '';
        gameDiv.appendChild(_guestVideo);
      } else {
        document.body.appendChild(_guestVideo);
      }
    }
    _guestVideo.srcObject = event.streams[0];

    // Minimize jitter buffer for low latency
    try {
      var receivers = peer.pc.getReceivers();
      for (var i = 0; i < receivers.length; i++) {
        var recv = receivers[i];
        if (recv.track && recv.track.kind === 'video') {
          if ('playoutDelayHint' in recv) recv.playoutDelayHint = 0;
          if ('jitterBufferTarget' in recv) recv.jitterBufferTarget = 0;
        }
      }
    } catch (_) {}

    setStatus('Spectating...');
  }

  // -- Direct memory input ---------------------------------------------------

  function writeInputToMemory(player, inputMask) {
    var buf = window.EJS_emulator.gameManager.Module.HEAPU8.buffer;
    var dv = new DataView(buf);

    // Digital buttons (0-15): write 0 or 1 as int32
    for (var btn = 0; btn < 16; btn++) {
      var addr = INPUT_BASE + (btn * BUTTON_STRIDE) + (player * PLAYER_STRIDE);
      dv.setInt32(addr, (inputMask >> btn) & 1, true);
    }

    // Analog axes (16+): buttons come in +/- pairs (16/17, 18/19, ...)
    // Each pair maps to an axis. If + is pressed, value = 32767.
    // If - is pressed, value = -32767. Both or neither = 0.
    for (var base = 16; base < 20; base += 2) {
      var posPressed = (inputMask >> base) & 1;
      var negPressed = (inputMask >> (base + 1)) & 1;
      var axisVal = (posPressed - negPressed) * 32767;
      var addrPos = INPUT_BASE + (base * BUTTON_STRIDE) + (player * PLAYER_STRIDE);
      var addrNeg = INPUT_BASE + ((base + 1) * BUTTON_STRIDE) + (player * PLAYER_STRIDE);
      dv.setInt32(addrPos, axisVal, true);
      dv.setInt32(addrNeg, 0, true);
    }
  }

  // -- Frame stepping (rAF interception) -------------------------------------

  function enterManualMode() {
    if (_manualMode) return;
    if (_isSpectator) return;  // spectators never enter manual mode

    var mod = window.EJS_emulator.gameManager.Module;

    // Save the real requestAnimationFrame
    _origRAF = window.requestAnimationFrame;

    // Pause first to invalidate stale runners
    mod.pauseMainLoop();

    // Replace rAF with interceptor that captures the runner
    window.requestAnimationFrame = function (cb) {
      _pendingRunner = cb;
      return -999;
    };

    // Resume to capture fresh runner
    mod.resumeMainLoop();

    _manualMode = true;
    console.log('[lockstep-v4] entered manual mode');
  }

  var _hasForkedCore = false;  // true if Module exports kn_set_deterministic

  function stepOneFrame() {
    if (!_pendingRunner) return false;
    var runner = _pendingRunner;
    _pendingRunner = null;

    var frameTimeMs = (_frameNum + 1) * 16.666666666666668;

    // Update deterministic frame time and reset call counter.
    // _emscripten_get_now returns frameTime + (callCount * 0.01ms).
    // Both emulators execute the same WASM, so callCount matches.
    window._kn_frameTime = frameTimeMs;
    window._kn_callCount = 0;

    // C-level: always update frame time (kn_deterministic_mode stays ON)
    if (_hasForkedCore) {
      var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                window.EJS_emulator.gameManager.Module;
      if (mod && mod._kn_set_frame_time) {
        mod._kn_set_frame_time(frameTimeMs);
      }
    }

    runner(frameTimeMs);

    // Force GL composite via real rAF no-op
    _origRAF.call(window, function () {});
    return true;
  }

  // -- True lockstep tick loop -----------------------------------------------
  //
  // Strategy: setInterval(tick, 16) for ~60fps. We never use rAF for the
  // game loop (background tabs would throttle it). Each tick:
  //   1. Send local input for current frame to ALL peers
  //   2. Check if ALL active player peers have input for the apply frame
  //   3. If not, stall (return early, retry via setTimeout(1))
  //   4. Write ALL players' inputs to Wasm memory
  //   5. Step exactly one frame
  //   6. Increment frame counter

  // FPS + debug tracking
  var _fpsLastTime     = 0;
  var _fpsFrameCount   = 0;
  var _fpsCurrent      = 0;
  var _remoteReceived  = 0;
  var _remoteMissed    = 0;
  var _remoteApplied   = 0;
  var _lastRemoteFrame = -1;
  var _lastRemoteFramePerSlot = {};  // slot -> highest frame received from that peer
  var _stallRetryPending = false;

  function startLockstep() {
    if (_running) return;
    _running = true;

    // Detect forked core with C-level deterministic timing exports
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    _hasForkedCore = !!(mod && mod._kn_set_deterministic && mod._kn_set_frame_time);
    if (_hasForkedCore) {
      console.log('[lockstep-v4] forked core detected — C-level deterministic timing');
    } else {
      console.log('[lockstep-v4] stock core — JS-level timing patch (fallback)');
    }

    // Only reset frame counter if not a late join (late join sets _frameNum before calling)
    if (_frameNum === 0) {
      _localInputs = {};
      _remoteInputs = {};
    }
    _fpsLastTime = performance.now();
    _fpsFrameCount = 0;
    _fpsCurrent = 0;
    _remoteReceived = 0;
    _remoteMissed = 0;
    _remoteApplied = 0;
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _stallStart = 0;
    window._netplayFrameLog = [];

    // _kn_inStep always ON: _emscripten_get_now returns N64 CPU cycle
    // counter (deterministic) instead of performance.now(). Audio still
    // works because cycle time advances with each CPU instruction.
    window._kn_inStep = true;
    window._kn_frameTime = 0;
    if (_hasForkedCore) {
      var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                window.EJS_emulator.gameManager.Module;
      if (mod && mod._kn_set_deterministic) {
        mod._kn_set_deterministic(1);
        console.log('[lockstep-v4] C-level deterministic timing enabled (session-wide)');
      }
    }

    var activePeers = getActivePeers();
    var peerSlots = activePeers.map(function (p) { return p.slot; });
    console.log('[lockstep-v4] lockstep started -- slot:', _playerSlot,
      'peerSlots:', peerSlots.join(','), 'delay:', DELAY_FRAMES);
    setStatus('Connected -- game on!');

    window._lockstepActive = true;

    // Use setInterval so background tabs are not throttled
    _tickInterval = setInterval(tick, 16);
  }

  function stopSync() {
    _running = false;
    window._lockstepActive = false;

    // Disable all deterministic timing
    window._kn_inStep = false;
    window._kn_frameTime = 0;
    if (_hasForkedCore) {
      var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                window.EJS_emulator.gameManager.Module;
      if (mod && mod._kn_set_deterministic) mod._kn_set_deterministic(0);
    }
    if (_tickInterval !== null) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
    // Restore original rAF if we intercepted it
    if (_origRAF) {
      window.requestAnimationFrame = _origRAF;
      _origRAF = null;
    }
    _manualMode = false;
    _pendingRunner = null;
    _pendingSyncCheck = null;
  }

  function tick() {
    if (!_running) return;

    var activePeers = getActivePeers();

    // FPS counter
    _fpsFrameCount++;
    var now = performance.now();
    if (now - _fpsLastTime >= 1000) {
      _fpsCurrent = _fpsFrameCount;
      _fpsFrameCount = 0;
      _fpsLastTime = now;
    }

    // Send local input for current frame to ALL open peer DCs
    var mask = readLocalInput();
    _localInputs[_frameNum] = mask;
    var buf = new Int32Array([_frameNum, mask]).buffer;
    for (var i = 0; i < activePeers.length; i++) {
      try { activePeers[i].dc.send(buf); } catch (_) {}
    }

    // Check if all INPUT peers (peers who have sent at least 1 input)
    // have input for the apply frame. Late joiners who haven't started
    // sending yet won't stall existing players.
    var inputPeers = getInputPeers();
    var applyFrame = _frameNum - DELAY_FRAMES;
    if (applyFrame >= 0) {
      var allArrived = true;
      for (var j = 0; j < inputPeers.length; j++) {
        var pSlot = inputPeers[j].slot;
        if (!_remoteInputs[pSlot] || _remoteInputs[pSlot][applyFrame] === undefined) {
          allArrived = false;
          break;
        }
      }

      if (!allArrived) {
        // STALL -- remote input not here yet
        if (_stallStart === 0) {
          _stallStart = now;
        }
        if (now - _stallStart >= MAX_STALL_MS) {
          // Timeout -- inject zero input for missing peers to unstick
          console.log('[lockstep-v4] stall timeout at frame', applyFrame,
            '(' + MAX_STALL_MS + 'ms)');
          for (var k = 0; k < inputPeers.length; k++) {
            var s = inputPeers[k].slot;
            if (!_remoteInputs[s]) _remoteInputs[s] = {};
            if (_remoteInputs[s][applyFrame] === undefined) {
              _remoteInputs[s][applyFrame] = 0;
            }
          }
          _stallStart = 0;
        } else {
          _remoteMissed++;
          // Retry quickly via setTimeout(1) to avoid 16ms wait
          if (!_stallRetryPending) {
            _stallRetryPending = true;
            setTimeout(function () {
              _stallRetryPending = false;
              tick();
            }, 1);
          }
          return;
        }
      } else {
        _stallStart = 0;
      }

      // Write ALL inputs to Wasm memory — use inputPeers for peers
      // we're synced with, activePeers for all connected
      writeInputToMemory(_playerSlot, _localInputs[applyFrame] || 0);
      for (var m = 0; m < inputPeers.length; m++) {
        var peerSlot = inputPeers[m].slot;
        var remoteMask = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || 0;
        writeInputToMemory(peerSlot, remoteMask);
        if (_remoteInputs[peerSlot]) delete _remoteInputs[peerSlot][applyFrame];
      }
      _remoteApplied++;

      // Cleanup old local entry
      delete _localInputs[applyFrame];
    }

    // Step one frame
    stepOneFrame();

    _frameNum++;
    window._frameNum = _frameNum;

    // Deferred sync check: guest was behind when sync-hash arrived, now caught up
    if (_pendingSyncCheck && _frameNum === _pendingSyncCheck.frame) {
      var localHash = hashGameState();
      if (localHash !== _pendingSyncCheck.hash) {
        console.log('[lockstep-v4] DESYNC (deferred) at frame', _pendingSyncCheck.frame);
        var syncPeer = _peers[_pendingSyncCheck.peerSid];
        if (syncPeer && syncPeer.dc) {
          try { syncPeer.dc.send('sync-request'); } catch (_) {}
        }
      }
      _pendingSyncCheck = null;
    } else if (_pendingSyncCheck && _frameNum > _pendingSyncCheck.frame) {
      // Passed the frame — discard stale check
      _pendingSyncCheck = null;
    }

    // -- Periodic desync check: host hashes game state (first 64KB), broadcasts hash.
    // With the forked core's deterministic timing, desyncs should not occur.
    // This serves as a safety net for edge cases or fallback to stock core.
    if (_syncEnabled && _playerSlot === 0 && _frameNum > 0 &&
        _frameNum % _syncCheckInterval === 0) {
      var hostHash = hashGameState();
      var syncMsg = 'sync-hash:' + _frameNum + ':' + hostHash;
      var ap = getActivePeers();
      for (var s = 0; s < ap.length; s++) {
        try { ap[s].dc.send(syncMsg); } catch (_) {}
      }
      // Log every 10th check (~50 seconds)
      if (_frameNum % (_syncCheckInterval * 10) === 0) {
        console.log('[lockstep-v4] sync check at frame', _frameNum, 'hash:', hostHash);
      }
    }

    // Debug overlay -- update every 15 frames (~4x per second)
    if (_frameNum % 15 === 0) {
      var dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        var playerCount = activePeers.length + 1;  // +1 for self
        var spectatorCount = Object.values(_peers).filter(function (p) {
          return p.slot === null;
        }).length;
        var remoteBufTotal = 0;
        Object.keys(_remoteInputs).forEach(function (slot) {
          remoteBufTotal += Object.keys(_remoteInputs[slot] || {}).length;
        });
        dbg.textContent =
          'F:' + _frameNum +
          ' fps:' + _fpsCurrent +
          ' slot:' + _playerSlot +
          ' players:' + playerCount +
          (spectatorCount > 0 ? ' spec:' + spectatorCount : '') +
          ' delay:' + DELAY_FRAMES +
          ' rBuf:' + remoteBufTotal +
          ' rcv:' + _remoteReceived +
          ' hit:' + _remoteApplied +
          ' miss:' + _remoteMissed +
          ' lastR:' + _lastRemoteFrame;
      }
    }
  }

  // -- Input read ------------------------------------------------------------

  function readLocalInput() {
    var mask = 0;

    // Gamepad
    var gp = navigator.getGamepads()[0];
    if (gp) {
      for (var i = 0; i < Math.min(gp.buttons.length, 32); i++) {
        if (gp.buttons[i].pressed) mask |= (1 << i);
      }
    }

    // Keyboard
    if (_p1KeyMap) {
      _heldKeys.forEach(function (kc) {
        var btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }

    return mask;
  }

  // -- Compression helpers ---------------------------------------------------

  async function compressState(bytes) {
    var cs = new CompressionStream('gzip');
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    while (true) {
      var result = await reader.read();
      if (result.value) chunks.push(result.value);
      if (result.done) break;
    }
    var out = new Uint8Array(chunks.reduce(function (a, c) { return a + c.length; }, 0));
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  async function decompressState(bytes) {
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = ds.readable.getReader();
    var chunks = [];
    while (true) {
      var result = await reader.read();
      if (result.value) chunks.push(result.value);
      if (result.done) break;
    }
    var out = new Uint8Array(chunks.reduce(function (a, c) { return a + c.length; }, 0));
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  function uint8ToBase64(bytes) {
    var chunkSize = 32768;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // -- Cheats ----------------------------------------------------------------

  function applyStandardCheats() {
    var attempt = function () {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(attempt, 500); return; }
      try {
        SSB64_ONLINE_CHEATS.forEach(function (c, i) { gm.setCheat(i, 1, c.code); });
        console.log('[lockstep-v4] applied', SSB64_ONLINE_CHEATS.length, 'standard cheats');
      } catch (_) { setTimeout(attempt, 500); return; }
      setTimeout(function () {
        try { SSB64_ONLINE_CHEATS.forEach(function (c, i) { gm.setCheat(i, 1, c.code); }); } catch (_) {}
      }, 2000);
      setTimeout(function () {
        try { SSB64_ONLINE_CHEATS.forEach(function (c, i) { gm.setCheat(i, 1, c.code); }); } catch (_) {}
      }, 5000);
    };
    attempt();
  }

  // -- Keyboard / input setup ------------------------------------------------

  function setupKeyTracking() {
    if (_p1KeyMap) return;

    var ejs = window.EJS_emulator;
    if (ejs && ejs.controls && ejs.controls[0]) {
      _p1KeyMap = {};
      Object.entries(ejs.controls[0]).forEach(function (entry) {
        var btnIdx = entry[0];
        var binding = entry[1];
        var kc = binding && binding.value;
        if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
      });
    }

    if (!_p1KeyMap || Object.keys(_p1KeyMap).length === 0) {
      _p1KeyMap = Object.assign({}, DEFAULT_N64_KEYMAP);
    }

    if (!setupKeyTracking._listenersAdded) {
      document.addEventListener('keydown', function (e) { _heldKeys.add(e['keyCode']); }, true);
      document.addEventListener('keyup',   function (e) { _heldKeys.delete(e['keyCode']); }, true);
      setupKeyTracking._listenersAdded = true;
    }
  }

  function disableEJSKeyboard() {
    var attempt = function () {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(attempt, 200); return; }
      gm.setKeyboardEnabled(false);
      var ejs = window.EJS_emulator;
      var parent = ejs.elements && ejs.elements.parent;
      if (parent) {
        var block = function (e) { e.stopImmediatePropagation(); };
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup',   block, true);
      }
    };
    attempt();
  }

  // -- Emulator start --------------------------------------------------------

  function triggerEmulatorStart() {
    var attempt = function () {
      var btn = document.querySelector('.ejs_start_button');
      if (btn) { btn.click(); return; }
      var ejs = window.EJS_emulator;
      if (ejs && typeof ejs.startButtonClicked === 'function') {
        ejs.startButtonClicked(); return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  }

  function hashGameState() {
    // Hash first _syncHashBytes of save state (game state only, excludes audio buffers).
    // getState() costs ~3ms; hashing 64KB is negligible. Called every ~5s.
    try {
      var gm = window.EJS_emulator.gameManager;
      var state = gm.getState();
      var bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
      var hash = 0x811c9dc5;
      var len = Math.min(bytes.length, _syncHashBytes);
      for (var i = 0; i < len; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
      }
      return hash | 0;
    } catch (e) {
      return 0;
    }
  }

  // -- Worker-based state sync -----------------------------------------------

  function initSyncWorker() {
    if (_syncWorker) return;
    _syncWorker = new Worker('/static/sync-worker.js');
    _syncWorker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'compressed') {
        // Host: compressed state ready, send via DC in chunks
        sendSyncChunks(msg.data, msg.frame);
      }
      if (msg.type === 'decompressed') {
        // Guest: decompressed state ready, load it
        applySyncState(msg.data, msg.frame);
      }
    };
  }

  function pushSyncState() {
    // Host: capture state and send to Worker for compression (3ms main thread)
    if (_playerSlot !== 0 || !_syncEnabled) return;
    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    var raw = gm.getState();
    var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    initSyncWorker();
    _syncWorker.postMessage({ type: 'compress', data: bytes, frame: _frameNum }, [bytes.buffer]);
  }

  function sendSyncChunks(compressed, frame) {
    // Host: send compressed state via DC to all player peers in 64KB chunks
    var CHUNK_SIZE = 64000;
    var numChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    var activePeers = getActivePeers();

    for (var p = 0; p < activePeers.length; p++) {
      var dc = activePeers[p].dc;
      if (!dc || dc.readyState !== 'open') continue;
      try {
        dc.send('sync-start:' + frame + ':' + numChunks);
        for (var i = 0; i < numChunks; i++) {
          var start = i * CHUNK_SIZE;
          var end = Math.min(start + CHUNK_SIZE, compressed.length);
          // .slice() creates an independent copy — .subarray().buffer would
          // send the entire underlying ArrayBuffer
          dc.send(compressed.slice(start, end));
        }
      } catch (err) {
        console.log('[lockstep-v4] sync send failed:', err);
      }
    }
    console.log('[lockstep-v4] pushed state frame', frame,
      '(' + Math.round(compressed.length / 1024) + 'KB,', numChunks, 'chunks)');
  }

  function handleSyncChunksComplete() {
    // Guest: reassemble chunks and send to Worker for decompression
    var total = _syncChunks.reduce(function (a, c) { return a + c.length; }, 0);
    var assembled = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < _syncChunks.length; i++) {
      assembled.set(_syncChunks[i], offset);
      offset += _syncChunks[i].length;
    }
    _syncChunks = [];
    _syncExpected = 0;
    initSyncWorker();
    _syncWorker.postMessage(
      { type: 'decompress', data: assembled, frame: _syncFrame },
      [assembled.buffer]
    );
  }

  function applySyncState(bytes, frame) {
    // Guest: hot-swap state without stopping the tick loop.
    // The tick loop keeps running — we just replace the emulator state underneath it.
    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;

    gm.loadState(bytes);

    // Re-capture rAF runner (loadState may invalidate _pendingRunner)
    var mod = gm.Module;
    mod.pauseMainLoop();
    mod.resumeMainLoop();

    _frameNum = frame;
    window._frameNum = _frameNum;

    // Fill any gaps in input buffers around the new frame so we don't stall.
    // Don't clear the whole buffer — keep existing inputs that are still valid.
    var pKeys = Object.keys(_peers);
    for (var pk = 0; pk < pKeys.length; pk++) {
      var pSlot = _peers[pKeys[pk]].slot;
      if (pSlot !== null && pSlot !== undefined) {
        if (!_remoteInputs[pSlot]) _remoteInputs[pSlot] = {};
        for (var gf = frame - DELAY_FRAMES - 5; gf <= frame + 5; gf++) {
          if (_remoteInputs[pSlot][gf] === undefined) _remoteInputs[pSlot][gf] = 0;
        }
        _lastRemoteFramePerSlot[pSlot] = Math.max(
          _lastRemoteFramePerSlot[pSlot] || 0, frame
        );
      }
    }
    for (var lf = frame - DELAY_FRAMES - 5; lf <= frame + 5; lf++) {
      if (_localInputs[lf] === undefined) _localInputs[lf] = 0;
    }

    _resyncCount++;
    if (_resyncCount <= 3 || _resyncCount % 10 === 0) {
      console.log('[lockstep-v4] sync #' + _resyncCount + ' applied at frame', frame);
    }
  }

  // -- (old desync detection helpers removed — replaced by Worker-based sync) --


  // -- Init / Stop API -------------------------------------------------------

  var _config = null;

  function init(config) {
    _config = config;
    socket = config.socket;
    sessionId = config.sessionId;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    // Apply pre-game options
    _audioEnabled = config.audioEnabled !== false;  // default: true
    _syncEnabled = !!config.rollbackEnabled;        // default: false

    window._playerSlot = _playerSlot;
    window._isSpectator = _isSpectator;

    // Register socket listeners
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);
    socket.on('data-message', onDataMessage);

    // Process current peers immediately
    if (config.initialPlayers) {
      onUsersUpdated(config.initialPlayers);
    }
    // startGameSequence() is triggered from ch.onopen (same as before)
  }

  function stop() {
    // Stop lockstep tick loop
    stopSync();

    // Close all peer connections
    Object.keys(_peers).forEach(function (sid) {
      var p = _peers[sid];
      if (p.dc) try { p.dc.close(); } catch (_) {}
      if (p.pc) try { p.pc.close(); } catch (_) {}
    });
    _peers = {};
    window._peers = _peers;

    // Reset lockstep state
    _remoteInputs = {};
    _localInputs = {};
    _frameNum = 0;
    window._frameNum = 0;
    _running = false;
    _gameStarted = false;
    _selfEmuReady = false;
    _selfLockstepReady = false;
    _lockstepReadyPeers = {};
    _guestStateBytes = null;
    _knownPlayers = {};
    _expectedPeerCount = 0;
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _resyncCount = 0;
    _syncChunks = [];
    _syncExpected = 0;
    if (_syncWorker) { _syncWorker.terminate(); _syncWorker = null; }

    // Clean up spectator stream
    if (_hostStream) {
      _hostStream.getTracks().forEach(function (t) { t.stop(); });
      _hostStream = null;
    }
    if (_guestVideo) {
      _guestVideo.srcObject = null;
      if (_guestVideo.parentNode) _guestVideo.parentNode.removeChild(_guestVideo);
      _guestVideo = null;
    }

    // Remove socket listeners
    if (socket) {
      socket.off('users-updated', onUsersUpdated);
      socket.off('webrtc-signal', onWebRTCSignal);
      socket.off('data-message', onDataMessage);
    }

    _config = null;
  }

  window.NetplayLockstepV4 = {
    init: init,
    stop: stop,
    setSyncEnabled: function (on) { _syncEnabled = !!on; },
    isSyncEnabled: function () { return _syncEnabled; },
    setSyncInterval: function (frames) { _syncCheckInterval = Math.max(30, frames); },
    isAudioEnabled: function () { return _audioEnabled; },
  };

})();
