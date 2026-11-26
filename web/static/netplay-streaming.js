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
 *     - Captures the emulator's WebGL canvas directly by default on
 *       non-Safari hosts for lowest latency. The guest renders it in the same
 *       4:3 footprint as the old blit path. Use ?streamCapture=blit to force
 *       the older normalized capture path.
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
 *       <video> element inside a #stream-overlay sibling of #game
 *       (avoids touching EJS DOM so the hibernated canvas survives)
 *     - Video starts muted for autoplay compliance; attempts programmatic
 *       unmute, falls back to a "tap to unmute" banner (iOS workaround)
 *     - Reads keyboard/gamepad input (or VirtualGamepad on mobile) and
 *       sends encoded input packet (currently 24 bytes) to the host over DC
 *     - Repeats input at 60Hz and queues an immediate send after local
 *       input events so the host sees changes before the next video frame
 *
 *   Spectator (slot null):
 *     - Same as guest but sends no input
 *
 * ── Video Encoding Optimization ───────────────────────────────────────────
 *
 *   SDP is munged before offer/answer to optimize for low-latency gaming:
 *     - Codec preference: H264 > VP9 > VP8 — H264 preferred for mobile HW decode (reorders m-line payload types)
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
 *   against previous mask per slot). Guest input uses a 60Hz setInterval
 *   plus event-triggered sends for the lowest practical input latency.
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

  const _getIceServers = () => window._iceServers || KNState.DEFAULT_ICE_SERVERS;
  const STREAM_CAPTURE_FPS = 60;
  const STREAM_CAPTURE_FRAME_MS = 1000 / STREAM_CAPTURE_FPS;
  const STREAMING_CORE_FPS_SAMPLE_MS = 1000;

  // ── State ─────────────────────────────────────────────────────────────────

  let socket = null;
  let _playerSlot = -1;
  let _isSpectator = false;
  let _peers = {}; // remoteSid → {pc, dc, slot}
  let _knownPlayers = {};
  let _knownSpectators = new Set(); // spectators' socket ids on the last roster
  let _hostStream = null; // MediaStream from canvas (host only)
  let _guestVideo = null; // <video> element (guest only)
  let _p1KeyMap = null;
  let _heldKeys = new Set();
  let _prevSlotInputs = {};
  let _gameRunning = false;
  let _hostInputInterval = null;
  let _hostInputAbort = null;
  let _hostFrameRateWatchdog = null;
  let _hostFrameRateResetCooldownUntil = 0;
  let _guestInputInterval = null;
  let _guestInputAbort = null;
  let _cachedInfo = null;
  let _captureMode = 'none';
  let _captureScaleDownBy = 1;
  let _lastControllerPresentMask = -1;
  let _lastControllerPresentMaskModule = null;
  // Touch state lives in KNState.touchInput (shared with VirtualGamepad)
  let _audioStreamDest = null; // MediaStreamAudioDestinationNode (host only)
  let _unmuteAbort = null; // AbortController for the unmute-banner gesture listeners; cleared in stop()

  // The match owns its log epoch through its last acknowledged upload.
  const SYNC_LOG_MAX = 5000;
  let _syncLogRing = KNShared.createSyncLogRing(SYNC_LOG_MAX);
  let _logUpload = null;

  const _syncLog = (msg) => {
    _syncLogRing.push({ t: performance.now(), f: 0, msg });
    console.log(`[streaming] ${msg}`);
  };

  const exportSyncLog = () => _syncLogRing.export();

  const startSessionLog = (config) => {
    if (config.isSpectator || config.playerSlot == null || !config.matchId) return null;
    const { matchId, playerName, playerSlot: slot, sessionId: room, socket: connection } = config;
    const boundary = window.KNCore.protocol.createBoundary((line) => console.warn(line));
    let token = config.uploadToken;
    const started = performance.now();
    return _rules.startLogUpload(_syncLogRing, async (epoch, entries, mode) => {
      if (_config === config && KNState.uploadToken) token = KNState.uploadToken;
      const payload = {
        matchId,
        playerName,
        slot,
        mode: 'streaming',
        epoch,
        entries,
        summary: { duration_sec: Math.round((performance.now() - started) / 1000) },
      };
      if (mode === 'regular' && connection.connected) {
        const ack = await new Promise((resolve) => {
          connection.timeout(4000).emit('session-log', payload, (err, value) => resolve(err ? null : value));
        });
        const accepted = ack && boundary.ack('session-log', ack);
        if (accepted) return accepted.lastSeq;
      }
      if (!token || !room) return -1;
      const body = mode === 'exit' ? window.KNCore.sessionLogKeepaliveBody(payload, 'exit') : JSON.stringify(payload);
      if (body === null) return -1;
      const response = await fetch(
        `/api/session-log?token=${encodeURIComponent(token)}&room=${encodeURIComponent(room)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: mode === 'exit',
        },
      );
      if (!response.ok) return -1;
      return boundary.ack('session-log', await response.json())?.lastSeq ?? -1;
    });
  };
  const flushSyncLog = ({ keepalive = false } = {}) => _logUpload?.flush(keepalive);

  // Expose for Playwright
  window._playerSlot = _playerSlot;
  window._isSpectator = _isSpectator;
  KNState.peers = _peers;

  const setStatus = (msg) => {
    if (_config?.onStatus) _config.onStatus(msg);
    _syncLog(msg);
  };

  // The streaming rules (web/src/streaming, KNCore.streaming): this engine
  // asks them at each decision and carries out the answer. kn-core.js loads
  // before this file, and the page stops if it did not load.
  const _rules = window.KNCore.streaming;

  // This page's port, and every player's it knows from the roster or holds a connection for.
  const _controllerPresentMask = () =>
    _rules.controllerPresentMask(_playerSlot, [
      ...Object.values(_knownPlayers).map((info) => info?.slot),
      ...Object.values(_peers).map((peer) => peer?.slot),
    ]);

  const _applyControllerPresentMask = (reason = 'tick') => {
    if (_playerSlot !== 0) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_set_controller_present_mask) return;
    const mask = _controllerPresentMask();
    if (!mask) return;
    if (mod === _lastControllerPresentMaskModule && mask === _lastControllerPresentMask) return;
    _lastControllerPresentMaskModule = mod;
    _lastControllerPresentMask = mask;
    mod._kn_set_controller_present_mask(mask);
    _syncLog(`controller present mask (${reason}): 0x${mask.toString(16)}`);
  };

  const _resetControllerPresentMask = () => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (mod?._kn_set_controller_present_mask) mod._kn_set_controller_present_mask(0x0f);
    _lastControllerPresentMask = -1;
    _lastControllerPresentMaskModule = null;
  };

  const _normalizeStreamingTiming = (reason = 'start') => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return false;

    try {
      // Lockstep owns deterministic timing; streaming should return to normal
      // RetroArch pacing with fast-forward and slow-motion explicitly off.
      window._kn_inStep = false;
      window._kn_frameTime = 0;
      window._kn_useRelativeCycles = false;
      mod._kn_set_deterministic?.(0);
      mod._kn_set_normalize_events?.(0);
      mod._kn_set_drain_interrupts?.(0);
      mod._toggle_fastforward?.(0);
      mod._toggle_slow_motion?.(0);
      mod._set_ff_ratio?.(1);
      mod._set_sm_ratio?.(1);
      mod._set_vsync?.(1);
      _syncLog(`streaming timing normalized (${reason})`);
      return true;
    } catch (err) {
      _syncLog(`streaming timing normalize failed (${reason}): ${err?.message || err}`);
      return false;
    }
  };

  const _resetStreamingMainLoop = (reason) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.resumeMainLoop) return false;

    try {
      mod.pauseMainLoop?.();
    } catch (err) {
      _syncLog(`streaming main loop pause failed (${reason}): ${err?.message || err}`);
    }

    const resume = () => {
      if (!_gameRunning) return;
      if (window.EJS_emulator?.gameManager?.Module !== mod) return;
      try {
        mod.resumeMainLoop();
        _syncLog(`streaming main loop reset (${reason})`);
      } catch (err) {
        _syncLog(`streaming main loop resume failed (${reason}): ${err?.message || err}`);
      }
    };

    const nativeRAF = window.APISandbox?.nativeRAF;
    if (typeof nativeRAF === 'function') nativeRAF(resume);
    else if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(resume);
    else setTimeout(resume, 0);
    return true;
  };

  const stopHostFrameRateWatchdog = () => {
    if (_hostFrameRateWatchdog) {
      clearInterval(_hostFrameRateWatchdog);
      _hostFrameRateWatchdog = null;
    }
  };

  const startHostFrameRateWatchdog = () => {
    stopHostFrameRateWatchdog();
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._get_current_frame_count) return;

    let lastFrame = mod._get_current_frame_count() || 0;
    let lastAt = performance.now();
    _hostFrameRateWatchdog = setInterval(() => {
      if (!_gameRunning) return;
      const currentMod = window.EJS_emulator?.gameManager?.Module;
      if (currentMod !== mod) {
        stopHostFrameRateWatchdog();
        return;
      }

      const now = performance.now();
      const frame = mod._get_current_frame_count?.() || 0;
      const elapsed = now - lastAt;
      const delta = frame - lastFrame;
      lastAt = now;
      lastFrame = frame;
      if (!_rules.coreFpsReset(elapsed, delta, now, _hostFrameRateResetCooldownUntil)) return;

      const fps = (delta * 1000) / elapsed;
      _hostFrameRateResetCooldownUntil = now + _rules.CORE_FPS_RESET_COOLDOWN_MS;
      _syncLog(`streaming core fps high (${fps.toFixed(1)}); resetting main loop`);
      _normalizeStreamingTiming('fps-watchdog');
      _resetStreamingMainLoop('fps-watchdog');
    }, STREAMING_CORE_FPS_SAMPLE_MS);
  };

  // ── users-updated (star topology) ──────────────────────────────────────

  const onUsersUpdated = (data) => {
    const players = data.players || {};
    const spectators = data.spectators || {};
    // This page's slot, and the connection table afterwards
    // (KNCore.streaming.hostRosterPlan): only the host offers, to every
    // player and spectator it holds no connection for; a guest or spectator
    // waits to be offered to.
    const plan = _rules.hostRosterPlan({
      mySid: socket.id,
      mySlot: _playerSlot,
      players: Object.values(players),
      spectators: Object.values(spectators),
      connections: Object.entries(_peers).map(([sid, peer]) => ({ sid, slot: peer.slot })),
      live: _gameRunning && !!_hostStream,
    });

    _knownPlayers = {};
    for (const p of Object.values(players)) {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    }
    _knownSpectators = new Set(Object.values(spectators).map((s) => s.socketId));
    _playerSlot = plan.mySlot;
    window._playerSlot = _playerSlot;

    for (const { sid, slot, step } of plan.connections) {
      if (step === 'kept') {
        if (_peers[sid]) _peers[sid].slot = slot;
        continue;
      }
      _syncLog(`new peer: ${sid} slot=${slot} hostStream=${!!_hostStream}`);
      createPeer(sid, slot, true);
      // A page joining a stream in play is offered to once it says it listens.
      if (step === 'offer') sendOffer(sid);
      else _syncLog(`new peer: waiting for late-join ready before offer (${sid})`);
    }

    _applyControllerPresentMask('users-updated');

    // The host's deadlines: one for every member it lists with no open
    // channel, none for a member it no longer lists.
    const deadlines = _playerSlot === 0 ? _deadlines() : null;
    if (deadlines) {
      for (const sid of deadlines.armed()) if (!_isListed(sid)) deadlines.forget(sid);
      const listed = [...Object.keys(_knownPlayers), ..._knownSpectators].filter(_isListed);
      for (const sid of listed) if (_offerRetry(sid) !== 'none') deadlines.arm(sid);
    }
    // After this handler, so the roster's own effect is observed first.
    if (_heldOffers.size) queueMicrotask(_decideHeldOffers);

    // Notify controller
    if (_config?.onPlayersChanged) {
      _config.onPlayersChanged(data);
    }
  };

  // ── Connection attempts and the host's deadline ────────────────────────
  // Every connection the host offers is named by an attempt {page, attempt}:
  // this page's id and its count of the connections it offered to that
  // member. Every signal carries the name of its connection as `attemptId`
  // (an offer its own; an answer or a candidate the one of the connection it
  // comes from), and a page applies it only to that connection
  // (KNCore.streaming: offerForConnection, answerApplies,
  // signalForConnection). A signal that names none comes from a page from
  // before, and is applied to whatever connection is held, as then.
  //
  // The host keeps a deadline for every member its roster lists whose
  // channel to it is not open (KNCore.streaming.startReofferDeadlines): when
  // it expires, the connection is replaced and offered again, at growing
  // waits, until the channel opens or the roster drops the member. Before
  // it, a lost connection was forgotten on both pages and nothing offered
  // again (specs/streaming_connection.qnt, droppedGuestTest).
  let _attemptPage = null;
  const _offerCounts = new Map(); // member sid → connections offered to it
  const _attemptPageId = () => {
    if (_attemptPage === null) {
      _attemptPage =
        window.KNCore?.attemptId?.newPageId?.() ?? `p${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    }
    return _attemptPage;
  };
  const _nextAttempt = (sid) => {
    const attempt = (_offerCounts.get(sid) ?? 0) + 1;
    _offerCounts.set(sid, attempt);
    return { page: _attemptPageId(), attempt };
  };
  const _readAttempt = (value) => window.KNCore?.attemptId?.readAttemptId?.(value) ?? null;
  const _withAttempt = (data, attempt) => (attempt ? { ...data, attemptId: attempt } : data);
  const _attemptText = (attempt) => (attempt ? `${attempt.page}#${attempt.attempt}` : 'none');
  const NAMES_NONE = { page: '', attempt: 0 };

  // A member the host's latest roster lists: a player other than this page, or a spectator.
  const _isListed = (sid) => (sid !== socket?.id && Object.hasOwn(_knownPlayers, sid)) || _knownSpectators.has(sid);

  const _offerRetry = (sid) => {
    const peer = _peers[sid];
    return _rules.retryOffer(_playerSlot === 0, _isListed(sid), peer?.dc?.readyState === 'open', !!peer?.mediaPending);
  };

  // The deadlines, made on first use; null without the bundle's rules (a
  // page that met an older bundle offers once, as before).
  let _reofferDeadlines;
  const _deadlines = () => {
    if (_reofferDeadlines === undefined) {
      _reofferDeadlines =
        window.KNCore?.streaming?.startReofferDeadlines?.({
          due: (sid) => _offerRetry(sid) !== 'none',
          reoffer: _reofferNow,
        }) ?? null;
    }
    return _reofferDeadlines;
  };

  // Close a connection and forget it, if it is still the one held.
  const _closePeer = (sid, peer) => {
    if (peer.dc)
      try {
        peer.dc.close();
      } catch (_) {}
    if (peer.pc)
      try {
        peer.pc.close();
      } catch (_) {}
    if (_peers[sid] === peer) delete _peers[sid];
    KNState.peers = _peers;
  };

  // The host's deadline for `sid` expired with no open channel: replace the
  // connection and offer on the new one.
  const _reofferNow = (sid, tries) => {
    if (_offerRetry(sid) === 'media') {
      _syncLog(`STREAM-REOFFER media ${sid} try=${tries} held=${_attemptText(_peers[sid].attempt)}`);
      void renegotiate(sid);
      return;
    }
    const old = _peers[sid];
    const state = old ? `${old.dc?.readyState ?? 'no-channel'}/${old.pc?.connectionState ?? '?'}` : 'none';
    _syncLog(`STREAM-REOFFER ${sid} try=${tries} held=${_attemptText(old?.attempt)} (${state})`);
    if (old) _closePeer(sid, old);
    createPeer(sid, Object.hasOwn(_knownPlayers, sid) ? _knownPlayers[sid].slot : null, true);
    sendOffer(sid);
  };

  // ── WebRTC ─────────────────────────────────────────────────────────────

  const createPeer = (remoteSid, remoteSlot, isInitiator) => {
    const peerGuard = (p) => _peers[remoteSid] === p;
    // The candidates this connection gathers carry its attempt.
    let made = null;
    const signalSocket = { emit: (event, data) => socket.emit(event, _withAttempt(data, made?.attempt ?? null)) };
    const peer = KNShared.createBasePeer(_getIceServers(), remoteSid, signalSocket, peerGuard);
    made = peer;
    peer.slot = remoteSlot;
    peer.attempt = null;

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (_rules.connectionLost(s, _peers[remoteSid] === peer)) {
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
        if (_peers[remoteSid] !== peer) return;
        // The host attaches this video track after installing its saved fight.
        const config = _config;
        if (config?.resumeFromMatchId && !_isSpectator && peer.slot === 0 && event.track.kind === 'video') {
          void config.matchReturn.ready().then((go) => {
            if (go && _config === config) startGuestInputLoop();
          });
        }
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
                // AbortController lets stop() drop both listeners atomically
                // even if the user never gestures. Without this, the
                // document-level touchstart listener stays registered across
                // game cycles (the per-listener removeEventListener calls
                // inside doUnmute only fire when the user actually taps).
                if (_unmuteAbort) _unmuteAbort.abort();
                _unmuteAbort = new AbortController();
                const doUnmute = () => {
                  // Detach via the shared controller so this is idempotent
                  // whether the user tapped or stop() aborted us first.
                  banner.classList.add('hidden');
                  if (_unmuteAbort) {
                    _unmuteAbort.abort();
                    _unmuteAbort = null;
                  }
                  if (!_guestVideo) return;
                  _guestVideo.muted = false;
                  // If unmuting paused the video (iOS), restart it
                  if (_guestVideo.paused) _guestVideo.play().catch(() => {});
                };
                banner.addEventListener('click', doUnmute, { signal: _unmuteAbort.signal });
                document.addEventListener('touchstart', doUnmute, { capture: true, signal: _unmuteAbort.signal });
              }
            },
            { once: true },
          );

          // Place guest video in a sibling overlay instead of inside #game.
          // This avoids touching EJS DOM at all — no innerHTML clear, no
          // display:none on EJS children, no EJS menu state leakage on wake.
          const gameDiv = (_config && _config.gameElement) || document.getElementById('game');
          const overlay = document.createElement('div');
          overlay.id = 'stream-overlay';
          // Take #game's flex slot — hide #game so overlay gets all the space
          overlay.style.cssText =
            'width:100%;max-width:100vw;flex:1 1 0;min-height:0;overflow:hidden;order:1;display:flex;align-items:center;justify-content:center;';
          gameDiv.style.display = 'none';
          overlay.appendChild(_guestVideo);
          gameDiv.parentNode.insertBefore(overlay, gameDiv.nextSibling);
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

        if (_guestVideo.requestVideoFrameCallback && event.track.kind === 'video') {
          const measureLatency = (now, metadata) => {
            if (_peers[remoteSid] !== peer || _guestVideo?.srcObject !== stream) return;
            peer.lastVideoFrameAt = now;
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
    // The first offer on a connection names it; its candidates follow it.
    if (!peer.attempt) peer.attempt = _nextAttempt(remoteSid);
    _deadlines()?.arm(remoteSid);
    try {
      const offer = await peer.pc.createOffer();
      offer.sdp = _rules.tuneOfferSdp(offer.sdp);
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', _withAttempt({ target: remoteSid, offer }, peer.attempt));
    } catch (err) {
      _syncLog(`sendOffer failed for ${remoteSid}: ${err.message || err}`);
    }
  };

  // ── Which offers a receiver takes ──────────────────────────────────────
  // A page that is not the host answers an offer only from the socket its
  // latest roster places at slot 0 (KNCore.streaming.signalGate): any other
  // room member could otherwise wire a connection to it and have it show
  // their video as the game. The sender is the server's: _relay_signal
  // builds the relayed payload with `sender` set from the sending socket, so
  // a page cannot name another. An offer from a sender no roster has placed
  // yet is held (the latest per sender, with the candidates that follow it)
  // and decided again by the next roster: the host does not send an offer
  // again when one goes unanswered, so dropping the host's would leave this
  // page without a stream. stop() clears what is held, so nothing is applied
  // in a later match. Whoever holds slot 0 is trusted.
  const HELD_CANDIDATES_MAX = 64;
  const _heldOffers = new Map(); // sender sid → { offer, candidates }
  const _offerGateLogged = new Set(); // "refuse:sid" / "hold:sid", logged once each

  const _offerGateLog = (key, msg) => {
    if (_offerGateLogged.has(key)) return;
    _offerGateLogged.add(key);
    _syncLog(msg);
  };

  const _roster = () => ({ players: _knownPlayers, spectators: [..._knownSpectators] });
  const _signalGate = (senderSid, data) =>
    _rules.signalGate(_playerSlot, _rules.signalKind(data), senderSid, _roster());

  // A roster arrived: decide each held offer again. From the sender now at
  // slot 0 it is handled as if it had just come, then its candidates; from a
  // sender the roster places anywhere else it is dropped; the rest wait on.
  const _decideHeldOffers = () => {
    for (const [sid, held] of _heldOffers) {
      const gate = _signalGate(sid, held.offer);
      if (gate === 'hold') continue;
      _heldOffers.delete(sid);
      if (gate === 'refuse') {
        _offerGateLog(`refuse:${sid}`, `dropped held offer from ${sid}: the roster does not place it at slot 0`);
        continue;
      }
      _syncLog(`applying held offer from ${sid}: the roster places it at slot 0`);
      onWebRTCSignal(held.offer);
      for (const candidate of held.candidates) onWebRTCSignal(candidate);
    }
  };

  const onWebRTCSignal = async (data) => {
    if (!data) return;
    const senderSid = data.sender;
    // What the signal does (KNCore.streaming.guardedSignalAction): the offer
    // gate, a candidate kept with its held offer, and which connection the
    // signal is for (attempt.ts).
    const named = _readAttempt(data.attemptId);
    let peer = senderSid ? _peers[senderSid] : undefined;
    const action = _rules.guardedSignalAction({
      sender: senderSid,
      kind: _rules.signalKind(data),
      mySlot: _playerSlot,
      roster: _roster(),
      hasEntry: !!peer,
      offerHeld: !!senderSid && _heldOffers.has(senderSid),
      held: peer?.attempt ?? null,
      named,
      awaitingAnswer: peer?.pc?.signalingState === 'have-local-offer',
    });
    if (action.act === 'refused') {
      _offerGateLog(`refuse:${senderSid}`, `refused offer from ${senderSid}: not the host (slot 0) on the roster`);
      return;
    }
    if (action.act === 'held') {
      if (data.offer) {
        _heldOffers.set(senderSid, { offer: data, candidates: [] });
        _offerGateLog(`hold:${senderSid}`, `holding offer from ${senderSid} until the roster places it`);
      } else {
        const held = _heldOffers.get(senderSid);
        if (held && held.candidates.length < HELD_CANDIDATES_MAX) held.candidates.push(data);
      }
      return;
    }
    if (action.act === 'stale') {
      // For a connection other than the one held: an older one's offer or an
      // answer the held connection is not waiting for. A stale candidate is
      // dropped quietly.
      if (data.offer) {
        _syncLog(
          `dropped offer from ${senderSid} for an older connection (${_attemptText(named)}, holding ${_attemptText(peer?.attempt)})`,
        );
      } else if (data.answer) {
        const waiting = peer?.pc?.signalingState === 'have-local-offer';
        _syncLog(
          `dropped answer from ${senderSid} (${_attemptText(named)}; holding ${_attemptText(peer?.attempt)}, waiting=${waiting})`,
        );
      }
      return;
    }
    if (action.replace) {
      _syncLog(
        `offer from ${senderSid} for a new connection (${_attemptText(named)}): replacing ${_attemptText(peer?.attempt)}`,
      );
      _closePeer(senderSid, peer);
    }
    if (action.create || action.replace) {
      peer = createPeer(senderSid, action.slot, false);
      peer.attempt = named;
    }
    if (!peer) return;

    try {
      if (data.offer) {
        peer._offerCount = (peer._offerCount || 0) + 1;
        const hasVideo = data.offer.sdp?.includes('m=video') ?? false;
        _syncLog(
          `received offer #${peer._offerCount} from ${senderSid} (hasVideo=${hasVideo}, attempt=${_attemptText(named)})`,
        );
        // A lost answer leaves the host retrying the same SDP. Reply from the
        // existing negotiation, including its ICE credentials.
        if (
          peer.answeredOffer === data.offer.sdp &&
          peer.pc.signalingState === 'stable' &&
          peer.pc.localDescription?.type === 'answer'
        ) {
          socket.emit(
            'webrtc-signal',
            _withAttempt({ target: senderSid, answer: peer.pc.localDescription }, peer.attempt),
          );
          return;
        }
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await KNShared.drainCandidates(peer);
        await KNShared.createAndSendAnswer(peer.pc, socket, senderSid, peer.attempt);
        peer.answeredOffer = data.offer.sdp;
      } else if (data.answer) {
        _syncLog(`received answer from ${senderSid}`);
        const answeredMedia = peer.pc.localDescription?.sdp?.includes('m=video');
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        if (_peers[senderSid] !== peer) return;
        if (peer.mediaPending) {
          if (answeredMedia) {
            peer.mediaPending = false;
            if (peer.dc?.readyState === 'open') _deadlines()?.opened(senderSid);
          } else {
            void renegotiate(senderSid);
          }
        }
        await KNShared.drainCandidates(peer);
      } else if (data.candidate) {
        await KNShared.addBufferedCandidate(peer, data.candidate);
      }
    } catch (err) {
      _syncLog(`WebRTC signal error: ${err.message || err}`);
    }
  };

  const onDataMessage = (data) => {
    if (!data || data.type !== 'streaming-late-join-ready') return;
    // What the host does (KNCore.streaming.lateJoinReadyAction). Who sent it
    // is the server's stamp (KNCore.checkRelayed), not what the message says:
    // any room member can write to the relay and could name another socket.
    const plan = _rules.lateJoinReadyAction({
      message: data,
      mySlot: _playerSlot,
      mySid: socket.id,
      roster: Object.entries(_knownPlayers).map(([sid, player]) => ({ sid, slot: player.slot })),
      connections: Object.entries(_peers).map(([sid, peer]) => ({
        sid,
        slot: peer.slot,
        linked: peer.dc?.readyState === 'open' || peer.pc?.connectionState === 'connected',
        pendingOffer: peer.pc?.localDescription?.type === 'offer',
      })),
    });
    if (plan.act === 'ignore') return;
    const remoteSid = window.KNCore.checkRelayed(data).sid;
    let peer = _peers[remoteSid];
    if (plan.create) peer = createPeer(remoteSid, plan.slot, true);
    else if (plan.slot !== null) peer.slot = plan.slot;

    if (plan.act === 'resend') {
      _syncLog(`late join ready: resending pending offer for ${remoteSid} slot=${plan.slot}`);
      socket.emit('webrtc-signal', _withAttempt({ target: remoteSid, offer: peer.pc.localDescription }, peer.attempt));
      return;
    }
    _syncLog(`late join ready: sending offer for ${remoteSid} slot=${plan.slot}`);
    sendOffer(remoteSid);
  };

  // ── Data channel ───────────────────────────────────────────────────────

  const setupDataChannel = (remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';

    const onOpen = () => {
      const peer = _peers[remoteSid];
      if (_playerSlot === 0 && peer?.dc === ch && !peer.mediaPending) _deadlines()?.opened(remoteSid);
      _syncLog(
        `DC open with ${remoteSid} slot=${peer ? peer.slot : '?'} mySlot=${_playerSlot} gameRunning=${_gameRunning} isSpectator=${_isSpectator}`,
      );
      // What the open channel leads to (KNCore.streaming.channelOpenAction).
      const act = _rules.channelOpenAction({
        mySlot: _playerSlot,
        spectator: _isSpectator,
        running: _gameRunning,
        live: !!_hostStream,
        hasEntry: !!peer,
        hasTracks: peer?.pc.getSenders().some((s) => s.track) ?? false,
      });
      if (act === 'startHost') {
        _syncLog('DC open: starting host emulator');
        startHost();
      } else if (act === 'addTracks') {
        // A late joiner: the host is already streaming.
        _syncLog('DC open: adding stream to late-join peer');
        for (const track of _hostStream.getTracks()) peer.pc.addTrack(track, _hostStream);
        optimizeVideoEncoding(peer.pc);
        renegotiate(remoteSid);
      } else if (act === 'tracksPresent') {
        _syncLog('DC open: late-join peer already has tracks');
      } else if (act === 'streamNotReady') {
        _syncLog('DC open: host running but stream not ready');
      } else if (act === 'startGuestInput' && !_config?.resumeFromMatchId) {
        _syncLog('DC open: starting guest input loop');
        startGuestInputLoop();
      } else if (act === 'spectator') {
        _syncLog('DC open: spectator, no input loop');
      }
    };
    ch.onopen = onOpen;
    // If the DataChannel is already open (race: ondatachannel delivered it
    // in the 'open' state), fire the handler immediately.
    if (ch.readyState === 'open') onOpen();

    ch.onclose = () => {
      const current = _peers[remoteSid];
      if (!current || current.dc !== ch) return;
      _syncLog(`DC closed with ${remoteSid}`);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => _syncLog(`DC error: ${remoteSid} ${e?.error?.message || e?.error || e}`);

    ch.onmessage = (e) => {
      // Only the host reads input, into the port the connection is filed
      // under (KNCore.streaming.readGuestPacket); a spectator's is dropped.
      const read = _rules.readGuestPacket(_playerSlot, _peers[remoteSid]?.slot, e.data);
      if (read) applyInputForSlot(read.slot, read.input);
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
    _closePeer(remoteSid, peer);
    _syncLog(`peer disconnected: ${remoteSid} (${_attemptText(peer.attempt)})`);
    if (_playerSlot === 0) {
      // The host offers again at its deadline while the roster lists them.
      if (_isListed(remoteSid)) _deadlines()?.arm(remoteSid);
    } else if (peer.slot === 0) {
      // The host offers again at its deadline; until then the video holds its last frame.
      setStatus('🟡 Connection to the host lost — reconnecting…');
    }
  };

  // ── Host: emulator + stream ────────────────────────────────────────────

  const startDirectCanvasCapture = (srcCanvas, scaleDownBy) => {
    _hostStream = srcCanvas.captureStream(STREAM_CAPTURE_FPS);
    const captureTrack = _hostStream.getVideoTracks()[0];
    if (!captureTrack) throw new Error('direct capture produced no video track');

    _captureMode = 'direct';
    _captureScaleDownBy = scaleDownBy;

    if ('contentHint' in captureTrack) captureTrack.contentHint = 'motion';
    if (captureTrack.applyConstraints) {
      captureTrack
        .applyConstraints({ frameRate: { ideal: 60, max: 60 } })
        .catch((err) => _syncLog(`direct capture constraints ignored: ${err?.message || err}`));
    }

    _syncLog(
      `direct canvas capture started (${srcCanvas.width}x${srcCanvas.height}@${STREAM_CAPTURE_FPS}, scaleDown=${_captureScaleDownBy.toFixed(2)})`,
    );
  };

  const startBlitCanvasCapture = (srcCanvas, isSafari) => {
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    const ctx = captureCanvas.getContext('2d');

    // The 4:3 game area of the source canvas (KNCore.streaming.blitCrop):
    // it may be wider from widescreen displays or Retina scaling.
    const computeCrop = () => _rules.blitCrop(srcCanvas.width, srcCanvas.height);
    let crop = computeCrop();

    _syncLog(
      `source canvas: ${srcCanvas.width}x${srcCanvas.height} → capture canvas: 640x480 (crop: ${crop.sx},${crop.sy} ${crop.sw}x${crop.sh})`,
    );

    // Safari's captureStream(0) + requestFrame() is broken in some versions —
    // frames never get pushed. Use auto-capture as primary, with requestFrame
    // as a bonus hint when available.
    _hostStream = captureCanvas.captureStream(isSafari ? STREAM_CAPTURE_FPS : 0);
    const captureTrack = _hostStream.getVideoTracks()[0];
    // 'motion' hint tells the browser encoder to use a low-latency profile
    // (e.g. CBP H264, shorter GOP) rather than optimizing for quality.
    if ('contentHint' in captureTrack) captureTrack.contentHint = 'motion';

    _captureMode = 'blit';
    _captureScaleDownBy = 1;

    let _blitCount = 0;
    let _lastSrcW = srcCanvas.width;
    let _lastSrcH = srcCanvas.height;
    let _lastCaptureAt = 0;
    const blitFrame = () => {
      if (!_gameRunning) return;
      requestAnimationFrame(blitFrame);
      const now = performance.now();
      if (_lastCaptureAt && now - _lastCaptureAt < STREAM_CAPTURE_FRAME_MS - 0.5) return;
      _lastCaptureAt = now;
      // Recompute crop if source canvas resized (e.g. window resize)
      if (srcCanvas.width !== _lastSrcW || srcCanvas.height !== _lastSrcH) {
        _lastSrcW = srcCanvas.width;
        _lastSrcH = srcCanvas.height;
        crop = computeCrop();
      }
      ctx.drawImage(srcCanvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, 640, 480);
      if (captureTrack.requestFrame) captureTrack.requestFrame();
      if (++_blitCount === 60) {
        _syncLog(
          `blit 60 frames, captureTrack: ${captureTrack.readyState} enabled=${captureTrack.enabled} muted=${captureTrack.muted}`,
        );
      }
    };
    blitFrame();

    _syncLog(`blit capture stream started (640x480 ${isSafari ? 'auto' : 'manual'} capture)`);
  };

  const startCanvasCapture = (srcCanvas) => {
    // How the canvas is captured (KNCore.streaming.capturePlan): directly,
    // unless blit was asked for or the browser is Safari.
    const plan = _rules.capturePlan({
      search: window.location.search,
      stored: KNStorage.get('localStorage', 'kn-stream-capture'),
      userAgent: navigator.userAgent,
      width: srcCanvas.width,
      height: srcCanvas.height,
    });
    if (plan.mode === 'direct') {
      try {
        startDirectCanvasCapture(srcCanvas, plan.scale);
        return;
      } catch (err) {
        _syncLog(`direct canvas capture failed, falling back to blit: ${err?.message || err}`);
      }
    } else if (plan.preference === 'direct' && plan.safari) {
      _syncLog('direct canvas capture disabled on Safari — using blit capture');
    }

    startBlitCanvasCapture(srcCanvas, plan.safari);
  };

  const recoverSolidCanvasIfNeeded = (reason) => {
    const bootCanvasHealth = window.KNDiag?.sampleCanvasHealth?.();
    if (!bootCanvasHealth?.solidPale) return null;
    _syncLog(
      `streaming CANVAS-BOOT-BLOCK solid pale/yellow ` +
        `bright=${bootCanvasHealth.brightness ?? '?'} stdev=${bootCanvasHealth.stdev ?? '?'} ` +
        `paleRatio=${bootCanvasHealth.paleRatio ?? '?'} yellowGreenRatio=${bootCanvasHealth.yellowGreenRatio ?? '?'}`,
    );
    const recovery = window.KNRecoverSolidCanvas?.({
      reason,
      health: bootCanvasHealth,
    });
    if (!recovery) {
      setStatus('Renderer failed to start — try reloading');
      return { failed: true };
    }
    return recovery;
  };

  let _stopMatchSaves = null;
  const startStreamingSaves = (config, gm) => {
    if (!config.matchId) return;
    const store = window.KNCore.matchSave;
    const scope = store.scope(config, window._knStreamingCoreHash);
    if (!scope) return;
    let writing = false;
    let savedFrame = 0;
    const current = () => _gameRunning && _config === config && window.EJS_emulator?.gameManager === gm;
    const capture = async () => {
      if (writing || !current()) return;
      const frame = gm.Module._get_current_frame_count?.();
      if (!frame || frame === savedFrame) return;
      writing = true;
      try {
        const snapshot = window.NetplayRollback.matchSaveCore.capture(frame);
        if (!snapshot) return;
        // Streaming also needs libretro's live scheduler, which rollback drives itself.
        snapshot.lib = new Uint8Array(gm.getState());
        const written = await store.write(
          { scope, frame, capturedAt: Date.now(), delay: 0, rows: [], snapshot },
          current,
        );
        if (written) savedFrame = frame;
      } catch (err) {
        _syncLog(`streaming match save unavailable: ${err?.message || err}`);
      } finally {
        writing = false;
      }
    };
    _stopMatchSaves = window.KNCore.startEvery(capture, store.cadence);
  };

  const startHost = () => {
    if (_gameRunning) return;
    _gameRunning = true;
    setStatus('Starting emulator…');
    window.KNStartEmulatorBoot?.({ forceStartOnLoad: true });
    KNShared.bootWithCheats('streaming');
    setupKeyTracking();

    const config = _config;
    const MIN_HOST_FRAMES = 10;
    let timingNormalized = false;
    const waitForEmu = async () => {
      if (!_gameRunning || _config !== config) return;
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) {
        setTimeout(waitForEmu, 100);
        return;
      }
      if (!timingNormalized) {
        timingNormalized = _normalizeStreamingTiming('host-start');
      }

      const frames = gm.Module?._get_current_frame_count?.() ?? 0;
      if (frames < MIN_HOST_FRAMES) {
        setTimeout(waitForEmu, 100);
        return;
      }
      const recovery = recoverSolidCanvasIfNeeded('streaming-host-boot');
      if (recovery) {
        if (!recovery.failed) {
          _gameRunning = false;
          setStatus(`Renderer retry (${recovery.profile})…`);
          setTimeout(startHost, 0);
        }
        return;
      }
      _syncLog(`emulator running (${frames} frames) — capturing stream`);
      _applyControllerPresentMask('emulator-ready');

      const srcCanvas = document.querySelector('#game canvas');
      if (!srcCanvas) {
        _syncLog('canvas not found, retrying…');
        setTimeout(waitForEmu, 200);
        return;
      }

      if (config.resumeFromMatchId) {
        try {
          gm.Module.pauseMainLoop();
          const store = window.KNCore.matchSave;
          const scope = store.scope(config, window._knStreamingCoreHash, config.resumeFromMatchId);
          const saved = scope && (await store.load(scope));
          if (_config !== config || !_gameRunning) return;
          if (!saved?.snapshot.lib) throw new Error('Streaming save unavailable');
          gm.loadState(saved.snapshot.lib);
          if (!window.NetplayRollback.matchSaveCore.install(saved.snapshot, saved.frame))
            throw new Error('Streaming save verification failed');
        } catch (err) {
          _syncLog(`streaming restore failed: ${err?.message || err}`);
          if (_config === config) config.matchReturn.fail();
          return;
        }
      }
      startCanvasCapture(srcCanvas);

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

      if (config.resumeFromMatchId) {
        setStatus('Waiting for players to resume…');
        if (!(await config.matchReturn.ready()) || _config !== config || !_gameRunning) return;
        gm.Module.resumeMainLoop();
      }
      startStreamingSaves(config, gm);
      setStatus('🟢 Hosting — game on!');
      startHostInputLoop();
      startHostFrameRateWatchdog();

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
    if (!peer || !_isListed(remoteSid)) return;
    peer.mediaPending = true;
    _deadlines()?.arm(remoteSid);
    if (peer.makingMediaOffer) return;
    peer.makingMediaOffer = true;
    try {
      if (peer.pc.signalingState === 'stable') {
        const offer = await peer.pc.createOffer();
        offer.sdp = _rules.tuneOfferSdp(offer.sdp);
        if (_peers[remoteSid] !== peer || !_isListed(remoteSid)) return;
        await peer.pc.setLocalDescription(offer);
        peer.mediaOffer = offer;
      }
      // If the original data-only offer is still outstanding, its answer
      // triggers negotiation for the attached tracks.
      if (
        _peers[remoteSid] === peer &&
        _isListed(remoteSid) &&
        peer.pc.signalingState === 'have-local-offer' &&
        peer.mediaOffer
      ) {
        socket.emit('webrtc-signal', _withAttempt({ target: remoteSid, offer: peer.mediaOffer }, peer.attempt));
      }
    } catch (err) {
      _syncLog(`renegotiate failed: ${err}`);
    } finally {
      peer.makingMediaOffer = false;
    }
  };

  const optimizeVideoEncoding = async (pc) => {
    // Set bitrate cap and 60fps for low-latency game streaming.
    // WebRTC defaults are conservative and cap at ~40fps. We override:
    // - minBitrate prevents the bandwidth estimator from throttling too low
    // - maxFramerate = 60 is non-negotiable for game feel
    // - maintain-framerate tells the encoder to drop resolution, never FPS
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        // KNCore.streaming.tuneEncoding: 2.5 Mbit/s, 60 fps, high priority,
        // resolution given up before frame rate.
        const params = _rules.tuneEncoding(sender.getParameters(), _captureMode, _captureScaleDownBy);
        try {
          await sender.setParameters(params);
          _syncLog(
            `video encoding optimized: 60fps, 2.5Mbps max, capture=${_captureMode}, scaleDown=${_captureScaleDownBy.toFixed(2)}`,
          );
        } catch (err) {
          _syncLog(`setParameters failed: ${err}`);
        }
      }
    }
  };

  const startHostInputLoop = () => {
    let _debugFrame = 0;
    const applyHostInput = () => {
      if (!_gameRunning) return;
      if (!_p1KeyMap) setupKeyTracking();
      const localInput = readLocalInput();
      applyInputForSlot(0, localInput);
    };

    let immediateQueued = false;
    const queueImmediateHostInput = () => {
      if (immediateQueued) return;
      immediateQueued = true;
      queueMicrotask(() => {
        immediateQueued = false;
        applyHostInput();
      });
    };

    if (_hostInputAbort) _hostInputAbort.abort();
    _hostInputAbort = new AbortController();
    document.addEventListener('keydown', queueImmediateHostInput, {
      capture: true,
      signal: _hostInputAbort.signal,
    });
    document.addEventListener('keyup', queueImmediateHostInput, {
      capture: true,
      signal: _hostInputAbort.signal,
    });
    document.addEventListener('touchstart', queueImmediateHostInput, { passive: true, signal: _hostInputAbort.signal });
    document.addEventListener('touchmove', queueImmediateHostInput, { passive: true, signal: _hostInputAbort.signal });
    document.addEventListener('touchend', queueImmediateHostInput, { passive: true, signal: _hostInputAbort.signal });
    document.addEventListener('touchcancel', queueImmediateHostInput, {
      passive: true,
      signal: _hostInputAbort.signal,
    });
    window.addEventListener('blur', queueImmediateHostInput, { signal: _hostInputAbort.signal });
    window.addEventListener('gamepadconnected', queueImmediateHostInput, { signal: _hostInputAbort.signal });
    window.addEventListener('gamepaddisconnected', queueImmediateHostInput, { signal: _hostInputAbort.signal });
    document.addEventListener('visibilitychange', queueImmediateHostInput, { signal: _hostInputAbort.signal });

    const tick = () => {
      applyHostInput();

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    };
    // Use setInterval instead of rAF — rAF throttles to ~1fps in background tabs,
    // which would starve all players if the host tabs away.
    _hostInputInterval = setInterval(tick, 16);
  };

  // ── Guest: input sender ────────────────────────────────────────────────

  const GUEST_INPUT_SEND_MS = 1000 / 60;

  let _guestLoopStarted = false;

  const startGuestInputLoop = () => {
    if (_guestLoopStarted) return;
    _guestLoopStarted = true;

    let _lastSentInput = KNShared.ZERO_INPUT;
    let _debugFrame = 0;

    const sendGuestInput = (force = false) => {
      if (!_guestLoopStarted) return false;
      if (!_p1KeyMap) setupKeyTracking();
      const localInput = readLocalInput();
      // KNCore.streaming.guestSends: the repeat sends what is held, an input
      // event only a change, and either only on an open channel to the host.
      const connections = Object.values(_peers).map((peer) => ({ slot: peer.slot, channel: peer.dc?.readyState }));
      if (!_rules.guestSends(force, localInput, _lastSentInput, connections)) return false;
      const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
      try {
        hostPeer.dc.send(_rules.guestPacket(localInput).buffer);
        _lastSentInput = localInput;
        return true;
      } catch (_) {}
      return false;
    };

    let immediateQueued = false;
    const queueImmediateSend = () => {
      if (immediateQueued) return;
      immediateQueued = true;
      queueMicrotask(() => {
        immediateQueued = false;
        sendGuestInput(false);
      });
    };

    if (_guestInputAbort) _guestInputAbort.abort();
    _guestInputAbort = new AbortController();
    document.addEventListener('keydown', queueImmediateSend, { capture: true, signal: _guestInputAbort.signal });
    document.addEventListener('keyup', queueImmediateSend, { capture: true, signal: _guestInputAbort.signal });
    document.addEventListener('touchstart', queueImmediateSend, { passive: true, signal: _guestInputAbort.signal });
    document.addEventListener('touchmove', queueImmediateSend, { passive: true, signal: _guestInputAbort.signal });
    document.addEventListener('touchend', queueImmediateSend, { passive: true, signal: _guestInputAbort.signal });
    document.addEventListener('touchcancel', queueImmediateSend, { passive: true, signal: _guestInputAbort.signal });
    window.addEventListener('blur', queueImmediateSend, { signal: _guestInputAbort.signal });
    window.addEventListener('gamepadconnected', queueImmediateSend, { signal: _guestInputAbort.signal });
    window.addEventListener('gamepaddisconnected', queueImmediateSend, { signal: _guestInputAbort.signal });
    document.addEventListener('visibilitychange', queueImmediateSend, { signal: _guestInputAbort.signal });

    _syncLog(`guest input loop: ${Math.round(1000 / GUEST_INPUT_SEND_MS)}Hz repeat + immediate sends`);

    const tick = () => {
      sendGuestInput(true);

      // Update debug overlay every 30 frames (~0.5s)
      if (++_debugFrame % 30 === 0) updateDebugOverlay();
    };
    tick();
    _guestInputInterval = setInterval(tick, GUEST_INPUT_SEND_MS);
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
    _logUpload = startSessionLog(config);

    window._playerSlot = _playerSlot;
    window._isSpectator = _isSpectator;

    // Register socket listeners
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);
    socket.on('data-message', onDataMessage);

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
    if (config.lateJoin && (_playerSlot !== 0 || _isSpectator)) {
      socket.emit('data-message', {
        type: 'streaming-late-join-ready',
        senderSid: socket.id,
        isSpectator: _isSpectator,
      });
    }
    // startHost() / startGuestInputLoop() triggered from ch.onopen

    // Virtual gamepad for mobile streaming guests
    if (config.isMobile && !_isSpectator && window.VirtualGamepad) {
      const gameEl = config.gameElement || document.getElementById('game');
      if (gameEl) {
        try {
          VirtualGamepad.init(gameEl);
          gameEl.style.margin = '0';
          // If a physical gamepad is already connected, hide virtual controls immediately
          if (window.GamepadManager?.hasGamepad(_playerSlot)) VirtualGamepad.setVisible(false);
        } catch (err) {
          _syncLog(`VirtualGamepad init failed: ${err.message || err}`);
        }
      }
    }
  };

  const stop = () => {
    _stopMatchSaves?.();
    _stopMatchSaves = null;
    if (_playerSlot === 0 && _config?.matchId) window.NetplayRollback.matchSaveCore.release();
    _gameRunning = false;
    _guestLoopStarted = false;
    _cachedInfo = null;
    if (_hostInputInterval) {
      clearInterval(_hostInputInterval);
      _hostInputInterval = null;
    }
    if (_hostInputAbort) {
      _hostInputAbort.abort();
      _hostInputAbort = null;
    }
    stopHostFrameRateWatchdog();
    _hostFrameRateResetCooldownUntil = 0;
    if (_guestInputInterval) {
      clearInterval(_guestInputInterval);
      _guestInputInterval = null;
    }
    if (_guestInputAbort) {
      _guestInputAbort.abort();
      _guestInputAbort = null;
    }
    _resetControllerPresentMask();

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
    _captureMode = 'none';
    _captureScaleDownBy = 1;
    if (_guestVideo) {
      _guestVideo.srcObject = null;
      // Remove the stream overlay container (sibling of #game)
      const streamOverlay = document.getElementById('stream-overlay');
      if (streamOverlay) streamOverlay.remove();
      else if (_guestVideo.parentNode) _guestVideo.parentNode.removeChild(_guestVideo);
      _guestVideo = null;
      // Restore #game visibility (was hidden when overlay was inserted)
      const gameDiv = (_config && _config.gameElement) || document.getElementById('game');
      if (gameDiv) gameDiv.style.display = '';
    }
    const unmuteBanner = document.getElementById('unmute-banner');
    if (unmuteBanner) unmuteBanner.classList.add('hidden');
    // Drop the unmute gesture listeners if the user never tapped.
    if (_unmuteAbort) {
      _unmuteAbort.abort();
      _unmuteAbort = null;
    }

    _reofferDeadlines?.stop();
    _reofferDeadlines = undefined;
    _heldKeys.clear();
    _knownPlayers = {};
    _knownSpectators = new Set();
    _heldOffers.clear();
    _offerGateLogged.clear();
    _prevSlotInputs = {};
    _p1KeyMap = null;
    KNShared.teardownKeyTracking();

    // Remove socket listeners (no data-message — streaming doesn't use it)
    if (socket) {
      socket.off('users-updated', onUsersUpdated);
      socket.off('webrtc-signal', onWebRTCSignal);
      socket.off('data-message', onDataMessage);
    }

    // Clean up virtual gamepad
    if (window.VirtualGamepad) {
      VirtualGamepad.destroy();
    }
    for (const ck in KNState.touchInput) {
      if (Object.prototype.hasOwnProperty.call(KNState.touchInput, ck)) delete KNState.touchInput[ck];
    }

    // Reset sync log for next game
    _logUpload?.stop();
    _logUpload = null;
    _syncLogRing = KNShared.createSyncLogRing(SYNC_LOG_MAX);

    _config = null;
  };

  const hostGameConnected = () => {
    const peer = Object.values(_peers).find((p) => p.slot === 0);
    const pc = peer?.pc;
    if (!pc) return false;
    const video = _guestVideo;
    const tracks = video?.srcObject?.getVideoTracks() || [];
    if (!pc.getReceivers().some(({ track }) => tracks.includes(track) && track.readyState === 'live' && !track.muted))
      return false;
    const now = performance.now();
    if (!video.requestVideoFrameCallback) {
      // Older receivers expose a decoded-frame counter without presentation callbacks.
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
      if (frames > peer.lastDecodedFrames && now - peer.lastVideoSampleAt <= 2000) peer.lastVideoFrameAt = now;
      peer.lastDecodedFrames = frames;
      peer.lastVideoSampleAt = now;
    }
    return window.KNCore.hostGameConnected(
      pc.connectionState,
      pc.iceConnectionState,
      peer.dc?.readyState === 'open',
      peer.lastVideoFrameAt,
      now,
    );
  };

  window.NetplayStreaming = {
    init,
    stop,
    hostGameConnected,
    exportSyncLog,
    flushSyncLog,
    getInfo: () => _cachedInfo,
    getPeerConnection: (sid) => {
      const p = _peers[sid];
      return p ? p.pc : null;
    },
  };
})();
