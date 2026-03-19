/**
 * kaillera-next netplay client — Phase 3: 4-Player + Spectators
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
  const INPUT_HZ    = 60;

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

  // Expose for Playwright verification
  window._playerSlot  = _playerSlot;
  window._isSpectator = _isSpectator;
  window._peers       = _peers;

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

    // Update my slot from server
    const myPlayerEntry = Object.values(players).find(p => p.socketId === socket.id);
    if (myPlayerEntry) {
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
    if (readyCount < _expectedPeerCount) return;
    _gameStarted = true;
    startInputSync();
  }

  function checkAllEmuReady() {
    if (!_selfEmuReady) return;
    const playerPeers = Object.values(_peers).filter(
      p => p.slot !== null && p.slot !== undefined
    );
    if (!playerPeers.every(p => p.emuReady)) return;
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
    window._netplayFrameLog = [];

    inputTimer = setInterval(() => {
      const openPeers = Object.values(_peers).filter(
        p => p.dc && p.dc.readyState === 'open'
      );
      if (openPeers.length === 0) return;

      // Retry key tracking setup if EJS wasn't ready at connect time
      if (!_p1KeyMap && !_isSpectator) setupP1KeyTracking();

      // Record and broadcast local input (players only)
      if (!_isSpectator) {
        const localMask = readLocalInput();
        _localQueue[_frameNum] = localMask;
        const buf = new Int32Array([_frameNum, localMask]).buffer;
        openPeers.forEach(p => {
          try { p.dc.send(buf); } catch (_) {}
        });
      }

      // Apply inputs from N frames ago
      const applyFrame = _frameNum - _delayN;
      if (applyFrame >= 0) {
        // Apply own local input (players only)
        if (!_isSpectator && _playerSlot !== null) {
          const lm = _localQueue[applyFrame] || 0;
          applyInputForSlot(_playerSlot, lm);
          delete _localQueue[applyFrame];
        }

        // Apply remote inputs from each connected peer
        for (const peer of Object.values(_peers)) {
          if (peer.slot === null || peer.slot === undefined) continue;
          if (peer.slot === _playerSlot) continue;  // skip own slot
          const slot = peer.slot;
          if (!_remoteQueues[slot]) _remoteQueues[slot] = {};

          const rm = (applyFrame in _remoteQueues[slot])
            ? _remoteQueues[slot][applyFrame]
            : (_lastRemoteMasks[slot] || 0);
          if (applyFrame in _remoteQueues[slot]) {
            _lastRemoteMasks[slot] = _remoteQueues[slot][applyFrame];
          }
          applyInputForSlot(slot, rm);
          delete _remoteQueues[slot][applyFrame];
        }

        // Debug log for Playwright verification (cap at 600 entries)
        if (window._netplayFrameLog && window._netplayFrameLog.length < 600) {
          window._netplayFrameLog.push({ frame: applyFrame });
        }
      }

      window._frameNum = _frameNum;

      // Update debug overlay twice per second
      if (_frameNum % 30 === 0) {
        const dbg = document.getElementById('np-debug');
        if (dbg) {
          dbg.style.display = '';
          const peerCount = Object.keys(_peers).length;
          dbg.textContent = 'F:' + _frameNum + ' delay:' + _delayN + ' peers:' + peerCount;
        }
      }

      _frameNum++;
    }, 1000 / INPUT_HZ);
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
    if (inputTimer) { clearInterval(inputTimer); inputTimer = null; }
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
