/**
 * kaillera-next netplay client — Phase 5: Desync Detection + Auto-Resync
 *
 * Full mesh WebRTC: each player connects to every other player.
 * With 4 players there are 6 bidirectional connections (each client manages 3).
 * Input is broadcast to all peers each tick; each peer applies inputs by slot.
 *
 * Spectators connect to all players (receive-only, no input sent).
 *
 * Slot assignment:
 *   Host  (slot 0) — creates room
 *   Guests (slot 1-3) — assigned in join order
 *   Spectators (slot null) — receive inputs, no slot
 *
 * Mesh initiation convention: lower slot sends the offer + creates data channel.
 * Spectators never initiate — players initiate connections to spectators.
 */

(function () {
  'use strict';

  const GAME_ID     = 'ssb64';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  // INPUT_HZ removed — now using requestAnimationFrame (synced to display refresh)

  // Standard online config applied automatically on all clients at game start.
  // Codes are N64 GameShark format ("XXXXXXXX YYYY") — sourced from the
  // SSB64 community. The "Unlock Everything" pair gives all characters +
  // Mushroom Kingdom stage + access to the Item Switch menu. The item switch
  // codes zero out all three item-group bytes so no items spawn in VS mode.
  const SSB64_ONLINE_CHEATS = [
    { desc: 'Have All Characters',   code: '810A4938 0FF0' },
    { desc: 'Have Mushroom Kingdom', code: '800A4937 00FF' },
    { desc: 'Stock Mode',            code: '800A4D0B 0002' },
    { desc: '5 Stocks',              code: '800A4D0F 0004' },
    { desc: 'Timer On',              code: '800A4D11 0001' },
    { desc: 'Items Off',             code: '800A4D24 0000' },
  ];

  // ── State ─────────────────────────────────────────────────────────────────

  let socket             = null;
  let sessionId          = null;
  let _playerSlot        = -1;     // 0-3 for players, null for spectators
  let _isSpectator       = false;
  let _peers             = {};     // remoteSid → PeerState
  let _knownPlayers      = {};     // socketId → {slot, playerName}
  let _expectedPeerCount = 0;      // other players in room (excludes spectators)
  let _gameStarted       = false;
  let _selfReady         = false;
  let _selfEmuReady      = false;
  let inputTimer         = null;
  let _prevSlotMasks     = {};     // slot → previous mask (for change detection)
  let _p1KeyMap          = null;   // keycode → libretro button index
  let _heldKeys          = new Set();
  let _frameNum          = 0;
  let _localQueue        = {};     // frame → mask
  let _remoteQueues      = {};     // slot → {frame → mask}
  let _lastRemoteMasks   = {};     // slot → last known mask (repeat on missing)
  let _delayN            = 2;      // frames of input delay
  let _stallCount        = 0;      // consecutive stalled ticks (waiting for remote input)
  const MAX_STALL        = 10;     // max ticks to stall before applying zero input

  // Phase 5: desync detection
  let _lastHash          = 0;      // last computed state hash
  let _lastHashFrame     = -1;     // frame at which _lastHash was computed
  let _desynced          = false;  // true if desync detected
  let _pendingResync     = null;   // {frame, data} if resync state received

  // Expose for Playwright verification
  window._playerSlot  = _playerSlot;
  window._isSpectator = _isSpectator;
  window._peers       = _peers;
  window._desynced    = false;

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
      <h3>Netplay</h3>
      <input id="np-name" placeholder="Your name" value="Player">
      <button id="np-create">Create Room</button>
      <div id="np-code-display" style="display:none"></div>
      <div class="row" style="margin-top:6px">
        <input id="np-join-code" placeholder="Room code">
        <button id="np-join">Join</button>
        <button id="np-spectate">Watch</button>
      </div>
      <div id="np-status">Connecting to server…</div>
      <div id="np-debug" style="display:none"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('np-create').onclick  = createRoom;
    document.getElementById('np-join').onclick     = joinRoom;
    document.getElementById('np-spectate').onclick = spectateRoom;
  }

  function setStatus(msg) {
    const el = document.getElementById('np-status');
    if (el) el.textContent = msg;
    console.log('[netplay]', msg);
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
    ['np-create', 'np-join', 'np-spectate'].forEach(id => {
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
    socket.on('connect',       () => setStatus('Ready'));
    socket.on('connect_error', (e) => setStatus('Server error: ' + e.message));
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);
    socket.on('data-message',  onDataMessage);
  }

  function onDataMessage(msg) {
    // Large messages (save state, resync state) route through Socket.IO
    // instead of data channels to avoid DC size limits
    if (!msg || !msg.type) return;
    if (msg.type === 'save-state')      handleSaveState(msg);
    if (msg.type === 'resync-request')  handleResyncRequest();
    if (msg.type === 'resync-state')    handleResyncState(msg);
  }

  // ── Room management ────────────────────────────────────────────────────

  function createRoom() {
    const name = document.getElementById('np-name').value.trim() || 'Player';
    sessionId  = randomCode();
    _playerSlot = 0;
    window._playerSlot = 0;

    socket.emit('open-room', {
      extra: {
        sessionid:     sessionId,
        userid:        socket.id,
        playerId:      socket.id,
        room_name:     name + "'s room",
        game_id:       GAME_ID,
        player_name:   name,
        room_password: null,
        domain:        window.location.hostname,
      },
      maxPlayers: 4,
      password:   null,
    }, (err) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();
      setCode(sessionId);
      setStatus('Waiting for players…');
    });
  }

  function joinRoom() {
    _joinOrSpectate(false);
  }

  function spectateRoom() {
    _joinOrSpectate(true);
  }

  function _joinOrSpectate(spectate) {
    const name = document.getElementById('np-name').value.trim() || 'Player';
    const code = document.getElementById('np-join-code').value.trim().toUpperCase();
    if (!code) { setStatus('Enter a room code'); return; }

    sessionId    = code;
    _isSpectator = spectate;
    window._isSpectator = spectate;

    socket.emit('join-room', {
      extra: {
        sessionid:   sessionId,
        userid:      socket.id,
        player_name: name,
        spectate:    spectate,
      },
      password: null,
    }, (err, data) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();

      // Read my slot from the server response
      if (!spectate && data && data.players) {
        const myEntry = Object.values(data.players).find(p => p.socketId === socket.id);
        if (myEntry) {
          _playerSlot = myEntry.slot;
          window._playerSlot = _playerSlot;
        }
      } else if (spectate) {
        _playerSlot = null;
        window._playerSlot = null;
      }

      setStatus(spectate ? 'Spectating…' : 'Joined — connecting…');
    });
  }

  // ── users-updated ──────────────────────────────────────────────────────

  function onUsersUpdated(data) {
    const players    = data.players    || {};
    const spectators = data.spectators || {};

    // Update known players map
    _knownPlayers = {};
    Object.values(players).forEach(p => {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    });

    // Update my slot from server (handles spectator → player transition)
    const myPlayerEntry = Object.values(players).find(p => p.socketId === socket.id);
    if (myPlayerEntry) {
      if (_isSpectator) {
        // Spectator claimed a slot — transition to player
        console.log('[netplay] transitioned from spectator to player, slot:', myPlayerEntry.slot);
        _isSpectator = false;
        window._isSpectator = false;
      }
      _playerSlot = myPlayerEntry.slot;
      window._playerSlot = _playerSlot;
    }

    // Count expected peers (other players, excludes spectators)
    const otherPlayers = Object.values(players).filter(p => p.socketId !== socket.id);
    _expectedPeerCount = otherPlayers.length;

    // Establish mesh connections to other players
    for (const p of otherPlayers) {
      if (_peers[p.socketId]) {
        _peers[p.socketId].slot = p.slot;  // update slot if changed
        continue;
      }

      // Lower slot initiates (creates data channel + sends offer)
      let shouldInitiate;
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
      for (const s of Object.values(spectators)) {
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }
  }

  // ── WebRTC multi-peer ──────────────────────────────────────────────────

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
        console.log('[netplay] peer', remoteSid, 'connection', s);
        handlePeerDisconnect(remoteSid);
      }
    };

    // Store in _peers BEFORE setting up DC so setupDataChannel can find it
    _peers[remoteSid] = peer;
    window._peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('inputs', {
        ordered: false, maxRetransmits: 0,
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

    // Create peer on demand if offer arrives before users-updated
    if (data.offer && !_peers[senderSid]) {
      const known = _knownPlayers[senderSid];
      createPeer(senderSid, known ? known.slot : null, false);
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
      console.log('[netplay] data channel open with', remoteSid, 'slot:', peer.slot);
      ch.send('ready');
      _selfReady = true;

      // Phase 4: if emulator is already running, send emu-ready immediately
      // so late joiners can complete their handshake
      if (_selfEmuReady) {
        ch.send('emu-ready');
      }

      // Phase 4: if game is already running, host sends save state to late joiner
      if (_gameStarted && _selfEmuReady && _playerSlot === 0) {
        setTimeout(() => sendSaveState(), 500);
      }

      checkAllReady();
    };

    ch.onclose = () => {
      console.log('[netplay] data channel closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => console.log('[netplay] data channel error:', remoteSid, e);

    ch.onmessage = (e) => {
      const peer = _peers[remoteSid];
      if (!peer) return;
      if (typeof e.data === 'string') {
        if (e.data === 'ready')     { peer.ready = true;    checkAllReady(); }
        if (e.data === 'emu-ready') { peer.emuReady = true; checkAllEmuReady(); }
        // JSON string messages (Phase 4 + 5)
        if (e.data.charAt(0) === '{') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveState(msg);
            if (msg.type === 'request-state')   handleStateRequest();
            if (msg.type === 'state-hash')      handleStateHash(msg, remoteSid);
            if (msg.type === 'resync-request')  handleResyncRequest();
            if (msg.type === 'resync-state')    handleResyncState(msg);
          } catch (_) {}
        }
        return;
      }
      if (e.data.byteLength === 8 && peer.slot !== null && peer.slot !== undefined) {
        const arr = new Int32Array(e.data);
        if (!_remoteQueues[peer.slot]) _remoteQueues[peer.slot] = {};
        _remoteQueues[peer.slot][arr[0]] = arr[1];
      }
    };
  }

  function checkAllReady() {
    if (!_selfReady || _gameStarted) return;
    if (_expectedPeerCount === 0) return;
    // Only count player peers (non-null slot) — spectators don't block game start
    const playerPeers = Object.values(_peers).filter(
      p => p.slot !== null && p.slot !== undefined
    );
    const readyCount = playerPeers.filter(
      p => p.ready && p.dc && p.dc.readyState === 'open'
    ).length;
    // Phase 4: allow starting with at least 1 ready peer (late join scenario)
    // Previously required all peers, but late joiners connect to a running game
    if (readyCount === 0) return;
    if (readyCount < _expectedPeerCount) {
      // Check if any peer already has the game running (late join detection)
      // If not, wait for all peers
      const anyEmuReady = playerPeers.some(p => p.emuReady);
      if (!anyEmuReady) return;
    }
    _gameStarted = true;
    startInputSync();
  }

  function checkAllEmuReady() {
    if (!_selfEmuReady) return;
    if (inputTimer) return;  // input loop already running
    const playerPeers = Object.values(_peers).filter(
      p => p.slot !== null && p.slot !== undefined
    );
    // Phase 4: for late joiners, start when at least 1 peer has emu ready
    const emuReadyCount = playerPeers.filter(p => p.emuReady).length;
    if (emuReadyCount === 0) return;
    if (emuReadyCount < playerPeers.length) {
      // Not all ready — but if any peer is already running (late join), proceed
      const anyRunning = playerPeers.some(p => p.emuReady);
      if (!anyRunning) return;
    }
    startInputLoop();
  }

  function handlePeerDisconnect(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    if (peer.slot !== null && peer.slot !== undefined) {
      applyInputForSlot(peer.slot, 0);  // zero their input (all buttons released)
      delete _remoteQueues[peer.slot];
    }
    delete _peers[remoteSid];
    window._peers = _peers;
    console.log('[netplay] peer disconnected:', remoteSid);

    const remaining = Object.values(_peers).filter(
      p => p.dc && p.dc.readyState === 'open'
    );
    if (remaining.length === 0 && _gameStarted) {
      setStatus('All peers disconnected');
      stopInputSync();
    }
  }

  // ── Compression helpers (gzip via CompressionStream API) ────────────────

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

  // ── Phase 4: Late join / leave ──────────────────────────────────────────

  async function handleSaveState(msg) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    console.log('[netplay] received save state, decompressing…');
    setStatus('Loading save state…');
    try {
      const compressed = base64ToUint8(msg.data);
      const bytes = await decompressState(compressed);
      gm.loadState(bytes);
      if (msg.frame !== undefined) {
        _frameNum = msg.frame;
        window._frameNum = _frameNum;
      }
      _localQueue      = {};
      _remoteQueues    = {};
      _lastRemoteMasks = {};
      _prevSlotMasks   = {};
      console.log('[netplay] save state loaded, synced at frame', _frameNum);
      setStatus('🟢 Connected — game on!');
    } catch (err) {
      console.log('[netplay] failed to load save state:', err);
    }
  }

  function handleStateRequest() {
    if (_playerSlot !== 0) return;
    sendSaveState();
  }

  async function sendSaveState() {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const compressed = await compressState(bytes);
      const b64 = uint8ToBase64(compressed);
      console.log('[netplay] sending save state via Socket.IO (' +
        Math.round(bytes.length / 1024) + 'KB raw → ' +
        Math.round(compressed.length / 1024) + 'KB gzip)');
      socket.emit('data-message', {
        type: 'save-state',
        frame: _frameNum,
        data: b64,
      });
    } catch (err) {
      console.log('[netplay] failed to send save state:', err);
    }
  }

  function sendSaveStateToAll() {
    // Host sends save state to all connected peers (via Socket.IO broadcast)
    if (_playerSlot !== 0) return;
    sendSaveState();
  }

  function claimSlot(slot) {
    if (!_isSpectator) return;
    socket.emit('claim-slot', { slot: slot !== undefined ? slot : null }, (err) => {
      if (err) { setStatus('Claim failed: ' + err); return; }
      setStatus('Slot claimed — connecting…');
      // Transition happens via users-updated
    });
  }
  // Expose for Playwright
  window.claimSlot = claimSlot;

  // ── Phase 5: Desync detection + auto-resync ────────────────────────────

  function stateHash() {
    // Hash the RDRAM region of the emulator save state (not HEAPU8 offset 0,
    // which is Wasm boilerplate that never changes between game states).
    // N64 RDRAM lives at ~384KB-704KB in the mupen64plus-next save state blob.
    // We sample 8KB from the hottest region (512KB offset) for a fast fingerprint.
    try {
      const gm = window.EJS_emulator.gameManager;
      if (!gm) return 0;
      const state = gm.getState();
      if (!state || state.length < 530000) return 0;
      let h = 0;
      const off = 512 * 1024;  // RDRAM hotspot in save state
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
    if (hash === 0) return;  // emulator not ready
    _lastHash = hash;
    _lastHashFrame = frame;
    const msg = JSON.stringify({ type: 'state-hash', frame: frame, hash: hash });
    Object.values(_peers).forEach(p => {
      if (p.dc && p.dc.readyState === 'open') {
        try { p.dc.send(msg); } catch (_) {}
      }
    });
  }

  function handleStateHash(msg, senderSid) {
    const localHash = _lastHash;
    const localFrame = _lastHashFrame;
    // Only compare if we have a hash for the same frame (or close enough)
    if (localFrame < 0 || Math.abs(msg.frame - localFrame) > 5) return;

    if (msg.hash === localHash) {
      // Hashes match — if we were resyncing, confirm resync succeeded
      if (_desynced) {
        console.log('[netplay] hashes match post-resync at frame', msg.frame);
        _desynced = false;
        window._desynced = false;
        setStatus('🟢 Connected — game on!');
      }
      return;
    }

    // Mismatch — only trigger resync if not already handling one
    if (_desynced) return;
    console.log('[netplay] DESYNC detected at frame', msg.frame,
      'local:', localHash, 'remote:', msg.hash, 'from:', senderSid);
    _desynced = true;
    window._desynced = true;
    setStatus('Desync detected — resyncing…');
    // Non-host sends resync request to host
    if (_playerSlot !== 0) {
      const hostPeer = Object.values(_peers).find(p => p.slot === 0);
      if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
        hostPeer.dc.send(JSON.stringify({ type: 'resync-request' }));
      }
    } else {
      // Host detected desync — send resync state to all
      sendResyncState();
    }
  }

  function handleResyncRequest() {
    // Only host handles resync requests
    if (_playerSlot !== 0) return;
    console.log('[netplay] received resync request, sending state to all');
    _desynced = true;
    window._desynced = true;
    setStatus('Desync detected — resyncing…');
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
      console.log('[netplay] sending resync state via Socket.IO (' +
        Math.round(bytes.length / 1024) + 'KB raw → ' +
        Math.round(compressed.length / 1024) + 'KB gzip)');
      socket.emit('data-message', {
        type: 'resync-state',
        frame: _frameNum,
        data: b64,
      });
      // Host also loads its own state to re-anchor at the same point
      applyResync(_frameNum, bytes);
    } catch (err) {
      console.log('[netplay] failed to send resync state:', err);
      _desynced = false;
      window._desynced = false;
    }
  }

  async function handleResyncState(msg) {
    console.log('[netplay] received resync state for frame', msg.frame);
    try {
      const compressed = base64ToUint8(msg.data);
      const bytes = await decompressState(compressed);
      applyResync(msg.frame, bytes);
    } catch (err) {
      console.log('[netplay] failed to apply resync state:', err);
      _desynced = false;
      window._desynced = false;
    }
  }

  function applyResync(frame, stateBytes) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    try {
      gm.loadState(stateBytes);
    } catch (_) {}
    // Reset frame counters and queues
    _frameNum = frame;
    window._frameNum = _frameNum;
    _localQueue      = {};
    _remoteQueues    = {};
    _lastRemoteMasks = {};
    _prevSlotMasks   = {};
    _lastHash        = 0;
    _lastHashFrame   = -1;
    console.log('[netplay] resync applied at frame', frame);
    setStatus('Resynced — waiting for hash confirmation…');
    // _desynced stays true until the next hash exchange confirms hashes match
    // (see handleStateHash). This prevents a detect→resync→detect loop.
  }

  // ── Cheats ─────────────────────────────────────────────────────────────

  function _doApplyCheats() {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return false;
    try {
      SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code));
      return true;
    } catch (_) {
      return false;
    }
  }

  function applyStandardCheats() {
    const attempt = () => {
      if (!_doApplyCheats()) { setTimeout(attempt, 500); return; }
      console.log('[netplay] applied', SSB64_ONLINE_CHEATS.length, 'standard cheats');
      setTimeout(() => { _doApplyCheats(); console.log('[netplay] re-applied cheats (2s)'); }, 2000);
      setTimeout(() => { _doApplyCheats(); console.log('[netplay] re-applied cheats (5s)'); }, 5000);
    };
    attempt();
  }

  // ── Keyboard tracking ──────────────────────────────────────────────────

  function setupP1KeyTracking() {
    const ejs = window.EJS_emulator;
    if (!ejs || !ejs.controls || !ejs.controls[0]) return;

    _p1KeyMap = {};
    Object.entries(ejs.controls[0]).forEach(([btnIdx, binding]) => {
      const kc = binding && binding.value;
      if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
    });

    // Non-host players: remap keyboard bindings to their slot
    if (_playerSlot > 0) {
      ejs.controls[_playerSlot] = Object.assign({}, ejs.controls[0]);
      ejs.controls[0] = {};
    }

    document.addEventListener('keydown', (e) => { _heldKeys.add(e['keyCode']); }, true);
    document.addEventListener('keyup',   (e) => { _heldKeys.delete(e['keyCode']); }, true);
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

  // ── Input sync ─────────────────────────────────────────────────────────

  function startInputSync() {
    setStatus('Starting emulator…');
    triggerEmulatorStart();
    applyStandardCheats();

    if (!_isSpectator) {
      setupP1KeyTracking();
      disableEJSKeyboard();
    }

    const waitForEmu = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(waitForEmu, 100); return; }
      console.log('[netplay] emulator running, signalling peers');
      _selfEmuReady = true;
      Object.values(_peers).forEach(p => {
        if (p.dc && p.dc.readyState === 'open') p.dc.send('emu-ready');
      });
      checkAllEmuReady();
    };
    waitForEmu();
  }

  function startInputLoop() {
    console.log('[netplay] all emulators running — starting input loop');
    setStatus('🟢 Connected — game on!');
    _frameNum        = 0;
    _localQueue      = {};
    _remoteQueues    = {};
    _lastRemoteMasks = {};
    _prevSlotMasks   = {};
    _stallCount      = 0;
    window._netplayFrameLog = [];

    // Use requestAnimationFrame instead of setInterval — rAF is synchronized
    // with the browser's render cycle (same clock the emulator uses), which
    // eliminates the timing jitter that caused both emulators to drift apart.
    let _inputSent = false;  // track whether we've sent input for current _frameNum

    function inputTick() {
      inputTimer = requestAnimationFrame(inputTick);

      const openPeers = Object.values(_peers).filter(
        p => p.dc && p.dc.readyState === 'open'
      );
      if (openPeers.length === 0) return;

      // Retry key tracking setup if EJS wasn't ready at connect time
      if (!_p1KeyMap && !_isSpectator) setupP1KeyTracking();

      // Record and broadcast local input ONCE per frame
      if (!_inputSent && !_isSpectator) {
        const localMask = readLocalInput();
        _localQueue[_frameNum] = localMask;
        const buf = new Int32Array([_frameNum, localMask]).buffer;
        openPeers.forEach(p => {
          try { p.dc.send(buf); } catch (_) {}
        });
        _inputSent = true;
      }

      // Apply inputs from N frames ago — TRUE LOCKSTEP
      const applyFrame = _frameNum - _delayN;
      if (applyFrame >= 0) {
        // Check if all remote peers' inputs have arrived for applyFrame
        const activePeers = Object.values(_peers).filter(
          p => p.slot !== null && p.slot !== undefined && p.slot !== _playerSlot
              && p.dc && p.dc.readyState === 'open'
        );
        const allArrived = activePeers.every(p => {
          if (!_remoteQueues[p.slot]) return false;
          return applyFrame in _remoteQueues[p.slot];
        });

        if (!allArrived && _stallCount < MAX_STALL) {
          _stallCount++;
          return;  // STALL — don't advance, wait for remote input
        }

        _stallCount = 0;

        // Apply own local input (players only)
        if (!_isSpectator && _playerSlot !== null) {
          const lm = _localQueue[applyFrame] || 0;
          applyInputForSlot(_playerSlot, lm);
          delete _localQueue[applyFrame];
        }

        // Apply remote inputs from each connected peer
        for (const peer of activePeers) {
          const slot = peer.slot;
          if (!_remoteQueues[slot]) _remoteQueues[slot] = {};
          const rm = (applyFrame in _remoteQueues[slot])
            ? _remoteQueues[slot][applyFrame]
            : 0;  // only reached after MAX_STALL — apply zero
          if (applyFrame in _remoteQueues[slot]) {
            _lastRemoteMasks[slot] = _remoteQueues[slot][applyFrame];
          }
          applyInputForSlot(slot, rm);
          delete _remoteQueues[slot][applyFrame];
        }

        if (window._netplayFrameLog && window._netplayFrameLog.length < 600) {
          window._netplayFrameLog.push({ frame: applyFrame });
        }
      }

      window._frameNum = _frameNum;

      // Phase 5: broadcast state hash every 60 frames
      if (!_isSpectator && _frameNum > 0 && _frameNum % 60 === 0) {
        broadcastHash(_frameNum);
      }

      // Update debug overlay twice per second
      if (_frameNum % 30 === 0) {
        const dbg = document.getElementById('np-debug');
        if (dbg) {
          dbg.style.display = '';
          const playerCount = Object.keys(_peers).length + (_isSpectator ? 0 : 1);
          dbg.textContent = 'F:' + _frameNum + ' delay:' + _delayN + ' players:' + playerCount +
            (_stallCount > 0 ? ' STALL:' + _stallCount : '');
        }
      }

      _frameNum++;
      _inputSent = false;  // allow recording input for next frame
    }

    inputTick();
  }

  function triggerEmulatorStart() {
    const attempt = () => {
      const btn = document.querySelector('.ejs_start_button');
      if (btn) { btn.click(); return; }
      const ejs = window.EJS_emulator;
      if (ejs && typeof ejs.startButtonClicked === 'function') {
        ejs.startButtonClicked();
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  }

  function stopInputSync() {
    if (inputTimer) { cancelAnimationFrame(inputTimer); inputTimer = null; }
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

  // ── Helpers ────────────────────────────────────────────────────────────

  function randomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  window.addEventListener('DOMContentLoaded', () => {
    buildUI();
    loadSocketIO(connectSocket);
  });

})();
