import type { WirePayload } from './wire.ts';
import type { Relayed } from './relay.ts';
import { acceptReply, type Generation, type Input, type Sample, openProof, sameOwner } from './owner-proof.ts';
import { decodeOwnerProof, OWNER_PROOF_REPLY, OWNER_PROOF_REQUEST, type OwnerProofWire } from './owner-proof-wire.ts';

type Proof = NonNullable<ReturnType<typeof openProof>>;
export type OwnerProofMember = Readonly<{
  identity: Generation; // exact server-stamped current socket SID, not the stable map key
  peerKey: string; // stable local peer-map key for the existing game/recovery actor
  active: boolean; // excludes pending, phantom, synthetic, disconnected and spectator
  original: boolean; // belongs to this incident's original running cohort
}>;
export type OwnerProofSession = Readonly<{
  running: boolean;
  mode: 'normal-native' | 'worker' | 'other';
  self: OwnerProofMember;
  members: readonly OwnerProofMember[]; // includes self
}>;
type RelayStamp = Readonly<{ stamped: boolean; allowed: boolean; sid: string | null; slot: number | null }>;
type SourceInput = Readonly<{ authored: true; value: Input }>;
export type OwnerProofRelayDependencies = Readonly<{
  // Use actual Socket.IO connected/id state; the game's _signalSocket is emit-only.
  socket: () => Readonly<{ connected: boolean; id?: string }> | null;
  // Must emit to the exact supplied current SID. Do not rewrite the proved target.
  transport: Readonly<{ emit: (event: 'data-message', message: OwnerProofWire) => void }>;
  // Read only current, locally known authority; never construct from wire fields.
  session: () => OwnerProofSession | null;
  // Use KNCore.checkRelayed on the unmodified server event, never trust body aliases.
  checkRelayed: (data: Relayed) => RelayStamp;
  now: () => number;
  getProof: (token: string) => Proof | undefined;
  getAuthoredInput: (id: number) => SourceInput | undefined;
  confirmed: (owner: OwnerProofMember) => ReadonlyMap<number, Input>; // excludes synthesized input
}>;
type Result =
  | Readonly<{ kind: 'replied'; count: number }>
  | Readonly<{
      kind: 'accepted';
      next: Proof;
      confirmedMissing: readonly Sample[];
      epoch: number;
      owner: OwnerProofMember;
    }>;
const sameMatch = (a: Generation, b: Generation) => a.match === b.match && a.epoch === b.epoch;

export function createOwnerProofRelay(deps: OwnerProofRelayDependencies) {
  const current = () => {
    const socket = deps.socket();
    const session = deps.session();
    if (!socket?.connected || !socket.id || !session?.running || session.mode !== 'normal-native') return null;
    const { self } = session;
    if (
      !self.active ||
      !self.original ||
      self.identity.sid !== socket.id ||
      self.identity.slot < 0 ||
      self.identity.slot > 3
    )
      return null;
    const live = session.members.filter((m) => m.active && sameMatch(self.identity, m.identity));
    if (
      live.length < 3 ||
      live.length > 4 ||
      new Set(live.map((m) => m.identity.sid)).size !== live.length ||
      new Set(live.map((m) => m.identity.slot)).size !== live.length ||
      new Set(live.map((m) => m.peerKey)).size !== live.length ||
      live.some((m) => !Number.isInteger(m.identity.slot) || m.identity.slot < 0 || m.identity.slot > 3) ||
      !live.some((m) => sameOwner(m.identity, self.identity) && m.peerKey === self.peerKey && m.original)
    )
      return null;
    const member = (slot: number) => live.find((m) => m.identity.slot === slot && m.original);
    const host = member(0);
    return host ? { sid: socket.id, self, host, member } : null;
  };
  const send = (message: OwnerProofWire): boolean => {
    try {
      deps.transport.emit('data-message', message);
      return true;
    } catch {
      return false;
    }
  };
  const sendRequest = (p: Proof): boolean => {
    const view = current();
    const now = deps.now();
    if (
      !view ||
      view.self.identity.slot !== 0 ||
      !Number.isFinite(now) ||
      now >= p.deadline ||
      deps.getProof(p.token) !== p
    )
      return false;
    const owner = view.member(p.owner.slot);
    if (!owner || owner.identity.slot === 0 || !sameOwner(owner.identity, p.owner)) return false;
    const msg = decodeOwnerProof({
      type: OWNER_PROOF_REQUEST,
      targetSid: owner.identity.sid,
      token: p.token,
      ids: [...p.missing].filter((id) => !p.accepted.has(id)),
    });
    return !!msg && send(msg);
  };
  const onMessage = (raw: WirePayload): Result | null => {
    if (raw === null || typeof raw !== 'object' || !('type' in raw) || !('knFrom' in raw)) return null;
    const view = current();
    if (!view) return null;
    const message = decodeOwnerProof(raw);
    if (!message || message.targetSid !== view.sid) return null; // retired local SIDs do not count
    const from = deps.checkRelayed(raw);
    if (!from.stamped || !from.allowed || !from.sid || from.slot === null) return null;
    if (message.type === OWNER_PROOF_REQUEST) {
      if (view.self.identity.slot === 0 || from.slot !== 0 || from.sid !== view.host.identity.sid) return null;
      const samples: Sample[] = [];
      for (const id of message.ids) {
        const input = deps.getAuthoredInput(id);
        if (input?.authored === true) samples.push([id, input.value]);
      }
      const reply = decodeOwnerProof({
        type: OWNER_PROOF_REPLY,
        targetSid: view.host.identity.sid,
        token: message.token,
        samples,
      });
      return reply && send(reply) ? { kind: 'replied', count: samples.length } : null;
    }
    if (view.self.identity.slot !== 0 || from.slot === 0) return null;
    const proof = deps.getProof(message.token);
    const owner = view.member(from.slot);
    if (!proof || !owner || owner.identity.sid !== from.sid || !sameOwner(proof.owner, owner.identity)) return null;
    const confirmed = deps.confirmed(owner);
    // A normal RTC handoff can arrive between proof replies. Never let its
    // presence retroactively overwrite the first value already accepted.
    for (const [id, prior] of proof.accepted) {
      const direct = confirmed.get(id);
      if (direct && prior.some((v, i) => v !== direct[i])) return null;
    }
    const next = acceptReply(
      proof,
      owner.identity,
      {
        sender: owner.identity,
        token: message.token,
        samples: message.samples,
        now: deps.now(),
      },
      confirmed,
    );
    if (!next) return null;
    // Keep already-confirmed and already-fed proofs out of the native feed.
    // The caller still revalidates generation/provenance atomically before write.
    const confirmedMissing: Sample[] = [];
    for (const [id, value] of next.accepted) {
      if (!confirmed.has(id) && !proof.accepted.has(id)) confirmedMissing.push([id, value]);
    }
    return { kind: 'accepted', next, confirmedMissing, epoch: view.self.identity.epoch, owner };
  };
  return { sendRequest, onMessage };
}
