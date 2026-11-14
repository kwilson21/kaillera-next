/**
 * `window.KNDesync`: cross-peer, field-granular desync detection.
 *
 * Each peer computes per-frame field hashes through the core's
 * kn_hash_registry exports, broadcasts a digest over the WebRTC DataChannel
 * and compares it with the peers' digests for the same frame. A mismatch
 * emits `desync-suspect` on `KNDesync.events`, and `desync-capture` once the
 * frame both peers screenshot has been reached; kn-vision-client.js acts on
 * the latter.
 *
 * The decisions are elsewhere and proved: which fields to flag
 * (desync-fields.ts), which frame a digest is built for (desync-confirm.ts)
 * and which frame is screenshotted (desync-capture.ts). A peer's digest is
 * decoded with desync-digest.ts before anything reads it.
 *
 * Spec: docs/superpowers/specs/2026-04-25-desync-detection-design.md
 */
import type { PackedRomAddresses, SceneIds } from '../address-maps.ts';
import { captureFrame } from '../desync-capture.ts';
import { digestFrame } from '../desync-confirm.ts';
import { decodeDesyncDigest, type DesyncDigest } from '../desync-digest.ts';
import {
  FIELD_COUNT,
  MATCH_PHASE_FIELD,
  SCENE_CSS_VS,
  SCENE_IN_GAME_VS,
  fieldName,
  fieldsToFlag,
  slotForField,
} from '../desync-fields.ts';

/* ── Configuration ───────────────────────────────────────────── */
const CONFIG = {
  digestCadence: { B: 1, C: 6 }, // frames between broadcasts
  heartbeatEveryFrames: 300, // B-mode only
  dedupWindowFrames: 60, // per (field, slot) flag dedup
  historyDepth: 60,
  visionConfidenceMin: 'med',
  // A screenshot for a flagged frame F is taken at frame F + this, on
  // every peer. It has to be past the tick at which the slowest peer
  // learns of F: one rollback window after F plus the digest's trip.
  captureLeadFrames: 90,
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
  MATCH_PHASE: MATCH_PHASE_FIELD,
  VS_BATTLE_HDR: 18,
  PHYSICS_MOTION: 19,
  FT_BUFFER: 20,
  COUNT: FIELD_COUNT,
});

type FrameHash = (frame: number) => number;
type SlotFrameHash = (slot: number, frame: number) => number;
type FieldValue = (fid: number) => number;
type Counter = () => number;

/** The core exports the detector cannot run without (tests/test_core_desync_exports.py reads this list). */
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
] satisfies (keyof RequiredExports)[];

interface RequiredExports {
  _kn_hash_stocks: SlotFrameHash;
  _kn_hash_character_id: SlotFrameHash;
  _kn_hash_css_cursor: SlotFrameHash;
  _kn_hash_css_selected: SlotFrameHash;
  _kn_hash_rng: FrameHash;
  _kn_hash_match_phase: FrameHash;
  _kn_hash_vs_battle_hdr: FrameHash;
  _kn_hash_physics_motion: FrameHash;
  _kn_hash_ft_buffer: FrameHash;
  _kn_get_pre_replay_hash: FieldValue;
  _kn_get_post_replay_hash: FieldValue;
  _kn_get_last_replay_target_frame: Counter;
  _kn_get_last_replay_final_frame: Counter;
  _kn_get_replay_frame_hash: SlotFrameHash;
  _kn_get_last_replay_length: Counter;
}

/** What the detector reads of the emulator's Emscripten module. A core built without the hash registry has none of it. */
export interface DetectorCore extends Partial<RequiredExports> {
  _kn_get_scene_curr?: Counter;
  _kn_get_replay_depth?: Counter;
  _kn_field_map_set?: (ptr: number, count: number) => number;
  _malloc?: (bytes: number) => number;
  _free?: (ptr: number) => void;
  HEAPU32?: { set: (values: readonly number[], offset: number) => void };
}
type ReadyCore = DetectorCore & RequiredExports;

/** A peer as the detector uses it: its slot and its data channel. */
export interface DetectorPeer {
  slot?: number | null;
  dc?: { readyState: string; send: (packet: string) => void } | null;
  /** A simulated peer (the demo page), with no real connection. */
  synthetic?: boolean;
}

