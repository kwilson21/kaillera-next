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
  let _localFrameTick = 0;
  let _lastFlagFrame = new Map(); // "field:slot" → frame
  let _heartbeatTimerId = null;
  const _events = new EventTarget();

  /* (Helpers _buildLocalDigest, _broadcastDigest, etc. added in
   * subsequent tasks. The skeleton declares them as no-ops to keep
   * the public API stable across incremental commits.) */

  function _buildLocalDigest(frame) {
    const m = _module;
    if (!m) return null;
    const hashes = new Array(FIELD.COUNT);
    for (let p = 0; p < 4; p++) {
      hashes[FIELD.STOCKS_P0 + p] = m._kn_hash_stocks(p, -1) >>> 0;
      hashes[FIELD.CHARACTER_ID_P0 + p] = m._kn_hash_character_id(p, -1) >>> 0;
      hashes[FIELD.CSS_CURSOR_P0 + p] = m._kn_hash_css_cursor(p, -1) >>> 0;
      hashes[FIELD.CSS_SELECTED_P0 + p] = m._kn_hash_css_selected(p, -1) >>> 0;
    }
    hashes[FIELD.RNG] = m._kn_hash_rng(-1) >>> 0;
    hashes[FIELD.MATCH_PHASE] = m._kn_hash_match_phase(-1) >>> 0;
    hashes[FIELD.VS_BATTLE_HDR] = m._kn_hash_vs_battle_hdr(-1) >>> 0;
    hashes[FIELD.PHYSICS_MOTION] = m._kn_hash_physics_motion(-1) >>> 0;
    hashes[FIELD.FT_BUFFER] = m._kn_hash_ft_buffer(-1) >>> 0;

    const replayTarget = m._kn_get_last_replay_target_frame() | 0;
    const replayFinal = m._kn_get_last_replay_final_frame() | 0;
    let replayMeta = null;
    if (replayTarget >= 0 && replayFinal >= 0) {
      const pre = new Array(FIELD.COUNT);
      const post = new Array(FIELD.COUNT);
      for (let f = 0; f < FIELD.COUNT; f++) {
        pre[f] = m._kn_get_pre_replay_hash(f) >>> 0;
        post[f] = m._kn_get_post_replay_hash(f) >>> 0;
      }
      replayMeta = {
        target: replayTarget,
        final: replayFinal,
        length: m._kn_get_last_replay_length() | 0,
        pre,
        post,
      };
    }

    return { frame, hashes, replayMeta };
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

  function _ingestPeerDigest(peerId, payload) {
    if (!payload || typeof payload.frame !== 'number') return;
    const dropFloor = _localFrameTick - CONFIG.historyDepth;
    if (payload.frame < dropFloor) return;
    let perPeer = _peerDigests.get(peerId);
    if (!perPeer) {
      perPeer = new Map();
      _peerDigests.set(peerId, perPeer);
    }
    perPeer.set(payload.frame, payload);
    for (const f of perPeer.keys()) {
      if (f < dropFloor) perPeer.delete(f);
    }
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
    IN_GAME_VS: 0x07, // verified empirically: in-game-mid-match.rdram fixture
    // CSS_VS, STAGE_SELECT, RESULTS — TBD per fixture capture
  };
  const IN_GAME_SCENES = new Set([SCENE.IN_GAME_VS]);
  const CSS_PHASE_SCENES = new Set(); // populated when CSS scene byte captured

  function _readScenePhase() {
    return _module && _module._kn_get_scene_curr ? _module._kn_get_scene_curr() : 0;
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

  function _diffDigests(a, b) {
    const ha = a.digest.hashes;
    const hb = b.digest.hashes;

    // GATING RULE: phase mismatch is itself the high-priority flag and
    // suppresses other field comparisons for this frame.
    if (ha[FIELD.MATCH_PHASE] !== hb[FIELD.MATCH_PHASE]) {
      _emitSuspect({
        frame: a.digest.frame,
        field: 'match_phase',
        slot: null,
        hashes: { [a.peerId]: ha[FIELD.MATCH_PHASE], [b.peerId]: hb[FIELD.MATCH_PHASE] },
        trigger: 'flag',
        severity: 'high',
        replayMeta: null,
      });
      return;
    }

    const phase = _readScenePhase();
    for (let fid = 0; fid < FIELD.COUNT; fid++) {
      if (fid === FIELD.MATCH_PHASE) continue;
      if (ha[fid] === hb[fid]) continue;
      if (!_fieldEligibleInPhase(fid, phase)) continue;

      const slot = _slotForField(fid);
      const dedupKey = `${fid}:${slot ?? 'g'}`;
      const lastFlagged = _lastFlagFrame.get(dedupKey) ?? -1;
      if (a.digest.frame - lastFlagged < CONFIG.dedupWindowFrames) continue;
      _lastFlagFrame.set(dedupKey, a.digest.frame);

      _emitSuspect({
        frame: a.digest.frame,
        field: _FIELD_NAMES[fid],
        slot,
        hashes: { [a.peerId]: ha[fid], [b.peerId]: hb[fid] },
        trigger: 'flag',
        replayMeta: a.digest.replayMeta || b.digest.replayMeta || null,
      });
    }
  }
  function _emitSuspect(payload) {
    payload.matchId = window.KNState && KNState.matchId;
    payload.matchPhase = _module && _module._kn_get_scene_curr ? _module._kn_get_scene_curr() : 0;
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
      _enabled = true;
      _peerDigests.clear();
      _lastFlagFrame.clear();
      console.log(`[KNDesync] init mode=${mode}`);
      if (_mode === 'B') _startHeartbeat();
    },

    setMode(mode) {
      _mode = mode;
      if (mode === 'B') _startHeartbeat();
      else _stopHeartbeat();
    },

    tick(frame) {
      if (!_enabled || !_module) return;
      _localFrameTick = frame;
      const localDigest = _buildLocalDigest(frame);
      if (!localDigest) return;
      _compareAtFrame(localDigest);
      const cadence = CONFIG.digestCadence[_mode];
      if (frame % cadence === 0) _broadcastDigest(localDigest);
    },

    onPeerDigest(peerId, payload) {
      _ingestPeerDigest(peerId, payload);
    },

    events: _events,
    _testHooks: { CONFIG, FIELD, peerDigests: _peerDigests, lastFlagFrame: _lastFlagFrame },
  };

  window.KNDesync = KNDesync;
})();
