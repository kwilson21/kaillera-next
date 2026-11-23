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
 *   5. onGameStarted(): boot EmulatorJS, create engine (rollback or streaming)
 *   6. Engine runs the game; play.js updates toolbar, info overlay, toasts
 *   7. Host clicks "End Game" → server broadcasts game-ended
 *   8. onGameEnded(): hibernate emulator (keep WASM alive), return to overlay
 *   9. Next game: wake emulator, create new engine — no page reload needed
 *
 * ── Emulator Lifecycle ──────────────────────────────────────────────────
 *
 *   The WASM module is kept alive between same-ROM games via
 *   hibernateEmulator() / wakeEmulator(). Emscripten's main loop corrupts on
 *   repeated EmulatorJS destroy/recreate cycles, so we pause and hide the
 *   emulator for same-ROM restarts and mode switches. When the ROM hash
 *   changes, the old instance is destroyed before booting the new ROM.
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
 *   Creates: window.NetplayRollback.init() or window.NetplayStreaming.init()
 */
(function () {
  'use strict';

  // The TypeScript core (dist/kn-core.js) is part of this page: the room
  // logic, the error card and the engine all call it, from the first lines
  // below. If it did not load (the request failed, or something blocked the
  // script), nothing here can run, so the page says so and stops instead of
  // throwing half way through setting up.
  if (!window.KNCore) {
    const sayReload = () => {
      const box = document.getElementById('error-msg');
      const card = box?.querySelector('.error-card');
      if (!box || !card) return;
      card.textContent = 'Part of this page did not load. Reload the page to try again.';
      box.classList.remove('hidden');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sayReload);
    else sayReload();
    return;
  }

  const { safeGet: _safeGet, safeSet: _safeSet, safeRemove: _safeRemove } = KNState;

  // ── State ──────────────────────────────────────────────────────────────

  let socket = null;
  let roomCode = null;
  let playerName = null;
  let isHost = false;
  let isSpectator = false;
  let mode = 'rollback';
  let mySlot = null;
  let coreFatal = false;

  // The mode at every intake (URL, dropdown, users-updated, game-started,
  // REST, data-message): rollback, lockstep or streaming, anything else
  // rollback (web/src/play/mode.ts). Rollback and lockstep both run the game
  // on every page; only streaming does not.
  const normalizeMode = window.KNCore.play.mode.normalizeMode;
  const everyoneRunsTheGame = window.KNCore.play.mode.everyoneRunsTheGame;

  const emulatorMissing = () => {
    const missing = [];
    if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
    if (!self.crossOriginIsolated) missing.push('crossOriginIsolated');
    return missing;
  };

  let _unsupportedReleasePending = false;
  let _unsupportedReleaseFailed = false;
  const releaseUnsupportedPlayer = (message) => {
    const missing = emulatorMissing();
    if (!missing.length) return false;
    if (!_unsupportedReleasePending && !_unsupportedReleaseFailed && socket?.connected) {
      _unsupportedReleasePending = true;
      socket.emit('release-slot', {}, (err) => {
        if (err) {
          _unsupportedReleasePending = false;
          _unsupportedReleaseFailed = true;
          socket.emit('leave-room', {});
          socket.disconnect();
          showUnsupportedBrowser(missing);
          return;
        }
        showToast(message);
      });
    }
    return true;
  };
  let lastUsersData = null;
  let engine = null;
  let _endGameRequest = null;
  let _lastHandledGameEndMatchId = null;
  let _unverifiedMatchId = null;
  const RECOVERY_UNVERIFIED = 'Recovery unverified. The host can end this match.';
  let _gameResyncEnabled = true;
  let previousPlayers = {};
  let previousSpectators = {};

  // Page lifecycle state machine from the TypeScript core (web/src/session.ts).
  // Stage 2: the machine says whether a game is on for this page.
  // A page that joined a match in play tells the server once it is in it:
  // until then the server counts this player as waiting for the match, and
  // ends a match that only waiting players are left in.
  const _tellServerMatchJoined = (matchId) => {
    if (socket?.connected) socket.emit('match-joined', { matchId });
  };
  const _session =
    window.KNCore?.createSession(({ type, ...meta }) => KNEvent(type, '', meta), undefined, _tellServerMatchJoined) ??
    null;
  const isGameRunning = () => _session?.gameOn() ?? false;
  KNState.gameOn = isGameRunning;
  // What the server and peers send this page is decoded before a handler sees
  // it (web/src/socket-boundary.ts): a server event, a join-room ack, a relay
  // of what a peer sent, a ROM transfer channel's text. A message off its
  // schema is dropped and logged; no handler runs on it.
  const _boundary = window.KNCore.protocol.createBoundary((line) => console.warn(line));
  let _sessionLateJoinPoll = null;
  const _sessionStopLateJoinPoll = () => {
    if (_sessionLateJoinPoll) clearInterval(_sessionLateJoinPoll);
    _sessionLateJoinPoll = null;
  };
  // A late join is done once the emulator is advancing frames.
  const _sessionWatchLateJoin = () => {
    if (!_session || _sessionLateJoinPoll) return;
    _sessionLateJoinPoll = setInterval(() => {
      if (!(KNState.frameNum > 0)) return;
      _sessionStopLateJoinPoll();
      _session.send({ type: 'lateJoinSynced' });
    }, 1000);
  };
  let _romBlob = null; // raw ROM Blob for re-creating blob URLs
  let _romBlobUrl = null;
  let _romHash = null; // SHA-256 hex of loaded ROM
  // Each change of the loaded ROM (a drop, a library pick, the host's ROM, a
  // clear) is a new load; _romHash is kept with the load it was computed for.
  // A dropped file is loaded at once but hashed a moment later, and until
  // then _romHash is the previous ROM's (specs/rom_identity.qnt).
  let _romLoad = 0;
  let _romHashLoad = 0;
  let _romName = null; // display name for the loaded ROM
  let _romSize = null; // byte size for the loaded ROM
  // The loaded ROM is one the player dropped themselves (its name), not a copy
  // the page chose (the library, the cache, the host's transfer). Told why
  // when the host's ROM turns out not to match it; a copy the page chose is
  // swapped quietly.
  let _romDroppedName = null;
  let _gameId = null; // derived from ROM hash via known_roms table
  // The host's ROM as the room last reported it ({hash, name, size, gameId,
  // changing}: hostRomFromData), replaced whole at each report. null until
  // join-room or the REST lookup has reported it (or that there is none).
  let _hostRom = null;
  let _pendingRomAutoload = null; // {lastHash, savedRom, drop, statusEl} — guest autoload deferred until host ROM is known
  let _pendingRomAutoloadTimer = null;
  let _hibernated = false; // true when emulator is hibernated between games
  let _hibernatedRomHash = null; // ROM hash at time of hibernate (detect ROM changes)
  let _emulatorBootInFlight = false; // true while ejs-loader is creating a fresh instance
  // The late-join questions are the machine's to answer (web/src/session.ts):
  // it is told of every change and the page keeps no flags of its own.
  // "Waiting for a ROM before the late join can start":
  const _setPendingLateJoin = (pending) => {
    _session?.send({ type: pending ? 'lateJoinRomNeeded' : 'lateJoinRomReady' });
  };
  const _isPendingLateJoin = () => _session?.flag('pendingLateJoin') ?? false;
  // "The next engine start is a late join":
  const _isLateJoin = () => _session?.flag('lateJoin') ?? false;
  // Server-injected feature flag — false when ROM_SHARING_ENABLED=false in env.
  const _ROM_SHARING_FEATURE = window.KN_CONFIG?.romSharingEnabled !== false;

  let _knownRoms = {}; // populated from /api/rom-hashes on load
  let renderRomLibrary = () => {}; // replaced with full impl after IDB functions

  const _gameIdHintFromUrl = () => {
    const hint = new URLSearchParams(window.location.search).get('game');
    return /^[a-z0-9-]{1,32}$/.test(hint || '') ? hint : null;
  };

  // The game a ROM is, from the known-ROMs table or the invite link's hint.
  // A ROM in neither has no game id: it is not taken for SSB64.
  const _gameIdFromHash = (hash) => {
    if (hash && _knownRoms[hash]?.game_id) return _knownRoms[hash].game_id;
    return _gameIdHintFromUrl();
  };

  // The host tells the room which game its ROM is, or that it has none.
  const _announceGameId = () => {
    if (isHost && socket?.connected) socket.emit('set-game-id', { game_id: _gameId || '' });
  };

  // The room's game id is the host's ROM. A guest takes whatever the room
  // says, empty included: the host's ROM is one the site does not list, and
  // keeping an earlier id (say Smash Remix's) would turn on that game's
  // workarounds for another. The host's own ROM decides its id; it takes the
  // room's only when the room names a game, as before.
  const _takeRoomGameId = (gameId) => {
    if (typeof gameId !== 'string') return;
    if (isHost && !gameId) return;
    _gameId = gameId || null;
    KNState.gameId = _gameId;
  };

  // ROM drop-zone status line. Every "Loaded: …" update goes through
  // _setRomStatus so a ROM missing from the known_roms table is flagged no
  // matter how it was loaded (drop, library, host transfer). Only SHA-256
  // hashes can be checked (the FNV fallback on insecure origins never
  // matches), and nothing is flagged until the table has loaded.
  let _romStatusText = '';
  let _warnedRomHash = null; // toast once per ROM

  const _isUnsupportedRom = () =>
    !!_romHash && _romHash[0] === 'S' && Object.keys(_knownRoms).length > 0 && !_knownRoms[_romHash];

  const _supportedRomNames = () =>
    [...new Set(Object.values(_knownRoms).map((r) => (r.region ? `${r.game} (${r.region})` : r.game)))].join(', ');

  const _renderRomStatus = () => {
    const statusEl = document.getElementById('rom-status');
    const unsupported = _isUnsupportedRom();
    if (statusEl) {
      statusEl.textContent = unsupported
        ? `${_romStatusText} \u2014 not a supported ROM, it may not work`
        : _romStatusText;
      statusEl.classList.toggle('rom-unsupported', unsupported);
    }
    if (unsupported && _warnedRomHash !== _romHash) {
      _warnedRomHash = _romHash;
      // \u00a77.4 wrong/unsupported-ROM copy: amber, names what's supported.
      // Doesn't block Start (\u00a77.2 M3 #1) \u2014 see updateStartButton.
      showToast(`Not a supported ROM. It may not work. Supported: ${_supportedRomNames()}`);
    }
  };

  const _setRomStatus = (text) => {
    _romStatusText = text;
    _renderRomStatus();
  };

  // Wrong-ROM banner (W4 variant) \u2014 persistent, names both games, stays
  // until the guest drops a matching ROM or picks another one.
  const showRomMismatch = (droppedName) => {
    const el = document.getElementById('rom-mismatch');
    const text = document.getElementById('rom-mismatch-text');
    if (!el || !text) return;
    const hostName = hostRomDisplayName() || 'a different game';
    text.textContent = `Your ROM doesn't match. Host is playing ${hostName}; you dropped ${droppedName || 'a different ROM'}.`;
    el.hidden = false;
  };

  const hideRomMismatch = () => {
    const el = document.getElementById('rom-mismatch');
    if (el) el.hidden = true;
  };

  let _romSharingEnabled = false; // room-level: host has sharing toggled on
  let _romSharingDecision = null; // 'accepted' once the player takes the host's ROM, else null
  // Where this guest's transfer of the host's ROM stands: its phase, retries,
  // the bytes counted and the host's header. It moves only through
  // rom-transfer.ts's receiverStep (`romStep` below), which also says what to
  // do next; the code here keeps the channel, the timers, the bytes and the page.
  const _romRules = window.KNCore.play.romTransfer;
  let _romReceiver = _romRules.IDLE;
  const romStepWhole = (event) => {
    const step = _romRules.receiverStep(_romReceiver, event);
    _romReceiver = step.state;
    return step;
  };
  const romStep = (event) => romStepWhole(event).next;
  let _romTransferStallTimer = null; // setTimeout ID — resets on each chunk
  let _romTransferResumeTimer = null; // setTimeout ID — 15s resume timeout
  let _romTransferChunks = []; // the bytes held, as many as the receiver counts
  let _romTransferDC = null; // active rom-transfer DataChannel (receiver side)
  let _romTransferDCs = {}; // active rom-transfer DataChannels (sender side, keyed by sid)
  let _romAcceptPollInterval = null; // polling interval for mid-game accept signaling
  const ROM_MAX_SIZE = _romRules.ROM_MAX_SIZE; // the largest ROM a guest accepts (rom-transfer.ts)
  const _GFX_RECOVERY_PROFILES = ['texrect', 'texrect-unopt', 'webgl1', 'angrylion'];
  let _gfxRecoveryAttempt = 0;
  let _runtimeGfxProfile = null;

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

  const applyRuntimeGfxProfile = (profile) => {
    if (!_GFX_RECOVERY_PROFILES.includes(profile) && profile !== 'unpack1') return false;
    window.EJS_defaultOptions = window.EJS_defaultOptions || {};
    if (profile === 'texrect') {
      Object.assign(window.EJS_defaultOptions, {
        'mupen64plus-EnableNativeResTexrects': 'Optimized',
        'mupen64plus-EnableTexCoordBounds': 'True',
        'mupen64plus-CorrectTexrectCoords': 'Force',
      });
    } else if (profile === 'texrect-unopt') {
      Object.assign(window.EJS_defaultOptions, {
        'mupen64plus-EnableNativeResTexrects': 'Unoptimized',
        'mupen64plus-EnableTexCoordBounds': 'True',
        'mupen64plus-CorrectTexrectCoords': 'Force',
        'mupen64plus-BackgroundMode': 'Stripped',
      });
    } else if (profile === 'webgl1') {
      window.EJS_forceLegacyCores = true;
      window.EJS_defaultOptions.webgl2Enabled = 'disabled';
    } else if (profile === 'angrylion') {
      window.EJS_defaultOptions['mupen64plus-rdp-plugin'] = 'angrylion';
    } else if (profile === 'unpack1') {
      window.__knInstallUnpackAlignmentShim?.();
    }
    _runtimeGfxProfile = profile;
    window.__knRuntimeGfxProfile = profile;
    console.log('[play] applied graphics profile:', profile);
    return true;
  };

  const initialRuntimeGfxProfile =
    new URLSearchParams(window.location.search).get('kngfx') || _safeGet('sessionStorage', 'kn-gfx-recovery-profile');
  if (initialRuntimeGfxProfile) applyRuntimeGfxProfile(initialRuntimeGfxProfile);

  const recoverSolidCanvas = ({ reason = 'solid-pale-canvas', health = null } = {}) => {
    while (_gfxRecoveryAttempt < _GFX_RECOVERY_PROFILES.length) {
      const profile = _GFX_RECOVERY_PROFILES[_gfxRecoveryAttempt++];
      if (profile === _runtimeGfxProfile) continue;
      applyRuntimeGfxProfile(profile);
      _safeSet('sessionStorage', 'kn-gfx-recovery-profile', profile);
      crumb('gfx-recovery', {
        reason,
        profile,
        attempt: _gfxRecoveryAttempt,
        health: health
          ? {
              brightness: health.brightness,
              stdev: health.stdev,
              range: health.range,
              paleRatio: health.paleRatio,
              yellowGreenRatio: health.yellowGreenRatio,
            }
          : null,
      });
      KNEvent('compat', 'Renderer returned a solid pale/yellow frame; retrying with safer graphics profile', {
        reason,
        profile,
        attempt: _gfxRecoveryAttempt,
        health,
      });
      showToast(`Renderer retry: ${profile}`);
      engine?.flushSyncLog?.();
      destroyEmulator();
      _hibernated = false;
      _hibernatedRomHash = null;
      return { profile, attempt: _gfxRecoveryAttempt };
    }
    KNEvent('compat', 'Renderer recovery exhausted all graphics profiles', { reason, health });
    return false;
  };

  window.KNRecoverSolidCanvas = recoverSolidCanvas;

  const ROM_CHUNK_SIZE = 64 * 1024; // 64KB — same for all platforms
  const ROM_BUFFER_THRESHOLD = 1024 * 1024; // 1MB — DC handles this fine on mobile
  let _romTransferLastChunkAt = 0;
  let _funnelRomLoadedSent = false; // P0-1 funnel: fire rom_loaded once per session
  let _preGamePC = null; // guest: pre-game RTCPeerConnection for ROM preload
  let _preGamePCs = {}; // host: pre-game RTCPeerConnections (sid → pc)
  let _romSignalHandler = null; // pre-game rom-signal Socket.IO listener
  let _currentInputType = _isMobile ? 'gamepad' : 'keyboard';
  let _autoSpectated = false; // true if we auto-joined as spectator due to full room
  // HMAC token for sync-log/cache-state uploads. Scoped per-room so a token
  // cached from room A is never replayed against room B (the server checks
  // the token's "room" claim against the request's room param and returns
  // 403 on mismatch). Initialize from cache so KNEvent works before the
  // socket-issued upload-token event arrives.
  const _urlRoomCode = new URLSearchParams(window.location.search).get('room') || '';
  const _uploadTokenKey = _urlRoomCode ? `kn-upload-token:${_urlRoomCode}` : '';
  let _uploadToken = (_uploadTokenKey && _safeGet('localStorage', _uploadTokenKey)) || '';
  KNState.uploadToken = _uploadToken;

  const _persistentId =
    _safeGet('sessionStorage', 'kn-player-id') ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  _safeSet('sessionStorage', 'kn-player-id', _persistentId);
  let _reconnectToken = _safeGet('sessionStorage', 'kn-reconnect-token') || '';

  // Moved to TypeScript (web/src/play/): this page reads them from the core
  // bundle, which play.html loads just before this file.
  const {
    escapeHtml,
    formatRomSize,
    hostRomFromData,
    hostRomIdentityKey,
    romHashMismatch,
    romIdentity,
    roomClosedMessage,
    rosterToasts,
  } = window.KNCore.play;

  const hostRomDisplayName = () => {
    const hash = _hostRom?.hash;
    if (hash && _knownRoms[hash]?.game) return _knownRoms[hash].game;
    if (_hostRom?.name) return _hostRom.name;
    if (hash) return `Unknown ROM (${hash.substring(1, 9)})`;
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
      el.textContent = _hostRom?.changing ? 'Host is loading a ROM…' : 'Waiting for host to load a ROM';
      el.className = 'host-rom-info pending';
      return;
    }
    const bits = [`Host ROM: ${name}`];
    const size = formatRomSize(_hostRom?.size);
    if (size) bits.push(size);
    el.style.display = '';
    el.textContent = bits.join(' | ');
    el.className = 'host-rom-info ready';
  };

  const localRomLoaded = () => !!(_romBlob || _romBlobUrl);

  const romHashIsLoaded = () => romIdentity.hashIsTheLoadedRoms(_romHashLoad, _romLoad);

  // The host's ROM is changing, as a guest sees it: the host's own page judges
  // its ROM against no one's.
  const hostRomChanging = () => !isHost && !!_hostRom?.changing;

  // The loaded ROM against the host's: `pending` while its own hash is not in
  // (a size that is not the host's refuses it at once), and while the host's
  // ROM is changing (specs/rom_identity.qnt, hostChangesToTheGuestsRomTest).
  const romVerdictNow = () => {
    const hostSize = _hostRom?.size ?? null;
    return romIdentity.romVerdict(
      localRomLoaded(),
      hostRomChanging(),
      romHashIsLoaded(),
      romHashMismatch(_hostRom?.hash, _romHash),
      hostSize !== null && _romSize !== null && hostSize !== Number(_romSize),
    );
  };

  const hostRomMismatch = () => romVerdictNow() === 'mismatch';

  const resetTransferForHostRomChange = () => {
    if (_romReceiver.phase !== 'idle' || _romReceiver.received > 0) {
      resetRomTransfer();
      setRomTransferState('idle');
    }
    if (_romSharingEnabled) _romSharingDecision = null;
    cleanupPreGameConnections();
  };

  // The ROM is not the host's: it goes, the player who dropped it is told why
  // (`droppedName`), the transfer state goes with the host's ROM it was for,
  // and the page looks for the host's ROM in its library (a match found
  // hides the banner again). One path for the host's ROM arriving and for a
  // drop whose own hash, landing, says so.
  const refuseRom = (droppedName) => {
    clearLoadedRom();
    if (droppedName) showRomMismatch(droppedName);
    resetTransferForHostRomChange();
    // The page held a ROM a moment ago: it wants the host's, spectating or
    // not (a spectator may claim a slot).
    if (romIdentity.looksInLibraryForHostsRom(true, localRomLoaded(), !!_hostRom?.hash)) {
      autoMatchRom(_hostRom.hash);
    }
    updateRomSharingUI();
  };

  // A dropped ROM that could not be read or hashed: the page cannot tell
  // whose it is, so it does not keep it (specs/rom_identity.qnt,
  // hashFailsTest). Announced by its size alone, a wrong ROM the host's size
  // would be counted ready and booted.
  const refuseUnreadableRom = (message) => {
    clearLoadedRom();
    showToast(message);
  };

  // The loaded ROM's hash, landed for `load`. The hash and what is read from
  // it first and the load number after, so nothing on the way can leave the
  // previous ROM's hash marked as this load's (specs/rom_identity.qnt). A
  // ROM from the host whose hash failed takes none (it is the host's by size),
  // and no game id or emulator identity of the ROM before it.
  const takeRomHash = (load, hash) => {
    _romHash = hash;
    KNState.romHash = hash;
    _gameId = _gameIdFromHash(hash);
    KNState.gameId = _gameId;
    window.EJS_gameID = hash || 'kaillera-next';
    _romHashLoad = load;
    discardHibernatedEmulatorForRomChange(hash);
  };

  // `hasNext`: the room names a host ROM. While the host's is changing it
  // names none: the page keeps its ROM, judges it against nothing and says it
  // is not ready, and the host's new hash, once the room's, decides.
  // `roomHadReported`: this is not the room's first report to the page (at
  // the first, the join's own autoload looks in the library).
  const handleHostRomChanged = (hadPrevious, hasNext, toastOnChange, roomHadReported) => {
    if (isHost) return;
    if (hadPrevious && toastOnChange) {
      if (_hostRom?.changing) showToast('Host is changing their ROM');
      else showToast(hasNext ? 'Host selected a different ROM' : 'Host cleared their ROM');
    }
    if (!hasNext) {
      resetTransferForHostRomChange();
      if (socket?.connected) socket.emit('rom-ready', { ready: false });
      updateRomSharingUI();
      return;
    }

    if (hostRomMismatch()) {
      console.warn(
        '[play] host ROM mismatch - clearing our ROM',
        'host:',
        _hostRom?.hash?.substring(0, 16) || _hostRom?.size,
        'ours:',
        _romHash?.substring(0, 16) || _romSize,
      );
      // A ROM the player dropped before the host's was known: say why it goes
      // (as at the drop, when the host's is known), named by its file.
      refuseRom(_romDroppedName);
      return;
    }

    if (localRomLoaded()) {
      notifyRomReady();
    } else {
      resetTransferForHostRomChange();
      // A ROM the player dropped a moment before the host changed to it was
      // refused then, against the host's previous ROM, and is in the
      // library: it comes back, as after a refusal (specs/rom_identity.qnt,
      // guestDroppedFirstTest).
      if (roomHadReported && romIdentity.looksInLibraryForHostsRom(!isSpectator, false, !!_hostRom?.hash)) {
        autoMatchRom(_hostRom.hash);
      }
      updateRomSharingUI();
    }
  };

  const applyHostRomFromData = (data, { toastOnChange = false } = {}) => {
    if (!data || isHost) {
      updateHostRomInfo();
      return false;
    }
    const prev = _hostRom;
    _hostRom = hostRomFromData(data);
    const prevKey = hostRomIdentityKey(prev);
    const nextKey = hostRomIdentityKey(_hostRom);
    // Flush any deferred autoload now that we know what the host has.
    if (_flushPendingRomAutoload) _flushPendingRomAutoload('host-rom-resolved');
    _takeRoomGameId(_hostRom.gameId);
    const hostHash = _hostRom.hash;
    const cachedHash = _safeGet('localStorage', 'kaillera-rom-hash');
    if (!localRomLoaded() && hostHash && cachedHash && romHashMismatch(hostHash, cachedHash)) {
      console.warn(
        '[play] cached ROM mismatch - clearing before autoload',
        'host:',
        hostHash.substring(0, 16),
        'cached:',
        cachedHash.substring(0, 16),
      );
      _safeRemove('localStorage', 'kaillera-rom-hash');
      if (socket?.connected) socket.emit('rom-ready', { ready: false });
    }

    updateHostRomInfo();
    if (prevKey !== nextKey || !!prev?.changing !== _hostRom.changing) {
      handleHostRomChanged(!!prevKey, !!nextKey, toastOnChange, prev !== null);
      return true;
    }
    if (hostRomMismatch()) {
      handleHostRomChanged(false, !!nextKey, false, prev !== null);
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
    mode = normalizeMode(params.get('mode') || 'rollback');
    isSpectator = params.get('spectate') === '1';
    _gameId = _gameIdHintFromUrl();
    KNState.gameId = _gameId;
  };

  // ── Global error handler ───────────────────────────────────────────────

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[play] unhandled rejection:', e.reason);
    KNEvent('unhandled', String(e.reason)?.slice(0, 500), { stack: e.reason?.stack?.slice(0, 500) });
  });

  // Uncaught errors, e.g. a WASM abort (`RuntimeError: unreachable`) thrown
  // from the frame loop. KNEvent adds match_id, and the server keeps a match
  // that reports a crash until someone resolves it.
  // Each distinct error is reported once per page: one thrown every frame
  // would otherwise send an event per frame.
  const _reportedErrors = new Set();
  window.addEventListener('error', (e) => {
    const err = e.error;
    const msg = String(err || e.message)?.slice(0, 500);
    if (_reportedErrors.has(msg) || _reportedErrors.size >= 20) return;
    _reportedErrors.add(msg);
    const type =
      typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError ? 'wasm-fail' : 'unhandled';
    KNEvent(type, msg, { stack: err?.stack?.slice(0, 500), source: e.filename });
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

  // Keepalive (docs/landing-design.md §7.12): a plain HTTP request is
  // unambiguous inbound traffic, so a host that naps when idle stays awake
  // under a live room. Off unless the server sets KEEPALIVE_SECONDS.
  let _keepaliveTimer = null;
  const startKeepalive = () => {
    const seconds = Number(window.KN_CONFIG?.keepaliveSeconds) || 0;
    if (_keepaliveTimer || seconds <= 0) return;
    _keepaliveTimer = setInterval(() => {
      fetch('/health', { cache: 'no-store' }).catch(() => {});
    }, seconds * 1000);
  };

  const connect = () => {
    socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
    window._isSpectator = isSpectator;
    startKeepalive();

    // What the player is told while the socket is down: the timings and the
    // rules are web/src/play/connection-notices.ts; these are the page effects.
    const _reconnectBanner = document.getElementById('reconnecting-banner');
    const _reconnectText = document.getElementById('reconnecting-text');
    const _connectionNotices = window.KNCore.play.connectionNotices.startConnectionNotices({
      showReconnecting: () => {
        if (_reconnectBanner) _reconnectBanner.classList.remove('hidden');
        if (_reconnectText) _reconnectText.textContent = 'Reconnecting to server\u2026';
      },
      showServerDown: () => {
        if (_reconnectBanner) _reconnectBanner.classList.remove('hidden');
        if (_reconnectText)
          _reconnectText.textContent =
            'Server is unreachable \u2014 your game is unaffected. New players cannot join until the server returns.';
      },
      hide: () => {
        if (_reconnectBanner) _reconnectBanner.classList.add('hidden');
      },
      giveUp: () => showError('Unable to reach server'),
      slowFirstConnect: () => showToast('Unable to reach server \u2014 retrying\u2026', 'error'),
    });
    const _connects = window.KNCore?.createConnectTracker() ?? null;
    socket.on('connect', () => {
      // Every (re)connect: Socket.IO v4 emits 'reconnect' on the Manager, not
      // on the socket, so 'connect' is the event that fires here.
      _session?.socketUp();
      _connectionNotices.up();
      // A `connect` after an earlier one is a signaling reconnect; the rule
      // lives in web/src/reconnect.ts.
      const { isReconnect, attempts } = _connects?.connected() ?? { isReconnect: false, attempts: 0 };
      if (isReconnect) {
        console.log('[play] socket reconnected after', attempts, 'attempts, new id:', socket.id);
        KNEvent('reconnect', `Reconnected after ${attempts} attempt(s)`, { attempts });
        KNState.sessionStats.reconnects++;
      }
      onConnect(isReconnect);
    });
    socket.io.on('reconnect_attempt', (attempt) => {
      _connects?.attempt(attempt);
    });
    socket.on('disconnect', (reason) => {
      _session?.send({ type: 'socketDown' });
      console.log('[play] socket disconnected:', reason, 'id was:', socket.id);
      if (reason === 'io client disconnect') return;
      _connectionNotices.down(isGameRunning() ? 'game' : 'lobby');
    });
    socket.on('connect_error', (e) => {
      console.log('[play] connect_error:', e.message);
      // During games: silent — Socket.IO keeps retrying, and the disconnect
      // already started the notices.
      if (!isGameRunning()) _connectionNotices.down('lobby');
    });
    socket.on('users-updated', _boundary.server('users-updated', onUsersUpdated));
    socket.on(
      'upload-token',
      _boundary.server('upload-token', (data) => {
        _uploadToken = data?.token || '';
        KNState.uploadToken = _uploadToken;
        try {
          if (_uploadTokenKey) _safeSet('localStorage', _uploadTokenKey, _uploadToken);
        } catch (_) {}
        fetch(`/ice-servers?token=${encodeURIComponent(_uploadToken)}&room=${encodeURIComponent(roomCode || '')}`)
          .then((r) => r.json())
          .then((s) => {
            window._iceServers = s;
          })
          .catch(() => {});
      }),
    );
    socket.on(
      'reconnect-token',
      _boundary.server('reconnect-token', (data) => {
        _reconnectToken = data?.token || '';
        try {
          _safeSet('sessionStorage', 'kn-reconnect-token', _reconnectToken);
        } catch (_) {}
      }),
    );
    socket.on('game-started', _boundary.server('game-started', onGameStarted));
    socket.on('game-ended', _boundary.server('game-ended', onGameEnded));
    socket.on('room-closed', onRoomClosed);
    socket.on('rom-sharing-updated', _boundary.server('rom-sharing-updated', onRomSharingUpdated));
    socket.on('data-message', _boundary.relay('data-message', onDataMessage));

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

  // The requests a page sends to open or join a room, and what the answers
  // mean, are web/src/play/connect.ts; the decisions are join-plan.ts
  // (proved). onConnect calls them and does what they answer.
  const _connect = window.KNCore.play.connect;
  const _joinPlan = window.KNCore.play.joinPlan;
  const joinerNow = () => ({
    roomCode,
    playerName,
    persistentId: _persistentId,
    reconnectToken: _reconnectToken,
  });

  const sendDeviceType = () => {
    if (socket?.connected) {
      socket.emit('device-type', { type: _isMobile ? 'mobile' : 'desktop' });
      socket.emit('input-type', { type: _currentInputType });
    }
  };

  // This page's socket was down, so it heard none of the room's broadcasts.
  // If the game ended meanwhile, or was replaced by a new match, catch up:
  // the rule is KNCore's reconcileRejoin (web/src/rejoin.ts), modelled as
  // `reconciled` in specs/room_lifecycle.qnt.
  const _reconcileAfterRejoin = (room) => {
    const verdict = _session?.rejoined({ playing: room.status === 'playing', matchId: room.matchId ?? null }) ?? 'keep';
    if (verdict === 'keep') return;
    console.log('[play] rejoin: the room moved on while the socket was down:', verdict);
    KNEvent('rejoin-reconciled', '', { verdict });
    onGameEnded({ matchId: KNState.matchId, leftByMachine: true });
    // The room is playing another match: join it as a fresh page would.
    if (verdict === 'matchReplaced') onConnect(false);
  };

  // The room no longer counts this page as a member (its socket was down for
  // longer than the grace window, or the room is gone), so the game it is
  // showing is over for it. End it and join again as a fresh page would:
  // that lands in the lobby or on the late-join path of the match in play,
  // or shows the player why it cannot get back in.
  // This page loaded as host and was told the room had dropped it: if its
  // fresh open-room finds the room still there, it belongs to someone else
  // now and the page joins it as a guest.
  let _droppedAsHost = false;
  const _leaveDroppedGame = (reason) => {
    console.log('[play] mid-game rejoin refused:', reason);
    KNEvent('rejoin-refused', '', { reason });
    // The session has already moved the machine to the lobby (rejoinRefused).
    onGameEnded({ matchId: KNState.matchId, reason: 'dropped', leftByMachine: true });
    // The match itself may still be on, and this page may be about to join
    // it again: its real game-ended must not be taken for a repeat.
    _lastHandledGameEndMatchId = null;
    _droppedAsHost = isHost;
    onConnect(false);
  };

  const onConnect = async (isReconnect = false) => {
    // Mid-game reconnect: silently rejoin signaling channel, don't reset UI
    if (isGameRunning()) {
      const rejoinEvent = isHost ? 'open-room' : 'join-room';
      // `resume` tells the server this page still has a game running, in
      // which slot and which match. If the room dropped it while its socket
      // was down, the server takes it back into that match and slot, or
      // refuses; it never lets it in as a new player or opens a new room.
      const resume = { slot: _connect.resumeSlot(isSpectator, mySlot), matchId: KNState.matchId || '' };
      const payload = isHost
        ? _connect.openRoomRequest(joinerNow(), _gameId || '', resume)
        : _connect.joinRoomRequest(joinerNow(), isSpectator, resume);
      // The session owns the rejoin: it cancels it if the socket drops again
      // or the game ends, and then this handler is never called.
      const rejoinOptions = {
        send: (answer) => socket.emit(rejoinEvent, payload, answer),
        answerWithinMs: 5000,
        retryAfterMs: 2000,
        attempts: 4,
      };
      _session.startRejoin(rejoinOptions, (outcome) => {
        if (outcome.kind === 'noAnswer') {
          // Every attempt went unanswered on a socket that says it is
          // connected, so this page is not in the room's signaling. Take a
          // new connection: its connect starts a new rejoin. The game keeps
          // running over the players' own connections meanwhile.
          console.log('[play] mid-game rejoin: no answer from the server, reconnecting the socket');
          KNEvent('rejoin-no-answer', '', {});
          if (socket.connected) {
            socket.disconnect();
            socket.connect();
          }
          return;
        }
        if (outcome.kind === 'dropped') {
          _leaveDroppedGame(outcome.reason);
          return;
        }
        console.log('[play] mid-game rejoin succeeded');
        sendDeviceType();
        // The server keeps a returning host's room as it was: a ROM changed
        // while the socket was down is told now.
        _announceGameId();
        // A player taken back after its grace window ran out is on a new
        // socket the server has no ROM report for: without this the next
        // start would wait for a ROM everybody already has.
        tellRomAfterRejoin();
        // Said again in case the first telling was lost with the socket.
        const joinedMatch = _session?.joinedMatch();
        if (joinedMatch) _tellServerMatchJoined(joinedMatch);
        if (isReconnect) resumeRomTransferAfterReconnect();
        // join-room's reconnect path says what the room is doing now. (The
        // host's open-room does not: only the host starts and ends games, so
        // its page cannot fall behind while it is still the owner.) An ack off
        // its schema is dropped: the page then hears the room from users-updated.
        const rejoinedRoom = rejoinEvent === 'join-room' ? _boundary.ack('join-room', outcome.room) : outcome.room;
        if (rejoinedRoom?.status) _reconcileAfterRejoin(rejoinedRoom);
      });
      return;
    }

    if (isHost) {
      socket.emit('open-room', _connect.openRoomRequest(joinerNow(), _gameId || '', null), (err) => {
        // What the answer means is connect.ts: opened, the room is someone
        // else's now (it was handed on after this page was dropped as host),
        // or failed.
        const answer = _connect.openRoomAnswer(err, _droppedAsHost);
        _droppedAsHost = false;
        if (answer.kind === 'join-as-guest') {
          // This page's URL says host, but the room belongs to someone
          // else now: this player was dropped mid-match and the room was
          // handed on (and it may since have been taken back as a player).
          // Come in the way any other player does.
          console.log('[play] open-room: not the owner of a room in play, joining instead');
          isHost = false;
          KNState.isLocalHost = false;
          onConnect(false);
          return;
        }
        if (answer.kind === 'failed') {
          showError(answer.message);
          return;
        }
        mySlot = 0;
        _session?.send({
          type: 'joined',
          status: 'lobby',
          matchId: null,
          spectator: false,
          streaming: mode === 'streaming',
        });
        KNEvent('room_created', '', { mode });
        sendDeviceType();
        {
          socket.emit('data-message', { type: 'mode-select', mode });
          socket.emit('set-mode', { mode });
        }
        // If ROM was already loaded from cache, notify server immediately
        if (isReconnect) tellRomAfterRejoin();
        else notifyRomReady();
        // A host taken back into its own room keeps the room's old game id
        // (the server ignores open-room's then): say the current one.
        if (isReconnect) _announceGameId();
        showOverlay();
      });
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
        _takeRoomGameId(roomData.gameId ?? roomData.game_id);
        applyHostRomFromData(roomData);

        // Room full: auto-join as spectator with banner. A page that already
        // holds a player slot is counted in player_count itself: rejoining a
        // full room (socket reconnect, or catching up with a replaced match)
        // must not turn it into a spectator while the server keeps its slot.
        const holdsPlayerSlot = mySlot !== null && mySlot !== undefined;
        if (_joinPlan.becomesSpectator(isSpectator, holdsPlayerSlot, roomData.player_count, roomData.max_players)) {
          console.log(
            `[play] auto-spectate: player_count=${roomData.player_count} >= max_players=${roomData.max_players}`,
          );
          isSpectator = true;
          _autoSpectated = true;
        }

        // Guests learn the authoritative room mode only after this lookup.
        // Gate rollback players here, while allowing streaming guests (and
        // spectators) through without emulator-only browser features.
        mode = normalizeMode(roomData.mode || mode);
        if (!isSpectator && mode !== 'streaming') {
          const missing = emulatorMissing();
          if (missing.length) {
            KNEvent('compat', `Missing: ${missing.join(', ')}`, { missing });
            showUnsupportedBrowser(missing);
            socket.disconnect();
            return;
          }
        }

        socket.emit('join-room', _connect.joinRoomRequest(joinerNow(), isSpectator, null), (err, joinAck) => {
          if (err) {
            // What each refusal says is connect.ts (the spectator-cap copy
            // is §7.2 M3 #3, whichever cap tripped).
            const refusal = _connect.joinRefusal(err, roomClosedMessage(roomData?.host_name));
            // Room filled between REST check and join — auto-spectate
            if (refusal.kind === 'watch-instead') {
              isSpectator = true;
              _autoSpectated = true;
              socket.emit('join-room', _connect.joinRoomRequest(joinerNow(), true, null), (err2, joinAck2) => {
                if (err2) {
                  showError(`Failed to join: ${err2}`);
                  return;
                }
                const joinData2 = _boundary.ack('join-room', joinAck2);
                mySlot = null;
                if (joinData2) lastUsersData = joinData2;
                sendDeviceType();
                KNEvent('peer_joined', '', { slot: -1, is_spectator: true });
                showRoomFullBanner();
                showOverlay();
              });
              return;
            }
            showError(refusal.message);
            return;
          }

          // The ack's data, decoded; one off its schema is dropped, and the page
          // goes on from the room it looked up and the users-updated that follows.
          const joinData = _boundary.ack('join-room', joinAck);
          _takeRoomGameId(joinData?.gameId ?? joinData?.game_id);
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
            hostHash: (_hostRom?.hash ?? '').substring(0, 12),
          });
          // If ROM was already loaded from cache, notify server immediately.
          // Skip for guests if host's ROM hash is known and doesn't match —
          // onUsersUpdated will handle activation once the host hash is verified.
          if (localRomLoaded() && (isHost || !hostRomMismatch())) {
            if (isReconnect) tellRomAfterRejoin();
            else notifyRomReady();
          } else if (!isHost && !_romSharingEnabled && !roomData.rom_sharing && hostRomMismatch()) {
            // Cached ROM doesn't match host's — clear it now (skip when ROM sharing handles it)
            console.log('[play] join: cached ROM mismatch — clearing');
            clearLoadedRom();
          } else if (isReconnect) {
            tellRomAfterRejoin();
          }
          if (isReconnect) resumeRomTransferAfterReconnect();

          if (roomData.status !== 'playing') {
            _session?.send({
              type: 'joined',
              status: 'lobby',
              matchId: null,
              spectator: !!isSpectator,
              streaming: mode === 'streaming',
            });
          }
          // Mid-game join handling
          if (roomData.status === 'playing') {
            crumb('mid-game-join', {
              spectator: isSpectator,
              mode,
              sharing: !!roomData.rom_sharing,
              hasRom: !!(_romBlob || _romBlobUrl),
              romHash: _romHash?.substring(0, 12),
              hostHash: (_hostRom?.hash ?? '').substring(0, 12),
            });
            console.log(
              `[play] mid-game join: isSpectator=${isSpectator}, mode=${mode}, player_count=${roomData.player_count}, max_players=${roomData.max_players}`,
            );
            // Set matchId for late joiners — game-started event doesn't fire
            // for them, so session logging would silently fail without this.
            // roomData (REST) doesn't include matchId — use joinData (Socket.IO ack).
            if (joinData?.matchId) KNState.matchId = joinData.matchId;
            else if (roomData.matchId) KNState.matchId = roomData.matchId;
            // Pick up the game mode — game-started event won't fire
            // since the game is already running. Try REST then join callback.
            if (roomData.mode) mode = roomData.mode;
            else if (joinData?.mode) mode = joinData.mode;
            // The machine needs the mode, which is only known here.
            _session?.send({
              type: 'joined',
              status: 'playing',
              matchId: joinData?.matchId ?? null,
              spectator: !!isSpectator,
              streaming: mode === 'streaming',
            });
            // A page that runs an emulator is in the game once it advances
            // frames. Streaming guests and spectators have no frame counter:
            // for them the engine start is the whole late join.
            if (!isSpectator && mode !== 'streaming') _sessionWatchLateJoin();
            // Use joinData directly — the users-updated socket event may not
            // have arrived yet (ack returns before broadcast is delivered)
            if (joinData) lastUsersData = joinData;

            // Store host ROM metadata for verification
            applyHostRomFromData(joinData || roomData);

            // How this page gets into the match is join-plan.ts (proved). A
            // ROM still being hashed is none yet: the page waits for a ROM,
            // and the hash landing joins the match or refuses it
            // (rom-identity.ts, specs/rom_identity.qnt).
            const verdict = romVerdictNow();
            const hasRom = romIdentity.romDecided(verdict);
            const lateJoinPlan = _joinPlan.lateJoinPlan(
              !!isSpectator || mode === 'streaming',
              hasRom,
              romIdentity.offersHostsRom(verdict, !!roomData.rom_sharing),
              verdict === 'mismatch',
              _romSharingDecision === 'accepted',
            );

            // Spectators and streaming guests don't need a ROM — they
            // receive a video stream. Skip ROM checks and go to engine init.
            if (lateJoinPlan === 'watch') {
              hideOverlay();
              showToolbar();
              showGameLoading();
              initEngine();
              return;
            }

            // No ROM, or one that isn't the host's, and the host is sharing
            // theirs: show the accept/decline prompt instead of a ROM drop.
            if (lateJoinPlan === 'askForSharedRom') {
              if (!hasRom) crumb('late-join-sharing-prompt', { sharing: true });
              _romSharingEnabled = true;
              _setPendingLateJoin(true);
              showLateJoinRomPrompt();
              updateRomSharingUI();
              return;
            }
            if (lateJoinPlan === 'askForRom') {
              crumb('late-join-rom-prompt', { sharing: false });
              _setPendingLateJoin(true);
              showLateJoinRomPrompt();
              return;
            }
            // The ROM's hash isn't the host's (one that came from the host by
            // sharing is believed), and the host isn't sharing.
            if (lateJoinPlan === 'wrongRom') {
              showError("Your ROM doesn't match the host's game. Drop the correct ROM.");
              return;
            }

            // A page that was in the lobby (it has just caught up with a
            // match that replaced the one it was in) still has the lobby
            // overlay up; a fresh page does not.
            hideOverlay();
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
        });
      } catch (_) {
        showError('Failed to connect');
      }
    }
  };

  // ── Users Updated ──────────────────────────────────────────────────────

  const onUsersUpdated = (data) => {
    lastUsersData = data;
    // The server sends this after game-ended as well. Reconcile its lobby
    // state even if the one-shot end event was missed (specs/game_end.qnt).
    if (data.status === 'lobby') _reconcileAfterRejoin(data);
    if (data.listed !== undefined) {
      const listedCb = document.getElementById('opt-listed');
      if (listedCb) listedCb.checked = !!data.listed;
    }
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
      mode = normalizeMode(data.mode);
      // Sync mode-select dropdown if we're the host
      const modeSel = document.getElementById('mode-select');
      if (modeSel && !isHost) modeSel.value = mode;
      // Re-emit rom-ready when switching to rollback so the host's "Waiting for ROMs"
      // check clears for guests who had already declared ROM in streaming mode.
      // Skip if ROM hash doesn't match the host's (guest has wrong cached ROM).
      if (
        !everyoneRunsTheGame(prevMode) &&
        everyoneRunsTheGame(mode) &&
        localRomLoaded() &&
        (isHost || !hostRomMismatch())
      ) {
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

    // Update my slot. Recomputed fresh every broadcast (not just "if found")
    // so a player who releases their slot (Watch instead) or is otherwise
    // removed from `players` doesn't keep a stale mySlot from before.
    let myPlayerEntry = null;
    for (const entry of Object.values(players)) {
      if (entry.socketId === socket.id) {
        myPlayerEntry = entry;
        break;
      }
    }
    mySlot = myPlayerEntry ? myPlayerEntry.slot : null;
    KNState.slot = mySlot;

    // Detect spectator → player transition (via claim-slot)
    const nowPlayer = mySlot !== null && mySlot !== undefined;
    if (isSpectator && nowPlayer) {
      if (
        mode !== 'streaming' &&
        releaseUnsupportedPlayer("This browser can't run the game — you can keep watching.")
      ) {
        return;
      }
      isSpectator = false;
      window._isSpectator = false;
      if (_romSharingEnabled && _romSharingDecision === null) {
        updateRomSharingUI();
      }
      // Restore the ROM drop / gamepad UI that showOverlay() hid for
      // spectators — claiming a slot needs your ROM (§7.2 M3 #3).
      if (!isGameRunning()) showOverlay();
      if (localRomLoaded() && (isHost || !hostRomMismatch())) notifyRomReady();
      // A player now: with no ROM, the host's comes from the library if it is there.
      if (!isHost && romIdentity.looksInLibraryForHostsRom(true, localRomLoaded(), !!_hostRom?.hash)) {
        autoMatchRom(_hostRom.hash);
      }
    }

    // Detect player → spectator transition ("Watch instead" / release-slot).
    // Symmetric with the claim-slot case above — the room stays put, no
    // reload, no leave-room.
    const nowSpectator = !nowPlayer && Object.values(spectators).some((s) => s.socketId === socket.id);
    const unsupportedReleaseSucceeded = nowSpectator && _unsupportedReleasePending;
    if (nowSpectator) _unsupportedReleasePending = false;
    if (!isSpectator && nowSpectator) {
      isSpectator = true;
      window._isSpectator = true;
      if (!isGameRunning()) {
        if (!unsupportedReleaseSucceeded) showToast("Watching — you'll see the game when it starts");
        showOverlay();
      }
    }

    if (!isHost && !isSpectator && nowPlayer && mode !== 'streaming') {
      releaseUnsupportedPlayer(`The host switched to ${mode}, which this browser can't run — you're now watching.`);
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
    if (!isGameRunning()) {
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
      syncDelayPickerPlacement();
    }
  };

  const diffForToasts = (players, spectators) => {
    for (const toast of rosterToasts(previousPlayers, previousSpectators, players, spectators)) showToast(toast);
  };

  // ── Game Lifecycle ─────────────────────────────────────────────────────

  // What a page does when a game starts, and whether it has a game's end to
  // handle: web/src/play/game-start.ts (proved). The handlers below carry
  // out its answer.
  const _gameStart = window.KNCore.play.gameStart;

  const onGameStarted = (data) => {
    _endGameRequest?.cancel();
    _endGameRequest = null;
    // Keep match events from covering the fatal error modal.
    if (coreFatal) return;
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
      `gameRunning=${isGameRunning()}`,
    );
    mode = data.mode || mode;
    _gameResyncEnabled = data.resyncEnabled !== false;
    _takeRoomGameId(data.gameId);
    applyHostRomFromData(data);
    KNState.matchId = data.matchId || null;
    _gfxRecoveryAttempt = 0;

    _session?.send({ type: 'gameStarted', matchId: String(data?.matchId ?? '') });

    // What this page does now (web/src/play/game-start.ts, `gameStartPlan`).
    // A ROM still being hashed is none yet: booted before its hash said whose
    // it is, a wrong ROM the host's size would run (specs/rom_identity.qnt,
    // bootWhileHashingTest). The page waits for a ROM in the started game, and
    // the hash landing joins it late or refuses the ROM.
    const verdict = romVerdictNow();
    const startPlan = _gameStart.gameStartPlan(
      !!isSpectator || (mode === 'streaming' && !isHost),
      romIdentity.romDecided(verdict),
      verdict === 'mismatch',
      romIdentity.offersHostsRom(verdict, !!_romSharingEnabled),
      _romSharingDecision === 'accepted',
    );

    // Spectators and streaming-mode guests don't run an emulator — they
    // receive a video stream from the host. Skip ROM checks and boot.
    if (startPlan === 'watch') {
      hideOverlay();
      showToolbar();
      showGameLoading();
      initEngine();
      return;
    }

    // No ROM, and none to take from the host: ask for one, and join the game
    // late once it is dropped, as a late joiner does. The server took the
    // start while this page's word that it cleared its ROM was on its way
    // (specs/rom_at_start.qnt); booting would run the emulator with nothing.
    if (startPlan === 'askForRom') {
      crumb('start-rom-prompt', { sharing: false });
      // Say so: this page runs no engine until a ROM is dropped and will not
      // answer the start's connections, and the host starts without it
      // rather than after its retries (specs/start_group.qnt). `prompt`: at the
      // ROM prompt, not merely without a ROM yet (a page that reloaded shows
      // that until its rom-ready arrives). The server may still count it
      // ready (the start took the word while it was on its way).
      if (socket?.connected) socket.emit('rom-ready', { ready: false, prompt: true });
      // As a late joiner's: tells the machine once frames run, so the join is
      // not reported as stranded.
      if (!isSpectator && mode !== 'streaming') _sessionWatchLateJoin();
      _setPendingLateJoin(true);
      showLateJoinRomPrompt();
      return;
    }

    // The ROM is not the host's and the host's cannot be taken.
    if (startPlan === 'wrongRom') {
      showError("Your ROM doesn't match the host's game. Drop the correct ROM to continue.");
      return;
    }

    // The ROM is missing or not the host's, and the host offers theirs: stay
    // in the lobby with the offer up. This also covers the host starting
    // before a guest has answered the offer.
    if (startPlan === 'askForSharedRom') {
      console.log("[play] game started — waiting for the guest to take the host's ROM");
      initEngine();
      updateRomSharingUI();
      return;
    }

    // The player took the host's ROM and it has not all arrived: stay in the
    // lobby while it does (the host may start before the transfer ends).
    if (startPlan === 'awaitSharedRom') {
      initEngine();
      romStep({ kind: 'game-started' });
      updateRomSharingUI();
      if (_preGamePC) {
        console.log('[play] game started — pre-game ROM transfer in progress');
      } else {
        console.log('[play] game started — waiting for ROM transfer');
        waitForDCAndSendRomAccepted();
      }
      return;
    }

    hideOverlay();
    showToolbar();
    showGameLoading();
    // Clear stale status text from previous game
    const toolbarEl = document.getElementById('toolbar-status');
    if (toolbarEl)
      toolbarEl.textContent = _unverifiedMatchId && _unverifiedMatchId === KNState.matchId ? RECOVERY_UNVERIFIED : '';
    const loadingText = document.getElementById('game-loading-text');
    if (loadingText) loadingText.textContent = 'Loading...';
    initEngine();
  };

  const onGameEnded = (data = {}) => {
    if (_unverifiedMatchId && _unverifiedMatchId === KNState.matchId && data?.matchId !== _unverifiedMatchId) return;
    const endedMatchId = data?.matchId || KNState.matchId || null;
    if (!_gameStart.endMatchesCurrent(endedMatchId ?? '', KNState.matchId ?? '')) return;
    // Whether this page has the end to handle (web/src/play/game-start.ts,
    // `handlesGameEnd`): not the same match's end twice, and nothing to end
    // if no game is on for this page. A caller that has already moved the
    // machine to the lobby (a reconnect that found the game over) says so,
    // because the machine can no longer answer whether there is a game to
    // clean up.
    const handled = _gameStart.handlesGameEnd(
      endedMatchId ? String(endedMatchId) : '',
      _lastHandledGameEndMatchId ? String(_lastHandledGameEndMatchId) : '',
      !!data?.leftByMachine,
      isGameRunning() || !!engine || _isLateJoin() || _isPendingLateJoin(),
    );
    if (!handled) return;
    if (endedMatchId) _lastHandledGameEndMatchId = endedMatchId;
    if (_unverifiedMatchId === endedMatchId) _unverifiedMatchId = null;
    _endGameRequest?.cancel();
    _endGameRequest = null;
    console.log(
      '[play] onGameEnded:',
      `engine=${!!engine}`,
      `EJS=${!!window.EJS_emulator}`,
      `romBlob=${!!_romBlob}`,
      `romBlobUrl=${!!_romBlobUrl}`,
      `matchId=${endedMatchId || 'none'}`,
    );
    _sessionStopLateJoinPoll();
    _session?.send({ type: 'gameEnded' });
    showToast(_gameStart.gameEndedMessage(data?.reason));
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
    _clearLateJoinRomPrompt();
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
    _endGameRequest?.cancel();
    _endGameRequest = null;
    _sessionStopLateJoinPoll();
    _session?.send({ type: 'roomClosed' });
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
      // Stop the transfer and cancel any retry on its way, also one a close of
      // the host's channel, seen before this message, already scheduled.
      if (romStep({ kind: 'sharing-off' }) === 'stop') {
        if (_romTransferDC) {
          try {
            _romTransferDC.close();
          } catch (_) {}
          _romTransferDC = null;
        }
        stopStallTimer();
        clearTimeout(_romTransferResumeTimer);
        _romTransferResumeTimer = null;
      }
      cleanupPreGameConnections();
    }

    // Host re-enabled sharing — resume if we have cached progress
    if (!isHost && _romSharingEnabled && !wasEnabled && _romSharingDecision === 'accepted' && !_romBlob) {
      // Resume what was paused part-way, or start a transfer that never began.
      if (romStep({ kind: 'sharing-on' }) === 'ask') {
        console.log('[play] ROM sharing re-enabled — asking from offset', _romReceiver.received);
        // In the lobby the host answers over a fresh pre-game connection,
        // whose signals the sharing-off above stopped listening for.
        if (!isGameRunning()) registerRomSignalHandler();
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
    // Any room member can write to the server's relay, so who sent a message
    // is the server's stamp (KNCore.checkRelayed, web/src/relay.ts), not
    // what the message says: `mode-select` is taken only from the room's
    // owner, and `rom-accepted` starts a transfer to the socket that really
    // sent it. A message with no stamp, or one this page cannot check (the
    // bundle did not load), is refused.
    const from = window.KNCore?.checkRelayed?.(data) ?? null;
    if (!from?.allowed) return;
    data = { ...data, sender: from.sid };
    // Host broadcasts mode selection to guests pre-game
    if (data.type === 'mode-select' && !isHost && data.mode) {
      mode = normalizeMode(data.mode);
      const modeSel = document.getElementById('mode-select');
      if (modeSel) modeSel.value = mode;
      updateRomSharingUI();
      if (lastUsersData) updateStartButton(lastUsersData.players || {});
      if (mode !== 'streaming' && !isHost && !isSpectator) {
        releaseUnsupportedPlayer(`The host switched to ${mode}, which this browser can't run — you're now watching.`);
      }
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

    // Streaming guests don't load a ROM — host streams video. Hide the drop
    // zone and any sharing UI; they just wait for the host to start.
    if (mode === 'streaming') {
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = true;
      if (retryBtn) retryBtn.hidden = true;
      return;
    }

    console.log(
      `[play] updateRomSharingUI: enabled=${_romSharingEnabled}` +
        ` decision=${_romSharingDecision} state=${_romReceiver.phase}` +
        ` hasRom=${!!_romBlob}`,
    );

    // Hide retry button by default — only shown in paused state
    if (retryBtn) retryBtn.hidden = true;

    if (_romSharingEnabled && _romSharingDecision === null && !_romBlob) {
      // Show ROM drop zone with compact "accept from host" option below
      if (romDrop) romDrop.style.display = '';
      if (prompt) prompt.hidden = false;
      if (progress) progress.hidden = true;
    } else if (_romReceiver.phase === 'receiving') {
      // Transfer in progress — show progress bar
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = false;
    } else if (_romReceiver.phase === 'paused') {
      // Paused — show progress bar with retry button
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = false;
      if (retryBtn) retryBtn.hidden = false;
      const text = document.getElementById('rom-progress-text');
      if (text) text.textContent = _romRules.pausedText(_romReceiver, _romSharingEnabled);
    } else if (_romReceiver.phase === 'resuming') {
      // Resuming — show progress bar with reconnecting text
      if (romDrop) romDrop.style.display = 'none';
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = false;
      const text = document.getElementById('rom-progress-text');
      if (text) text.textContent = 'ROM transfer reconnecting...';
    } else if (_romReceiver.phase === 'complete' || (_romSharingDecision === 'accepted' && _romBlob)) {
      // Transfer complete
      if (romDrop) {
        romDrop.style.display = '';
        romDrop.classList.add('loaded');
      }
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = true;
    } else {
      // Default: show normal drop zone
      if (romDrop) romDrop.style.display = '';
      if (prompt) prompt.hidden = true;
      if (progress) progress.hidden = true;
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
    romStep({ kind: 'accept' });
    updateRomSharingUI();

    // Pre-game: initiate early ROM transfer via standalone WebRTC connection
    if (!isGameRunning()) {
      console.log('[play] ROM sharing accepted pre-game — requesting early transfer');
      registerRomSignalHandler();
      requestResumeTransfer();
      return;
    }

    // Mid-game join: start engine in connect-only mode to get WebRTC
    if (!engine && isGameRunning()) {
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
          armResumeDeadline();
          return;
        }
      }
    }
    // Fallback: ask over Socket.IO, with the same deadline as every other request.
    requestResumeTransfer();
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
        armResumeDeadline();
      }
    }, 200);
    setTimeout(() => {
      if (_romAcceptPollInterval) {
        clearInterval(_romAcceptPollInterval);
        _romAcceptPollInterval = null;
        // DC didn't open in time — fall back to Socket.IO with retry logic
        if (_romReceiver.phase === 'resuming' && !_romBlob) {
          console.log('[play] waitForDCAndSendRomAccepted timed out — falling back to Socket.IO');
          requestResumeTransfer();
        }
      }
    }, 15000);
  };

  const cancelRomTransfer = () => {
    romStep({ kind: 'reset' });
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
    cleanupPreGameConnections();
    updateRomSharingUI();
    setRomTransferState('idle');
  };

  const retryRomTransfer = () => {
    if (romStep({ kind: 'retry' }) !== 'ask') return;
    updateRomSharingUI();
    setRomTransferState('retrying', 'Retrying ROM transfer…');
    requestResumeTransfer();
  };

  const resetRomTransfer = () => {
    // Game-end cleanup — same as cancel but no toast, also closes sender DCs
    romStep({ kind: 'reset' });
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
  };

  // ── Pre-game ROM Preloading ─────────────────────────────────────────

  const registerRomSignalHandler = () => {
    if (_romSignalHandler) return;
    // A relayed signal that is not one a peer may send is dropped.
    _romSignalHandler = _boundary.relay('rom-signal', async (data) => {
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
    });
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

    answerRomResumeOn(dc, peerSid, 'pre-game ');
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

  // The sender waits for the receiver's rom-resume, which names the offset to
  // send from. KNCore.createRomResumeAnswerer keeps a request that arrives
  // before this side's channel reports open and answers it on open
  // (web/src/rom-resume.ts).
  const answerRomResumeOn = (dc, peerSid, label) => {
    const answer = window.KNCore.createRomResumeAnswerer((offset) => {
      console.log(`[play] ${label}ROM resume requested from offset`, offset);
      sendRomOverChannel(dc, peerSid, offset);
    });
    dc.onopen = () => {
      console.log(`[play] ${label}rom-transfer DC open to`, peerSid);
      answer.channelOpened();
    };
    dc.onmessage = (e) => {
      // A string that is not a message this channel carries is dropped.
      if (typeof e.data === 'string' && !_boundary.peerText('rom-transfer', e.data)) return;
      answer.received(e.data, dc.readyState === 'open');
    };
  };

  const startRomTransferTo = (peerSid) => {
    // A server with ROM sharing off never sends a ROM, on any connection.
    if (!_ROM_SHARING_FEATURE || !_romBlob || !isHost) return;
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

    answerRomResumeOn(dc, peerSid, '');
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
    if (!_ROM_SHARING_FEATURE || _romSharingDecision !== 'accepted') {
      channel.close();
      return;
    }

    console.log('[play] received rom-transfer DataChannel from', remoteSid);
    // Only one channel may fill the chunk buffer. A repeated request (e.g. a
    // retry after a signaling reconnect that crossed with the original) makes
    // the host open a second one; the newest wins and restarts from the
    // offset reported below.
    if (_romTransferDC && _romTransferDC !== channel) {
      console.log('[play] replacing earlier rom-transfer DataChannel');
      const stale = _romTransferDC;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      try {
        stale.close();
      } catch (_) {}
    }
    _romTransferDC = channel;
    channel.binaryType = 'arraybuffer';

    // A channel that arrives while waiting to resume keeps what it has; any
    // other starts the file again.
    const resumed = _romReceiver.phase === 'resuming' || _romReceiver.phase === 'paused';
    romStep({ kind: 'channel' });
    if (resumed) {
      clearTimeout(_romTransferResumeTimer);
      _romTransferResumeTimer = null;
      console.log('[play] resuming ROM transfer from offset', _romReceiver.received);
    } else {
      _romTransferChunks = [];
    }

    // Always tell the host where to start sending from.
    // offset 0 = fresh (host sends header + all chunks)
    // offset N = resume (host sends chunks from N, no header)
    const resumeOffset = _romReceiver.received;
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
        // A string that is not a message this channel carries is dropped.
        if (!_boundary.peerText('rom-transfer', e.data)) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'rom-header') {
            const counted = _romReceiver.received;
            const next = romStep({ kind: 'header', size: msg.size, hash: msg.hash, name: msg.name });
            if (next === 'abandoned') {
              setRomTransferState('failed', 'ROM too large — loading manually');
              channel.close();
              cancelRomTransfer();
              return;
            }
            // The host is now sending a different file: what arrived is dropped.
            if (counted > 0 && _romReceiver.received === 0) {
              console.log('[play] ROM changed — clearing cached chunks');
              _romTransferChunks = [];
            }
            if (_romReceiver.received === 0) {
              updateRomProgress(0, msg.size);
            }
          } else if (msg.type === 'rom-complete') {
            stopStallTimer();
            finishRomTransfer(romStep({ kind: 'complete' }));
          }
        } catch (_) {}
      } else if (e.data instanceof ArrayBuffer) {
        const step = romStepWhole({ kind: 'chunk', bytes: e.data.byteLength });
        if (step.next === 'abandoned') {
          setRomTransferState(
            'failed',
            step.reason === 'tooLarge' ? 'ROM transfer too large — aborting' : 'ROM transfer size mismatch — aborting',
          );
          channel.close();
          cancelRomTransfer();
          return;
        }
        _romTransferChunks.push(new Uint8Array(e.data));
        _romTransferLastChunkAt = Date.now();
        resetStallTimer();
        if (_romReceiver.header) {
          updateRomProgress(_romReceiver.received, _romReceiver.header.size);
        }
      }
    };

    channel.onclose = () => {
      if (_romReceiver.phase !== 'receiving') return;
      _romTransferDC = null;
      stopStallTimer();
      // Retried by itself after a pause, whether or not any of the file
      // arrived; after three, the guest decides (rom-transfer-step.ts).
      const next = romStep({ kind: 'closed' });
      console.log('[play] ROM transfer DC closed, retry', _romReceiver.retries, '/ 3');
      if (next === 'ask-after-pause') {
        setRomTransferState('retrying', `ROM transfer interrupted — retry ${_romReceiver.retries}/3`);
        _romTransferResumeTimer = setTimeout(romBackoffElapsed, 2000);
      } else if (next === 'stalled') {
        setRomTransferState('stalled', 'ROM transfer stalled — cancel or wait for host');
      }
      updateRomSharingUI();
    };

    updateRomSharingUI();
  };

  // The pause before an automatic retry ended: ask again, if still paused.
  const romBackoffElapsed = () => {
    if (romStep({ kind: 'backoff-elapsed' }) !== 'ask') return;
    updateRomSharingUI();
    requestResumeTransfer();
  };

  const requestResumeTransfer = () => {
    // Re-request transfer from host via Socket.IO
    socket.emit('data-message', { type: 'rom-accepted', sender: socket.id });
    armResumeDeadline();
  };

  // The host has been asked for a channel. If none arrives in 15 s, fall
  // back to paused and try again, however the request was sent: one sent
  // over the engine channel used to start nothing, and a host that never
  // answered left the guest on "reconnecting..." (specs/rom_transfer.qnt).
  const armResumeDeadline = () => {
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = setTimeout(() => {
      // Nothing to do unless still waiting for the channel.
      const next = romStep({ kind: 'resume-timed-out' });
      if (next === 'none') return;
      console.log('[play] ROM resume timed out, retry', _romReceiver.retries);
      if (next === 'ask-after-pause') {
        setRomTransferState('retrying', 'ROM transfer resume timed out — will retry');
        _romTransferResumeTimer = setTimeout(romBackoffElapsed, 2000);
      } else {
        setRomTransferState('stalled', 'ROM transfer stalled — cancel or wait for host');
      }
      updateRomSharingUI();
    }, 15000);
  };

  // Ask the host for the ROM again after rejoining (new socket id), from where
  // we stopped. When to do so is decided in web/src/reconnect.ts.
  const resumeRomTransferAfterReconnect = () => {
    const resume = window.KNCore?.shouldResumeRomTransfer({
      isHost,
      sharingDecision: _romSharingDecision,
      hasRom: !!_romBlob,
      transferState: _romReceiver.phase,
      askingOverEngine: !!_romAcceptPollInterval,
    });
    if (!resume) return;
    console.log('[play] resuming ROM transfer after reconnect');
    cleanupPreGameConnections();
    registerRomSignalHandler();
    romStep({ kind: 'reconnected' });
    clearTimeout(_romTransferResumeTimer);
    _romTransferResumeTimer = null;
    requestResumeTransfer();
    updateRomSharingUI();
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
    if (_romReceiver.phase !== 'receiving') return;
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
    const progress = _romRules.romProgress(received, total);
    if (bar) bar.style.width = `${progress.percent}%`;
    if (text) text.textContent = progress.text;
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
      wrap.hidden = true;
      wrap.style.borderColor = '';
      return;
    }

    wrap.hidden = false;
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
    if (retryBtn) retryBtn.hidden = !(state === 'failed' || state === 'stalled');
    // Cancel button always visible while a transfer state exists
    if (cancelBtn) cancelBtn.hidden = false;
  };

  // The host said the file is complete; `next` is what the receiver made of it.
  const finishRomTransfer = (next) => {
    if (next === 'abandoned') {
      // Short or long of what the host announced: not the file. The receiver
      // has dropped its count and header; the bytes go too, so a later request
      // starts the file again (specs/rom_transfer.qnt, `countIsHeld`).
      setRomTransferState('failed', 'ROM transfer size mismatch — load manually');
      _romTransferChunks = [];
      updateRomSharingUI();
      return;
    }

    const blob = new Blob(_romTransferChunks);
    const displayName = _romReceiver.header?.name ?? 'rom.z64';
    const expectedHash = _romReceiver.header?.hash ?? null;

    const load = ++_romLoad;
    _romBlob = blob;
    _romName = displayName;
    _romDroppedName = null;
    _romSize = blob.size;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(blob);
    window.EJS_gameUrl = _romBlobUrl;
    // Cache received ROM so guests auto-load on future joins without re-downloading
    _safeSet('localStorage', 'kaillera-rom-name', displayName);
    cacheRom(blob, { name: displayName, source: 'p2p' });

    _romTransferChunks = [];
    _romTransferDC = null;

    // Use the host's hash directly — the bytes are verified identical (size check
    // passed) and recomputing locally can produce a different hash if the host
    // uses SHA-256 (HTTPS/localhost) while the guest uses FNV-1a (HTTP LAN IP).
    if (expectedHash) {
      takeRomHash(load, expectedHash);
      afterRomTransferComplete(displayName);
    } else {
      const reader = new FileReader();
      reader.onload = async () => {
        let hash = null;
        try {
          hash = await hashArrayBuffer(reader.result);
        } catch (_) {}
        // Another ROM was loaded or cleared meanwhile: this hash is not the
        // loaded ROM's (specs/rom_identity.qnt), but the transfer still ends.
        if (!romIdentity.hashIsTheLoadedRoms(load, _romLoad)) {
          endRomTransfer();
          return;
        }
        takeRomHash(load, hash);
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
    if (statusEl) _setRomStatus(`Loaded: ${displayName} (from host)`);

    updateRomSharingUI();

    // If game is running and we were waiting for the ROM (connect-only mode),
    // hide overlay, show toolbar, and boot the emulator
    if (isGameRunning() && !window.EJS_emulator && (isHost || !everyoneRunsTheGame(mode))) {
      hideOverlay();
      showToolbar();
      bootEmulator();
    }
    // If we were in a pending late-join, dismiss the prompt
    if (_isPendingLateJoin()) {
      crumb('rom-transfer-complete-late-join');
      dismissLateJoinPrompt();
    }

    // Success — clear the persistent transfer status. The rom-status (above
    // the progress UI) already shows "Loaded: <name>" so the user knows.
    endRomTransfer();
  };

  // The transfer is over: its status goes, and so do the pre-game WebRTC
  // connections it used. Also when the player loaded another ROM before the
  // transferred one was hashed.
  const endRomTransfer = () => {
    setRomTransferState('idle');
    cleanupPreGameConnections();
    updateRomSharingUI();
  };

  // The server keeps the lobby host for a few seconds after a disconnect,
  // and any player mid-game, and carries their readiness over to the new
  // socket; a ROM cleared while the socket was down was never told. A page
  // that comes back without one says so (specs/rom_at_start.qnt,
  // clearedWhileDownTest).
  // A ROM still being hashed is said as none too: its own hash says ready when
  // it lands, and a drop made while the socket was down told the server
  // nothing (specs/rom_identity.qnt, rejoinWhileHashingTest). The host's
  // says it is pending, so the room names none meanwhile.
  const tellRomAfterRejoin = () => {
    if (romIdentity.announcesRom(localRomLoaded(), romHashIsLoaded(), hostRomChanging())) notifyRomReady();
    else if (socket?.connected) {
      const pending = localRomLoaded() && !romHashIsLoaded();
      socket.emit('rom-ready', pending ? { ready: false, pending: true } : { ready: false });
    }
  };

  const notifyRomReady = () => {
    // Only with a ROM, and with that ROM's own hash: a drop being hashed is
    // announced by its own hash when it lands. Not a guest's while the host's
    // ROM is changing: the host's new hash decides (specs/rom_identity.qnt).
    if (!romIdentity.announcesRom(localRomLoaded(), romHashIsLoaded(), hostRomChanging())) return;
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
    _emulatorBootInFlight = false;
    window.KNEmulatorResumeContext = null;
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

  const discardHibernatedEmulatorForRomChange = (nextHash) => {
    if (!_hibernated) return;
    if (nextHash && _hibernatedRomHash === nextHash) return;
    console.log(
      '[play] ROM changed while emulator hibernated, destroying old core',
      `${_hibernatedRomHash?.substring(0, 16) || 'unknown'} -> ${nextHash?.substring(0, 16) || 'none'}`,
    );
    destroyEmulator();
    _hibernated = false;
    _hibernatedRomHash = null;
  };

  const markSameRomEmulatorResume = (reason) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    window.KNEmulatorResumeContext = {
      reused: true,
      sameRom: true,
      mode,
      matchId: window.KNState?.matchId || null,
      romHash: _romHash || null,
      coreFrame: mod?._get_current_frame_count?.() ?? null,
      reason,
      at: Date.now(),
    };
  };

  const hibernateEmulator = () => {
    const emu = window.EJS_emulator;
    if (!emu) return;
    console.log('[play] hibernateEmulator: pausing + hiding');

    const mod = emu.gameManager?.Module;
    if (mod) {
      // Establish a known paused state. stopSync() restores native rAF but
      // never resumes the Emscripten main loop — it's left in limbo (not
      // paused, not running). Calling pauseMainLoop() here gives the next
      // engine start a known state to resume from.
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
      emu.paused = false;
      try {
        mod._platform_emscripten_update_window_hidden_cb?.(0);
      } catch (_) {}
      try {
        mod._toggleMainLoop?.(1);
      } catch (_) {}
      try {
        mod._cmd_unpause?.();
      } catch (_) {}

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

  const resumeStreamingMainLoop = (reason) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.resumeMainLoop) return;

    // A same-ROM switch out of lockstep leaves Emscripten paused while the
    // rAF sandbox is being restored. Pause once more after restore, then
    // resume on native rAF so stale captured runners cannot overlap with the
    // streaming loop.
    try {
      mod.pauseMainLoop?.();
    } catch (err) {
      console.warn('[play] streaming main loop pause before resume failed:', err?.message || err);
    }

    const resume = () => {
      if (window.EJS_emulator?.gameManager?.Module !== mod) return;
      try {
        mod.resumeMainLoop();
        console.log(`[play] streaming main loop resumed (${reason})`);
      } catch (err) {
        console.warn('[play] streaming main loop resume failed:', err?.message || err);
      }
    };

    const nativeRAF = window.APISandbox?.nativeRAF;
    if (typeof nativeRAF === 'function') nativeRAF(resume);
    else if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(resume);
    else setTimeout(resume, 0);
  };

  const bootEmulator = ({ forceStartOnLoad = false } = {}) => {
    if (window.__test_skipBoot) return;
    // Re-initialize EmulatorJS if it was destroyed
    if (window.EJS_emulator) {
      console.log('[play] bootEmulator: EJS already exists, skipping');
      return;
    }
    if (_emulatorBootInFlight) {
      console.log('[play] bootEmulator: boot already in flight');
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
    // Guests normally wait for the lockstep gesture prompt. When boot is
    // launched from that prompt, force EJS auto-start so the first EJS start
    // path is the same on initial boot and after a ROM swap.
    window.EJS_startOnLoaded = !!(isHost || forceStartOnLoad);
    if (!isHost && !forceStartOnLoad) {
      console.log('[play] bootEmulator: guest — waiting for gesture-gated start');
    } else if (!isHost) {
      console.log('[play] bootEmulator: guest — starting from gesture');
    }

    console.log('[play] bootEmulator: gameUrl:', _romBlobUrl.substring(0, 50));
    window.EJS_gameUrl = _romBlobUrl;
    window.EJS_gameID = _romHash || window.KNState?.romHash || 'kaillera-next';
    window.KNEmulatorResumeContext = null;
    KNShared.resetBootState?.();

    // Wait for IDB cache clear (core-redirector) before loading EJS.
    // If the clear hasn't finished, EJS might use stale cached core data.
    const injectLoader = () => {
      _emulatorBootInFlight = true;
      let bootDoneTimer = null;
      const markBootDone = () => {
        _emulatorBootInFlight = false;
        if (bootDoneTimer) {
          clearTimeout(bootDoneTimer);
          bootDoneTimer = null;
        }
        window.removeEventListener('kn-ejs-loader-complete', markBootDone);
      };
      window.addEventListener('kn-ejs-loader-complete', markBootDone);
      bootDoneTimer = setTimeout(markBootDone, 30000);
      const script = document.createElement('script');
      script.src = '/static/ejs-loader.js';
      script.onload = () => {
        console.log('[play] loader.js loaded');
      };
      script.onerror = () => {
        console.log('[play] loader.js FAILED to load');
        markBootDone();
        // BF5: surface EJS loader failure to the user
        window.knShowError?.('Failed to load emulator \u2014 please refresh the page.');
        KNEvent?.('wasm-fail', 'ejs-loader script error');
      };
      document.body.appendChild(script);
    };
    const coreReady = window._knPrepareN64Core?.(mode) ?? window._knCoreReady;
    if (coreReady) {
      // BF5: race core readiness against a 15s timeout so boot doesn't hang
      // forever if /api/core-info fetch never resolves.
      const coreTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Core load timeout (15s)')), 15000),
      );
      Promise.race([coreReady, coreTimeout]).then(injectLoader, (err) => {
        console.warn(`[play] core-ready: ${err.message} — proceeding without cache clear`);
        injectLoader();
      });
    } else {
      injectLoader();
    }
  };

  const ensureEmulatorBooted = ({ forceStartOnLoad = false } = {}) => {
    if (_hibernated && _hibernatedRomHash === _romHash) {
      markSameRomEmulatorResume('same-rom-wake');
      wakeEmulator();
      if (mode === 'streaming') resumeStreamingMainLoop('same-rom-wake');
      return;
    }
    if (_hibernated) {
      // ROM changed — the old WASM instance cannot be reused safely.
      console.log('[play] ensureEmulatorBooted: ROM changed, full restart');
      destroyEmulator();
      _hibernated = false;
      _hibernatedRomHash = null;
    }
    bootEmulator({ forceStartOnLoad });
  };

  window.KNStartEmulatorBoot = ensureEmulatorBooted;

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

    // Auto-load the most recently used ROM from library.
    //
    // Guest race fix: if we don't yet know the host's ROM hash (the join-room
    // ack hasn't returned), don't blindly autoload from localStorage — the
    // cached hash may belong to a different game and we'd briefly load it,
    // emit rom-ready with the wrong hash, and trigger "ROM does not match
    // host". Defer the autoload until applyHostRomFromData runs, then evaluate
    // the cached hash against the host's hash.
    const lastHash = _safeGet('localStorage', 'kaillera-rom-hash');
    // Expose to applyHostRomFromData so it can flush the deferred autoload
    // once host identity arrives. Set before the deferral below returns.
    _flushPendingRomAutoload = (trigger) => {
      if (_pendingRomAutoload) runRomAutoload(trigger);
    };
    if (lastHash) {
      if (!isHost && !_hostRom) {
        _pendingRomAutoload = { lastHash, savedRom, drop, statusEl };
        if (statusEl && savedRom) statusEl.textContent = `Waiting for host ROM info before loading ${savedRom}…`;
        // Failsafe: if no host info ever arrives, fall back to autoload after
        // 8s so we don't strand the user on a "waiting" message indefinitely
        // (REST timeout, room not found, network issue).
        _pendingRomAutoloadTimer = setTimeout(() => {
          if (_pendingRomAutoload) {
            console.log('[play] host ROM identity timeout — running deferred autoload anyway');
            runRomAutoload('timeout-fallback');
          }
        }, 8000);
        return;
      }
      runRomAutoload('immediate');
    } else {
      if (!isSpectator) renderRomLibrary();
    }

    function runRomAutoload(trigger) {
      if (!_pendingRomAutoload && !lastHash) return;
      const ctx = _pendingRomAutoload || { lastHash, savedRom, drop, statusEl };
      _pendingRomAutoload = null;
      if (_pendingRomAutoloadTimer) {
        clearTimeout(_pendingRomAutoloadTimer);
        _pendingRomAutoloadTimer = null;
      }
      const hostHash = _hostRom?.hash ?? null;
      if (!isHost && hostHash && romHashMismatch(hostHash, ctx.lastHash)) {
        console.warn(
          '[play] cached ROM mismatch - skipping autoload',
          'host:',
          hostHash.substring(0, 16),
          'cached:',
          ctx.lastHash.substring(0, 16),
          'trigger:',
          trigger,
        );
        // Try to load the host's hash from IDB (autoMatchRom) instead. Don't
        // emit rom-ready:false yet — we may still find a matching ROM.
        if (ctx.statusEl) ctx.statusEl.textContent = `Cached ROM doesn't match host — looking for match…`;
        autoMatchRom(hostHash);
        return;
      }
      crumb('rom-autoload-start', { hash: ctx.lastHash.substring(0, 12), trigger });
      loadRomFromLibrary(ctx.lastHash, (ok, name) => {
        crumb('rom-autoload-done', {
          ok,
          name,
          trigger,
          pendingLateJoin: _isPendingLateJoin(),
          hostHash: hostHash?.substring(0, 12),
          match: !hostHash || !romHashMismatch(hostHash, ctx.lastHash),
        });
        if (ok) {
          ctx.drop.classList.add('loaded');
          if (ctx.statusEl) _setRomStatus(`Loaded: ${name} (drop to change)`);
          if (_isPendingLateJoin()) dismissLateJoinPrompt();
        } else if (ctx.savedRom && ctx.statusEl) {
          ctx.statusEl.textContent = `Last used: ${ctx.savedRom} (file not cached — drop again)`;
        }
        if (!isSpectator) renderRomLibrary();
      });
    }
  };

  // Set by setupRomDrop; called from applyHostRomFromData when the host's ROM
  // identity is first known. No-op if no autoload is pending.
  let _flushPendingRomAutoload = null;

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
    hideRomMismatch();
    const load = ++_romLoad;
    // Until this file is hashed the server still holds the previous ROM's
    // word: a start in that moment would count a guest ready with that ROM,
    // and every guest would judge theirs against the host's previous one. So
    // the page says at once that its ROM is being hashed: a guest is not
    // ready, and the host's room names no ROM. Its own hash says ready when
    // it lands (specs/rom_identity.qnt, DROP_SAYS_NOT_READY and
    // HOST_DROP_SAYS_CHANGING).
    if (socket?.connected) socket.emit('rom-ready', { ready: false, pending: true });
    _romBlob = file;
    _romName = displayName;
    _romDroppedName = displayName;
    _romSize = file.size;
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    _romBlobUrl = URL.createObjectURL(file);
    window.EJS_gameUrl = _romBlobUrl;
    _safeSet('localStorage', 'kaillera-rom-name', displayName);
    cacheRom(file, { name: displayName, source: 'local' });

    const drop = document.getElementById('rom-drop');
    if (drop) drop.classList.add('loaded');
    const statusEl = document.getElementById('rom-status');
    _romStatusText = `Loaded: ${displayName}`;
    if (statusEl) {
      // _romHash still belongs to the previous ROM here; re-rendered once hashed
      statusEl.textContent = _romStatusText;
      statusEl.classList.remove('rom-unsupported');
    }

    // Enable ROM sharing checkbox if host
    const romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb && isHost) romShareCb.disabled = false;
    // The host's Start waits for this ROM's hash.
    if (isHost && lastUsersData?.players) updateStartButton(lastUsersData.players);

    // Compute ROM hash and proceed with any pending late-join. The hash has
    // a 15-second timeout and an onerror handler; a ROM that cannot be read
    // or hashed is refused, not left loaded with no hash (specs/rom_identity.qnt,
    // hashFailsTest). A hash for a load the page no longer holds (the player
    // dropped, picked or cleared another ROM meanwhile) changes nothing.
    const stillLoaded = () => romIdentity.hashIsTheLoadedRoms(load, _romLoad);
    const reader = new FileReader();
    let _hashTimedOut = false;
    const _hashTimer = setTimeout(() => {
      _hashTimedOut = true;
      try {
        reader.abort();
      } catch (_) {}
      console.log('[play] ROM hash timed out after 15s');
      KNEvent('compat', 'ROM hash computation timed out', { size: file.size });
      if (stillLoaded()) refuseUnreadableRom("Couldn't read the ROM in time — try dropping it again");
    }, 15000);
    reader.onerror = () => {
      clearTimeout(_hashTimer);
      if (_hashTimedOut) return;
      console.log('[play] FileReader error:', reader.error);
      KNEvent('compat', 'ROM FileReader failed', { error: String(reader.error) });
      if (stillLoaded()) refuseUnreadableRom('Could not read ROM file — try dropping it again');
    };
    reader.onload = async () => {
      clearTimeout(_hashTimer);
      if (_hashTimedOut) return;
      let hash = null;
      try {
        hash = await hashArrayBuffer(reader.result);
      } catch (err) {
        console.log('[play] hash failed:', err);
        KNEvent('compat', 'ROM hash compute failed', { error: String(err) });
      }
      if (!stillLoaded()) return;
      if (!hash) {
        refuseUnreadableRom('ROM hash failed — try dropping it again');
        return;
      }
      takeRomHash(load, hash);
      try {
        _safeSet('localStorage', 'kaillera-rom-hash', hash);
        console.log(`[play] ROM hash: ${hash.substring(0, 16)}\u2026 game_id: ${_gameId}`);
        _announceGameId();
        _renderRomStatus();
      } catch (err) {
        console.log('[play] showing the ROM hash failed:', err);
      }
      if (isHost && lastUsersData?.players) updateStartButton(lastUsersData.players);
      // Guest ROM mismatch check: this ROM is not the host's (the verdict
      // says so only once the host's hash or size is known), so it is
      // refused and the player asked for another.
      if (!isHost && hostRomMismatch()) {
        console.log(
          '[play] ROM mismatch — guest hash:',
          hash.substring(0, 16),
          'host hash:',
          _hostRom?.hash?.substring(0, 16),
        );
        refuseRom(_knownRoms[hash]?.game || displayName);
        return;
      }
      hideRomMismatch();
      notifyRomReady();
      // A guest who loads their own ROM has declined the host's: the offer goes.
      updateRomSharingUI();
      // Always proceed with late-join, even if hash computation failed
      if (_isPendingLateJoin()) {
        dismissLateJoinPrompt();
      }
    };
    reader.readAsArrayBuffer(file);
  };

  // ── ZIP extraction ────────────────────────────────────────────────────

  const extractRomFromZip = async (arrayBuffer) =>
    window.KNCore.play.romFromArchive(fflate.unzipSync(new Uint8Array(arrayBuffer)));

  const hashArrayBuffer = (buf) => window.KNCore.play.hashRom(buf);

  const clearLoadedRom = () => {
    if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
    discardHibernatedEmulatorForRomChange(null);
    _romBlob = null;
    _romBlobUrl = null;
    _romHash = null;
    _romHashLoad = ++_romLoad;
    _romName = null;
    _romDroppedName = null;
    _romSize = null;
    _gameId = null;
    KNState.romHash = null;
    KNState.gameId = null;
    _announceGameId();
    // The server counts this page as ready until told: a start would be taken
    // with no ROM here (specs/rom_at_start.qnt, deletedRomTest).
    if (socket?.connected) socket.emit('rom-ready', { ready: false });
    window.EJS_gameUrl = undefined;
    window.EJS_gameID = 'kaillera-next';
    const romDrop = document.getElementById('rom-drop');
    const statusEl = document.getElementById('rom-status');
    if (romDrop) romDrop.classList.remove('loaded');
    if (statusEl) _setRomStatus('Drop or click to load ROM');
    // A guest with no ROM again may take the host's, so the offer comes back.
    updateRomSharingUI();
  };

  // ── ROM library (IndexedDB) ────────────────────────────────────────────
  // Storage and the list markup are web/src/play/rom-library.ts. What loading
  // a ROM means for this page (its state, the emulator, the server) is here.

  const _romLibrary = window.KNCore.play.openRomLibrary({
    name: _safeGet('localStorage', 'kaillera-rom-name'),
    hash: _safeGet('localStorage', 'kaillera-rom-hash'),
  });

  const cacheRom = async (blob, { name, source = 'local' } = {}) => {
    try {
      const bytes = await (blob instanceof Blob ? blob : new Blob([blob])).arrayBuffer();
      // Can't cache without a hash.
      const hash = await hashArrayBuffer(bytes);
      await _romLibrary.put(hash, window.KNCore.play.newStoredRom(bytes, hash, name, source, _knownRoms, Date.now()));
      if (!isSpectator) renderRomLibrary();
      // The room may have named this ROM as the host's while its copy was on
      // its way here, and the lookup then found nothing (specs/rom_identity.qnt,
      // cacheLandsLateTest).
      if (
        !isHost &&
        hash === _hostRom?.hash &&
        romIdentity.looksInLibraryForHostsRom(!isSpectator, localRomLoaded(), true)
      ) {
        autoMatchRom(hash);
      }
    } catch (_) {}
  };

  const loadRomFromLibrary = (hash, cb) => {
    _romLibrary
      .get(hash)
      .then((val) => {
        if (!val) {
          cb(false);
          return;
        }
        const blob = new Blob([val.blob]);
        const load = ++_romLoad;
        _romBlob = blob;
        _romName = val.name;
        _romDroppedName = null;
        _romSize = val.size || blob.size;
        if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
        _romBlobUrl = URL.createObjectURL(blob);
        window.EJS_gameUrl = _romBlobUrl;
        takeRomHash(load, hash);
        _safeSet('localStorage', 'kaillera-rom-name', val.name);
        _safeSet('localStorage', 'kaillera-rom-hash', hash);
        _announceGameId();
        _romLibrary.touch(hash, Date.now()).catch(() => {});
        // Enable ROM sharing checkbox if host
        const romShareCb = document.getElementById('opt-rom-sharing');
        if (romShareCb && isHost) romShareCb.disabled = false;
        if (!isHost && hostRomMismatch()) {
          socket.emit('rom-ready', { ready: false });
          showRomMismatch(val.name);
        } else {
          hideRomMismatch();
          notifyRomReady();
          // As for a dropped file: a guest with their own ROM no longer sees the host's offer.
          updateRomSharingUI();
        }
        cb(true, val.name);
      })
      .catch(() => cb(false));
  };

  renderRomLibrary = () => {
    const container = document.getElementById('rom-library');
    if (!container) return;

    const hide = () => {
      container.style.display = 'none';
      container.innerHTML = '';
    };
    // Spectators don't load a ROM \u2014 nothing to show.
    if (isSpectator) {
      hide();
      return;
    }

    _romLibrary
      .list()
      .then((entries) => {
        if (entries.length === 0) {
          hide();
          return;
        }

        container.style.display = '';
        container.className = 'rom-library';
        container.innerHTML = window.KNCore.play.romLibraryHtml(entries, {
          isHost,
          activeHash: _romHash,
          hostHash: _hostRom?.hash ?? null,
        });

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
                if (statusEl) _setRomStatus(`Loaded: ${name}`);
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
      })
      .catch(hide);
  };

  const deleteRomFromLibrary = (hash) => {
    // If we deleted the active ROM, clear it
    if (_romHash === hash) clearLoadedRom();
    _romLibrary
      .remove(hash)
      .then(() => renderRomLibrary())
      .catch(() => {});
  };

  const _retroVerifyLibrary = () => {
    if (!Object.keys(_knownRoms).length) return;
    _romLibrary
      .verifyAgainst(_knownRoms)
      .then((updated) => {
        if (updated && isHost) renderRomLibrary();
      })
      .catch(() => {});
  };

  const autoMatchRom = (hostHash) => {
    loadRomFromLibrary(hostHash, (ok, name) => {
      if (ok) {
        const displayName = name || 'cached ROM';
        showToast(`ROM matched \u2014 ${displayName} loaded`);
        const drop = document.getElementById('rom-drop');
        const statusEl = document.getElementById('rom-status');
        if (drop) drop.classList.add('loaded');
        if (statusEl) _setRomStatus(`Loaded: ${displayName}`);
        hideRomMismatch();
        renderRomLibrary();
        if (_isPendingLateJoin()) dismissLateJoinPrompt();
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
    // Only show #game when the emulator is needed (rollback or streaming host).
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
      if (!isHost && everyoneRunsTheGame(mode)) {
        console.log('[play] initEngine: guest rollback boot deferred until gesture');
      } else {
        ensureEmulatorBooted();
      }
    } else {
      console.log('[play] initEngine: connect-only mode (spectator or no ROM)');
    }

    const Engine = mode === 'streaming' ? window.NetplayStreaming : window.NetplayRollback;

    if (!Engine) {
      showError('Netplay engine not loaded');
      return;
    }

    const resyncEnabled = _gameResyncEnabled;

    const lateJoin = _isLateJoin();
    engine = Engine;
    engine.init({
      socket,
      sessionId: roomCode,
      playerSlot: isSpectator ? null : mySlot,
      // This page's own roster entry is found by this too (KNCore.rosterPeers).
      persistentId: _persistentId,
      isSpectator,
      playerName,
      gameElement: document.getElementById('game'),
      resyncEnabled,
      // Lockstep: the rollback engine with nothing predicted (every frame
      // waits for every player's input).
      lockstep: mode === 'lockstep',
      romHash: _romHash ?? null,
      gameId: _gameId ?? null,
      uploadToken: _uploadToken,
      isMobile: _isMobile,
      onMatchIntegrityUnverified: ({ matchId }) => {
        if (matchId !== KNState.matchId || _unverifiedMatchId === matchId) return;
        _unverifiedMatchId = matchId;
        const toolbar = document.getElementById('toolbar-status');
        if (toolbar) toolbar.textContent = RECOVERY_UNVERIFIED;
        showToast(RECOVERY_UNVERIFIED);
      },
      onStatus: (msg) => {
        const status = _unverifiedMatchId && _unverifiedMatchId === KNState.matchId ? RECOVERY_UNVERIFIED : msg;
        // Show in toolbar (visible during gameplay) and overlay (visible pre-game)
        const toolbarEl = document.getElementById('toolbar-status');
        if (toolbarEl) toolbarEl.textContent = status;
        const overlayEl = document.getElementById('engine-status');
        if (overlayEl) overlayEl.textContent = status;
        // Update game loading overlay
        const loadingText = document.getElementById('game-loading-text');
        if (loadingText) loadingText.textContent = status;
        // Dismiss loading overlay when game loop starts or stream connects
        if (msg.includes('game on') || msg.includes('Spectating') || msg.includes('streaming')) {
          dismissGameLoading();
        }
      },
      onPlayersChanged: () => {
        // Engine forwards users-updated — supplementary to our direct listener
      },
      onToast: showToast,
      // `message`: why the match cannot start on this page; none for a crash.
      onFatal: (message) => {
        coreFatal = true;
        engine?.flushSyncLog?.();
        engine?.dumpLogs?.();
        showError(message || "The emulator crashed and can't continue. Reload the page to rejoin the match.");
      },
      onLateJoinInputFailed: (message) => {
        coreFatal = true; // stop the generic connection timeout from replacing this error
        _sessionStopLateJoinPoll();
        // A failed admitted guest must vacate its server slot, not just close
        // its data channels. release-slot is lobby-only; this is the same
        // guest-only leave-room event as the Leave button, without navigation.
        const connection = socket;
        connection?.io?.reconnection(false);
        if (connection?.connected) connection.timeout(2000).emit('leave-room', {}, () => connection.disconnect());
        else connection?.disconnect();
        engine?.stop();
        engine = null;
        showError(message);
      },
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
        if (_romReceiver.phase === 'paused' && engine?.getPeerConnection) {
          startRomTransferTo(sid);
        }
      },
      initialPlayers: lastUsersData,
      lateJoin,
      // The host had not started running, so this page loads as a player
      // who was there at the start instead of waiting for state.
      onLateJoinAdmitted: () => {
        _sessionStopLateJoinPoll();
        _session?.send({ type: 'admittedToStart' });
      },
      // The host started without this page: it had no channel to the host by
      // its own deadline on the start (specs/start_group.qnt, rejoinLate). It
      // joins late instead of waiting for an offer that will not come.
      // The same when the host dropped this page in the match because it
      // could not be kept in sync (specs/drop_is_final.qnt), or while it was
      // still waiting for the state, its serve having timed out
      // (specs/room_lifecycle.qnt, serveTimesOut). The machine moves to
      // lateJoinStarting first, so initEngine below starts a late join.
      onLeftOutOfStart: () => {
        crumb('left-out-of-start', {});
        _session?.send({ type: 'leftOutOfStart' });
        _sessionWatchLateJoin();
        initEngine();
      },
    });
    _session?.send({
      type: 'engineStarted',
      connectOnly: needsEmulator && !(_romBlob || _romBlobUrl),
      waitsForState: needsEmulator,
    });

    // Connection timeout: if the game-loading overlay is still visible after
    // 30 seconds, the WebRTC handshake likely failed.
    // P1-3: include the specific connection state of each peer in the
    // failure message so the operator (and the user) can tell whether it was
    // NAT traversal failure (state=failed), peer never started (state=new),
    // or signaling stalled (no peers in KNState at all).
    setTimeout(() => {
      if (coreFatal) return;
      const loadingEl = document.getElementById('game-loading');
      if (loadingEl && !loadingEl.classList.contains('hidden') && isGameRunning()) {
        const text = document.getElementById('game-loading-text');
        // Inspect peer connection states to give a specific reason
        const peers = KNState.peers || {};
        const peerEntries = Object.values(peers);
        let reason = 'Connection timed out';
        let detail = 'check your network or firewall';
        let eventType = 'webrtc-fail';
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
          } else if (states.every((s) => s === 'connected' || s === 'completed')) {
            reason = 'Game boot timed out';
            detail = 'peer connection is up, but emulator sync did not finish';
            eventType = 'wasm-fail';
          }
          // Report to telemetry so funnel timeline shows the specific reason
          KNEvent(eventType, `${reason}: ${detail}`, { states });
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
    // The ROM just dropped is still being hashed: the start would carry the
    // previous ROM's hash (specs/rom_identity.qnt, hostStartsWhileHashingTest).
    if (!romHashIsLoaded()) {
      showToast('Your ROM is still being checked');
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
    if (_endGameRequest) return;
    const endingMatchId = KNState.matchId || null;
    showToast('Ending game for everyone...');
    // The shared Effect request runner has bounded retries and cancellation.
    // No host-only timeout: that used to leave everyone else in the match.
    const request = window.KNCore.startRejoin({
      send: (answer) => {
        if (socket?.connected) socket.emit('end-game', { matchId: endingMatchId }, answer);
      },
      answerWithinMs: 2000,
      retryAfterMs: 250,
      attempts: 3,
    });
    _endGameRequest = request;
    void request.outcome.then((outcome) => {
      if (_endGameRequest !== request) return;
      _endGameRequest = null;
      if (!_gameStart.endMatchesCurrent(endingMatchId ?? '', KNState.matchId ?? '')) return;
      if (outcome.kind === 'resumed') {
        if (_unverifiedMatchId && _unverifiedMatchId === endingMatchId) {
          showToast('End request acknowledged. The lobby is not yet confirmed.');
          return;
        }
        onGameEnded({ matchId: endingMatchId, localAck: true });
      } else {
        showToast(
          outcome.kind === 'noAnswer'
            ? 'Could not confirm the game ended. Check your connection and try End Game again.'
            : `End game failed: ${outcome.reason}`,
        );
      }
    });
  };

  const leaveGame = () => {
    _endGameRequest?.cancel();
    _endGameRequest = null;
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

  // Undo showLateJoinRomPrompt: take its message away and show the lobby's
  // sections again. Also run when the game ends under the prompt, which
  // used to leave a lobby with only the ROM drop zone and "Game in progress".
  const _clearLateJoinRomPrompt = () => {
    const msg = document.getElementById('late-join-msg');
    if (msg) msg.parentNode.removeChild(msg);
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    const sections = overlay.querySelectorAll(
      '.card-section, .card-header, #host-controls, #guest-status, #leave-btn, #engine-status',
    );
    for (const section of sections) {
      section.style.display = '';
    }
  };

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
      hostHash: _hostRom?.hash?.substring(0, 12),
      sharingEnabled: _romSharingEnabled,
      sharingDecision: _romSharingDecision,
    });
    // A ROM still being hashed: its hash, landing, comes back here.
    if (romVerdictNow() === 'pending') return;
    _setPendingLateJoin(false);

    // Verify ROM hash before joining (skip if ROM sharing — ROM comes from host)
    if (hostRomMismatch() && _romSharingDecision !== 'accepted') {
      if (_romSharingEnabled && _romSharingDecision === null) {
        // ROM sharing available but user hasn't decided yet (e.g. auto-loaded
        // a cached ROM from a previous game). Stay on the sharing prompt so
        // they can accept the host's ROM instead of erroring out.
        _setPendingLateJoin(true);
        return;
      }
      showError("Your ROM doesn't match the host's game. Drop the correct ROM to rejoin.");
      return;
    }

    _clearLateJoinRomPrompt();
    document.getElementById('overlay')?.classList.add('hidden');

    // The next engine start is the late join: the machine is in
    // lateJoinStarting here (a connect-only start for ROM sharing does not
    // leave it).

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
    const watchInsteadRow = document.getElementById('watch-instead-row');
    const romLibrary = document.getElementById('rom-library');
    if (isSpectator) {
      if (romDrop) romDrop.style.display = 'none';
      if (romLibrary) {
        romLibrary.style.display = 'none';
        romLibrary.innerHTML = '';
      }
      if (romSharingPrompt) romSharingPrompt.hidden = true;
      if (gamepadArea) gamepadArea.style.display = 'none';
      if (watchInsteadRow) watchInsteadRow.hidden = true;
      if (guestStatus) guestStatus.textContent = 'Waiting for host to start the game...';
      hideRomMismatch();
    } else {
      // Restore what spectator mode hid — a claim-slot transition (§7.2 M3
      // #3) re-enters this branch from a spectator's already-rendered page.
      if (romDrop) romDrop.style.display = '';
      if (gamepadArea) gamepadArea.style.display = '';
      if (!isHost) {
        // "Watch instead" (§7.2 M3 #1) — the no-ROM path that doesn't leave
        // the room. Only for a guest still choosing a ROM.
        if (watchInsteadRow) watchInsteadRow.hidden = false;
      } else if (watchInsteadRow) {
        watchInsteadRow.hidden = true;
      }
    }

    if (!isHost && !isSpectator) renderRomLibrary();

    updateNameHint();
    syncDelayPickerPlacement();

    const modeSel = document.getElementById('mode-select');
    if (modeSel) modeSel.value = mode;
  };

  const hideOverlay = () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
  };

  // What each slot, the spectator line and the info panel show is
  // web/src/play/room-view.ts; the elements are found and written here.
  const _roomView = window.KNCore.play.roomView;

  const setBadge = (el, badge) => {
    if (!el) return;
    if (badge) {
      el.textContent = badge.icon;
      el.title = badge.label;
      el.setAttribute('aria-label', badge.label);
      el.removeAttribute('aria-hidden');
    } else {
      // Empty slot: no input/device to report. role="img" with no name is
      // an axe violation (role-img-alt); aria-hidden is correct here since
      // the empty state is already conveyed by the "Open" name text.
      el.textContent = '';
      el.title = '';
      el.removeAttribute('aria-label');
      el.setAttribute('aria-hidden', 'true');
    }
  };

  const updatePlayerList = (players, spectators, ownerSid) => {
    for (let i = 0; i < 4; i++) {
      const slotEl = document.querySelector(`.player-slot[data-slot="${i}"]`);
      if (!slotEl) continue;
      const nameEl = slotEl.querySelector('.name');
      if (!nameEl) continue;

      const playerInSlot = Object.values(players).find((entry) => entry.slot === i) ?? null;
      const view = _roomView.slotView(playerInSlot, {
        isOwner: !!(playerInSlot && ownerSid && playerInSlot.socketId === ownerSid),
        gameRunning: isGameRunning(),
        viewerSpectates: isSpectator,
      });

      nameEl.textContent = view.name;
      nameEl.classList.toggle('empty', view.empty);
      if (view.flair) nameEl.dataset.a21 = '1';
      else delete nameEl.dataset.a21;

      const romEl = slotEl.querySelector('.rom-status');
      if (romEl) {
        romEl.textContent = view.romText;
        romEl.className = view.romClass ? `rom-status ${view.romClass}` : 'rom-status';
      }
      setBadge(slotEl.querySelector('.gamepad'), view.input);
      setBadge(slotEl.querySelector('.device'), view.device);
      const claimBtn = slotEl.querySelector('.claim-slot-btn');
      if (claimBtn) claimBtn.hidden = view.claimHidden;
    }

    const specEl = document.getElementById('spectator-list');
    if (specEl) {
      specEl.textContent = _roomView.spectatorLine(Object.values(spectators).map((s) => s.playerName));
    }
  };

  const updateStartButton = (players) => {
    const btn = document.getElementById('start-btn');
    if (!btn || !isHost) return;
    const sel = document.getElementById('mode-select');
    const selectedMode = sel ? sel.value : mode;
    const entries = Object.values(players);
    // Whether the host may start, and what the button says, is room-view.ts:
    // streaming needs two players and no ROMs (the host runs the only
    // emulator); rollback needs every player's ROM, unless the host shares.
    const look = _roomView.startButton(
      entries.length,
      entries.filter((p) => p.romReady).length,
      selectedMode,
      _romSharingEnabled,
      romHashIsLoaded(),
    );
    btn.disabled = look.disabled;
    btn.textContent = look.label;
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
    startBootPorts();
  };

  // Exposed so the rollback engine can re-show the overlay when a late-join
  // state arrives — guarantees the EJS canvas (which may be painting boot
  // frames) stays fully covered until the host's state is loaded.
  window.knShowGameLoading = showGameLoading;

  const dismissGameLoading = () => {
    if (_loadingTimeoutId) {
      clearTimeout(_loadingTimeoutId);
      _loadingTimeoutId = null;
    }
    const el = document.getElementById('game-loading');
    if (!el || el.classList.contains('hidden')) return;
    stopBootPorts({ collapse: true });
    el.classList.add('fade-out');
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('fade-out');
    }, 400);
  };

  // Local preview replaces the menu affordance, not the existing gamepad layout.
  const resetCombo = window.KNCore.page.startContextualReset(
    window,
    KNState,
    (address) => engine?.readRdram32?.(address) ?? null,
  );
  document.querySelector('#toolbar-reset-combo')?.setAttribute('hidden', '');

  const showToolbar = () => {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    const roomEl = document.getElementById('toolbar-room');
    if (roomEl) roomEl.textContent = roomCode;

    const resetBtn = document.getElementById('toolbar-reset-combo');
    if (resetBtn) resetBtn.style.display = isSpectator ? 'none' : '';
    const endBtn = document.getElementById('toolbar-end');
    if (endBtn) endBtn.style.display = isHost ? '' : 'none';
  };

  const hideToolbar = () => {
    resetCombo.close();
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

    const usesGamepad = !!window.GamepadManager?.hasGamepad?.(mySlot);
    const panel = _roomView.infoPanel(info, usesGamepad);
    if (headerEl) headerEl.textContent = panel.header;
    if (statsEl) statsEl.textContent = panel.stats;
    if (peersEl) peersEl.textContent = panel.peers;
  };

  // ── UI: Toast Notifications ───────────────────────────────────────────

  const showSyncStatus = (_msg) => {
    // Intentionally silent — updating toolbar-status wraps the toolbar on mobile,
    // shrinking #game and triggering EJS ResizeObserver (canvas clear).
  };

  // Toasts, the error card and the room-full banner are web/src/play/notices.ts.
  const { showToast, showErrorCard, showRoomFullBanner } = window.KNCore.play.notices;

  // Expose toast/error for cross-module UI surfacing (P1-3). Other modules
  // (shared.js, netplay-rollback.js) can call these to show user-visible
  // messages instead of failing silently.
  window.knShowToast = showToast;

  // ── UI: Error ──────────────────────────────────────────────────────────

  const showError = (msg) => {
    crumb('error', msg);
    flushBreadcrumbs(msg);
    showErrorCard(msg);
  };

  // Expose for cross-module UI surfacing — see knShowToast comment above.
  window.knShowError = showError;

  // ── UI: Copy Link ─────────────────────────────────────────────────────

  // Invite links land on the invite page (landing-design §7.2 M2), which
  // wakes the server if needed and says what Join and Watch need before
  // handing off to this page.
  const inviteUrl = (spectate) => window.KNCore.play.inviteUrl(window.location.origin, roomCode, spectate);

  // The invite menu, sharing or copying a link, and the More menu are
  // web/src/play/menus.ts.
  const _menus = window.KNCore.play.menus;
  const inviteLinksNow = () => _menus.inviteLinks(inviteUrl(false), inviteUrl(true));
  const copyLink = () => _menus.toggleInviteMenu(inviteUrl(false), inviteUrl(true), _isMobile);
  const toggleMoreDropdown = _menus.toggleMoreMenu;
  const closeMoreDropdown = _menus.closeMoreMenu;

  window.KNCloseMoreDropdown = closeMoreDropdown;

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
        statusEl.textContent = `${GamepadManager.displayName(primary.id).substring(0, 40)} (${primary.profileName})`;
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
  // What each input does (which step takes it, what it does to the mapping,
  // Back and Skip) is web/src/play/remap-wizard.ts; whether a step takes it
  // is remap-step.ts (proved). This keeps what touches the page: polling the
  // pads, the key listener, the debounce, the prompts and saving.

  const _remap = window.KNCore.play.remapWizard;

  let _wizardActive = false;
  let _wizardInGame = false; // true when wizard launched from in-game toolbar
  let _wizard = null; // the rules' state (remap-wizard.ts) for the current run
  let _wizardDebounce = 0;
  let _wizardRafId = null;
  let _wizardKeyHandler = null;
  let _wizardBaselineButtons = null;
  let _wizardHadGamepad = false;
  let _wizardHotPlugCheck = 0;

  // The pad buttons held right now: a step takes only a button pressed after it began.
  const wizardHeldButtons = () => {
    const held = {};
    const gps = GamepadManager.nativeGetGamepads();
    for (let gi = 0; gi < gps.length; gi++) {
      if (gps[gi]) {
        for (let bi = 0; bi < gps[gi].buttons.length; bi++) {
          if (gps[gi].buttons[bi].pressed) held[`${gi}:${bi}`] = true;
        }
      }
    }
    return held;
  };

  const startWizard = (inGame) => {
    // Idempotent: if the wizard is already running, tear it down first so we
    // don't orphan the previous _wizardKeyHandler when overwriting it below.
    if (_wizardActive) cancelWizard();
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    const gamepadId = detected.length > 0 ? detected[0].id : null;

    // The wizard edits a copy of the pad's current profile (saved or default)
    // and the saved key map (the default one when none is saved).
    let profile = null;
    if (gamepadId && window.GamepadManager) {
      const current = GamepadManager.hasCustomProfile(gamepadId)
        ? JSON.parse(_safeGet('localStorage', `gamepad-profile:${gamepadId}`))
        : GamepadManager.getDefaultProfile(gamepadId);
      profile = _remap.customProfileFrom(current);
    }
    let savedKb = null;
    try {
      savedKb = JSON.parse(_safeGet('localStorage', 'keyboard-mapping'));
    } catch (_) {}
    _wizard = _remap.startWizardState(profile, savedKb);

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
    _wizardBaselineButtons = gamepadId ? wizardHeldButtons() : {};

    // Keyboard listener
    _wizardKeyHandler = (e) => {
      if (!_wizardActive) return;
      if (e.keyCode === 27) {
        cancelWizard();
        return;
      } // Escape
      e.preventDefault();
      if (Date.now() < _wizardDebounce) return;
      wizardInput({ kind: 'key', keyCode: e.keyCode });
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
    // Save the gamepad profile, with each stick whose two directions were captured
    const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    const profile = _remap.finishedProfile(_wizard);
    if (detected.length > 0 && profile) {
      GamepadManager.saveGamepadProfile(detected[0].id, profile);
    }

    // Save keyboard mapping
    try {
      _safeSet('localStorage', 'keyboard-mapping', JSON.stringify(_wizard.keyMap));
    } catch (_) {}
    // Tell the netplay engine to re-read its cached keymap so the
    // wizard's binding changes actually reach readLocalInput.
    window.NetplayRollback?.refreshKeyMap?.();

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
    window.NetplayRollback?.refreshKeyMap?.();
    updateGamepadUI();
  };

  const wizardPromptElements = () => {
    const prefix = _wizardInGame ? 'ingame-remap' : 'remap';
    return {
      promptEl: document.getElementById(`${prefix}-prompt`),
      progressEl: document.getElementById(`${prefix}-progress`),
      backBtn: document.getElementById(`${prefix}-back`),
    };
  };

  const updateWizardPrompt = () => {
    if (!_wizardActive) return;
    const { promptEl, progressEl, backBtn } = wizardPromptElements();
    const { prompt, progress, canGoBack } = _remap.wizardPrompt(_wizard);
    if (promptEl) promptEl.textContent = prompt;
    if (progressEl) progressEl.textContent = progress;
    if (backBtn) backBtn.disabled = !canGoBack;
  };

  // Hand one input to the rules and carry out what they decided.
  const wizardInput = (input) => {
    const outcome = _remap.wizardInput(_wizard, input);
    _wizard = outcome.state;
    if (outcome.result === 'ignored') return;
    if (outcome.result === 'wrong-stick') {
      // The other direction of this stick was captured on another axis.
      const { promptEl } = wizardPromptElements();
      if (promptEl) {
        promptEl.textContent = `Must use same stick as ${outcome.pairName} — try again`;
        setTimeout(updateWizardPrompt, 1000);
      }
      return;
    }
    _wizardDebounce = Date.now() + 150;
    if (outcome.result === 'done') {
      saveWizard();
      return;
    }
    // A new step takes only a button pressed after it began (Back keeps the old baseline).
    if (input.kind !== 'back') _wizardBaselineButtons = wizardHeldButtons();
    updateWizardPrompt();
  };

  const wizardBack = () => {
    if (!_wizardActive) return;
    wizardInput({ kind: 'back' });
  };

  const wizardSkip = () => {
    if (!_wizardActive) return;
    wizardInput({ kind: 'skip' });
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

    const step = _remap.WIZARD_STEPS[_wizard.step];

    for (let gi = 0; gi < gps.length; gi++) {
      const gp = gps[gi];
      if (!gp) continue;

      // Check buttons (for button and cbutton steps)
      if (step.type === 'button' || step.type === 'cbutton') {
        for (let bi = 0; bi < gp.buttons.length; bi++) {
          if (gp.buttons[bi].pressed && !_wizardBaselineButtons[`${gi}:${bi}`]) {
            wizardInput({ kind: 'button', index: bi });
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
            wizardInput({ kind: 'axis', index: ai, positive: val > 0 });
            return;
          }
        }
      }
    }
  };

  // ── Delay Preference ────────────────────────────────────────────────

  // The delay itself (what this player asks the engine for), what Auto means
  // and the wording beside the picker are web/src/play/delay.ts.
  const _delay = window.KNCore.play.delay;

  KNState.delayAutoValue = _delay.DEFAULT_FRAME_DELAY;

  const isSoloDelayContext = () => {
    if (isSpectator || !lastUsersData?.players) return false;
    return Object.keys(lastUsersData.players).length <= 1;
  };

  // The delay picker as it stands: who is in the room and what the controls say.
  const delayPickerNow = () => ({
    solo: isSoloDelayContext(),
    auto: document.getElementById('delay-auto')?.checked,
    selectValue: document.getElementById('delay-select')?.value,
    autoValue: KNState.delayAutoValue,
  });

  const currentAutoDelayValue = () =>
    _delay.currentAutoDelay({ solo: isSoloDelayContext(), autoValue: KNState.delayAutoValue });

  // The delay this player asks the match for is delay.ts: none when solo,
  // Auto's measurement when Auto is on, else the select's value.
  const getDelayPreference = () => _delay.delayPreference(delayPickerNow());

  window.getDelayPreference = getDelayPreference;

  const setAutoDelay = (value) => {
    KNState.delayAutoValue = _delay.sanitizeFrameDelay(value);
    const selectEl = document.getElementById('delay-select');
    const autoEl = document.getElementById('delay-auto');
    if (selectEl && autoEl?.checked) {
      selectEl.value = String(currentAutoDelayValue());
      updateDelayEffectiveHintFromPicker();
    }
  };

  window.setAutoDelay = setAutoDelay;

  const updateDelayEffectiveHintFromPicker = () => {
    const el = document.getElementById('delay-effective');
    if (!el) return;
    syncDelaySelectSoloOption();
    syncDelaySelectVisibility();
    const hint = _delay.pickerHint(delayPickerNow());
    const selectEl = document.getElementById('delay-select');
    if (selectEl && hint.selectValue !== undefined) selectEl.value = hint.selectValue;
    el.textContent = hint.text;
    updateAdvancedSummaryStatuses();
  };

  const directAdvancedOptions = (parent) =>
    Array.from(parent?.children || []).find((el) => el.classList?.contains('advanced-options')) || null;

  const createAdvancedOptions = () => {
    const details = document.createElement('details');
    details.className = 'advanced-options';
    const summary = document.createElement('summary');
    const status = document.createElement('span');
    status.className = 'summary-status';
    summary.append(document.createTextNode('Advanced '), status);
    details.appendChild(summary);
    return details;
  };

  const syncDelaySelectSoloOption = () => {
    const selectEl = document.getElementById('delay-select');
    if (!selectEl) return;
    let zeroOption = selectEl.querySelector('option[value="0"]');
    if (!zeroOption) {
      zeroOption = new Option('0', '0');
      selectEl.prepend(zeroOption);
    }
    zeroOption.textContent = '0';
    const solo = _delay.soloOption(delayPickerNow());
    zeroOption.disabled = solo.disabled;
    if (zeroOption.disabled && selectEl.value === '0') selectEl.value = solo.fallbackValue;
  };

  const normalizeDelaySelectOptions = () => {
    syncDelaySelectSoloOption();
    syncDelaySelectVisibility();
  };

  const syncDelaySelectVisibility = () => {
    const autoEl = document.getElementById('delay-auto');
    const selectEl = document.getElementById('delay-select');
    if (selectEl) selectEl.hidden = !!autoEl?.checked;
  };

  const selectedModeIsRollback = () =>
    everyoneRunsTheGame(normalizeMode(document.getElementById('mode-select')?.value || mode));

  const updatePlayerControlsVisibility = (isRollbackMode = selectedModeIsRollback()) => {
    const playerControls = document.getElementById('player-controls');
    if (playerControls) playerControls.style.display = !isHost && !isSpectator && isRollbackMode ? '' : 'none';
  };

  const updateDelayPickerVisibility = (isRollbackMode = selectedModeIsRollback()) => {
    const delayPicker = document.getElementById('delay-picker');
    if (delayPicker) delayPicker.style.display = !isSpectator && isRollbackMode ? '' : 'none';
  };

  const getDelaySummaryText = () =>
    _delay.delaySummary(delayPickerNow(), document.getElementById('delay-effective')?.textContent);

  const syncDelayPickerPlacement = (isRollbackMode = selectedModeIsRollback()) => {
    const hostDetails = document.querySelector('#host-controls .advanced-options');
    const playerDetails = document.querySelector('#player-controls .advanced-options');
    const delayPicker = document.getElementById('delay-picker');
    const targetDetails = isHost ? hostDetails : playerDetails;
    if (delayPicker && targetDetails && delayPicker.parentElement !== targetDetails) {
      targetDetails.appendChild(delayPicker);
    }
    updatePlayerControlsVisibility(isRollbackMode);
    updateDelayPickerVisibility(isRollbackMode);
    updateDelayEffectiveHintFromPicker();
  };

  const ensureAdvancedSummary = (details) => {
    if (!details) return null;
    let summary = Array.from(details.children).find((el) => el.tagName === 'SUMMARY');
    if (!summary) {
      summary = document.createElement('summary');
      details.prepend(summary);
    }
    if (!summary.textContent.trim().startsWith('Advanced')) {
      summary.prepend(document.createTextNode('Advanced'));
    }
    let status = summary.querySelector('.summary-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'summary-status';
      summary.appendChild(status);
    }
    return status;
  };

  const normalizeAdvancedOptionsMarkup = () => {
    const hostControls = document.getElementById('host-controls');
    if (hostControls) {
      let hostDetails = directAdvancedOptions(hostControls);
      const startBtn = document.getElementById('start-btn');
      if (!hostDetails) {
        hostDetails = createAdvancedOptions();
        hostControls.insertBefore(hostDetails, startBtn || null);
      }
      ensureAdvancedSummary(hostDetails);
      for (const id of ['rollback-options', 'rom-sharing-options', 'rom-sharing-disclaimer']) {
        const el = document.getElementById(id);
        if (el && el.parentElement !== hostDetails) hostDetails.appendChild(el);
      }
      if (startBtn?.parentElement === hostControls && startBtn.previousElementSibling !== hostDetails) {
        hostControls.insertBefore(hostDetails, startBtn);
      }
    }

    const playerControls = document.getElementById('player-controls');
    if (playerControls) {
      let delayDetails = directAdvancedOptions(playerControls);
      if (!delayDetails) {
        delayDetails = createAdvancedOptions();
        playerControls.appendChild(delayDetails);
      }
      ensureAdvancedSummary(delayDetails);
    }
    normalizeDelaySelectOptions();
    syncDelayPickerPlacement();
  };

  const normalizeGamepadControlsMarkup = () => {
    document.getElementById('remap-btn')?.remove();
    document.getElementById('reset-mapping-btn')?.remove();

    const overlaySettingsBtn = document.getElementById('overlay-settings-btn');
    if (overlaySettingsBtn) overlaySettingsBtn.textContent = 'Configure Controller';
  };

  const updateAdvancedSummaryStatuses = () => {
    const delayText = getDelaySummaryText();
    const hostStatus = document.querySelector('#host-controls .advanced-options .summary-status');
    if (hostStatus) {
      const resyncOn = document.getElementById('opt-resync')?.checked ?? false;
      const romSharingOn = document.getElementById('opt-rom-sharing')?.checked ?? false;
      hostStatus.textContent = _delay.hostOptionsSummary(resyncOn, romSharingOn, delayText);
    }

    const delayStatus = document.querySelector('#player-controls .advanced-options .summary-status');
    if (delayStatus) {
      delayStatus.textContent = delayText;
    }
  };

  const wireAdvancedSummaryStatus = () => {
    const optResync = document.getElementById('opt-resync');
    if (optResync) optResync.addEventListener('change', updateAdvancedSummaryStatuses);

    const romShareCb = document.getElementById('opt-rom-sharing');
    if (romShareCb) romShareCb.addEventListener('change', () => requestAnimationFrame(updateAdvancedSummaryStatuses));

    const delayAuto = document.getElementById('delay-auto');
    if (delayAuto) delayAuto.addEventListener('change', () => requestAnimationFrame(updateAdvancedSummaryStatuses));

    const delaySelect = document.getElementById('delay-select');
    if (delaySelect) delaySelect.addEventListener('change', updateDelayEffectiveHintFromPicker);

    updateDelayEffectiveHintFromPicker();
  };

  const showEffectiveDelay = (own, room) => {
    const el = document.getElementById('delay-effective');
    if (!el) return;
    el.textContent = _delay.effectiveDelayHint(own, room);
    updateAdvancedSummaryStatuses();
  };

  window.showEffectiveDelay = showEffectiveDelay;

  const normalizeRomSharingMarkup = () => {
    const prompt = document.getElementById('rom-sharing-prompt');
    if (prompt) {
      prompt.hidden = prompt.hidden || prompt.style.display === 'none';
      prompt.style.display = '';
      const promptText = prompt.querySelector('.rom-sharing-prompt-text');
      if (promptText) promptText.removeAttribute('style');
      const legal =
        prompt.querySelector('.rom-sharing-prompt-legal') || prompt.querySelector('.rom-sharing-prompt-text span');
      if (legal) {
        legal.classList.add('rom-sharing-prompt-legal');
        legal.removeAttribute('style');
      }
    }

    const progress = document.getElementById('rom-transfer-progress');
    if (progress) {
      progress.hidden = progress.hidden || progress.style.display === 'none';
      progress.style.display = '';
    }

    const retryBtn = document.getElementById('rom-transfer-retry');
    if (retryBtn) {
      retryBtn.hidden = retryBtn.hidden || retryBtn.style.display === 'none';
      retryBtn.style.display = '';
    }
  };

  // ── Room overlay restyle (docs/landing-design.md §7.2 M3) ───────────────

  // Unsupported-browser screen — shown before anything else loads when a
  // required feature is missing. Plain-language names for the feature-
  // detection list built at init (RTCPeerConnection, WebAssembly,
  // crossOriginIsolated).
  const _MISSING_FEATURE_LABELS = {
    RTCPeerConnection: 'peer-to-peer connections (WebRTC)',
    WebAssembly: 'WebAssembly, needed to run the emulator',
    crossOriginIsolated: 'a security feature (SharedArrayBuffer) that in-app browsers and some privacy modes turn off',
  };

  const showUnsupportedBrowser = (missing) => {
    const el = document.getElementById('unsupported-browser');
    if (!el) return;
    el.classList.remove('hidden');
    const detail = document.getElementById('unsupported-detail');
    if (detail) {
      const names = missing.map((m) => _MISSING_FEATURE_LABELS[m] || m);
      detail.textContent =
        names.length === 1
          ? `This browser can't run the game. It needs ${names[0]}.`
          : `This browser can't run the game. It's missing: ${names.join('; ')}.`;
    }
    const copyBtn = document.getElementById('unsupported-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        _menus.copyToClipboard(inviteUrl(false), 'Link');
      });
    }
    const watchBtn = document.getElementById('unsupported-watch');
    if (watchBtn) {
      // Watching only needs WebRTC (video receive) — offer it unless that's
      // also missing.
      if (!missing.includes('RTCPeerConnection') && roomCode) {
        watchBtn.hidden = false;
        watchBtn.addEventListener('click', () => {
          window.location.href = inviteUrl(true);
        });
      } else {
        watchBtn.hidden = true;
      }
    }
  };

  // ── "Watch instead" — player releases their slot to spectate without
  // leaving the room (server event: release-slot). Lobby-only.
  const releaseSlot = () => {
    if (!socket?.connected) return;
    socket.emit('release-slot', {}, (err) => {
      if (err) {
        showToast(err);
        return;
      }
      // isSpectator flips on the users-updated broadcast this triggers.
    });
  };

  // ── Name: gentle nudge, never a block (docs/landing-design.md §7.4/§7.11) —
  // "Player" is an allowed name; this just invites picking a real one.
  const updateNameHint = () => {
    const hint = document.getElementById('name-hint');
    if (!hint) return;
    hint.hidden = !(playerName || '').trim() || playerName.trim().toLowerCase() !== 'player';
  };

  // ── Spectator slot-claim ("Join · needs your ROM") ──────────────────────
  const wireClaimSlotButtons = () => {
    const list = document.getElementById('player-list');
    if (!list || list.dataset.claimWired) return;
    list.dataset.claimWired = '1';
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.claim-slot-btn');
      if (!btn || btn.hidden || btn.disabled) return;
      if (mode !== 'streaming' && emulatorMissing().length) {
        showToast("This browser can't run the game — you can keep watching.");
        return;
      }
      const slot = Number(btn.dataset.slot);
      btn.disabled = true;
      socket.emit('claim-slot', { slot }, (err) => {
        btn.disabled = false;
        if (err) showToast(err);
      });
    });
  };

  // ── Match start — boot/sync loading overlay (§5.7f #2, §7.11) ──────────
  // Ports fill from REAL state only: a slot fills once its player is
  // ROM-ready AND (it's our own slot, or that peer's WebRTC DataChannel is
  // open). No fabricated timing — this reads KNState.peers, which the
  // netplay engines already populate; it never writes to it.
  let _bootPortsTimer = null;
  let _bootAllReadyFired = false;

  const _slotIsBootReady = (slot, playersBySlot) => {
    const p = playersBySlot[slot];
    if (!p) return false;
    if (slot === mySlot) return !!p.romReady;
    const peers = (window.KNState && KNState.peers) || {};
    const peer = Object.values(peers).find((pr) => pr.slot === slot);
    const connected = !!(peer && peer.dc && peer.dc.readyState === 'open');
    return !!p.romReady && connected;
  };

  const updateBootPorts = () => {
    const svg = document.getElementById('ms-boot');
    if (!svg) return;
    const playersBySlot = {};
    for (const p of Object.values(lastUsersData?.players || {})) playersBySlot[p.slot] = p;
    let occupied = 0;
    let ready = 0;
    for (let slot = 0; slot < 4; slot++) {
      const fillEl = svg.querySelector(`.fill[data-slot="${slot}"]`);
      if (!fillEl) continue;
      const present = !!playersBySlot[slot];
      if (present) occupied++;
      const isReady = present && _slotIsBootReady(slot, playersBySlot);
      if (isReady) ready++;
      fillEl.classList.toggle('is-ready', isReady);
      fillEl.classList.toggle('is-open', !present);
    }
    if (occupied > 0 && ready === occupied && !_bootAllReadyFired) {
      _bootAllReadyFired = true;
      svg.classList.add('all-ready');
    }
  };

  const startBootPorts = () => {
    _bootAllReadyFired = false;
    const svg = document.getElementById('ms-boot');
    if (svg) svg.classList.remove('all-ready', 'collapsing');
    updateBootPorts();
    if (_bootPortsTimer) clearInterval(_bootPortsTimer);
    _bootPortsTimer = setInterval(updateBootPorts, 250);
  };

  const stopBootPorts = ({ collapse = false } = {}) => {
    if (_bootPortsTimer) {
      clearInterval(_bootPortsTimer);
      _bootPortsTimer = null;
    }
    const svg = document.getElementById('ms-boot');
    if (svg && collapse) svg.classList.add('collapsing');
  };

  window.KNBootPorts = { start: startBootPorts, stop: stopBootPorts, update: updateBootPorts };

  // ── Init ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    console.log('kaillera-next — v0.9 forever');
    console.log('Welcome to a new EmuLinker Server!');
    console.log('Edit language.properties to setup your login announcements');
    parseParams();
    const initialModeSelect = document.getElementById('mode-select');
    if (initialModeSelect) initialModeSelect.value = mode;
    normalizeRomSharingMarkup();
    normalizeAdvancedOptionsMarkup();
    normalizeGamepadControlsMarkup();
    // Agent 21 badge — gold jersey number for the creator's handle
    const _a21style = document.createElement('style');
    _a21style.textContent =
      `.name[data-a21]::after{content:'21';display:inline-block;` +
      `margin-left:5px;padding:1px 5px;background:#c9a227;color:#111;` +
      `border-radius:3px;font-size:.7em;font-weight:700;vertical-align:middle;}`;
    document.head.appendChild(_a21style);
    // Fetch known ROM hashes for verification
    fetch('/api/rom-hashes')
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        _knownRoms = data;
        if (_romHash) {
          _gameId = _gameIdFromHash(_romHash);
          KNState.gameId = _gameId;
          // A ROM loaded from the cache before the table arrived was
          // announced with no game id.
          _announceGameId();
          if (_romStatusText) _renderRomStatus();
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

    // Feature detection — §7.2 M3 #2: an unsupported-browser screen shown
    // before anything else loads, instead of a silent later failure.
    const missing = [];
    // Hosts know their selected mode from the URL. Guests defer emulator-only
    // checks until the room lookup supplies its authoritative mode.
    const needsEmulator = isHost && mode !== 'streaming';
    if (typeof RTCPeerConnection === 'undefined') missing.push('RTCPeerConnection');
    if (needsEmulator) missing.push(...emulatorMissing());
    if (missing.length) {
      KNEvent('compat', `Missing: ${missing.join(', ')}`, { missing });
      showUnsupportedBrowser(missing);
      return;
    }

    // Name input — populate from current name, save + notify on change.
    // "Player" is an allowed name (§7.4/§7.11) — updateNameHint only nudges.
    const nameInput = document.getElementById('player-name-input');
    updateNameHint();
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
        updateNameHint();
      });
    }

    wireClaimSlotButtons();

    const watchInsteadBtn = document.getElementById('watch-instead-btn');
    if (watchInsteadBtn) watchInsteadBtn.addEventListener('click', releaseSlot);

    const romMismatchChoose = document.getElementById('rom-mismatch-choose');
    const romDropEl = document.getElementById('rom-drop');
    if (romMismatchChoose && romDropEl) {
      romMismatchChoose.addEventListener('click', (e) => {
        e.stopPropagation();
        romDropEl.click();
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
        _menus.shareOrCopy(inviteLinksNow().play, _isMobile);
        closeMoreDropdown();
      });
    }

    const shareWatch = document.getElementById('share-watch');
    if (shareWatch) {
      shareWatch.addEventListener('click', () => {
        _menus.shareOrCopy(inviteLinksNow().watch, _isMobile);
        closeMoreDropdown();
      });
    }

    document.getElementById('toolbar-reset-combo')?.addEventListener('click', () => {
      closeMoreDropdown();
      resetCombo.refresh();
    });

    // More (overflow) dropdown
    const toolbarMore = document.getElementById('toolbar-more');
    if (toolbarMore) toolbarMore.addEventListener('click', toggleMoreDropdown);

    // Close dropdowns on outside click or Escape
    document.addEventListener('click', (e) => {
      const moreW = document.getElementById('more-wrapper');
      const dd = document.getElementById('more-dropdown');
      if (moreW && !moreW.contains(e.target) && !dd?.contains(e.target)) closeMoreDropdown();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMoreDropdown();
      }
    });

    const copyBtn = document.getElementById('copy-link');
    if (copyBtn) copyBtn.addEventListener('click', copyLink);

    // Show/hide rollback options based on mode selector
    const modeSelect = document.getElementById('mode-select');
    const rollbackOpts = document.getElementById('rollback-options');
    if (modeSelect && rollbackOpts) {
      // Set mode-select from URL params before running updateOpts
      modeSelect.value = mode;
      let _romSharingBeforeStreamingMode = false;
      const updateOpts = () => {
        const isRollback = everyoneRunsTheGame(normalizeMode(modeSelect.value));
        mode = normalizeMode(modeSelect.value);
        rollbackOpts.style.display = isRollback ? '' : 'none';
        syncDelayPickerPlacement(isRollback);
        // Hide ROM sharing options in streaming mode
        const romSharingRow = document.getElementById('rom-sharing-options');
        const romSharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
        if (romSharingRow) romSharingRow.style.display = isRollback ? '' : 'none';
        if (!isRollback && romSharingDisclaimer) romSharingDisclaimer.style.display = 'none';
        const cb = document.getElementById('opt-rom-sharing');
        if (!isRollback) {
          // Switching to streaming — save and disable sharing
          _romSharingBeforeStreamingMode = cb?.checked ?? false;
          if (cb?.checked) {
            cb.checked = false;
            socket.emit('rom-sharing-toggle', { enabled: false });
          }
        } else if (_romSharingBeforeStreamingMode && cb && !cb.checked) {
          // Switching back to rollback — restore previous sharing state
          cb.checked = true;
          socket.emit('rom-sharing-toggle', { enabled: true });
          _romSharingBeforeStreamingMode = false;
        }
        updateRomSharingUI();
        if (lastUsersData) updateStartButton(lastUsersData.players || {});
        // Broadcast mode to guests so they can update ROM/sharing UI for the new mode
        if (socket?.connected) {
          socket.emit('data-message', { type: 'mode-select', mode: modeSelect.value });
          // Also set on server for users-updated payload (requires server restart)
          socket.emit('set-mode', { mode: modeSelect.value });
        }
      };
      modeSelect.addEventListener('change', updateOpts);
      updateOpts();
    }

    // Front-page listing (host only; the server refuses password rooms)
    const listedCb = document.getElementById('opt-listed');
    if (listedCb) {
      listedCb.addEventListener('change', () => {
        const listed = listedCb.checked;
        socket.emit('set-listed', { listed }, (err) => {
          if (!err) return;
          listedCb.checked = !listed;
          showToast(err);
        });
      });
    }

    // ROM sharing toggle
    const romShareCb = document.getElementById('opt-rom-sharing');
    if (!_ROM_SHARING_FEATURE) {
      // Feature disabled server-side — hide all ROM sharing UI permanently.
      const sharingRow = document.getElementById('rom-sharing-options');
      const sharingPrompt = document.getElementById('rom-sharing-prompt');
      const sharingDisclaimer = document.getElementById('rom-sharing-disclaimer');
      if (sharingRow) sharingRow.style.display = 'none';
      if (sharingPrompt) sharingPrompt.hidden = true;
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

    // Delay picker
    const delayAuto = document.getElementById('delay-auto');
    const delaySelect = document.getElementById('delay-select');
    if (delayAuto && delaySelect) {
      delayAuto.addEventListener('change', () => {
        delaySelect.disabled = delayAuto.checked;
        if (delayAuto.checked) delaySelect.value = String(currentAutoDelayValue());
        updateDelayEffectiveHintFromPicker();
      });
    }
    wireAdvancedSummaryStatus();

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
  // The ROM this page holds (a Blob once one has arrived from the host), or null.
  window.__test_romBlob = () => _romBlob;
})();
