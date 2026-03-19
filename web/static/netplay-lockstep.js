/**
 * kaillera-next — Prototype C: retro_run Hook Lockstep
 *
 * True Kaillera-style dual-emulator lockstep. Both peers run their own
 * EmulatorJS instance but stay perfectly in sync by:
 *
 *   1. Intercepting requestAnimationFrame to take manual control of the
 *      Emscripten main loop (which calls retro_run internally).
 *   2. Each "tick": read local input → send to peer → wait for peer input
 *      → apply both inputs via simulateInput → step exactly one frame.
 *
 * This gives frame-perfect deterministic sync — both emulators process
 * exactly the same inputs at exactly the same frame.
 *
 * Topology: mesh (same as Prototype A / netplay-dual.js).
 * Host (slot 0) creates room; guest (slot 1) joins.
 * 2-player only for now. Spectators not implemented.
 *
 * Key difference from Prototype A: instead of calling simulateInput()
 * while the emulator runs freely (async, can't block frame advance),
 * we OWN the frame loop. The emulator literally cannot advance until
 * we call the captured MainLoop_runner.
 */

(function () {
  'use strict';

  const GAME_ID     = 'ssb64';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Input delay in frames — both peers buffer this many frames of input
  // before applying. Hides network latency: peer has DELAY_FRAMES worth
  // of time to deliver their input before we need it.
  const DELAY_FRAMES = 2;

  // Max time to wait for remote input before applying zero.
  // Classic Kaillera blocks forever — we use a very long timeout (30s)
  // to handle disconnects, but never drop inputs during normal play.
  // The peer disconnect handler (onconnectionstatechange) handles the
  // actual disconnect case much faster than this timeout.
  const MAX_STALL_MS = 30000;

  // Desync detection via hashing is disabled — two Wasm N64 instances
  // aren't perfectly deterministic (FP/RNG differences).
  const HASH_INTERVAL = 0;

  // Periodic state resync: host sends save state to guest every N frames
  // to correct drift from non-deterministic emulation. Trades a brief
  // visual hitch for keeping both emulators closely in sync.
  const RESYNC_INTERVAL = 0;  // disabled — causes freezes due to large state transfer

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
    88: 0,    // X → B
    67: 8,    // C → A
    86: 3,    // V → Start
    38: 4,    // Up → D-Up
    40: 5,    // Down → D-Down
    37: 6,    // Left → D-Left
    39: 7,    // Right → D-Right
    90: 9,    // Z → Z-trigger
    84: 10,   // T → L-shoulder
    89: 11,   // Y → R-shoulder
    73: 12,   // I → C-Up
    75: 13,   // K → C-Down
    74: 14,   // J → C-Left
    76: 15,   // L → C-Right
    87: 16,   // W → Analog Up
    83: 17,   // S → Analog Down
    65: 18,   // A → Analog Left
    68: 19,   // D → Analog Right
  };

  // ── State ─────────────────────────────────────────────────────────────────

  let socket             = null;
  let sessionId          = null;
  let _playerSlot        = -1;     // 0 = host, 1 = guest
  let _peers             = {};     // remoteSid → PeerState
  let _knownPlayers      = {};
  let _gameStarted       = false;
  let _selfEmuReady      = false;
  let _p1KeyMap          = null;
  let _heldKeys          = new Set();
  let _prevSlotMasks     = {};     // slot → previous mask (for change detection)

  // Manual frame stepping state
  let _origRAF           = null;   // saved requestAnimationFrame
  let _pendingRunner     = null;   // captured Emscripten MainLoop_runner
  let _manualMode        = false;  // true when we own the frame loop
  let _tickTimer         = null;   // setTimeout ID for the tick loop
  let _peerLockstepReady = false;  // true when peer signals lockstep-ready

  // Lockstep state
  let _frameNum          = 0;      // current logical frame number
  let _localInputs       = {};     // frame → inputMask
  let _remoteInputs      = {};     // frame → inputMask
  let _peerSlot          = -1;     // the other player's slot
  let _stallStart        = 0;      // timestamp when we started waiting for input
  let _running           = false;  // tick loop active

  // Desync detection
  let _lastHash          = 0;
  let _lastHashFrame     = -1;
  let _desynced          = false;

  // Expose for Playwright
  window._playerSlot  = _playerSlot;
  window._peers       = _peers;
  window._desynced    = false;
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
      <h3>Netplay (Lockstep)</h3>
      <div style="font-size:10px; margin-bottom:8px; color:#555;">
        <a href="?mode=streaming" style="color:#6af; text-decoration:none;">Switch to Streaming mode</a>
      </div>
      <input id="np-name" placeholder="Your name" value="Player">
      <button id="np-create">Create Room</button>
      <div id="np-code-display" style="display:none"></div>
      <div class="row" style="margin-top:6px">
        <input id="np-join-code" placeholder="Room code">
        <button id="np-join">Join</button>
      </div>
      <div id="np-status">Connecting to server…</div>
      <div id="np-debug" style="display:none"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('np-create').onclick = createRoom;
    document.getElementById('np-join').onclick   = joinRoom;
  }

  function setStatus(msg) {
    const el = document.getElementById('np-status');
    if (el) el.textContent = msg;
    console.log('[lockstep]', msg);
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
    if (msg.type === 'save-state')     handleSaveState(msg);
    if (msg.type === 'resync-state')   handleResyncState(msg);
    if (msg.type === 'resync-request') handleResyncRequest();
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
      setStatus('Waiting for player 2…');
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
      setStatus('Joined — connecting…');
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
        console.log('[lockstep] peer', remoteSid, 'connection', s);
        handlePeerDisconnect(remoteSid);
      }
    };

    _peers[remoteSid] = peer;
    window._peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,  // ordered for lockstep — input order matters
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
      console.log('[lockstep] DC open with', remoteSid, 'slot:', peer.slot);
      peer.ready = true;
      ch.send('ready');

      if (_selfEmuReady) ch.send('emu-ready');

      if (!_gameStarted) startGameSequence();
    };

    ch.onclose = () => {
      console.log('[lockstep] DC closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => console.log('[lockstep] DC error:', remoteSid, e);

    ch.onmessage = (e) => {
      const peer = _peers[remoteSid];
      if (!peer) return;

      if (typeof e.data === 'string') {
        if (e.data === 'ready')          { peer.ready = true; }
        if (e.data === 'emu-ready')      { peer.emuReady = true; checkBothEmuReady(); }
        if (e.data === 'lockstep-ready') { _peerLockstepReady = true; checkBothLockstepReady(); }
        if (e.data.charAt(0) === '{') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'state-hash')     handleStateHash(msg);
            if (msg.type === 'resync-request') handleResyncRequest();
            if (msg.type === 'resync-state')   handleResyncState(msg);
          } catch (_) {}
        }
        return;
      }

      // Binary: Int32Array [frame, inputMask]
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 8) {
        const arr = new Int32Array(e.data);
        _remoteInputs[arr[0]] = arr[1];
      }
    };
  }

  function handlePeerDisconnect(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    delete _peers[remoteSid];
    window._peers = _peers;
    console.log('[lockstep] peer disconnected:', remoteSid);
    if (_running) {
      setStatus('Peer disconnected');
      stopLockstep();
    }
  }

  function getPeer() {
    return Object.values(_peers)[0] || null;
  }

  // ── Game start sequence ────────────────────────────────────────────────

  // Minimum frames the emulator must run before we take manual control.
  // The N64 BIOS + game boot takes many frames; we need the main loop
  // fully established and running before we can intercept it.
  const MIN_BOOT_FRAMES = 120;  // ~2 seconds at 60fps

  function startGameSequence() {
    if (_gameStarted) return;
    _gameStarted = true;

    setStatus('Starting emulator…');
    triggerEmulatorStart();
    applyStandardCheats();
    setupKeyTracking();
    disableEJSKeyboard();

    // Wait for gameManager AND for the emulator to run enough frames
    // so the Emscripten main loop is fully established.
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

      console.log('[lockstep] emulator booted (' + frames + ' frames)');
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

    console.log('[lockstep] both emulators ready — syncing initial state');
    setStatus('Syncing…');

    if (_playerSlot === 0) {
      // Host: send save state (emulator keeps running freely until
      // both sides are lockstep-ready — then we freeze + start).
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
    console.log('[lockstep] both sides lockstep-ready — GO');

    // Enter manual mode NOW — right before starting the tick loop.
    // No async gap = no stale rAF callbacks can corrupt the runner.
    enterManualMode();

    // Guest: load the save state while emulator is frozen
    if (_guestStateBytes) {
      const gm = window.EJS_emulator.gameManager;
      gm.loadState(_guestStateBytes);
      _guestStateBytes = null;
      console.log('[lockstep] guest loaded initial state');
    }

    _frameNum = 0;
    startLockstep();
  }

  async function sendInitialState() {
    const gm = window.EJS_emulator.gameManager;
    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const compressed = await compressState(bytes);
      const b64 = uint8ToBase64(compressed);
      console.log('[lockstep] sending initial state (' +
        Math.round(bytes.length / 1024) + 'KB raw → ' +
        Math.round(compressed.length / 1024) + 'KB gzip)');
      socket.emit('data-message', {
        type: 'save-state',
        frame: 0,
        data: b64,
      });
      // Host is ready — signal and wait for guest
      _selfLockstepReady = true;
      const peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send('lockstep-ready');
      }
      checkBothLockstepReady();
    } catch (err) {
      console.log('[lockstep] failed to send initial state:', err);
    }
  }

  async function handleSaveState(msg) {
    console.log('[lockstep] received initial state');
    setStatus('Loading initial state…');
    try {
      const compressed = base64ToUint8(msg.data);
      const bytes = await decompressState(compressed);

      // Store the state — it will be loaded in checkBothLockstepReady
      // right after enterManualMode, with no async gap.
      _guestStateBytes = bytes;
      console.log('[lockstep] initial state decompressed (' + bytes.length + ' bytes)');

      // Signal host that we're ready to run lockstep
      _selfLockstepReady = true;
      const peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send('lockstep-ready');
      }
      checkBothLockstepReady();
    } catch (err) {
      console.log('[lockstep] failed to decompress initial state:', err);
    }
  }

  // ── Manual frame stepping ─────────────────────────────────────────────
  //
  // Strategy: intercept requestAnimationFrame to capture the Emscripten
  // MainLoop_runner, then call it directly from our tick loop. The runner
  // may throw OOB errors (audio subsystem) when called outside a real rAF
  // context — we catch and ignore these since they're non-fatal (audio
  // glitches but emulation continues).

  function enterManualMode() {
    if (_manualMode) return;
    const mod = window.EJS_emulator.gameManager.Module;

    if (!_origRAF) _origRAF = window.requestAnimationFrame;

    // FIRST: pause the main loop. This increments the generation counter,
    // which invalidates ALL existing scheduled rAF callbacks. Any runner
    // that fires after this will see checkIsRunning()=false and bail.
    mod.pauseMainLoop();

    // THEN: replace rAF. Use a capture gate — only accept the runner
    // registered by resumeMainLoop (next line), not stale callbacks
    // from the old main loop that might fire during this tick.
    let _captureGate = false;
    window.requestAnimationFrame = function(cb) {
      if (_captureGate) _pendingRunner = cb;
      return -999;
    };

    _manualMode = true;

    // FINALLY: resume to create a fresh runner with the new generation.
    // Open the gate so only THIS registration is captured.
    _captureGate = true;
    mod.resumeMainLoop();
    _captureGate = false;

    // Now set the permanent interceptor that captures re-registrations
    // from the runner after each frame step.
    window.requestAnimationFrame = function(cb) {
      _pendingRunner = cb;
      return -999;
    };

    if (_pendingRunner) {
      console.log('[lockstep] manual mode active — captured runner');
    } else {
      console.log('[lockstep] WARNING: failed to capture runner');
    }
  }

  function stepOneFrame() {
    if (!_pendingRunner) return false;
    const runner = _pendingRunner;
    _pendingRunner = null;
    try {
      runner(performance.now());
    } catch (e) {
      // Audio OOB errors are non-fatal — emulation continues, audio glitches
      // Re-capture the runner since the error may have interrupted re-registration
      const mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                  window.EJS_emulator.gameManager.Module;
      if (mod && !_pendingRunner) {
        mod.pauseMainLoop();
        mod.resumeMainLoop();
      }
    }
    return true;
  }

  function exitManualMode() {
    if (!_manualMode) return;
    _manualMode = false;
    if (_origRAF) {
      window.requestAnimationFrame = _origRAF;
      _origRAF = null;
    }
    const mod = window.EJS_emulator.gameManager.Module;
    mod.pauseMainLoop();
    mod.resumeMainLoop();
    console.log('[lockstep] manual mode exited — normal playback');
  }

  // ── Lockstep tick loop ────────────────────────────────────────────────

  function startLockstep() {
    if (_running) return;
    _running = true;
    _frameNum = 0;
    _localInputs = {};
    _remoteInputs = {};
    _prevSlotMasks = {};
    _stallStart = 0;
    window._netplayFrameLog = [];

    console.log('[lockstep] lockstep started — slot:', _playerSlot);
    setStatus('Connected — game on!');

    tick();
  }

  function stopLockstep() {
    _running = false;
    if (_tickTimer) { clearTimeout(_tickTimer); _tickTimer = null; }
    exitManualMode();
  }

  function tick() {
    if (!_running) return;

    const peer = getPeer();
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') {
      setStatus('Peer disconnected');
      stopLockstep();
      return;
    }

    // Step 1: Read and send local input for the current frame
    if (!(_frameNum in _localInputs)) {
      const mask = readLocalInput();
      _localInputs[_frameNum] = mask;
      const buf = new Int32Array([_frameNum, mask]).buffer;
      try { peer.dc.send(buf); } catch (_) {}
    }

    // Step 2: Determine which frame to apply inputs for
    const applyFrame = _frameNum - DELAY_FRAMES;

    if (applyFrame >= 0) {
      // Check if remote input has arrived for applyFrame
      if (!(applyFrame in _remoteInputs)) {
        // STALL: wait for remote input
        if (_stallStart === 0) _stallStart = performance.now();
        const waited = performance.now() - _stallStart;

        if (waited < MAX_STALL_MS) {
          // Keep waiting via real rAF
          _tickTimer = _origRAF.call(window, tick);
          return;
        }

        // Stall timeout — apply zero input for remote to prevent freeze
        console.log('[lockstep] stall timeout at frame', applyFrame, '(' + Math.round(waited) + 'ms)');
        _remoteInputs[applyFrame] = 0;
      }

      _stallStart = 0;

      // Step 3: Apply inputs for both players
      const localMask  = _localInputs[applyFrame] || 0;
      const remoteMask = _remoteInputs[applyFrame] || 0;

      applyInputForSlot(_playerSlot, localMask);
      applyInputForSlot(_peerSlot, remoteMask);

      // Clean up old input buffers
      delete _localInputs[applyFrame];
      delete _remoteInputs[applyFrame];
    }

    // Step 4: Advance the emulator by exactly one frame.
    // Calls the captured Emscripten runner directly. OOB errors from
    // audio are caught and ignored (non-fatal).
    stepOneFrame();

    // Step 5: Desync detection — hash every HASH_INTERVAL frames
    if (HASH_INTERVAL > 0 && _frameNum > 0 && _frameNum % HASH_INTERVAL === 0) {
      broadcastHash(_frameNum);
    }

    // Step 5b: Periodic resync — host sends state to correct drift
    if (RESYNC_INTERVAL > 0 && _playerSlot === 0 &&
        _frameNum > 0 && _frameNum % RESYNC_INTERVAL === 0) {
      sendResyncState();
    }

    // Step 6: Debug overlay
    if (_frameNum % 30 === 0) {
      const dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        dbg.textContent = 'F:' + _frameNum + ' delay:' + DELAY_FRAMES +
          ' slot:' + _playerSlot +
          (_desynced ? ' DESYNC' : '');
      }
    }

    if (window._netplayFrameLog && window._netplayFrameLog.length < 600) {
      window._netplayFrameLog.push({ frame: _frameNum });
    }

    window._frameNum = _frameNum;
    _frameNum++;

    // Schedule next tick via the real rAF. The runner must execute
    // inside a real rAF callback for the browser to composite the
    // WebGL framebuffer to the screen.
    _tickTimer = _origRAF.call(window, tick);
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

    // Analog axes (indices 16+): buttons come in +/- pairs (16/17, 18/19, …)
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

  // ── Desync detection ──────────────────────────────────────────────────

  function stateHash() {
    try {
      const gm = window.EJS_emulator.gameManager;
      const state = gm.getState();
      if (!state || state.length < 530000) return 0;
      let h = 0;
      const off = 512 * 1024;
      const len = 8192;
      for (let i = off; i < off + len && i < state.length; i++) {
        h = (h * 31 + state[i]) >>> 0;
      }
      return h;
    } catch (_) {
      return 0;
    }
  }

  function broadcastHash(frame) {
    const hash = stateHash();
    if (hash === 0) return;
    _lastHash = hash;
    _lastHashFrame = frame;
    const peer = getPeer();
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(JSON.stringify({ type: 'state-hash', frame: frame, hash: hash }));
      } catch (_) {}
    }
  }

  function handleStateHash(msg) {
    if (_lastHashFrame < 0 || Math.abs(msg.frame - _lastHashFrame) > 5) return;

    if (msg.hash === _lastHash) {
      if (_desynced) {
        console.log('[lockstep] hashes match post-resync at frame', msg.frame);
        _desynced = false;
        window._desynced = false;
        setStatus('Connected — game on!');
      }
      return;
    }

    console.log('[lockstep] DESYNC at frame', msg.frame,
      'local:', _lastHash, 'remote:', msg.hash);
    _desynced = true;
    window._desynced = true;
    setStatus('Desync detected — resyncing…');

    if (_playerSlot !== 0) {
      // Guest requests resync from host
      const peer = getPeer();
      if (peer && peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send(JSON.stringify({ type: 'resync-request' }));
      }
    } else {
      sendResyncState();
    }
  }

  function handleResyncRequest() {
    if (_playerSlot !== 0) return;
    console.log('[lockstep] received resync request');
    _desynced = true;
    window._desynced = true;
    sendResyncState();
  }

  async function sendResyncState() {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const compressed = await compressState(bytes);
      const b64 = uint8ToBase64(compressed);
      console.log('[lockstep] sending resync state');
      socket.emit('data-message', {
        type: 'resync-state',
        frame: _frameNum,
        data: b64,
      });
      applyResync(_frameNum, bytes);
    } catch (err) {
      console.log('[lockstep] resync send failed:', err);
      _desynced = false;
      window._desynced = false;
    }
  }

  async function handleResyncState(msg) {
    console.log('[lockstep] received resync state for frame', msg.frame);
    try {
      const compressed = base64ToUint8(msg.data);
      const bytes = await decompressState(compressed);
      applyResync(msg.frame, bytes);
    } catch (err) {
      console.log('[lockstep] resync load failed:', err);
      _desynced = false;
      window._desynced = false;
    }
  }

  function applyResync(frame, stateBytes) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    try {
      gm.loadState(stateBytes);
    } catch (err) {
      console.log('[lockstep] loadState failed:', err);
      _desynced = false;
      window._desynced = false;
      return;
    }
    _frameNum = frame;
    window._frameNum = _frameNum;
    _localInputs   = {};
    _remoteInputs  = {};
    _prevSlotMasks = {};
    _lastHash      = 0;
    _lastHashFrame = -1;
    _stallStart    = 0;
    console.log('[lockstep] resync applied at frame', frame);
    setStatus('Resynced');
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
        console.log('[lockstep] applied', SSB64_ONLINE_CHEATS.length, 'standard cheats');
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