/** The page globals the detector reads, each at the moment it needs it. */
export interface DetectorPage {
  KNState?: {
    matchId: string | null;
    isLocalHost: boolean;
    peers: Record<string, DetectorPeer>;
  };
  /** Takes the place of `KNState.peers` when set. */
  _peers?: Record<string, DetectorPeer>;
  /** The engine's sync log, while an engine is running. */
  _knSyncLog?: ((message: string) => void) | null;
  /** Set from `?forceDesyncTick=1`; see `installDesyncDetector`. */
  __knForceDesyncTick?: boolean;
}

/** The sender's last rollback replay, as it travels in a digest. */
type ReplayMeta = NonNullable<DesyncDigest['replayMeta']>;

/** One frame's field hashes, built here or received from a peer. */
interface Digest {
  readonly frame: number;
  readonly hashes: readonly number[];
  readonly replayMeta?: ReplayMeta | null | undefined;
}

interface PeerDigest {
  readonly peerId: string;
  readonly digest: Digest;
}

/** The `detail` of a `desync-suspect` and of a `desync-capture` event. */
export interface DesyncSuspect {
  frame: number;
  field: string;
  slot: number | null;
  /** The differing hash by peer id; null for a heartbeat. */
  hashes: Record<string, number | undefined> | null;
  trigger: 'flag' | 'heartbeat';
  severity?: 'high';
  scope?: string[];
  replayMeta: ReplayMeta | null;
  matchId?: string | null | undefined;
  matchPhase?: number;
  /** Set on `desync-capture`: the frame the screenshot is of. */
  captureFrame?: number;
}

/** What the engine passes as a peer's digest: whatever the peer sent. */
type ReceivedDigest = Parameters<typeof decodeDesyncDigest>[0];

// The scenes fields are gated on. They come with the ROM's address map
// (web/src/address-maps.ts); these are SSB64 US's, the registry's
// built-in map: nSCKindVSBattle and nSCKindPlayersVS.
const SSB64_SCENES: SceneIds = Object.freeze({
  characterSelect: SCENE_CSS_VS,
  stageSelect: 21,
  battle: SCENE_IN_GAME_VS,
});

// The scene a digest's frame was in, from its match_phase hash (FNV-1a of
// the one scene byte). A digest is for a frame a rollback window old, so
// the live scene can already be the next one; gating on that dropped the
// character-select fields from the last digests of the character select.
// -1 when the hash is of no scene byte (0 = the registry had no entry).
const SCENE_BY_HASH = new Map<number, number>();
for (let scene = 0; scene < 256; scene++) {
  SCENE_BY_HASH.set(Math.imul(0x811c9dc5 ^ scene, 0x01000193) >>> 0, scene);
}

// Whether the registry had an entry for the digest's frame. It returns 0
// for a frame this emulator never simulated: after a late join or a
// resync loads the host's state at frame F, the frames a rollback window
// before F were never run here. FNV-1a of one byte is never 0, so a zero
// match_phase hash means "no entry", not a scene; such a digest is neither
// sent nor compared.
const hasHistory = (hashes: readonly number[]): boolean => (hashes[FIELD.MATCH_PHASE] ?? 0) >>> 0 !== 0;
const sceneOfDigest = (hashes: readonly number[]): number =>
  SCENE_BY_HASH.get((hashes[FIELD.MATCH_PHASE] ?? 0) >>> 0) ?? -1;

const dedupKey = (fid: number): string => `${fid}:${slotForField(fid) ?? 'g'}`;

const trimDigestMap = (map: Map<number, Digest>, dropFloor: number): void => {
  for (const f of map.keys()) {
    if (f < dropFloor) map.delete(f);
  }
};

const cadenceOf = (mode: string): number =>
  mode === 'B' ? CONFIG.digestCadence.B : mode === 'C' ? CONFIG.digestCadence.C : Number.NaN;

