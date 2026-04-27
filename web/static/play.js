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
 *   State & URL params .............. ~line 63
 *   Socket.IO connection ............ ~line 228
 *   Users updated handler ........... ~line 687
 *   Game lifecycle (start/end) ...... ~line 831
 *   ROM sharing UI + consent ........ ~line 972
 *   Pre-game ROM preloading ......... ~line 1284
 *   ROM transfer (host sending) ..... ~line 1422
 *   ROM transfer (guest receiving) .. ~line 1577
 *   ZIP extraction .................. ~line 2221
 *   ROM IDB cache ................... ~line 2292
 *   Late-join ROM prompt ............ ~line 2797
 *   UI: Overlay ..................... ~line 2875
 *   UI: Toolbar ..................... ~line 3070
 *   UI: Info overlay ................ ~line 3120
 *   UI: Toasts / errors / share ..... ~line 3207
 *   Gamepad detection + remap wizard  ~line 3417
 *   Delay preference ................ ~line 3928
 *   Init ............................ ~line 3973
 *
 * ── Cross-Module Communication ──────────────────────────────────────────
 *
 *   Reads:  KNState.peers, KNState.frameNum (from engines, for info overlay)
 *   Writes: KNState.remapActive, KNState.delayAutoValue, KNState.romHash
 *   Exposes: window.play_notifyPeerStatus, window.play_notifyDesync,
 *            window.play_notifyResync (engine → play.js callbacks for toasts)
 *   Creates: window.NetplayLockstep.init() or window.NetplayStreaming.init()
 */
