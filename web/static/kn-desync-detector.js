/**
 * kn-desync-detector.js — Cross-peer field-granular desync detection.
 *
 * Architecture: each peer computes per-frame field hashes via the C
 * exports added in kn_hash_registry, broadcasts a digest packet over
 * the existing WebRTC DataChannel, and compares against peer digests
 * by frame_id. Mismatches emit `desync-suspect` events on
 * KNDesync.events which kn-vision-client.js (chunk 4) consumes.
 *
 * Pattern: IIFE + window.KNDesync, matching project convention
 * (no ES modules — see memory feedback_no_es_modules).
 *
 * Spec: docs/superpowers/specs/2026-04-25-desync-detection-design.md
 * Plan: docs/superpowers/plans/2026-04-25-desync-detection.md
 */
(function () {
  'use strict';

  /* ── Configuration ───────────────────────────────────────────── */
  const CONFIG = {
    digestCadence: { B: 1, C: 6 }, // frames between broadcasts
    heartbeatIntervalMs: 5000, // B-mode only
    dedupWindowFrames: 60, // per (field, slot) flag dedup
    historyDepth: 60,
    visionConfidenceMin: 'med',
  };

  /* Diagnostic-only URL flag: ?forceDesyncTick=1 forces the per-tick
   * digest build to run even with a synthetic peer, so the demo can
   * measure the build cost under simulated network conditions. Real
   * production sessions never set this; it's just a perf-measurement
   * hatch. The flag is read once at module load and stored on window
   * so kn-desync-detector's tick() can check it without reparsing. */
  try {
    const params = new URLSearchParams(window.location?.search || '');
    if (params.get('forceDesyncTick') === '1') window.__knForceDesyncTick = true;
  } catch (_) {}

  /* ── KN_FIELD_* enum (mirror of kn_hash_registry.h) ──────────── */
  const FIELD = Object.freeze({
    STOCKS_P0: 0,
    STOCKS_P1: 1,
    STOCKS_P2: 2,
    STOCKS_P3: 3,
    CHARACTER_ID_P0: 4,
    CHARACTER_ID_P1: 5,
    CHARACTER_ID_P2: 6,
    CHARACTER_ID_P3: 7,
    CSS_CURSOR_P0: 8,
    CSS_CURSOR_P1: 9,
    CSS_CURSOR_P2: 10,
    CSS_CURSOR_P3: 11,
    CSS_SELECTED_P0: 12,
    CSS_SELECTED_P1: 13,
    CSS_SELECTED_P2: 14,
    CSS_SELECTED_P3: 15,
    RNG: 16,
    MATCH_PHASE: 17,
    VS_BATTLE_HDR: 18,
    PHYSICS_MOTION: 19,
    FT_BUFFER: 20,
    COUNT: 21,
  });

  /* ── State ───────────────────────────────────────────────────── */
  let _mode = 'B';
  let _enabled = false;
  let _module = null;
  let _peerDigests = new Map(); // peer_id → Map<frame, digest>
  let _localDigests = new Map(); // frame → digest
  let _localFrameTick = 0;
  let _lastFlagFrame = new Map(); // "field:slot" → frame
  let _heartbeatTimerId = null;
  let _missingExportsLogged = false;
  // Frames the engine may still replay (its rollback window). A digest is
  // built for the frame this far behind the newest one; see tick().
  let _confirmWindow = 0;
  let _noDecisionLogged = false;
  const _events = new EventTarget();

  /* (Helpers _buildLocalDigest, _broadcastDigest, etc. added in
   * subsequent tasks. The skeleton declares them as no-ops to keep
   * the public API stable across incremental commits.) */

  const REQUIRED_EXPORTS = [
    '_kn_hash_stocks',
    '_kn_hash_character_id',
    '_kn_hash_css_cursor',
    '_kn_hash_css_selected',
    '_kn_hash_rng',
    '_kn_hash_match_phase',
    '_kn_hash_vs_battle_hdr',
    '_kn_hash_physics_motion',
    '_kn_hash_ft_buffer',
    '_kn_get_pre_replay_hash',
    '_kn_get_post_replay_hash',
    '_kn_get_last_replay_target_frame',
    '_kn_get_last_replay_final_frame',
    '_kn_get_replay_frame_hash',
    '_kn_get_last_replay_length',
  ];

  function _log(msg) {
    try {
      console.log(`[KNDesync] ${msg}`);
      if (typeof window._knSyncLog === 'function') window._knSyncLog(`KNDesync ${msg}`);
    } catch (_) {}
  }

  function _hasRequiredExports(m) {
    if (!m) return false;
    const missing = REQUIRED_EXPORTS.filter((name) => typeof m[name] !== 'function');
    if (missing.length === 0) return true;
    if (!_missingExportsLogged) {
      _missingExportsLogged = true;
      _log(`disabled: core missing exports ${missing.join(',')}`);
    }
    return false;
  }

  function _readFieldHash(fid, frame) {
    const m = _module;
    switch (fid) {
      case FIELD.STOCKS_P0:
      case FIELD.STOCKS_P1:
      case FIELD.STOCKS_P2:
      case FIELD.STOCKS_P3:
        return m._kn_hash_stocks(fid - FIELD.STOCKS_P0, frame) >>> 0;
      case FIELD.CHARACTER_ID_P0:
      case FIELD.CHARACTER_ID_P1:
      case FIELD.CHARACTER_ID_P2:
      case FIELD.CHARACTER_ID_P3:
        return m._kn_hash_character_id(fid - FIELD.CHARACTER_ID_P0, frame) >>> 0;
      case FIELD.CSS_CURSOR_P0:
      case FIELD.CSS_CURSOR_P1:
      case FIELD.CSS_CURSOR_P2:
      case FIELD.CSS_CURSOR_P3:
        return m._kn_hash_css_cursor(fid - FIELD.CSS_CURSOR_P0, frame) >>> 0;
      case FIELD.CSS_SELECTED_P0:
      case FIELD.CSS_SELECTED_P1:
      case FIELD.CSS_SELECTED_P2:
      case FIELD.CSS_SELECTED_P3:
        return m._kn_hash_css_selected(fid - FIELD.CSS_SELECTED_P0, frame) >>> 0;
      case FIELD.RNG:
        return m._kn_hash_rng(frame) >>> 0;
      case FIELD.MATCH_PHASE:
        return m._kn_hash_match_phase(frame) >>> 0;
      case FIELD.VS_BATTLE_HDR:
        return m._kn_hash_vs_battle_hdr(frame) >>> 0;
      case FIELD.PHYSICS_MOTION:
        return m._kn_hash_physics_motion(frame) >>> 0;
      case FIELD.FT_BUFFER:
        return m._kn_hash_ft_buffer(frame) >>> 0;
      default:
        return 0;
    }
  }

  function _buildReplayMeta() {
    const m = _module;
    const replayStart = m._kn_get_last_replay_target_frame() | 0;
    const replayFinal = m._kn_get_last_replay_final_frame() | 0;
    if (replayStart < 0 || replayFinal < 0) return null;

    const pre = new Array(FIELD.COUNT);
    const post = new Array(FIELD.COUNT);
    for (let f = 0; f < FIELD.COUNT; f++) {
      pre[f] = m._kn_get_pre_replay_hash(f) >>> 0;
      post[f] = m._kn_get_post_replay_hash(f) >>> 0;
    }

    const length = m._kn_get_last_replay_length() | 0;
    return {
      target: replayStart,
      final: replayFinal,
      length,
      pre,
      post,
      // Always null now. It was the first replay frame whose hash differed
      // from the forward pass, read from the history rings; a replay now
      // rewrites those entries (they must hold the confirmed hash), so the
      // forward pass's value is no longer kept. The key stays for the
      // server and for peers that decode it.
      firstTrajectoryDivergence: null,
    };
  }

  function _buildLocalDigest(frame) {
    if (!_hasRequiredExports(_module)) return null;
    const hashes = new Array(FIELD.COUNT);
    for (let f = 0; f < FIELD.COUNT; f++) hashes[f] = _readFieldHash(f, frame);
    return { frame, hashes, replayMeta: _buildReplayMeta() };
  }
  function _broadcastDigest(digest) {
    const peers = window._peers || (window.KNState && KNState.peers) || {};
    const packet = JSON.stringify({ type: 'digest', ...digest });
    for (const sid of Object.keys(peers)) {
      const peer = peers[sid];
      if (!peer || !peer.dc || peer.dc.readyState !== 'open') continue;
      try {
        peer.dc.send(packet);
      } catch (e) {
        console.warn('[KNDesync] broadcast send failed for', sid, e);
      }
    }
  }

  function _trimDigestMap(map, dropFloor) {
    for (const f of map.keys()) {
      if (f < dropFloor) map.delete(f);
    }
  }

  function _comparePeerDigestToLocal(peerId, digest) {
    const localDigest = _localDigests.get(digest.frame);
    if (!localDigest) return;
    if (_mode === 'B') {
      _diffDigests({ peerId: 'local', digest: localDigest }, { peerId, digest });
    } else if (window.KNState && KNState.isLocalHost) {
      _diffDigests({ peerId: 'host', digest: localDigest }, { peerId, digest });
    } else if (window.KNState && KNState.peers?.[peerId]?.slot === 0) {
      _diffDigests({ peerId, digest }, { peerId: 'local', digest: localDigest });
    }
  }

  function _ingestPeerDigest(peerId, payload) {
    if (!payload || typeof payload.frame !== 'number') return;
    if (!Array.isArray(payload.hashes) || !_hasHistory(payload.hashes)) return;
    const dropFloor = _localFrameTick - _confirmWindow - CONFIG.historyDepth;
    if (payload.frame < dropFloor) return;
    let perPeer = _peerDigests.get(peerId);
    if (!perPeer) {
      perPeer = new Map();
      _peerDigests.set(peerId, perPeer);
    }
    perPeer.set(payload.frame, payload);
    _trimDigestMap(perPeer, dropFloor);
    _comparePeerDigestToLocal(peerId, payload);
  }
  function _compareAtFrame(localDigest) {
    const frame = localDigest.frame;
    const peerHits = [];
    for (const [peerId, perPeer] of _peerDigests) {
      const d = perPeer.get(frame);
      if (d) peerHits.push({ peerId, digest: d });
    }
    if (peerHits.length === 0) return;
    if (_mode === 'B') _comparePairwise(localDigest, peerHits);
    else _compareHostAuth(localDigest, peerHits);
  }

  function _comparePairwise(local, peerHits) {
    const all = [{ peerId: 'local', digest: local }, ...peerHits];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        _diffDigests(all[i], all[j]);
      }
    }
  }

  function _compareHostAuth(local, peerHits) {
    if (window.KNState && KNState.isLocalHost) {
      for (const guest of peerHits) {
        _diffDigests({ peerId: 'host', digest: local }, guest);
      }
    } else {
      const host = peerHits.find((p) => window.KNState && KNState.peers?.[p.peerId]?.slot === 0);
      if (host) {
        _diffDigests(host, { peerId: 'local', digest: local });
      }
    }
  }

  const _FIELD_NAMES = [
    'stocks',
    'stocks',
    'stocks',
    'stocks',
    'character_id',
    'character_id',
    'character_id',
    'character_id',
    'css_cursor',
    'css_cursor',
    'css_cursor',
    'css_cursor',
    'css_selected',
    'css_selected',
    'css_selected',
    'css_selected',
    'rng',
    'match_phase',
    'vs_battle_hdr',
    'physics_motion',
    'ft_buffer',
  ];

  function _slotForField(fid) {
    if (fid <= FIELD.STOCKS_P3) return fid - FIELD.STOCKS_P0;
    if (fid <= FIELD.CHARACTER_ID_P3) return fid - FIELD.CHARACTER_ID_P0;
    if (fid <= FIELD.CSS_CURSOR_P3) return fid - FIELD.CSS_CURSOR_P0;
    if (fid <= FIELD.CSS_SELECTED_P3) return fid - FIELD.CSS_SELECTED_P0;
    return null;
  }

  const SCENE = {
    IN_GAME_VS: 22, // nSCKindVSBattle
    CSS_VS: 16, // nSCKindPlayersVS
    STAGE_SELECT: 21, // nSCKindMaps
  };
  const IN_GAME_SCENES = new Set([SCENE.IN_GAME_VS]);
  const CSS_PHASE_SCENES = new Set([SCENE.CSS_VS]);

  // The scene a digest's frame was in, from its match_phase hash (FNV-1a of
  // the one scene byte). A digest is for a frame a rollback window old, so
  // the live scene can already be the next one; gating on that dropped the
  // character-select fields from the last digests of the character select.
  // -1 when the hash is of no scene byte (0 = the registry had no entry).
  const _SCENE_BY_HASH = new Map();
  for (let scene = 0; scene < 256; scene++) {
    _SCENE_BY_HASH.set(Math.imul(0x811c9dc5 ^ scene, 0x01000193) >>> 0, scene);
  }
  // Whether the registry had an entry for the digest's frame. It returns 0
  // for a frame this emulator never simulated: after a late join or a
  // resync loads the host's state at frame F, the frames a rollback window
  // before F were never run here. FNV-1a of one byte is never 0, so a zero
  // match_phase hash means "no entry", not a scene; such a digest is neither
  // sent nor compared.
  function _hasHistory(hashes) {
    return hashes[FIELD.MATCH_PHASE] >>> 0 !== 0;
  }
  function _sceneOfDigest(hashes) {
    return _SCENE_BY_HASH.get(hashes[FIELD.MATCH_PHASE] >>> 0) ?? -1;
  }

  function _fieldEligibleInPhase(fid, phase) {
    const inGame = IN_GAME_SCENES.has(phase);
    const cssPhase = CSS_PHASE_SCENES.has(phase);
    switch (fid) {
      case FIELD.STOCKS_P0:
      case FIELD.STOCKS_P1:
      case FIELD.STOCKS_P2:
      case FIELD.STOCKS_P3:
      case FIELD.VS_BATTLE_HDR:
      case FIELD.PHYSICS_MOTION:
      case FIELD.FT_BUFFER:
        return inGame;
      case FIELD.CSS_CURSOR_P0:
      case FIELD.CSS_CURSOR_P1:
      case FIELD.CSS_CURSOR_P2:
      case FIELD.CSS_CURSOR_P3:
      case FIELD.CSS_SELECTED_P0:
      case FIELD.CSS_SELECTED_P1:
      case FIELD.CSS_SELECTED_P2:
      case FIELD.CSS_SELECTED_P3:
        return cssPhase;
      default:
        return true;
    }
  }

  // The field ids to flag for one pair of digests. The decision is
  // KNCore.desyncFieldsToFlag (web/src/desync-fields.ts), which is proved
  // never to flag a field whose hashes are equal. The code below it is the
  // same rule, used if the bundle did not load or a peer sent a digest
  // that is not a full array of hashes.
  function _fieldsToFlag(ha, hb, frame) {
    // The scene the digest's frame was in, not the live one: a digest is a
    // rollback window old. When the two match_phase hashes differ, that
    // alone is flagged and the scene is not used.
    const phase = _sceneOfDigest(ha);
    const decide = window.KNCore?.desyncFieldsToFlag;
    if (decide && Array.isArray(ha) && Array.isArray(hb) && ha.length >= FIELD.COUNT && hb.length >= FIELD.COUNT) {
      const lastFlagged = [];
      for (let fid = 0; fid < FIELD.COUNT; fid++) {
        lastFlagged.push(_lastFlagFrame.get(_dedupKey(fid)) ?? -1);
      }
      return decide(ha, hb, phase, frame, lastFlagged, CONFIG.dedupWindowFrames);
    }

    // GATING RULE: phase mismatch is itself the high-priority flag and
    // suppresses other field comparisons for this frame.
    if (ha[FIELD.MATCH_PHASE] !== hb[FIELD.MATCH_PHASE]) return [FIELD.MATCH_PHASE];
    const flagged = [];
    for (let fid = 0; fid < FIELD.COUNT; fid++) {
      if (fid === FIELD.MATCH_PHASE) continue;
      if (ha[fid] === hb[fid]) continue;
      if (!_fieldEligibleInPhase(fid, phase)) continue;
      const lastFlagged = _lastFlagFrame.get(_dedupKey(fid)) ?? -1;
      if (frame - lastFlagged < CONFIG.dedupWindowFrames) continue;
      flagged.push(fid);
    }
    return flagged;
  }

  function _dedupKey(fid) {
    return `${fid}:${_slotForField(fid) ?? 'g'}`;
  }

  function _diffDigests(a, b) {
    const ha = a.digest.hashes;
    const hb = b.digest.hashes;

    for (const fid of _fieldsToFlag(ha, hb, a.digest.frame)) {
      if (fid === FIELD.MATCH_PHASE) {
        _emitSuspect({
          frame: a.digest.frame,
          field: 'match_phase',
          slot: null,
          hashes: { [a.peerId]: ha[FIELD.MATCH_PHASE], [b.peerId]: hb[FIELD.MATCH_PHASE] },
          trigger: 'flag',
          severity: 'high',
          replayMeta: null,
        });
        continue;
      }
      _lastFlagFrame.set(_dedupKey(fid), a.digest.frame);
      _emitSuspect({
        frame: a.digest.frame,
        field: _FIELD_NAMES[fid],
        slot: _slotForField(fid),
        hashes: { [a.peerId]: ha[fid], [b.peerId]: hb[fid] },
        trigger: 'flag',
        replayMeta: a.digest.replayMeta || b.digest.replayMeta || null,
      });
    }
  }
  function _emitSuspect(payload) {
    payload.matchId = window.KNState && KNState.matchId;
    payload.matchPhase = _module && _module._kn_get_scene_curr ? _module._kn_get_scene_curr() : 0;
    _log(
      `suspect frame=${payload.frame} field=${payload.field}` +
        ` slot=${payload.slot ?? 'g'} trigger=${payload.trigger} phase=${payload.matchPhase}`,
    );
    _events.dispatchEvent(new CustomEvent('desync-suspect', { detail: payload }));
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    if (_mode !== 'B') return;
    _heartbeatTimerId = setInterval(() => {
      if (!_enabled || !_module) return;
      _emitSuspect({
        frame: _localFrameTick,
        field: 'heartbeat',
        slot: null,
        hashes: null,
        trigger: 'heartbeat',
        scope: ['damage', 'stocks', 'position', 'css_cursor'],
        replayMeta: null,
      });
    }, CONFIG.heartbeatIntervalMs);
  }

  function _stopHeartbeat() {
    if (_heartbeatTimerId !== null) {
      clearInterval(_heartbeatTimerId);
      _heartbeatTimerId = null;
    }
  }

  const KNDesync = {
    init(emModule, mode = 'B') {
      _module = emModule;
      _mode = mode;
      _enabled = _hasRequiredExports(emModule);
      _peerDigests.clear();
      _localDigests.clear();
      _lastFlagFrame.clear();
      _noDecisionLogged = false;
      _log(`init mode=${mode}`);
      if (!_enabled) {
        _stopHeartbeat();
        return;
      }
      if (_mode === 'B') _startHeartbeat();
    },

    // The engine's rollback window in frames, set once it is known
    // (kn_rollback_init). 0, the default, is right for strict lockstep,
    // where no frame is simulated on a predicted input.
    setConfirmWindow(frames) {
      const n = Number.isInteger(frames) && frames > 0 ? frames : 0;
      if (n === _confirmWindow) return;
      _confirmWindow = n;
      _log(`confirm window=${n}`);
    },

    setMode(mode) {
      _mode = mode;
      if (mode === 'B') _startHeartbeat();
      else _stopHeartbeat();
    },

    // Stop the heartbeat and clear cross-game caches. Callers (lockstep stop)
    // must invoke this; otherwise the setInterval keeps firing into the next
    // session and _peerDigests/_localDigests carry stale frame state.
    stop() {
      _stopHeartbeat();
      _enabled = false;
      _module = null;
      _confirmWindow = 0;
      _peerDigests.clear();
      _localDigests.clear();
      _lastFlagFrame.clear();
    },

    tick(frame) {
      if (!_module) return;
      if (!_enabled) {
        _enabled = _hasRequiredExports(_module);
        if (!_enabled) return;
      }
      _localFrameTick = frame;
      // Skip the expensive digest build when there is no real peer to
      // detect divergence with. _buildLocalDigest does 21 field hashes plus
      // _buildReplayMeta's 42 pre/post hashes plus up to 64×21×2 trajectory
      // hashes — ~3-9 ms per tick on mobile, every tick. In the demo with a
      // synthetic peer (in-process, no DataChannel) and in solo / spectator
      // modes, all of that work is wasted: synthetic peers never broadcast
      // digests back, _compareAtFrame has nothing to compare against, and
      // _broadcastDigest's loop sees no open DataChannels.
      // This skip is safe: when a real peer joins later, _peerDigests is
      // empty (we never received any) and _localDigests is empty (we never
      // built any) — same starting state as a fresh connection.
      const peers = window._peers || (window.KNState && window.KNState.peers) || {};
      let _hasRealPeer = false;
      for (const sid of Object.keys(peers)) {
        const p = peers[sid];
        if (!p || p.synthetic === true) continue;
        if (p.dc && p.dc.readyState === 'open') {
          _hasRealPeer = true;
          break;
        }
      }
      // Diagnostic: ?forceDesyncTick=1 forces the digest-build path to run
      // even with a synthetic peer, so the demo can measure the per-tick
      // build cost (with simulated RTT via KNFakePeer.setNetwork) without
      // needing a two-tab real-WebRTC harness. Broadcasts go to a
      // no-op DC and comparisons run against an empty peer-digest map;
      // the work is what we're measuring.
      if (!_hasRealPeer && !window.__knForceDesyncTick) return;
      // Which frame to report, if any: KNCore.digestFrame
      // (web/src/desync-confirm.ts). It is the frame one rollback window
      // behind this tick, on the broadcast cadence (mode B = every frame;
      // mode C = every 6th). The newest frame ran on predicted inputs and
      // may still be replayed, so two healthy peers can hold different
      // hashes for it; the frame a window back is final, and the registry
      // rewrites a frame's history when a replay re-simulates it
      // (specs/desync_digest.qnt). Building on the cadence only also keeps
      // the cost down: a digest between cadence frames had nothing to
      // compare against.
      //
      // A replay's own trajectory is not flagged. The forward pass ran on a
      // mispredicted input, so the replay differing from it is what a
      // rollback is for; flagging it raised a `suspect` (and a canvas
      // capture in kn-vision-client.js) on healthy matches. The first
      // divergence still travels in replayMeta with a cross-peer flag.
      const decide = window.KNCore?.digestFrame;
      if (typeof decide !== 'function') {
        if (!_noDecisionLogged) {
          _noDecisionLogged = true;
          _log('no digests: KNCore.digestFrame is not loaded');
        }
        return;
      }
      const replayActive = typeof _module._kn_get_replay_depth === 'function' && _module._kn_get_replay_depth() > 0;
      if (replayActive) return;
      const digestFor = decide(frame, _confirmWindow, CONFIG.digestCadence[_mode]);
      if (digestFor < 0) return;

      const localDigest = _buildLocalDigest(digestFor);
      if (!localDigest || !_hasHistory(localDigest.hashes)) return;
      _localDigests.set(digestFor, localDigest);
      _trimDigestMap(_localDigests, digestFor - CONFIG.historyDepth);
      _compareAtFrame(localDigest);
      _broadcastDigest(localDigest);
    },

    onPeerDigest(peerId, payload) {
      _ingestPeerDigest(peerId, payload);
    },

    events: _events,
    _testHooks: {
      CONFIG,
      FIELD,
      peerDigests: _peerDigests,
      localDigests: _localDigests,
      lastFlagFrame: _lastFlagFrame,
    },
  };

  window.KNDesync = KNDesync;
})();