/** Build the detector over the page it runs in. `installDesyncDetector` passes `window`. */
export const createDesyncDetector = (page: DetectorPage) => {
  /* ── State ───────────────────────────────────────────────────── */
  let mode = 'B';
  let enabled = false;
  let core: DetectorCore | null = null;
  const peerDigests = new Map<string, Map<number, Digest>>(); // peer_id → Map<frame, digest>
  const localDigests = new Map<number, Digest>(); // frame → digest
  let localFrameTick = 0;
  const lastFlagFrame = new Map<string, number>(); // "field:slot" → frame
  let heartbeatOn = false;
  let lastHeartbeatFrame = -1;
  let missingExportsLogged = false;
  // Frames the engine may still replay (its rollback window). A digest is
  // built for the frame this far behind the newest one; see tick().
  let confirmWindow = 0;
  let malformedDigestLogged = false;
  // Screenshots waiting for their frame: capture frame -> suspect payloads.
  const pendingCaptures = new Map<number, DesyncSuspect[]>();
  const events = new EventTarget();
  let scenes: SceneIds = SSB64_SCENES;

  const log = (msg: string): void => {
    try {
      console.log(`[KNDesync] ${msg}`);
      if (typeof page._knSyncLog === 'function') page._knSyncLog(`KNDesync ${msg}`);
    } catch {
      // A log line must never stop the tick.
    }
  };

  const hasRequiredExports = (m: DetectorCore | null): m is ReadyCore => {
    if (!m) return false;
    const missing = REQUIRED_EXPORTS.filter((name) => typeof m[name] !== 'function');
    if (missing.length === 0) return true;
    if (!missingExportsLogged) {
      missingExportsLogged = true;
      log(`disabled: core missing exports ${missing.join(',')}`);
    }
    return false;
  };

  // Hand the registry this ROM's addresses (kn_field_map_set). A core from
  // before the map was data has only the built-in SSB64 US map; that is
  // fine for SSB64 US and wrong for anything else.
  const installAddressMap = (m: DetectorCore, rom: PackedRomAddresses): boolean => {
    const values = rom.values;
    if (typeof m._kn_field_map_set !== 'function' || typeof m._malloc !== 'function') {
      if (rom.name === 'ssb64-us') return true;
      log(`disabled: this core cannot take the address map for ${rom.name}`);
      return false;
    }
    const ptr = m._malloc(values.length * 4);
    let accepted = false;
    try {
      m.HEAPU32?.set(values, ptr >>> 2);
      accepted = m._kn_field_map_set(ptr, values.length) === 1;
    } finally {
      m._free?.(ptr);
    }
    if (!accepted) {
      log(`disabled: the core refused the address map for ${rom.name}`);
      return false;
    }
    scenes = rom.scenes;
    log(`address map=${rom.name}`);
    return true;
  };

  const readFieldHash = (m: ReadyCore, fid: number, frame: number): number => {
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
  };

  const buildReplayMeta = (m: ReadyCore): ReplayMeta | null => {
    const replayStart = m._kn_get_last_replay_target_frame() | 0;
    const replayFinal = m._kn_get_last_replay_final_frame() | 0;
    if (replayStart < 0 || replayFinal < 0) return null;

    const pre: number[] = [];
    const post: number[] = [];
    for (let f = 0; f < FIELD.COUNT; f++) {
      pre.push(m._kn_get_pre_replay_hash(f) >>> 0);
      post.push(m._kn_get_post_replay_hash(f) >>> 0);
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
  };

  const buildLocalDigest = (frame: number): Digest | null => {
    const m = core;
    if (!hasRequiredExports(m)) return null;
    const hashes: number[] = [];
    for (let f = 0; f < FIELD.COUNT; f++) hashes.push(readFieldHash(m, f, frame));
    return { frame, hashes, replayMeta: buildReplayMeta(m) };
  };

  const currentPeers = (): Record<string, DetectorPeer> => page._peers || page.KNState?.peers || {};

  const broadcastDigest = (digest: Digest): void => {
    const peers = currentPeers();
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
  };

  const scheduleCapture = (payload: DesyncSuspect, lead: number): void => {
    const at = captureFrame(payload.frame, localFrameTick, lead);
    if (at < 0) {
      log(`capture skipped: suspect frame=${payload.frame} raised at tick=${localFrameTick}, past its capture frame`);
      return;
    }
    const waiting = pendingCaptures.get(at);
    if (waiting) waiting.push(payload);
    else pendingCaptures.set(at, [payload]);
    if (at === localFrameTick) dispatchCaptures(at);
  };

  // The peers' screenshots for a suspect are compared with each other, so
  // they must show the same frame. Each peer raises the suspect at a
  // different tick; both know its frame, so both capture at the same later
  // one (captureFrame, web/src/desync-capture.ts; specs/desync_capture.qnt).
  // A peer that hears of it after that frame takes no picture.
  // `desync-capture` is what kn-vision-client.js acts on.
  const dispatchCaptures = (frame: number): void => {
    if (pendingCaptures.size === 0) return;
    for (const [at, payloads] of pendingCaptures) {
      if (at > frame) continue;
      pendingCaptures.delete(at);
      if (at < frame) {
        // The frame counter jumped over it (a resync). A picture now would
        // not be of the agreed frame.
        log(`capture dropped: frame=${at} was never ticked (now ${frame})`);
        continue;
      }
      for (const payload of payloads) {
        payload.captureFrame = at;
        log(`capture frame=${at} suspect=${payload.frame} field=${payload.field} slot=${payload.slot ?? 'g'}`);
        events.dispatchEvent(new CustomEvent('desync-capture', { detail: payload }));
      }
    }
  };

  const emitSuspect = (payload: DesyncSuspect): void => {
    payload.matchId = page.KNState && page.KNState.matchId;
    payload.matchPhase = core && core._kn_get_scene_curr ? core._kn_get_scene_curr() : 0;
    log(
      `suspect frame=${payload.frame} field=${payload.field}` +
        ` slot=${payload.slot ?? 'g'} trigger=${payload.trigger} phase=${payload.matchPhase}`,
    );
    events.dispatchEvent(new CustomEvent('desync-suspect', { detail: payload }));
    scheduleCapture(payload, CONFIG.captureLeadFrames);
  };

  // The field ids to flag for one pair of digests: `fieldsToFlag`
  // (web/src/desync-fields.ts), which is proved never to flag a field whose
  // hashes are equal.
  const fieldsFor = (ha: readonly number[], hb: readonly number[], frame: number): number[] => {
    // The scene the digest's frame was in, not the live one: a digest is a
    // rollback window old. When the two match_phase hashes differ, that
    // alone is flagged and the scene is not used.
    const scene = sceneOfDigest(ha);
    // The rule gates on SSB64's scene ids. Another ROM's map names its own
    // battle and character-select scenes, so the digest's scene is put in
    // SSB64's terms first: one of those two, or neither.
    const phase = scene === scenes.battle ? SCENE_IN_GAME_VS : scene === scenes.characterSelect ? SCENE_CSS_VS : -1;
    const lastFlagged: number[] = [];
    for (let fid = 0; fid < FIELD.COUNT; fid++) {
      lastFlagged.push(lastFlagFrame.get(dedupKey(fid)) ?? -1);
    }
    return fieldsToFlag([...ha], [...hb], phase, frame, lastFlagged, CONFIG.dedupWindowFrames);
  };

  const diffDigests = (a: PeerDigest, b: PeerDigest): void => {
    const ha = a.digest.hashes;
    const hb = b.digest.hashes;

    for (const fid of fieldsFor(ha, hb, a.digest.frame)) {
      if (fid === FIELD.MATCH_PHASE) {
        emitSuspect({
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
      lastFlagFrame.set(dedupKey(fid), a.digest.frame);
      emitSuspect({
        frame: a.digest.frame,
        field: fieldName(fid),
        slot: slotForField(fid),
        hashes: { [a.peerId]: ha[fid], [b.peerId]: hb[fid] },
        trigger: 'flag',
        replayMeta: a.digest.replayMeta || b.digest.replayMeta || null,
      });
    }
  };

  const comparePeerDigestToLocal = (peerId: string, digest: Digest): void => {
    const localDigest = localDigests.get(digest.frame);
    if (!localDigest) return;
    if (mode === 'B') {
      diffDigests({ peerId: 'local', digest: localDigest }, { peerId, digest });
    } else if (page.KNState && page.KNState.isLocalHost) {
      diffDigests({ peerId: 'host', digest: localDigest }, { peerId, digest });
    } else if (page.KNState && page.KNState.peers?.[peerId]?.slot === 0) {
      diffDigests({ peerId, digest }, { peerId: 'local', digest: localDigest });
    }
  };

  // A peer's digest is JSON from another browser. It is decoded with
  // decodeDesyncDigest (web/src/desync-digest.ts, an Effect Schema) before
  // anything reads it; anything that does not fit is dropped.
  const ingestPeerDigest = (peerId: string, received: ReceivedDigest): void => {
    const payload = decodeDesyncDigest(received);
    if (!payload) {
      if (!malformedDigestLogged) {
        malformedDigestLogged = true;
        log(`dropped a malformed digest from ${peerId}`);
      }
      return;
    }
    // A digest for a frame the sender never simulated (see hasHistory).
    if (!hasHistory(payload.hashes)) return;
    const dropFloor = localFrameTick - confirmWindow - CONFIG.historyDepth;
    if (payload.frame < dropFloor) return;
    let perPeer = peerDigests.get(peerId);
    if (!perPeer) {
      perPeer = new Map();
      peerDigests.set(peerId, perPeer);
    }
    perPeer.set(payload.frame, payload);
    trimDigestMap(perPeer, dropFloor);
    comparePeerDigestToLocal(peerId, payload);
  };

  const comparePairwise = (local: Digest, peerHits: PeerDigest[]): void => {
    const all: PeerDigest[] = [{ peerId: 'local', digest: local }, ...peerHits];
    all.forEach((first, i) => {
      for (const second of all.slice(i + 1)) diffDigests(first, second);
    });
  };

  const compareHostAuth = (local: Digest, peerHits: PeerDigest[]): void => {
    if (page.KNState && page.KNState.isLocalHost) {
      for (const guest of peerHits) {
        diffDigests({ peerId: 'host', digest: local }, guest);
      }
    } else {
      const host = peerHits.find((p) => page.KNState && page.KNState.peers?.[p.peerId]?.slot === 0);
      if (host) {
        diffDigests(host, { peerId: 'local', digest: local });
      }
    }
  };

  const compareAtFrame = (localDigest: Digest): void => {
    const frame = localDigest.frame;
    const peerHits: PeerDigest[] = [];
    for (const [peerId, perPeer] of peerDigests) {
      const d = perPeer.get(frame);
      if (d) peerHits.push({ peerId, digest: d });
    }
    if (peerHits.length === 0) return;
    if (mode === 'B') comparePairwise(localDigest, peerHits);
    else compareHostAuth(localDigest, peerHits);
  };

  // Mode B's heartbeat: a screenshot from every peer at intervals, whether
  // or not a field has been flagged. It is driven by the frame count, not a
  // clock: each peer raises it on the same frames (every
  // CONFIG.heartbeatEveryFrames, five seconds at full speed), so the
  // pictures are of one frame and the server pairs them. A wall-clock timer
  // fired on a different frame on each peer, and could fire more than once
  // for the same frame when the game ran slow.
  const startHeartbeat = (): void => {
    heartbeatOn = mode === 'B';
    lastHeartbeatFrame = 0;
  };

  const heartbeatAt = (frame: number): void => {
    const payload: DesyncSuspect = {
      frame,
      field: 'heartbeat',
      slot: null,
      hashes: null,
      trigger: 'heartbeat',
      scope: ['damage', 'stocks', 'position', 'css_cursor'],
      replayMeta: null,
    };
    payload.matchId = page.KNState && page.KNState.matchId;
    log(`suspect frame=${frame} field=heartbeat slot=g trigger=heartbeat`);
    events.dispatchEvent(new CustomEvent('desync-suspect', { detail: payload }));
    scheduleCapture(payload, 0);
  };

  const stopHeartbeat = (): void => {
    heartbeatOn = false;
  };

  return {
    // `rom` is the ROM's addresses from KNCore.addressMapFor
    // ({name, values, scenes}); without it the registry's built-in map
    // (SSB64 US) is used as it stands.
    init(emModule: DetectorCore | null, newMode = 'B', rom: PackedRomAddresses | null = null): void {
      core = emModule;
      mode = newMode;
      enabled = hasRequiredExports(emModule);
      malformedDigestLogged = false;
      peerDigests.clear();
      localDigests.clear();
      lastFlagFrame.clear();
      pendingCaptures.clear();
      scenes = SSB64_SCENES;
      log(`init mode=${newMode}`);
      if (enabled && emModule && rom && !installAddressMap(emModule, rom)) {
        // Off for the whole match. tick() re-checks the exports of a
        // module it holds and would switch the detector back on, hashing
        // through whatever map the core was left with.
        enabled = false;
        core = null;
      }
      if (!enabled) {
        stopHeartbeat();
        return;
      }
      if (mode === 'B') startHeartbeat();
    },

    // The engine's rollback window in frames, set once it is known
    // (kn_rollback_init). 0, the default, is right for strict lockstep,
    // where no frame is simulated on a predicted input.
    setConfirmWindow(frames: number): void {
      const n = Number.isInteger(frames) && frames > 0 ? frames : 0;
      if (n === confirmWindow) return;
      confirmWindow = n;
      log(`confirm window=${n}`);
    },

    setMode(newMode: string): void {
      mode = newMode;
      if (newMode === 'B') startHeartbeat();
      else stopHeartbeat();
    },

    // Stop the heartbeat and clear cross-game caches. Callers (the engine's
    // stop) must invoke this; otherwise the digest maps carry stale frame
    // state into the next session.
    stop(): void {
      stopHeartbeat();
      enabled = false;
      core = null;
      confirmWindow = 0;
      pendingCaptures.clear();
      peerDigests.clear();
      localDigests.clear();
      lastFlagFrame.clear();
    },

    tick(frame: number): void {
      if (!core) return;
      if (!enabled) {
        enabled = hasRequiredExports(core);
        if (!enabled) return;
      }
      localFrameTick = frame;
      dispatchCaptures(frame);
      // Skip the expensive digest build when there is no real peer to
      // detect divergence with. buildLocalDigest does 21 field hashes plus
      // buildReplayMeta's 42 pre/post hashes, every tick. In the demo with a
      // synthetic peer (in-process, no DataChannel) and in solo / spectator
      // modes, all of that work is wasted: synthetic peers never broadcast
      // digests back, compareAtFrame has nothing to compare against, and
      // broadcastDigest's loop sees no open DataChannels.
      // This skip is safe: when a real peer joins later, peerDigests is
      // empty (we never received any) and localDigests is empty (we never
      // built any), the same starting state as a fresh connection.
      const peers = currentPeers();
      let hasRealPeer = false;
      for (const sid of Object.keys(peers)) {
        const p = peers[sid];
        if (!p || p.synthetic === true) continue;
        if (p.dc && p.dc.readyState === 'open') {
          hasRealPeer = true;
          break;
        }
      }
      // Diagnostic: ?forceDesyncTick=1 forces the digest-build path to run
      // even with a synthetic peer, so the demo can measure the per-tick
      // build cost (with simulated RTT via KNFakePeer.setNetwork) without
      // needing a two-tab real-WebRTC harness. Broadcasts go to a
      // no-op DC and comparisons run against an empty peer-digest map;
      // the work is what we're measuring.
      if (!hasRealPeer && !page.__knForceDesyncTick) return;
      // Once per frame number: a resync can rewind the counter over it.
      if (heartbeatOn && frame > lastHeartbeatFrame && frame % CONFIG.heartbeatEveryFrames === 0) {
        lastHeartbeatFrame = frame;
        heartbeatAt(frame);
      }
      // Which frame to report, if any: digestFrame
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
      const replayActive = typeof core._kn_get_replay_depth === 'function' && core._kn_get_replay_depth() > 0;
      if (replayActive) return;
      const digestFor = digestFrame(frame, confirmWindow, cadenceOf(mode));
      if (digestFor < 0) return;

      const localDigest = buildLocalDigest(digestFor);
      if (!localDigest || !hasHistory(localDigest.hashes)) return;
      localDigests.set(digestFor, localDigest);
      trimDigestMap(localDigests, digestFor - CONFIG.historyDepth);
      compareAtFrame(localDigest);
      broadcastDigest(localDigest);
    },

    onPeerDigest(peerId: string, payload: ReceivedDigest): void {
      ingestPeerDigest(peerId, payload);
    },

    events,
    _testHooks: {
      CONFIG,
      FIELD,
      peerDigests,
      localDigests,
      lastFlagFrame,
    },
  };
};

export type DesyncDetector = ReturnType<typeof createDesyncDetector>;

declare global {
  interface Window {
    KNDesync?: DesyncDetector;
  }
}

/**
 * Define `window.KNDesync`. Called once as the bundle loads.
 *
 * Also reads the diagnostic `?forceDesyncTick=1`, which makes the per-tick
 * digest build run even with only a synthetic peer, so the demo can measure
 * its cost under simulated network conditions. Real sessions never set it.
 */
export const installDesyncDetector = (): void => {
  // SAFETY: the detector's page globals are optional properties other scripts
  // set on `window` (the engine's `_knSyncLog`, `KNState.peers` with their
  // data channels); every one is checked where it is read.
  const page = window as Window & DetectorPage;
  try {
    const params = new URLSearchParams(window.location?.search || '');
    if (params.get('forceDesyncTick') === '1') page.__knForceDesyncTick = true;
  } catch {
    // No location to read (an embedded or sandboxed page): the flag stays off.
  }
  window.KNDesync = createDesyncDetector(page);
};
