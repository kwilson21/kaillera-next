/**
 * kaillera-next — Streaming Netplay Engine
 *
 * Single-emulator streaming mode: the host (slot 0) runs the emulator and
 * streams canvas video + audio to all guests and spectators via WebRTC.
 * Guests send their controller input back to the host over a DataChannel.
 * Zero desync by design — only one emulator instance exists.
 *
 * ── Network Topology ──────────────────────────────────────────────────────
 *
 *   Star topology centered on the host. The host initiates all WebRTC
 *   connections — guests and spectators wait for incoming offers. This
 *   is the opposite of lockstep mode (where lower slot initiates).
 *
 *   Host (slot 0):
 *     - Runs EmulatorJS, applies standard online cheats via KNShared
 *     - Captures the emulator's WebGL canvas by blitting it onto a
 *       smaller 640x480 2D canvas via drawImage() each frame. The 2D
 *       canvas is captured via captureStream(0) with manual frame
 *       control (requestFrame()). This avoids expensive GPU readback
 *       from the WebGL canvas — the drawImage blit is GPU-accelerated.
 *     - Captures emulator audio via AudioContext → MediaStreamDestination,
 *       adds the audio track to the host MediaStream so guests/spectators
 *       receive video + audio over the same RTCPeerConnection
 *     - Adds the MediaStream tracks to each peer's RTCPeerConnection
 *     - Reads its own input locally and applies via applyInputForSlot()
 *       which calls _simulate_input() on the WASM core
 *     - Receives guest input via DataChannel and applies the same way
 *
 *   Guest (slot 1-3):
 *     - Does NOT start the emulator — no WASM core loaded
 *     - Receives the host's video+audio stream and displays it in a
 *       <video> element inserted into the game container
 *     - Video starts muted for autoplay compliance; attempts programmatic
 *       unmute, falls back to a "tap to unmute" banner (iOS workaround)
 *     - Reads keyboard/gamepad input (or VirtualGamepad on mobile) and
 *       sends encoded input object (16 bytes) to the host over DC
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
 *     - Bitrate cap: b=AS:3000 added after video c= line
 *     - RTCRtpSender parameters: maxBitrate=2.5Mbps, maxFramerate=60,
 *       degradationPreference='maintain-framerate' (drop resolution, not FPS)
 *
 *   On the receiving side, jitter buffer is minimized:
 *     - playoutDelayHint = 0 (decode and display ASAP)
 *     - jitterBufferTarget = 0 (Chrome 114+)
 *
 * ── Input Path ────────────────────────────────────────────────────────────
 *
 *   Host reads input via setInterval(16) tick loop (not rAF — rAF throttles
 *   to ~1fps in background tabs). Uses readLocalInput() shared with lockstep
 *   (keyboard keyCode tracking + GamepadManager profiles + VirtualGamepad
 *   on mobile). All input is applied via applyInputForSlot() which calls
 *   _simulate_input() per button/axis. Only changed bits are written (diff
 *   against previous mask per slot). Guest input tick uses rAF since guests
 *   have no emulator to drive.
 *
 *   DataChannel config: { ordered: false, maxRetransmits: 0 } — unreliable
 *   delivery is acceptable for input since each message contains the full
 *   current state, not a delta. Dropped packets just mean one frame of stale
 *   input, which the next packet corrects.
 *
 * ── Connection Recovery ─────────────────────────────────────────────────
 *
 *   When a peer's ICE connection degrades (failed/disconnected state),
 *   the peer is cleaned up and a new connection can be established via
 *   the normal offer/answer flow (no renegotiation — unreliable on iOS).
 *   onconnectionstatechange handles cleanup when a peer fully disconnects.
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

  let socket = null;
  let _playerSlot = -1;
  let _isSpectator = false;
  let _peers = {}; // remoteSid → {pc, dc, slot}
  let _knownPlayers = {};
  let _hostStream = null; // MediaStream from canvas (host only)
  let _guestVideo = null; // <video> element (guest only)
  let _p1KeyMap = null;
  let _heldKeys = new Set();
  let _prevSlotInputs = {};
  let _gameRunning = false;
  let _hostInputInterval = null;
  let _cachedInfo = null;
  // Touch state lives in KNState.touchInput (shared with VirtualGamepad)
  let _audioStreamDest = null; // MediaStreamAudioDestinationNode (host only)

  // -- Sync log ring buffer (matches lockstep — uploaded on game end) --------
  const SYNC_LOG_MAX = 5000;
  const _syncLogRing = new Array(SYNC_LOG_MAX);
  let _syncLogHead = 0;
  let _syncLogCount = 0;
  let _syncLogSeq = 0;

  const _syncLog = (msg) => {
    _syncLogRing[_syncLogHead] = { seq: _syncLogSeq++, t: performance.now(), f: 0, msg };
    _syncLogHead = (_syncLogHead + 1) % SYNC_LOG_MAX;
    if (_syncLogCount < SYNC_LOG_MAX) _syncLogCount++;
    console.log(`[streaming] ${msg}`);
  };

  const exportSyncLog = () => {
    const lines = [];
    const start = _syncLogCount < SYNC_LOG_MAX ? 0 : _syncLogHead;
    for (let i = 0; i < _syncLogCount; i++) {
      const e = _syncLogRing[(start + i) % SYNC_LOG_MAX];
      lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
    }
    return lines.join('\n');
  };

  // Expose for Playwright
  window._playerSlot = _playerSlot;
  window._isSpectator = _isSpectator;
  KNState.peers = _peers;

  const setStatus = (msg) => {
    if (_config?.onStatus) _config.onStatus(msg);
    _syncLog(msg);
  };

  // ── users-updated (star topology) ──────────────────────────────────────

  const onUsersUpdated = (data) => {
    const players = data.players || {};
    const spectators = data.spectators || {};

    _knownPlayers = {};
    for (const p of Object.values(players)) {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    }

    const myPlayerEntry = Object.values(players).find((p) => p.socketId === socket.id);
    if (myPlayerEntry) {
      _playerSlot = myPlayerEntry.slot;
      window._playerSlot = _playerSlot;
    }

    if (_playerSlot === 0) {
      // HOST: initiate connections to all non-host players and spectators
      const others = Object.values(players).filter((p) => p.socketId !== socket.id);
      for (const p of others) {
        if (_peers[p.socketId]) {
          _peers[p.socketId].slot = p.slot;
          continue;
        }
        _syncLog(`new peer: ${p.socketId} slot=${p.slot} hostStream=${!!_hostStream}`);
        createPeer(p.socketId, p.slot, true);
        sendOffer(p.socketId);
      }
      for (const s of Object.values(spectators)) {
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        _syncLog(`new spectator peer: ${s.socketId}`);
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }
    // Guests/spectators: wait for host to initiate (don't create connections)

    // Notify controller
    if (_config?.onPlayersChanged) {
      _config.onPlayersChanged(data);
    }
  };

  // ── WebRTC ─────────────────────────────────────────────────────────────

  const createPeer = (remoteSid, remoteSlot, isInitiator) => {
    const peerGuard = (p) => _peers[remoteSid] === p;
    const peer = KNShared.createBasePeer(ICE_SERVERS, remoteSid, socket, peerGuard);
    peer.slot = remoteSlot;

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        if (_peers[remoteSid] !== peer) return;
        _syncLog(`peer ${remoteSid} connection ${s}`);
        handlePeerDisconnect(remoteSid);
      }
    };

    // Host: add video stream tracks BEFORE creating data channel / offer
    if (_playerSlot === 0 && _hostStream) {
      for (const track of _hostStream.getTracks()) {
        peer.pc.addTrack(track, _hostStream);
      }
      optimizeVideoEncoding(peer.pc);
    }

    // Guest/spectator: listen for incoming video tracks
    if (_playerSlot !== 0 || _isSpectator) {
      peer.pc.ontrack = (event) => {
        _syncLog(
          `received track: ${event.track.kind} streams=${event.streams.length} stream0tracks=${
            event.streams[0]
              ?.getTracks()
              .map((t) => t.kind + ':' + t.readyState)
              .join(',') ?? 'none'
          }`,
        );
        if (!_guestVideo) {
          _guestVideo = document.createElement('video');
          _guestVideo.id = 'guest-video';
          _guestVideo.autoplay = true;
          _guestVideo.playsInline = true;
          _guestVideo.muted = true;

          _guestVideo.disableRemotePlayback = true;
          _guestVideo.setAttribute('playsinline', '');

          _guestVideo.addEventListener('loadedmetadata', () => {
            _syncLog(`video loadedmetadata: ${_guestVideo.videoWidth}x${_guestVideo.videoHeight}`);
          });
          _guestVideo.addEventListener('canplay', () => {
            _syncLog(`video canplay: paused=${_guestVideo.paused} readyState=${_guestVideo.readyState}`);
            const rect = _guestVideo.getBoundingClientRect();
            const cs = getComputedStyle(_guestVideo);
            _syncLog(
              `video layout: rect=${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.left)},${Math.round(rect.top)}) display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity} zIndex=${cs.zIndex}`,
            );
            const gameDiv = _guestVideo.parentElement;
            if (gameDiv) {
              const gr = gameDiv.getBoundingClientRect();
              const gcs = getComputedStyle(gameDiv);
              _syncLog(
                `gameDiv layout: rect=${Math.round(gr.width)}x${Math.round(gr.height)} overflow=${gcs.overflow} display=${gcs.display} children=${gameDiv.children.length} childTags=${[...gameDiv.children].map((c) => c.tagName + (c.id ? '#' + c.id : '')).join(',')}`,
              );
            }
          });
          _guestVideo.addEventListener('stalled', () => {
            _syncLog('video stalled');
          });
          _guestVideo.addEventListener('error', () => {
            _syncLog(`video error: ${_guestVideo.error?.message ?? _guestVideo.error?.code ?? 'unknown'}`);
          });

          _guestVideo.addEventListener(
            'playing',
            () => {
              _syncLog(`video playing: ${_guestVideo.videoWidth}x${_guestVideo.videoHeight}`);
              // Don't programmatically unmute — on mobile this pauses the
              // video (autoplay policy: muted autoplay OK, unmute needs gesture).
              // Always show the banner and let the user tap to unmute.
              const banner = document.getElementById('unmute-banner');
              if (banner) {
                banner.classList.remove('hidden');
                const doUnmute = () => {
                  _guestVideo.muted = false;
                  // If unmuting paused the video (iOS), restart it
                  if (_guestVideo.paused) _guestVideo.play().catch(() => {});
                  banner.classList.add('hidden');
                  banner.removeEventListener('click', doUnmute);
                  document.removeEventListener('touchstart', doUnmute, true);
                };
                banner.addEventListener('click', doUnmute);
                document.addEventListener('touchstart', doUnmute, true);
              }
            },
            { once: true },
          );

          const gameDiv = (_config && _config.gameElement) || document.getElementById('game');
          gameDiv.innerHTML = '';
          gameDiv.appendChild(_guestVideo);
        }
        const stream = event.streams[0];
        _syncLog(
          `setting srcObject: tracks=${stream
            .getTracks()
            .map((t) => t.kind + ':' + t.readyState + ':' + t.enabled)
            .join(',')}`,
        );
        _guestVideo.srcObject = stream;
        _syncLog(
          `video after srcObject: paused=${_guestVideo.paused} readyState=${_guestVideo.readyState} networkState=${_guestVideo.networkState}`,
        );

        try {
          for (const recv of peer.pc.getReceivers()) {
            if (recv.track?.kind === 'video') {
              if ('playoutDelayHint' in recv) {
                recv.playoutDelayHint = 0;
                _syncLog('set playoutDelayHint = 0 (minimum jitter buffer)');
              }
              if ('jitterBufferTarget' in recv) {
                recv.jitterBufferTarget = 0;
                _syncLog('set jitterBufferTarget = 0');
              }
            }
          }
        } catch (e) {
          _syncLog(`jitter buffer config failed: ${e}`);
        }

        setStatus('🟢 Connected — streaming!');

        // Delayed diagnostic — check video state 2s after track arrives
        setTimeout(() => {
          if (!_guestVideo) return;
          const r = _guestVideo.getBoundingClientRect();
          _syncLog(
            `video 2s check: paused=${_guestVideo.paused} readyState=${_guestVideo.readyState} videoW=${_guestVideo.videoWidth} videoH=${_guestVideo.videoHeight} rectW=${Math.round(r.width)} rectH=${Math.round(r.height)} currentTime=${_guestVideo.currentTime.toFixed(2)} inDOM=${!!_guestVideo.parentElement}`,
          );
        }, 2000);

        if (_guestVideo.requestVideoFrameCallback) {
          const measureLatency = (now, metadata) => {
            if (!_gameRunning) return;
            if (metadata.receiveTime && metadata.expectedDisplayTime) {
              const pipelineDelay = metadata.expectedDisplayTime - metadata.receiveTime;
              window._videoPipelineDelay = pipelineDelay.toFixed(1);
            }
            if (metadata.captureTime) {
              const e2eDelay = now - metadata.captureTime;
              window._videoE2EDelay = e2eDelay.toFixed(1);
            }
            _guestVideo.requestVideoFrameCallback(measureLatency);
          };
          _guestVideo.requestVideoFrameCallback(measureLatency);
        }
      };
    }

    _peers[remoteSid] = peer;
    KNState.peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('inputs', {
        ordered: false,
        maxRetransmits: 0,
      });
      setupDataChannel(remoteSid, peer.dc);
    } else {
      peer.pc.ondatachannel = (e) => {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      };
    }

    return peer;
  };

  const sendOffer = async (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    const offer = await peer.pc.createOffer();
    offer.sdp = preferCodecs(setSDPBitrate(offer.sdp, 3000));
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer });
  };

  const onWebRTCSignal = async (data) => {
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
        peer._offerCount = (peer._offerCount || 0) + 1;
        const hasVideo = data.offer.sdp?.includes('m=video') ?? false;
        _syncLog(`received offer #${peer._offerCount} from ${senderSid} (hasVideo=${hasVideo})`);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await KNShared.drainCandidates(peer);
        await KNShared.createAndSendAnswer(peer.pc, socket, senderSid);
      } else if (data.answer) {
        _syncLog(`received answer from ${senderSid}`);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await KNShared.drainCandidates(peer);
      } else if (data.candidate) {
        await KNShared.addBufferedCandidate(peer, data.candidate);
      }
    } catch (err) {
      _syncLog(`WebRTC signal error: ${err.message || err}`);
    }
  };

  // ── Data channel ───────────────────────────────────────────────────────

  const setupDataChannel = (remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      const peer = _peers[remoteSid];
      _syncLog(
        `DC open with ${remoteSid} slot=${peer ? peer.slot : '?'} mySlot=${_playerSlot} gameRunning=${_gameRunning} isSpectator=${_isSpectator}`,
      );

      if (_playerSlot === 0) {
        if (!_gameRunning) {
          _syncLog('DC open: starting host emulator');
          startHost();
        } else if (_hostStream) {
          // Late-joiner: host already streaming — add tracks if needed
          const lateJoinPeer = _peers[remoteSid];
          if (lateJoinPeer) {
            const hasTracks = lateJoinPeer.pc.getSenders().some((s) => s.track);
            if (!hasTracks) {
              _syncLog('DC open: adding stream to late-join peer');
              for (const track of _hostStream.getTracks()) {
                lateJoinPeer.pc.addTrack(track, _hostStream);
              }
              optimizeVideoEncoding(lateJoinPeer.pc);
              renegotiate(remoteSid);
            } else {
              _syncLog('DC open: late-join peer already has tracks');
            }
          }
        } else {
          _syncLog('DC open: host running but stream not ready');
        }
      } else if (!_isSpectator) {
        _syncLog('DC open: starting guest input loop');
        startGuestInputLoop();
      } else {
        _syncLog('DC open: spectator, no input loop');
      }
    };

    ch.onclose = () => {
      const current = _peers[remoteSid];
      if (!current || current.dc !== ch) return;
      _syncLog(`DC closed with ${remoteSid}`);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => _syncLog(`DC error: ${remoteSid} ${e?.error?.message || e?.error || e}`);

    ch.onmessage = (e) => {
      if (_playerSlot !== 0) return; // only host processes input
      const peer = _peers[remoteSid];
      if (!peer || peer.slot === null || peer.slot === undefined) return;

      // Guest sends encoded input object — 16 bytes
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 16) {
        const decoded = KNShared.decodeInput(e.data);
        applyInputForSlot(peer.slot, {
          buttons: decoded.buttons,
          lx: decoded.lx,
          ly: decoded.ly,
          cx: decoded.cx,
          cy: decoded.cy,
        });
      }
    };
  };

  const handlePeerDisconnect = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    // Zero their input if they were a player
    if (_playerSlot === 0 && peer.slot !== null && peer.slot !== undefined) {
      applyInputForSlot(peer.slot, KNShared.ZERO_INPUT);
    }
    // Close the RTCPeerConnection to release OS sockets and media resources.
    // Without this, each disconnect leaks an open PC (DTLS, ICE agent, encoders).
    if (peer.dc)
      try {
        peer.dc.close();
      } catch (_) {}
    if (peer.pc)
      try {
        peer.pc.close();
      } catch (_) {}
    delete _peers[remoteSid];
    KNState.peers = _peers;
    _syncLog(`peer disconnected: ${remoteSid}`);
  };

  // ── Host: emulator + stream ────────────────────────────────────────────

  const startHost = () => {
    if (_gameRunning) return;
    _gameRunning = true;
    setStatus('Starting emulator…');
    KNShared.bootWithCheats('streaming');
    setupKeyTracking();

    const MIN_HOST_FRAMES = 10;
    const waitForEmu = () => {
      if (!_gameRunning) return;
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) {
        setTimeout(waitForEmu, 100);
        return;
      }

      const frames = gm.Module?._get_current_frame_count?.() ?? 0;
      if (frames < MIN_HOST_FRAMES) {
        setTimeout(waitForEmu, 100);
        return;
      }
      _syncLog(`emulator running (${frames} frames) — capturing stream`);

      const srcCanvas = document.querySelector('#game canvas');
      if (!srcCanvas) {
        _syncLog('canvas not found, retrying…');
        setTimeout(waitForEmu, 200);
        return;
      }

      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = 640;
      captureCanvas.height = 480;
      const ctx = captureCanvas.getContext('2d');

      _syncLog(`source canvas: ${srcCanvas.width}x${srcCanvas.height} → capture canvas: 640x480`);

      // Safari's captureStream(0) + requestFrame() is broken in some versions —
      // frames never get pushed. Use auto-capture as primary, with requestFrame
      // as a bonus hint when available.
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      _hostStream = captureCanvas.captureStream(isSafari ? 60 : 0);
      const captureTrack = _hostStream.getVideoTracks()[0];

      let _blitCount = 0;
      const blitFrame = () => {
        if (!_gameRunning) return;
        requestAnimationFrame(blitFrame);
        ctx.drawImage(srcCanvas, 0, 0, 640, 480);
        if (captureTrack.requestFrame) captureTrack.requestFrame();
        if (++_blitCount === 60) {
          _syncLog(
            `blit 60 frames, captureTrack: ${captureTrack.readyState} enabled=${captureTrack.enabled} muted=${captureTrack.muted}`,
          );
        }
      };
      blitFrame();

      _syncLog(`capture stream started (640x480 ${isSafari ? 'auto' : 'manual'} capture)`);

      captureEmulatorAudio();

      // Add tracks to all existing peers and renegotiate so guests
      // receive the video+audio stream.
      for (const [sid, peer] of Object.entries(_peers)) {
        for (const track of _hostStream.getTracks()) {
          peer.pc.addTrack(track, _hostStream);
        }
        optimizeVideoEncoding(peer.pc);
        renegotiate(sid);
      }

      setStatus('🟢 Hosting — game on!');
      startHostInputLoop();

      if (!_audioStreamDest) {
        let audioAttempts = 0;
        const waitForAudio = () => {
          if (!_gameRunning) return;
          if (captureEmulatorAudio()) return;
          if (++audioAttempts < 150) setTimeout(waitForAudio, 200);
          else _syncLog('audio capture timed out — streaming video only');
        };
        waitForAudio();
      }
    };
    waitForEmu();
  };

  const renegotiate = async (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    try {
      const offer = await peer.pc.createOffer();
      offer.sdp = preferCodecs(setSDPBitrate(offer.sdp, 3000));
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { target: remoteSid, offer });
    } catch (err) {
      _syncLog(`renegotiate failed: ${err}`);
    }
  };

  const setSDPBitrate = (sdp, bitrateKbps) => {
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
        result.push(`b=AS:${bitrateKbps}`);
      }
    }
    return result.join('\r\n');
  };

  const preferCodecs = (sdp) => {
    // Reorder video codecs in the SDP m-line for optimal encoding.
    // Preference: VP9 (best compression, some HW support) → H264 (good HW
    // support via VideoToolbox/NVENC) → VP8 (software fallback).
    // The browser picks the first mutually supported codec.
    const lines = sdp.split('\r\n');

    // Collect all video codec payload types from a=rtpmap lines
    const codecPts = {}; // codec name → payload type
    for (const line of lines) {
      const m = line.match(/^a=rtpmap:(\d+) (VP9|H264|VP8)\//i);
      if (m) {
        const name = m[2].toUpperCase();
        if (!codecPts[name]) codecPts[name] = m[1]; // keep first match
      }
    }

    // Build preferred order: H264 first for mobile compatibility.
    // iOS WebKit (FxiOS/Safari) has guaranteed H264 HW decode but
    // spotty VP9 WebRTC support — VP9 tracks may never deliver frames.
    const preferred = [];
    if (codecPts['H264']) preferred.push(codecPts['H264']);
    if (codecPts['VP9']) preferred.push(codecPts['VP9']);

    if (preferred.length === 0) return sdp; // no preferred codecs found

    return lines
      .map((line) => {
        if (line.startsWith('m=video')) {
          const parts = line.split(' ');
          const header = parts.slice(0, 3);
          const pts = parts.slice(3);
          // Put preferred codecs first, then the rest in original order
          const prefSet = new Set(preferred);
          const rest = pts.filter((p) => !prefSet.has(p));
          return [...header, ...preferred, ...rest].join(' ');
        }
        return line;
      })
      .join('\r\n');
  };

  const optimizeVideoEncoding = async (pc) => {
    // Set bitrate cap and 60fps for low-latency game streaming.
    // WebRTC defaults are conservative and cap at ~40fps. We override:
    // - minBitrate prevents the bandwidth estimator from throttling too low
    // - maxFramerate = 60 is non-negotiable for game feel
    // - maintain-framerate tells the encoder to drop resolution, never FPS
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 2_500_000; // 2.5 Mbps (ample for 640x480 N64)
        params.encodings[0].maxFramerate = 60;
        // No scaleResolutionDownBy needed — capture canvas is already 640x480
        params.degradationPreference = 'maintain-framerate';
        try {
          await sender.setParameters(params);
          _syncLog('video encoding optimized: 60fps, 2.5Mbps max');
        } catch (err) {
          _syncLog(`setParameters failed: ${err}`);
        }
      }
    }
  };

  const startHostInputLoop = () => {
    let _debugFrame = 0;
    const tick = () => {
      if (!_p1KeyMap) setupKeyTracking();
      const localInput = readLocalInput();
      applyInputForSlot(0, localInput);

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    };
    // Use setInterval instead of rAF — rAF throttles to ~1fps in background tabs,
    // which would starve all players if the host tabs away.
    _hostInputInterval = setInterval(tick, 16);
  };

  // ── Guest: input sender ────────────────────────────────────────────────

  let _guestLoopStarted = false;

  const startGuestInputLoop = () => {
    if (_guestLoopStarted) return;
    _guestLoopStarted = true;

    let _lastSentInput = KNShared.ZERO_INPUT;
    let _debugFrame = 0;
    const tick = () => {
      if (!_guestLoopStarted) return;
      requestAnimationFrame(tick);
      if (!_p1KeyMap) setupKeyTracking();
      const localInput = readLocalInput();

      // Only send when input changes — reduces DC overhead
      if (!KNShared.inputEqual(localInput, _lastSentInput)) {
        const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
        if (hostPeer?.dc?.readyState === 'open') {
          try {
            hostPeer.dc.send(KNShared.encodeInput(0, localInput).buffer);
          } catch (_) {}
          _lastSentInput = localInput;
        }
      }

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    };
    tick();
  };

  // ── Debug overlay ────────────────────────────────────────────────────────

  const gatherStats = async () => {
    const peers = _peers || {};
    const pc = Object.values(peers)[0]?.pc;
    const playerCount = Object.keys(peers).length + (_isSpectator ? 0 : 1);

    if (!pc) {
      return {
        mode: 'streaming',
        fps: 0,
        ping: null,
        playerCount,
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
      let fps = 0,
        codec = null,
        res = null,
        ping = null;
      let jitterVal = null,
        pktLost = 0,
        pktRecv = 0,
        dropped = null;
      let bitrate = null;
      let encodeTime = null,
        qualLimit = null;

      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          fps = s.framesPerSecond || 0;
          res = `${s.frameWidth || '?'}x${s.frameHeight || '?'}`;
          if (s.totalEncodeTime && s.framesEncoded && s.framesEncoded > 0) {
            encodeTime = parseFloat(((s.totalEncodeTime / s.framesEncoded) * 1000).toFixed(1));
          }
          if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') {
            qualLimit = s.qualityLimitationReason;
          }
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          fps = s.framesPerSecond || 0;
          res = `${s.frameWidth || '?'}x${s.frameHeight || '?'}`;
          jitterVal = s.jitter !== undefined ? parseFloat((s.jitter * 1000).toFixed(1)) : null;
          pktLost = s.packetsLost || 0;
          pktRecv = s.packetsReceived || 0;
          dropped = s.framesDropped || 0;
        }
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          ping = s.currentRoundTripTime !== undefined ? Math.round(s.currentRoundTripTime * 1000) : null;
          if (s.availableOutgoingBitrate) {
            bitrate = parseFloat((s.availableOutgoingBitrate / 1_000_000).toFixed(1));
          }
        }
        if (s.type === 'codec' && s.mimeType?.includes('video')) {
          codec = s.mimeType.replace('video/', '');
        }
      });

      const lossRate = pktRecv > 0 ? parseFloat(((pktLost / pktRecv) * 100).toFixed(1)) : 0;

      return {
        mode: 'streaming',
        fps,
        ping,
        playerCount,
        codec,
        resolution: res,
        encodeTime,
        bitrate,
        jitter: jitterVal,
        lossRate,
        dropped,
        qualLimit,
      };
    } catch (_) {
      return {
        mode: 'streaming',
        fps: 0,
        ping: null,
        playerCount,
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
  };

  const updateDebugOverlay = async () => {
    const dbg = document.getElementById('np-debug');
    if (!dbg) return;
    dbg.style.display = '';

    const info = await gatherStats();
    _cachedInfo = info;

    const role = _playerSlot === 0 ? 'Host' : `Guest (P${_playerSlot})`;

    if (!Object.values(_peers || {})[0]?.pc) {
      dbg.textContent = `${role} | players:${info.playerCount}`;
      return;
    }

    // Build display strings from the gathered info
    const fpsStr = info.fps || '?';
    const codecStr = info.codec || '?';
    const resStr = info.resolution || '?';
    const rttStr = info.ping !== null ? `${info.ping}ms` : '?';
    const qualLimitStr = info.qualLimit ? ` [${info.qualLimit}]` : '';

    const line1 = `${role} | ${codecStr} ${resStr} ${fpsStr}fps${qualLimitStr}`;
    let line2;
    if (_playerSlot === 0) {
      // Host: show encode time, send bitrate
      const encStr = info.encodeTime !== null ? `${info.encodeTime}ms` : '?';
      const bwStr = info.bitrate !== null ? `${info.bitrate}Mbps` : '?';
      line2 = `rtt:${rttStr} encode:${encStr} bw:${bwStr} | players:${info.playerCount}`;
    } else {
      // Guest: show jitter, packet loss, pipeline delay, e2e delay
      const jitterStr = info.jitter !== null ? `${info.jitter}ms` : '?';
      const lossStr = info.lossRate !== null ? `${info.lossRate}%` : '0%';
      const pipeline = window._videoPipelineDelay ? `${window._videoPipelineDelay}ms` : '?';
      const e2e = window._videoE2EDelay ? `${window._videoE2EDelay}ms` : '?';
      line2 = `rtt:${rttStr} jitter:${jitterStr} pipeline:${pipeline} e2e:${e2e} loss:${lossStr} dropped:${info.dropped !== null ? info.dropped : 0}`;
    }
    dbg.textContent = `${line1}\n${line2}`;
    dbg.style.whiteSpace = 'pre';
  };

  // ── Keyboard / input ───────────────────────────────────────────────────

  const setupKeyTracking = () => {
    _p1KeyMap = KNShared.setupKeyTracking(_p1KeyMap, _heldKeys);
  };

  // ── Audio capture for streaming ──────────────────────────────────────
  // Connects the emulator's OpenAL master gain node to a MediaStreamDestination
  // so audio is included in the WebRTC stream to guests.

  const captureEmulatorAudio = () => {
    const gm = window.EJS_emulator?.gameManager;
    const mod = gm?.Module;
    if (!mod || !mod.AL || !mod.AL.contexts) return false;

    let alCtx = null;
    for (const id in mod.AL.contexts) {
      const c = mod.AL.contexts[id];
      if (c && c.audioCtx && c.audioCtx.state !== 'closed' && c.gain) {
        alCtx = c;
        break;
      }
    }
    if (!alCtx) return false;

    try {
      _audioStreamDest = alCtx.audioCtx.createMediaStreamDestination();
      alCtx.gain.connect(_audioStreamDest);

      const audioTrack = _audioStreamDest.stream.getAudioTracks()[0];
      if (audioTrack && _hostStream) {
        _hostStream.addTrack(audioTrack);
        _syncLog('added audio track to host stream');
        return true;
      }
    } catch (e) {
      _syncLog(`audio capture failed: ${e.message}`);
    }
    return false;
  };

  const readLocalInput = () => KNShared.readLocalInput(_playerSlot, _p1KeyMap, _heldKeys);

  const applyInputForSlot = (slot, input) => {
    KNShared.applyInputToWasm(slot, input, _prevSlotInputs);
  };

  // -- Init / Stop API -------------------------------------------------------

  let _config = null;

  const init = (config) => {
    _config = config;
    socket = config.socket;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    window._playerSlot = _playerSlot;
    window._isSpectator = _isSpectator;

    // Register socket listeners
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);

    if (!_isSpectator && _playerSlot !== 0) {
      setupKeyTracking();
    }

    // Host: apply cheats + disable EJS input at boot (same as lockstep).
    if (_playerSlot === 0) {
      KNShared.bootWithCheats('streaming');
    }

    // Process current peers immediately
    if (config.initialPlayers) {
      onUsersUpdated(config.initialPlayers);
    }
    // startHost() / startGuestInputLoop() triggered from ch.onopen

    // Virtual gamepad for mobile streaming guests
    if (config.isMobile && !_isSpectator && _playerSlot !== 0 && window.VirtualGamepad) {
      const gameEl = config.gameElement || document.getElementById('game');
      if (gameEl) {
        VirtualGamepad.init(gameEl);
        gameEl.style.margin = '0';
        // If a physical gamepad is already connected, hide virtual controls immediately
        const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
        if (detected.length > 0) VirtualGamepad.setVisible(false);
      }
    }
  };

  const stop = () => {
    _gameRunning = false;
    _guestLoopStarted = false;
    _cachedInfo = null;
    if (_hostInputInterval) {
      clearInterval(_hostInputInterval);
      _hostInputInterval = null;
    }

    // Close all peer connections
    for (const sid of Object.keys(_peers)) {
      const p = _peers[sid];
      if (p.dc)
        try {
          p.dc.close();
        } catch (_) {}
      if (p.pc)
        try {
          p.pc.close();
        } catch (_) {}
    }
    _peers = {};
    KNState.peers = _peers;

    // Clean up audio capture
    if (_audioStreamDest) {
      try {
        _audioStreamDest.disconnect();
      } catch (_) {}
      _audioStreamDest = null;
    }

    // Clean up streams
    if (_hostStream) {
      for (const t of _hostStream.getTracks()) {
        t.stop();
      }
      _hostStream = null;
    }
    if (_guestVideo) {
      _guestVideo.srcObject = null;
      if (_guestVideo.parentNode) _guestVideo.parentNode.removeChild(_guestVideo);
      _guestVideo = null;
    }
    const unmuteBanner = document.getElementById('unmute-banner');
    if (unmuteBanner) unmuteBanner.classList.add('hidden');

    _heldKeys.clear();
    _knownPlayers = {};
    _prevSlotInputs = {};
    _p1KeyMap = null;

    // Remove socket listeners (no data-message — streaming doesn't use it)
    if (socket) {
      socket.off('users-updated', onUsersUpdated);
      socket.off('webrtc-signal', onWebRTCSignal);
    }

    // Clean up virtual gamepad
    if (window.VirtualGamepad) {
      VirtualGamepad.destroy();
    }
    for (const ck in KNState.touchInput) {
      if (Object.prototype.hasOwnProperty.call(KNState.touchInput, ck)) delete KNState.touchInput[ck];
    }

    // Reset sync log for next game
    _syncLogHead = 0;
    _syncLogCount = 0;
    _syncLogSeq = 0;

    _config = null;
  };

  window.NetplayStreaming = {
    init,
    stop,
    exportSyncLog,
    getInfo: () => _cachedInfo,
    getPeerConnection: (sid) => {
      const p = _peers[sid];
      return p ? p.pc : null;
    },
  };
})();
