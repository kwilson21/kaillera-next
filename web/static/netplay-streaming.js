/**
 * kaillera-next — Streaming Netplay Engine
 *
 * Single-emulator streaming mode: the host (slot 0) runs the emulator and
 * streams the canvas video to all guests and spectators via WebRTC. Guests
 * send their controller input back to the host over a DataChannel. Zero
 * desync by design — only one emulator instance exists.
 *
 * ── Network Topology ──────────────────────────────────────────────────────
 *
 *   Star topology centered on the host. The host initiates all WebRTC
 *   connections — guests and spectators wait for incoming offers. This
 *   is the opposite of lockstep mode (where lower slot initiates).
 *
 *   Host (slot 0):
 *     - Runs EmulatorJS, applies game cheats
 *     - Captures the emulator's WebGL canvas by blitting it onto a
 *       smaller 640x480 2D canvas via drawImage() each frame. The 2D
 *       canvas is captured via captureStream(0) with manual frame
 *       control (requestFrame()). This avoids expensive GPU readback
 *       from the WebGL canvas — the drawImage blit is GPU-accelerated.
 *     - Adds the MediaStream video track to each peer's RTCPeerConnection
 *     - Reads its own input locally and applies via simulateInput()
 *     - Receives guest input via DataChannel and applies via simulateInput()
 *
 *   Guest (slot 1-3):
 *     - Does NOT start the emulator — no WASM core loaded
 *     - Receives the host's video stream and displays it in a <video>
 *       element inserted into the game container
 *     - Reads keyboard/gamepad input and sends Int32Array([inputMask])
 *       (4 bytes) to the host over the DataChannel
 *     - Only sends when input changes (delta encoding) to minimize
 *       DataChannel overhead
 *
 *   Spectator (slot null):
 *     - Same as guest but sends no input
 *
 * ── Video Encoding Optimization ───────────────────────────────────────────
 *
 *   SDP is munged before offer/answer to optimize for low-latency gaming:
 *     - Codec preference: VP9 → H264 → VP8 (reorders m-line payload types)
 *     - Bitrate floor: b=AS:10000 added after video c= line
 *     - RTCRtpSender parameters: maxBitrate=5Mbps, maxFramerate=60,
 *       degradationPreference='maintain-framerate' (drop resolution, not FPS)
 *
 *   On the receiving side, jitter buffer is minimized:
 *     - playoutDelayHint = 0 (decode and display ASAP)
 *     - jitterBufferTarget = 0 (Chrome 114+)
 *
 * ── Input Path ────────────────────────────────────────────────────────────
 *
 *   Host reads input via rAF-driven tick loop using the same readLocalInput()
 *   as lockstep (keyboard keyCode tracking + GamepadManager profiles). Guest
 *   input is applied via simulateInput() which is the EmulatorJS API for
 *   setting button/axis state per player slot. Only changed bits are written
 *   (diff against previous mask per slot).
 *
 *   DataChannel config: { ordered: false, maxRetransmits: 0 } — unreliable
 *   delivery is acceptable for input since each message contains the full
 *   current state, not a delta. Dropped packets just mean one frame of stale
 *   input, which the next packet corrects.
 *
 * ── Debug Overlay ─────────────────────────────────────────────────────────
 *
 *   Updated every 30 frames (~0.5s) via RTCPeerConnection.getStats().
 *   Host sees: codec, resolution, FPS, encode time, RTT, bandwidth.
 *   Guest sees: codec, resolution, FPS, RTT, jitter, pipeline delay,
 *   end-to-end delay (via requestVideoFrameCallback), packet loss, drops.
 */

