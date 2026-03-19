/**
 * kaillera-next — Prototype C v3: Free-Running Input Sync
 *
 * Both emulators run freely at native 60fps. No pausing, no rAF interception.
 * Input exchanged each frame with delay buffer.
 *
 * Each peer reads local input, sends it over WebRTC, and applies inputs
 * (local + remote) with a configurable frame delay. If remote input hasn't
 * arrived yet, the last known remote input is repeated (prediction).
 *
 * Topology: mesh. Host (slot 0) + guest (slot 1). 2-player only.
 */

(function () {
  'use strict';

  const GAME_ID     = 'ssb64';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Input delay in frames — both peers buffer this many frames of input
  // before applying. Hides network latency: peer has DELAY_FRAMES worth
  // of time to deliver their input before we need it.
  const DELAY_FRAMES = 3;

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

  // Default N64 keymap (EJS defaults) — fallback when EJS controls unavailable
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

  // ── State ─────────────────────────────────────────────────────────────────

  let socket             = null;
  let sessionId          = null;
  let _playerSlot        = -1;     // 0 = host, 1 = guest
  let _peers             = {};     // remoteSid -> PeerState
  let _knownPlayers      = {};
  let _gameStarted       = false;
  let _selfEmuReady      = false;
  let _p1KeyMap          = null;
  let _heldKeys          = new Set();
  let _prevSlotMasks     = {};     // slot -> previous mask (for change detection)

  // Lockstep state
  let _peerLockstepReady = false;  // true when peer signals lockstep-ready
  let _frameNum          = 0;      // current logical frame number
  let _localInputs       = {};     // frame -> inputMask
  let _remoteInputs      = {};     // frame -> inputMask
  let _peerSlot          = -1;     // the other player's slot
  let _running           = false;  // tick loop active
  let _lastRemoteMask    = 0;      // last known remote input for prediction

  // Expose for Playwright
  window._playerSlot  = _playerSlot;
  window._peers       = _peers;
  window._frameNum    = 0;

  // ── UI ─────────────────────────────────────────────────────────────────

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #np { position:fixed; top:12px; right:12px; z-index:9999;
            background:#151520; border:1px solid #2a2a40; border-radius:8px;
            padding:12px 14px; min-width:210px; font:13px/1.5 sans-serif;
            color:#ccc; box-shadow:0 4px 16px rgba(0,0,0,.5); }
      #np h3 { margin:0 0 10px; font-size:12px; letter-spacing:.08em;
               text-transform:uppercase; color:#666; }
      #np input { display:block; width:100%; padding:5px 8px; margin-bottom:6px;
                  background:#0d0d1a; border:1px solid #333; border-radius:4px;
                  color:#eee; font-size:12px; box-sizing:border-box; }
      #np input:focus { outline:none; border-color:#4a6fa5; }
      #np .row { display:flex; gap:6px; margin-bottom:6px; }
      #np .row input { margin:0; flex:1; }
      #np button { padding:5px 10px; border:none; border-radius:4px;
                   background:#3a5a8a; color:#fff; font-size:12px;
                   cursor:pointer; white-space:nowrap; }
      #np button:hover { background:#4a6fa5; }
      #np button:disabled { background:#2a2a40; color:#555; cursor:default; }
      #np-status { font-size:11px; color:#777; margin-top:6px; min-height:14px; }
      #np-debug { font-size:10px; color:#555; font-family:monospace; margin-top:4px; }
      #np-code-display { font-size:16px; font-weight:bold; letter-spacing:.15em;
                         color:#6af; text-align:center; padding:4px 0 2px; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'np';
    panel.innerHTML = `
      <h3>Netplay (Lockstep v3)</h3>
      <div style="font-size:10px; margin-bottom:8px; color:#555;">
        <a href="?mode=streaming" style="color:#6af; text-decoration:none;">Streaming</a> |
        <a href="?mode=lockstep" style="color:#6af; text-decoration:none;">Lockstep v1</a>
      </div>
      <input id="np-name" placeholder="Your name" value="Player">
      <button id="np-create">Create Room</button>
      <div id="np-code-display" style="display:none"></div>
      <div class="row" style="margin-top:6px">
        <input id="np-join-code" placeholder="Room code">
        <button id="np-join">Join</button>
      </div>
      <div id="np-status">Connecting to server...</div>
      <div id="np-debug" style="display:none"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('np-create').onclick = createRoom;
    document.getElementById('np-join').onclick   = joinRoom;
  }

  function setStatus(msg) {
    const el = document.getElementById('np-status');
    if (el) el.textContent = msg;
    console.log('[lockstep-v3]', msg);
  }

  function setCode(code) {
    const el = document.getElementById('np-code-display');
    if (!el) return;
    el.textContent = code;
    el.style.display = code ? '' : 'none';
    const input = document.getElementById('np-join-code');
    if (input) input.value = code;
  }

  function disableButtons() {
    ['np-create', 'np-join'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  }

  // ── Socket.IO ──────────────────────────────────────────────────────────

  function loadSocketIO(cb) {
    const s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function connectSocket() {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
    socket.on('connect',       () => { if (!_gameStarted) setStatus('Ready'); });
    socket.on('connect_error', (e) => setStatus('Server error: ' + e.message));
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);
    socket.on('data-message',  onDataMessage);
  }

  function onDataMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'save-state') handleSaveStateMsg(msg);
  }

  // ── Room management ────────────────────────────────────────────────────

  function createRoom() {
    const name = document.getElementById('np-name').value.trim() || 'Player';
    sessionId   = randomCode();
    _playerSlot = 0;
    window._playerSlot = 0;

    socket.emit('open-room', {
      extra: {
        sessionid: sessionId, userid: socket.id, playerId: socket.id,
        room_name: name + "'s room", game_id: GAME_ID,
        player_name: name, room_password: null,
        domain: window.location.hostname,
      },
      maxPlayers: 2, password: null,
    }, (err) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();
      setCode(sessionId);
      setStatus('Waiting for player 2...');
    });
  }

  function joinRoom() {
    const name = document.getElementById('np-name').value.trim() || 'Player';
    const code = document.getElementById('np-join-code').value.trim().toUpperCase();
    if (!code) { setStatus('Enter a room code'); return; }

    sessionId = code;

    socket.emit('join-room', {
      extra: { sessionid: sessionId, userid: socket.id, player_name: name, spectate: false },
      password: null,
    }, (err, data) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();
      if (data && data.players) {
        const myEntry = Object.values(data.players).find(p => p.socketId === socket.id);
        if (myEntry) { _playerSlot = myEntry.slot; window._playerSlot = _playerSlot; }
      }
      setStatus('Joined -- connecting...');
    });
  }

  // ── users-updated ──────────────────────────────────────────────────────

  function onUsersUpdated(data) {
    const players = data.players || {};

    _knownPlayers = {};
    Object.values(players).forEach(p => {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    });

    const myEntry = Object.values(players).find(p => p.socketId === socket.id);
    if (myEntry) { _playerSlot = myEntry.slot; window._playerSlot = _playerSlot; }

    // Connect to the other player
    const others = Object.values(players).filter(p => p.socketId !== socket.id);
    for (const p of others) {
      if (_peers[p.socketId]) { _peers[p.socketId].slot = p.slot; continue; }
      _peerSlot = p.slot;
      const shouldInitiate = _playerSlot < p.slot;
      createPeer(p.socketId, p.slot, shouldInitiate);
      if (shouldInitiate) sendOffer(p.socketId);
    }
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────

  function createPeer(remoteSid, remoteSlot, isInitiator) {
    const peer = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      dc: null,
      slot: remoteSlot,
      pendingCandidates: [],
      remoteDescSet: false,
      ready: false,
      emuReady: false,
    };

    peer.pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        console.log('[lockstep-v3] peer', remoteSid, 'connection', s);
        handlePeerDisconnect(remoteSid);
      }
    };

    _peers[remoteSid] = peer;
    window._peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,  // ordered — input order matters
        maxRetransmits: 2,
      });
      setupDataChannel(remoteSid, peer.dc);
    } else {
      peer.pc.ondatachannel = (e) => {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      };
    }
    return peer;
  }

  async function sendOffer(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer });
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    const senderSid = data.sender;
    if (!senderSid) return;

    if (data.offer && !_peers[senderSid]) {
      const known = _knownPlayers[senderSid];
      createPeer(senderSid, known ? known.slot : 1, false);
    }

    const peer = _peers[senderSid];
    if (!peer) return;

    if (data.offer) {
      await peer.pc.setRemoteDescription(data.offer);
      await drainCandidates(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { target: senderSid, answer });
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
    for (const c of peer.pendingCandidates) {
      try { await peer.pc.addIceCandidate(c); } catch (_) {}
    }
    peer.pendingCandidates = [];
  }

  // ── Data channel ───────────────────────────────────────────────────────

  function setupDataChannel(remoteSid, ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      const peer = _peers[remoteSid];
      if (!peer) return;
      console.log('[lockstep-v3] DC open with', remoteSid, 'slot:', peer.slot);
      peer.ready = true;
      ch.send('ready');

      if (_selfEmuReady) ch.send('emu-ready');

      if (!_gameStarted) startGameSequence();
    };

    ch.onclose = () => {
      console.log('[lockstep-v3] DC closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => console.log('[lockstep-v3] DC error:', remoteSid, e);

    ch.onmessage = (e) => {
      const peer = _peers[remoteSid];
      if (!peer) return;

      if (typeof e.data === 'string') {
        if (e.data === 'ready')          { peer.ready = true; }
        if (e.data === 'emu-ready')      { peer.emuReady = true; checkBothEmuReady(); }
        if (e.data === 'lockstep-ready') { _peerLockstepReady = true; checkBothLockstepReady(); }
        // JSON messages (save-state sent via DC)
        if (e.data.charAt(0) === '{') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'save-state') handleSaveStateMsg(msg);
          } catch (_) {}
        }
        return;
      }

      // Binary: Int32Array [frame, inputMask]
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 8) {
        const arr = new Int32Array(e.data);
        _remoteInputs[arr[0]] = arr[1];
        _remoteReceived++;
        if (arr[0] > _lastRemoteFrame) _lastRemoteFrame = arr[0];
      }
    };
  }

  function handlePeerDisconnect(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    delete _peers[remoteSid];
    window._peers = _peers;
    console.log('[lockstep-v3] peer disconnected:', remoteSid);
    if (_running) {
      setStatus('Peer disconnected');
      stopSync();
    }
  }

  function getPeer() {
    return Object.values(_peers)[0] || null;
  }

  // ── Game start sequence ────────────────────────────────────────────────

  // Minimum frames the emulator must run before we consider it ready.
  // The N64 BIOS + game boot takes many frames; we need the main loop
  // fully established and running before we sync state.
  const MIN_BOOT_FRAMES = 120;  // ~2 seconds at 60fps

  function startGameSequence() {
    if (_gameStarted) return;
    _gameStarted = true;

    setStatus('Starting emulator...');
    triggerEmulatorStart();
    applyStandardCheats();
    setupKeyTracking();
    disableEJSKeyboard();

    // Wait for gameManager AND for the emulator to run enough frames
    const waitForEmu = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(waitForEmu, 100); return; }

      const mod = gm.Module;
      const frames = mod && mod._get_current_frame_count
        ? mod._get_current_frame_count() : 0;

      if (frames < MIN_BOOT_FRAMES) {
        setTimeout(waitForEmu, 100);
        return;
      }

      console.log('[lockstep-v3] emulator booted (' + frames + ' frames)');
      _selfEmuReady = true;

      const peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send('emu-ready');
      }

      checkBothEmuReady();
    };
    waitForEmu();
  }

  function checkBothEmuReady() {
    if (!_selfEmuReady) return;
    const peer = getPeer();
    if (!peer || !peer.emuReady) return;
    if (_running) return;

    console.log('[lockstep-v3] both emulators ready -- syncing initial state');
    setStatus('Syncing...');

    if (_playerSlot === 0) {
      // Host: capture and send save state
      sendInitialState();
    }
    // Guest: waits for save state via handleSaveState
  }

  // Called when peer sends 'lockstep-ready' AND we're ready too
  let _selfLockstepReady = false;
  let _guestStateBytes = null;  // guest stores decompressed state here

  function checkBothLockstepReady() {
    if (!_selfLockstepReady || !_peerLockstepReady) return;
    if (_running) return;
    console.log('[lockstep-v3] both sides lockstep-ready -- GO');

    // Load the save state on BOTH sides. The host also loads its own
    // captured state — this resets the WebGL context so the canvas
    // renders correctly instead of showing stale boot-screen content.
    const gm = window.EJS_emulator.gameManager;
    if (_guestStateBytes) {
      gm.loadState(_guestStateBytes);
      _guestStateBytes = null;
      console.log('[lockstep-v3] loaded initial state (slot ' + _playerSlot + ')');
    } else {
      // Fallback: if state bytes not available, force a state round-trip
      // to reset the GL context
      console.log('[lockstep-v3] WARNING: no state bytes, doing self-reset');
      const selfState = gm.getState();
      gm.loadState(selfState);
    }

    // Both sides reset and start free-running sync
    _frameNum = 0;
    startSync();
  }

  async function sendInitialState() {
    const gm = window.EJS_emulator.gameManager;
    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      // Store for host to also load (resets GL context for proper rendering)
      _guestStateBytes = bytes;
      const compressed = await compressState(bytes);
      const b64 = uint8ToBase64(compressed);
      console.log('[lockstep-v3] sending initial state via DC (' +
        Math.round(bytes.length / 1024) + 'KB raw -> ' +
        Math.round(compressed.length / 1024) + 'KB gzip)');

      // Send via Socket.IO — the save state is ~1.5MB which crashes WebRTC
      // data channels (SCTP can't handle messages that large with maxRetransmits).
      // Server needs max_http_buffer_size=16MB (configured in signaling.py).
      socket.emit('data-message', { type: 'save-state', frame: 0, data: b64 });

      // Host is ready — signal via DC (small message, fine for DC)
      _selfLockstepReady = true;
      const peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send('lockstep-ready');
      }
      checkBothLockstepReady();
    } catch (err) {
      console.log('[lockstep-v3] failed to send initial state:', err);
    }
  }

  function handleSaveStateMsg(msg) {
    // Handle save state from either DC JSON or Socket.IO data-message
    console.log('[lockstep-v3] received initial state');
    setStatus('Loading initial state...');

    var compressed = base64ToUint8(msg.data);
    decompressState(compressed).then(function(bytes) {
      _guestStateBytes = bytes;
      console.log('[lockstep-v3] initial state decompressed (' + bytes.length + ' bytes)');

      _selfLockstepReady = true;
      var peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send('lockstep-ready');
      }
      checkBothLockstepReady();
    }).catch(function(err) {
      console.log('[lockstep-v3] failed to decompress initial state:', err);
    });
  }

  // ── Free-running sync loop ────────────────────────────────────────────
  //
  // Strategy: the emulator runs freely at native 60fps. We never pause it.
  // On each requestAnimationFrame, we read the emulator's current frame
  // count, send our local input, and apply delayed inputs for both players.
  // If remote input hasn't arrived yet, we predict by repeating the last
  // known remote input.

  // FPS + debug tracking
  let _fpsLastTime    = 0;
  let _fpsFrameCount  = 0;
  let _fpsCurrent     = 0;
  let _remoteReceived = 0;  // total remote inputs received
  let _remoteMissed   = 0;  // times we had to predict
  let _remoteApplied  = 0;  // times we applied real remote input
  let _lastRemoteFrame = -1; // highest remote frame number seen

  function startSync() {
    if (_running) return;
    _running = true;
    _frameNum = 0;
    _localInputs = {};
    _remoteInputs = {};
    _prevSlotMasks = {};
    _lastRemoteMask = 0;
    _fpsLastTime = performance.now();
    _fpsFrameCount = 0;
    _fpsCurrent = 0;
    _remoteReceived = 0;
    _remoteMissed = 0;
    _remoteApplied = 0;
    _lastRemoteFrame = -1;
    window._netplayFrameLog = [];

    console.log('[lockstep-v3] sync started -- slot:', _playerSlot,
      'peerSlot:', _peerSlot);
    setStatus('Connected -- game on!');

    requestAnimationFrame(tick);
  }

  function stopSync() {
    _running = false;
  }

  function tick() {
    if (!_running) return;

    const peer = getPeer();
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') {
      setStatus('Peer disconnected');
      stopSync();
      return;
    }

    // FPS counter
    _fpsFrameCount++;
    const now = performance.now();
    if (now - _fpsLastTime >= 1000) {
      _fpsCurrent = _fpsFrameCount;
      _fpsFrameCount = 0;
      _fpsLastTime = now;
    }

    // Use our own logical frame counter (both sides reset to 0 at sync).
    // Do NOT use _get_current_frame_count() — host and guest have
    // different core frame counts since the host ran freely before sync.

    // Send local input for current frame
    const mask = readLocalInput();
    _localInputs[_frameNum] = mask;
    const buf = new Int32Array([_frameNum, mask]).buffer;
    try { peer.dc.send(buf); } catch (_) {}

    // Apply inputs with delay
    const applyFrame = _frameNum - DELAY_FRAMES;
    if (applyFrame >= 0) {
      // Local input: use what we recorded
      applyInputForSlot(_playerSlot, _localInputs[applyFrame] || 0);

      // Remote input: use received, or predict (repeat last known)
      if (_remoteInputs[applyFrame] !== undefined) {
        _lastRemoteMask = _remoteInputs[applyFrame];
        _remoteApplied++;
      } else {
        _remoteMissed++;
      }
      applyInputForSlot(_peerSlot, _remoteInputs[applyFrame] !== undefined
        ? _remoteInputs[applyFrame]
        : _lastRemoteMask);

      // Cleanup old entries
      delete _localInputs[applyFrame];
      delete _remoteInputs[applyFrame];
    }

    _frameNum++;
    window._frameNum = _frameNum;

    // Debug overlay — update every 15 frames (~4x per second)
    if (_frameNum % 15 === 0) {
      const dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        const remoteKeys = Object.keys(_remoteInputs).length;
        const localKeys = Object.keys(_localInputs).length;
        dbg.textContent =
          'F:' + _frameNum +
          ' fps:' + _fpsCurrent +
          ' slot:' + _playerSlot +
          ' peer:' + _peerSlot +
          ' delay:' + DELAY_FRAMES +
          ' rBuf:' + remoteKeys +
          ' rcv:' + _remoteReceived +
          ' hit:' + _remoteApplied +
          ' miss:' + _remoteMissed +
          ' lastR:' + _lastRemoteFrame;
      }
    }

    requestAnimationFrame(tick);
  }

  // ── Input read / apply ─────────────────────────────────────────────────

  function readLocalInput() {
    let mask = 0;

    // Gamepad
    const gp = navigator.getGamepads()[0];
    if (gp) {
      for (let i = 0; i < Math.min(gp.buttons.length, 32); i++) {
        if (gp.buttons[i].pressed) mask |= (1 << i);
      }
    }

    // Keyboard
    if (_p1KeyMap) {
      _heldKeys.forEach(kc => {
        const btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }

    return mask;
  }

  function applyInputForSlot(slot, inputMask) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;

    const prevMask = _prevSlotMasks[slot] || 0;

    // Digital buttons (indices 0-15)
    for (let i = 0; i < 16; i++) {
      const wasPressed = (prevMask >> i) & 1;
      const isPressed  = (inputMask >> i) & 1;
      if (wasPressed !== isPressed) gm.simulateInput(slot, i, isPressed);
    }

    // Analog axes (indices 16+): buttons come in +/- pairs (16/17, 18/19, ...)
    for (let base = 16; base <= 22; base += 2) {
      const posNow  = (inputMask >> base)       & 1;
      const negNow  = (inputMask >> (base + 1)) & 1;
      const posPrev = (prevMask >> base)         & 1;
      const negPrev = (prevMask >> (base + 1))   & 1;
      if (posNow !== posPrev || negNow !== negPrev) {
        gm.simulateInput(slot, base, (posNow - negNow) * 32767);
      }
    }

    _prevSlotMasks[slot] = inputMask;
  }

  // ── Compression helpers ────────────────────────────────────────────────

  async function compressState(bytes) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (value) chunks.push(value);
      if (done) break;
    }
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  async function decompressState(bytes) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (value) chunks.push(value);
      if (done) break;
    }
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  function uint8ToBase64(bytes) {
    const chunkSize = 32768;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Cheats ─────────────────────────────────────────────────────────────

  function applyStandardCheats() {
    const attempt = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(attempt, 500); return; }
      try {
        SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code));
        console.log('[lockstep-v3] applied', SSB64_ONLINE_CHEATS.length, 'standard cheats');
      } catch (_) { setTimeout(attempt, 500); return; }
      setTimeout(() => { try { SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code)); } catch(_){} }, 2000);
      setTimeout(() => { try { SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code)); } catch(_){} }, 5000);
    };
    attempt();
  }

  // ── Keyboard / input setup ────────────────────────────────────────────

  function setupKeyTracking() {
    if (_p1KeyMap) return;

    const ejs = window.EJS_emulator;
    if (ejs && ejs.controls && ejs.controls[0]) {
      _p1KeyMap = {};
      Object.entries(ejs.controls[0]).forEach(([btnIdx, binding]) => {
        const kc = binding && binding.value;
        if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
      });
    }

    if (!_p1KeyMap || Object.keys(_p1KeyMap).length === 0) {
      _p1KeyMap = Object.assign({}, DEFAULT_N64_KEYMAP);
    }

    if (!setupKeyTracking._listenersAdded) {
      document.addEventListener('keydown', (e) => { _heldKeys.add(e['keyCode']); }, true);
      document.addEventListener('keyup',   (e) => { _heldKeys.delete(e['keyCode']); }, true);
      setupKeyTracking._listenersAdded = true;
    }
  }

  function disableEJSKeyboard() {
    const attempt = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(attempt, 200); return; }
      gm.setKeyboardEnabled(false);
      const ejs = window.EJS_emulator;
      const parent = ejs.elements && ejs.elements.parent;
      if (parent) {
        const block = e => e.stopImmediatePropagation();
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup',   block, true);
      }
    };
    attempt();
  }

  // ── Emulator start ─────────────────────────────────────────────────────

  function triggerEmulatorStart() {
    const attempt = () => {
      const btn = document.querySelector('.ejs_start_button');
      if (btn) { btn.click(); return; }
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.startButtonClicked === 'function') {
        ejs.startButtonClicked(); return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function randomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  window.addEventListener('DOMContentLoaded', () => {
    buildUI();
    loadSocketIO(connectSocket);
  });

})();