(function () {
  'use strict';

  const { safeGet: _safeGet, safeSet: _safeSet, safeRemove: _safeRemove } = KNState;

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
  let _gameResyncEnabled = true;
  let previousPlayers = {};
  let previousSpectators = {};
  let _lateJoin = false;
  let _romBlob = null; // raw ROM Blob for re-creating blob URLs
  let _romBlobUrl = null;
  let _romHash = null; // SHA-256 hex of loaded ROM
  let _romName = null; // display name for the loaded ROM
  let _romSize = null; // byte size for the loaded ROM
  let _gameId = null; // derived from ROM hash via known_roms table
  let _hostRomHash = null; // host's ROM hash for late-join verification
  let _hostRomName = null; // host's current ROM display name
  let _hostRomSize = null; // host's current ROM byte size
  let _hibernated = false; // true when emulator is hibernated between games
  let _hibernatedRomHash = null; // ROM hash at time of hibernate (detect ROM changes)
  let _pendingLateJoin = false; // waiting for ROM before late-join init
  // Server-injected feature flag — false when ROM_SHARING_ENABLED=false in env.
  const _ROM_SHARING_FEATURE = window.KN_CONFIG?.romSharingEnabled !== false;

  let _knownRoms = {}; // populated from /api/rom-hashes on load
  let renderRomLibrary = () => {}; // replaced with full impl after IDB functions

  const _gameIdHintFromUrl = () => {
    const hint = new URLSearchParams(window.location.search).get('game');
    return /^[a-z0-9-]{1,32}$/.test(hint || '') ? hint : null;
  };

  const _gameIdFromHash = (hash) => {
    if (hash && _knownRoms[hash]?.game_id) return _knownRoms[hash].game_id;
    const hint = _gameIdHintFromUrl();
    if (hint) return hint;
    return 'ssb64'; // default fallback
  };

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

  // ── Breadcrumb Trail ────────────────────────────────────────────────
  // Ring buffer of pre-game events — auto-flushed via debug-logs on error.
  const _CRUMB_MAX = 50;
  const _breadcrumbs = [];
  const crumb = (event, detail) => {
    const entry = { t: Date.now(), e: event };
    if (detail !== undefined) entry.d = detail;
    _breadcrumbs.push(entry);
    if (_breadcrumbs.length > _CRUMB_MAX) _breadcrumbs.shift();
  };
  const flushBreadcrumbs = (reason) => {
    if (!socket?.connected || _breadcrumbs.length === 0) return;
    socket.emit('debug-logs', {
      info: { type: 'breadcrumbs', reason, slot: mySlot ?? '?', player: playerName },
      logs: _breadcrumbs.map((c) => `${c.t} [${c.e}]${c.d ? ' ' + JSON.stringify(c.d) : ''}`),
    });
  };
  const _isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && /Macintosh/i.test(navigator.userAgent)) ||
    navigator.userAgentData?.mobile;

  // Pre-unlock AudioContext within a gesture callstack.
  // Browsers block AudioContext.resume() outside user gestures — desktop
  // included (Chrome autoplay policy). iOS is stricter (~1s window).
  // Must be called from a click/tap handler (Start Game, Accept ROM, ROM drop).
  const _preloadAudioCtx = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || (window._kn_preloadedAudioCtx && window._kn_preloadedAudioCtx.state !== 'closed')) return;
    try {
      window._kn_preloadedAudioCtx = new AC({ sampleRate: 44100 });
    } catch (_) {
      window._kn_preloadedAudioCtx = new AC();
    }
    window._kn_preloadedAudioCtx.resume().catch((e) => {
      console.warn(`[kn] preload AudioContext resume: ${e.name}: ${e.message}`);
    });
    const dest = window._kn_preloadedAudioCtx.createMediaStreamDestination();
    const el = document.createElement('audio');
    el.srcObject = dest.stream;
    el.play().catch(() => {});
    window._kn_gestureAudioEl = el;
    window._kn_gestureAudioDest = dest;
    const gain = window._kn_preloadedAudioCtx.createGain();
    gain.gain.value = 0;
    const osc = window._kn_preloadedAudioCtx.createOscillator();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    window._kn_keepAliveOsc = osc;
  };

  const ROM_CHUNK_SIZE = 64 * 1024; // 64KB — same for all platforms
  const ROM_BUFFER_THRESHOLD = 1024 * 1024; // 1MB — DC handles this fine on mobile
  let _romTransferBytesReceived = 0;
  let _romTransferLastChunkAt = 0;
  let _funnelRomLoadedSent = false; // P0-1 funnel: fire rom_loaded once per session
  let _preGamePC = null; // guest: pre-game RTCPeerConnection for ROM preload
  let _preGamePCs = {}; // host: pre-game RTCPeerConnections (sid → pc)
  let _romSignalHandler = null; // pre-game rom-signal Socket.IO listener
  let _currentInputType = _isMobile ? 'gamepad' : 'keyboard';
  let _autoSpectated = false; // true if we auto-joined as spectator due to full room
  let _uploadToken = _safeGet('localStorage', 'kn-upload-token') || ''; // HMAC token for sync-log/cache-state uploads
  KNState.uploadToken = _uploadToken; // initialize immediately so KNEvent works before upload-token socket event

  const _persistentId =
    _safeGet('sessionStorage', 'kn-player-id') ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  _safeSet('sessionStorage', 'kn-player-id', _persistentId);
  let _reconnectToken = _safeGet('sessionStorage', 'kn-reconnect-token') || '';

  const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => _escapeMap[c]);

  const formatRomSize = (bytes) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  };

  const hostRomIdentityKey = (hash, name, size) => {
    if (hash) return `h:${hash}:${size ?? ''}`;
    if (name || size !== null) return `n:${name || ''}:${size ?? ''}`;
    return '';
  };

  const hostRomFromData = (data) => {
    const hostRom = data?.hostRom || {};
    const size = data?.romSize ?? data?.rom_size ?? hostRom.size ?? null;
    return {
      hash: data?.romHash ?? data?.rom_hash ?? hostRom.hash ?? null,
      name: data?.romName ?? data?.rom_name ?? hostRom.name ?? null,
      size: size === null || size === undefined ? null : Number(size),
      gameId: data?.gameId ?? data?.game_id ?? hostRom.gameId ?? hostRom.game_id ?? null,
    };
  };

  const hostRomDisplayName = () => {
    if (_hostRomHash && _knownRoms[_hostRomHash]?.game) return _knownRoms[_hostRomHash].game;
    if (_hostRomName) return _hostRomName;
    if (_hostRomHash) return `Unknown ROM (${_hostRomHash.substring(1, 9)})`;
    return '';
  };

  const updateHostRomInfo = () => {
    const el = document.getElementById('host-rom-info');
    if (!el) return;
    if (isHost || isSpectator) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const name = hostRomDisplayName();
    if (!name) {
      el.style.display = '';
      el.textContent = 'Waiting for host to load a ROM';
      el.className = 'host-rom-info pending';
      return;
    }
    const bits = [`Host ROM: ${name}`];
    const size = formatRomSize(_hostRomSize);
    if (size) bits.push(size);
    el.style.display = '';
    el.textContent = bits.join(' | ');
    el.className = 'host-rom-info ready';
  };

  const localRomLoaded = () => !!(_romBlob || _romBlobUrl);

  const hostRomMismatch = () => {
    if (!localRomLoaded()) return false;
    if (romHashMismatch(_hostRomHash, _romHash)) return true;
    if (_hostRomSize !== null && _romSize !== null && Number(_hostRomSize) !== Number(_romSize)) return true;
    return false;
  };

  const resetTransferForHostRomChange = () => {
    if (_romTransferState !== 'idle' || _romTransferBytesReceived > 0) {
      resetRomTransfer();
      setRomTransferState('idle');
    }
    if (_romSharingEnabled) _romSharingDecision = null;
    cleanupPreGameConnections();
  };

  const handleHostRomChanged = (hadPrevious, hasNext, toastOnChange) => {
    if (isHost) return;
    if (hadPrevious && toastOnChange) {
      showToast(hasNext ? 'Host selected a different ROM' : 'Host cleared their ROM');
    }
    if (!hasNext) {
      resetTransferForHostRomChange();
      if (socket?.connected) socket.emit('rom-ready', { ready: false });
      updateRomSharingUI();
      return;
    }

    if (hostRomMismatch()) {
      console.warn(
        '[play] host ROM mismatch - clearing cached ROM',
        'host:',
        _hostRomHash?.substring(0, 16) || _hostRomSize,
        'ours:',
        _romHash?.substring(0, 16) || _romSize,
      );
      clearLoadedRom();
      resetTransferForHostRomChange();
      if (socket?.connected) socket.emit('rom-ready', { ready: false });
      if (_hostRomHash) autoMatchRom(_hostRomHash);
      updateRomSharingUI();
      return;
    }

    if (localRomLoaded()) {
      notifyRomReady();
    } else {
      resetTransferForHostRomChange();
      updateRomSharingUI();
    }
  };

  const applyHostRomFromData = (data, { toastOnChange = false } = {}) => {
    if (!data || isHost) {
      updateHostRomInfo();
      return false;
    }
    const prevKey = hostRomIdentityKey(_hostRomHash, _hostRomName, _hostRomSize);
    const next = hostRomFromData(data);
    const nextKey = hostRomIdentityKey(next.hash, next.name, Number.isFinite(next.size) ? next.size : null);

    _hostRomHash = next.hash || null;
    _hostRomName = next.name || null;
    _hostRomSize = Number.isFinite(next.size) ? next.size : null;
    if (next.gameId) {
      _gameId = next.gameId;
      KNState.gameId = _gameId;
    }
    const cachedHash = _safeGet('localStorage', 'kaillera-rom-hash');
    if (!localRomLoaded() && _hostRomHash && cachedHash && romHashMismatch(_hostRomHash, cachedHash)) {
      console.warn(
        '[play] cached ROM mismatch - clearing before autoload',
        'host:',
        _hostRomHash.substring(0, 16),
        'cached:',
        cachedHash.substring(0, 16),
      );
      _safeRemove('localStorage', 'kaillera-rom-hash');
      if (socket?.connected) socket.emit('rom-ready', { ready: false });
    }

    updateHostRomInfo();
    if (prevKey !== nextKey) {
      handleHostRomChanged(!!prevKey, !!nextKey, toastOnChange);
      return true;
    }
    if (hostRomMismatch()) {
      handleHostRomChanged(false, !!nextKey, false);
      return true;
    }
    return false;
  };

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
    KNState.room = roomCode;
    isHost = params.get('host') === '1';
    KNState.isLocalHost = isHost;
    playerName = params.get('name') || _safeGet('localStorage', 'kaillera-name') || 'Player';
    _safeSet('localStorage', 'kaillera-name', playerName);
    mode = params.get('mode') || 'lockstep';
    isSpectator = params.get('spectate') === '1';
    _gameId = _gameIdHintFromUrl();
    KNState.gameId = _gameId;
  };

  // ── Global error handler ───────────────────────────────────────────────

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[play] unhandled rejection:', e.reason);
    KNEvent('unhandled', String(e.reason)?.slice(0, 500), { stack: e.reason?.stack?.slice(0, 500) });
  });

  // ── Clean tab close ───────────────────────────────────────────────────

  window.addEventListener('pagehide', () => {
    // Flush session log via HTTP keepalive (survives page close)
    if (engine?.exportSyncLog) {
      try {
        engine.flushSyncLog?.();
      } catch (_) {}
    }
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
  });

  // ── Socket.IO ──────────────────────────────────────────────────────────

  const connect = () => {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
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
    // BF7: warn user if initial connection takes >10s
    let _initialConnectTimer = setTimeout(() => {
      if (!socket.connected) {
        showToast('Unable to reach server \u2014 retrying\u2026', 'error');
      }
    }, 10000);
    socket.on('connect', () => {
      if (_initialConnectTimer) {
        clearTimeout(_initialConnectTimer);
        _initialConnectTimer = null;
      }
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
      KNEvent('reconnect', `Reconnected after ${attempt} attempt(s)`, { attempts: attempt });
      KNState.sessionStats.reconnects++;
      _hideReconnecting();
      const rejoinEvent = isHost ? 'open-room' : 'join-room';
      const payload = isHost
        ? {
            extra: {
              sessionid: roomCode,
              player_name: playerName,
              room_name: `${playerName}'s room`,
              game_id: _gameId || 'ssb64',
              persistentId: _persistentId,
              reconnectToken: _reconnectToken,
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
              reconnectToken: _reconnectToken,
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
        // Resume stalled ROM transfer — pre-game WebRTC connections are lost on
        // socket reconnect, so re-register signaling and retry via Socket.IO
        if (
          !isHost &&
          _romSharingDecision === 'accepted' &&
          !_romBlob &&
          (_romTransferState === 'resuming' || _romTransferState === 'paused')
        ) {
          console.log('[play] resuming ROM transfer after reconnect');
          cleanupPreGameConnections();
          registerRomSignalHandler();
          _romTransferRetries = 0;
          _romTransferState = 'resuming';
          clearTimeout(_romTransferResumeTimer);
          _romTransferResumeTimer = null;
          requestResumeTransfer();
          updateRomSharingUI();
        }
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
      KNState.uploadToken = _uploadToken;
      try {
        _safeSet('localStorage', 'kn-upload-token', _uploadToken);
      } catch (_) {}
      fetch(`/ice-servers?token=${encodeURIComponent(_uploadToken)}&room=${encodeURIComponent(roomCode || '')}`)
        .then((r) => r.json())
        .then((s) => {
          window._iceServers = s;
        })
        .catch(() => {});
    });
    socket.on('reconnect-token', (data) => {
      _reconnectToken = data?.token || '';
      try {
        _safeSet('sessionStorage', 'kn-reconnect-token', _reconnectToken);
      } catch (_) {}
    });
    socket.on('game-started', onGameStarted);
    socket.on('game-ended', onGameEnded);
    socket.on('room-closed', onRoomClosed);
    socket.on('rom-sharing-updated', onRomSharingUpdated);
    socket.on('data-message', onDataMessage);

    // Lockstep peer-phantom notifications — P1-6: replaced with a persistent
    // corner status indicator instead of transient center-screen toasts.
    // The indicator stays visible for as long as the peer is disconnected
    // and clears when they reconnect, so it's much less distracting during
    // gameplay than a flash-toast that disappears in 2.7s.
    window.addEventListener('kn-peer-phantom', (e) => {
      const slot = e.detail?.slot;
      const name = getPlayerNameBySlot(slot) || '';
      addPeerStatusEntry(slot, name, 'unresponsive');
    });
    window.addEventListener('kn-peer-recovered', (e) => {
      const slot = e.detail?.slot;
      removePeerStatusEntry(slot);
    });
  };

  // ── Peer status indicator (P1-6) ───────────────────────────────────────
  // Persistent corner element listing disconnected peers. Replaces the
  // transient phantom-peer toasts that were "more distracting than helpful
  // to the gaming experience" per the launch readiness audit.
  const _peerStatusEntries = new Map(); // slot -> { name, state }
  const _ensurePeerStatusEl = () => {
    let el = document.getElementById('kn-peer-status');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'kn-peer-status';
    el.style.cssText =
      'position:fixed; top:64px; right:12px; z-index:120; ' +
      'display:flex; flex-direction:column; gap:4px; pointer-events:none;';
    document.body.appendChild(el);
    return el;
  };
  const _renderPeerStatus = () => {
    const el = _ensurePeerStatusEl();
    if (_peerStatusEntries.size === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = [..._peerStatusEntries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, info]) => {
        const dotColor = info.state === 'unresponsive' ? '#e74c3c' : '#f5c542';
        // Show "P2 jimmy unresponsive" if we have a name, "P2 unresponsive"
        // if we don't (avoids the redundant "P2 P2" when no name is known).
        const label = info.name ? `P${slot} ${escapeHtml(info.name)}` : `P${slot}`;
        return (
          '<div style="background:rgba(15,15,30,0.92); border:1px solid #2a2a40; ' +
          'border-radius:6px; padding:4px 10px; font-size:12px; color:#eee; ' +
          'display:flex; align-items:center; gap:6px; ' +
          'box-shadow:0 2px 8px rgba(0,0,0,0.4)">' +
          `<span style="width:8px; height:8px; border-radius:50%; background:${dotColor}"></span>` +
          `<span>${label} ${escapeHtml(info.state)}</span>` +
          '</div>'
        );
      })
      .join('');
  };
  const addPeerStatusEntry = (slot, name, state) => {
    _peerStatusEntries.set(slot, { name, state });
    _renderPeerStatus();
  };
  const removePeerStatusEntry = (slot) => {
    _peerStatusEntries.delete(slot);
    _renderPeerStatus();
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
              game_id: _gameId || 'ssb64',
              persistentId: _persistentId,
              reconnectToken: _reconnectToken,
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
              reconnectToken: _reconnectToken,
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
            game_id: _gameId || 'ssb64',
            persistentId: _persistentId,
            reconnectToken: _reconnectToken,
          },
          maxPlayers: 4,
        },
        (err) => {
          if (err) {
            showError(`Failed to create room: ${err}`);
            return;
          }
          mySlot = 0;
          KNEvent('room_created', '', { mode });
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
          showError('Room not found — it may have expired or the code may be incorrect');
          return;
        }
        const roomData = await response.json();
        if (!roomData) return;
        const roomGameId = roomData.gameId || roomData.game_id;
        if (roomGameId) {
          _gameId = roomGameId;
          KNState.gameId = _gameId;
        }
        applyHostRomFromData(roomData);

        // Room full: auto-join as spectator with banner
        if (!isSpectator && roomData.player_count >= roomData.max_players) {
          console.log(
            `[play] auto-spectate: player_count=${roomData.player_count} >= max_players=${roomData.max_players}`,
          );
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
              reconnectToken: _reconnectToken,
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
                      reconnectToken: _reconnectToken,
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
                    KNEvent('peer_joined', '', { slot: -1, is_spectator: true });
                    showRoomFullBanner();
                    showOverlay();
                  },
                );
                return;
              }
              showError(`Failed to join: ${err}`);
              return;
            }

            const joinGameId = joinData?.gameId || joinData?.game_id;
            if (joinGameId) {
              _gameId = joinGameId;
              KNState.gameId = _gameId;
            }
            applyHostRomFromData(joinData || roomData);

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
            KNEvent('peer_joined', '', {
              slot: mySlot ?? -1,
              is_spectator: !!isSpectator,
            });
            crumb('join-ack', {
              host: isHost,
              spectator: isSpectator,
              status: roomData.status,
              sharing: !!roomData.rom_sharing,
              hasRom: !!(_romBlob || _romBlobUrl),
              romHash: _romHash?.substring(0, 12),
              hostHash: (_hostRomHash ?? '').substring(0, 12),
            });
            // If ROM was already loaded from cache, notify server immediately.
            // Skip for guests if host's ROM hash is known and doesn't match —
            // onUsersUpdated will handle activation once the host hash is verified.
            if (localRomLoaded() && (isHost || !hostRomMismatch())) {
              notifyRomReady();
            } else if (!isHost && !_romSharingEnabled && !roomData.rom_sharing && hostRomMismatch()) {
              // Cached ROM doesn't match host's — clear it now (skip when ROM sharing handles it)
              console.log('[play] join: cached ROM mismatch — clearing');
              clearLoadedRom();
            }

            // Mid-game join handling
            if (roomData.status === 'playing') {
              crumb('mid-game-join', {
                spectator: isSpectator,
                mode,
                sharing: !!roomData.rom_sharing,
                hasRom: !!(_romBlob || _romBlobUrl),
                romHash: _romHash?.substring(0, 12),
                hostHash: (_hostRomHash ?? '').substring(0, 12),
              });
              console.log(
                `[play] mid-game join: isSpectator=${isSpectator}, mode=${mode}, player_count=${roomData.player_count}, max_players=${roomData.max_players}`,
              );
              gameRunning = true;
              _lateJoin = !isSpectator;
              // Set matchId for late joiners — game-started event doesn't fire
              // for them, so session logging would silently fail without this.
              // roomData (REST) doesn't include matchId — use joinData (Socket.IO ack).
              if (joinData?.matchId) KNState.matchId = joinData.matchId;
              else if (roomData.matchId) KNState.matchId = roomData.matchId;
              // Pick up the game mode — game-started event won't fire
              // since the game is already running. Try REST then join callback.
              if (roomData.mode) mode = roomData.mode;
              else if (joinData?.mode) mode = joinData.mode;
              // Use joinData directly — the users-updated socket event may not
              // have arrived yet (ack returns before broadcast is delivered)
              if (joinData) lastUsersData = joinData;

              // Store host ROM metadata for verification
              applyHostRomFromData(joinData || roomData);

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
              if (!localRomLoaded()) {
                if (roomData.rom_sharing) {
                  // Show accept/decline prompt instead of ROM drop
                  crumb('late-join-sharing-prompt', { sharing: true });
                  _romSharingEnabled = true;
                  _pendingLateJoin = true;
                  showLateJoinRomPrompt();
                  updateRomSharingUI();
                  return;
                }
                crumb('late-join-rom-prompt', { sharing: false });
                _pendingLateJoin = true;
                showLateJoinRomPrompt();
                return;
              }

              // Verify ROM hash if available (skip when ROM came from host via sharing)
              if (hostRomMismatch() && _romSharingDecision !== 'accepted') {
                if (roomData.rom_sharing) {
                  // Cached ROM doesn't match but sharing is available —
                  // show sharing prompt instead of erroring out
                  _romSharingEnabled = true;
                  _pendingLateJoin = true;
                  showLateJoinRomPrompt();
                  updateRomSharingUI();
                  return;
                }
                showError("Your ROM doesn't match the host's game. Drop the correct ROM or enable ROM sharing.");
                return;
              }

              showToolbar();
              initEngine();
              return;
            }

            showOverlay();
            // Sync ROM sharing state and refresh UI unconditionally.
            // users-updated may arrive before or after the ack, and only calls
            // updateRomSharingUI() when the value changes. If it already set
            // _romSharingEnabled=true before the ack, the change-guard skips it
            // a second time — so we call it here after showOverlay() to ensure
            // the prompt appears regardless of event ordering.
            if (!isHost && !isSpectator) {
              const sharingFromAck = joinData?.romSharing ?? roomData?.rom_sharing;
              if (sharingFromAck !== undefined) {
                _romSharingEnabled = !!sharingFromAck;
              }
              updateRomSharingUI();
            }
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

    // Check if we became the host (ownership transfer)
    const wasHost = isHost;
    if (ownerSid) {
      isHost = ownerSid === socket.id;
      KNState.isLocalHost = isHost;
    }
    if (!wasHost && isHost) {
      showToast('You are now the host');
      renderRomLibrary();
      if (localRomLoaded()) notifyRomReady();
    }

    // Track room mode from server (set by host's set-mode event)
    if (data.mode) {
      const prevMode = mode;
      mode = data.mode;
      // Sync mode-select dropdown if we're the host
      const modeSel = document.getElementById('mode-select');
      if (modeSel && !isHost) modeSel.value = mode;
      // Re-emit rom-ready when switching to lockstep so the host's "Waiting for ROMs"
      // check clears for guests who had already declared ROM in streaming mode.
      // Skip if ROM hash doesn't match the host's (guest has wrong cached ROM).
      if (prevMode !== 'lockstep' && mode === 'lockstep' && localRomLoaded() && (isHost || !hostRomMismatch())) {
        notifyRomReady();
      }
    }

    // Update ROM sharing state from users-updated (supplementary to rom-sharing-updated)
    if (_ROM_SHARING_FEATURE && data.romSharing !== undefined) {
      const wasSharing = _romSharingEnabled;
      _romSharingEnabled = !!data.romSharing;
      if (_romSharingEnabled !== wasSharing) {
        console.log('[play] ROM sharing state from users-updated:', _romSharingEnabled);
        if (_romSharingEnabled && !isHost) showToast('Host is sharing their ROM');
        updateRomSharingUI();
      }
    }

    // Track host ROM identity for display, cache verification, and live invalidation.
    applyHostRomFromData(data, { toastOnChange: true });

    // Update my slot
    for (const entry of Object.values(players)) {
      if (entry.socketId === socket.id) {
        mySlot = entry.slot;
        KNState.slot = mySlot;
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
    crumb('game-started', {
      mode: data.mode,
      hasRom: !!(_romBlob || _romBlobUrl),
      romHash: _romHash?.substring(0, 12),
      hostHash: data.romHash?.substring(0, 12),
      gameId: data.gameId || _gameId,
      sharingEnabled: _romSharingEnabled,
      sharingDecision: _romSharingDecision,
    });
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
    _gameResyncEnabled = data.resyncEnabled !== false;
    if (data.gameId) {
      _gameId = data.gameId;
      KNState.gameId = _gameId;
    }
    applyHostRomFromData(data);
    KNState.matchId = data.matchId || null;

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

    // Verify ROM identity matches host's (skip if ROM sharing — ROM comes from host)
    if (hostRomMismatch() && _romSharingDecision !== 'accepted') {
      if (_romSharingEnabled && _romSharingDecision === null) {
        // Cached ROM doesn't match but sharing available and user hasn't
        // decided — stay in overlay so they can accept the host's ROM
        initEngine();
        updateRomSharingUI();
        return;
      }
      showError("Your ROM doesn't match the host's game. Drop the correct ROM to continue.");
      return;
    }

    // If ROM sharing is enabled and we don't have a ROM yet (regardless of
    // whether the guest accepted, declined, or hasn't decided), stay in overlay.
    // This handles the race where the host starts before the guest finishes
    // downloading or even accepts the sharing prompt.
    if (_romSharingEnabled && !localRomLoaded()) {
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
      engine.stop();
      engine = null;
    }
    KNState.matchId = null;
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
    // Nudge feedback while experience is fresh
    if (window.KNFeedback?.prompt) setTimeout(() => window.KNFeedback.prompt(), 1500);
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
    if (!_ROM_SHARING_FEATURE) return;
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

  const _isKnownPeerSid = (sid) => {
    if (!lastUsersData?.players) return false;
    return Object.values(lastUsersData.players).some((p) => p.socketId === sid);
  };

  const onDataMessage = (data) => {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    // Host broadcasts mode selection to guests pre-game
    if (data.type === 'mode-select' && !isHost && data.mode) {
      if (data.mode !== 'lockstep' && data.mode !== 'streaming') return;
      mode = data.mode;
      const modeSel = document.getElementById('mode-select');
      if (modeSel) modeSel.value = mode;
      updateRomDeclarePrompt();
      if (lastUsersData) updateStartButton(lastUsersData.players || {});
    }
    if (data.type === 'rom-accepted' && isHost && _romSharingEnabled && data.sender) {
      if (typeof data.sender !== 'string' || !_isKnownPeerSid(data.sender)) return;
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
      // Show ROM drop zone with compact "accept from host" option below
      if (romDrop) romDrop.style.display = '';
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
    _preloadAudioCtx(); // gesture — unlock audio for mobile guests
    crumb('rom-sharing-accept');
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
      requestResumeTransfer();
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
        // DC didn't open in time — fall back to Socket.IO with retry logic
        if (_romTransferState === 'resuming' && !_romBlob) {
          console.log('[play] waitForDCAndSendRomAccepted timed out — falling back to Socket.IO');
          requestResumeTransfer();
        }
      }
    }, 15000);
  };

  const declineRomSharing = () => {
    crumb('rom-sharing-decline');
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
    setRomTransferState('idle');
  };

  const retryRomTransfer = () => {
    if (_romTransferState !== 'paused' && _romTransferState !== 'idle') return;
    _romTransferRetries = 0;
    _romTransferState = 'resuming';
    updateRomSharingUI();
    setRomTransferState('retrying', 'Retrying ROM transfer…');
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
        const ICE = window._iceServers || KNState.DEFAULT_ICE_SERVERS;
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

    const ICE = window._iceServers || KNState.DEFAULT_ICE_SERVERS;
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
    const romName = _safeGet('localStorage', 'kaillera-rom-name') || 'rom.z64';

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
              setRomTransferState('failed', 'ROM transfer failed — load ROM manually');
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
          setRomTransferState('failed', 'ROM transfer failed — load ROM manually');
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
              setRomTransferState('failed', 'ROM too large — loading manually');
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
        if (_romTransferBytesReceived > ROM_MAX_SIZE) {
          setRomTransferState('failed', 'ROM transfer too large — aborting');
          channel.close();
          cancelRomTransfer();
          return;
        }
        if (_romTransferHeader && _romTransferBytesReceived > _romTransferHeader.size * 1.1) {
          setRomTransferState('failed', 'ROM transfer size mismatch — aborting');
          channel.close();
          cancelRomTransfer();
          return;
        }
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
          setRomTransferState('retrying', `ROM transfer interrupted — retry ${_romTransferRetries}/3`);
          // Auto-retry after backoff
          _romTransferResumeTimer = setTimeout(() => {
            if (_romTransferState !== 'paused') return;
            _romTransferState = 'resuming';
            updateRomSharingUI();
            requestResumeTransfer();
          }, 2000);
        } else if (_romTransferRetries > 3) {
          setRomTransferState('stalled', 'ROM transfer stalled — cancel or wait for host');
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
        setRomTransferState('retrying', 'ROM transfer resume timed out — will retry');
        // Schedule another attempt
        _romTransferResumeTimer = setTimeout(() => {
          if (_romTransferState !== 'paused') return;
          _romTransferState = 'resuming';
          updateRomSharingUI();
          requestResumeTransfer();
        }, 2000);
      } else {
        setRomTransferState('stalled', 'ROM transfer stalled — cancel or wait for host');
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
    setRomTransferState('receiving');
  };

  // P1-5: Single source of truth for ROM transfer status. Replaces the 11+
  // separate showToast calls that flashed during a transfer. The persistent
  // progress UI updates its text/border/buttons in place instead of a stream
  // of disappearing toasts.
  // States: 'receiving', 'paused', 'retrying', 'stalled', 'failed', 'idle'
  const setRomTransferState = (state, message) => {
    const wrap = document.getElementById('rom-transfer-progress');
    const text = document.getElementById('rom-progress-text');
    const retryBtn = document.getElementById('rom-transfer-retry');
    const cancelBtn = document.getElementById('rom-transfer-cancel');
    if (!wrap) return;

    if (state === 'idle') {
      wrap.style.display = 'none';
      wrap.style.borderColor = '';
      return;
    }

    wrap.style.display = '';
    if (message && text) text.textContent = message;

    // Border color hint by severity (uses inline style so it overrides
    // whatever the existing CSS sets without needing a new class).
    const borderColor =
      state === 'failed'
        ? '#e74c3c'
        : state === 'stalled' || state === 'paused'
          ? '#f5c542'
          : state === 'retrying'
            ? '#4a9eff'
            : '';
    wrap.style.borderColor = borderColor;

    // Retry button visible only when the user can act on it
    if (retryBtn) retryBtn.style.display = state === 'failed' || state === 'stalled' ? '' : 'none';
    // Cancel button always visible while a transfer state exists
    if (cancelBtn) cancelBtn.style.display = '';
  };

  const finishRomTransfer = () => {
    let totalSize = 0;
    for (const chunk of _romTransferChunks) {
      totalSize += chunk.byteLength;
    }

    if (_romTransferHeader && _romTransferHeader.size !== totalSize) {
      setRomTransferState('failed', 'ROM transfer size mismatch — load manually');
      _romTransferState = 'idle';
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    const blob = new Blob(_romTransferChunks);
    const displayName = _romTransferHeader?.name ?? 'rom.z64';
    const expectedHash = _romTransferHeader?.hash ?? null;

    _romBlob = blob;
    _romName = displayName;
    _romSize = blob.size;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;
    // Cache received ROM so guests auto-load on future joins without re-downloading
    _safeSet('localStorage', 'kaillera-rom-name', displayName);
    cacheRom(blob, { name: displayName, source: 'p2p' });

    _romTransferState = 'complete';
    _romTransferChunks = [];
    _romTransferDC = null;

    // Use the host's hash directly — the bytes are verified identical (size check
    // passed) and recomputing locally can produce a different hash if the host
    // uses SHA-256 (HTTPS/localhost) while the guest uses FNV-1a (HTTP LAN IP).
    if (expectedHash) {
      _romHash = expectedHash;
      _gameId = _gameIdFromHash(expectedHash);
      KNState.romHash = expectedHash;
      KNState.gameId = _gameId;
      afterRomTransferComplete(displayName);
    } else {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          _romHash = await hashArrayBuffer(reader.result);
          _gameId = _gameIdFromHash(_romHash);
          KNState.romHash = _romHash;
          KNState.gameId = _gameId;
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
      crumb('rom-transfer-complete-late-join');
      dismissLateJoinPrompt();
    }

    // Success — clear the persistent transfer status. The rom-status (above
    // the progress UI) already shows "Loaded: <name>" so the user knows.
    setRomTransferState('idle');

    // Clean up pre-game WebRTC connections (ROM delivered, no longer needed)
    cleanupPreGameConnections();
  };

  const notifyRomReady = () => {
    if (socket?.connected) {
      socket.emit('rom-ready', {
        ready: true,
        hash: _romHash || undefined,
        name: _romName || _safeGet('localStorage', 'kaillera-rom-name') || undefined,
        size: _romSize ?? _romBlob?.size ?? undefined,
      });
      if (!_funnelRomLoadedSent) {
        _funnelRomLoadedSent = true;
        KNEvent('rom_loaded', '', { bytes: _romBlob?.size || 0 });
      }
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
      const suspendedCtxs = [];
      if (mod.AL?.contexts) {
        for (const ctx of Object.values(mod.AL.contexts)) {
          if (ctx?.audioCtx && ctx.audioCtx.state !== 'closed') {
            try {
              if (proto.resume) ctx.audioCtx.resume = proto.resume;
              ctx.audioCtx.resume().catch(() => {});
              if (ctx.audioCtx.state !== 'running') suspendedCtxs.push(ctx.audioCtx);
            } catch (_) {}
          }
        }
      }

      // Resume SDL2 AudioContext if present
      if (mod.SDL2?.audioContext && mod.SDL2.audioContext.state !== 'closed') {
        try {
          mod.SDL2.audioContext.resume().catch(() => {});
          if (mod.SDL2.audioContext.state !== 'running') suspendedCtxs.push(mod.SDL2.audioContext);
        } catch (_) {}
      }

      // Retry suspended contexts on next user gesture (autoplay policy)
      if (suspendedCtxs.length) {
        const retryResume = () => {
          const still = suspendedCtxs.filter((c) => c.state !== 'running' && c.state !== 'closed');
          if (!still.length) {
            document.removeEventListener('click', retryResume, true);
            document.removeEventListener('keydown', retryResume, true);
            document.removeEventListener('touchstart', retryResume, true);
            return;
          }
          for (const c of still) c.resume().catch(() => {});
        };
        document.addEventListener('click', retryResume, true);
        document.addEventListener('keydown', retryResume, true);
        document.addEventListener('touchstart', retryResume, true);
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
        // BF5: surface EJS loader failure to the user
        window.knShowError?.('Failed to load emulator \u2014 please refresh the page.');
        KNEvent?.('wasm-fail', 'ejs-loader script error');
      };
      document.body.appendChild(script);
    };
    if (window._knCoreReady) {
      // BF5: race _knCoreReady against a 15s timeout so boot doesn't hang
      // forever if /api/core-info fetch never resolves.
      const coreTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Core load timeout (15s)')), 15000),
      );
      Promise.race([window._knCoreReady, coreTimeout]).then(injectLoader, (err) => {
        console.warn(`[play] core-ready: ${err.message} — proceeding without cache clear`);
        injectLoader();
      });
    } else {
      injectLoader();
    }
  };

  const setupRomDrop = () => {
    const drop = document.getElementById('rom-drop');
    if (!drop) return;

    const savedRom = _safeGet('localStorage', 'kaillera-rom-name');
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

    // Auto-load the most recently used ROM from library
    const lastHash = _safeGet('localStorage', 'kaillera-rom-hash');
    if (lastHash) {
      if (!isHost && _hostRomHash && romHashMismatch(_hostRomHash, lastHash)) {
        console.warn(
          '[play] cached ROM mismatch - clearing before autoload',
          'host:',
          _hostRomHash.substring(0, 16),
          'cached:',
          lastHash.substring(0, 16),
        );
        clearLoadedRom();
        if (socket?.connected) socket.emit('rom-ready', { ready: false });
        return;
      }
      crumb('rom-autoload-start', { hash: lastHash.substring(0, 12) });
      loadRomFromLibrary(lastHash, (ok, name) => {
        crumb('rom-autoload-done', {
          ok,
          name,
          pendingLateJoin: _pendingLateJoin,
          hostHash: _hostRomHash?.substring(0, 12),
          match: !_hostRomHash || !romHashMismatch(_hostRomHash, lastHash),
        });
        if (ok) {
          drop.classList.add('loaded');
          if (statusEl) statusEl.textContent = `Loaded: ${name} (drop to change)`;
          if (_pendingLateJoin) dismissLateJoinPrompt();
        } else if (savedRom && statusEl) {
          statusEl.textContent = `Last used: ${savedRom} (file not cached — drop again)`;
        }
        // Render library for host after loading
        if (isHost) renderRomLibrary();
      });
    } else {
      if (isHost) renderRomLibrary();
    }
  };

  const handleRomFile = (file) => {
    _preloadAudioCtx(); // gesture — unlock audio for mobile guests dropping ROM
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
    _romName = displayName;
    _romSize = file.size;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(file);
    window.EJS_gameUrl = _romBlobUrl;
    _safeSet('localStorage', 'kaillera-rom-name', displayName);
    cacheRom(file, { name: displayName, source: 'local' });

    const drop = document.getElementById('rom-drop');
    if (drop) drop.classList.add('loaded');
    const statusEl = document.getElementById('rom-status');
    if (statusEl) statusEl.textContent = `Loaded: ${displayName}`;

    // Enable ROM sharing checkbox if host
    const romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb && isHost) romShareCb.disabled = false;

    // Compute ROM hash and proceed with any pending late-join.
    // P1-3: ROM hash now has a 15-second timeout and an onerror handler so
    // a stuck FileReader / digest call surfaces a user-visible failure
    // instead of leaving the player on a silent "loaded" state with no hash
    // (which would later block ROM ready broadcasting and game start).
    const reader = new FileReader();
    let _hashTimedOut = false;
    const _hashTimer = setTimeout(() => {
      _hashTimedOut = true;
      try {
        reader.abort();
      } catch (_) {}
      console.log('[play] ROM hash timed out after 15s');
      KNEvent('compat', 'ROM hash computation timed out', { size: file.size });
      showToast('ROM hash failed — try a smaller ROM or different browser');
    }, 15000);
    reader.onerror = () => {
      clearTimeout(_hashTimer);
      if (_hashTimedOut) return;
      console.log('[play] FileReader error:', reader.error);
      KNEvent('compat', 'ROM FileReader failed', { error: String(reader.error) });
      showToast('Could not read ROM file — try dropping it again');
    };
    reader.onload = async () => {
      clearTimeout(_hashTimer);
      if (_hashTimedOut) return;
      try {
        const hash = await hashArrayBuffer(reader.result);
        _romHash = hash;
        _gameId = _gameIdFromHash(hash);
        KNState.romHash = hash;
        KNState.gameId = _gameId;
        window.EJS_gameID = hash;
        _safeSet('localStorage', 'kaillera-rom-hash', hash);
        console.log(`[play] ROM hash: ${hash.substring(0, 16)}\u2026 game_id: ${_gameId}`);
        if (isHost && _gameId && _gameId !== 'ssb64') {
          socket.emit('set-game-id', { game_id: _gameId });
        }
      } catch (err) {
        console.log('[play] hash failed:', err);
        KNEvent('compat', 'ROM hash compute failed', { error: String(err) });
        showToast('ROM hash failed — game may not work');
      }
      // Guest ROM mismatch check: if the host's ROM hash is known and
      // this ROM doesn't match, reject it and prompt re-upload.
      if (!isHost && (_hostRomHash || _hostRomSize !== null) && hostRomMismatch()) {
        console.log(
          '[play] ROM mismatch — guest hash:',
          _romHash?.substring(0, 16),
          'host hash:',
          _hostRomHash?.substring(0, 16),
        );
        clearLoadedRom();
        if (socket?.connected) socket.emit('rom-ready', { ready: false });
        showToast('ROM version mismatch — please load the same ROM as the host');
        return;
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
  const clearLoadedRom = () => {
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlob = null;
    _romBlobUrl = null;
    _romHash = null;
    _romName = null;
    _romSize = null;
    _gameId = null;
    KNState.romHash = null;
    KNState.gameId = null;
    window.EJS_gameUrl = undefined;
    const romDrop = document.getElementById('rom-drop');
    const statusEl = document.getElementById('rom-status');
    if (romDrop) romDrop.classList.remove('loaded');
    if (statusEl) statusEl.textContent = 'Drop or click to load ROM';
  };

  // Hashes are prefixed with 'S' (SHA-256) or 'F' (FNV-1a).
  // If algorithms differ (host on localhost, guest on LAN HTTP), skip — can't compare.
  const romHashMismatch = (a, b) => {
    if (!a || !b) return false;
    if (a[0] !== b[0]) return false; // different algorithms, can't compare
    return a !== b;
  };

  // ── ROM IDB Cache (multi-ROM library) ──────────────────────────────────

  const _ROM_DB = 'kaillera-rom-cache';
  const _ROM_STORE = 'roms';
  const _ROM_DB_VERSION = 2;

  const openRomDB = (cb) => {
    if (typeof indexedDB === 'undefined') {
      cb(null);
      return;
    }
    const req = indexedDB.open(_ROM_DB, _ROM_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // Fresh install — create store
        db.createObjectStore(_ROM_STORE);
      }

      if (oldVersion < 2 && oldVersion >= 1) {
        // Migration: move 'current' key to hash-keyed entry.
        // All operations stay synchronous within the upgrade transaction —
        // async calls (like SubtleCrypto) would cause the transaction to
        // auto-commit prematurely. Use the cached hash from localStorage.
        const tx = req.transaction;
        const store = tx.objectStore(_ROM_STORE);
        const getReq = store.get('current');
        getReq.onsuccess = () => {
          if (!getReq.result) return;
          const buf = getReq.result;
          const name = _safeGet('localStorage', 'kaillera-rom-name') || 'Unknown ROM';
          const hash = _safeGet('localStorage', 'kaillera-rom-hash');
          if (hash) {
            store.put(
              {
                blob: buf,
                name,
                size: buf.byteLength,
                source: 'local',
                verified: false,
                gameName: null,
                addedAt: Date.now(),
                lastUsed: Date.now(),
              },
              hash,
            );
          }
          store.delete('current');
        };
      }
    };
    req.onsuccess = () => cb(req.result);
    req.onerror = () => cb(null);
  };

  const cacheRom = (blob, { name, source = 'local' } = {}) => {
    const reader = new FileReader();
    reader.onload = async () => {
      let hash = null;
      try {
        hash = await hashArrayBuffer(reader.result);
      } catch (_) {
        return; // can't cache without a hash
      }
      const verified = !!(hash && _knownRoms[hash]);
      const gameName = verified ? _knownRoms[hash].game : null;
      openRomDB((db) => {
        if (!db) return;
        const tx = db.transaction(_ROM_STORE, 'readwrite');
        tx.objectStore(_ROM_STORE).put(
          {
            blob: reader.result,
            name: gameName || name || 'Unknown ROM',
            size: reader.result.byteLength,
            source,
            verified,
            gameName,
            addedAt: Date.now(),
            lastUsed: Date.now(),
          },
          hash,
        );
        // Re-render after write commits (not before)
        tx.oncomplete = () => {
          if (isHost) renderRomLibrary();
        };
      });
    };
    reader.readAsArrayBuffer(blob instanceof Blob ? blob : new Blob([blob]));
  };

  const getRomLibrary = (cb) => {
    openRomDB((db) => {
      if (!db) {
        cb([]);
        return;
      }
      const tx = db.transaction(_ROM_STORE, 'readonly');
      const store = tx.objectStore(_ROM_STORE);
      const req = store.openCursor();
      const entries = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value;
          entries.push({
            hash: cursor.key,
            name: val.name,
            size: val.size,
            source: val.source,
            verified: val.verified,
            gameName: val.gameName,
            addedAt: val.addedAt,
            lastUsed: val.lastUsed,
          });
          cursor.continue();
        } else {
          // Sort by lastUsed descending
          entries.sort((a, b) => b.lastUsed - a.lastUsed);
          cb(entries);
        }
      };
      req.onerror = () => cb([]);
    });
  };

  const loadRomFromLibrary = (hash, cb) => {
    openRomDB((db) => {
      if (!db) {
        cb(false);
        return;
      }
      const tx = db.transaction(_ROM_STORE, 'readwrite');
      const req = tx.objectStore(_ROM_STORE).get(hash);
      req.onsuccess = () => {
        if (!req.result?.blob) {
          cb(false);
          return;
        }
        const val = req.result;
        const blob = new Blob([val.blob]);
        _romBlob = blob;
        _romName = val.name;
        _romSize = val.size || blob.size;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        _romHash = hash;
        _gameId = _gameIdFromHash(hash);
        KNState.romHash = hash;
        KNState.gameId = _gameId;
        _safeSet('localStorage', 'kaillera-rom-name', val.name);
        _safeSet('localStorage', 'kaillera-rom-hash', hash);
        if (isHost && _gameId && _gameId !== 'ssb64') {
          socket.emit('set-game-id', { game_id: _gameId });
        }
        // Update lastUsed
        tx.objectStore(_ROM_STORE).put({ ...val, lastUsed: Date.now() }, hash);
        // Enable ROM sharing checkbox if host
        const romShareCb = document.getElementById('opt-rom-sharing');
        if (romShareCb && isHost) romShareCb.disabled = false;
        notifyRomReady();
        cb(true, val.name);
      };
      req.onerror = () => cb(false);
    });
  };

  renderRomLibrary = () => {
    const container = document.getElementById('rom-library');
    if (!container) return;

    // Only show for host
    if (!isHost) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    getRomLibrary((entries) => {
      if (entries.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      container.style.display = '';
      container.className = 'rom-library';

      const esc = (s) =>
        s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';

      const formatSize = (bytes) => {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${bytes} B`;
      };

      let html = `<div class="rom-library-header"><span>ROM Library</span><span class="rom-count">${entries.length} ROM${entries.length !== 1 ? 's' : ''}</span></div>`;
      html += '<div class="rom-library-list">';

      for (const entry of entries) {
        const isActive = entry.hash === _romHash;
        const verifiedLabel = entry.verified
          ? `<span class="verified">Verified \u2014 ${esc(entry.gameName)}</span>`
          : '<span class="unverified">Unverified</span>';
        const sourceLabel = entry.source === 'p2p' ? 'From host' : '';

        html += `<div class="rom-library-item${isActive ? ' active' : ''}" data-hash="${esc(entry.hash)}">`;
        html += '<span class="rom-check">\u2713</span>';
        html += '<div class="rom-info">';
        html += `<div class="rom-name">${esc(entry.name)}</div>`;
        html += `<div class="rom-meta">${verifiedLabel}<span>${formatSize(entry.size)}</span>${sourceLabel ? `<span>${sourceLabel}</span>` : ''}</div>`;
        html += '</div>';
        html += `<button class="rom-delete" data-hash="${esc(entry.hash)}" title="Remove from library">\u2715</button>`;
        html += '</div>';
      }

      html += '</div>';
      container.innerHTML = html;

      // Wire click handlers
      for (const item of container.querySelectorAll('.rom-library-item')) {
        item.addEventListener('click', (e) => {
          // Don't trigger load when clicking delete
          if (e.target.closest('.rom-delete')) return;
          const hash = item.dataset.hash;
          if (hash === _romHash) return; // already active
          loadRomFromLibrary(hash, (ok, name) => {
            if (ok) {
              const drop = document.getElementById('rom-drop');
              const statusEl = document.getElementById('rom-status');
              if (drop) drop.classList.add('loaded');
              if (statusEl) statusEl.textContent = `Loaded: ${name}`;
              renderRomLibrary();
            }
          });
        });
      }

      for (const btn of container.querySelectorAll('.rom-delete')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRomFromLibrary(btn.dataset.hash);
        });
      }
    });
  };

  const deleteRomFromLibrary = (hash) => {
    openRomDB((db) => {
      if (!db) return;
      const tx = db.transaction(_ROM_STORE, 'readwrite');
      tx.objectStore(_ROM_STORE).delete(hash);
      // If we deleted the active ROM, clear it
      if (_romHash === hash) clearLoadedRom();
      // Re-render after transaction commits (not before)
      tx.oncomplete = () => renderRomLibrary();
    });
  };

  const _retroVerifyLibrary = () => {
    if (!Object.keys(_knownRoms).length) return;
    openRomDB((db) => {
      if (!db) return;
      const tx = db.transaction(_ROM_STORE, 'readwrite');
      const store = tx.objectStore(_ROM_STORE);
      const req = store.openCursor();
      let updated = false;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value;
          const known = _knownRoms[cursor.key];
          if (known && !val.verified) {
            cursor.update({
              ...val,
              verified: true,
              gameName: known.game,
              name: known.game,
            });
            updated = true;
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => {
        if (updated && isHost) renderRomLibrary();
      };
    });
  };

  const autoMatchRom = (hostHash) => {
    loadRomFromLibrary(hostHash, (ok, name) => {
      if (ok) {
        const displayName = name || 'cached ROM';
        showToast(`ROM matched \u2014 ${displayName} loaded`);
        const drop = document.getElementById('rom-drop');
        const statusEl = document.getElementById('rom-status');
        if (drop) drop.classList.add('loaded');
        if (statusEl) statusEl.textContent = `Loaded: ${displayName}`;
        if (_pendingLateJoin) dismissLateJoinPrompt();
      }
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
      // Mobile: init virtual gamepad BEFORE booting EJS so #game is already at
      // its final (smaller) size when EJS attaches its ResizeObserver.
      // If called after boot, VirtualGamepad.init appending to the body flex
      // layout shrinks #game, triggering a canvas resize mid-session.
      if ('ontouchstart' in window && !isSpectator && window.VirtualGamepad) {
        VirtualGamepad.init();
        const _detected = window.GamepadManager ? GamepadManager.getDetected() : [];
        if (_detected.length > 0) VirtualGamepad.setVisible(false);
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

    const resyncEnabled = _gameResyncEnabled;

    engine = Engine;
    engine.init({
      socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      isSpectator,
      playerName,
      gameElement: document.getElementById('game'),
      resyncEnabled,
      romHash: _romHash ?? null,
      gameId: _gameId ?? null,
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
      onSyncStatus: showSyncStatus,
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
          if (text) text.textContent = 'Connection lost — reconnecting & resyncing...';
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
    // 30 seconds, the WebRTC handshake likely failed.
    // P1-3: include the specific connection state of each peer in the
    // failure message so the operator (and the user) can tell whether it was
    // NAT traversal failure (state=failed), peer never started (state=new),
    // or signaling stalled (no peers in KNState at all).
    setTimeout(() => {
      const loadingEl = document.getElementById('game-loading');
      if (loadingEl && !loadingEl.classList.contains('hidden') && gameRunning) {
        const text = document.getElementById('game-loading-text');
        // Inspect peer connection states to give a specific reason
        const peers = KNState.peers || {};
        const peerEntries = Object.values(peers);
        let reason = 'Connection timed out';
        let detail = 'check your network or firewall';
        if (peerEntries.length === 0) {
          reason = 'No peers connected';
          detail = 'the other players never showed up — they may have left or the signaling server is unreachable';
        } else {
          const states = peerEntries.map((p) => p.pc?.connectionState || 'unknown');
          const failed = states.filter((s) => s === 'failed').length;
          const stuck = states.filter((s) => s === 'new' || s === 'connecting').length;
          if (failed > 0) {
            reason = 'WebRTC connection failed';
            detail = `${failed} of ${states.length} peer connection${states.length === 1 ? '' : 's'} failed (likely NAT/firewall — try a different network or enable a TURN server)`;
          } else if (stuck > 0) {
            reason = 'WebRTC handshake stalled';
            detail = `${stuck} of ${states.length} peer connection${states.length === 1 ? '' : 's'} stuck in ${states.includes('new') ? 'new' : 'connecting'} state — ICE may not be reaching candidates`;
          }
          // Report to telemetry so funnel timeline shows the specific reason
          KNEvent('webrtc-fail', `${reason}: ${detail}`, { states });
        }
        if (text) text.textContent = `${reason} — ${detail}`;
        crumb('connection-timeout', {
          reason,
          detail,
          states: peerEntries.map((p) => ({
            pc: p.pc?.connectionState || 'unknown',
            dc: p.dc?.readyState || 'unknown',
            slot: p.slot ?? null,
          })),
          room: roomCode,
          mode,
          slot: mySlot,
        });
        flushBreadcrumbs(reason);
        engine?.flushSyncLog?.();
        engine?.dumpLogs?.();
        showToast(reason);
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
    _preloadAudioCtx();
    const sel = document.getElementById('mode-select');
    const selectedMode = sel ? sel.value : mode;
    const optResync = document.getElementById('opt-resync');
    crumb('start-game-click', {
      mode: selectedMode,
      romHash: _romHash?.substring(0, 12),
      gameId: _gameId,
      players: lastUsersData?.players ? Object.keys(lastUsersData.players).length : null,
      ready: lastUsersData?.players
        ? Object.values(lastUsersData.players).map((p) => ({ slot: p.slot, romReady: !!p.romReady }))
        : null,
    });
    socket.emit(
      'start-game',
      {
        mode: selectedMode,
        resyncEnabled: optResync ? optResync.checked : true,
        romHash: _romHash ?? null,
        gameId: _gameId ?? null,
      },
      (err) => {
        if (err) {
          crumb('start-game-error', err);
          flushBreadcrumbs(err);
          showToast(err);
        } else {
          crumb('start-game-ack', { mode: selectedMode });
        }
      },
    );
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
      engine.stop();
      engine = null;
    }
    // Signal homepage to show feedback prompt
    try {
      localStorage.setItem('kn-feedback-prompt', '1');
    } catch (_) {}
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
      const hostRomName = hostRomDisplayName();
      msg.textContent = hostRomName
        ? `Game in progress - load ${hostRomName} to join`
        : 'Game in progress - load a ROM to join';
      card.insertBefore(msg, card.firstChild);
    }
  };

  const dismissLateJoinPrompt = () => {
    crumb('dismiss-late-join', {
      romHash: _romHash?.substring(0, 12),
      hostHash: _hostRomHash?.substring(0, 12),
      sharingEnabled: _romSharingEnabled,
      sharingDecision: _romSharingDecision,
    });
    _pendingLateJoin = false;

    // Verify ROM hash before joining (skip if ROM sharing — ROM comes from host)
    if (hostRomMismatch() && _romSharingDecision !== 'accepted') {
      if (_romSharingEnabled && _romSharingDecision === null) {
        // ROM sharing available but user hasn't decided yet (e.g. auto-loaded
        // a cached ROM from a previous game). Stay on the sharing prompt so
        // they can accept the host's ROM instead of erroring out.
        _pendingLateJoin = true;
        return;
      }
      showError("Your ROM doesn't match the host's game. Drop the correct ROM to rejoin.");
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

    // Ensure _lateJoin is set — dismissLateJoinPrompt only runs for mid-game
    // joins. The flag may have been consumed by a prior initEngine() call
    // (e.g., game-started handler for ROM sharing no-ROM path).
    if (gameRunning) _lateJoin = true;

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
    updateHostRomInfo();

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
      const romEl = slotEl.querySelector('.rom-status');

      if (playerInSlot) {
        const isOwner = ownerSid && playerInSlot.socketId === ownerSid;
        const suffix = isOwner ? ' (host)' : '';
        nameEl.textContent = playerInSlot.playerName + suffix;
        nameEl.classList.remove('empty');
        if (/\b(a21|agent[- ]?21|atwenty0ne)\b/i.test(playerInSlot.playerName)) nameEl.dataset.a21 = '1';
        else delete nameEl.dataset.a21;
        // ROM ready indicator (pre-game only)
        if (romEl) {
          if (!gameRunning) {
            const ready = !!playerInSlot.romReady;
            romEl.textContent = ready ? 'Ready' : 'Not Ready';
            romEl.className = `rom-status ${ready ? 'ready' : 'not-ready'}`;
          } else {
            romEl.textContent = '';
            romEl.className = 'rom-status';
          }
        }
        // Show input type indicator
        if (gpEl) {
          const itype = playerInSlot.inputType || 'keyboard';
          const gpLabel = itype === 'gamepad' ? 'Gamepad' : 'Keyboard';
          gpEl.textContent = itype === 'gamepad' ? '\uD83C\uDFAE' : '\u2328\uFE0F';
          gpEl.title = gpLabel;
          gpEl.setAttribute('aria-label', gpLabel);
        }
        // Show device type indicator
        if (devEl) {
          const dtype = playerInSlot.deviceType || 'desktop';
          const devLabel = dtype === 'mobile' ? 'Mobile' : 'Desktop';
          devEl.textContent = dtype === 'mobile' ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F';
          devEl.title = devLabel;
          devEl.setAttribute('aria-label', devLabel);
        }
      } else {
        nameEl.textContent = 'Open';
        nameEl.classList.add('empty');
        delete nameEl.dataset.a21;
        if (romEl) {
          romEl.textContent = '';
          romEl.className = 'rom-status';
        }
        if (gpEl) {
          gpEl.textContent = '';
          gpEl.title = '';
          gpEl.removeAttribute('aria-label');
        }
        if (devEl) {
          devEl.textContent = '';
          devEl.title = '';
          devEl.removeAttribute('aria-label');
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
    if (roomEl) roomEl.textContent = roomCode;

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
    const modeLabel = info.mode === 'streaming' ? 'Streaming' : info.rollback ? 'Rollback' : 'Lockstep';
    if (headerEl) headerEl.textContent = `${modeLabel} | ${inputType}`;

    // Stats line
    const parts = [];
    parts.push(`FPS: ${info.fps || 0}`);
    const pingStr = info.ping !== null && info.ping !== undefined ? `${Math.round(info.ping)}ms` : '--';
    parts.push(`Ping: ${pingStr}`);

    if (info.mode === 'lockstep') {
      if (info.rollback) {
        parts.push(`Delay: ${info.frameDelay}f (feels 0f)`);
      } else {
        parts.push(`Delay: ${info.frameDelay}f`);
      }
      parts.push(`Players: ${info.playerCount}`);
      if (info.rollback) {
        parts.push(`Rollback: ${info.rollback.rollbacks}/${info.rollback.predictions}`);
      }
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

  const showSyncStatus = (_msg) => {
    // Intentionally silent — updating toolbar-status wraps the toolbar on mobile,
    // shrinking #game and triggering EJS ResizeObserver (canvas clear).
  };

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

  // Expose toast/error for cross-module UI surfacing (P1-3). Other modules
  // (shared.js, netplay-lockstep.js) can call these to show user-visible
  // messages instead of failing silently.
  window.knShowToast = showToast;

  // ── UI: Error ──────────────────────────────────────────────────────────

  const showError = (msg) => {
    crumb('error', msg);
    flushBreadcrumbs(msg);
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

  // Expose for cross-module UI surfacing — see knShowToast comment above.
  window.knShowError = showError;

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

  const _gameParam = () => {
    // Include game_id in shared URLs so OG cards show the right background
    // even if the room doesn't exist yet when the crawler fetches it
    if (_gameId) return _gameId;
    const params = new URLSearchParams(window.location.search);
    return params.get('game') || 'ssb64';
  };

  const copyLink = () => {
    // Toggle overlay invite dropdown — positioned via JS to escape overflow:auto clipping
    const existing = document.getElementById('kn-invite-dropdown');
    if (existing) {
      existing.remove();
      return;
    }
    const btn = document.getElementById('copy-link');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    const dropdown = document.createElement('div');
    dropdown.id = 'kn-invite-dropdown';
    Object.assign(dropdown.style, {
      position: 'fixed',
      top: `${rect.bottom + 6}px`,
      right: `${window.innerWidth - rect.right}px`,
      background: '#1a1a2e',
      border: '1px solid #2a2a40',
      borderRadius: '8px',
      padding: '4px',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: '140px',
      zIndex: '99999',
    });

    const makeOption = (label, url, title) => {
      const opt = document.createElement('button');
      opt.textContent = label;
      opt.className = 'share-option';
      opt.addEventListener('click', () => {
        shareOrCopy(url, `${label} link`, title);
        dropdown.remove();
      });
      return opt;
    };

    const playUrl = `${window.location.origin}/play.html?room=${roomCode}&game=${_gameParam()}`;
    const watchUrl = `${playUrl}&spectate=1`;
    dropdown.append(
      makeOption('Play', playUrl, 'Join my game on Kaillera Next'),
      makeOption('Watch', watchUrl, 'Watch my game on Kaillera Next'),
    );

    document.body.appendChild(dropdown);

    // Close on outside click (next tick to avoid immediate self-close)
    setTimeout(() => {
      const close = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
          dropdown.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  };

  // ── UI: In-Game Share Dropdown ──────────────────────────────────────

  const _canNativeShare = _isMobile && typeof navigator.share === 'function';

  const nativeShare = async (url, title) => {
    try {
      await navigator.share({ title, url });
    } catch (err) {
      // AbortError = user dismissed; NotAllowedError = permission denied (e.g. no gesture)
      if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
        showToast('Share failed');
      }
    }
  };

  const shareOrCopy = async (url, label, title) => {
    if (_canNativeShare) {
      await nativeShare(url, title);
    } else {
      await copyToClipboard(url, label);
    }
  };

  const copyToClipboard = async (text, label) => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`${label} copied!`);
        return;
      } catch (_) {
        /* fall through to execCommand fallback */
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`${label} copied!`);
  };

  // ── UI: More (overflow) Dropdown ──────────────────────────────────────

  const toggleMoreDropdown = () => {
    const dd = document.getElementById('more-dropdown');
    const btn = document.getElementById('toolbar-more');
    if (!dd) return;
    const isOpen = !dd.classList.contains('hidden');
    if (isOpen) {
      dd.classList.add('hidden');
      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
      }
    } else {
      dd.classList.remove('hidden');
      if (btn) {
        btn.classList.add('active');
        btn.setAttribute('aria-expanded', 'true');
      }
    }
  };

  const closeMoreDropdown = () => {
    const dd = document.getElementById('more-dropdown');
    const btn = document.getElementById('toolbar-more');
    if (dd) dd.classList.add('hidden');
    if (btn) {
      btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
    }
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
        ? JSON.parse(_safeGet('localStorage', `gamepad-profile:${gamepadId}`))
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
      savedKb = JSON.parse(_safeGet('localStorage', 'keyboard-mapping'));
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
      _safeSet('localStorage', 'keyboard-mapping', JSON.stringify(_wizardKeyMap));
    } catch (_) {}

    cancelWizard();

    // Refresh settings panel mapping grid if open
    if (window.ControllerSettings?._refreshGrid) ControllerSettings._refreshGrid();
  };

  const resetMappings = () => {
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && window.GamepadManager) {
      GamepadManager.clearGamepadProfile(detected[0].id);
    }
    try {
      _safeRemove('localStorage', 'keyboard-mapping');
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
    // Agent 21 badge — gold jersey number for the creator's handle
    const _a21style = document.createElement('style');
    _a21style.textContent =
      `.name[data-a21]::after{content:'21';display:inline-block;` +
      `margin-left:5px;padding:1px 5px;background:#c9a227;color:#111;` +
      `border-radius:3px;font-size:.7em;font-weight:700;vertical-align:middle;}`;
    document.head.appendChild(_a21style);
    parseParams();
    // Fetch known ROM hashes for verification
    fetch('/api/rom-hashes')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        _knownRoms = data;
        if (_romHash) {
          _gameId = _gameIdFromHash(_romHash);
          KNState.gameId = _gameId;
        }
        updateHostRomInfo();
        // Retroactively verify any cached ROMs that were stored before
        // the known-hash table was available (e.g. v1→v2 migration)
        _retroVerifyLibrary();
      })
      .catch(() => {}); // non-fatal — verification just won't work
    if (!roomCode) {
      window.location.href = '/';
      return;
    }

    // Feature detection — report missing capabilities
    const missing = [];
    if (typeof RTCPeerConnection === 'undefined') missing.push('RTCPeerConnection');
    if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
    if (!self.crossOriginIsolated) missing.push('crossOriginIsolated');
    if (missing.length) {
      KNEvent('compat', `Missing: ${missing.join(', ')}`, { missing });
    }

    // Name input — populate from current name, save + notify on change
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) {
      nameInput.value = playerName;
      nameInput.addEventListener('change', () => {
        const val = nameInput.value.trim();
        if (val && val !== playerName) {
          playerName = val;
          _safeSet('localStorage', 'kaillera-name', playerName);
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
    if (toolbarEnd)
      toolbarEnd.addEventListener('click', () => {
        closeMoreDropdown();
        endGame();
      });

    const toolbarInfo = document.getElementById('toolbar-info');
    if (toolbarInfo)
      toolbarInfo.addEventListener('click', () => {
        closeMoreDropdown();
        toggleInfoOverlay();
      });

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

    const sharePlay = document.getElementById('share-play');
    if (sharePlay) {
      sharePlay.addEventListener('click', () => {
        const url = `${window.location.origin}/play.html?room=${roomCode}&game=${_gameParam()}`;
        shareOrCopy(url, 'Play link', 'Join my game on Kaillera Next');
        closeMoreDropdown();
      });
    }

    const shareWatch = document.getElementById('share-watch');
    if (shareWatch) {
      shareWatch.addEventListener('click', () => {
        const url = `${window.location.origin}/play.html?room=${roomCode}&game=${_gameParam()}&spectate=1`;
        shareOrCopy(url, 'Watch link', 'Watch my game on Kaillera Next');
        closeMoreDropdown();
      });
    }

    // More (overflow) dropdown
    const toolbarMore = document.getElementById('toolbar-more');
    if (toolbarMore) toolbarMore.addEventListener('click', toggleMoreDropdown);

    // Close dropdowns on outside click or Escape
    document.addEventListener('click', (e) => {
      const moreW = document.getElementById('more-wrapper');
      if (moreW && !moreW.contains(e.target)) closeMoreDropdown();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMoreDropdown();
      }
    });

    const copyBtn = document.getElementById('copy-link');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    // Show/hide lockstep options based on mode selector
    const modeSelect = document.getElementById('mode-select');
    const lockstepOpts = document.getElementById('lockstep-options');
    if (modeSelect && lockstepOpts) {
      // Set mode-select from URL params before running updateOpts
      modeSelect.value = mode;
      let _romSharingBeforeStreamingMode = false;
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
        const cb = document.getElementById('opt-rom-sharing');
        if (!isLockstep) {
          // Switching to streaming — save and disable sharing
          _romSharingBeforeStreamingMode = cb?.checked ?? false;
          if (cb?.checked) {
            cb.checked = false;
            socket.emit('rom-sharing-toggle', { enabled: false });
          }
        } else if (_romSharingBeforeStreamingMode && cb && !cb.checked) {
          // Switching back to lockstep — restore previous sharing state
          cb.checked = true;
          socket.emit('rom-sharing-toggle', { enabled: true });
          _romSharingBeforeStreamingMode = false;
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
    if (!_ROM_SHARING_FEATURE) {
      // Feature disabled server-side — hide all ROM sharing UI permanently.
      const sharingRow = document.getElementById('rom-sharing-options');
      const sharingPrompt = document.getElementById('rom-sharing-prompt');
      const sharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
      if (sharingRow) sharingRow.style.display = 'none';
      if (sharingPrompt) sharingPrompt.style.display = 'none';
      if (sharingDisclaimer) sharingDisclaimer.style.display = 'none';
    } else {
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
    }

    // ROM sharing accept/decline/cancel buttons
    const romAcceptBtn = document.getElementById('rom-accept-btn');
    if (romAcceptBtn) romAcceptBtn.addEventListener('click', acceptRomSharing);

    // rom-decline-btn removed — guests now see rom-drop + compact "accept from host" option

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

    const overlaySettingsBtn = document.getElementById('overlay-settings-btn');
    if (overlaySettingsBtn) overlaySettingsBtn.addEventListener('click', () => window.ControllerSettings?.toggle());

    const backBtn = document.getElementById('remap-back');
    if (backBtn) backBtn.addEventListener('click', wizardBack);

    const skipBtn = document.getElementById('remap-skip');
    if (skipBtn) skipBtn.addEventListener('click', wizardSkip);

    const cancelBtn = document.getElementById('remap-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelWizard);

    // In-game remap (toolbar button + overlay buttons)
    const toolbarRemapBtn = document.getElementById('toolbar-remap');
    if (toolbarRemapBtn)
      toolbarRemapBtn.addEventListener('click', () => {
        closeMoreDropdown();
        if (window.ControllerSettings) {
          ControllerSettings.open();
          ControllerSettings.startQuickSetup?.();
        } else {
          startWizard(true);
        }
      });

    // Controller settings panel (gear button)
    const settingsBtn = document.getElementById('toolbar-settings');
    if (settingsBtn)
      settingsBtn.addEventListener('click', () => {
        closeMoreDropdown();
        window.ControllerSettings?.toggle();
      });

    // Expose in-game wizard start for Quick Setup integration
    window._startIngameRemap = () => startWizard(true);

    const igBackBtn = document.getElementById('ingame-remap-back');
    if (igBackBtn) igBackBtn.addEventListener('click', wizardBack);

    const igSkipBtn = document.getElementById('ingame-remap-skip');
    if (igSkipBtn) igSkipBtn.addEventListener('click', wizardSkip);

    const igCancelBtn = document.getElementById('ingame-remap-cancel');
    if (igCancelBtn) igCancelBtn.addEventListener('click', cancelWizard);

    // Sync log upload (placeholder — now handled by continuous Socket.IO streaming)
    const toolbarLogs = document.getElementById('toolbar-logs');
    if (toolbarLogs) {
      toolbarLogs.addEventListener('click', () => {
        closeMoreDropdown();
        showToast('Logs are streamed continuously to the server');
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

  // E2E test hooks — getter returns live socket value (socket is null until async init)
  Object.defineProperty(window, '__test_socket', { get: () => socket, configurable: true });
  window.__test_setRomLoaded = () => {
    _romBlob = new Uint8Array([0]);
    _romBlobUrl = 'blob:test';
    window.__test_skipBoot = true;
  };
})();