(function () {
  'use strict';

  const ICE_SERVERS = window._iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }];

  // ── State ─────────────────────────────────────────────────────────────────

  let socket             = null;
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
  let _cachedInfo        = null;
  let _touchInputState   = {};     // virtual gamepad touch state (index → value)

  // Expose for Playwright
  window._playerSlot  = _playerSlot;
  window._isSpectator = _isSpectator;
  window._peers       = _peers;

  function setStatus(msg) {
    if (_config && _config.onStatus) _config.onStatus(msg);
    console.log('[netplay]', msg);
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

    // Notify controller
    if (_config && _config.onPlayersChanged) {
      _config.onPlayersChanged(data);
    }
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────

  function createPeer(remoteSid, remoteSlot, isInitiator) {
    const peer = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      dc: null,
      slot: remoteSlot,
    };

    peer.pc.onicecandidate = (e) => {
      if (e.candidate && _peers[remoteSid] === peer) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        if (_peers[remoteSid] !== peer) return;
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
          _guestVideo.muted = true;  // start muted so autoplay works without gesture

          // Minimize video decode/display latency:
          // - disableRemotePlayback: don't add cast overlay
          // - no buffering: play ASAP
          _guestVideo.disableRemotePlayback = true;
          _guestVideo.setAttribute('playsinline', '');

          // Unmute after playback starts
          _guestVideo.addEventListener('playing', () => {
            _guestVideo.muted = false;
          }, { once: true });

          const gameDiv = (_config && _config.gameElement) || document.getElementById('game');
          gameDiv.innerHTML = '';
          gameDiv.appendChild(_guestVideo);
        }
        _guestVideo.srcObject = event.streams[0];

        // Minimize jitter buffer: set minimum playout delay on the receiver.
        // The default jitter buffer adds 50-150ms of latency for smooth
        // playback on unreliable networks. For gaming we want minimum delay.
        try {
          const receivers = peer.pc.getReceivers();
          for (const recv of receivers) {
            if (recv.track && recv.track.kind === 'video') {
              // playoutDelayHint: target playout delay in seconds
              // 0 = minimum possible (decode and display ASAP)
              if ('playoutDelayHint' in recv) {
                recv.playoutDelayHint = 0;
                console.log('[netplay] set playoutDelayHint = 0 (minimum jitter buffer)');
              }
              // jitterBufferTarget: alternative API (Chrome 114+)
              if ('jitterBufferTarget' in recv) {
                recv.jitterBufferTarget = 0;
                console.log('[netplay] set jitterBufferTarget = 0');
              }
            }
          }
        } catch (e) {
          console.log('[netplay] jitter buffer config failed:', e);
        }

        setStatus('🟢 Connected — streaming!');

        // Measure actual display latency via requestVideoFrameCallback
        if (_guestVideo.requestVideoFrameCallback) {
          function measureLatency(now, metadata) {
            // metadata.receiveTime = when the frame was received from network
            // metadata.expectedDisplayTime = when browser plans to show it
            // The difference is the decode + display pipeline delay
            if (metadata.receiveTime && metadata.expectedDisplayTime) {
              const pipelineDelay = metadata.expectedDisplayTime - metadata.receiveTime;
              window._videoPipelineDelay = pipelineDelay.toFixed(1);
            }
            // metadata.captureTime is when the frame was captured (host side)
            if (metadata.captureTime) {
              const e2eDelay = now - metadata.captureTime;
              window._videoE2EDelay = e2eDelay.toFixed(1);
            }
            _guestVideo.requestVideoFrameCallback(measureLatency);
          }
          _guestVideo.requestVideoFrameCallback(measureLatency);
        }
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
    offer.sdp = preferCodecs(setSDPBitrate(offer.sdp, 10000));
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

    try {
      if (data.offer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await drainCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { target: senderSid, answer });
      } else if (data.answer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await drainCandidates(peer);
      } else if (data.candidate) {
        if (peer.remoteDescSet) {
          try { await peer.pc.addIceCandidate(data.candidate); } catch (_) {}
        } else {
          if (!peer.pendingCandidates) peer.pendingCandidates = [];
          peer.pendingCandidates.push(data.candidate);
        }
      }
    } catch (err) {
      console.log('[netplay] WebRTC signal error:', err.message || err);
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
      const current = _peers[remoteSid];
      if (!current || current.dc !== ch) return;
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
    KNShared.triggerEmulatorStart();
    KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);
    setupKeyTracking();
    disableEJSInput();

    // Wait for emulator to be running, then capture canvas stream
    const waitForEmu = () => {
      const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) { setTimeout(waitForEmu, 100); return; }
      console.log('[netplay] emulator running — capturing stream');

      // The emulator canvas is WebGL at 1280x960. Capturing it directly
      // requires expensive GPU readback (~5MB/frame). Instead, blit onto a
      // small 2D canvas (640x480) and capture THAT. The drawImage blit is
      // GPU-accelerated and the 2D canvas readback is much cheaper.
      const srcCanvas = document.querySelector('#game canvas');
      if (!srcCanvas) { console.log('[netplay] canvas not found, retrying…'); setTimeout(waitForEmu, 200); return; }

      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = 640;
      captureCanvas.height = 480;
      const ctx = captureCanvas.getContext('2d');

      console.log('[netplay] source canvas:', srcCanvas.width + 'x' + srcCanvas.height,
        '→ capture canvas: 640x480');

      // Blit loop: copy emulator canvas to capture canvas every frame
      _hostStream = captureCanvas.captureStream(0);  // manual frame control
      const captureTrack = _hostStream.getVideoTracks()[0];

      function blitFrame() {
        if (!_gameRunning) return;  // stop loop when game ends
        requestAnimationFrame(blitFrame);
        ctx.drawImage(srcCanvas, 0, 0, 640, 480);
        captureTrack.requestFrame();  // signal new frame to captureStream
      }
      blitFrame();

      console.log('[netplay] capture stream started (640x480 2D blit)');

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
      offer.sdp = preferCodecs(setSDPBitrate(offer.sdp, 10000));
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
      if (inVideo && line.startsWith('c=')) {
        result.push('b=AS:' + bitrateKbps);
      }
    }
    return result.join('\r\n');
  }

  function preferCodecs(sdp) {
    // Reorder video codecs in the SDP m-line for optimal encoding.
    // Preference: VP9 (best compression, some HW support) → H264 (good HW
    // support via VideoToolbox/NVENC) → VP8 (software fallback).
    // The browser picks the first mutually supported codec.
    const lines = sdp.split('\r\n');

    // Collect all video codec payload types from a=rtpmap lines
    const codecPts = {};  // codec name → payload type
    for (const line of lines) {
      const m = line.match(/^a=rtpmap:(\d+) (VP9|H264|VP8)\//i);
      if (m) {
        const name = m[2].toUpperCase();
        if (!codecPts[name]) codecPts[name] = m[1];  // keep first match
      }
    }

    // Build preferred order: VP9 first, then H264, then everything else
    const preferred = [];
    if (codecPts['VP9'])  preferred.push(codecPts['VP9']);
    if (codecPts['H264']) preferred.push(codecPts['H264']);

    if (preferred.length === 0) return sdp;  // no preferred codecs found

    return lines.map(line => {
      if (line.startsWith('m=video')) {
        const parts = line.split(' ');
        const header = parts.slice(0, 3);
        const pts = parts.slice(3);
        // Put preferred codecs first, then the rest in original order
        const prefSet = new Set(preferred);
        const rest = pts.filter(p => !prefSet.has(p));
        return [...header, ...preferred, ...rest].join(' ');
      }
      return line;
    }).join('\r\n');
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
        params.encodings[0].maxBitrate = 5_000_000;  // 5 Mbps (640x480 needs less)
        params.encodings[0].maxFramerate = 60;
        // No scaleResolutionDownBy needed — capture canvas is already 640x480
        params.degradationPreference = 'maintain-framerate';
        sender.setParameters(params).then(() => {
          console.log('[netplay] video encoding optimized: 60fps, 5Mbps max');
        }).catch(err => {
          console.log('[netplay] setParameters failed:', err);
        });
      }
    }
  }

  function startHostInputLoop() {
    let _debugFrame = 0;
    function tick() {
      requestAnimationFrame(tick);
      if (!_p1KeyMap) setupKeyTracking();
      const mask = readLocalInput();
      applyInputForSlot(0, mask);

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    }
    tick();
  }

  // ── Guest: input sender ────────────────────────────────────────────────

  let _guestLoopStarted = false;

  function startGuestInputLoop() {
    if (_guestLoopStarted) return;
    _guestLoopStarted = true;

    let _lastSentMask = -1;
    let _debugFrame = 0;
    function tick() {
      requestAnimationFrame(tick);
      if (!_p1KeyMap) setupKeyTracking();
      const mask = readLocalInput();

      // Only send when input changes — reduces DC overhead
      if (mask !== _lastSentMask) {
        const hostPeer = Object.values(_peers).find(p => p.slot === 0);
        if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
          try { hostPeer.dc.send(new Int32Array([mask]).buffer); } catch (_) {}
          _lastSentMask = mask;
        }
      }

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    }
    tick();
  }

  // ── Debug overlay ────────────────────────────────────────────────────────

  async function gatherStats() {
    const peers = _peers || {};
    const pc = Object.values(peers)[0]?.pc;
    const playerCount = Object.keys(peers).length + (_isSpectator ? 0 : 1);

    if (!pc) {
      return {
        mode: 'streaming',
        fps: 0,
        ping: null,
        playerCount: playerCount,
        codec: null,
        resolution: null,
        encodeTime: null,
        bitrate: null,
        jitter: null,
        lossRate: null,
        dropped: null,
        qualLimit: null,
      };
    }

    try {
      const stats = await pc.getStats();
      let fps = 0, codec = null, res = null, ping = null;
      let jitterVal = null, pktLost = 0, pktRecv = 0, dropped = null;
      let bitrate = null;
      let encodeTime = null, qualLimit = null;

      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          fps = s.framesPerSecond || 0;
          res = (s.frameWidth || '?') + 'x' + (s.frameHeight || '?');
          if (s.totalEncodeTime && s.framesEncoded && s.framesEncoded > 0) {
            encodeTime = parseFloat((s.totalEncodeTime / s.framesEncoded * 1000).toFixed(1));
          }
          if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') {
            qualLimit = s.qualityLimitationReason;
          }
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          fps = s.framesPerSecond || 0;
          res = (s.frameWidth || '?') + 'x' + (s.frameHeight || '?');
          jitterVal = s.jitter !== undefined ? parseFloat((s.jitter * 1000).toFixed(1)) : null;
          pktLost = s.packetsLost || 0;
          pktRecv = s.packetsReceived || 0;
          dropped = s.framesDropped || 0;
        }
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          ping = s.currentRoundTripTime !== undefined
            ? Math.round(s.currentRoundTripTime * 1000) : null;
          if (s.availableOutgoingBitrate) {
            bitrate = parseFloat((s.availableOutgoingBitrate / 1_000_000).toFixed(1));
          }
        }
        if (s.type === 'codec' && s.mimeType && s.mimeType.includes('video')) {
          codec = s.mimeType.replace('video/', '');
        }
      });

      const lossRate = pktRecv > 0 ? parseFloat((pktLost / pktRecv * 100).toFixed(1)) : 0;

      return {
        mode: 'streaming',
        fps: fps,
        ping: ping,
        playerCount: playerCount,
        codec: codec,
        resolution: res,
        encodeTime: encodeTime,
        bitrate: bitrate,
        jitter: jitterVal,
        lossRate: lossRate,
        dropped: dropped,
        qualLimit: qualLimit,
      };
    } catch (_) {
      return {
        mode: 'streaming',
        fps: 0,
        ping: null,
        playerCount: playerCount,
        codec: null,
        resolution: null,
        encodeTime: null,
        bitrate: null,
        jitter: null,
        lossRate: null,
        dropped: null,
        qualLimit: null,
      };
    }
  }

  async function updateDebugOverlay() {
    const dbg = document.getElementById('np-debug');
    if (!dbg) return;
    dbg.style.display = '';

    const info = await gatherStats();
    _cachedInfo = info;

    const role = _playerSlot === 0 ? 'Host' : 'Guest (P' + _playerSlot + ')';

    if (!Object.values(_peers || {})[0]?.pc) {
      dbg.textContent = role + ' | players:' + info.playerCount;
      return;
    }

    // Build display strings from the gathered info
    const fpsStr = info.fps || '?';
    const codecStr = info.codec || '?';
    const resStr = info.resolution || '?';
    const rttStr = info.ping !== null ? info.ping + 'ms' : '?';
    const qualLimitStr = info.qualLimit ? ' [' + info.qualLimit + ']' : '';

    const line1 = role + ' | ' + codecStr + ' ' + resStr + ' ' + fpsStr + 'fps' + qualLimitStr;
    let line2;
    if (_playerSlot === 0) {
      // Host: show encode time, send bitrate
      const encStr = info.encodeTime !== null ? info.encodeTime + 'ms' : '?';
      const bwStr = info.bitrate !== null ? info.bitrate + 'Mbps' : '?';
      line2 = 'rtt:' + rttStr + ' encode:' + encStr + ' bw:' + bwStr
        + ' | players:' + info.playerCount;
    } else {
      // Guest: show jitter, packet loss, pipeline delay, e2e delay
      const jitterStr = info.jitter !== null ? info.jitter + 'ms' : '?';
      const lossStr = info.lossRate !== null ? info.lossRate + '%' : '0%';
      const pipeline = window._videoPipelineDelay ? window._videoPipelineDelay + 'ms' : '?';
      const e2e = window._videoE2EDelay ? window._videoE2EDelay + 'ms' : '?';
      line2 = 'rtt:' + rttStr + ' jitter:' + jitterStr + ' pipeline:' + pipeline
        + ' e2e:' + e2e + ' loss:' + lossStr + ' dropped:' + (info.dropped !== null ? info.dropped : 0);
    }
    dbg.textContent = line1 + '\n' + line2;
    dbg.style.whiteSpace = 'pre';
  }

  // ── Keyboard / input ───────────────────────────────────────────────────

  function setupKeyTracking() {
    _p1KeyMap = KNShared.setupKeyTracking(_p1KeyMap, _heldKeys);
  }

  function disableEJSInput() {
    const attempt = () => {
      const ejs = window.EJS_emulator;
      const gm = ejs && ejs.gameManager;
      if (!gm) { setTimeout(attempt, 200); return; }

      // Disable EJS keyboard handling
      gm.setKeyboardEnabled(false);
      const parent = ejs.elements && ejs.elements.parent;
      if (parent) {
        const block = e => e.stopImmediatePropagation();
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup',   block, true);
      }

      // Disable EJS gamepad handling — stop its JS-level 10ms polling loop
      if (ejs.gamepad) {
        if (ejs.gamepad.timeout) clearTimeout(ejs.gamepad.timeout);
        ejs.gamepad.loop = function () {};
      }
    };
    attempt();
  }

  function readLocalInput() {
    let mask = 0;

    // Suppress all input while remap wizard is active (prevents desyncs)
    if (window._remapWizardActive) return 0;

    if (window.GamepadManager) {
      mask |= GamepadManager.readGamepad(_playerSlot);
    }
    if (_p1KeyMap) {
      _heldKeys.forEach(kc => {
        const btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }

    // Virtual gamepad touch input (same logic as lockstep readLocalInput)
    // Left stick (indices 16-19): apply absolute + relative deadzone
    var TOUCH_ABS_DEADZONE = 3500;
    var stR = _touchInputState[16] || 0;
    var stL = _touchInputState[17] || 0;
    var stD = _touchInputState[18] || 0;
    var stU = _touchInputState[19] || 0;
    var stMajor = Math.max(stR, stL, stD, stU);
    if (stMajor > TOUCH_ABS_DEADZONE) {
      var stThresh = stMajor * 0.4;
      if (stR > stThresh) mask |= (1 << 16);
      if (stL > stThresh) mask |= (1 << 17);
      if (stD > stThresh) mask |= (1 << 18);
      if (stU > stThresh) mask |= (1 << 19);
    }
    // Digital buttons + C-buttons
    for (var ti in _touchInputState) {
      var idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue;
      var val = _touchInputState[idx];
      if (!val) continue;
      if (idx < 16) {
        mask |= (1 << idx);
      } else if (idx >= 20 && idx <= 23) {
        if (val > 0) mask |= (1 << idx);
      }
    }

    return mask;
  }

  function applyInputForSlot(slot, inputMask) {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    const prevMask = _prevSlotMasks[slot] || 0;
    if (inputMask === prevMask) return;  // skip if unchanged — saves simulateInput calls
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

  // -- Init / Stop API -------------------------------------------------------

  let _config = null;

  function init(config) {
    _config = config;
    socket = config.socket;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    window._playerSlot = _playerSlot;
    window._isSpectator = _isSpectator;

    // Register socket listeners
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);

    // Guest: set up keyboard tracking immediately
    if (!_isSpectator && _playerSlot !== 0) {
      setupKeyTracking();
    }

    // Process current peers immediately
    if (config.initialPlayers) {
      onUsersUpdated(config.initialPlayers);
    }
    // startHost() / startGuestInputLoop() triggered from ch.onopen (same as before)

    // Virtual gamepad for mobile streaming guests
    if (config.isMobile && !_isSpectator && _playerSlot !== 0 && window.VirtualGamepad) {
      var gameEl = config.gameElement || document.getElementById('game');
      if (gameEl) {
        VirtualGamepad.init(gameEl, _touchInputState);
        gameEl.style.margin = '0';
        // If a physical gamepad is already connected, hide virtual controls immediately
        var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
        if (detected.length > 0) VirtualGamepad.setVisible(false);
      }
    }
  }

  function stop() {
    _gameRunning = false;
    _guestLoopStarted = false;
    _cachedInfo = null;

    // Close all peer connections
    Object.keys(_peers).forEach((sid) => {
      const p = _peers[sid];
      if (p.dc) try { p.dc.close(); } catch (_) {}
      if (p.pc) try { p.pc.close(); } catch (_) {}
    });
    _peers = {};
    window._peers = _peers;

    // Clean up streams
    if (_hostStream) {
      _hostStream.getTracks().forEach((t) => { t.stop(); });
      _hostStream = null;
    }
    if (_guestVideo) {
      _guestVideo.srcObject = null;
      if (_guestVideo.parentNode) _guestVideo.parentNode.removeChild(_guestVideo);
      _guestVideo = null;
    }

    _knownPlayers = {};
    _prevSlotMasks = {};

    // Remove socket listeners (no data-message — streaming doesn't use it)
    if (socket) {
      socket.off('users-updated', onUsersUpdated);
      socket.off('webrtc-signal', onWebRTCSignal);
    }

    // Clean up virtual gamepad
    if (window.VirtualGamepad) {
      VirtualGamepad.destroy();
    }
    _touchInputState = {};

    _config = null;
  }

  window.NetplayStreaming = {
    init: init,
    stop: stop,
    getInfo: () => _cachedInfo,
    getPeerConnection: function (sid) {
      var p = _peers[sid];
      return p ? p.pc : null;
    },
  };

})();
