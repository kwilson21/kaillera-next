/**
 * kaillera-next — Prototype B: Single-Emulator Streaming
 *
 * Architecture: host runs the emulator and streams canvas video to guests.
 * Guests display a <video> element and send keyboard/gamepad input back
 * to the host via WebRTC data channel. Zero desync by design.
 *
 * Topology: star (all guests connect to host only, not to each other).
 *
 * Host (slot 0):
 *   - Runs EmulatorJS, applies cheats
 *   - Captures canvas via captureStream(60)
 *   - Adds video track to peer connections
 *   - Receives guest input via data channel, applies via simulateInput()
 *   - Reads own input locally, applies via simulateInput()
 *
 * Guest (slot 1-3):
 *   - Does NOT start the emulator
 *   - Receives video stream, displays in <video> element
 *   - Captures keyboard/gamepad input, sends to host via data channel
 *
 * Spectator (slot null):
 *   - Receives video stream only, no input sent
 */

(function () {
  'use strict';

  const GAME_ID     = 'ssb64';
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Standard online cheats — applied on host only
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
    73: 12,   // I → C-Up     (mapped to analog)
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
  let _playerSlot        = -1;
  let _isSpectator       = false;
  let _peers             = {};     // remoteSid → {pc, dc, slot}
  let _knownPlayers      = {};
  let _hostStream        = null;   // MediaStream from canvas (host only)
  let _guestVideo        = null;   // <video> element (guest only)
  let _p1KeyMap          = null;
  let _heldKeys          = new Set();
  let _prevSlotMasks     = {};
  let _gameRunning       = false;

  // Expose for Playwright
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
      #guest-video { width:640px; height:480px; background:#000; display:block; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'np';
    panel.innerHTML = `
      <h3>Netplay (Streaming)</h3>
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
        sessionid: sessionId, userid: socket.id, playerId: socket.id,
        room_name: name + "'s room", game_id: GAME_ID,
        player_name: name, room_password: null,
        domain: window.location.hostname,
      },
      maxPlayers: 4, password: null,
    }, (err) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();
      setCode(sessionId);
      setStatus('Waiting for players…');
    });
  }

  function joinRoom() { _joinOrSpectate(false); }
  function spectateRoom() { _joinOrSpectate(true); }

  function _joinOrSpectate(spectate) {
    const name = document.getElementById('np-name').value.trim() || 'Player';
    const code = document.getElementById('np-join-code').value.trim().toUpperCase();
    if (!code) { setStatus('Enter a room code'); return; }

    sessionId    = code;
    _isSpectator = spectate;
    window._isSpectator = spectate;

    socket.emit('join-room', {
      extra: { sessionid: sessionId, userid: socket.id, player_name: name, spectate: spectate },
      password: null,
    }, (err, data) => {
      if (err) { setStatus('Error: ' + err); return; }
      disableButtons();
      if (!spectate && data && data.players) {
        const myEntry = Object.values(data.players).find(p => p.socketId === socket.id);
        if (myEntry) { _playerSlot = myEntry.slot; window._playerSlot = _playerSlot; }
      } else if (spectate) {
        _playerSlot = null; window._playerSlot = null;
      }
      setStatus(spectate ? 'Spectating…' : 'Joined — waiting for host stream…');
      // Guest: set up keyboard tracking immediately
      if (!spectate) setupKeyTracking();
    });
  }

  // ── users-updated (star topology) ──────────────────────────────────────

  function onUsersUpdated(data) {
    const players    = data.players    || {};
    const spectators = data.spectators || {};

    _knownPlayers = {};
    Object.values(players).forEach(p => {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    });

    const myPlayerEntry = Object.values(players).find(p => p.socketId === socket.id);
    if (myPlayerEntry) { _playerSlot = myPlayerEntry.slot; window._playerSlot = _playerSlot; }

    if (_playerSlot === 0) {
      // HOST: initiate connections to all non-host players and spectators
      const others = Object.values(players).filter(p => p.socketId !== socket.id);
      for (const p of others) {
        if (_peers[p.socketId]) { _peers[p.socketId].slot = p.slot; continue; }
        createPeer(p.socketId, p.slot, true);
        sendOffer(p.socketId);
      }
      for (const s of Object.values(spectators)) {
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }
    // Guests/spectators: wait for host to initiate (don't create connections)
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────

  function createPeer(remoteSid, remoteSlot, isInitiator) {
    const peer = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      dc: null,
      slot: remoteSlot,
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

    // Host: add video stream tracks BEFORE creating data channel / offer
    if (_playerSlot === 0 && _hostStream) {
      _hostStream.getTracks().forEach(track => {
        peer.pc.addTrack(track, _hostStream);
      });
      optimizeVideoEncoding(peer.pc);
    }

    // Guest/spectator: listen for incoming video tracks
    if (_playerSlot !== 0 || _isSpectator) {
      peer.pc.ontrack = (event) => {
        console.log('[netplay] received track:', event.track.kind);
        if (!_guestVideo) {
          _guestVideo = document.createElement('video');
          _guestVideo.id = 'guest-video';
          _guestVideo.autoplay = true;
          _guestVideo.playsInline = true;
          _guestVideo.muted = false;
          const gameDiv = document.getElementById('game');
          // Hide EJS UI, show video
          gameDiv.innerHTML = '';
          gameDiv.appendChild(_guestVideo);
        }
        _guestVideo.srcObject = event.streams[0];
        setStatus('🟢 Connected — streaming!');
      };
    }

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
    offer.sdp = setSDPBitrate(offer.sdp, 10000);
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer });
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    const senderSid = data.sender;
    if (!senderSid) return;

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
        if (!peer.pendingCandidates) peer.pendingCandidates = [];
        peer.pendingCandidates.push(data.candidate);
      }
    }
  }

  async function drainCandidates(peer) {
    peer.remoteDescSet = true;
    if (peer.pendingCandidates) {
      for (const c of peer.pendingCandidates) {
        try { await peer.pc.addIceCandidate(c); } catch (_) {}
      }
      peer.pendingCandidates = [];
    }
  }

  // ── Data channel ───────────────────────────────────────────────────────

  function setupDataChannel(remoteSid, ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      const peer = _peers[remoteSid];
      console.log('[netplay] DC open with', remoteSid, 'slot:', peer ? peer.slot : '?');

      if (_playerSlot === 0) {
        // Host: if emulator isn't started yet, start it now
        if (!_gameRunning) startHost();
      } else if (!_isSpectator) {
        // Guest: start sending input
        startGuestInputLoop();
      }
    };

    ch.onclose = () => {
      console.log('[netplay] DC closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => console.log('[netplay] DC error:', remoteSid, e);

    ch.onmessage = (e) => {
      if (_playerSlot !== 0) return;  // only host processes input
      const peer = _peers[remoteSid];
      if (!peer || peer.slot === null || peer.slot === undefined) return;

      // Guest sends Int32Array([inputMask]) — 4 bytes
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 4) {
        const mask = new Int32Array(e.data)[0];
        applyInputForSlot(peer.slot, mask);
      }
    };
  }

  function handlePeerDisconnect(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    // Zero their input if they were a player
    if (_playerSlot === 0 && peer.slot !== null && peer.slot !== undefined) {
      applyInputForSlot(peer.slot, 0);
    }
    delete _peers[remoteSid];
    window._peers = _peers;
    console.log('[netplay] peer disconnected:', remoteSid);
  }

  // ── Host: emulator + stream ────────────────────────────────────────────

  function startHost() {
    if (_gameRunning) return;
    _gameRunning = true;
    setStatus('Starting emulator…');
    triggerEmulatorStart();
    applyStandardCheats();
    setupKeyTracking();
    disableEJSKeyboard();

    // Wait for emulator to be running, then capture canvas stream
    const waitForEmu = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(waitForEmu, 100); return; }
      console.log('[netplay] emulator running — capturing stream');

      // Find the canvas
      const canvas = document.querySelector('#game canvas');
      if (!canvas) { console.log('[netplay] canvas not found, retrying…'); setTimeout(waitForEmu, 200); return; }

      _hostStream = canvas.captureStream(60);
      console.log('[netplay] captured stream:', _hostStream.getTracks().map(t => t.kind));

      // Add tracks to all existing peer connections and optimize encoding
      Object.entries(_peers).forEach(([sid, peer]) => {
        _hostStream.getTracks().forEach(track => {
          peer.pc.addTrack(track, _hostStream);
        });
        optimizeVideoEncoding(peer.pc);
        renegotiate(sid);
      });

      setStatus('🟢 Hosting — game on!');
      startHostInputLoop();
    };
    waitForEmu();
  }

  async function renegotiate(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    try {
      const offer = await peer.pc.createOffer();
      // Munge SDP to set higher bitrate floor for video
      offer.sdp = setSDPBitrate(offer.sdp, 10000);  // 10 Mbps
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { target: remoteSid, offer });
    } catch (err) {
      console.log('[netplay] renegotiate failed:', err);
    }
  }

  function setSDPBitrate(sdp, bitrateKbps) {
    // Add b=AS: line after video m-line to set session-level bitrate
    const lines = sdp.split('\r\n');
    const result = [];
    let inVideo = false;
    for (const line of lines) {
      result.push(line);
      if (line.startsWith('m=video')) {
        inVideo = true;
      } else if (line.startsWith('m=') && !line.startsWith('m=video')) {
        inVideo = false;
      }
      // Add bitrate line right after the c= line in the video section
      if (inVideo && line.startsWith('c=')) {
        result.push('b=AS:' + bitrateKbps);
      }
    }
    return result.join('\r\n');
  }

  function optimizeVideoEncoding(pc) {
    // Force high bitrate and 60fps for low-latency game streaming.
    // WebRTC defaults are conservative and cap at ~40fps. We override:
    // - minBitrate prevents the bandwidth estimator from throttling too low
    // - maxFramerate = 60 is non-negotiable for game feel
    // - maintain-framerate tells the encoder to drop resolution, never FPS
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track && sender.track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 10_000_000;  // 10 Mbps ceiling
        params.encodings[0].maxFramerate = 60;
        // scaleResolutionDownBy = 1 means no downscaling from source
        params.encodings[0].scaleResolutionDownBy = 1.0;
        params.degradationPreference = 'maintain-framerate';
        sender.setParameters(params).then(() => {
          console.log('[netplay] video encoding optimized: 60fps, 10Mbps max');
        }).catch(err => {
          console.log('[netplay] setParameters failed:', err);
        });
      }
    }
  }

  function startHostInputLoop() {
    function tick() {
      requestAnimationFrame(tick);
      if (!_p1KeyMap) setupKeyTracking();
      const mask = readLocalInput();
      applyInputForSlot(0, mask);  // host is always slot 0

      // Debug overlay
      const dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        const playerCount = Object.keys(_peers).length + 1;
        dbg.textContent = 'Host | players:' + playerCount;
      }
    }
    tick();
  }

  // ── Guest: input sender ────────────────────────────────────────────────

  let _guestLoopStarted = false;

  function startGuestInputLoop() {
    if (_guestLoopStarted) return;
    _guestLoopStarted = true;

    function tick() {
      requestAnimationFrame(tick);
      if (!_p1KeyMap) setupKeyTracking();
      const mask = readLocalInput();

      // Send to host via data channel
      const hostPeer = Object.values(_peers).find(p => p.slot === 0);
      if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
        try { hostPeer.dc.send(new Int32Array([mask]).buffer); } catch (_) {}
      }

      // Debug overlay
      const dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        dbg.textContent = 'Guest (slot ' + _playerSlot + ') | streaming';
      }
    }
    tick();
  }

  // ── Cheats ─────────────────────────────────────────────────────────────

  function applyStandardCheats() {
    const attempt = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(attempt, 500); return; }
      try {
        SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code));
        console.log('[netplay] applied', SSB64_ONLINE_CHEATS.length, 'standard cheats');
      } catch (_) { setTimeout(attempt, 500); return; }
      setTimeout(() => { try { SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code)); } catch(_){} }, 2000);
      setTimeout(() => { try { SSB64_ONLINE_CHEATS.forEach((c, i) => gm.setCheat(i, 1, c.code)); } catch(_){} }, 5000);
    };
    attempt();
  }

  // ── Keyboard / input ───────────────────────────────────────────────────

  function setupKeyTracking() {
    if (_p1KeyMap) return;  // already set up

    // Try EJS controls first
    const ejs = window.EJS_emulator;
    if (ejs && ejs.controls && ejs.controls[0]) {
      _p1KeyMap = {};
      Object.entries(ejs.controls[0]).forEach(([btnIdx, binding]) => {
        const kc = binding && binding.value;
        if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
      });
    }

    // Fallback to hardcoded defaults
    if (!_p1KeyMap || Object.keys(_p1KeyMap).length === 0) {
      _p1KeyMap = Object.assign({}, DEFAULT_N64_KEYMAP);
    }

    // Only need to add listeners once
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

  function readLocalInput() {
    let mask = 0;
    const gp = navigator.getGamepads()[0];
    if (gp) {
      for (let i = 0; i < Math.min(gp.buttons.length, 32); i++) {
        if (gp.buttons[i].pressed) mask |= (1 << i);
      }
    }
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
    for (let i = 0; i < 16; i++) {
      const wasPressed = (prevMask >> i) & 1;
      const isPressed  = (inputMask >> i) & 1;
      if (wasPressed !== isPressed) gm.simulateInput(slot, i, isPressed);
    }
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
