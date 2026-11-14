/**
 * WebRTC peer helpers: RTCPeerConnection creation, ICE candidate buffering
 * and the offer/answer exchange. Both engines use them, so the same WebRTC
 * plumbing is not written twice.
 */
import { clientEvent } from './client-event.ts';
import { page } from './shared-globals.ts';

/** The Socket.IO client, as far as these helpers use it. */
export interface SignalSocket {
  emit: (event: 'webrtc-signal', payload: SignalPayload) => void;
}

interface SignalPayload {
  target: string;
  candidate?: RTCIceCandidate;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
}

/** The part of a peer that candidate buffering keeps. The engines add their own fields. */
export interface BufferingPeer {
  pc: RTCPeerConnection;
  pendingCandidates?: RTCIceCandidateInit[];
  remoteDescSet?: boolean;
}

/** A peer as `createBasePeer` starts it. */
export interface BasePeer extends BufferingPeer {
  dc: RTCDataChannel | null;
  slot: number | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
}

/** Called before a candidate is sent; false if the peer has been replaced or removed. */
type PeerGuard<P> = (peer: P) => boolean;

// Build the RTCConfiguration for a new peer connection. Spectators force
// iceTransportPolicy: 'relay' so their public IP isn't exposed to other
// peers via ICE candidates — all traffic runs through the TURN server.
// Players still rely on STUN-discovered host candidates for the lower-
// latency P2P path needed for input exchange.
const buildRtcConfig = (iceServers: RTCIceServer[]): RTCConfiguration => {
  const cfg: RTCConfiguration = { iceServers };
  if (page()._isSpectator === true) {
    cfg.iceTransportPolicy = 'relay';
  }
  return cfg;
};

// Drain buffered ICE candidates after setting remote description.
// Shared by lockstep and streaming WebRTC signal handlers.
export async function drainCandidates(peer: BufferingPeer): Promise<void> {
  peer.remoteDescSet = true;
  if (peer.pendingCandidates && peer.pendingCandidates.length) {
    // Swap to a temp array before iterating — candidates arriving during
    // the async addIceCandidate calls go into the fresh empty array
    // instead of being lost when we clear pendingCandidates.
    const batch = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of batch) {
      try {
        await peer.pc.addIceCandidate(c);
      } catch {}
    }
  }
}

// Create a base peer object with RTCPeerConnection and ICE candidate relay.
//   iceServers:  array of ICE server configs
//   remoteSid:   socket ID of the remote peer
//   socket:      Socket.IO client instance for emitting signals
//   peerGuard:   () => boolean, called before emitting candidates;
//                returns false if the peer has been replaced/removed
export const createBasePeer = (
  iceServers: RTCIceServer[],
  remoteSid: string,
  socket: SignalSocket,
  peerGuard?: PeerGuard<BasePeer>,
): BasePeer => {
  const peer: BasePeer = {
    pc: new RTCPeerConnection(buildRtcConfig(iceServers)),
    dc: null,
    slot: null,
    pendingCandidates: [],
    remoteDescSet: false,
  };
  peer.pc.onicecandidate = (e) => {
    if (e.candidate && (!peerGuard || peerGuard(peer))) {
      socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
    }
  };
  return peer;
};

// Buffer or immediately add an ICE candidate depending on whether the
// remote description has been set yet.
export const addBufferedCandidate = async (peer: BufferingPeer, candidate: RTCIceCandidateInit): Promise<void> => {
  if (peer.remoteDescSet) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (e) {
      clientEvent('webrtc-fail', 'ICE candidate add failed', { error: e instanceof Error ? e.message : undefined });
    }
  } else {
    if (!peer.pendingCandidates) peer.pendingCandidates = [];
    peer.pendingCandidates.push(candidate);
  }
};

// Create an offer, set local description, and emit via socket.
// Returns the offer for callers that need to inspect/modify it.
export const createAndSendOffer = async (
  pc: RTCPeerConnection,
  socket: SignalSocket,
  targetSid: string,
): Promise<RTCSessionDescriptionInit> => {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-signal', { target: targetSid, offer });
  return offer;
};

// Create an answer, set local description, and emit via socket.
export const createAndSendAnswer = async (
  pc: RTCPeerConnection,
  socket: SignalSocket,
  targetSid: string,
): Promise<void> => {
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-signal', { target: targetSid, answer });
};

// Detach handlers from an existing RTCPeerConnection, close it, and
// create a fresh one with ICE candidate relay on the same peer object.
// Used by lockstep reconnect flows that need to replace the PC while
// preserving the peer's slot, input state, etc.
export const resetPeerConnection = <P extends BufferingPeer>(
  peer: P,
  iceServers: RTCIceServer[],
  remoteSid: string,
  socket: SignalSocket,
  peerGuard?: PeerGuard<P>,
): void => {
  if (peer.pc) {
    peer.pc.onconnectionstatechange = null;
    peer.pc.ondatachannel = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    try {
      peer.pc.close();
    } catch {}
  }
  peer.pc = new RTCPeerConnection(buildRtcConfig(iceServers));
  peer.pendingCandidates = [];
  peer.remoteDescSet = false;
  peer.pc.onicecandidate = (e) => {
    if (e.candidate && (!peerGuard || peerGuard(peer))) {
      socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
    }
  };
};
